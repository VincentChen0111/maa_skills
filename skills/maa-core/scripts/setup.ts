import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readSettings, settingsHome } from './preferences.ts';
import type { CheckResult } from './doctor.ts';
import { executeSetupConfigWrite, type MaaProcess } from './maa-config.ts';
import { currentConfiguration, discoverSetupConnections, testSetupConnection, type AdbBoundary, type ConnectionContext, type ConnectionSelection, type SetupWriteRequest } from './setup-connection.ts';
import { DownloadError, downloadStatus, executeDownload, installDownload, planDownload, type DownloadContext } from './setup-download.ts';
export { discoverSetupConnections, testSetupConnection, type AdbBoundary, type ConnectionContext, type ConnectionSelection, type SetupWriteRequest } from './setup-connection.ts';

export type SetupContext = { home?: string; maaDirectory?: string };
/** Observes the installed MAA binary metadata without launching it. */
export type MaaVersionReader = (maaDirectory: string) => Promise<string | null>;
export function checkRuntime(platform = process.platform, nodeVersion = process.versions.node) {
  return { windows: platform === 'win32', node24: /^24\./.test(nodeVersion) };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-object');
  return value as Record<string, unknown>;
}
async function isFile(path: string) { try { return (await stat(path)).isFile(); } catch { return false; } }
async function isDirectory(path: string) { try { return (await stat(path)).isDirectory(); } catch { return false; } }
export const readMaaVersion: MaaVersionReader = async directory => {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return null;
  const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const code = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Diagnostics.FileVersionInfo]::GetVersionInfo($env:MAA_SETUP_BINARY).ProductVersion";
  return new Promise(resolveResult => execFile(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { env: { ...process.env, MAA_SETUP_BINARY: join(directory, 'MAA.exe') }, windowsHide: true, timeout: 5000, maxBuffer: 4096 },
    (error, stdout) => { const version = stdout.trim(); resolveResult(!error && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ? version.replace(/^v/, '') : null); }));
};

/** Read-only: does not create settings, directories, or a diagnostic record. */
export async function checkSetup(context: SetupContext = {}, versionReader: MaaVersionReader = readMaaVersion) {
  const home = resolve(context.home ?? settingsHome()); const runtime = checkRuntime();
  let settings;
  try { settings = await readSettings(home); } catch { /* Preserve unreadable settings; independent checks still run. */ }
  const directory = context.maaDirectory ?? settings?.maaDirectory ?? null;
  if (directory !== null && (typeof directory !== 'string' || !isAbsolute(directory))) throw new Error('maa-directory-invalid');
  const settingsPresent = await isFile(join(home, 'config.json'));
  const checks: (CheckResult & { message: string })[] = [];
  const messages: Record<string, string> = {
    windows: 'The host is Windows.', 'windows-required': 'This workflow requires Windows.',
    'maa-gui-missing': 'The selected MAA GUI executable is missing.', 'maa-configuration-unreadable': 'The current MAA GUI configuration could not be read.', 'maa-gui-present': 'The MAA GUI executable and current configuration are present.',
    'cn-client': 'The current MAA profile selects a CN client.', 'client-unverified': 'The current client has not been verified.', 'unsupported-client': 'The current client is outside the CN scope.',
    'node-24': 'Node 24 is running.', 'node-24-required': 'This workflow requires Node 24.',
    'settings-readable': 'Existing settings were read.', 'settings-missing': 'Initial settings have not been saved.',
    'settings-unreadable': 'Existing settings could not be read or validated; their original contents were preserved.',
    'private-directory-unverified': 'The private directory cannot be determined until settings are repaired.',
    'private-directory-present': 'The selected private directory exists.', 'private-directory-missing': 'The selected private directory is absent or not a directory.',
    'verification-record-unavailable': 'The packaged verification record could not be read.', 'maa-version-unknown': 'The installed MAA version could not be identified.',
    'maa-version-not-fully-verified': 'This MAA version is not fully verified by this repository; setup may continue.', 'maa-version-verified': 'This MAA version has source and device verification records.',
  };
  const repairs: Record<string, string> = {
    'use-windows-gui': 'Use an existing Windows MAA GUI installation.', 'official-maa-installation': 'Choose an existing MAA GUI directory, or review the official download plan from setup plan; nothing is downloaded until you confirm that plan.',
    'inspect-maa-configuration': 'Inspect or initialize the current configuration in the MAA GUI.', 'select-cn-client-in-maa': 'Check the selected client in the MAA GUI; use a CN profile.',
    'official-node-24-installation': 'Install Node 24.x from the official Node download page; setup plan can show the official installer, downloaded only after you confirm that plan.', 'set-preferences': 'Save the first-run choices using the shared preferences script.',
    'inspect-settings': 'Preserve config.json in the selected settings home, then restore a known-good copy or repair its JSON, schema and access permissions; rerun check before saving preferences or creating directories.',
    'prepare-private-directory': 'Run setup prepare after saving the selected private directory.', 'read-version-verification': 'Read the packaged version record and retain the unverified warning; no upgrade is required.',
  };
  const add = (id: string, status: CheckResult['status'], reason: string, repair: string, executor: 'skill' | 'user' = 'user') =>
    checks.push({ id, status, reason, message: messages[reason]!, repair: { id: repair, executor, description: repairs[repair]! } });
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
  add('settings', settings && settingsPresent ? 'normal' : 'error', !settings ? 'settings-unreadable' : settingsPresent ? 'settings-readable' : 'settings-missing', settings ? 'set-preferences' : 'inspect-settings', settings ? 'skill' : 'user');
  const privatePresent = settings && await isDirectory(settings.privateDirectory);
  add('private-directory', privatePresent ? 'normal' : 'error', !settings ? 'private-directory-unverified' : privatePresent ? 'private-directory-present' : 'private-directory-missing', settings ? 'prepare-private-directory' : 'inspect-settings', settings ? 'skill' : 'user');
  let version: string | null = null;
  if (directory && executable) try { version = await versionReader(directory); } catch { /* Unknown versions only warn. */ }
  if (version !== null && !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) version = null;
  let sourceVerified = false; let deviceVerified = false; let recordAvailable = false;
  try {
    const record = object(JSON.parse(await readFile(new URL('../references/verified-versions.json', import.meta.url), 'utf8')));
    if (record.schemaVersion !== 1 || !Array.isArray(record.sourceVerified) || !Array.isArray(record.deviceVerified)
      || [...record.sourceVerified, ...record.deviceVerified].some(value => typeof value !== 'string')) throw new Error('versions-invalid');
    recordAvailable = true; sourceVerified = version !== null && record.sourceVerified.includes(version); deviceVerified = version !== null && record.deviceVerified.includes(version);
  } catch { /* Missing records cannot certify a version. */ }
  add('version', sourceVerified && deviceVerified ? 'normal' : 'warning', !recordAvailable ? 'verification-record-unavailable' : !version ? 'maa-version-unknown' : sourceVerified && deviceVerified ? 'maa-version-verified' : 'maa-version-not-fully-verified', 'read-version-verification');
  return { checkedAt: new Date().toISOString(), exitCode: checks.some(item => item.status === 'error') ? 1 : 0, checks,
    language: settings?.language ?? null, needsLanguagePrompt: !!settings && !settings.languageAsked && settings.language === null,
    needsDirectoryPrompt: !!settings && !settingsPresent, version: { installed: version, recordAvailable, sourceVerified, deviceVerified } };
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
 * Final recheck after installation: Node, MAA and settings by the fresh check, adb and the connection by
 * discovery and, for a selected candidate, the adb transport test. Complete only when nothing is pending.
 */
export async function recheckSetup(request: Partial<ConnectionSelection> = {}, context: ConnectionContext = {}, versionReader: MaaVersionReader = readMaaVersion, adb?: AdbBoundary) {
  const home = resolve(context.home ?? settingsHome());
  if (!await isFile(join(home, 'config.json'))) throw new Error('set-preferences-first');
  const settings = await readSettings(home);
  const result = await checkSetup(context, versionReader);
  const downloads = (await downloadStatus({ home })).items;
  let connection: Record<string, unknown>;
  if (!['maa', 'server', 'settings'].every(id => result.checks.find(item => item.id === id)?.status === 'normal')) connection = { status: 'not-checked', reason: 'maa-check-required' };
  else try {
    const found = await discoverSetupConnections(context, adb);
    if (request.discoveryRevision === undefined) {
      connection = { status: found.candidates.length ? 'selection-required' : 'no-candidate', adbCount: found.adbCount, failedAdb: found.failedAdb,
        candidates: found.candidates.length, discoveryRevision: found.discoveryRevision };
    } else {
      const tested = await testSetupConnection({ discoveryRevision: request.discoveryRevision, ...(request.candidate ? { candidate: request.candidate } : {}) }, context, adb);
      connection = { status: tested.status === 'connected' ? 'connected' : tested.status === 'failed' ? 'failed' : 'rejected', reason: tested.reason };
    }
  } catch (error) {
    connection = { status: 'unavailable', reason: error instanceof Error && connectionReasons.has(error.message) ? error.message : 'connection-check-failed' };
  }
  const pending = [...result.checks.filter(item => item.status === 'error').map(item => item.id), ...(connection.status === 'connected' ? [] : ['connection'])];
  const record = { ...result, exitCode: pending.length ? 1 : 0, downloads, connection, complete: pending.length === 0, pending };
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
      install: ['planId', 'target'], downloads: [], recheck: ['adbPaths', 'addresses', 'discoveryRevision', 'candidate'] };
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
        result = await recheckSetup(selection as Partial<ConnectionSelection>, context); process.exitCode = result.exitCode;
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
