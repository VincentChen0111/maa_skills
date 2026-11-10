import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { checkSetup, checkRuntime, prepareSetup, discoverSetupConnections, testSetupConnection, applySetupConnection, type AdbBoundary } from '../skills/maa-core/scripts/setup.ts';
import type { MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';
import { runChecks, executeRepairs } from '../skills/maa-core/scripts/doctor.ts';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'maa-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'settings'); const maaDirectory = join(root, 'maa'); const privateDirectory = join(root, 'private');
  await mkdir(join(maaDirectory, 'config'), { recursive: true });
  await writeFile(join(maaDirectory, 'MAA.exe'), 'synthetic executable');
  const config = { Current: 'Synthetic private name', Configurations: { 'Synthetic private name': {
    Gui: { ConnectSettings: { AdbPath: '', Address: '', AddressHistory: [], AutoDetect: true, AlwaysAutoDetect: false },
      RuntimeSettings: { ClientType: 'Official', StartGame: true } }, TaskQueue: [],
  } }, Timers: { List: [] }, Unknown: 'synthetic-hidden-value' };
  const configFile = join(maaDirectory, 'config/gui.new.json'); await writeFile(configFile, JSON.stringify(config));
  return { root, home, maaDirectory, privateDirectory, configFile, config };
}

test('setup checks fresh settings without creating them and repeats only its own environment record', async (t) => {
  const f = await fixture(t);
  const fresh = await checkSetup({ home: f.home, maaDirectory: f.maaDirectory });
  assert.equal(fresh.needsLanguagePrompt, true); assert.equal(fresh.needsDirectoryPrompt, true);
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
  await updateSettings({ language: 'en', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }, f.home);
  const beforeSettings = await readFile(join(f.home, 'config.json'));
  const result = await prepareSetup({ home: f.home });
  assert.equal(result.needsLanguagePrompt, false); assert.equal(result.needsDirectoryPrompt, false);
  assert.equal(result.language, 'en');
  assert.deepEqual(result.checks.map(item => item.id), ['platform', 'maa', 'server', 'node', 'settings', 'private-directory', 'version']);
  assert.equal(result.checks.every(item => item.repair.description !== item.repair.id), true, 'each check supplies an actionable explanation');
  await writeFile(join(f.privateDirectory, 'account-snapshot.json'), 'synthetic existing snapshot');
  await prepareSetup({ home: f.home });
  assert.deepEqual(await readFile(join(f.home, 'config.json')), beforeSettings);
  assert.equal(await readFile(join(f.privateDirectory, 'account-snapshot.json'), 'utf8'), 'synthetic existing snapshot');
  assert.deepEqual((await readdir(f.privateDirectory)).sort(), ['account-snapshot.json', 'setup-environment.json']);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic private name|synthetic-hidden-value|maa-setup-/);
});

test('runtime requires Windows and Node 24, including rejecting newer unsupported Node', () => {
  assert.deepEqual(checkRuntime('win32', '24.12.0'), { windows: true, node24: true });
  assert.deepEqual(checkRuntime('linux', '22.0.0'), { windows: false, node24: false });
  assert.equal(checkRuntime('win32', '25.0.0').node24, false);
});

test('connection discovery is fresh, redacted, and ambiguous candidates require selection before adb connect', async (t) => {
  const f = await fixture(t); const adbPath = join(f.maaDirectory, 'adb.exe'); await writeFile(adbPath, 'synthetic adb');
  await updateSettings({ language: 'zh-CN', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }, f.home);
  const calls: string[][] = [];
  const adb: AdbBoundary = { run: async (_file, args) => { calls.push(args); return { exitCode: 0, stdout: args[0] === 'devices' ? 'List of devices attached\n127.0.0.1:5555\tdevice\n127.0.0.1:5557\toffline\n' : args.at(-1) === 'get-state' ? 'device\n' : 'connected' }; } };
  const found = await discoverSetupConnections({ home: f.home }, adb);
  assert.equal(found.candidates.length, 2); assert.equal(found.requiresSelection, true);
  const chosen = found.candidates.find(item => item.state === 'device')!;
  assert.doesNotMatch(JSON.stringify(found), /127\.0\.0\.1|maa-setup-|Synthetic private/);
  const undecided = await testSetupConnection({ discoveryRevision: found.discoveryRevision }, { home: f.home }, adb);
  assert.equal(undecided.reason, 'candidate-selection-required');
  assert.equal(calls.every(args => args[0] === 'devices'), true);
  const tested = await testSetupConnection({ discoveryRevision: found.discoveryRevision, candidate: chosen.id }, { home: f.home }, adb);
  assert.equal(tested.status, 'connected');
  assert.deepEqual(calls.slice(-2), [['connect', '127.0.0.1:5555'], ['-s', '127.0.0.1:5555', 'get-state']]);
  const failed: AdbBoundary = { run: async (_file, args) => ({ exitCode: 0, stdout: args[0] === 'devices' ? 'List of devices attached\n127.0.0.1:5555\tdevice\n127.0.0.1:5557\toffline\n' : 'offline' }) };
  assert.equal((await testSetupConnection({ discoveryRevision: found.discoveryRevision, candidate: chosen.id }, { home: f.home }, failed)).status, 'failed');
  await rm(adbPath);
  assert.equal((await testSetupConnection({ discoveryRevision: found.discoveryRevision, candidate: chosen.id }, { home: f.home }, adb)).reason, 'discovery-changed');
  assert.deepEqual(await readdir(f.home), ['config.json']);
});

test('setup connection writes use the unified transaction, require closed confirmation, and skip already configured connections', async (t) => {
  const f = await fixture(t); const adbPath = join(f.maaDirectory, 'adb.exe'); await writeFile(adbPath, 'synthetic adb');
  await updateSettings({ language: 'en', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }, f.home);
  const adb: AdbBoundary = { run: async (_file, args) => ({ exitCode: 0, stdout: args[0] === 'devices' ? 'List of devices attached\n127.0.0.1:5555\tdevice\n' : args.at(-1) === 'get-state' ? 'device' : 'connected' }) };
  let running = false; const actions: string[] = [];
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }),
    close: async () => { actions.push('close'); running = false; }, start: async () => { actions.push('start'); running = true; } };
  const found = await discoverSetupConnections({ home: f.home }, adb);
  const request = { discoveryRevision: found.discoveryRevision, host: 'codex' as const, reference: 'synthetic installation request' };
  const original = await readFile(f.configFile);
  assert.equal((await applySetupConnection(request, { home: f.home }, adb, maa)).reason, 'closed-confirmation-required');
  assert.deepEqual(await readFile(f.configFile), original); assert.deepEqual(actions, []);
  const result = await applySetupConnection({ ...request, closedConfirmed: true }, { home: f.home }, adb, maa);
  assert.equal(result.status, 'complete', JSON.stringify(result)); assert.deepEqual(actions, ['start']);
  const changed = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.deepEqual(changed.Configurations['Synthetic private name'].Gui.ConnectSettings, {
    AdbPath: adbPath, Address: '127.0.0.1:5555', AddressHistory: [], AutoDetect: false, AlwaysAutoDetect: false,
  });
  assert.equal(changed.Unknown, 'synthetic-hidden-value'); assert.equal(changed.Configurations['Synthetic private name'].Gui.RuntimeSettings.StartGame, true);
  assert.equal((await readdir(join(f.privateDirectory, 'maa-config-backups'))).length, 1);
  assert.equal(JSON.parse((await readFile(join(f.privateDirectory, 'daily-pending.jsonl'), 'utf8')).trim()).skill, 'maa-setup');
  const next = await discoverSetupConnections({ home: f.home }, adb);
  assert.equal((await applySetupConnection({ ...request, discoveryRevision: next.discoveryRevision }, { home: f.home }, adb, maa)).status, 'unchanged');
  assert.deepEqual(actions, ['start']);
});

test('setup CLI reports missing prerequisites and malformed input without raw paths or a download', async (t) => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('../skills/maa-core/scripts/setup.ts', import.meta.url));
  const env = { ...process.env, MAA_SKILLS_HOME: f.home, HOME: f.root, USERPROFILE: f.root };
  const run = (action: string, input: unknown = {}) => spawnSync(process.execPath, [script, action, '--json'], { env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
  const missing = run('check'); assert.equal(missing.status, 1, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).needsLanguagePrompt, true);
  assert.equal(JSON.parse(missing.stdout).checks.find((item: { id: string }) => item.id === 'maa').reason, 'maa-gui-missing');
  const noSettings = run('prepare'); assert.equal(noSettings.status, 1); assert.equal(JSON.parse(noSettings.stdout).reason, 'set-preferences-first');
  const invalid = run('apply', { shell: 'synthetic command' }); assert.equal(invalid.status, 1);
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
  assert.doesNotMatch(missing.stdout + noSettings.stdout + invalid.stdout, /maa-setup-|synthetic command|Synthetic private/);
  await updateSettings({ language: 'en', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }, f.home);
  await writeFile(f.privateDirectory, 'synthetic blocked directory');
  const blocked = run('prepare'); assert.equal(blocked.status, 2); assert.equal(JSON.parse(blocked.stdout).status, 'unexpected-failure');
  assert.doesNotMatch(blocked.stdout, /maa-setup-|EPERM|ENOTDIR|EEXIST/);
});

test('explicit local candidates narrow discovery and reject remote addresses and non-adb executables', async (t) => {
  const f = await fixture(t); const configuredAdb = join(f.maaDirectory, 'adb.exe'); const selectedAdb = join(f.root, 'selected-adb.exe');
  await writeFile(configuredAdb, 'synthetic adb one'); await writeFile(selectedAdb, 'synthetic adb two');
  await updateSettings({ languageAsked: true, privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }, f.home);
  const calls: string[] = [];
  const adb: AdbBoundary = { run: async file => { calls.push(file); return { exitCode: 0, stdout: 'List of devices attached\n127.0.0.1:5555 device\n127.0.0.1:5557 device\n' }; } };
  const explicit = await discoverSetupConnections({ home: f.home, adbPaths: [selectedAdb], addresses: ['127.0.0.1:5557'] }, adb);
  assert.equal(explicit.candidates.length, 1); assert.equal(explicit.requiresSelection, false); assert.deepEqual(calls, [selectedAdb]);
  await assert.rejects(discoverSetupConnections({ home: f.home, addresses: ['192.0.2.1:5555'] }, adb), /candidate-input-invalid/);
  await assert.rejects(discoverSetupConnections({ home: f.home, adbPaths: ['relative-adb.exe'] }, adb), /candidate-input-invalid/);
  assert.equal((await discoverSetupConnections({ home: f.home, adbPaths: [process.execPath] }, adb)).adbCount, 0);
  assert.equal((await checkSetup({ home: f.home })).needsLanguagePrompt, false, 'declining language once must not prompt again');
  Reflect.set(f.config.Configurations['Synthetic private name'].Gui.RuntimeSettings, 'ClientType', ['Official']);
  await writeFile(f.configFile, JSON.stringify(f.config));
  await assert.rejects(discoverSetupConnections({ home: f.home }, adb), /cn-client-required/);
});

test('missing or unsupported current client is a check error; unknown MAA versions remain warnings and live changes are reread', async (t) => {
  const f = await fixture(t);
  await updateSettings({ language: 'en', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }, f.home);
  await mkdir(f.privateDirectory);
  const first = await checkSetup({ home: f.home }, async () => '99.1.2');
  assert.equal(first.checks.find(item => item.id === 'version')!.status, 'warning'); assert.equal(first.version.installed, '99.1.2');
  assert.equal(first.checks.find(item => item.id === 'server')!.status, 'normal');
  const changed = structuredClone(f.config); changed.Configurations['Synthetic private name'].Gui.RuntimeSettings.ClientType = 'YoStarEN';
  await writeFile(f.configFile, JSON.stringify(changed));
  assert.equal((await checkSetup({ home: f.home }, async () => null)).checks.find(item => item.id === 'server')!.reason, 'unsupported-client');
  Reflect.deleteProperty(changed.Configurations['Synthetic private name'].Gui, 'RuntimeSettings');
  await writeFile(f.configFile, JSON.stringify(changed));
  assert.equal((await checkSetup({ home: f.home }, async () => null)).checks.find(item => item.id === 'server')!.reason, 'client-unverified');
  await writeFile(f.configFile, '{');
  assert.equal((await checkSetup({ home: f.home }, async () => null)).checks.find(item => item.id === 'maa')!.reason, 'maa-configuration-unreadable');
});

test('connection mutation rejects stale evidence and live locks; failed restart leaves a doctor-recoverable setup transaction', async t => {
  for (const mode of ['busy', 'stale-during-test', 'restart-failed', 'profile-changed-on-close']) await t.test(mode, async t => {
    const f = await fixture(t); const adbPath = join(f.maaDirectory, 'adb.exe'); await writeFile(adbPath, 'synthetic adb');
    if (mode === 'restart-failed') { f.config.Configurations['Synthetic private name'].Gui.ConnectSettings.AdbPath = 'adb/platform-tools/adb.exe'; await writeFile(f.configFile, JSON.stringify(f.config)); }
    await updateSettings({ language: 'en', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }, f.home);
    let changeDuringTest = false;
    const adb: AdbBoundary = { run: async (_file, args) => {
      if (changeDuringTest && args.at(-1) === 'get-state') await writeFile(f.configFile, JSON.stringify({ ...f.config, NewSetting: true }));
      return { exitCode: 0, stdout: args[0] === 'devices' ? 'List of devices attached\n127.0.0.1:5555\tdevice\n' : args.at(-1) === 'get-state' ? 'device' : 'connected' };
    } };
    let running = mode === 'profile-changed-on-close'; const actions: string[] = [];
    const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }),
      close: async () => { actions.push('close'); running = false; if (mode === 'profile-changed-on-close') await writeFile(f.configFile, JSON.stringify({ ...f.config, Current: 'Changed synthetic profile' })); },
      start: async () => { actions.push('start'); if (mode !== 'restart-failed') running = true; } };
    const found = await discoverSetupConnections({ home: f.home }, adb);
    const request = { discoveryRevision: found.discoveryRevision, host: 'codex' as const, reference: 'synthetic installation request', closedConfirmed: true };
    const lockFile = join(f.maaDirectory, 'config/.maa-skills.lock');
    if (mode === 'busy') await writeFile(lockFile, JSON.stringify({ pid: process.pid }));
    if (mode === 'stale-during-test') changeDuringTest = true;
    const result = await applySetupConnection(request, { home: f.home }, adb, maa);
    if (mode === 'busy') { assert.equal(result.status, 'busy'); assert.deepEqual(actions, []); }
    if (mode === 'stale-during-test') { assert.equal(result.reason, 'configuration-changed'); assert.deepEqual(actions, []); }
    if (mode === 'profile-changed-on-close') {
      assert.equal(result.status, 'unknown'); assert.deepEqual(actions, ['close']);
      assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')).Configurations, f.config.Configurations);
    }
    if (mode === 'restart-failed') {
      assert.equal(result.status, 'unknown'); assert.deepEqual(actions, ['start']);
      // Model the persisted evidence after its real writer process has exited.
      const lock = JSON.parse(await readFile(lockFile, 'utf8')); lock.pid = 2147483647; await writeFile(lockFile, JSON.stringify(lock));
      const pendingFile = join(f.privateDirectory, 'daily-pending.jsonl'); const pending = JSON.parse((await readFile(pendingFile, 'utf8')).trim()); pending.pid = lock.pid;
      await writeFile(pendingFile, JSON.stringify(pending) + '\n');
      const checked = await runChecks(f, maa);
      assert.equal(checked.recovery.canRestore, true, JSON.stringify(checked.recovery));
      const working: MaaProcess = { ...maa, start: async () => { running = true; } };
      const repaired = await executeRepairs({ ...f, host: 'codex', approved: ['restore-config'], reference: 'synthetic restore request', evidenceRevision: checked.recovery.evidenceRevision, closedConfirmed: true }, working);
      assert.equal(repaired.status, 'complete', JSON.stringify(repaired));
      assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')), f.config);
    }
    assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|Synthetic private name|maa-setup-/);
  });
});
