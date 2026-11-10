import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareTrainingPlan, readTrainingPlan, applyTrainingPlan, reconcileTrainingPlan, refreshTrainingMaterials } from '../skills/maa-core/scripts/training-plan.ts';
import { trainingFixture } from './fixtures/training-data.ts';
import { configFixture } from './fixtures/training-runtime.ts';
import { plan, log } from './fixtures/training-runtime.ts';

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
  input.configurationBinding = { profile: 'synthetic', queue: structuredClone(f.config.Configurations.synthetic.TaskQueue), timer };
  Object.assign(f.config.Timers.List[0]!, { ...timer, IsEnabled: false }); await writeFile(f.file, JSON.stringify(f.config));
  await mkdir(join(f.privateDirectory, 'training-plans'), { recursive: true });
  await writeFile(join(f.privateDirectory, 'training-plans', `${input.id}.json`), JSON.stringify(input));
  await writeFile(join(f.root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: f.privateDirectory, maaDirectory: f.maaDirectory }));
  await writeFile(join(f.maaDirectory, 'core.log'), log(executed, 'TaskChainCompleted', { taskchain: 'Infrast' }));
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
