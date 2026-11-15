// Ticket 32: unattended mastery chaining — tier after tier, and from one approved operator to the next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareTrainingPlan, applyTrainingPlan, refreshTrainingMaterials, reconcileTrainingPlan, readTrainingPlan, listTrainingPlans, closeTrainingPlan } from '../skills/maa-core/scripts/training-plan.ts';
import { calculateTraining, materialGate } from '../skills/maa-core/scripts/training-time.ts';
import { reconcileTraining, type TrainingPlan } from '../skills/maa-core/scripts/training-state.ts';
import type { GapResult } from '../skills/maa-core/scripts/cultivation-gaps.ts';
import { trainingFixture } from './fixtures/training-data.ts';
import { approvedTrainingReport } from './fixtures/training-report.ts';
import { configFixture, plan as runtimePlan } from './fixtures/training-runtime.ts';
import { plan as evidencePlan, nativeTask, confirmation, countdown, log as nativeLog } from './fixtures/training-evidence.ts';
import { versionDoublePreload } from './fixtures/maa-version-guard.ts';

type Fixture = ReturnType<typeof trainingFixture>;
/** The synthetic MAA snapshot with a depot scan time equal to its read time (R1-1: the cut-off is the inventory time). */
const scanned = (f: Fixture) => { Object.assign(f.snapshot, { sourceTimes: { operators: null, inventory: f.snapshot.readAt } }); return f; };
const binding = { profile: 0, infrastTask: 0, progressTask: 1, timer: 0 };
const fiveHour = '进驻训练室单次协助一名干员训练时长达5小时，则该名干员下次训练所需时间-50%（任意一方离开训练室时，效果消失）';
/** The trial's shape: the only available assistant carries nothing but the five-hour condition. */
function fiveHourOnly(f: Fixture) {
  Object.assign(f.tables.building.buffs, { synthetic_reduce: { buffName: '合成时长条件', roomType: 'TRAINING', description: fiveHour } });
  f.tables.building.chars.char_helper.buffChar = [{ buffData: [{ buffId: 'synthetic_reduce', cond: { phase: 'PHASE_0', level: 1 } }] }];
  f.request.facts.availableAssistants = ['char_helper'];
  return f;
}
async function world(t: { after(fn: () => Promise<unknown>): void }, f: Fixture) {
  const runtime = await configFixture(t);
  await writeFile(join(runtime.root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: runtime.privateDirectory, maaDirectory: runtime.maaDirectory }));
  const snapshotFile = join(runtime.root, 'snapshot.json'), tablesFile = join(runtime.root, 'tables.json');
  await writeFile(snapshotFile, JSON.stringify(f.snapshot)); await writeFile(tablesFile, JSON.stringify(f.tables));
  return { ...runtime, snapshotFile, tablesFile };
}

test('32 defect 1: a goal beyond the next tier is preparable when the only assistant has the five-hour condition', async t => {
  const f = fiveHourOnly(trainingFixture()), w = await world(t, f);
  const plan = await prepareTrainingPlan({ query: { ...f.request, target: 3, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile }, binding, currentTrainee: null,
    authorization: { source: 'current-request', reference: 'synthetic: train S1 to M3' } }, { home: w.root });
  assert.equal(plan.state, 'pending'); assert.equal(plan.rank, 1); assert.equal(plan.target.goal, 3);
  assert.deepEqual(plan.assistants, { '1': '合成助手', '2': '合成助手', '3': '合成助手' });
});

test('32 defect 1: the prepare CLI names the specific reason and the pending facts instead of the generic code', async t => {
  const f = trainingFixture(); f.request.facts.availableAssistants = [];
  const w = await world(t, f);
  const run = spawnSync(process.execPath, ['--import', versionDoublePreload, resolve('skills/maa-core/scripts/training-plan.ts'), 'prepare'], { encoding: 'utf8',
    env: { ...process.env, MAA_SKILLS_HOME: w.root },
    input: JSON.stringify({ query: { ...f.request, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile }, binding, currentTrainee: null,
      authorization: { source: 'current-request', reference: 'synthetic request' } }) });
  assert.equal(run.status, 1); assert.equal(run.stdout, '');
  const output = JSON.parse(run.stderr);
  // Owner, 2026-11-16: 「check required 要给我具体的，和有没有替代」 — reason, what to check, and the alternatives.
  assert.deepEqual([output.ok, output.status, output.reason], [false, 'check-required', 'training-facts-required']);
  assert.ok(output.check.length > 0); assert.ok(output.alternatives.length > 0);
  assert.ok(output.details.issues.includes('training:stage-1-pending'), run.stderr);
  const stage = output.details.stages.find((row: { rank: number }) => row.rank === 1);
  assert.ok(stage.assistants.find((row: { id: string; issues: string[] }) => row.id === 'char_helper').issues.includes('assistant:unavailable'), run.stderr);
});

async function storePlan(w: { privateDirectory: string }, input: TrainingPlan) {
  await mkdir(join(w.privateDirectory, 'training-plans'), { recursive: true });
  await writeFile(join(w.privateDirectory, 'training-plans', `${input.id}.json`), JSON.stringify(input));
}
/** A plan whose M1 finished with real completion evidence; M2 waits for fresh materials. */
function between(paidAt: Record<string, string> | undefined): TrainingPlan {
  const input = runtimePlan(); input.rank = 2; input.target.currentRank = 1; input.target.goal = 3; input.state = 'pending'; input.materialReady = false; input.preplacementRequired = false;
  delete input.action; input.history = [{ at: '2026-11-11T05:00:00.000Z', kind: 'completed', rank: 1 }]; if (paidAt) input.paidAt = paidAt;
  return input;
}

test('32 defect 3: a user-confirmed in-training tier is paid in the snapshot and is not counted again', () => {
  const f = scanned(trainingFixture()), query = { ...f.request, target: 3 };
  assert.equal(calculateTraining(f.tables, f.snapshot, query).materials.raw?.materials.mat, 6);
  const paid = calculateTraining(f.tables, f.snapshot, { ...query, inTraining: { source: 'user-confirmed', rank: 1 } });
  assert.equal(paid.status, 'ok', JSON.stringify(paid.issues));
  assert.deepEqual([paid.currentRank, paid.inTrainingRank, paid.costFromRank], [0, 1, 1]);
  assert.equal(paid.materials.raw?.materials.mat, 5);
  assert.deepEqual(paid.stages.map(stage => stage.rank), [1, 2, 3]);
  assert.equal(paid.startMaterials?.raw?.materials.mat, 2);
  for (const fact of [{ source: 'user-confirmed', rank: 2 }, { source: 'unverified', rank: 1 }, { source: 'user-confirmed', rank: 1, startedAt: 'synthetic' }]) {
    const invalid = calculateTraining(f.tables, f.snapshot, { ...query, inTraining: fact });
    assert.equal(invalid.status, 'needs-input'); assert.ok(invalid.issues.includes('training:in-training-invalid'), JSON.stringify(fact));
  }
});

test('32 defect 3: a plan started from the in-training tier only observes that tier and never starts or pays it again', async t => {
  const f = scanned(trainingFixture()), w = await world(t, f);
  const query = { ...f.request, target: 3, inTraining: { source: 'user-confirmed', rank: 1 }, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const authorization = { source: 'current-request', reference: 'synthetic: S1 M1 is training now, continue to M3' };
  await assert.rejects(prepareTrainingPlan({ query, binding, currentTrainee: null, authorization }, { home: w.root }), /training-in-training-trainee-conflict/);
  const prepared = await prepareTrainingPlan({ query, binding, currentTrainee: 'char_synthetic', authorization }, { home: w.root });
  assert.deepEqual([prepared.rank, prepared.manualTraining, prepared.preplacementRequired, prepared.materialReady], [1, true, false, false]);
  assert.deepEqual(prepared.paidAt, { '1': f.snapshot.readAt });
  assert.ok(prepared.history.some(entry => entry.kind === 'in-training-user-confirmed' && entry.rank === 1));
  const applied = await applyTrainingPlan({ id: prepared.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.equal(applied.status, 'complete', JSON.stringify(applied));
  const queue = JSON.parse(await readFile(w.file, 'utf8')).Configurations.synthetic.TaskQueue;
  assert.deepEqual([queue[0].IsEnable, queue[1].IsEnable, queue[1].Plans], [true, false, []]);
  assert.equal((await readTrainingPlan(prepared.id, { home: w.root })).action?.kind, 'observe');
});

test('32 defect 3: between tiers, a snapshot older than the real completion is reconciled with the plan evidence instead of refusing or double counting', async t => {
  const f = scanned(trainingFixture()); f.snapshot.items.mat = 2;
  const w = await world(t, f), stale = { ...f.request, target: 2, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const refresh = async (input: TrainingPlan, query: unknown = stale) => { await storePlan(w, input); return refreshTrainingMaterials({ id: input.id, query }, { home: w.root }); };
  // M1 was paid before the snapshot was read (its materials are already gone from it): only M2 is needed.
  assert.equal((await refresh(between({ '1': f.snapshot.readAt }))).materialReady, true);
  // M1 was paid after the snapshot: that inventory still holds M1's materials, so M1 counts too (1 + 2 > 2).
  assert.equal((await refresh(between({ '1': '2026-11-12T00:00:00.000Z' }))).materialReady, false);
  // No recorded payment time: the tool cannot tell, so it counts M1 (conservative).
  assert.equal((await refresh(between(undefined))).materialReady, false);
  // A snapshot ahead of the plan's evidence is a contradiction and still stops.
  await assert.rejects(refresh(between({ '1': f.snapshot.readAt }), { ...stale, current: { ...f.request.current, mastery: { '1': 2 } } }), /target-changed/);
  // The in-training fact belongs to preparation only.
  await assert.rejects(refresh(between({ '1': f.snapshot.readAt }), { ...stale, current: { ...f.request.current, mastery: { '1': 1 } }, inTraining: { source: 'user-confirmed', rank: 2 } }), /training-in-training-refresh-unsupported/);
});

test('32 R1-1: the cut-off is the inventory scan time, and a tier the plan paid after it is counted even when the stated rank is newer', async t => {
  const f = trainingFixture(); f.snapshot.items.mat = 2;
  // An MAA snapshot imported after M1 was paid, from a depot scanned before it: readAt is not the inventory time.
  Object.assign(f.snapshot, { source: 'maa', readAt: '2026-11-12T00:00:00.000Z', sourceTimes: { operators: null, inventory: '2026-11-10T00:00:00.000Z' } });
  const w = await world(t, f), query = { ...f.request, target: 2, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const refresh = async (input: TrainingPlan, body: unknown = query) => { await storePlan(w, input); return refreshTrainingMaterials({ id: input.id, query: body }, { home: w.root }); };
  assert.equal((await refresh(between({ '1': '2026-11-11T00:00:00.000Z' }))).materialReady, false, 'scanned before M1 was paid: M1 + M2 = 3 > 2');
  // The completed rank stated in `current` does not hide a tier the plan paid after the scan.
  assert.equal((await refresh(between({ '1': '2026-11-11T00:00:00.000Z' }), { ...query, current: { ...f.request.current, mastery: { '1': 1 } } })).materialReady, false);
  // No inventory time at all: every tier the plan paid is counted.
  Object.assign(f.snapshot, { sourceTimes: { operators: null, inventory: null } }); await writeFile(w.snapshotFile, JSON.stringify(f.snapshot));
  assert.equal((await refresh(between({ '1': '2026-11-01T00:00:00.000Z' }))).materialReady, false);
  // Scanned after M1 was paid: only M2 counts.
  Object.assign(f.snapshot, { sourceTimes: { operators: null, inventory: '2026-11-11T12:00:00.000Z' } }); await writeFile(w.snapshotFile, JSON.stringify(f.snapshot));
  assert.equal((await refresh(between({ '1': '2026-11-11T00:00:00.000Z' }))).materialReady, true);
  // The in-training fact needs an inventory time it can vouch against.
  Object.assign(f.snapshot, { sourceTimes: { operators: null, inventory: null } });
  const unknown = calculateTraining(f.tables, f.snapshot, { ...f.request, target: 3, inTraining: { source: 'user-confirmed', rank: 1 } });
  assert.ok(unknown.issues.includes('training:in-training-inventory-time-unknown'), JSON.stringify(unknown.issues));
});

test('32 R1-2: an in-training tier that already finished before the first observation still advances the plan', () => {
  const manual = evidencePlan(); manual.manualTraining = true; manual.preplacementRequired = false; manual.target.goal = 2;
  manual.action = { kind: 'observe', dueAt: '2026-11-11T01:05:05.000Z', armedAt: manual.createdAt };
  const completed = (operator = '合成干员') => nativeLog('2026-11-11T01:05:20.000Z', 'SubTaskExtraInfo', { taskchain: 'Infrast', taskid: 5, what: 'InfrastTrainingCompleted',
    details: { operator, skill: '合成技能', level: 1 } });
  const advanced = reconcileTraining(manual, nativeTask(manual, undefined, 5) + completed(), '2026-11-11T01:06:00.000Z');
  assert.deepEqual([advanced.rank, advanced.state, advanced.target.currentRank, advanced.manualTraining], [2, 'pending', 1, false]);
  assert.ok(advanced.history.some(entry => entry.kind === 'completed' && entry.rank === 1));
  // Another operator's completion, or a completion outside this plan's own native run, does not count.
  assert.equal(reconcileTraining(manual, nativeTask(manual, undefined, 5) + completed('合成助手'), '2026-11-11T01:06:00.000Z').rank, 1);
  assert.equal(reconcileTraining(manual, completed(), '2026-11-11T01:06:00.000Z').rank, 1);
  // A plan that started the tier itself still needs its own start evidence first.
  const own = structuredClone(manual); own.manualTraining = false;
  assert.equal(reconcileTraining(own, nativeTask(own, undefined, 5) + completed(), '2026-11-11T01:06:00.000Z').rank, 1);
});

test('32 defect 3: the plan records when each tier it started was paid, and keeps a confirmed earlier payment', () => {
  const input = evidencePlan();
  const confirmed = reconcileTraining(input, nativeTask(input) + confirmation(), '2026-11-11T01:06:00.000Z');
  const observing = structuredClone(confirmed); observing.action = { kind: 'observe', dueAt: '2026-11-11T01:05:05.000Z', armedAt: input.createdAt };
  const started = reconcileTraining(observing, nativeTask(observing, undefined, 5) + countdown(), '2026-11-11T01:06:00.000Z');
  assert.equal(started.state, 'started'); assert.deepEqual(started.paidAt, { '1': '2026-11-11T01:05:01.000Z' });
  const manual = evidencePlan(); manual.manualTraining = true; manual.paidAt = { '1': '2026-11-10T00:00:00.000Z' };
  manual.action = { kind: 'observe', dueAt: '2026-11-11T01:05:05.000Z', armedAt: manual.createdAt };
  const observed = reconcileTraining(manual, nativeTask(manual, undefined, 5) + countdown(), '2026-11-11T01:06:00.000Z');
  assert.equal(observed.state, 'started'); assert.deepEqual(observed.paidAt, { '1': '2026-11-10T00:00:00.000Z' });
});

function craftable(f: Fixture) {
  Object.assign(f.tables.building.workshopFormulas, { synthetic: { formulaId: 'recipe_mat', formulaType: 'F_EVOLVE', itemId: 'mat', count: 1, goldCost: 5, apCost: 360000,
    costs: [{ id: 'ore', count: 2, type: 'MATERIAL' }], requireRooms: [{ roomId: 'WORKSHOP', roomLevel: 3, roomCount: 1 }], requireStages: [] } });
  Object.assign(f.tables.items.items, { ore: { name: '合成原料' } });
  Object.assign(f.snapshot.items, { mat: 0, ore: 10 });
  return f;
}
const workshop = { source: 'user-confirmed', rooms: { WORKSHOP: [3] } };

test('32 defect 2: with the user\'s crafting approval, a shortage the workshop covers lets the tier start (MAA OperProgress crafts it)', async t => {
  const f = craftable(trainingFixture()), w = await world(t, f);
  const query = { ...f.request, target: 1, progress: workshop, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const authorization = { source: 'current-request', reference: 'synthetic: train S1 to M1' }, crafting = { reference: 'synthetic: 缺的材料让 MAA 自动合成' };
  const plain = await prepareTrainingPlan({ query, binding, currentTrainee: 'char_synthetic', authorization }, { home: w.root });
  assert.equal(plain.materialReady, false);
  // Owner, 2026-11-16: a shortage keeps the plan waiting for its start; it is not an error and writes nothing.
  const before = await readFile(w.file, 'utf8');
  const waiting = await applyTrainingPlan({ id: plain.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.deepEqual([waiting.status, waiting.reason], ['waiting', 'training-materials-pending']); assert.equal(await readFile(w.file, 'utf8'), before);
  await assert.rejects(prepareTrainingPlan({ query, binding, currentTrainee: 'char_synthetic', authorization, crafting: { reference: ' ' } }, { home: w.root }), /training-authorization-required/);
  // Unknown workshop facts leave the recipe condition unknown, and the crafting fee needs LMD beyond the reserved costs.
  assert.equal((await prepareTrainingPlan({ query: { ...query, progress: undefined }, binding, currentTrainee: 'char_synthetic', authorization, crafting }, { home: w.root })).materialReady, false);
  f.snapshot.lmd = 4; await writeFile(w.snapshotFile, JSON.stringify(f.snapshot));
  assert.equal((await prepareTrainingPlan({ query, binding, currentTrainee: 'char_synthetic', authorization, crafting }, { home: w.root })).materialReady, false);
  f.snapshot.lmd = 1000; await writeFile(w.snapshotFile, JSON.stringify(f.snapshot));
  const granted = await prepareTrainingPlan({ query, binding, currentTrainee: 'char_synthetic', authorization, crafting }, { home: w.root });
  assert.deepEqual([granted.materialReady, granted.craftingRequired, granted.crafting], [true, true, crafting]);
  const applied = await applyTrainingPlan({ id: granted.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.equal(applied.status, 'complete', JSON.stringify(applied));
  assert.deepEqual(JSON.parse(await readFile(w.file, 'utf8')).Configurations.synthetic.TaskQueue[1].Plans[0].SkillMastery, [1, 0, 0]);
});

test('32 defect 2: the start gate never counts a voucher exchange, which MAA does not perform', () => {
  const row = (remaining: number | null) => ({ required: 1, available: 0, existing: 0, crafted: 1, voucher: 0, remaining });
  const plan = (extra = {}) => ({ materials: { mat: row(0) }, lmd: row(0), exp: row(0), steps: [], ledger: {}, blocked: [], vouchers: [], voucherAllocations: [], route: [], targets: [], ...extra });
  const gaps = (craft: object, noCraft: object = plan({ materials: { mat: row(1) } })) => ({ comparison: { craft, noCraft } }) as unknown as GapResult;
  const allocation = { voucherId: 'synthetic_voucher', itemId: 'mat', count: 1 };
  assert.equal(materialGate(gaps(plan()), false), 'short');
  assert.equal(materialGate(gaps(plan()), true), 'crafting');
  assert.equal(materialGate(gaps(plan({ voucherAllocations: [allocation], route: [{ kind: 'voucher', allocation }] })), true), 'short');
  assert.equal(materialGate(gaps(plan({ materials: { mat: row(null) } })), true), 'short');
  assert.equal(materialGate(gaps(plan(), plan()), false), 'ready');
  assert.equal(materialGate(null, true), 'short');
});

test('32 defect 4: an approved-report authorization is checked against the approved item before a plan is saved', async t => {
  const f = trainingFixture(), w = await world(t, f), hash = await approvedTrainingReport(w.privateDirectory, f);
  const prepare = (reference: string, query = {}) => prepareTrainingPlan({ query: { ...f.request, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile, ...query }, binding, currentTrainee: null,
    authorization: { source: 'approved-report', reference } }, { home: w.root });
  assert.equal((await prepare(`cultivation/${hash}#S1`)).target.goal, 2);
  await assert.rejects(prepare(`cultivation/${hash}#S1`, { target: 3 }), /training-approval-scope-mismatch/);
  await assert.rejects(prepare(`cultivation/${hash}#S2`), /training-approval-scope-mismatch/);
  await assert.rejects(prepare('synthetic approved training report entry'), /report-reference-invalid/);
});

test('32 defect 4: the next approved operator is preplaced only after the previous plan completes; one plan holds the training room at a time', async t => {
  const f = trainingFixture(), w = await world(t, f), hash = await approvedTrainingReport(w.privateDirectory, f);
  const a = runtimePlan(); a.id = 'plan-a'; a.state = 'started'; delete a.action; a.history = [{ at: '2026-11-11T01:00:00.000Z', kind: 'arming-start', rank: 1 }];
  await storePlan(w, a);
  const helperQuery = { name: '合成助手', skill: 1, target: 1, current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': 0 } },
    facts: { source: 'user-confirmed', trainingRoomLevel: 3, availableAssistants: ['char_synthetic'] }, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const b = await prepareTrainingPlan({ query: helperQuery, binding, currentTrainee: 'char_synthetic', authorization: { source: 'approved-report', reference: `cultivation/${hash}#S2` } }, { home: w.root });
  assert.equal(b.preplacementRequired, true);
  const before = await readFile(w.file, 'utf8');
  const blocked = await applyTrainingPlan({ id: b.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.deepEqual([blocked.status, blocked.reason], ['check-required', 'training-other-plan-active']); assert.equal(await readFile(w.file, 'utf8'), before);
  const listed = (await listTrainingPlans({ home: w.root })).map(row => [row.id, row.state, row.holdsTrainingRoom]);
  assert.deepEqual(listed.sort(), [['plan-a', 'started', true], [b.id, 'pending', false]].sort());
  // An arming the writer refused before writing changed nothing in MAA, so it does not hold the room.
  a.history.push({ at: '2026-11-11T01:01:00.000Z', kind: 'configuration-rejected-before-write', rank: 1 }); await storePlan(w, a);
  assert.equal((await listTrainingPlans({ home: w.root })).find(row => row.id === 'plan-a')?.holdsTrainingRoom, false);
  a.history.push({ at: '2026-11-11T01:02:00.000Z', kind: 'arming-start', rank: 1 }); await storePlan(w, a);
  assert.equal((await listTrainingPlans({ home: w.root })).find(row => row.id === 'plan-a')?.holdsTrainingRoom, true);
  a.state = 'complete'; a.target.currentRank = 2; await storePlan(w, a);
  const preplaced = await applyTrainingPlan({ id: b.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.equal(preplaced.status, 'complete', JSON.stringify(preplaced));
  const record = await readTrainingPlan(b.id, { home: w.root });
  assert.equal(record.action?.kind, 'preplace'); assert.ok(Date.parse(record.action!.dueAt) - Date.now() >= 240000);
  const queue = JSON.parse(await readFile(w.file, 'utf8')).Configurations.synthetic.TaskQueue;
  assert.deepEqual([queue[0].IsEnable, queue[1].IsEnable, queue[1].Plans], [true, false, []]);
});

test('32 defect 4: the user can close a stopped plan to free the training room; a plan whose own timer is still armed cannot be closed', async t => {
  const f = trainingFixture(), w = await world(t, f), now = new Date().toISOString();
  const a = runtimePlan(); a.id = 'plan-a'; a.state = 'unknown'; a.issues = ['training:execution-needs-reconciliation'];
  a.history = [{ at: now, kind: 'arming-start', rank: 1 }];
  const due = new Date(Date.now() + 3600000); due.setUTCSeconds(0, 0);
  const timer = { Id: 0, IsEnabled: null, Config: 'synthetic', Hour: due.getHours(), Minute: due.getMinutes() };
  a.action = { kind: 'start', dueAt: due.toISOString(), armedAt: now, timerIdentity: timer };
  Object.assign(w.config.Timers.List[0]!, timer); await writeFile(w.file, JSON.stringify(w.config)); await storePlan(w, a);
  const words = 'synthetic: 我已在游戏里核对，关闭这个计划';
  assert.deepEqual(await closeTrainingPlan({ id: 'plan-a', reference: words }, { home: w.root }), { status: 'check-required', reason: 'training-timer-still-armed' });
  Object.assign(w.config.Timers.List[0]!, { IsEnabled: false }); await writeFile(w.file, JSON.stringify(w.config));
  await assert.rejects(closeTrainingPlan({ id: 'plan-a' }, { home: w.root }), /training-close-reference-required/);
  assert.equal((await closeTrainingPlan({ id: 'plan-a', reference: words }, { home: w.root })).status, 'complete');
  const record = await readTrainingPlan('plan-a', { home: w.root });
  assert.equal(record.closed?.reference, words); assert.equal(record.state, 'unknown');
  assert.deepEqual((await listTrainingPlans({ home: w.root })).map(row => [row.id, row.holdsTrainingRoom, row.closed]), [['plan-a', false, true]]);
});

test('32 R1-3/R1-4: a cleanup the writer refused before writing stays pending and is retried; the plan keeps the room and cannot be closed meanwhile', async t => {
  const f = trainingFixture(), w = await world(t, f);
  const input = runtimePlan(); input.state = 'started'; input.target.goal = 2; input.preplacementRequired = false;
  input.createdAt = new Date(Date.now() - 3600000).toISOString(); input.startedAt = input.createdAt;
  input.history = [{ at: input.createdAt, kind: 'arming-start', rank: 1 }];
  const due = new Date(Date.now() - 600000); due.setUTCSeconds(0, 0);
  const timer = { Id: 0, IsEnabled: null, Config: 'synthetic', Hour: due.getHours(), Minute: due.getMinutes() };
  w.config.Configurations.synthetic.TaskQueue[0]!.Filename = 'synthetic-training.json';
  input.configurationBinding = { profile: 'synthetic', queue: structuredClone(w.config.Configurations.synthetic.TaskQueue), timer };
  input.action = { kind: 'observe', dueAt: due.toISOString(), armedAt: input.createdAt, timerIdentity: timer };
  Object.assign(w.config.Timers.List[0]!, timer); await writeFile(w.file, JSON.stringify(w.config)); await storePlan(w, input);
  // The observation ran and saw the tier finish: the plan advances to M2, but MAA is closed and nobody confirmed it.
  const ran = new Date(due.getTime() + 30000).toISOString();
  await writeFile(join(w.maaDirectory, 'core.log'), nativeTask(input, due.toISOString(), 5) + nativeLog(ran, 'SubTaskExtraInfo', { taskchain: 'Infrast', taskid: 5,
    what: 'InfrastTrainingCompleted', details: { operator: '合成干员', skill: '合成技能', level: 1 } }));
  const refused = await reconcileTrainingPlan({ id: input.id, logFile: join(w.maaDirectory, 'core.log'), host: 'codex' }, w.maa, { home: w.root });
  assert.equal(refused.cleanup?.status, 'rejected');
  assert.deepEqual([refused.plan.rank, refused.plan.state], [2, 'pending']); assert.ok(refused.plan.pendingCleanup);
  assert.ok(refused.plan.issues.includes('training:timer-cleanup-pending')); assert.equal(JSON.parse(await readFile(w.file, 'utf8')).Timers.List[0].IsEnabled, null);
  assert.equal((await listTrainingPlans({ home: w.root }))[0]!.holdsTrainingRoom, true);
  const blocked = await applyTrainingPlan({ id: input.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.deepEqual([blocked.status, blocked.reason], ['check-required', 'training-timer-cleanup-pending']);
  assert.deepEqual(await closeTrainingPlan({ id: input.id, reference: 'synthetic: 关闭' }, { home: w.root }), { status: 'check-required', reason: 'training-timer-still-armed' });
  // The next re-entry (confirmed this time) disables the plan's own slot and the chain continues.
  const cleaned = await reconcileTrainingPlan({ id: input.id, logFile: join(w.maaDirectory, 'core.log'), host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.equal(cleaned.cleanup?.status, 'complete'); assert.equal(cleaned.plan.pendingCleanup, undefined);
  assert.equal(cleaned.plan.issues.includes('training:timer-cleanup-pending'), false); assert.equal(JSON.parse(await readFile(w.file, 'utf8')).Timers.List[0].IsEnabled, false);
  assert.equal((await applyTrainingPlan({ id: input.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root })).status, 'waiting');
});
