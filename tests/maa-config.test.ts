import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { executeConfigWrite as writeConfig, inspectConfiguration, checkMaintenanceWindow, type MaaProcess, type WriteRequest } from '../skills/maa-core/scripts/maa-config.ts';

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
      // The pinned MAA v6.21.4 FightTask consumption fields, all closed.
      TaskQueue: [{ $type: 'FightTask', TaskType: 'Fight', IsEnable: false, UseStone: false, StoneCount: 0, UseStoneAllowSave: false, UseMedicine: false, MedicineCount: 0,
        UseExpiringMedicine: false, MedicineExpireDays: 2, UseExpireMedicineForActivity: false, StagePlan: ['1-7'] }, { $type: 'InfrastTask', TaskType: 'Infrast', IsEnable: true, PlanSelect: 3 },
      { $type: 'AwardTask', TaskType: 'Award', IsEnable: false, FreeGacha: false, SpecialAccess: false }],
    } },
    Timers: { List: [], NotifyBeforeScheduledStart: false, ScheduledStartNotificationMinutes: 5, CustomConfig: false },
    UnknownSetting: { keep: 'synthetic-secret-token' },
  };
  const file = join(maa, 'config', 'gui.new.json');
  await writeFile(file, JSON.stringify(config));
  return { root, maa, privateDirectory, file, config };
}

test('a task label cannot disguise its runtime model in the safe configuration summary', async (t) => {
  const f = await fixture(t);
  Object.assign(f.config.Configurations['Synthetic profile'], { TaskQueue: [
    { $type: 'StartUpTask', TaskType: 'Infrast', IsEnable: false, AccountName: 'synthetic-account' },
    { $type: 'FightTask', TaskType: 'Infrast', IsEnable: true, UseStone: true },
    { $type: 'FutureTask', TaskType: 'Infrast', IsEnable: false },
    { TaskType: 'Infrast', IsEnable: false },
    { $type: 'InfrastTask', TaskType: 'Infrast', IsEnable: false },
  ] });
  await writeFile(f.file, JSON.stringify(f.config));
  const summary = await inspectConfiguration(f.maa);
  assert.deepEqual(summary.profiles[0]!.queue.map(task => task.type), ['OtherTask', 'OtherTask', 'OtherTask', 'OtherTask', 'Infrast']);
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-account|StartUpTask/);
  // An unverified task (here a FightTask labelled Infrast with stone on) lists no consumption state.
  assert.ok(summary.profiles[0]!.queue.every(task => !Object.hasOwn(task, 'consumption')));
});

test('runtime task identity controls enable, medicine, reordering and timer authorization', async (t) => {
  const cases = [
    { name: 'login disguised as base', task: { $type: 'StartUpTask', TaskType: 'Infrast', IsEnable: false, AccountSwitchEnabled: true, AccountName: 'synthetic-account' }, field: 'IsEnable', value: true },
    { name: 'unknown runtime model', task: { $type: 'FutureTask', TaskType: 'Infrast', IsEnable: false }, field: 'IsEnable', value: true },
    { name: 'missing runtime model', task: { TaskType: 'Infrast', IsEnable: false }, field: 'IsEnable', value: true },
    { name: 'medicine on disguised login', task: { $type: 'StartUpTask', TaskType: 'Fight', IsEnable: false, UseMedicine: false, MedicineCount: 0, UseStone: false, UseExpiringMedicine: false, UseExpireMedicineForActivity: false }, field: 'UseMedicine', value: false },
    { name: 'moving a disabled mismatched task', task: { $type: 'StartUpTask', TaskType: 'Infrast', IsEnable: false }, field: 'reorder', value: [1, 0] },
    { name: 'timer with disguised consuming Fight', task: { $type: 'FightTask', TaskType: 'Infrast', IsEnable: true, UseStone: true, UseStoneAllowSave: true, UseMedicine: true, MedicineCount: 5 }, field: 'timer', value: null },
    // 27: stone and expiring medicine are opened only on a verified Fight task, whatever the grant.
    { name: 'stone on disguised login', task: { $type: 'StartUpTask', TaskType: 'Fight', IsEnable: false, UseStone: false, StoneCount: 0, UseStoneAllowSave: false }, field: 'UseStone', value: true },
    { name: 'expiring medicine on disguised login', task: { $type: 'StartUpTask', TaskType: 'Fight', IsEnable: false, UseExpiringMedicine: false, MedicineExpireDays: 2 }, field: 'UseExpiringMedicine', value: true },
    { name: 'timer with disguised expiring Fight', task: { $type: 'FightTask', TaskType: 'Infrast', IsEnable: true, UseExpiringMedicine: true, MedicineExpireDays: 2 }, field: 'timer', value: true },
  ];
  // Every consumption grant is present and current: none of them can authorize a task whose runtime identity is not verified.
  const grants = { medicineCount: 5, stoneCount: 5, expiringMedicine: { days: 2, forActivity: true } };
  for (const sample of cases) await t.test(sample.name, async (t) => {
    const f = await fixture(t); let running = false; let processCalls = 0;
    Object.assign(f.config.Configurations['Synthetic profile'], { TaskQueue: [sample.task, { $type: 'InfrastTask', TaskType: 'Infrast', IsEnable: false }] });
    Object.assign(f.config.Timers, { List: [{ IsEnabled: false, Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic profile' }] });
    await writeFile(f.file, JSON.stringify(f.config));
    const before = await readFile(f.file);
    const maa: MaaProcess = { inspect: async () => { processCalls++; return { running, treeExited: !running, idle: true, ready: running }; }, close: async () => { running = false; }, start: async () => { running = true; } };
    const path = sample.field === 'reorder' ? ['Configurations', 0, 'TaskQueue'] : sample.field === 'timer' ? ['Timers', 'List', 0, 'IsEnabled'] : ['Configurations', 0, 'TaskQueue', 0, sample.field];
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
      authorization: { source: 'current-request', reference: 'synthetic ordinary task change', ...grants }, changes: [{ path, value: sample.value }] }, maa);
    assert.equal(result.status, 'rejected');
    assert.equal(processCalls, 0);
    assert.deepEqual(await readFile(f.file), before);
    assert.deepEqual(await readdir(join(f.maa, 'config')), ['gui.new.json']);
  });
});

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
  const fight = (field: string, value: unknown) => [{ path: ['Configurations', 'Synthetic profile', 'TaskQueue', 0, field], value }];
  const all = { medicineCount: 5, stoneCount: 5, expiringMedicine: { days: 2, forActivity: true } };
  const reminder = [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }];
  const cases: [Record<string, unknown>, { path: (string | number)[]; value: unknown }[], string][] = [
    [{}, fight('UseStone', true), 'stone-grant-required'],
    [{}, [{ path: ['Configurations', 'Synthetic profile', 'TaskQueue', 2, 'FreeGacha'], value: true }], 'request-invalid'],
    [{}, [{ path: ['Configurations', 'Synthetic profile', 'Gui', 'RuntimeSettings', 'StartGame'], value: true }], 'request-invalid'],
    [{}, fight('UseMedicine', true), 'medicine-grant-required'],
    [{}, fight('UseExpiringMedicine', true), 'expiring-grant-required'],
    // 27: gacha, special packs and login stay refused with all three consumption grants present.
    [all, [{ path: ['Configurations', 'Synthetic profile', 'TaskQueue', 2, 'FreeGacha'], value: true }], 'request-invalid'],
    [all, [{ path: ['Configurations', 'Synthetic profile', 'TaskQueue', 2, 'SpecialAccess'], value: true }], 'request-invalid'],
    [all, [{ path: ['Configurations', 'Synthetic profile', 'Gui', 'RuntimeSettings', 'StartGame'], value: true }], 'request-invalid'],
    // Grant values follow MAA's signed 32-bit counts and the GUI's 1-30 expiring days; unknown grant keys are refused.
    ...[-1, 1.5, '1', 2147483648].map(stoneCount => [{ stoneCount }, reminder, 'consumption-grant-invalid'] as [Record<string, unknown>, typeof reminder, string]),
    ...[{ days: 0, forActivity: false }, { days: 31, forActivity: false }, { days: 2 }, { days: 2, forActivity: 'yes' }, { days: 2, forActivity: false, extra: true }]
      .map(expiringMedicine => [{ expiringMedicine }, reminder, 'consumption-grant-invalid'] as [Record<string, unknown>, typeof reminder, string]),
    [{ stonecount: 1 }, reminder, 'authorization-invalid'],
  ];
  for (const [grant, changes, reason] of cases) {
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'current-request', reference: 'synthetic', ...grant } as never, changes }, maa);
    assert.equal(result.status, 'rejected');
    assert.equal(result.phase, 'check');
    assert.equal(result.reason, reason, JSON.stringify(grant));
  }
  const report = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex',
    authorization: { source: 'approved-report', reference: 'old report', stoneCount: 1 }, changes: reminder }, maa);
  assert.equal(report.reason, 'current-request-required');
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

test('an omitted native timer enabled field retains its one-shot maintenance window', () => {
  const config = { Timers: { List: [{ Hour: 12, Minute: 30 }] } };
  assert.equal(checkMaintenanceWindow(config, new Date(2026, 0, 1, 11, 0), new Date(2026, 0, 1, 11, 2)), true);
  assert.equal(checkMaintenanceWindow(config, new Date(2026, 0, 1, 12, 28), new Date(2026, 0, 1, 12, 29)), false);
  assert.equal(checkMaintenanceWindow({ Timers: { List: [{ IsEnabled: 0, Hour: 12, Minute: 30 }] } }, new Date(2026, 0, 1, 11, 0), new Date(2026, 0, 1, 11, 2)), false);
});

test('native omission of a null one-shot flag is equivalent for changed fields, slots and timer dependencies', async (t) => {
  for (const mode of ['direct-flag', 'slot-hour', 'timer-dependency', 'omitted-input', 'shutdown-omission']) await t.test(mode, async (t) => {
    const f = await fixture(t); let running = mode === 'shutdown-omission';
    const hour = (new Date().getHours() + 3) % 24;
    const timer: Record<string, unknown> = { Id: 0, IsEnabled: mode === 'direct-flag' ? false : null, Hour: hour, Minute: 0, Config: 'Synthetic profile', FutureField: null };
    if (mode === 'omitted-input') delete timer.IsEnabled;
    Object.assign(f.config.Timers, { List: [timer] });
    await writeFile(f.file, JSON.stringify(f.config));
    const before = await readFile(f.file);
    let expectedBackup = before;
    const saveNative = async () => {
      const saved = JSON.parse(await readFile(f.file, 'utf8'));
      for (const entry of saved.Timers.List) if (entry.IsEnabled === null) delete entry.IsEnabled;
      await writeFile(f.file, JSON.stringify(saved));
    };
    const maa: MaaProcess = {
      inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }),
      close: async () => { running = false; await saveNative(); expectedBackup = await readFile(f.file); },
      start: async () => { running = true; await saveNative(); },
    };
    const changes = mode === 'direct-flag' || mode === 'omitted-input' ? [{ path: ['Timers', 'List', 0, 'IsEnabled'], value: null }]
      : mode === 'timer-dependency' ? [{ path: ['Timers', 'CustomConfig'], value: true }]
      : [{ path: ['Timers', 'List', 0, 'Hour'], value: (hour + 1) % 24 }];
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
      authorization: { source: 'current-request', reference: 'synthetic one-shot change' }, changes }, maa);
    assert.equal(result.status, 'complete');
    const actual = JSON.parse(await readFile(f.file, 'utf8'));
    assert.equal(Object.hasOwn(actual.Timers.List[0], 'IsEnabled'), false);
    assert.equal(actual.Timers.List[0].FutureField, null);
    assert.equal((await inspectConfiguration(f.maa)).timers[0]!.enabled, null);
    const backups = await readdir(join(f.privateDirectory, 'maa-config-backups'));
    assert.deepEqual(await readFile(join(f.privateDirectory, 'maa-config-backups', backups[0]!)), expectedBackup);
    assert.equal((await readdir(join(f.maa, 'config'))).includes('.maa-skills.lock'), false);
  });
});

test('omitted one-shot flags count each scheduled medicine run exactly once', async (t) => {
  for (const budget of [1, 2]) await t.test(`budget ${budget}`, async (t) => {
    const f = await fixture(t); let running = false;
    const fight = f.config.Configurations['Synthetic profile'].TaskQueue[0]!;
    Object.assign(fight, { IsEnable: true, UseMedicine: true, MedicineCount: 1 });
    const timer = { Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic profile' };
    Object.assign(f.config.Timers, { List: [timer, { ...timer, Minute: 1 }] });
    await writeFile(f.file, JSON.stringify(f.config));
    const before = await readFile(f.file);
    const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
      authorization: { source: 'current-request', reference: 'one medicine per scheduled run', medicineCount: budget }, changes: [{ path: ['Configurations', 0, 'TaskQueue', 0, 'MedicineCount'], value: 1 }] }, maa);
    assert.equal(result.status, budget === 2 ? 'complete' : 'rejected');
    if (budget === 1) { assert.equal(result.reason, 'medicine-quantity-exceeded'); assert.deepEqual(await readFile(f.file), before); }
  });
});

test('null equivalence does not authorize changed timer values or other omitted fields during shutdown or readback', async (t) => {
  const mutations = [
    { key: 'IsEnabled', value: true }, { key: 'IsEnabled', value: false }, { key: 'Hour', value: -1 },
    { key: 'Minute', value: 2 }, { key: 'Config', value: 'synthetic-other' }, { key: 'FutureField', value: undefined },
  ];
  for (const phase of ['close', 'start']) for (const mutation of mutations) await t.test(`${phase} ${mutation.key} ${mutation.value}`, async (t) => {
    const f = await fixture(t); let running = phase === 'close';
    Object.assign(f.config.Timers, { List: [{ IsEnabled: null, Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic profile', FutureField: null }] });
    await writeFile(f.file, JSON.stringify(f.config));
    const mutate = async () => { const saved = JSON.parse(await readFile(f.file, 'utf8')); saved.Timers.List[0][mutation.key] = mutation.value; await writeFile(f.file, JSON.stringify(saved)); };
    const maa: MaaProcess = {
      inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }),
      close: async () => { running = false; if (phase === 'close') await mutate(); },
      start: async () => { running = true; if (phase === 'start') await mutate(); },
    };
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
      authorization: { source: 'current-request', reference: 'use the selected timer configuration' }, changes: [{ path: ['Timers', 'CustomConfig'], value: true }] }, maa);
    assert.equal(result.status, 'unknown');
    assert.equal(result.phase, phase === 'close' ? 'backup' : 'readback');
    assert.equal((await readdir(join(f.maa, 'config'))).includes('.maa-skills.lock'), true);
  });
});

test('raw revisions retain null omission differences and only Timer.IsEnabled may be missing in a change', async (t) => {
  const f = await fixture(t);
  const timer: Record<string, unknown> = { IsEnabled: null, Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic profile' };
  Object.assign(f.config.Timers, { List: [timer] });
  await writeFile(f.file, JSON.stringify(f.config));
  const explicit = await inspectConfiguration(f.maa);
  delete timer.IsEnabled;
  await writeFile(f.file, JSON.stringify(f.config));
  const omitted = await inspectConfiguration(f.maa);
  assert.notEqual(explicit.revision, omitted.revision);
  const maa: MaaProcess = { inspect: async () => { assert.fail('must reject before process access'); }, close: async () => {}, start: async () => {} };
  const request = { maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex' as const, closedConfirmed: true,
    authorization: { source: 'current-request' as const, reference: 'synthetic timer change' }, changes: [{ path: ['Timers', 'List', 0, 'IsEnabled'], value: false }] };
  assert.equal((await executeConfigWrite({ ...request, expectedRevision: explicit.revision }, maa)).reason, 'configuration-changed');
  delete timer.Hour;
  await writeFile(f.file, JSON.stringify(f.config));
  const result = await executeConfigWrite({ ...request, changes: [{ path: ['Timers', 'List', 0, 'Hour'], value: 12 }] }, maa);
  assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'request-invalid');
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
  const all = { medicineCount: 5, stoneCount: 5, expiringMedicine: { days: 2, forActivity: true } };
  const cases: [string, number, Record<string, unknown>, Record<string, unknown>, string][] = [
    ['existing stone without a grant', 0, { UseStone: true }, {}, 'stone-grant-required'],
    // A stone grant cannot borrow a switch MAA would reset, nor a zero or missing quantity.
    ['existing stone without the save switch', 0, { UseStone: true, StoneCount: 2 }, { stoneCount: 2 }, 'stone-settings-invalid'],
    ['existing expiring medicine without a grant', 0, { UseExpiringMedicine: true }, {}, 'expiring-grant-required'],
    ['existing expiring medicine with other days', 0, { UseExpiringMedicine: true, MedicineExpireDays: 5 }, { expiringMedicine: { days: 2, forActivity: false } }, 'expiring-days-mismatch'],
    ['existing activity expiring medicine not named', 0, { UseExpireMedicineForActivity: true }, { expiringMedicine: { days: 2, forActivity: false } }, 'expiring-activity-not-approved'],
    ['existing free gacha under every grant', 2, { FreeGacha: true }, all, 'forbidden-setting'],
    ['existing special access under every grant', 2, { SpecialAccess: true }, all, 'forbidden-setting'],
  ];
  for (const [name, index, existing, grant, reason] of cases) await t.test(name, async (t) => {
    const f = await fixture(t);
    const config = structuredClone(f.config);
    Object.assign(config.Configurations['Synthetic profile'].TaskQueue[index]!, { IsEnable: true, ...existing });
    Object.assign(config.Timers, { List: [{ IsEnabled: false, Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic profile' }] });
    await writeFile(f.file, JSON.stringify(config)); const before = await readFile(f.file);
    const maa: MaaProcess = { inspect: async () => { assert.fail('must not inspect'); }, close: async () => { assert.fail('must not close'); }, start: async () => {} };
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'current-request', reference: 'only enable a timer', ...grant },
      changes: [{ path: ['Timers', 'List', 0, 'IsEnabled'], value: true }] }, maa);
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, reason);
    assert.deepEqual(await readFile(f.file), before);
    assert.deepEqual(await readdir(join(f.maa, 'config')), ['gui.new.json']);
  });
});

test('the CLI reads only settings-selected MAA summaries and never prints secrets or raw parse errors', async (t) => {
  const f = await fixture(t); const home = join(f.root, 'home');
  await updateSettings({ maaDirectory: f.maa, privateDirectory: f.privateDirectory }, home);
  const command = fileURLToPath(new URL('../skills/maa-core/scripts/maa-config.ts', import.meta.url));
  const invoke = (action: string, input: unknown = {}) => spawnSync(process.execPath, [command, action], { encoding: 'utf8', input: JSON.stringify(input), env: { ...process.env, MAA_SKILLS_HOME: home, HOME: home, USERPROFILE: home } });
  const result = invoke('read');
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true); assert.equal(summary.configuration.currentProfile, 0);
  assert.deepEqual(summary.configuration.profiles[0].queue.map((task: { type: string }) => task.type), ['Fight', 'Infrast', 'Award']);
  // 27: each verified Fight task lists medicine, stone and expiring medicine; other tasks list none of them.
  assert.deepEqual(summary.configuration.profiles[0].queue.map((task: { consumption?: unknown }) => task.consumption ?? null), [
    { medicine: { on: false, count: 0 }, stone: { on: false, count: 0, allowSave: false }, expiring: { on: false, days: 2, activity: false } }, null, null]);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret|Synthetic profile/);
  const forbidden = invoke('write', { host: 'codex', expectedRevision: summary.configuration.revision, authorization: { source: 'current-request', reference: 'synthetic' }, changes: [{ path: ['Configurations', 0, 'TaskQueue', 0, 'UseStone'], value: true }] });
  assert.equal(forbidden.status, 1);
  assert.equal(JSON.parse(forbidden.stdout).status, 'rejected');
  assert.equal(JSON.parse(forbidden.stdout).reason, 'stone-grant-required');
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
  Object.assign(config.Configurations['Synthetic profile'], { TaskQueue: [{ $type: 'InfrastTask', TaskType: 'Infrast', IsEnable: false }, { $type: 'MallTask', TaskType: 'Mall', IsEnable: false }] });
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
  const module = new URL('../skills/maa-core/scripts/maa-config.ts', import.meta.url).href;
  const source = `import {checkMaintenanceWindow} from ${JSON.stringify(module)};
    const config={Timers:{List:[{IsEnabled:true,Hour:1,Minute:30}]}};
    const intervals=[['2026-11-01T01:29:30-04:00','2026-11-01T01:31:00-04:00'],['2026-11-01T01:29:30-05:00','2026-11-01T01:31:00-05:00'],['2026-11-01T01:27:00-05:00','2026-11-01T01:27:59-05:00']];
    console.log(JSON.stringify(intervals.map(([start,end])=>checkMaintenanceWindow(config,new Date(start),new Date(end)))));`;
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: source, encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [false, false, true]);
});

test('readback verifies the expected execution dependencies after MAA restarts', async (t) => {
  for (const change of ['current-profile', 'target-queue']) {
    const f = await fixture(t); let running = true;
    const config = structuredClone(f.config);
    Object.assign(config.Configurations, { 'Synthetic second': structuredClone(config.Configurations['Synthetic profile']) });
    Object.assign(config.Timers, { List: [{ IsEnabled: false, Hour: (new Date().getHours() + 3) % 24, Minute: 0, Config: 'Synthetic profile' }] });
    await writeFile(f.file, JSON.stringify(config));
    const maa: MaaProcess = {
      inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; },
      start: async () => {
        running = true; const saved = JSON.parse(await readFile(f.file, 'utf8'));
        if (change === 'current-profile') saved.Current = 'Synthetic second';
        else saved.Configurations['Synthetic profile'].TaskQueue.reverse();
        await writeFile(f.file, JSON.stringify(saved));
      },
    };
    const result = await executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'current-request', reference: 'run this profile once' }, changes: [{ path: ['Timers', 'List', 0, 'IsEnabled'], value: null }] }, maa);
    assert.equal(result.status, 'unknown', change); assert.equal(result.phase, 'readback');
    assert.equal(JSON.parse(await readFile(join(f.maa, 'config', '.maa-skills.lock'), 'utf8')).phase, 'readback');
    assert.equal(JSON.parse((await readFile(join(f.privateDirectory, 'daily-runs.jsonl'), 'utf8')).trim()).status, 'unknown');
  }
});

test('a repeated timer has a full physical two-minute window before the clock rolls back', () => {
  const module = new URL('../skills/maa-core/scripts/maa-config.ts', import.meta.url).href;
  const source = `import {checkMaintenanceWindow} from ${JSON.stringify(module)};
    const config={Timers:{List:[{IsEnabled:true,Hour:1,Minute:0}]}};
    const intervals=[['2026-11-01T01:58:30-04:00','2026-11-01T01:59:30-04:00'],['2026-11-01T01:57:00-04:00','2026-11-01T01:57:59-04:00']];
    console.log(JSON.stringify(intervals.map(([start,end])=>checkMaintenanceWindow(config,new Date(start),new Date(end)))));`;
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: source, encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [false, true]);
});

// 27: stone (Originium for sanity) and expiring medicine after the user's current approval.
const fightPath = (index: number, field: string) => ['Configurations', 0, 'TaskQueue', index, field];
const openStone = (index: number, count: number) => [{ path: fightPath(index, 'UseStone'), value: true },
  { path: fightPath(index, 'UseStoneAllowSave'), value: true }, { path: fightPath(index, 'StoneCount'), value: count }];
async function consumptionFixture(t: Parameters<typeof fixture>[0], tasks: Record<string, unknown>[] = [{}], timers: Record<string, unknown>[] = []) {
  const f = await fixture(t);
  const base = f.config.Configurations['Synthetic profile'].TaskQueue[0]!;
  Object.assign(f.config.Configurations['Synthetic profile'], { TaskQueue: tasks.map((extra, index) => ({ ...base, StagePlan: [`SYN-${index}`], ...extra })) });
  Object.assign(f.config.Timers, { List: timers.map((timer, index) => ({ IsEnabled: false, Hour: (new Date().getHours() + 3) % 24, Minute: index, Config: 'Synthetic profile', ...timer })) });
  await writeFile(f.file, JSON.stringify(f.config));
  let running = false; let processCalls = 0;
  const maa: MaaProcess = { inspect: async () => { processCalls++; return { running, treeExited: !running, idle: true, ready: running }; },
    close: async () => { running = false; }, start: async () => { running = true; } };
  const write = (grant: Record<string, unknown>, changes: { path: (string | number)[]; value: unknown }[], source = 'current-request') =>
    executeConfigWrite({ maaDirectory: f.maa, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
      authorization: { source, reference: 'synthetic approval', ...grant } as never, changes }, maa);
  const saved = async () => JSON.parse(await readFile(f.file, 'utf8')).Configurations['Synthetic profile'].TaskQueue as Record<string, unknown>[];
  return { ...f, write, saved, processCalls: () => processCalls };
}

test('approved stone is written together with its save switch and read back, and one quantity can be split across two tasks', async (t) => {
  const f = await consumptionFixture(t, [{}, {}]);
  const result = await f.write({ stoneCount: 3 }, [...openStone(0, 2), { path: fightPath(0, 'IsEnable'), value: true }, ...openStone(1, 1)]);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  const [first, second] = await f.saved();
  assert.deepEqual([first!.UseStone, first!.UseStoneAllowSave, first!.StoneCount, first!.IsEnable], [true, true, 2, true]);
  assert.deepEqual([second!.UseStone, second!.UseStoneAllowSave, second!.StoneCount], [true, true, 1]);
  assert.ok(result.changedKeys.includes('Configurations.<profile>.TaskQueue.0.UseStoneAllowSave'));
  assert.doesNotMatch(JSON.stringify(result), /Synthetic profile|synthetic-secret/);
});

test('a stone quantity counts every single timer run in every profile and never rides a daily-repeating timer', async (t) => {
  for (const [budget, expected] of [[5, 'stone-quantity-exceeded'], [6, 'complete']] as const) await t.test(`budget ${budget}`, async (t) => {
    const f = await consumptionFixture(t, [{ IsEnable: true }], [{ IsEnabled: null }, { IsEnabled: null }]);
    const config = JSON.parse(await readFile(f.file, 'utf8'));
    config.Configurations['Synthetic second'] = structuredClone(config.Configurations['Synthetic profile']);
    config.Timers.CustomConfig = true; await writeFile(f.file, JSON.stringify(config)); const before = await readFile(f.file);
    // Two single runs of the first profile and one explicit allocation in the second: 2 * 2 + 2 = 6.
    const result = await f.write({ stoneCount: budget }, [...openStone(0, 2), ...openStone(0, 2).map(change => ({ ...change, path: ['Configurations', 1, ...change.path.slice(2)] }))]);
    assert.equal(result.status === 'complete' ? 'complete' : result.reason, expected);
    if (expected !== 'complete') { assert.equal(f.processCalls(), 0); assert.deepEqual(await readFile(f.file), before); }
  });
  const daily = await consumptionFixture(t, [{ IsEnable: true }], [{ IsEnabled: true }]); const before = await readFile(daily.file);
  const result = await daily.write({ stoneCount: 9 }, openStone(0, 1));
  assert.equal(result.reason, 'recurring-quantity-not-authorized'); assert.equal(daily.processCalls(), 0); assert.deepEqual(await readFile(daily.file), before);
});

test('approved expiring medicine stays on a daily-repeating timer and the activity switch opens only when named', async (t) => {
  const f = await consumptionFixture(t, [{ IsEnable: true }], [{ IsEnabled: false }]);
  const result = await f.write({ expiringMedicine: { days: 3, forActivity: false } }, [{ path: fightPath(0, 'UseExpiringMedicine'), value: true },
    { path: fightPath(0, 'MedicineExpireDays'), value: 3 }, { path: ['Timers', 'List', 0, 'IsEnabled'], value: true }]);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual([(await f.saved())[0]!.UseExpiringMedicine, (await f.saved())[0]!.MedicineExpireDays], [true, 3]);
  const before = await readFile(f.file);
  const unnamed = await f.write({ expiringMedicine: { days: 3, forActivity: false } }, [{ path: fightPath(0, 'UseExpireMedicineForActivity'), value: true }]);
  assert.equal(unnamed.reason, 'expiring-activity-not-approved'); assert.deepEqual(await readFile(f.file), before);
  const named = await f.write({ expiringMedicine: { days: 3, forActivity: true } }, [{ path: fightPath(0, 'UseExpireMedicineForActivity'), value: true }]);
  assert.equal(named.status, 'complete', JSON.stringify(named)); assert.equal((await f.saved())[0]!.UseExpireMedicineForActivity, true);
});

test('medicine, stone and expiring medicine can be approved together in one request', async (t) => {
  const f = await consumptionFixture(t);
  const result = await f.write({ medicineCount: 2, stoneCount: 1, expiringMedicine: { days: 2, forActivity: true } }, [
    { path: fightPath(0, 'UseMedicine'), value: true }, { path: fightPath(0, 'MedicineCount'), value: 2 }, ...openStone(0, 1),
    { path: fightPath(0, 'UseExpiringMedicine'), value: true }, { path: fightPath(0, 'UseExpireMedicineForActivity'), value: true }, { path: fightPath(0, 'IsEnable'), value: true }]);
  assert.equal(result.status, 'complete', JSON.stringify(result));
});

test('closing stone or expiring medicine needs only an ordinary current request, without a quantity or days', async (t) => {
  // Other consumption on the same task (approved earlier, possibly on a daily timer) is not re-decided by a closing request.
  const open = { IsEnable: true, UseMedicine: true, MedicineCount: 1, UseStone: true, UseStoneAllowSave: true, StoneCount: 2, UseExpiringMedicine: true, UseExpireMedicineForActivity: true };
  const f = await consumptionFixture(t, [open], [{ IsEnabled: true }]);
  const close = [{ path: fightPath(0, 'UseStone'), value: false }, { path: fightPath(0, 'UseStoneAllowSave'), value: false },
    { path: fightPath(0, 'UseExpiringMedicine'), value: false }, { path: fightPath(0, 'UseExpireMedicineForActivity'), value: false }];
  const before = await readFile(f.file);
  assert.equal((await f.write({}, close, 'approved-report')).reason, 'current-request-required');
  // UseStoneAllowSave alone does not close stone: UseStone stays on, so it still needs a stone grant (and MAA would reset it on reading).
  assert.equal((await f.write({}, [close[1]!])).reason, 'stone-grant-required');
  assert.equal(f.processCalls(), 0); assert.deepEqual(await readFile(f.file), before);
  const result = await f.write({}, close);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual((await f.saved())[0], { ...JSON.parse(before.toString()).Configurations['Synthetic profile'].TaskQueue[0], UseStone: false, UseStoneAllowSave: false, UseExpiringMedicine: false, UseExpireMedicineForActivity: false });
});

test('stone and expiring medicine are refused before process access, a lock or a write without the matching current approval', async (t) => {
  const cases: [string, Record<string, unknown>[], Record<string, unknown>, { path: (string | number)[]; value: unknown }[], string, string?][] = [
    ['stone without a grant', [{}], {}, openStone(0, 1), 'stone-grant-required'],
    ['stone from an approved report', [{}], { stoneCount: 1 }, openStone(0, 1), 'current-request-required', 'approved-report'],
    ['stone above its quantity', [{}], { stoneCount: 2 }, openStone(0, 3), 'stone-quantity-exceeded'],
    ['stone without its save switch', [{}], { stoneCount: 2 }, [openStone(0, 2)[0]!, openStone(0, 2)[2]!], 'stone-settings-invalid'],
    ['stone with a zero quantity', [{}], { stoneCount: 2 }, openStone(0, 0), 'stone-settings-invalid'],
    ['enabling a task that already holds stone', [{ UseStone: true, UseStoneAllowSave: true, StoneCount: 2 }], {}, [{ path: fightPath(0, 'IsEnable'), value: true }], 'stone-grant-required'],
    ['expiring medicine without a grant', [{}], {}, [{ path: fightPath(0, 'UseExpiringMedicine'), value: true }], 'expiring-grant-required'],
    ['expiring medicine from an approved report', [{}], { expiringMedicine: { days: 2, forActivity: false } }, [{ path: fightPath(0, 'UseExpiringMedicine'), value: true }], 'current-request-required', 'approved-report'],
    ['expiring days other than approved', [{}], { expiringMedicine: { days: 2, forActivity: false } }, [{ path: fightPath(0, 'UseExpiringMedicine'), value: true }, { path: fightPath(0, 'MedicineExpireDays'), value: 3 }], 'expiring-days-mismatch'],
    ['expiring days outside the MAA range', [{}], { expiringMedicine: { days: 2, forActivity: false } }, [{ path: fightPath(0, 'MedicineExpireDays'), value: 31 }], 'request-invalid'],
    ['approved expiring days outside the MAA range', [{}], { expiringMedicine: { days: 31, forActivity: false } }, [{ path: fightPath(0, 'UseExpiringMedicine'), value: true }], 'consumption-grant-invalid'],
    ['activity expiring medicine not named', [{}], { expiringMedicine: { days: 2, forActivity: false } }, [{ path: fightPath(0, 'UseExpireMedicineForActivity'), value: true }], 'expiring-activity-not-approved'],
    ['enabling a task that already holds activity expiring medicine', [{ UseExpireMedicineForActivity: true }], { expiringMedicine: { days: 2, forActivity: false } }, [{ path: fightPath(0, 'IsEnable'), value: true }], 'expiring-activity-not-approved'],
  ];
  for (const [name, tasks, grant, changes, reason, source] of cases) await t.test(name, async (t) => {
    const f = await consumptionFixture(t, tasks); const before = await readFile(f.file);
    const result = await f.write(grant, changes, source);
    assert.equal(result.status, 'rejected'); assert.equal(result.phase, 'check'); assert.equal(result.reason, reason);
    assert.equal(f.processCalls(), 0); assert.deepEqual(await readFile(f.file), before);
    assert.deepEqual(await readdir(join(f.maa, 'config')), ['gui.new.json']);
    await assert.rejects(readFile(join(f.privateDirectory, 'daily-pending.jsonl')), { code: 'ENOENT' });
  });
});
