import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-help/scripts/preferences.ts';
import { executeConfigWrite as writeConfig, inspectConfiguration, checkMaintenanceWindow, type MaaProcess, type WriteRequest } from '../skills/maa-help/scripts/maa-config.ts';

async function executeConfigWrite(request: Omit<WriteRequest, 'expectedRevision'> & { expectedRevision?: string }, maa: MaaProcess) {
  const expectedRevision = request.expectedRevision ?? (await inspectConfiguration(request.maaDirectory)).revision;
  return writeConfig({ ...request, expectedRevision }, maa);
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'maa-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const maa = join(root, 'maa'); const privateDirectory = join(root, 'private');
  await mkdir(join(maa, 'config'), { recursive: true });
  const config = {
    Current: 'Synthetic profile', ConfigVersion: 1,
    Configurations: { 'Synthetic profile': {
      Gui: { ConnectSettings: { Address: 'synthetic-secret-address' }, StartUpSettings: { RunDirectly: false }, RuntimeSettings: { StartGame: false } },
      TaskQueue: [{ TaskType: 'Fight', IsEnable: false, UseStone: false, UseMedicine: false, MedicineCount: 0, UseExpiringMedicine: false, UseExpireMedicineForActivity: false, StagePlan: ['1-7'] }, { TaskType: 'Infrast', IsEnable: true, PlanSelect: 3 }, { TaskType: 'Award', IsEnable: false, FreeGacha: false }],
    } },
    Timers: { List: [], NotifyBeforeScheduledStart: false, ScheduledStartNotificationMinutes: 5, CustomConfig: false },
    UnknownSetting: { keep: 'synthetic-secret-token' },
  };
  const file = join(maa, 'config', 'gui.new.json');
  await writeFile(file, JSON.stringify(config));
  return { root, maa, privateDirectory, file, config };
}

test('a confirmed closed MAA receives only the requested reminder change with backup and a private run record', async (t) => {
  const f = await fixture(t);
  // The MAA process boundary is the only substitute; configuration and evidence use real files.
  let running = false;
  const processBoundary: MaaProcess = {
    inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }),
    close: async () => { running = false; },
    start: async () => { running = true; },
  };
  const before = await readFile(f.file);
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
    authorization: { source: 'current-request', reference: 'synthetic request' },
    changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }],
  }, processBoundary);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.changedKeys, ['Timers.NotifyBeforeScheduledStart']);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { ...f.config, Timers: { ...f.config.Timers, NotifyBeforeScheduledStart: true } });
  const backup = await readdir(join(f.privateDirectory, 'maa-config-backups'));
  assert.equal(backup.length, 1);
  assert.deepEqual(await readFile(join(f.privateDirectory, 'maa-config-backups', backup[0]!)), before);
  assert.equal((await readdir(join(f.maa, 'config'))).includes('.maa-skills.lock'), false);
  const runs = await readFile(join(f.privateDirectory, 'daily-runs.jsonl'), 'utf8');
  assert.match(runs, /"status":"complete"/);
  const publicOutput = JSON.stringify({ result, summary: await inspectConfiguration(f.maa) });
  assert.doesNotMatch(publicOutput, /synthetic-secret|Synthetic profile/);
});

test('invalid grants and forbidden fields are rejected before closing MAA or creating a lock', async (t) => {
  const f = await fixture(t);
  let closeCalls = 0;
  const maa: MaaProcess = { inspect: async () => ({ running: true, treeExited: false, idle: true, ready: true }), close: async () => { closeCalls++; }, start: async () => {} };
  const before = await readFile(f.file);
  for (const changes of [
    [{ path: ['Configurations', 'Synthetic profile', 'TaskQueue', 0, 'UseStone'], value: true }],
    [{ path: ['Configurations', 'Synthetic profile', 'TaskQueue', 2, 'FreeGacha'], value: true }],
    [{ path: ['Configurations', 'Synthetic profile', 'Gui', 'RuntimeSettings', 'StartGame'], value: true }],
    [{ path: ['Configurations', 'Synthetic profile', 'TaskQueue', 0, 'UseMedicine'], value: true }],
  ]) {
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'current-request', reference: 'synthetic' }, changes }, maa);
    assert.equal(result.status, 'rejected');
    assert.equal(result.phase, 'check');
  }
  assert.equal(closeCalls, 0);
  assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await readdir(join(f.maa, 'config')), ['gui.new.json']);
});

test('a closed or busy MAA needs confirmation or idleness before any lock or pending write', async (t) => {
  const f = await fixture(t);
  for (const running of [false, true]) {
    const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: false, ready: running }), close: async () => { assert.fail('must not close'); }, start: async () => { assert.fail('must not start'); } };
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'claude', authorization: { source: 'current-request', reference: 'synthetic' }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] }, maa);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, running ? 'maa-not-idle' : 'closed-confirmation-required');
    assert.deepEqual(await readdir(join(f.maa, 'config')), ['gui.new.json']);
  }
});

test('concurrent calls cannot both close MAA and a retained lock is never deleted or stolen', async (t) => {
  const f = await fixture(t);
  let closed = false; let announceClose!: () => void; let releaseClose!: () => void;
  const closing = new Promise<void>(resolve => { announceClose = resolve; });
  const release = new Promise<void>(resolve => { releaseClose = resolve; });
  const maa: MaaProcess = {
    inspect: async () => ({ running: !closed, treeExited: closed, idle: true, ready: !closed }),
    close: async () => { announceClose(); await release; closed = true; }, start: async () => { closed = false; },
  };
  const request = { maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex' as const, authorization: { source: 'current-request' as const, reference: 'synthetic' }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] };
  const first = executeConfigWrite(request, maa);
  await closing;
  const contender = await executeConfigWrite({ ...request, host: 'claude' }, maa);
  assert.equal(contender.status, 'busy');
  releaseClose(); assert.equal((await first).status, 'complete');
  const lockFile = join(f.maa, 'config', '.maa-skills.lock');
  const stale = '{"pid":2147483647,"phase":"write","id":"synthetic-stale"}';
  await writeFile(lockFile, stale);
  const retained = await executeConfigWrite(request, maa);
  assert.equal(retained.status, 'unknown');
  assert.equal(retained.reason, 'lock-requires-reconciliation');
  assert.equal(await readFile(lockFile, 'utf8'), stale);
});

test('queue changes preserve task parameters and medicine requires the current exact quantity', async (t) => {
  const f = await fixture(t);
  let running = false;
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
    authorization: { source: 'current-request', reference: 'synthetic use two medicines', medicineCount: 2 }, changes: [
      { path: ['Configurations', 'Synthetic profile', 'TaskQueue', 0, 'UseMedicine'], value: true },
      { path: ['Configurations', 'Synthetic profile', 'TaskQueue', 0, 'MedicineCount'], value: 2 },
      { path: ['Configurations', 'Synthetic profile', 'TaskQueue', 0, 'IsEnable'], value: true },
    ],
  }, maa);
  assert.equal(result.status, 'complete');
  const expected = structuredClone(f.config);
  Object.assign(expected.Configurations['Synthetic profile'].TaskQueue[0]!, { UseMedicine: true, MedicineCount: 2, IsEnable: true });
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), expected);
  const denied = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'approved-report', reference: 'old report', medicineCount: 5 }, changes: [{ path: ['Configurations', 'Synthetic profile', 'TaskQueue', 0, 'MedicineCount'], value: 5 }] }, maa);
  assert.equal(denied.status, 'rejected');
  assert.doesNotMatch(JSON.stringify(result), /Synthetic profile|synthetic-secret/);
});

test('partial operations retain the lock and report their actual failure phase without replay', async (t) => {
  for (const failingPhase of ['close', 'backup', 'restart', 'readback']) {
    const f = await fixture(t); let running = true;
    if (failingPhase === 'backup') { await mkdir(f.privateDirectory); await writeFile(join(f.privateDirectory, 'maa-config-backups'), 'blocked'); }
    const maa: MaaProcess = {
      inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }),
      close: async () => { if (failingPhase === 'close') throw new Error('synthetic-secret-process-error'); running = false; },
      start: async () => {
        if (failingPhase === 'restart') throw new Error('synthetic-secret-start-error');
        running = true;
        if (failingPhase === 'readback') await writeFile(f.file, JSON.stringify(f.config));
      },
    };
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'claude', authorization: { source: 'current-request', reference: 'synthetic' }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] }, maa);
    assert.equal(result.status, 'unknown'); assert.equal(result.phase, failingPhase);
    const lock = JSON.parse(await readFile(join(f.maa, 'config', '.maa-skills.lock'), 'utf8'));
    assert.equal(lock.phase, failingPhase); assert.equal(lock.pid, process.pid);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
    assert.match(await readFile(join(f.privateDirectory, 'daily-pending.jsonl'), 'utf8'), /"source":"current-request"/);
    assert.match(await readFile(join(f.privateDirectory, 'daily-runs.jsonl'), 'utf8'), /"status":"unknown"/);
  }
});

test('the entire maintenance interval avoids recurring and one-shot timer windows including midnight', () => {
  const timers = { Timers: { List: [{ IsEnabled: null, Hour: 0, Minute: 0 }] } };
  // Native MAA timers use the computer local timezone, including the trigger minute.
  assert.equal(checkMaintenanceWindow(timers, new Date(2026, 10, 10, 23, 56), new Date(2026, 10, 10, 23, 57, 59)), true);
  assert.equal(checkMaintenanceWindow(timers, new Date(2026, 10, 10, 23, 57), new Date(2026, 10, 10, 23, 58)), false);
  assert.equal(checkMaintenanceWindow(timers, new Date(2026, 10, 11, 0, 0, 30), new Date(2026, 10, 11, 0, 1, 30)), false);
  assert.equal(checkMaintenanceWindow(timers, new Date(2026, 10, 11, 0, 2), new Date(2026, 10, 11, 0, 4)), true);
  assert.equal(checkMaintenanceWindow({ Timers: { List: [{ IsEnabled: true, Hour: 99, Minute: 0 }] } }, new Date(), new Date()), false);
});

test('a timer that would be reached during the full close-to-reopen budget prevents closing MAA', async (t) => {
  const f = await fixture(t);
  const now = new Date();
  const config = { ...f.config, Timers: { ...f.config.Timers, List: [{ IsEnabled: true, Hour: now.getHours(), Minute: now.getMinutes() }] } };
  await writeFile(f.file, JSON.stringify(config));
  const maa: MaaProcess = { inspect: async () => ({ running: true, treeExited: false, idle: true, ready: true }), close: async () => { assert.fail('timer window must prevent close'); }, start: async () => {} };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'current-request', reference: 'synthetic' }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] }, maa);
  assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'timer-window');
  assert.deepEqual(await readdir(join(f.maa, 'config')), ['gui.new.json']);
});

test('existing queue order and timer slots can change without replacing task or timer data', async (t) => {
  const f = await fixture(t); let running = false;
  const hour = (new Date().getHours() + 3) % 24;
  const config = { ...f.config, Timers: { ...f.config.Timers, List: [{ Id: 0, IsEnabled: false, Hour: hour, Minute: 0, Config: 'Synthetic profile', FutureField: 'keep' }] } };
  await writeFile(f.file, JSON.stringify(config));
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, authorization: { source: 'current-request', reference: 'synthetic timer and order' }, changes: [
    { path: ['Configurations', 'Synthetic profile', 'TaskQueue'], value: [2, 1, 0] },
    { path: ['Timers', 'List', 0, 'IsEnabled'], value: null },
    { path: ['Timers', 'ScheduledStartNotificationMinutes'], value: 10 },
  ] }, maa);
  assert.equal(result.status, 'complete');
  const actual = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(actual.Configurations['Synthetic profile'].TaskQueue, [config.Configurations['Synthetic profile'].TaskQueue[2], config.Configurations['Synthetic profile'].TaskQueue[1], config.Configurations['Synthetic profile'].TaskQueue[0]]);
  assert.deepEqual(actual.Timers.List, [{ ...config.Timers.List[0], IsEnabled: null }]);
  assert.equal(actual.Timers.ScheduledStartNotificationMinutes, 10);
});

test('enabling a timer cannot activate existing forbidden or unapproved consumption settings', async (t) => {
  const f = await fixture(t);
  const config = structuredClone(f.config);
  Object.assign(config.Configurations['Synthetic profile'].TaskQueue[0]!, { IsEnable: true, UseStone: true });
  Object.assign(config.Timers, { List: [{ IsEnabled: false, Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic profile' }] });
  await writeFile(f.file, JSON.stringify(config));
  const maa: MaaProcess = { inspect: async () => ({ running: true, treeExited: false, idle: true, ready: true }), close: async () => { assert.fail('must not close'); }, start: async () => {} };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'current-request', reference: 'only enable a timer' }, changes: [{ path: ['Timers', 'List', 0, 'IsEnabled'], value: true }] }, maa);
  assert.equal(result.status, 'rejected');
  assert.deepEqual(await readdir(join(f.maa, 'config')), ['gui.new.json']);
});

test('the CLI reads only settings-selected MAA summaries and never prints secrets or raw parse errors', async (t) => {
  const f = await fixture(t); const home = join(f.root, 'home');
  await updateSettings({ maaDirectory: f.maa, privateDirectory: f.privateDirectory }, home);
  const command = fileURLToPath(new URL('../skills/maa-help/scripts/maa-config.ts', import.meta.url));
  const invoke = (action: string, input: unknown = {}) => spawnSync(process.execPath, [command, action], { encoding: 'utf8', input: JSON.stringify(input), env: { ...process.env, MAA_SKILLS_HOME: home, HOME: home, USERPROFILE: home } });
  const result = invoke('read');
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true); assert.equal(summary.configuration.currentProfile, 0);
  assert.deepEqual(summary.configuration.profiles[0].queue.map((task: { type: string }) => task.type), ['Fight', 'Infrast', 'Award']);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret|Synthetic profile/);
  const forbidden = invoke('write', { host: 'codex', expectedRevision: summary.configuration.revision, authorization: { source: 'current-request', reference: 'synthetic' }, changes: [{ path: ['Configurations', 0, 'TaskQueue', 0, 'UseStone'], value: true }] });
  assert.equal(forbidden.status, 1);
  assert.equal(JSON.parse(forbidden.stdout).status, 'rejected');
  assert.deepEqual(await readdir(join(f.maa, 'config')), ['gui.new.json']);
  await writeFile(f.file, '{"synthetic-secret-corrupt');
  const corrupt = invoke('read'); assert.equal(corrupt.status, 1);
  assert.doesNotMatch(corrupt.stdout + corrupt.stderr, /synthetic-secret|Synthetic profile/);
});

test('profile indexes from the safe summary select a profile without exposing its private name', async (t) => {
  const f = await fixture(t); let running = false;
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, authorization: { source: 'current-request', reference: 'synthetic' }, changes: [{ path: ['Configurations', 0, 'TaskQueue', 2, 'IsEnable'], value: true }] }, maa);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.changedKeys, ['Configurations.<profile>.TaskQueue.2.IsEnable']);
});

test('a replaced lock is retained and release reports unknown even after verified writing', async (t) => {
  const f = await fixture(t); let running = false;
  const lockFile = join(f.maa, 'config', '.maa-skills.lock');
  const replacement = '{"id":"synthetic-other-owner","pid":2147483647}';
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; await rename(lockFile, lockFile + '.retained'); await writeFile(lockFile, replacement); } };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, authorization: { source: 'current-request', reference: 'synthetic' }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] }, maa);
  assert.equal(result.status, 'unknown'); assert.equal(result.phase, 'release');
  assert.equal(await readFile(lockFile, 'utf8'), replacement);
  assert.match(await readFile(join(f.privateDirectory, 'daily-runs.jsonl'), 'utf8'), /"status":"unknown"/);
});

test('a process that reappears after close prevents the atomic configuration replacement', async (t) => {
  const f = await fixture(t); let afterClose = false; let inspections = 0;
  const before = await readFile(f.file);
  const maa: MaaProcess = {
    inspect: async () => {
      const exited = afterClose && inspections++ === 0;
      return { running: !exited, treeExited: exited, idle: true, ready: !exited };
    },
    close: async () => { afterClose = true; inspections = 0; }, start: async () => {},
  };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'current-request', reference: 'synthetic' }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] }, maa);
  assert.equal(result.status, 'unknown'); assert.equal(result.phase, 'write');
  assert.deepEqual(await readFile(f.file), before);
});

test('only a boolean user confirmation is accepted from runtime JSON', async (t) => {
  const f = await fixture(t);
  const request = JSON.parse(JSON.stringify({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: 'false', authorization: { source: 'current-request', reference: 'synthetic' }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] }));
  const maa: MaaProcess = { inspect: async () => ({ running: false, treeExited: true, idle: false, ready: false }), close: async () => {}, start: async () => {} };
  const result = await executeConfigWrite(request, maa);
  assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'request-invalid');
  assert.deepEqual(await readdir(join(f.maa, 'config')), ['gui.new.json']);
});

test('the authorized task cannot change identity while MAA is closing', async (t) => {
  const f = await fixture(t); let running = true;
  const config = structuredClone(f.config);
  Object.assign(config.Configurations['Synthetic profile'], { TaskQueue: [{ TaskType: 'Infrast', IsEnable: false }, { TaskType: 'Mall', IsEnable: false }] });
  await writeFile(f.file, JSON.stringify(config));
  const reordered = structuredClone(config);
  reordered.Configurations['Synthetic profile'].TaskQueue.reverse();
  const maa: MaaProcess = {
    inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }),
    close: async () => { running = false; await writeFile(f.file, JSON.stringify(reordered)); }, start: async () => { running = true; },
  };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'current-request', reference: 'enable Infrast' }, changes: [{ path: ['Configurations', 0, 'TaskQueue', 0, 'IsEnable'], value: true }] }, maa);
  assert.equal(result.status, 'unknown'); assert.equal(result.phase, 'backup');
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), reordered);
});

test('a stale read summary cannot authorize a task at a newly occupied index', async (t) => {
  const f = await fixture(t);
  const summary = await inspectConfiguration(f.maa);
  const configuration = structuredClone(f.config); configuration.Configurations['Synthetic profile'].TaskQueue.reverse();
  await writeFile(f.file, JSON.stringify(configuration));
  const request = JSON.parse(JSON.stringify({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, expectedRevision: summary.revision, authorization: { source: 'current-request', reference: 'enable Fight from the earlier summary' }, changes: [{ path: ['Configurations', 0, 'TaskQueue', 0, 'IsEnable'], value: true }] }));
  const maa: MaaProcess = { inspect: async () => { assert.fail('stale request must not inspect processes'); }, close: async () => {}, start: async () => {} };
  const result = await executeConfigWrite(request, maa);
  assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'configuration-changed');
});

test('duplicate Fight tasks can be reordered independently by their bound positions', async (t) => {
  const f = await fixture(t); let running = false;
  const config = structuredClone(f.config);
  const first = { ...config.Configurations['Synthetic profile'].TaskQueue[0]!, StagePlan: ['1-7'] };
  const second = { ...first, StagePlan: ['CE-6'] };
  const base = config.Configurations['Synthetic profile'].TaskQueue[1]!;
  Object.assign(config.Configurations['Synthetic profile'], { TaskQueue: [first, second, base] });
  await writeFile(f.file, JSON.stringify(config));
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, authorization: { source: 'current-request', reference: 'base then second Fight then first Fight' }, changes: [{ path: ['Configurations', 0, 'TaskQueue'], value: [2, 1, 0] }] }, maa);
  assert.equal(result.status, 'complete');
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).Configurations['Synthetic profile'].TaskQueue, [base, second, first]);
});

test('medicine authorization cannot exceed the native signed 32-bit configuration field', async (t) => {
  const f = await fixture(t); const before = await readFile(f.file);
  let running = false;
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, authorization: { source: 'current-request', reference: 'synthetic', medicineCount: 2147483648 }, changes: [
    { path: ['Configurations', 0, 'TaskQueue', 0, 'UseMedicine'], value: true },
    { path: ['Configurations', 0, 'TaskQueue', 0, 'MedicineCount'], value: 2147483648 },
  ] }, maa);
  assert.equal(result.status, 'rejected');
  assert.deepEqual(await readFile(f.file), before);
});

test('one medicine budget cannot be reused by two Fight tasks when enabling a timer', async (t) => {
  const f = await fixture(t); let running = false;
  const config = structuredClone(f.config);
  const fight = { ...config.Configurations['Synthetic profile'].TaskQueue[0]!, IsEnable: true, UseMedicine: true, MedicineCount: 2 };
  Object.assign(config.Configurations['Synthetic profile'], { TaskQueue: [fight, { ...fight, StagePlan: ['CE-6'] }] });
  Object.assign(config.Timers, { List: [{ IsEnabled: false, Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic profile' }] });
  await writeFile(f.file, JSON.stringify(config));
  const before = await readFile(f.file);
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, authorization: { source: 'current-request', reference: 'at most two medicines', medicineCount: 2 }, changes: [{ path: ['Timers', 'List', 0, 'IsEnabled'], value: null }] }, maa);
  assert.equal(result.status, 'rejected'); assert.deepEqual(await readFile(f.file), before);
});

test('a current medicine budget can be allocated across two distinct Fight tasks once', async (t) => {
  const f = await fixture(t); let running = false;
  const config = structuredClone(f.config);
  const fight = config.Configurations['Synthetic profile'].TaskQueue[0]!;
  Object.assign(config.Configurations['Synthetic profile'], { TaskQueue: [fight, { ...fight, StagePlan: ['CE-6'] }] });
  await writeFile(f.file, JSON.stringify(config));
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
  const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, authorization: { source: 'current-request', reference: 'one medicine for each Fight, two total', medicineCount: 2 }, changes: [0, 1].flatMap(index => [
    { path: ['Configurations', 0, 'TaskQueue', index, 'UseMedicine'], value: true },
    { path: ['Configurations', 0, 'TaskQueue', index, 'MedicineCount'], value: 1 },
    { path: ['Configurations', 0, 'TaskQueue', index, 'IsEnable'], value: true },
  ]) }, maa);
  assert.equal(result.status, 'complete');
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).Configurations['Synthetic profile'].TaskQueue.map((task: { MedicineCount: number }) => task.MedicineCount), [1, 1]);
});

test('existing Fight allocations and repeated timer runs cannot reuse a current medicine budget', async (t) => {
  for (const mode of ['other-fight', 'two-timers', 'recurring']) {
    const f = await fixture(t); let running = false;
    const config = structuredClone(f.config);
    const fight = { ...config.Configurations['Synthetic profile'].TaskQueue[0]!, IsEnable: true, UseMedicine: true, MedicineCount: 2 };
    Object.assign(config.Configurations['Synthetic profile'], { TaskQueue: mode === 'other-fight' ? [fight, { ...fight, IsEnable: false, StagePlan: ['CE-6'] }] : [fight] });
    const timer = { IsEnabled: false as boolean | null, Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic profile' };
    Object.assign(config.Timers, { List: mode === 'two-timers' ? [{ ...timer, IsEnabled: null, Minute: 1 }, timer] : [timer] });
    await writeFile(f.file, JSON.stringify(config));
    const before = await readFile(f.file);
    const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
    const changes = mode === 'other-fight' ? [{ path: ['Configurations', 0, 'TaskQueue', 1, 'IsEnable'], value: true }]
      : [{ path: ['Timers', 'List', mode === 'two-timers' ? 1 : 0, 'IsEnabled'], value: mode === 'recurring' ? true : null }];
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, authorization: { source: 'current-request', reference: 'at most two medicines', medicineCount: 2 }, changes }, maa);
    assert.equal(result.status, 'rejected', mode); assert.deepEqual(await readFile(f.file), before);
  }
});

test('a timer authorization binds its effective profile and task queue across shutdown', async (t) => {
  for (const change of ['current-profile', 'timer-mode', 'target-queue']) {
    const f = await fixture(t); let running = true;
    const config = structuredClone(f.config);
    Object.assign(config.Configurations, { 'Synthetic second': structuredClone(config.Configurations['Synthetic profile']) });
    Object.assign(config.Timers, { List: [{ IsEnabled: false, Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic second' }] });
    await writeFile(f.file, JSON.stringify(config));
    const saved = structuredClone(config);
    if (change === 'current-profile') saved.Current = 'Synthetic second';
    if (change === 'timer-mode') saved.Timers.CustomConfig = true;
    if (change === 'target-queue') saved.Configurations['Synthetic profile'].TaskQueue.reverse();
    const maa: MaaProcess = {
      inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }),
      close: async () => { running = false; await writeFile(f.file, JSON.stringify(saved)); }, start: async () => { running = true; },
    };
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'current-request', reference: 'run the current profile once' }, changes: [{ path: ['Timers', 'List', 0, 'IsEnabled'], value: null }] }, maa);
    assert.equal(result.status, 'unknown', change); assert.equal(result.phase, 'backup', change);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), saved);
  }
});

test('medicine budgets sum each profile after accounting for its own timer count', async (t) => {
  for (const budget of [4, 6]) {
    const f = await fixture(t); let running = false;
    const config = structuredClone(f.config);
    const fight = { ...config.Configurations['Synthetic profile'].TaskQueue[0]!, IsEnable: true, UseMedicine: true, MedicineCount: 2 };
    Object.assign(config.Configurations['Synthetic profile'], { TaskQueue: [fight] });
    Object.assign(config.Configurations, { 'Synthetic second': { TaskQueue: [{ ...fight, StagePlan: ['CE-6'] }] } });
    const timer = { IsEnabled: null, Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic profile' };
    Object.assign(config.Timers, { CustomConfig: true, List: [timer, { ...timer, Minute: 1 }] });
    await writeFile(f.file, JSON.stringify(config)); const before = await readFile(f.file);
    const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, authorization: { source: 'current-request', reference: 'two scheduled runs of first profile and one run of second', medicineCount: budget }, changes: [0, 1].flatMap(index => [
      { path: ['Configurations', index, 'TaskQueue', 0, 'UseMedicine'], value: true },
      { path: ['Configurations', index, 'TaskQueue', 0, 'MedicineCount'], value: 2 },
    ]) }, maa);
    assert.equal(result.status, budget === 4 ? 'rejected' : 'complete');
    if (budget === 4) assert.deepEqual(await readFile(f.file), before);
  }
});

test('local timer protection includes both occurrences of the daylight saving repeated hour', () => {
  const module = new URL('../skills/maa-help/scripts/maa-config.ts', import.meta.url).href;
  const source = `import {checkMaintenanceWindow} from ${JSON.stringify(module)};
    const config={Timers:{List:[{IsEnabled:true,Hour:1,Minute:30}]}};
    const intervals=[['2026-11-01T01:29:30-04:00','2026-11-01T01:31:00-04:00'],['2026-11-01T01:29:30-05:00','2026-11-01T01:31:00-05:00'],['2026-11-01T01:27:00-05:00','2026-11-01T01:27:59-05:00']];
    console.log(JSON.stringify(intervals.map(([start,end])=>checkMaintenanceWindow(config,new Date(start),new Date(end)))));`;
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: source, encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [false, false, true]);
});
