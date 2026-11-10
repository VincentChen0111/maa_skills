import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readSettings, settingsHome } from './preferences.ts';
import type { CheckResult } from './doctor.ts';
import { executeConfigWrite, inspectConfiguration, type MaaProcess } from './maa-config.ts';

export type SetupContext = { home?: string; maaDirectory?: string };
export type ConnectionContext = SetupContext & { adbPaths?: string[]; addresses?: string[] };
/** Only adb process execution is substituted by tests. Arguments are always an array, never a shell. */
export interface AdbBoundary { run(executable: string, args: string[]): Promise<{ exitCode: number; stdout: string }> }
const systemAdb: AdbBoundary = { run: async (executable, args) => new Promise(resolveResult => {
  if (process.platform !== 'win32') { resolveResult({ exitCode: 1, stdout: '' }); return; }
  execFile(executable, args, { windowsHide: true, timeout: 5000, maxBuffer: 65536 }, (error, stdout) => resolveResult({ exitCode: error ? 1 : 0, stdout }));
}) };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function localAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^emulator-\d{1,5}$/.test(value)) return true;
  const match = /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(value);
  return !!match && Number(match[1]) > 0 && Number(match[1]) <= 65535;
}
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
async function currentConfiguration(directory: string) {
  const config = object(JSON.parse((await readFile(join(directory, 'config/gui.new.json'), 'utf8')).replace(/^\uFEFF/, '')));
  const profiles = object(config.Configurations);
  if (typeof config.Current !== 'string' || !Object.hasOwn(profiles, config.Current)) throw new Error('current-profile-invalid');
  const profile = object(profiles[config.Current]);
  return { config, profile, gui: object(profile.Gui), profileIndex: Object.keys(profiles).indexOf(config.Current) };
}
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
  try { settings = await readSettings(home); } catch { throw new Error('settings-check-required'); }
  const directory = context.maaDirectory ?? settings.maaDirectory;
  if (directory !== null && (!isAbsolute(directory) || typeof directory !== 'string')) throw new Error('maa-directory-invalid');
  const settingsPresent = await isFile(join(home, 'config.json'));
  const checks: (CheckResult & { message: string })[] = [];
  const messages: Record<string, string> = {
    windows: 'The host is Windows.', 'windows-required': 'This workflow requires Windows.',
    'maa-gui-missing': 'The selected MAA GUI executable is missing.', 'maa-configuration-unreadable': 'The current MAA GUI configuration could not be read.', 'maa-gui-present': 'The MAA GUI executable and current configuration are present.',
    'cn-client': 'The current MAA profile selects a CN client.', 'client-unverified': 'The current client has not been verified.', 'unsupported-client': 'The current client is outside the CN scope.',
    'node-24': 'Node 24 is running.', 'node-24-required': 'This workflow requires Node 24.',
    'settings-readable': 'Existing settings were read.', 'settings-missing': 'Initial settings have not been saved.',
    'private-directory-present': 'The selected private directory exists.', 'private-directory-missing': 'The selected private directory is absent or not a directory.',
    'verification-record-unavailable': 'The packaged verification record could not be read.', 'maa-version-unknown': 'The installed MAA version could not be identified.',
    'maa-version-not-fully-verified': 'This MAA version is not fully verified by this repository; setup may continue.', 'maa-version-verified': 'This MAA version has source and device verification records.',
  };
  const repairs: Record<string, string> = {
    'use-windows-gui': 'Use an existing Windows MAA GUI installation.', 'official-maa-installation': 'Choose an existing MAA GUI directory or use the official installation instructions; no download is performed.',
    'inspect-maa-configuration': 'Inspect or initialize the current configuration in the MAA GUI.', 'select-cn-client-in-maa': 'Check the selected client in the MAA GUI; use a CN profile.',
    'official-node-24-installation': 'Use the official Node download page and select version 24.x.', 'set-preferences': 'Save the first-run choices using the shared preferences script.',
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
  add('settings', settingsPresent ? 'normal' : 'error', settingsPresent ? 'settings-readable' : 'settings-missing', 'set-preferences', 'skill');
  const privatePresent = await isDirectory(settings.privateDirectory);
  add('private-directory', privatePresent ? 'normal' : 'error', privatePresent ? 'private-directory-present' : 'private-directory-missing', 'prepare-private-directory', 'skill');
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
    language: settings.language, needsLanguagePrompt: !settings.languageAsked && settings.language === null,
    needsDirectoryPrompt: !settingsPresent, version: { installed: version, recordAvailable, sourceVerified, deviceVerified } };
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

type Candidate = { id: string; adbPath: string; address: string; sources: string[]; state: string };
async function discover(context: ConnectionContext, adb: AdbBoundary) {
  const settings = await readSettings(context.home);
  const directory = context.maaDirectory ?? settings.maaDirectory;
  if (!directory || !isAbsolute(directory)) throw new Error('maa-directory-unset');
  const current = await currentConfiguration(directory);
  const client = object(current.gui.RuntimeSettings).ClientType;
  if (client !== 'Official' && client !== 'Bilibili') throw new Error('cn-client-required');
  const connect = object(current.gui.ConnectSettings);
  for (const values of [context.adbPaths, context.addresses]) if (values !== undefined && (!Array.isArray(values) || values.length > 32 || values.some(value => typeof value !== 'string'))) throw new Error('candidate-input-invalid');
  if (context.adbPaths?.some(path => !isAbsolute(path)) || context.addresses?.some(address => !localAddress(address))) throw new Error('candidate-input-invalid');
  const paths = new Map<string, string[]>();
  const addPath = async (path: unknown, source: string, relativeTo?: string) => {
    if (typeof path !== 'string' || !path.trim() || !/adb[^/\\]*\.exe$/i.test(basename(path))) return;
    if (!isAbsolute(path) && !relativeTo) return;
    const absolute = resolve(relativeTo ?? directory, path);
    if (!await isFile(absolute)) return;
    const canonical = await realpath(absolute);
    const previous = [...paths.keys()].find(key => process.platform === 'win32' ? key.toLowerCase() === canonical.toLowerCase() : key === canonical);
    const key = previous ?? canonical;
    paths.set(key, [...new Set([...(paths.get(key) ?? []), source])]);
  };
  if (context.adbPaths === undefined) {
    await addPath(connect.AdbPath, 'configured-adb', directory);
    for (const relative of ['adb.exe', 'adb/adb.exe', 'adb/platform-tools/adb.exe']) await addPath(relative, 'maa-directory', directory);
    const startup = current.gui.StartUpSettings;
    if (startup && typeof startup === 'object' && typeof object(startup).EmulatorPath === 'string' && String(object(startup).EmulatorPath)) {
      const emulator = resolve(directory, String(object(startup).EmulatorPath));
      for (const name of ['adb.exe', 'vbox_adb.exe', 'adb/adb.exe']) await addPath(join(dirname(emulator), name), 'configured-emulator');
    }
    for (const path of (process.env.PATH ?? '').split(delimiter)) if (isAbsolute(path)) await addPath(join(path, 'adb.exe'), 'path');
  }
  for (const path of context.adbPaths ?? []) await addPath(path, 'user-provided');
  if (paths.size > 32) throw new Error('too-many-adb-candidates');
  const candidates: Candidate[] = []; let failedAdb = 0;
  for (const [adbPath, sources] of paths) {
    const addresses = new Map<string, { sources: string[]; state: string }>();
    const addAddress = (address: unknown, source: string, state = 'unverified') => {
      if (!localAddress(address)) return;
      if (context.addresses !== undefined && !context.addresses.includes(address)) return;
      const old = addresses.get(address);
      addresses.set(address, { sources: [...new Set([...(old?.sources ?? []), source])], state: state === 'unverified' ? old?.state ?? state : state });
    };
    addAddress(connect.Address, 'configured-address');
    if (Array.isArray(connect.AddressHistory)) for (const address of connect.AddressHistory) addAddress(address, 'address-history');
    for (const address of context.addresses ?? []) addAddress(address, 'user-provided');
    try {
      const result = await adb.run(adbPath, ['devices']);
      if (result.exitCode !== 0) failedAdb++;
      else for (const line of result.stdout.split(/\r?\n/)) {
        const match = /^(\S+)\s+(device|offline|unauthorized)(?:\s|$)/.exec(line.trim());
        if (match) addAddress(match[1], 'adb-devices', match[2]);
      }
    } catch { failedAdb++; }
    for (const [address, details] of addresses) candidates.push({ id: hash([adbPath, address]), adbPath, address, sources: [...sources, ...details.sources], state: details.state });
  }
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  if (candidates.length > 128) throw new Error('too-many-connection-candidates');
  const discoveryRevision = hash([current.config, candidates.map(({ id }) => id)]);
  return { directory, current, candidates, discoveryRevision, adbCount: paths.size, failedAdb };
}

export async function discoverSetupConnections(context: ConnectionContext = {}, adb: AdbBoundary = systemAdb) {
  const found = await discover(context, adb);
  return { discoveryRevision: found.discoveryRevision, adbCount: found.adbCount, failedAdb: found.failedAdb,
    requiresSelection: found.candidates.length > 1,
    candidates: found.candidates.map(({ id, sources, state }, index) => ({ id, index, sources, state })) };
}
export type ConnectionSelection = { discoveryRevision: string; candidate?: string };
async function selectConnection(selection: ConnectionSelection, context: ConnectionContext, adb: AdbBoundary) {
  const found = await discover(context, adb);
  if (selection.discoveryRevision !== found.discoveryRevision) return { reason: 'discovery-changed' } as const;
  if (!selection.candidate && found.candidates.length > 1) return { reason: 'candidate-selection-required' } as const;
  const chosen = selection.candidate ? found.candidates.find(item => item.id === selection.candidate) : found.candidates[0];
  if (!chosen) return { reason: 'candidate-unavailable' } as const;
  return { found, chosen };
}
async function testCandidate(chosen: Candidate, adb: AdbBoundary) {
  try {
    if (!chosen.address.startsWith('emulator-')) {
      const connected = await adb.run(chosen.adbPath, ['connect', chosen.address]);
      if (connected.exitCode !== 0) return false;
    }
    const state = await adb.run(chosen.adbPath, ['-s', chosen.address, 'get-state']);
    return state.exitCode === 0 && state.stdout.trim() === 'device';
  } catch { return false; }
}
export async function testSetupConnection(selection: ConnectionSelection, context: ConnectionContext = {}, adb: AdbBoundary = systemAdb) {
  const selected = await selectConnection(selection, context, adb);
  if ('reason' in selected) return { status: 'rejected', reason: selected.reason };
  const passed = await testCandidate(selected.chosen, adb);
  return { status: passed ? 'connected' : 'failed', reason: passed ? 'adb-transport-only' : 'connection-test-failed', candidate: selected.chosen.id };
}

export type SetupWriteRequest = ConnectionSelection & { host: 'codex' | 'claude'; reference: string; closedConfirmed?: boolean };
export async function applySetupConnection(request: SetupWriteRequest, context: ConnectionContext = {}, adb: AdbBoundary = systemAdb, maa?: MaaProcess) {
  if (!['codex', 'claude'].includes(request.host) || typeof request.reference !== 'string' || !request.reference.trim()
    || request.closedConfirmed !== undefined && typeof request.closedConfirmed !== 'boolean') return { status: 'rejected', reason: 'request-invalid' };
  const selected = await selectConnection(request, context, adb);
  if ('reason' in selected) return { status: 'rejected', reason: selected.reason };
  if (!await testCandidate(selected.chosen, adb)) return { status: 'rejected', reason: 'connection-test-failed' };
  const settings = await readSettings(context.home);
  const { found, chosen } = selected;
  // Bind the exact configuration observed during candidate selection, before the adb test.
  const expectedRevision = hash(found.current.config);
  const connect = object(found.current.gui.ConnectSettings);
  const values = { AdbPath: chosen.adbPath, Address: chosen.address, AutoDetect: false, AlwaysAutoDetect: false };
  if (Object.keys(values).some(key => !Object.hasOwn(connect, key))) return { status: 'rejected', reason: 'initialize-connection-in-maa' };
  const changes = Object.entries(values).filter(([key, value]) => connect[key] !== value)
    .map(([key, value]) => ({ path: ['Configurations', found.current.profileIndex, 'Gui', 'ConnectSettings', key], value }));
  if (!changes.length) {
    if ((await inspectConfiguration(found.directory)).revision !== expectedRevision) return { status: 'rejected', reason: 'configuration-changed' };
    return { status: 'unchanged', reason: 'connection-already-configured' };
  }
  const boundary = maa ?? (await import('./maa-process.ts')).createMaaProcess(found.directory);
  return executeConfigWrite({ maaDirectory: found.directory, privateDirectory: settings.privateDirectory, host: request.host,
    expectedRevision, closedConfirmed: request.closedConfirmed, authorization: { source: 'current-request', reference: request.reference }, changes }, boundary);
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
        result = action === 'test' ? await testSetupConnection(body as ConnectionSelection, context) : await applySetupConnection(body as SetupWriteRequest, context);
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
