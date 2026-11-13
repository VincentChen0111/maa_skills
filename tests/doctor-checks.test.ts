import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { runChecks, githubReleaseLookup, type ReleaseLookup } from '../skills/maa-core/scripts/doctor.ts';
import { checkSetup } from '../skills/maa-core/scripts/setup.ts';
import { checkGroups, skillRepairChannels } from '../skills/maa-core/scripts/checks.ts';
import { assessMaaVersion } from '../skills/maa-core/scripts/maa-version.ts';
import type { MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';
import { discoverSetupConnections, isAdbExecutablePath, type AdbBoundary } from '../skills/maa-core/scripts/setup-connection.ts';
import { versionDoublePreload } from './fixtures/maa-version-guard.ts';

const coreDirectory = fileURLToPath(new URL('../skills/maa-core', import.meta.url));
const windows = process.platform === 'win32';
const profile = 'Synthetic private profile';
type Options = { connect?: Record<string, unknown>; remote?: Record<string, unknown>; extraProfile?: Record<string, unknown> };

async function fixture(t: { after(fn: () => Promise<unknown>): void }, options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maa-doctor-checks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private'), skillsRoot = join(root, 'skills');
  await mkdir(join(maaDirectory, 'config'), { recursive: true }); await mkdir(privateDirectory, { recursive: true });
  await writeFile(join(maaDirectory, 'MAA.exe'), 'synthetic executable placeholder');
  const gui: Record<string, unknown> = { RuntimeSettings: { ClientType: 'Official' } };
  if (options.connect) gui.ConnectSettings = options.connect;
  if (options.remote) gui.RemoteControl = options.remote;
  const config: Record<string, any> = { Current: profile, Configurations: { [profile]: { TaskQueue: [], Gui: gui }, ...(options.extraProfile ?? {}) },
    Timers: { List: [], NotifyBeforeScheduledStart: false, ScheduledStartNotificationMinutes: 5 }, PrivateExample: 'synthetic-hidden-value' };
  const file = join(maaDirectory, 'config/gui.new.json');
  await writeFile(file, JSON.stringify(config));
  await updateSettings({ language: 'en', privateDirectory, maaDirectory }, home);
  await mkdir(skillsRoot); await cp(coreDirectory, join(skillsRoot, 'maa-core'), { recursive: true });
  const maa: MaaProcess = { inspect: async () => ({ running: true, ready: true, treeExited: false, idle: true }),
    close: async () => { throw new Error('unexpected close'); }, start: async () => { throw new Error('unexpected start'); } };
  const context = { home, maaDirectory, privateDirectory, skillsRoot };
  return { root, home, maaDirectory, privateDirectory, skillsRoot, config, file, maa, context };
}
const noAdb: AdbBoundary = { run: async () => { throw new Error('adb must not run'); } };
const quiet = { versionReader: async () => null, adb: noAdb };
const row = (result: { checks: { id: string }[] }, id: string) => result.checks.find(item => item.id === id) as any;

test('doctor covers the eight check groups with status, reason, repair and executor, reusing the setup installation rows', async (t) => {
  const f = await fixture(t);
  const result = await runChecks(f.context, f.maa, quiet);
  assert.deepEqual([...new Set(result.checks.map(item => item.group))], [...checkGroups]);
  assert.deepEqual(result.checks.map(item => item.id), ['platform', 'maa', 'server', 'node', 'settings', 'private-directory', 'version', 'connection',
    'configuration', 'configuration-fields', 'remote-control', 'write-lock', 'credential-nga', 'credential-skland', 'credential-bilibili', 'private-files', 'skill-version', 'skill-links']);
  for (const item of result.checks) {
    assert.ok(['normal', 'warning', 'error'].includes(item.status)); assert.ok(item.reason);
    assert.ok(item.repair.id && item.repair.description && ['skill', 'user'].includes(item.repair.executor));
    if (item.repair.executor === 'skill') assert.ok(item.repair.channel, `${item.id} names the existing channel that performs its repair`);
  }
  const setup = await checkSetup({ home: f.home }, async () => null);
  const installation = ['platform', 'maa', 'server', 'node', 'settings', 'private-directory', 'version'];
  assert.deepEqual(result.checks.filter(item => installation.includes(item.id)).map(({ group: _group, ...item }) => item), setup.checks.filter(item => installation.includes(item.id)));
  assert.equal(result.exitCode, windows ? 0 : 1);
  assert.deepEqual(result.version, setup.version);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic private profile|synthetic-hidden-value|maa-doctor-checks-/);
  assert.deepEqual(JSON.parse(await readFile(join(f.privateDirectory, 'doctor-latest.json'), 'utf8')), result);
});

test('every skill-executed repair names an existing channel script and action, never a second writer', async () => {
  const channels = { ...skillRepairChannels(), 'reconcile-lock': 'doctor.ts repair', 'restore-config': 'doctor.ts repair' };
  const actions: Record<string, RegExp> = { 'preferences.ts': /process\.argv\[2\] === '(\w+)'/g, 'setup.ts': /\['check', 'prepare', 'discover', 'test', 'apply'(?:, \.\.\.Object\.keys\(downloadActions\))?\]/g, 'doctor.ts': /\['check', 'analyze', 'repair'\]/g };
  for (const [repair, channel] of Object.entries(channels)) {
    const [script, action, flag] = channel.split(' ');
    const source = await readFile(join(coreDirectory, 'scripts', script!), 'utf8');
    const accepted = script === 'preferences.ts' ? [...source.matchAll(actions[script]!)].map(match => match[1]) : (source.match(actions[script!]!) ?? [''])[0]!;
    for (const name of action!.split('|')) assert.ok(accepted.includes(name), `${repair}: ${script} accepts ${name}`);
    if (flag) assert.match(source, new RegExp(flag.replace(/[-]/g, '\\-')), `${repair}: ${script} accepts ${flag}`);
  }
});

test('MAA version records only warn when missing, empty or not covering the installed version', () => {
  const unavailable = assessMaaVersion('6.21.4', { available: false, recordVersion: null, sourceVerified: [], deviceVerified: [] });
  assert.deepEqual([unavailable.status, unavailable.reason], ['warning', 'verification-record-unavailable']);
  const empty = assessMaaVersion('6.21.4', { available: true, recordVersion: 1, sourceVerified: [], deviceVerified: [] });
  assert.deepEqual([empty.status, empty.reason, empty.evidence.recordEmpty], ['warning', 'verification-record-empty', true]);
  const unknown = assessMaaVersion(null, { available: true, recordVersion: 1, sourceVerified: ['6.21.4'], deviceVerified: ['6.21.4'] });
  assert.deepEqual([unknown.status, unknown.reason], ['warning', 'maa-version-unknown']);
  const partly = assessMaaVersion('6.22.0', { available: true, recordVersion: 1, sourceVerified: ['6.22.0'], deviceVerified: ['6.21.4'] });
  assert.deepEqual([partly.status, partly.reason], ['warning', 'maa-version-not-fully-verified']);
  const verified = assessMaaVersion('6.21.4', { available: true, recordVersion: 1, sourceVerified: ['6.21.4'], deviceVerified: ['6.21.4'] });
  assert.deepEqual([verified.status, verified.reason], ['normal', 'maa-version-verified']);
});

test('an empty verification record is stated as empty, and a newer source-verified release is the same reminder as in setup', async (t) => {
  const f = await fixture(t);
  const verificationRecord = join(f.root, 'record.json');
  await writeFile(verificationRecord, JSON.stringify({ schemaVersion: 2, recordVersion: 1, sourceVerified: [], deviceVerified: [] }));
  const result = await runChecks({ ...f.context, verificationRecord }, f.maa, { ...quiet, versionReader: async () => '6.21.4' });
  assert.deepEqual([row(result, 'version').status, row(result, 'version').reason], ['warning', 'verification-record-empty']);
  assert.deepEqual(result.version, { installed: '6.21.4', recordAvailable: true, recordEmpty: true, recordVersion: 1, sourceVerified: false, deviceVerified: false,
    newerSourceVerified: null, newerDeviceVerified: false });
  await writeFile(verificationRecord, JSON.stringify({ schemaVersion: 2, recordVersion: 2, sourceVerified: ['6.21.4', '6.22.0'], deviceVerified: ['6.21.4'] }));
  const upgrade = await runChecks({ ...f.context, verificationRecord }, f.maa, { ...quiet, versionReader: async () => '6.21.4' });
  const setup = await checkSetup({ home: f.home, verificationRecord }, async () => '6.21.4');
  assert.deepEqual(row(upgrade, 'version'), { ...row(setup, 'version'), group: 'installation' });
  assert.deepEqual([row(upgrade, 'version').status, row(upgrade, 'version').reason, row(upgrade, 'version').repair.executor], ['warning', 'maa-upgrade-available', 'user']);
  assert.equal(upgrade.version.newerSourceVerified, '6.22.0');
});

test('connection checks read adb state without connecting or printing the address', async (t) => {
  const cases: [string, string, string, string, string, string][] = [
    ['online', '127.0.0.1:16384', '127.0.0.1:16384\tdevice', 'normal', 'device-online', 'inspect-connection-in-maa'],
    ['offline', '127.0.0.1:16384', '127.0.0.1:16384\toffline', 'error', 'device-offline', 'restart-emulator-and-adb'],
    ['unauthorized', '127.0.0.1:16384', '127.0.0.1:16384\tunauthorized', 'error', 'device-unauthorized', 'authorize-adb'],
    // adb lists a network address only after something connects to it, so absence says nothing about the emulator.
    ['network address not connected', '127.0.0.1:16384', 'emulator-5554\tdevice', 'warning', 'device-not-connected', 'test-connection-through-setup'],
    ['console port listed under its emulator serial', '127.0.0.1:5555', 'emulator-5554\tdevice', 'normal', 'device-online', 'inspect-connection-in-maa'],
    // adb scans local emulator ports only when its server starts, so an emulator started later is never auto-listed either.
    ['emulator serial not listed', 'emulator-5556', 'emulator-5554\tdevice', 'warning', 'device-not-connected', 'test-connection-through-setup'],
    ['local emulator port not listed', '127.0.0.1:5555', '', 'warning', 'device-not-connected', 'test-connection-through-setup'],
  ];
  for (const [name, address, listing, status, reason, repair] of cases) await t.test(name, async (t) => {
    const f = await fixture(t, { connect: { AdbPath: 'adb/synthetic-adb.exe', Address: address, AutoDetect: false } });
    await mkdir(join(f.maaDirectory, 'adb')); await writeFile(join(f.maaDirectory, 'adb/synthetic-adb.exe'), 'synthetic');
    const calls: string[][] = [];
    const adb: AdbBoundary = { run: async (_executable, args) => { calls.push(args); return { exitCode: 0, stdout: `List of devices attached\n${listing}\n` }; } };
    const result = await runChecks(f.context, f.maa, { ...quiet, adb });
    assert.deepEqual(calls, [['devices']]);
    assert.deepEqual([row(result, 'connection').status, row(result, 'connection').reason, row(result, 'connection').repair.id], [status, reason, repair]);
    if (reason === 'device-not-connected') {
      assert.match(row(result, 'connection').message, /not currently connected/);
      assert.doesNotMatch(row(result, 'connection').message, /not be running|not running/);
    }
    assert.doesNotMatch(JSON.stringify(result) + await readFile(join(f.privateDirectory, 'doctor-latest.json'), 'utf8'), /16384|127\.0\.0\.1|emulator-555|synthetic-adb/);
  });
  await t.test('a configured path that is not an adb executable is never run', async (t) => {
    for (const name of ['MAA.exe', 'HD-Player.exe', 'adb.exe.bak']) {
      const f = await fixture(t, { connect: { AdbPath: name, Address: '127.0.0.1:16384' } });
      if (name !== 'MAA.exe') await writeFile(join(f.maaDirectory, name), 'synthetic program that must not run');
      const calls: string[] = [];
      const adb: AdbBoundary = { run: async (executable) => { calls.push(executable); return { exitCode: 0, stdout: 'List of devices attached\n127.0.0.1:16384\tdevice\n' }; } };
      const result = await runChecks(f.context, f.maa, { ...quiet, adb });
      assert.deepEqual(calls, [], `${name} is not executed`);
      assert.deepEqual([row(result, 'connection').status, row(result, 'connection').reason, row(result, 'connection').repair.channel], ['warning', 'adb-path-unrecognized', 'setup.ts discover|test|apply']);
      assert.doesNotMatch(JSON.stringify(result), /HD-Player|adb\.exe\.bak/);
    }
  });
  await t.test('setup discovery and doctor share one adb executable predicate', async (t) => {
    const f = await fixture(t, { connect: { AdbPath: 'HD-Player.exe', Address: '127.0.0.1:16384' } });
    await writeFile(join(f.maaDirectory, 'HD-Player.exe'), 'synthetic program that must not run');
    const calls: string[] = [];
    const adb: AdbBoundary = { run: async (executable) => { calls.push(executable); return { exitCode: 0, stdout: 'List of devices attached\n' }; } };
    await discoverSetupConnections({ home: f.home, maaDirectory: f.maaDirectory }, adb);
    await discoverSetupConnections({ home: f.home, maaDirectory: f.maaDirectory, adbPaths: [join(f.maaDirectory, 'HD-Player.exe')] }, adb);
    assert.equal(calls.some(executable => /HD-Player/i.test(executable)), false);
    for (const [path, accepted] of [['adb.exe', true], ['vbox_adb.exe', true], ['HD-Adb.exe', true], ['MAA.exe', false], ['HD-Player.exe', false], ['adb.exe.bak', false], ['adb', false]] as const)
      assert.equal(isAdbExecutablePath(join(f.maaDirectory, path)), accepted, path);
  });
  await t.test('missing adb and unconfigured connections route to the setup channel', async (t) => {
    const missing = await fixture(t, { connect: { AdbPath: 'adb/absent-adb.exe', Address: '127.0.0.1:16384' } });
    const absent = await runChecks(missing.context, missing.maa, quiet);
    assert.deepEqual([row(absent, 'connection').status, row(absent, 'connection').reason, row(absent, 'connection').repair.channel], ['error', 'adb-missing', 'setup.ts discover|test|apply']);
    const unset = await fixture(t);
    const none = await runChecks(unset.context, unset.maa, quiet);
    assert.deepEqual([row(none, 'connection').status, row(none, 'connection').reason], ['warning', 'connection-not-configured']);
  });
  await t.test('a failing adb is unverified rather than offline', async (t) => {
    const f = await fixture(t, { connect: { AdbPath: join('adb', 'synthetic-adb.exe'), Address: 'emulator-5554' } });
    await mkdir(join(f.maaDirectory, 'adb')); await writeFile(join(f.maaDirectory, 'adb/synthetic-adb.exe'), 'synthetic');
    const result = await runChecks(f.context, f.maa, { ...quiet, adb: { run: async () => ({ exitCode: 1, stdout: '' }) } });
    assert.deepEqual([row(result, 'connection').status, row(result, 'connection').reason], ['warning', 'adb-unavailable']);
  });
});

test('configuration field checks validate the fields this project writes and name only field kinds', async (t) => {
  const f = await fixture(t);
  const config = structuredClone(f.config);
  config.Configurations[profile].TaskQueue = [{ $type: 'FightTask', TaskType: 'Fight', IsEnable: 'yes', UseMedicine: true, MedicineCount: -2 }];
  config.Timers.List = [{ IsEnabled: true, Hour: 25, Minute: 0, Config: profile }];
  await writeFile(f.file, JSON.stringify(config));
  const invalid = await runChecks(f.context, f.maa, quiet);
  assert.deepEqual([row(invalid, 'configuration-fields').status, row(invalid, 'configuration-fields').reason], ['error', 'managed-fields-invalid']);
  assert.deepEqual(row(invalid, 'configuration-fields').details, ['task.IsEnable', 'fight.MedicineCount', 'timer.Hour']);
  assert.equal(invalid.exitCode, 1);
  config.Configurations[profile].TaskQueue = [{ $type: 'FightTask', TaskType: 'Fight', IsEnable: true, UseMedicine: false, MedicineCount: 0 }];
  config.Timers.List = [{ IsEnabled: true, Hour: 4, Minute: 0, Config: 'Synthetic deleted profile' }];
  await writeFile(f.file, JSON.stringify(config));
  const missingProfile = await runChecks(f.context, f.maa, quiet);
  assert.deepEqual([row(missingProfile, 'configuration-fields').status, row(missingProfile, 'configuration-fields').reason], ['warning', 'timer-profile-missing']);
  assert.doesNotMatch(JSON.stringify(missingProfile), /Synthetic deleted profile|Synthetic private profile/);
  config.Timers.List = [{ IsEnabled: null, Hour: 4, Minute: 0, Config: profile }];
  await writeFile(f.file, JSON.stringify(config));
  assert.equal(row(await runChecks(f.context, f.maa, quiet), 'configuration-fields').reason, 'managed-fields-valid');
  await writeFile(f.file, '{');
  const corrupt = await runChecks(f.context, f.maa, quiet);
  assert.deepEqual(['configuration', 'configuration-fields', 'remote-control', 'connection'].map(id => row(corrupt, id).reason),
    ['Configuration cannot be parsed.', 'managed-fields-unknown', 'remote-control-unknown', 'connection-unreadable']);
});

/**
 * Merge of 27 with 10 (2026-11-14): the field check keeps 10's scope (task, medicine and timer fields). Stone and expiring
 * medicine are MAA's own states that the read summary classifies through the consumption predicate; a null stone switch is
 * what the MAA GUI saves when stone is on without "allow saving", so it must not become a blocking configuration error.
 */
test('stone and expiring-medicine states MAA itself saves are not configuration-field errors and block nothing', async (t) => {
  const f = await fixture(t);
  const config = structuredClone(f.config);
  const fight = { $type: 'FightTask', TaskType: 'Fight', IsEnable: true, UseMedicine: false, MedicineCount: 0, StoneCount: 3, UseStoneAllowSave: false,
    UseExpiringMedicine: true, MedicineExpireDays: 2, UseExpireMedicineForActivity: false };
  config.Configurations[profile].TaskQueue = [{ ...fight, UseStone: null }, { ...fight, UseStone: true, UseStoneAllowSave: true }];
  await writeFile(f.file, JSON.stringify(config));
  const result = await runChecks(f.context, f.maa, quiet);
  assert.deepEqual([row(result, 'configuration-fields').status, row(result, 'configuration-fields').reason], ['normal', 'managed-fields-valid']);
  assert.equal(result.exitCode, 0);
});

test('remote control reports only configured or not, with no endpoint or identity', async (t) => {
  const secrets = { RemoteControlGetTaskEndpointUri: 'synthetic-endpoint-ciphertext-marker', RemoteControlReportStatusUri: 'synthetic-report-marker',
    RemoteControlUserIdentity: 'synthetic-user-identity-marker', RemoteControlDeviceIdentity: 'synthetic-device-identity-marker', RemoteControlPollIntervalMs: 1000 };
  for (const [name, options, status, reason] of [
    ['configured on the current profile', { remote: secrets }, 'warning', 'remote-control-configured'],
    ['configured on another profile', { extraProfile: { 'Synthetic other profile': { Gui: { RemoteControl: secrets } } } }, 'warning', 'remote-control-configured'],
    ['empty endpoint', { remote: { ...secrets, RemoteControlGetTaskEndpointUri: '' } }, 'normal', 'remote-control-unconfigured'],
    ['absent', {}, 'normal', 'remote-control-unconfigured'],
  ] as [string, Options, string, string][]) await t.test(name, async (t) => {
    const f = await fixture(t, options);
    const result = await runChecks(f.context, f.maa, quiet);
    const item = row(result, 'remote-control');
    assert.deepEqual([item.status, item.reason, item.repair.id, item.repair.executor], [status, reason, status === 'warning' ? 'review-remote-control-in-maa' : 'no-remote-control-action', 'user']);
    if (status === 'warning') assert.match(item.message, /gacha/);
    const record = await readFile(join(f.privateDirectory, 'doctor-latest.json'), 'utf8');
    assert.doesNotMatch(JSON.stringify(result) + record, /synthetic-(endpoint|report|user-identity|device-identity)|Synthetic other profile/);
  });
});

test('private file checks report damaged records and leftover temporary files without changing them', async (t) => {
  const f = await fixture(t);
  assert.equal(row(await runChecks(f.context, f.maa, quiet), 'private-files').reason, 'private-files-readable');
  await writeFile(join(f.privateDirectory, 'account-snapshot.json'), '{ damaged');
  await writeFile(join(f.privateDirectory, 'daily-runs.jsonl'), '{"status":"complete"}\nnot json\n');
  await writeFile(join(f.privateDirectory, `doctor-latest.synthetic.tmp`), 'partial');
  const before = await readdir(f.privateDirectory);
  const damaged = await runChecks(f.context, f.maa, quiet);
  assert.deepEqual([row(damaged, 'private-files').status, row(damaged, 'private-files').reason, row(damaged, 'private-files').repair.executor], ['error', 'private-files-damaged', 'user']);
  assert.deepEqual(row(damaged, 'private-files').details, ['account-snapshot.json', 'daily-runs.jsonl', 'temporary-files:1']);
  assert.equal(await readFile(join(f.privateDirectory, 'account-snapshot.json'), 'utf8'), '{ damaged');
  assert.deepEqual((await readdir(f.privateDirectory)).sort(), [...before].sort());
  await rm(join(f.privateDirectory, 'account-snapshot.json')); await rm(join(f.privateDirectory, 'daily-runs.jsonl'));
  assert.deepEqual([row(await runChecks(f.context, f.maa, quiet), 'private-files').status, row(await runChecks(f.context, f.maa, quiet), 'private-files').reason], ['warning', 'private-files-temporary']);
});

test('skill version compares the installed maa-core version with an optional release lookup', async (t) => {
  const f = await fixture(t);
  const installed = JSON.parse(await readFile(join(coreDirectory, 'package.json'), 'utf8')).version;
  assert.match(installed, /^\d+\.\d+\.\d+/);
  const offline = await runChecks(f.context, f.maa, quiet);
  assert.deepEqual([row(offline, 'skill-version').status, row(offline, 'skill-version').reason, row(offline, 'skill-version').repair.channel], ['normal', 'skill-update-not-checked', 'doctor.ts check --online']);
  assert.deepEqual(offline.skills.version, { installed, latest: null, lookup: 'not-requested' });
  const cases: [ReleaseLookup, string, string][] = [
    [async () => ({ state: 'found', version: '99.0.0' }), 'warning', 'skill-update-available'],
    [async () => ({ state: 'found', version: installed }), 'normal', 'skill-up-to-date'],
    [async () => ({ state: 'none' }), 'normal', 'skill-release-none'],
    [async () => ({ state: 'failed' }), 'warning', 'skill-update-unknown'],
  ];
  for (const [releases, status, reason] of cases) {
    const result = await runChecks(f.context, f.maa, { ...quiet, releases });
    assert.deepEqual([row(result, 'skill-version').status, row(result, 'skill-version').reason], [status, reason]);
  }
  await writeFile(join(f.skillsRoot, 'maa-core/package.json'), '{}');
  assert.equal(row(await runChecks(f.context, f.maa, quiet), 'skill-version').reason, 'skill-version-unknown');
});

test('the GitHub release lookup reads only the latest published tag and treats failures as unknown', async () => {
  const urls: string[] = [];
  const respond = (status: number, body: unknown): typeof fetch => async (input) => { urls.push(String(input)); return new Response(JSON.stringify(body), { status }); };
  assert.deepEqual(await githubReleaseLookup(respond(200, { tag_name: 'v0.2.0', draft: false, prerelease: false }))(), { state: 'found', version: '0.2.0' });
  assert.deepEqual(await githubReleaseLookup(respond(404, { message: 'Not Found' }))(), { state: 'none' });
  assert.deepEqual(await githubReleaseLookup(respond(403, {}))(), { state: 'failed' });
  assert.deepEqual(await githubReleaseLookup(respond(200, { tag_name: 'not-a-version' }))(), { state: 'failed' });
  assert.deepEqual(await githubReleaseLookup(async () => { throw new Error('offline'); })(), { state: 'failed' });
  assert.ok(urls.every(url => url === 'https://api.github.com/repos/VincentChen0111/maa_skills/releases/latest'));
});

test('skill link checks find broken directory links and missing entries among installed maa_skills directories', async (t) => {
  const f = await fixture(t);
  const target = join(f.root, 'clone-doctor');
  await mkdir(target); await writeFile(join(target, 'SKILL.md'), '---\nname: maa-doctor\n---\n');
  await symlink(target, join(f.skillsRoot, 'maa-doctor'), windows ? 'junction' : 'dir');
  await mkdir(join(f.skillsRoot, 'unrelated-skill'));
  const intact = await runChecks(f.context, f.maa, quiet);
  assert.deepEqual([row(intact, 'skill-links').status, row(intact, 'skill-links').reason], ['normal', 'skill-links-intact']);
  assert.deepEqual(intact.skills.links, [{ name: 'maa-core', kind: 'directory', state: 'ok' }, { name: 'maa-doctor', kind: 'link', state: 'ok' }]);
  await rm(target, { recursive: true });
  await mkdir(join(f.skillsRoot, 'maa-help'));
  const broken = await runChecks(f.context, f.maa, quiet);
  assert.deepEqual([row(broken, 'skill-links').status, row(broken, 'skill-links').reason, row(broken, 'skill-links').repair.id], ['error', 'skill-link-broken', 'repair-skill-link']);
  assert.deepEqual(row(broken, 'skill-links').details, ['maa-doctor', 'maa-help']);
  assert.deepEqual(broken.skills.links.map((item: { state: string }) => item.state), ['ok', 'broken', 'no-skill-file']);
  assert.doesNotMatch(JSON.stringify(broken), /clone-doctor|maa-doctor-checks-/);
});

test('doctor CLI check accepts --online, keeps 0/1/2 exit codes and resolves the skills root from the invoked path', async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, MAA_SKILLS_HOME: f.home, USERPROFILE: f.root, HOME: f.root };
  const cli = join(f.skillsRoot, 'maa-core/scripts/doctor.ts');
  const invoke = (args: string[]) => spawnSync(process.execPath, ['--import', versionDoublePreload, cli, ...args], { env, input: '{}', encoding: 'utf8', windowsHide: true });
  const checked = invoke(['check', '--json']);
  assert.equal(checked.status, windows ? 0 : 1, checked.stdout + checked.stderr);
  const result = JSON.parse(checked.stdout);
  assert.deepEqual(result.skills.links, [{ name: 'maa-core', kind: 'directory', state: 'ok' }]);
  const human = invoke(['check']);
  assert.match(human.stdout, /\[skill-links\]/); assert.match(human.stdout, /connect-through-setup \(skill via setup\.ts discover\|test\|apply\)/);
  for (const args of [['check', '--json', '--json'], ['check', '--online', '--extra'], ['analyze', '--online'], ['repair', '--online']]) {
    const rejected = invoke(args); assert.equal(rejected.status, 1); assert.match(rejected.stdout, /usage/);
  }
  assert.ok(existsSync(join(f.privateDirectory, 'doctor-latest.json')));
  assert.doesNotMatch(checked.stdout + human.stdout, /Synthetic private profile|synthetic-hidden-value|maa-doctor-checks-/);
});
