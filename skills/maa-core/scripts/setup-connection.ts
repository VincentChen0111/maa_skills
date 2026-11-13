import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readSettings } from './preferences.ts';
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
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-object');
  return value as Record<string, unknown>;
}
async function isFile(path: string) { try { return (await stat(path)).isFile(); } catch { return false; } }
export async function currentConfiguration(directory: string) {
  const config = object(JSON.parse((await readFile(join(directory, 'config/gui.new.json'), 'utf8')).replace(/^\uFEFF/, '')));
  const profiles = object(config.Configurations);
  if (typeof config.Current !== 'string' || !Object.hasOwn(profiles, config.Current)) throw new Error('current-profile-invalid');
  const profile = object(profiles[config.Current]);
  return { config, profile, gui: object(profile.Gui), profileIndex: Object.keys(profiles).indexOf(config.Current) };
}
/**
 * The one rule for what may ever be run as adb, shared by setup discovery and doctor: the file name
 * must be an `…adb….exe` name. A configured MAA.exe, emulator player or any other program is never run.
 */
export function isAdbExecutablePath(path: unknown): path is string {
  return typeof path === 'string' && !!path.trim() && !/[\0\r\n]/.test(path) && /adb[^/\\]*\.exe$/i.test(basename(path.replaceAll('\\', '/')));
}
/** Resolves a configured or discovered path to an existing adb executable; the real target must pass the same rule. */
export async function resolveAdbExecutable(path: unknown, relativeTo: string): Promise<{ executable: string } | { reason: 'adb-path-unrecognized' | 'adb-missing' }> {
  if (!isAdbExecutablePath(path)) return { reason: 'adb-path-unrecognized' };
  const absolute = resolve(relativeTo, path);
  if (!await isFile(absolute)) return { reason: 'adb-missing' };
  const canonical = await realpath(absolute);
  return isAdbExecutablePath(canonical) ? { executable: canonical } : { reason: 'adb-path-unrecognized' };
}

export type ConnectionState = 'device-online' | 'device-offline' | 'device-unauthorized' | 'device-not-listed' | 'device-not-connected' | 'adb-unavailable'
  | 'adb-missing' | 'adb-path-unrecognized' | 'connection-not-configured' | 'connection-unreadable';
/**
 * Android adb (developer.android.com/tools/adb): the server finds local emulators by scanning odd ports 5555–5585
 * and lists each as `emulator-<console port>`, the console port being the adb port minus one. Other network
 * addresses appear only after something runs `adb connect`, so their absence says nothing about the emulator.
 */
function localAdbPort(value: string): number | null {
  const loopback = /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(value);
  if (loopback) return Number(loopback[1]);
  const serial = /^emulator-(\d{1,5})$/.exec(value);
  return serial ? Number(serial[1]) + 1 : null;
}
const autoListed = (port: number | null) => port !== null && port >= 5555 && port <= 5585 && port % 2 === 1;
/**
 * Doctor's read-only connection check: the current profile's adb path and address, then only `adb devices`.
 * It never runs `connect`, never runs a program that is not adb, never selects or writes a connection and
 * never returns the address or path.
 */
export async function inspectConnection(maaDirectory: string, adb: AdbBoundary = systemAdb): Promise<ConnectionState> {
  let connect: Record<string, unknown>;
  try {
    const current = await currentConfiguration(maaDirectory);
    connect = current.gui.ConnectSettings === undefined ? {} : object(current.gui.ConnectSettings);
  } catch { return 'connection-unreadable'; }
  const { AdbPath: adbPath, Address: address } = connect;
  if (typeof adbPath !== 'string' || !adbPath.trim() || typeof address !== 'string' || !address.trim()) return 'connection-not-configured';
  const resolved = await resolveAdbExecutable(adbPath, maaDirectory);
  if ('reason' in resolved) return resolved.reason;
  const port = localAdbPort(address);
  const same = (listed: string) => listed === address || port !== null && localAdbPort(listed) === port;
  try {
    const result = await adb.run(resolved.executable, ['devices']);
    if (result.exitCode !== 0) return 'adb-unavailable';
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^(\S+)\s+(\S+)/.exec(line.trim());
      if (match && same(match[1]!)) return match[2] === 'device' ? 'device-online' : match[2] === 'unauthorized' ? 'device-unauthorized' : 'device-offline';
    }
    return autoListed(port) ? 'device-not-listed' : 'device-not-connected';
  } catch { return 'adb-unavailable'; }
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
    if (!isAdbExecutablePath(path) || !isAbsolute(path) && !relativeTo) return;
    const resolved = await resolveAdbExecutable(path, relativeTo ?? directory);
    if ('reason' in resolved) return;
    const canonical = resolved.executable;
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
export async function prepareSetupConnection(request: SetupWriteRequest, context: ConnectionContext = {}, adb: AdbBoundary = systemAdb) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['discoveryRevision', 'candidate', 'host', 'reference', 'closedConfirmed'].includes(key))
    || Object.keys(context).some(key => !['home', 'maaDirectory', 'adbPaths', 'addresses'].includes(key))) return { status: 'rejected', reason: 'request-invalid' };
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
  return { writeRequest: { maaDirectory: found.directory, privateDirectory: settings.privateDirectory, host: request.host,
    expectedRevision, closedConfirmed: request.closedConfirmed, authorization: { source: 'current-request' as const, reference: request.reference }, changes } };
}
