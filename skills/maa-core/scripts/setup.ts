import { mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readSettings, settingsHome } from './preferences.ts';
import { inspectCredentials } from './credentials.ts';
import { blockingChecks, libraryCheck, type CheckResult, type LibraryCheck } from './checks.ts';
import { assessMaaVersion, readMaaVersion, readVerificationRecord, type MaaVersionReader } from './maa-version.ts';
import { executeSetupConfigWrite, inspectConfigRecovery, type MaaProcess } from './maa-config.ts';
import { configurationCheck, writeLockCheck } from './doctor-checks.ts';
import { currentConfiguration, discoverSetupConnections, testSetupConnection, type AdbBoundary, type ConnectionContext, type ConnectionSelection, type SetupWriteRequest } from './setup-connection.ts';
import { DownloadError, downloadStatus, executeDownload, installDownload, planDownload, type DownloadContext } from './setup-download.ts';
export { discoverSetupConnections, testSetupConnection, type AdbBoundary, type ConnectionContext, type ConnectionSelection, type SetupWriteRequest } from './setup-connection.ts';

export type SetupContext = { home?: string; maaDirectory?: string };
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
  const version = assessMaaVersion(installed, await readVerificationRecord());
  add('version', version.status, version.reason, 'read-version-verification');
  return { checks, settings: settings ?? null, settingsPresent, version: version.evidence };
}

/** Read-only: does not create settings, directories, or a diagnostic record. */
export async function checkSetup(context: SetupContext = {}, versionReader: MaaVersionReader = readMaaVersion) {
  const installation = await inspectInstallation(context, versionReader);
  const { settings } = installation;
  const checks: (CheckResult & { message: string })[] = [...installation.checks];
  // Shared with doctor: presence and known state only, never a value; an unknown private directory is not guessed.
  checks.push(...(await inspectCredentials(settings ? settings.privateDirectory : null)).checks);
  return { checkedAt: new Date().toISOString(), exitCode: blockingChecks(checks, 'setup-exit').blocking.length ? 1 : 0, checks,
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
  await writeEnvironmentRecord(settings.privateDirectory, result);
  return result;
}
async function writeEnvironmentRecord(privateDirectory: string, result: unknown) {
  const temporary = join(privateDirectory, `.setup-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(privateDirectory, 'setup-environment.json'));
}

export async function applySetupConnection(request: SetupWriteRequest, context: ConnectionContext = {}, adb?: AdbBoundary, maa?: MaaProcess) {
  return executeSetupConfigWrite(request, context, adb, maa);
}

export type SetupDownloadContext = SetupContext & DownloadContext & { nodeVersion?: string };
/**
 * Shows the official plan for one missing program. A program that the fresh check already finds is not
 * planned again; a verified earlier download is reported instead of a new plan. Nothing is written.
 */
export async function planSetupDownload(request: unknown, context: SetupDownloadContext = {}) {
  const program = request && typeof request === 'object' ? (request as Record<string, unknown>).program : undefined;
  if (program === 'node' && checkRuntime(process.platform, context.nodeVersion ?? process.versions.node).node24) return { status: 'not-needed', program, reason: 'already-installed' };
  if (program === 'maa') {
    const state = await checkSetup({ ...(context.home ? { home: context.home } : {}), ...(context.maaDirectory ? { maaDirectory: context.maaDirectory } : {}) }, async () => null);
    if (state.checks.find(item => item.id === 'maa')!.reason !== 'maa-gui-missing') return { status: 'not-needed', program, reason: 'already-installed' };
  }
  return planDownload(request, context);
}
/** Downloads only the plan named by a confirmation given for that plan; see setup-download.ts. */
export async function downloadSetupProgram(request: unknown, context: DownloadContext = {}) { return executeDownload(request, context); }
export async function setupDownloadStatus(context: DownloadContext = {}) { return downloadStatus(context); }
export async function installSetupDownload(request: unknown, context: DownloadContext = {}) { return installDownload(request, context); }

const connectionReasons = new Set(['maa-directory-unset', 'cn-client-required', 'candidate-input-invalid', 'too-many-adb-candidates', 'too-many-connection-candidates']);
/**
 * Final recheck after installation: Node, MAA and settings by the fresh check, adb and the connection by a
 * fresh discovery and, for the candidate the user chose, the adb transport test. The candidate id hashes only
 * the adb path and address, so it survives the connection write and MAA rewriting its configuration, while a
 * discovery revision would not. Complete only when nothing is pending: `pending` lists the check errors the
 * `setup-recheck` purpose of `blockingChecks` names (what setup installs or configures) plus the connection when
 * its test did not pass; other errors, such as a credential, are reported in `notBlocking`. The `configuration`
 * and `write-lock` rows come from the producer doctor uses, so a connection write whose result is unknown (its
 * lock retained) keeps setup pending until doctor reconciles it. `maa` only inspects the MAA process, read-only.
 */
export type RecheckRequest = { candidate?: string };
export async function recheckSetup(request: RecheckRequest = {}, context: ConnectionContext = {}, versionReader: MaaVersionReader = readMaaVersion, adb?: AdbBoundary, maa?: MaaProcess) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => key !== 'candidate')
    || request.candidate !== undefined && (typeof request.candidate !== 'string' || !/^[a-f0-9]{64}$/.test(request.candidate))) throw new Error('request-invalid');
  const home = resolve(context.home ?? settingsHome());
  if (!await isFile(join(home, 'config.json'))) throw new Error('set-preferences-first');
  const settings = await readSettings(home);
  const result = await checkSetup(context, versionReader);
  const checks: CheckResult[] = [...result.checks];
  // Without an MAA directory there is no configuration to read or lock, and the `maa` row already blocks.
  const maaDirectory = context.maaDirectory ?? settings.maaDirectory;
  if (maaDirectory) {
    let created: MaaProcess | undefined;
    const boundary: MaaProcess = maa ?? { inspect: async () => (created ??= (await import('./maa-process.ts')).createMaaProcess(maaDirectory)).inspect(),
      close: async () => { throw new Error('recheck-never-closes-maa'); }, start: async () => { throw new Error('recheck-never-starts-maa'); } };
    const recovery = await inspectConfigRecovery({ maaDirectory, privateDirectory: settings.privateDirectory }, boundary);
    checks.push(configurationCheck(recovery), writeLockCheck(recovery));
  }
  const downloads = (await downloadStatus({ home })).items;
  const { blocking, notBlocking } = blockingChecks(checks, 'setup-recheck');
  let connection: Record<string, unknown>;
  // These three rows are only normal or error: discovery needs the MAA GUI, its CN profile and readable settings.
  if (['maa', 'server', 'settings'].some(id => blocking.includes(id))) connection = { status: 'not-checked', reason: 'maa-check-required' };
  else try {
    const found = await discoverSetupConnections(context, adb);
    const counts = { adbCount: found.adbCount, failedAdb: found.failedAdb, candidates: found.candidates.length };
    if (request.candidate === undefined) connection = { status: found.candidates.length ? 'selection-required' : 'no-candidate', ...counts };
    else if (!found.candidates.some(item => item.id === request.candidate)) connection = { status: 'candidate-unavailable', reason: 'chosen-candidate-not-found', ...counts };
    else {
      const tested = await testSetupConnection({ discoveryRevision: found.discoveryRevision, candidate: request.candidate }, context, adb);
      connection = { status: tested.status === 'connected' ? 'connected' : tested.status === 'failed' ? 'failed' : 'rejected', reason: tested.reason };
    }
  } catch (error) {
    connection = { status: 'unavailable', reason: error instanceof Error && connectionReasons.has(error.message) ? error.message : 'connection-check-failed' };
  }
  const pending = [...new Set([...blocking, ...(connection.status === 'connected' ? [] : ['connection'])])];
  // The exit code keeps meaning "there is an error" (`setup-exit`, over every row here); completion is `complete`.
  const record = { ...result, checks, exitCode: (blockingChecks(checks, 'setup-exit').blocking.length || pending.length) ? 1 : 0, downloads, connection,
    complete: pending.length === 0, pending, notBlocking };
  await mkdir(settings.privateDirectory, { recursive: true });
  await writeEnvironmentRecord(settings.privateDirectory, record);
  return record;
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
    const downloadActions: Record<string, string[]> = { plan: ['program', 'vendor', 'url', 'version'], download: ['program', 'planId', 'fingerprint', 'reference', 'termsAccepted', 'vendor', 'url', 'version'],
      install: ['planId', 'target'], downloads: [], recheck: ['adbPaths', 'addresses', 'candidate'] };
    if (!['check', 'prepare', 'discover', 'test', 'apply', ...Object.keys(downloadActions)].includes(action ?? '') || args.length > 2 || args.length === 2 && args[1] !== '--json') throw new Error('request-invalid');
    let text = ''; for await (const chunk of process.stdin) { text += String(chunk); if (Buffer.byteLength(text) > 65536) throw new Error('request-invalid'); }
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(text || '{}')); } catch { throw new Error('request-invalid'); }
    const allowed = action === 'check' ? ['maaDirectory'] : action === 'prepare' ? [] : action === 'discover' ? ['adbPaths', 'addresses']
      : action === 'test' ? ['adbPaths', 'addresses', 'discoveryRevision', 'candidate'] : Object.hasOwn(downloadActions, action!) ? downloadActions[action!]!
      : ['adbPaths', 'addresses', 'discoveryRevision', 'candidate', 'host', 'reference', 'closedConfirmed'];
    if (Object.keys(body).some(key => !allowed.includes(key)) || body.maaDirectory !== undefined && (typeof body.maaDirectory !== 'string' || !isAbsolute(body.maaDirectory))) throw new Error('request-invalid');
    // Planning and downloading Node itself, and reading download status, must work on the wrong Node major.
    const fixesNode = action === 'downloads' || (action === 'plan' || action === 'download') && body.program === 'node';
    if (action !== 'check' && !fixesNode && !checkRuntime().node24) throw new Error('node-24-required');
    const context: ConnectionContext = { ...(typeof body.maaDirectory === 'string' ? { maaDirectory: body.maaDirectory } : {}),
      ...(body.adbPaths !== undefined ? { adbPaths: body.adbPaths as string[] } : {}), ...(body.addresses !== undefined ? { addresses: body.addresses as string[] } : {}) };
    let result;
    if (action === 'check' || action === 'prepare') {
      result = action === 'check' ? await checkSetup(context) : await prepareSetup(context);
      process.exitCode = result.exitCode;
    } else if (action === 'downloads') {
      result = await setupDownloadStatus();
    } else if (action === 'plan' || action === 'download' || action === 'install' || action === 'recheck') {
      if (!checkRuntime().windows) throw new Error('windows-required');
      if (action === 'recheck') {
        const { adbPaths: _adbPaths, addresses: _addresses, ...selection } = body;
        result = await recheckSetup(selection as RecheckRequest, context); process.exitCode = result.exitCode;
      } else {
        result = action === 'plan' ? await planSetupDownload(body) : action === 'download' ? await downloadSetupProgram(body) : await installSetupDownload(body);
        process.exitCode = ['planned', 'not-needed', 'already-downloaded', 'downloaded', 'extracted', 'already-extracted', 'user-steps'].includes(result.status) ? 0 : 1;
      }
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
    // Download reasons are fixed codes chosen by setup-download.ts; no path, address or response text.
    const reason = error instanceof DownloadError || error instanceof Error && safe.has(error.message) ? (error as Error).message : 'setup-check-required';
    emit({ status: reason === 'setup-check-required' ? 'unexpected-failure' : 'rejected', reason }); process.exitCode = reason === 'setup-check-required' ? 2 : 1;
  }
}
