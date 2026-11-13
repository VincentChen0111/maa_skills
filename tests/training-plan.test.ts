import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareTrainingPlan, readTrainingPlan, applyTrainingPlan, reconcileTrainingPlan, refreshTrainingMaterials } from '../skills/maa-core/scripts/training-plan.ts';
import { trainingFixture } from './fixtures/training-data.ts';
import { queryTraining } from '../skills/maa-core/scripts/training-time.ts';
import { configFixture } from './fixtures/training-runtime.ts';
import { plan, log } from './fixtures/training-runtime.ts';
import { nativeTask, log as nativeLog } from './fixtures/training-evidence.ts';
import { reconcileTraining } from '../skills/maa-core/scripts/training-state.ts';
import { readVerificationRecord } from '../skills/maa-core/scripts/maa-version.ts';
import './fixtures/maa-version-guard.ts';

test('a prepared authorized target persists pending state and a repeated apply cannot arm it twice', async t => {
  const f = await configFixture(t), data = trainingFixture();
  await writeFile(join(f.root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }));
  await writeFile(join(f.root, 'snapshot.json'), JSON.stringify(data.snapshot)); await writeFile(join(f.root, 'tables.json'), JSON.stringify(data.tables));
  const plan = await prepareTrainingPlan({ query: { ...data.request, snapshotFile: join(f.root, 'snapshot.json'), tablesFile: join(f.root, 'tables.json') },
    binding: { profile: 0, infrastTask: 0, progressTask: 1, timer: 0 }, currentTrainee: null,
    authorization: { source: 'current-request', reference: 'synthetic request' } }, { home: f.root });
  assert.equal(plan.state, 'pending'); assert.equal(plan.rank, 1); assert.equal(plan.preplacementRequired, true);
  assert.equal((await readTrainingPlan(plan.id, { home: f.root })).id, plan.id);
  const rejected = await applyTrainingPlan({ id: plan.id, host: 'codex' }, f.maa, { home: f.root });
  assert.equal(rejected.status, 'rejected');
  assert.equal((await readTrainingPlan(plan.id, { home: f.root })).state, 'pending');
  f.config.Configurations.synthetic.TaskQueue[0]!.Filename = 'changed-by-user'; await writeFile(f.file, JSON.stringify(f.config));
  assert.equal((await applyTrainingPlan({ id: plan.id, host: 'codex', closedConfirmed: true }, f.maa, { home: f.root })).status, 'check-required');
  f.config.Configurations.synthetic.TaskQueue[0]!.Filename = ''; await writeFile(f.file, JSON.stringify(f.config));
  const first = await applyTrainingPlan({ id: plan.id, host: 'codex', closedConfirmed: true }, f.maa, { home: f.root });
  assert.equal(first.status, 'complete');
  const before = await readFile(f.file, 'utf8');
  const duplicate = await applyTrainingPlan({ id: plan.id, host: 'codex', closedConfirmed: true }, f.maa, { home: f.root });
  assert.equal(duplicate.status, 'check-required'); assert.equal(await readFile(f.file, 'utf8'), before);
});

test('a plan records the MAA and record versions it was prepared under; apply and reconcile report a difference without refusing', async t => {
  const f = await configFixture(t), data = trainingFixture(), recordVersion = (await readVerificationRecord()).recordVersion;
  await writeFile(join(f.maaDirectory, 'MAA.exe'), 'synthetic executable placeholder');
  await writeFile(join(f.root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }));
  await writeFile(join(f.root, 'snapshot.json'), JSON.stringify(data.snapshot)); await writeFile(join(f.root, 'tables.json'), JSON.stringify(data.tables));
  const prepared = await prepareTrainingPlan({ query: { ...data.request, snapshotFile: join(f.root, 'snapshot.json'), tablesFile: join(f.root, 'tables.json') },
    binding: { profile: 0, infrastTask: 0, progressTask: 1, timer: 0 }, currentTrainee: null,
    authorization: { source: 'current-request', reference: 'synthetic request' } }, { home: f.root, versionReader: async () => '6.21.4' });
  assert.deepEqual(prepared.versions, { maaVersion: '6.21.4', recordVersion });
  assert.deepEqual((await readTrainingPlan(prepared.id, { home: f.root })).versions, prepared.versions);
  f.maa.version = async () => '6.22.0';
  const applied = await applyTrainingPlan({ id: prepared.id, host: 'codex', closedConfirmed: true }, f.maa, { home: f.root });
  const drift = { state: 'changed', recorded: { maaVersion: '6.21.4', recordVersion }, current: { maaVersion: '6.22.0', recordVersion }, changed: ['maaVersion'] };
  assert.equal(applied.status, 'complete'); assert.deepEqual(applied.versions, drift);
  await writeFile(join(f.maaDirectory, 'core.log'), '');
  const reconciled = await reconcileTrainingPlan({ id: prepared.id, logFile: join(f.maaDirectory, 'core.log'), host: 'codex', closedConfirmed: true }, f.maa, { home: f.root });
  assert.deepEqual(reconciled.versions, drift);
});

test('each next stage requires fresh shared costs and cannot change the approved target', async t => {
  const f = await configFixture(t), data = trainingFixture(), input = plan();
  input.rank = 2; input.target.currentRank = 1; input.state = 'pending'; input.materialReady = false; delete input.action;
  await mkdir(join(f.privateDirectory, 'training-plans'), { recursive: true });
  await writeFile(join(f.privateDirectory, 'training-plans', `${input.id}.json`), JSON.stringify(input));
  await writeFile(join(f.root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }));
  await writeFile(join(f.root, 'snapshot.json'), JSON.stringify(data.snapshot)); await writeFile(join(f.root, 'tables.json'), JSON.stringify(data.tables));
  const query = { ...data.request, current: { ...data.request.current, mastery: { '1': 1 } }, snapshotFile: join(f.root, 'snapshot.json'), tablesFile: join(f.root, 'tables.json') };
  const refreshed = await refreshTrainingMaterials({ id: input.id, query }, { home: f.root });
  assert.equal(refreshed.materialReady, true);
  await assert.rejects(refreshTrainingMaterials({ id: input.id, query: { ...query, target: 3 } }, { home: f.root }), /target-changed/);
  data.snapshot.items.mat = 0; await writeFile(join(f.root, 'snapshot.json'), JSON.stringify(data.snapshot));
  assert.equal((await refreshTrainingMaterials({ id: input.id, query }, { home: f.root })).materialReady, false);
});

test('reconciliation disables a missed owned one-shot and never touches a changed or recurring timer', async t => {
  for (const changed of [false, true]) {
    const f = await configFixture(t), input = plan();
    const due = new Date(Date.now() - 600000); due.setUTCSeconds(0, 0);
    input.action = { kind: 'preplace', dueAt: due.toISOString(), armedAt: new Date(Date.now() - 1200000).toISOString(), operation: 'synthetic-operation',
      timerIdentity: { Id: 0, IsEnabled: null, Config: 'synthetic', Hour: due.getHours(), Minute: due.getMinutes() } };
    Object.assign(f.config.Timers.List[0]!, input.action.timerIdentity);
    if (changed) f.config.Timers.List[0]!.IsEnabled = true;
    await writeFile(f.file, JSON.stringify(f.config));
    await mkdir(join(f.privateDirectory, 'training-plans'), { recursive: true });
    await writeFile(join(f.privateDirectory, 'training-plans', `${input.id}.json`), JSON.stringify(input));
    await writeFile(join(f.root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }));
    await writeFile(join(f.maaDirectory, 'core.log'), '');
    await writeFile(join(f.root, 'unrelated.log'), '');
    await assert.rejects(reconcileTrainingPlan({ id: input.id, logFile: join(f.root, 'unrelated.log'), host: 'codex', closedConfirmed: true }, f.maa, { home: f.root }), /log-instance/);
    const result = await reconcileTrainingPlan({ id: input.id, logFile: join(f.maaDirectory, 'core.log'), host: 'codex', closedConfirmed: true }, f.maa, { home: f.root });
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).Timers.List[0].IsEnabled, changed ? true : false);
    assert.equal(result.plan.state, 'unknown'); assert.equal(result.cleanup?.status, changed ? 'check-required' : 'complete');
  }
});

test('observed preplacement reuses its now-disabled native slot for exactly the approved next mastery rank', async t => {
  const f = await configFixture(t), input = plan(), executed = new Date(Date.now() - 600000).toISOString();
  input.createdAt = new Date(Date.now() - 1800000).toISOString();
  const due = new Date(Date.now() - 1200000); due.setUTCSeconds(0, 0);
  const timer = { Id: 0, IsEnabled: null, Config: 'synthetic', Hour: due.getHours(), Minute: due.getMinutes() };
  input.action = { kind: 'preplace', dueAt: due.toISOString(), armedAt: input.createdAt, timerIdentity: timer };
  f.config.Configurations.synthetic.TaskQueue[0]!.Filename = 'synthetic-training.json';
  input.configurationBinding = { profile: 'synthetic', queue: structuredClone(f.config.Configurations.synthetic.TaskQueue), timer };
  Object.assign(f.config.Timers.List[0]!, { ...timer, IsEnabled: false }); await writeFile(f.file, JSON.stringify(f.config));
  await mkdir(join(f.privateDirectory, 'training-plans'), { recursive: true });
  await writeFile(join(f.privateDirectory, 'training-plans', `${input.id}.json`), JSON.stringify(input));
  await writeFile(join(f.root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }));
  await writeFile(join(f.maaDirectory, 'core.log'), nativeTask(input) + nativeLog(executed, 'TaskChainCompleted', { taskchain: 'Infrast', taskid: 4 }));
  const observed = await reconcileTrainingPlan({ id: input.id, logFile: join(f.maaDirectory, 'core.log'), host: 'codex', closedConfirmed: true }, f.maa, { home: f.root });
  assert.equal(observed.plan.state, 'preplaced');
  const started = await applyTrainingPlan({ id: input.id, host: 'codex', closedConfirmed: true }, f.maa, { home: f.root });
  assert.equal(started.status, 'complete');
  const after = JSON.parse(await readFile(f.file, 'utf8')), record = await readTrainingPlan(input.id, { home: f.root });
  assert.equal(after.Configurations.synthetic.TaskQueue[0].IsEnable, false); assert.equal(after.Configurations.synthetic.TaskQueue[1].IsEnable, true);
  assert.deepEqual(after.Configurations.synthetic.TaskQueue[1].Plans[0].SkillMastery, [1, 0, 0]);
  assert.ok(Date.parse(record.action!.dueAt) - Date.parse(executed) >= 360000);
  assert.notEqual(record.state, 'started'); assert.equal(record.materialReady, false);
});

test('R1-3 explicit patch form identity survives shared query through plan preparation', async t => {
  const f = await configFixture(t), data = trainingFixture();
  const patchId = 'char_synthetic_patch';
  const tables = { ...data.tables, patches: { patchChars: { [patchId]: data.tables.characters.char_synthetic } } };
  data.snapshot.operators.push({ ...data.snapshot.operators[0]!, id: patchId });
  await writeFile(join(f.root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }));
  await writeFile(join(f.root, 'snapshot.json'), JSON.stringify(data.snapshot)); await writeFile(join(f.root, 'tables.json'), JSON.stringify(tables));
  const query = { ...data.request, operatorId: patchId, snapshotFile: join(f.root, 'snapshot.json'), tablesFile: join(f.root, 'tables.json') };
  const calculation = await queryTraining(query, { home: f.root }); assert.equal(calculation.result.status, 'ok');
  assert.equal(calculation.result.operator?.id, patchId); assert.equal(calculation.result.skillName, '合成技能');
  const prepared = await prepareTrainingPlan({ query, binding: { profile: 0, infrastTask: 0, progressTask: 1, timer: 0 }, currentTrainee: null,
    authorization: { source: 'current-request', reference: 'synthetic patch target' } }, { home: f.root });
  assert.equal(prepared.target.operatorId, patchId); assert.equal(prepared.target.role, 'Warrior');
  const ambiguous = await queryTraining({ ...query, operatorId: undefined }, { home: f.root }); assert.equal(ambiguous.result.status, 'needs-input');
});

test('R1-4 unrelated Infrast completion cannot rearm an expired start through material refresh', async t => {
  const f = await configFixture(t), input = plan(), data = trainingFixture();
  input.createdAt = new Date(Date.now() - 1800000).toISOString(); input.preplacementRequired = false; input.materialReady = false;
  const due = new Date(Date.now() - 600000); due.setUTCSeconds(0, 0);
  const timer = { Id: 0, IsEnabled: null, Config: 'synthetic', Hour: due.getHours(), Minute: due.getMinutes() };
  input.action = { kind: 'start', dueAt: due.toISOString(), armedAt: input.createdAt, timerIdentity: timer };
  Object.assign(f.config.Timers.List[0]!, timer); f.config.Configurations.synthetic.TaskQueue[1]!.IsEnable = true;
  Object.assign(f.config.Configurations.synthetic.TaskQueue[1]!, { Plans: [{ Role: 'Warrior', Name: '合成干员', Elite: 0, SkillLevel: 0, SkillMastery: [1, 0, 0], ShowRole: false }] });
  input.configurationBinding = { profile: 'synthetic', queue: structuredClone(f.config.Configurations.synthetic.TaskQueue), timer };
  await writeFile(f.file, JSON.stringify(f.config)); await mkdir(join(f.privateDirectory, 'training-plans'), { recursive: true });
  await writeFile(join(f.privateDirectory, 'training-plans', `${input.id}.json`), JSON.stringify(input));
  await writeFile(join(f.root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }));
  await writeFile(join(f.root, 'snapshot.json'), JSON.stringify(data.snapshot)); await writeFile(join(f.root, 'tables.json'), JSON.stringify(data.tables));
  await writeFile(join(f.maaDirectory, 'core.log'), nativeLog(new Date(Date.now() - 300000).toISOString(), 'TaskChainCompleted', { taskchain: 'Infrast', taskid: 91 }));
  const result = await reconcileTrainingPlan({ id: input.id, logFile: join(f.maaDirectory, 'core.log'), host: 'codex', closedConfirmed: true }, f.maa, { home: f.root });
  assert.equal(result.plan.state, 'unknown'); assert.equal(result.plan.action?.completedAt, undefined); assert.equal(result.cleanup?.status, 'complete');
  await assert.rejects(refreshTrainingMaterials({ id: input.id, query: { ...data.request, target: 1, snapshotFile: join(f.root, 'snapshot.json'), tablesFile: join(f.root, 'tables.json') } }, { home: f.root }), /not-pending/);
  assert.equal((await applyTrainingPlan({ id: input.id, host: 'codex', closedConfirmed: true }, f.maa, { home: f.root })).status, 'check-required');
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).Timers.List[0].IsEnabled, false);
});

test('R1-1 manual M1 completion, fresh materials and apply schedule the authorized M2 start', async t => {
  const f = await configFixture(t), data = trainingFixture(), input = plan();
  const time = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
  input.createdAt = time(30); input.manualTraining = true;
  f.config.Configurations.synthetic.TaskQueue[0]!.Filename = 'synthetic-training.json';
  input.configurationBinding = { profile: 'synthetic', queue: structuredClone(f.config.Configurations.synthetic.TaskQueue), timer: { ...f.config.Timers.List[0]! } };
  input.action = { kind: 'observe', dueAt: time(20), armedAt: input.createdAt };
  const running = reconcileTraining(input, nativeTask(input, undefined, 5) + nativeLog(time(15), 'SubTaskExtraInfo', { taskchain: 'Infrast', taskid: 5,
    what: 'InfrastTrainingTimeLeft', details: { operator: '合成干员', skill: '合成技能', level: 1, time: '00:05:00' } }), time(14));
  assert.equal(running.state, 'started');
  const due = new Date(Date.now() - 5 * 60000); due.setUTCSeconds(0, 0);
  const timer = { Id: 0, IsEnabled: null, Config: 'synthetic', Hour: due.getHours(), Minute: due.getMinutes() };
  running.action = { kind: 'observe', dueAt: due.toISOString(), armedAt: time(10), timerIdentity: timer };
  running.configurationBinding!.timer = timer;
  Object.assign(f.config.Timers.List[0]!, { ...timer, IsEnabled: false }); await writeFile(f.file, JSON.stringify(f.config));
  await mkdir(join(f.privateDirectory, 'training-plans'), { recursive: true });
  await writeFile(join(f.privateDirectory, 'training-plans', `${input.id}.json`), JSON.stringify(running));
  await writeFile(join(f.root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }));
  await writeFile(join(f.root, 'snapshot.json'), JSON.stringify(data.snapshot)); await writeFile(join(f.root, 'tables.json'), JSON.stringify(data.tables));
  await writeFile(join(f.maaDirectory, 'core.log'), nativeTask(running, undefined, 9) + nativeLog(time(1), 'SubTaskExtraInfo', { taskchain: 'Infrast', taskid: 9,
    what: 'InfrastTrainingCompleted', details: { operator: '合成干员', skill: '合成技能', level: 1 } }));
  const done = await reconcileTrainingPlan({ id: input.id, logFile: join(f.maaDirectory, 'core.log'), host: 'codex', closedConfirmed: true }, f.maa, { home: f.root });
  assert.equal(done.plan.rank, 2); assert.equal(done.plan.manualTraining, false);
  const ready = await refreshTrainingMaterials({ id: input.id, query: { ...data.request, current: { ...data.request.current, mastery: { '1': 1 } },
    snapshotFile: join(f.root, 'snapshot.json'), tablesFile: join(f.root, 'tables.json') } }, { home: f.root });
  assert.equal(ready.materialReady, true);
  assert.equal((await applyTrainingPlan({ id: input.id, host: 'codex', closedConfirmed: true }, f.maa, { home: f.root })).status, 'complete');
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).Configurations.synthetic.TaskQueue[1].Plans[0].SkillMastery, [2, 0, 0]);
});
