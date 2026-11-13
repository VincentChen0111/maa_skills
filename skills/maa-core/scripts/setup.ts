import { mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readSettings, settingsHome } from './preferences.ts';
import { inspectCredentials } from './credentials.ts';
import { libraryCheck, type CheckResult, type LibraryCheck } from './checks.ts';
import { assessMaaVersion, readMaaVersion, readVerificationRecord, versionRepair, type MaaVersionReader } from './maa-version.ts';
import { executeSetupConfigWrite, type MaaProcess } from './maa-config.ts';
import { currentConfiguration, discoverSetupConnections, testSetupConnection, type AdbBoundary, type ConnectionContext, type ConnectionSelection, type SetupWriteRequest } from './setup-connection.ts';
export { discoverSetupConnections, testSetupConnection, type AdbBoundary, type ConnectionContext, type ConnectionSelection, type SetupWriteRequest } from './setup-connection.ts';

/** `verificationRecord` defaults to the packaged record; tests point it at a real temporary record file. */
export type SetupContext = { home?: string; maaDirectory?: string; verificationRecord?: string };
export { readMaaVersion, type MaaVersionReader } from './maa-version.ts';
export function checkRuntime(platform = process.platform, nodeVersion = process.versions.node) {
  return { windows: platform === 'win32', node24: /^24\./.test(nodeVersion) };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-object');
  return value as Record<string, unknown>;
}
async function isFile(path: string) { try { return (await stat(path)).isFile(); } catch { return false; } }
async function isDirectory(path: string) { try { return (await stat(path)).isDirectory(); } catch { return false; } }

/**
 * The installation check group shared by setup and doctor: Windows, MAA GUI and configuration, CN client,
 * Node 24, settings, private directory and MAA version. Read-only: it creates no settings, directory or record.
 */
export async function inspectInstallation(context: SetupContext = {}, versionReader: MaaVersionReader = readMaaVersion) {
  const home = resolve(context.home ?? settingsHome()); const runtime = checkRuntime();
  let settings;
  try { settings = await readSettings(home); } catch { /* Preserve unreadable settings; independent checks still run. */ }
  const directory = context.maaDirectory ?? settings?.maaDirectory ?? null;
  if (directory !== null && (typeof directory !== 'string' || !isAbsolute(directory))) throw new Error('maa-directory-invalid');
  const settingsPresent = await isFile(join(home, 'config.json'));
  const checks: LibraryCheck[] = [];
  const add = (id: string, status: CheckResult['status'], reason: string, repair: string) => checks.push(libraryCheck(id, status, reason, repair));
  add('platform', runtime.windows ? 'normal' : 'error', runtime.windows ? 'windows' : 'windows-required', 'use-windows-gui');
  const executable = directory !== null && await isFile(join(directory, 'MAA.exe'));
  let current;
  if (directory && executable) try { current = await currentConfiguration(directory); } catch { /* Preserve unreadable configuration. */ }
  add('maa', executable && current ? 'normal' : 'error', !executable ? 'maa-gui-missing' : !current ? 'maa-configuration-unreadable' : 'maa-gui-present', !executable ? 'official-maa-installation' : 'inspect-maa-configuration');
  let client: unknown = null;
  if (current) try { client = object(current.gui.RuntimeSettings).ClientType; } catch { /* Missing client remains unverified. */ }
  const supported = client === 'Official' || client === 'Bilibili';
  add('server', supported ? 'normal' : 'error', supported ? 'cn-client' : client === null || client === undefined ? 'client-unverified' : 'unsupported-client', 'select-cn-client-in-maa');
  add('node', runtime.node24 ? 'normal' : 'error', runtime.node24 ? 'node-24' : 'node-24-required', 'official-node-24-installation');
  add('settings', settings && settingsPresent ? 'normal' : 'error', !settings ? 'settings-unreadable' : settingsPresent ? 'settings-readable' : 'settings-missing', settings ? 'set-preferences' : 'inspect-settings');
  const privatePresent = settings && await isDirectory(settings.privateDirectory);
  add('private-directory', privatePresent ? 'normal' : 'error', !settings ? 'private-directory-unverified' : privatePresent ? 'private-directory-present' : 'private-directory-missing', settings ? 'prepare-private-directory' : 'inspect-settings');
  let installed: string | null = null;
  if (directory && executable) try { installed = await versionReader(directory); } catch { /* Unknown versions only warn. */ }
  const version = assessMaaVersion(installed, await readVerificationRecord(context.verificationRecord));
  add('version', version.status, version.reason, versionRepair(version.reason));
  return { checks, settings: settings ?? null, settingsPresent, version: version.evidence };
}

/** Read-only: does not create settings, directories, or a diagnostic record. */
export async function checkSetup(context: SetupContext = {}, versionReader: MaaVersionReader = readMaaVersion) {
  const installation = await inspectInstallation(context, versionReader);
  const { settings } = installation;
  const checks: (CheckResult & { message: string })[] = [...installation.checks];
  // Shared with doctor: presence and known state only, never a value; an unknown private directory is not guessed.
  checks.push(...(await inspectCredentials(settings ? settings.privateDirectory : null)).checks);
  return { checkedAt: new Date().toISOString(), exitCode: checks.some(item => item.status === 'error') ? 1 : 0, checks,
    language: settings?.language ?? null, needsLanguagePrompt: !!settings && !settings.languageAsked && settings.language === null,
    needsDirectoryPrompt: !!settings && !installation.settingsPresent, version: installation.version };
}

/** Creates only the private directory and its redacted setup record, preserving all existing content. */
export async function prepareSetup(context: SetupContext = {}, versionReader: MaaVersionReader = readMaaVersion) {
  const home = resolve(context.home ?? settingsHome());
  if (!await isFile(join(home, 'config.json'))) throw new Error('set-preferences-first');
  const settings = await readSettings(home);
  await mkdir(settings.privateDirectory, { recursive: true });
  const result = await checkSetup(context, versionReader);
  const temporary = join(settings.privateDirectory, `.setup-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(settings.privateDirectory, 'setup-environment.json'));
  return result;
}

export async function applySetupConnection(request: SetupWriteRequest, context: ConnectionContext = {}, adb?: AdbBoundary, maa?: MaaProcess) {
  return executeSetupConfigWrite(request, context, adb, maa);
}

const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  const json = process.argv.includes('--json');
  const emit = (value: unknown) => {
    if (json) console.log(JSON.stringify(value));
    else console.log(JSON.stringify(value, null, 2));
  };
  try {
    const args = process.argv.slice(2); const action = args[0];
    if (!['check', 'prepare', 'discover', 'test', 'apply'].includes(action ?? '') || args.length > 2 || args.length === 2 && args[1] !== '--json') throw new Error('request-invalid');
    let text = ''; for await (const chunk of process.stdin) { text += String(chunk); if (Buffer.byteLength(text) > 65536) throw new Error('request-invalid'); }
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(text || '{}')); } catch { throw new Error('request-invalid'); }
    const allowed = action === 'check' ? ['maaDirectory'] : action === 'prepare' ? [] : action === 'discover' ? ['adbPaths', 'addresses']
      : action === 'test' ? ['adbPaths', 'addresses', 'discoveryRevision', 'candidate'] : ['adbPaths', 'addresses', 'discoveryRevision', 'candidate', 'host', 'reference', 'closedConfirmed'];
    if (Object.keys(body).some(key => !allowed.includes(key)) || body.maaDirectory !== undefined && (typeof body.maaDirectory !== 'string' || !isAbsolute(body.maaDirectory))) throw new Error('request-invalid');
    if (action !== 'check' && !checkRuntime().node24) throw new Error('node-24-required');
    const context: ConnectionContext = { ...(typeof body.maaDirectory === 'string' ? { maaDirectory: body.maaDirectory } : {}),
      ...(body.adbPaths !== undefined ? { adbPaths: body.adbPaths as string[] } : {}), ...(body.addresses !== undefined ? { addresses: body.addresses as string[] } : {}) };
    let result;
    if (action === 'check' || action === 'prepare') {
      result = action === 'check' ? await checkSetup(context) : await prepareSetup(context);
      process.exitCode = result.exitCode;
    } else {
      if (!checkRuntime().windows) throw new Error('windows-required');
      if (action === 'discover') { result = await discoverSetupConnections(context); process.exitCode = result.candidates.length ? 0 : 1; }
      else {
        const { adbPaths: _adbPaths, addresses: _addresses, ...selection } = body;
        result = action === 'test' ? await testSetupConnection(selection as ConnectionSelection, context) : await applySetupConnection(selection as SetupWriteRequest, context);
        process.exitCode = ['connected', 'complete', 'unchanged'].includes(result.status) ? 0 : 1;
      }
    }
    emit(result);
  } catch (error) {
    const safe = new Set(['request-invalid', 'set-preferences-first', 'node-24-required', 'windows-required', 'maa-directory-unset', 'candidate-input-invalid', 'too-many-adb-candidates', 'too-many-connection-candidates', 'cn-client-required']);
    const reason = error instanceof Error && safe.has(error.message) ? error.message : 'setup-check-required';
    emit({ status: reason === 'setup-check-required' ? 'unexpected-failure' : 'rejected', reason }); process.exitCode = reason === 'setup-check-required' ? 2 : 1;
  }
}
