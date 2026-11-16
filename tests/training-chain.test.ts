// Ticket 32: unattended mastery chaining — tier after tier, and from one approved operator to the next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareTrainingPlan, applyTrainingPlan, refreshTrainingMaterials, reconcileTrainingPlan, readTrainingPlan, listTrainingPlans, closeTrainingPlan, refreshTrainingPlan, reconcileCheckRequired } from '../skills/maa-core/scripts/training-plan.ts';
import { calculateTraining, materialGate, formatTraining, gateSpend, paymentTaken, trainingIssuePhase } from '../skills/maa-core/scripts/training-time.ts';
import { operatorCatalog } from '../skills/maa-core/scripts/operator-cost.ts';
import { reconcileTraining, paidRanks, planPayments, type TrainingPlan } from '../skills/maa-core/scripts/training-state.ts';
import type { GapResult } from '../skills/maa-core/scripts/cultivation-gaps.ts';
import { checkRequired, isCheckRequired } from '../skills/maa-core/scripts/check-required.ts';
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
  assert.equal(isCheckRequired(output), true, 'the shared shape, static details included');
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
  assert.deepEqual(await closeTrainingPlan({ id: 'plan-a', reference: words }, { home: w.root }), checkRequired('training-timer-still-armed'));
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
  assert.deepEqual(await closeTrainingPlan({ id: input.id, reference: 'synthetic: 关闭' }, { home: w.root }), checkRequired('training-timer-still-armed'));
  // The next re-entry (confirmed this time) disables the plan's own slot and the chain continues.
  const cleaned = await reconcileTrainingPlan({ id: input.id, logFile: join(w.maaDirectory, 'core.log'), host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.equal(cleaned.cleanup?.status, 'complete'); assert.equal(cleaned.plan.pendingCleanup, undefined);
  assert.equal(cleaned.plan.issues.includes('training:timer-cleanup-pending'), false); assert.equal(JSON.parse(await readFile(w.file, 'utf8')).Timers.List[0].IsEnabled, false);
  assert.equal((await applyTrainingPlan({ id: input.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root })).status, 'waiting');
});

test('32 R2-1: every tier the plan completed has a payment time, a manual tier is paid no later than the plan, and a missing time is bounded by the completion', async t => {
  // Producers. prepare: a tier the user already started by hand was paid no later than the plan itself.
  const f = trainingFixture(); f.snapshot.items.mat = 2;
  // An MAA depot scanned before the user started M1 by hand (M1 costs 1, M2 costs 2; real stock after M1 is 1).
  Object.assign(f.snapshot, { source: 'maa', readAt: '2026-11-12T00:00:00.000Z', sourceTimes: { operators: null, inventory: '2026-11-09T00:00:00.000Z' } });
  const w = await world(t, f), query = { ...f.request, target: 2, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const prepared = await prepareTrainingPlan({ query, binding, currentTrainee: 'char_synthetic', manualTraining: true,
    authorization: { source: 'current-request', reference: '一级我已经手动开了，接着练到二级' } }, { home: w.root });
  assert.deepEqual(prepared.paidAt, { '1': prepared.createdAt });
  // That record's own payment would be reserved by every other plan (R3-2); the cases below are about one plan.
  await rm(join(w.privateDirectory, 'training-plans', `${prepared.id}.json`));
  // reconcile: the R1-2 completion path keeps that time; a record without one reports the completed tier as paid at an unknown time.
  const manual = evidencePlan(); manual.manualTraining = true; manual.preplacementRequired = false; manual.target.goal = 2;
  manual.action = { kind: 'observe', dueAt: '2026-11-11T01:05:05.000Z', armedAt: manual.createdAt };
  const completed = nativeTask(manual, undefined, 5) + nativeLog('2026-11-11T01:05:20.000Z', 'SubTaskExtraInfo', { taskchain: 'Infrast', taskid: 5,
    what: 'InfrastTrainingCompleted', details: { operator: '合成干员', skill: '合成技能', level: 1 } });
  const forgot = reconcileTraining(manual, completed, '2026-11-11T01:06:00.000Z');
  assert.deepEqual([forgot.rank, forgot.target.currentRank], [2, 1]); assert.deepEqual(paidRanks(forgot), { '1': '2026-11-11T01:05:20.000Z' }, 'paid no later than its completion');
  const kept = reconcileTraining({ ...structuredClone(manual), paidAt: { '1': manual.createdAt } }, completed, '2026-11-11T01:06:00.000Z');
  assert.deepEqual(paidRanks(kept), { '1': manual.createdAt });
  // Consumer: refresh step 8 states the completed rank; the tier still in the older scan is counted either way (1 + 2 > 2).
  const stated = { ...query, current: { ...f.request.current, mastery: { '1': 1 } } };
  const refresh = async (input: TrainingPlan) => { await storePlan(w, input); return refreshTrainingMaterials({ id: input.id, query: stated }, { home: w.root }); };
  assert.equal((await refresh(between(undefined))).materialReady, false, 'no payment time recorded');
  assert.equal((await refresh(between({ '1': manual.createdAt }))).materialReady, false, 'paid by hand before the plan, after the scan');
  Object.assign(f.snapshot, { sourceTimes: { operators: null, inventory: '2026-11-11T12:00:00.000Z' } }); await writeFile(w.snapshotFile, JSON.stringify(f.snapshot));
  assert.equal((await refresh(between({ '1': manual.createdAt }))).materialReady, true, 'scanned after the plan: only M2 counts');
});

test('32 R2-2/R2-3: a waiting plan says to refresh; a refresh that lacks a fact the next start needs names it and keeps the start closed', async t => {
  const f = scanned(trainingFixture()); f.snapshot.items.mat = 2;
  const w = await world(t, f), query = { ...f.request, target: 2, current: { ...f.request.current, mastery: { '1': 1 } }, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const a = between({ '1': f.snapshot.readAt }); await storePlan(w, a);
  // Waiting for materials: the result says the next step is a refresh with the latest snapshot, not another apply.
  const waiting = await applyTrainingPlan({ id: a.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.deepEqual([waiting.status, waiting.reason, (waiting as { next?: string }).next], ['waiting', 'training-materials-pending', 'refresh']);
  // The room level is no longer confirmed: refresh names the fact, records it, and apply says to check it instead of "materials pending".
  const unconfirmed = { ...query, facts: { source: 'user-confirmed', availableAssistants: ['char_helper', 'char_locked'] } };
  await assert.rejects(refreshTrainingMaterials({ id: a.id, query: unconfirmed }, { home: w.root }),
    (error: Error & { details?: { issues?: string[] } }) => error.message === 'training-facts-required' && Boolean(error.details?.issues?.includes('training:room-unverified')));
  const record = await readTrainingPlan(a.id, { home: w.root });
  const named = ['training:room-unverified', 'training:room-rank-unavailable'];
  assert.deepEqual([record.materialReady, record.startIssues], [false, named]);
  const facts = await applyTrainingPlan({ id: a.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.deepEqual([facts.status, facts.reason, (facts as { details?: unknown }).details], ['check-required', 'training-facts-required', { issues: named }]);
  // With the fact back, refresh clears it and the start opens once materials are covered.
  const ready = await refreshTrainingMaterials({ id: a.id, query }, { home: w.root });
  assert.deepEqual([ready.materialReady, ready.startIssues], [true, undefined]);
});

test('32 R2-4: the training summary and the refresh output show the shortage down to base materials and the LMD gap', async t => {
  const f = craftable(scanned(trainingFixture()));
  const query = { ...f.request, target: 1, progress: workshop };
  // Crafting from stock covers it: the summary names the finished shortage and that crafting needs the user's approval.
  const covered = formatTraining(calculateTraining(f.tables, f.snapshot, query));
  assert.match(covered, /下一次开训（M1）还缺: mat × 1/); assert.match(covered, /按现有库存加工可以补齐/); assert.doesNotMatch(covered, /加工展开到基础材料/);
  // Nothing to craft from: the breakdown names the base material still to get and the LMD gap.
  const bare = structuredClone(f); Object.assign(bare.snapshot.items, { ore: 0 });
  const summary = formatTraining(calculateTraining(bare.tables, bare.snapshot, query));
  assert.match(summary, /加工展开到基础材料/); assert.match(summary, /还要获取的基础材料：ore × 2/); assert.match(summary, /龙门币缺口/);
  // Nothing short: no breakdown section.
  const enough = scanned(trainingFixture()); enough.snapshot.items.mat = 20;
  assert.doesNotMatch(formatTraining(calculateTraining(enough.tables, enough.snapshot, { ...enough.request, target: 1 })), /加工展开到基础材料/);
  // The refresh that keeps a plan waiting reports the same breakdown.
  Object.assign(f.snapshot.items, { ore: 0 }); const w = await world(t, f);
  const a = between({ '1': f.snapshot.readAt }); await storePlan(w, a);
  const refreshed = await refreshTrainingPlan({ id: a.id, query: { ...f.request, target: 2, current: { ...f.request.current, mastery: { '1': 1 } }, progress: workshop,
    snapshotFile: w.snapshotFile, tablesFile: w.tablesFile } }, { home: w.root });
  assert.equal(refreshed.plan.materialReady, false); assert.match(refreshed.summary, /加工展开到基础材料/);
});

test('32 R3-1: the apply CLI prints each stop with its own reason, with or without details', async t => {
  const f = scanned(trainingFixture()); const w = await world(t, f);
  const apply = (id: string) => {
    const run = spawnSync(process.execPath, ['--import', versionDoublePreload, resolve('skills/maa-core/scripts/training-plan.ts'), 'apply'], { encoding: 'utf8',
      env: { ...process.env, MAA_SKILLS_HOME: w.root }, input: JSON.stringify({ id, host: 'codex', closedConfirmed: true }) });
    return { status: run.status, output: JSON.parse(run.stdout) };
  };
  const closed = between({ '1': f.snapshot.readAt }); closed.id = 'plan-closed'; closed.closed = { at: '2026-11-12T00:00:00.000Z', reference: '关掉' }; await storePlan(w, closed);
  const stop = apply(closed.id);
  assert.deepEqual([stop.status, stop.output.status, stop.output.reason], [1, 'check-required', 'training-plan-closed']); assert.ok(stop.output.alternatives.length);
  const facts = between({ '1': f.snapshot.readAt }); facts.id = 'plan-facts'; facts.startIssues = ['training:room-unverified']; await storePlan(w, facts);
  const named = apply(facts.id);
  assert.deepEqual([named.output.reason, named.output.details.issues], ['training-facts-required', ['training:room-unverified']]);
});

/** A finished plan for the other synthetic operator that paid its M1 at `at` (the fixture's operators share the same costs). */
function paidElsewhere(at: string): TrainingPlan {
  const a = runtimePlan(); a.id = 'plan-a'; a.target = { ...a.target, operatorId: 'char_helper', name: '合成助手' }; a.target.goal = 1; a.rank = 1; a.target.currentRank = 1;
  a.state = 'complete'; a.preplacementRequired = false; delete a.action; a.paidAt = { '1': at };
  a.history = [{ at, kind: 'arming-start', rank: 1 }, { at, kind: 'countdown-observed', rank: 1 }, { at: '2026-11-11T05:00:00.000Z', kind: 'completed', rank: 1 }];
  return a;
}

test('32 R3-2: a payment any plan made after the inventory time is reserved before the next plan\'s gate, and a start never uses a gate older than one', async t => {
  // An MAA depot scanned on 11-09 with mat 2 (M1 costs 1, M2 costs 2); the other operator's plan paid its M1 on 11-10: real stock 1.
  const f = trainingFixture(); f.snapshot.items.mat = 2;
  Object.assign(f.snapshot, { source: 'maa', readAt: '2026-11-12T00:00:00.000Z', sourceTimes: { operators: null, inventory: '2026-11-09T00:00:00.000Z' } });
  const w = await world(t, f), query = { ...f.request, target: 1, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const authorization = { source: 'current-request', reference: '合成助手练完接着练合成干员一技能专一' };
  // Consumer 1, prepare: the stale stock covers M1 (2 >= 1), but 1 of it is gone: still 1 >= 1, so tighten to mat 1 (real 0).
  f.snapshot.items.mat = 1; await writeFile(w.snapshotFile, JSON.stringify(f.snapshot));
  await storePlan(w, paidElsewhere('2026-11-10T00:05:01.000Z'));
  const b = await prepareTrainingPlan({ query, binding, currentTrainee: null, authorization }, { home: w.root });
  assert.equal(b.materialReady, false, 'the other plan already spent the only mat');
  // A payment before the scan is already out of the inventory and is not reserved twice.
  await storePlan(w, paidElsewhere('2026-11-08T00:00:00.000Z'));
  const fresh = await prepareTrainingPlan({ query, binding, currentTrainee: null, authorization }, { home: w.root });
  assert.equal(fresh.materialReady, true);
  // Consumer 2, refresh of a waiting plan: the same reservation.
  await storePlan(w, paidElsewhere('2026-11-10T00:05:01.000Z'));
  assert.equal((await refreshTrainingMaterials({ id: fresh.id, query }, { home: w.root })).materialReady, false);
  // Consumer 3, apply: a gate computed before another plan recorded a new payment is not used to start.
  await storePlan(w, paidElsewhere('2026-11-08T00:00:00.000Z'));
  const ready = await refreshTrainingMaterials({ id: fresh.id, query }, { home: w.root }); assert.equal(ready.materialReady, true);
  const later = paidElsewhere('2026-11-08T00:00:00.000Z'); later.id = 'plan-later'; later.paidAt = { '1': '2026-11-12T03:00:00.000Z' }; await storePlan(w, later);
  const record = await readTrainingPlan(fresh.id, { home: w.root }); record.preplacementRequired = false; record.state = 'preplaced'; record.preplacedAt = '2026-11-12T00:00:00.000Z'; await storePlan(w, record);
  const before = await readFile(w.file, 'utf8');
  const held = await applyTrainingPlan({ id: fresh.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.deepEqual([held.status, held.reason, (held as { next?: string }).next], ['waiting', 'training-materials-pending', 'refresh']);
  assert.equal(await readFile(w.file, 'utf8'), before, 'nothing is armed');
  assert.equal((await readTrainingPlan(fresh.id, { home: w.root })).materialReady, false);
});

test('32 R3-2: one owner lists every plan\'s payments, and every gate in the plan tool reads it', async () => {
  const manual = runtimePlan(); manual.paidAt = { '1': '2026-11-10T00:00:00.000Z' };
  const done = runtimePlan(); done.id = 'plan-done'; done.history = [{ at: '2026-11-11T05:00:00.000Z', kind: 'completed', rank: 2 }];
  const counted = runtimePlan(); counted.id = 'plan-counted'; counted.history = [{ at: '2026-11-11T01:05:10.000Z', kind: 'countdown-observed', rank: 3 }];
  // Producers: a recorded payment time, a completed tier without one (paid no later than its completion), a countdown observation.
  assert.deepEqual(planPayments([manual, done, counted], manual.id).map(row => [row.operatorId, row.rank, row.at]),
    [['char_synthetic', 2, '2026-11-11T05:00:00.000Z'], ['char_synthetic', 3, '2026-11-11T01:05:10.000Z']]);
  assert.deepEqual(planPayments([manual], null).map(row => row.rank), [1]);
  // Consumers: every estimate the plan tool runs passes the other plans' payments; the start path checks what its gate saw.
  const text = await readFile(resolve('skills/maa-core/scripts/training-plan.ts'), 'utf8');
  const queries = [...text.matchAll(/queryTraining\(([^;]*)\)/g)].map(match => match[1]!);
  assert.ok(queries.length >= 2 && queries.every(call => call.includes('payments')), queries.join(' | '));
  assert.match(text, /paymentsSeen/);
});

test('32 R4-1/R4-2: a tier another plan started under a crafting gate reserves what that gate spent, raw inputs and fees included, and the reservation is shown', async t => {
  const f = trainingFixture();
  // 合成助手 M1 costs mat x2; 合成干员 M1 costs ore x4. The workshop makes mat from ore x2 and ore from dust x3.
  const tier = (cost: { id: string; count: number }[], seconds: number) => ({ unlockCond: { phase: 'PHASE_2', level: 1 }, lvlUpTime: seconds, levelUpCost: cost.map(c => ({ ...c, type: 'MATERIAL' })) });
  const skills = (m1: { id: string; count: number }[]) => [{ skillId: 'synthetic_skill', unlockCond: { phase: 'PHASE_0', level: 1 },
    levelUpCostCond: [tier(m1, 3600), tier([{ id: 'mat', count: 2 }], 7200), tier([{ id: 'mat', count: 3 }], 14400)] }];
  Object.assign(f.tables.characters.char_helper, { skills: skills([{ id: 'mat', count: 2 }]) });
  Object.assign(f.tables.characters.char_synthetic, { skills: skills([{ id: 'ore', count: 4 }]) });
  const formula = (id: string, input: string, count: number) => ({ formulaId: `recipe_${id}`, formulaType: 'F_EVOLVE', itemId: id, count: 1, goldCost: 5, apCost: 360000,
    costs: [{ id: input, count, type: 'MATERIAL' }], requireRooms: [{ roomId: 'WORKSHOP', roomLevel: 3, roomCount: 1 }], requireStages: [] });
  Object.assign(f.tables.building.workshopFormulas, { mat: formula('mat', 'ore', 2), ore: formula('ore', 'dust', 3) });
  Object.assign(f.tables.items.items, { ore: { name: '合成原料' }, dust: { name: '合成粉末' } });
  // The depot scan the chain keeps using (11-09): mat 0, ore 4, dust 30.
  Object.assign(f.snapshot, { items: { mat: 0, ore: 4, dust: 30 }, lmd: 1000, source: 'maa', readAt: '2026-11-12T00:00:00.000Z',
    sourceTimes: { operators: null, inventory: '2026-11-09T00:00:00.000Z' } });
  const w = await world(t, f);
  const facts = (assistants: string[]) => ({ source: 'user-confirmed', trainingRoomLevel: 3, availableAssistants: assistants });
  const query = (name: string, assistants: string[]) => ({ name, skill: 1, target: 1, current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': 0 } }, facts: facts(assistants),
    progress: workshop, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile });
  // Plan A has the user's crafting approval: its gate is 'crafting' and records that the start spends ore x4 (and the fees).
  const a = await prepareTrainingPlan({ query: query('合成助手', ['char_synthetic', 'char_locked']), binding, currentTrainee: 'char_helper',
    authorization: { source: 'current-request', reference: '合成助手一技能专一' }, crafting: { reference: '缺的材料让 MAA 自动合成' } }, { home: w.root });
  assert.deepEqual([a.materialReady, a.craftingRequired], [true, true]);
  assert.deepEqual(a.spends?.['1'], { items: { mat: 2, ore: 4 }, lmd: 10 }, 'gross use on the route (R6-1)');
  // A started on 11-10 (after the scan) and finished: MAA crafted mat x2 from ore x4 and paid them.
  const done = await readTrainingPlan(a.id, { home: w.root });
  Object.assign(done, { state: 'complete', materialReady: false, paidAt: { '1': '2026-11-10T00:05:01.000Z' }, target: { ...done.target, currentRank: 1 } }); delete done.action;
  done.history.push({ at: '2026-11-10T00:05:10.000Z', kind: 'countdown-observed', rank: 1 }, { at: '2026-11-10T01:05:20.000Z', kind: 'completed', rank: 1 });
  await storePlan(w, done);
  assert.deepEqual(planPayments([done], null).map(row => row.spent), [a.spends!['1']]);
  // Plan B, without crafting approval, needs ore x4 directly: the old scan still shows it, but A's crafting used it up.
  const b = await prepareTrainingPlan({ query: query('合成干员', ['char_helper', 'char_locked']), binding, currentTrainee: 'char_helper',
    authorization: { source: 'current-request', reference: '合成干员一技能专一' } }, { home: w.root });
  assert.equal(b.materialReady, false, 'the ore went into A\'s crafting');
  assert.deepEqual(b.reservedTiers?.map(row => [row.operatorId, row.skill, row.rank]), [['char_helper', 1, 1]]);
  // R4-2: the summary names the reservation and how to lift it.
  const refreshed = await refreshTrainingPlan({ id: b.id, query: query('合成干员', ['char_helper', 'char_locked']) }, { home: w.root });
  assert.match(refreshed.summary, /别的计划.*已从库存里扣掉/); assert.match(refreshed.summary, /char_helper/);
  // A payment without a gate record (a tier the user paid by hand) still reserves the tier's finished cost.
  delete done.spends; await storePlan(w, done);
  assert.deepEqual(planPayments([done], null).map(row => row.spent), [undefined]);
});

/** R4/R5 world: 合成助手 M1 costs mat x2 (mat crafts from ore x2), 合成干员 M1 costs `need`; an MAA scan at `scan`. */
async function craftWorld(t: { after(fn: () => Promise<unknown>): void }, items: Record<string, number>, need: { id: string; count: number }[], scan = '2026-11-09T00:00:00.000Z') {
  const f = trainingFixture();
  const tier = (cost: { id: string; count: number }[], seconds: number) => ({ unlockCond: { phase: 'PHASE_2', level: 1 }, lvlUpTime: seconds, levelUpCost: cost.map(c => ({ ...c, type: 'MATERIAL' })) });
  const skills = (m1: { id: string; count: number }[]) => [{ skillId: 'synthetic_skill', unlockCond: { phase: 'PHASE_0', level: 1 },
    levelUpCostCond: [tier(m1, 3600), tier([{ id: 'mat', count: 2 }], 7200), tier([{ id: 'mat', count: 3 }], 14400)] }];
  Object.assign(f.tables.characters.char_helper, { skills: skills([{ id: 'mat', count: 2 }]) });
  Object.assign(f.tables.characters.char_synthetic, { skills: skills(need) });
  const formula = (id: string, input: string, count: number) => ({ formulaId: `recipe_${id}`, formulaType: 'F_EVOLVE', itemId: id, count: 1, goldCost: 5, apCost: 360000,
    costs: [{ id: input, count, type: 'MATERIAL' }], requireRooms: [{ roomId: 'WORKSHOP', roomLevel: 3, roomCount: 1 }], requireStages: [] });
  Object.assign(f.tables.building.workshopFormulas, { mat: formula('mat', 'ore', 2), ore: formula('ore', 'dust', 3) });
  // As in the real item table, the materials relate to a material voucher whose count no snapshot carries (R5-1).
  const voucher = [{ voucherId: 'premium_material_voucher_perm', voucherItemType: 'MATERIAL_ISSUE_VOUCHER' }];
  Object.assign(f.tables.items.items, { mat: { ...(f.tables.items.items as Record<string, object>).mat, voucherRelateList: voucher }, ore: { name: '合成原料', voucherRelateList: voucher },
    dust: { name: '合成粉末' }, premium_material_voucher_perm: { name: '合成材料提货券', itemType: 'MATERIAL_ISSUE_VOUCHER' } });
  Object.assign(f.snapshot, { items, lmd: 1000, source: 'maa', readAt: '2026-11-12T00:00:00.000Z', sourceTimes: { operators: null, inventory: scan } });
  const w = await world(t, f);
  const query = (name: string, assistants: string[], target = 1, mastery = 0) => ({ name, skill: 1, target, current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': mastery } },
    facts: { source: 'user-confirmed', trainingRoomLevel: 3, availableAssistants: assistants }, progress: workshop, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile });
  return { f, w, query };
}

test('32 R5-1: material vouchers whose count no snapshot carries do not keep the start gate closed', async t => {
  const { w, query } = await craftWorld(t, { mat: 4, ore: 0, dust: 0 }, [{ id: 'ore', count: 4 }]);
  const a = await prepareTrainingPlan({ query: query('合成助手', ['char_synthetic', 'char_locked']), binding, currentTrainee: 'char_helper',
    authorization: { source: 'current-request', reference: '合成助手一技能专一' } }, { home: w.root });
  assert.equal(a.materialReady, true); assert.deepEqual(a.spends?.['1'], { items: { mat: 2 }, lmd: 0 });
});

test('32 R5-2/R5-3: one owner says what a payment took out of an inventory: only its own tier, never less than the tier\'s finished materials', async t => {
  // R5-3: A's gate was computed on an old scan (crafting from ore); the user then got mat x2 and rescanned before A started, so A
  // used the mat. B (no crafting approval) needs mat x2 and reads that newer scan: the mat is reserved, not only the ore.
  const { w, query } = await craftWorld(t, { mat: 2, ore: 4, dust: 0 }, [{ id: 'mat', count: 2 }], '2026-11-09T12:00:00.000Z');
  const a = runtimePlan(); a.id = 'plan-a'; a.target = { ...a.target, operatorId: 'char_helper', name: '合成助手' }; a.target.goal = 1; a.rank = 1; a.target.currentRank = 1;
  a.state = 'complete'; a.preplacementRequired = false; delete a.action; a.paidAt = { '1': '2026-11-10T00:05:01.000Z' }; a.spends = { '1': { items: { ore: 4 }, lmd: 10 } };
  a.history = [{ at: '2026-11-10T00:05:10.000Z', kind: 'countdown-observed', rank: 1 }, { at: '2026-11-10T01:05:20.000Z', kind: 'completed', rank: 1 }];
  await storePlan(w, a);
  const b = await prepareTrainingPlan({ query: query('合成干员', ['char_helper', 'char_locked']), binding, currentTrainee: 'char_helper',
    authorization: { source: 'current-request', reference: '合成干员一技能专一' } }, { home: w.root });
  assert.equal(b.materialReady, false, 'A used the mat the newer scan shows');
  // R5-2: a plan whose own M1 was paid after the scan records for M2 only M2's materials (the gate covers exactly its tier).
  const own = between({ '1': '2026-11-10T00:00:00.000Z' }); own.id = 'plan-own';
  own.target = { ...own.target, operatorId: 'char_helper', name: '合成助手' }; own.target.goal = 2; await storePlan(w, own);
  await rm(join(w.privateDirectory, 'training-plans', 'plan-a.json')); await rm(join(w.privateDirectory, 'training-plans', `${b.id}.json`));
  Object.assign(w, {}); const g = JSON.parse(await readFile(w.snapshotFile, 'utf8')); g.items = { mat: 4, ore: 0, dust: 0 }; await writeFile(w.snapshotFile, JSON.stringify(g));
  const refreshed = await refreshTrainingMaterials({ id: own.id, query: query('合成助手', ['char_synthetic', 'char_locked'], 2, 1) }, { home: w.root });
  assert.equal(refreshed.materialReady, true, 'M1 (2) reserved, M2 (2) covered by the remaining 2');
  assert.deepEqual(refreshed.spends?.['2'], { items: { mat: 2 }, lmd: 0 }, 'M2 only, not M1 again');
});

test('32 R6-1/R6-2/R6-3: a crafting record covers every item the route used, intermediates included; a manual tier records nothing; the summary names whose tiers', async t => {
  // A's gate on scan S0 (mat 0, ore 0, dust 30) crafts ore x4 from dust x12 and mat x2 from that ore.
  const { w, query } = await craftWorld(t, { mat: 0, ore: 0, dust: 30 }, [{ id: 'ore', count: 4 }], '2026-11-09T00:00:00.000Z');
  const a = await prepareTrainingPlan({ query: query('合成助手', ['char_synthetic', 'char_locked']), binding, currentTrainee: 'char_helper',
    authorization: { source: 'current-request', reference: '合成助手一技能专一' }, crafting: { reference: '缺的材料让 MAA 自动合成' } }, { home: w.root });
  assert.deepEqual([a.materialReady, a.spends?.['1']?.items], [true, { mat: 2, ore: 4, dust: 12 }], 'gross use, not net');
  // The user then got ore x4 and rescanned (S1) before A started, so A's start crafted mat from that ore. B (no crafting
  // approval) needs ore x4 and reads S1: the ore is reserved.
  const s1 = JSON.parse(await readFile(w.snapshotFile, 'utf8')); s1.items = { mat: 0, ore: 4, dust: 30 }; s1.sourceTimes.inventory = '2026-11-09T12:00:00.000Z';
  await writeFile(w.snapshotFile, JSON.stringify(s1));
  const done = await readTrainingPlan(a.id, { home: w.root });
  Object.assign(done, { state: 'complete', materialReady: false, paidAt: { '1': '2026-11-10T00:05:01.000Z' }, target: { ...done.target, currentRank: 1 } }); delete done.action;
  done.history.push({ at: '2026-11-10T00:05:10.000Z', kind: 'countdown-observed', rank: 1 }, { at: '2026-11-10T01:05:20.000Z', kind: 'completed', rank: 1 });
  await storePlan(w, done);
  const b = await prepareTrainingPlan({ query: query('合成干员', ['char_helper', 'char_locked']), binding, currentTrainee: 'char_helper',
    authorization: { source: 'current-request', reference: '合成干员一技能专一' } }, { home: w.root });
  assert.equal(b.materialReady, false, 'A\'s start used the ore the newer scan shows');
  // R6-3: the summary does not call the reserved tiers "other plans'".
  const shown = await refreshTrainingPlan({ id: b.id, query: query('合成干员', ['char_helper', 'char_locked']) }, { home: w.root });
  assert.match(shown.summary, /在这份库存读取之后已经付过料的档次/); assert.doesNotMatch(shown.summary, /别的计划在这份库存/);
  // R6-2: a tier the user already started by hand records no spend, at prepare or at refresh.
  for (const file of [a.id, b.id]) await rm(join(w.privateDirectory, 'training-plans', `${file}.json`));
  const manual = await prepareTrainingPlan({ query: query('合成助手', ['char_synthetic', 'char_locked']), binding, currentTrainee: 'char_helper', manualTraining: true,
    authorization: { source: 'current-request', reference: '一级我已经手动开了' }, crafting: { reference: '缺的材料让 MAA 自动合成' } }, { home: w.root });
  assert.equal(manual.spends, undefined);
  assert.equal((await refreshTrainingMaterials({ id: manual.id, query: query('合成助手', ['char_synthetic', 'char_locked']) }, { home: w.root })).spends?.['1'], undefined);
});

test('32 R6-1 conformance: for any gate scan S0 <= later inventory I <= start stock P, what is reserved never leaves more in I than MAA leaves at the start', () => {
  // 合成助手 M1 costs mat x2; the workshop makes mat from ore x2 and ore from dust x3 (5 LMD each).
  const f = trainingFixture();
  const tier = (cost: { id: string; count: number }[], seconds: number) => ({ unlockCond: { phase: 'PHASE_2', level: 1 }, lvlUpTime: seconds, levelUpCost: cost.map(c => ({ ...c, type: 'MATERIAL' })) });
  Object.assign(f.tables.characters.char_helper, { skills: [{ skillId: 'synthetic_skill', unlockCond: { phase: 'PHASE_0', level: 1 },
    levelUpCostCond: [tier([{ id: 'mat', count: 2 }], 3600), tier([{ id: 'mat', count: 2 }], 7200), tier([{ id: 'mat', count: 3 }], 14400)] }] });
  const formula = (id: string, input: string, count: number) => ({ formulaId: `recipe_${id}`, formulaType: 'F_EVOLVE', itemId: id, count: 1, goldCost: 5, apCost: 360000,
    costs: [{ id: input, count, type: 'MATERIAL' }], requireRooms: [{ roomId: 'WORKSHOP', roomLevel: 3, roomCount: 1 }], requireStages: [] });
  Object.assign(f.tables.building.workshopFormulas, { mat: formula('mat', 'ore', 2), ore: formula('ore', 'dust', 3) });
  Object.assign(f.tables.items.items, { ore: { name: '合成原料' }, dust: { name: '合成粉末' } });
  const ids = ['mat', 'ore', 'dust'] as const; type Stock = Record<(typeof ids)[number], number>;
  const query = { name: '合成助手', skill: 1, target: 1, current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': 0 } },
    facts: { source: 'user-confirmed', trainingRoomLevel: 3, availableAssistants: ['char_synthetic', 'char_locked'] }, progress: workshop };
  /** MAA at the start: use the stock, craft the rest recursively; null when it cannot (no start, nothing paid). */
  const maaTakes = (stock: Stock): Stock | null => {
    const left = { ...stock }, taken: Stock = { mat: 0, ore: 0, dust: 0 };
    const need = (id: 'mat' | 'ore' | 'dust', count: number): boolean => {
      const own = Math.min(left[id], count); left[id] -= own; taken[id] += own; const rest = count - own;
      if (!rest) return true; if (id === 'dust') return false;
      return need(id === 'mat' ? 'ore' : 'dust', rest * (id === 'mat' ? 2 : 3));
    };
    return need('mat', 2) ? taken : null;
  };
  const catalog = operatorCatalog(f.tables as never);
  let checked = 0;
  for (const s0 of [[0, 0, 12], [0, 4, 0], [1, 2, 0], [0, 0, 30], [2, 0, 0], [0, 2, 6]] as const) {
    const scan: Stock = { mat: s0[0], ore: s0[1], dust: s0[2] };
    const result = calculateTraining(f.tables, { ...f.snapshot, items: { ...scan }, lmd: 1000 }, query);
    const gate = materialGate(result.startMaterials, true); assert.notEqual(gate, 'short', JSON.stringify(scan));
    const spent = gateSpend(result.startMaterials, gate as 'ready' | 'crafting')!;
    const reserved = paymentTaken(catalog, { operatorId: 'char_helper', skill: 1, rank: 1, at: '2026-11-10T00:00:00.000Z', spent })!;
    for (const addI of [[0, 0, 0], [2, 0, 0], [0, 4, 0], [0, 0, 6], [1, 2, 3]] as const) for (const addP of [[0, 0, 0], [2, 0, 0], [0, 4, 0], [0, 0, 6]] as const) {
      const inventory: Stock = { mat: scan.mat + addI[0], ore: scan.ore + addI[1], dust: scan.dust + addI[2] };
      const start: Stock = { mat: inventory.mat + addP[0], ore: inventory.ore + addP[1], dust: inventory.dust + addP[2] };
      const taken = maaTakes(start); if (!taken) continue;
      for (const id of ids) assert.ok(Math.max(0, inventory[id] - (reserved.items[id] ?? 0)) <= start[id] - taken[id],
        `${id}: S0 ${JSON.stringify(scan)} I ${JSON.stringify(inventory)} P ${JSON.stringify(start)} reserved ${JSON.stringify(reserved)} taken ${JSON.stringify(taken)}`);
      checked++;
    }
  }
  assert.ok(checked > 100, String(checked));
});

test('32 item 7: a plan prepared from a Skland read that shows this tier training only observes it, paid at the read time', async t => {
  const f = trainingFixture(), at = '2026-11-12T00:00:00.000Z'; f.snapshot.items.mat = 20;
  for (const operator of f.snapshot.operators) Object.assign(operator, { skillLevel: 7, mastery: { '1': 0, '2': 0, '3': 0 } });
  Object.assign(f.snapshot, { source: 'skland', readAt: at, sourceTimes: { operators: at, inventory: at },
    base: { rooms: [{ type: 'training', slotId: 'slot_train', level: 3, operators: [{ id: 'char_synthetic', role: 'trainee', targetSkill: 0, remainSecs: 3600, moodRaw: 0, moodAt: at }] }] },
    coverage: { operators: { status: 'complete', issues: [] }, inventory: { status: 'complete', issues: [] }, base: { status: 'complete', issues: [] } } });
  const w = await world(t, f), query = { ...f.request, target: 2, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  await assert.rejects(prepareTrainingPlan({ query, binding, currentTrainee: null, authorization: { source: 'current-request', reference: '接着练到专二' } }, { home: w.root }),
    /training-in-training-trainee-conflict/);
  const prepared = await prepareTrainingPlan({ query, binding, currentTrainee: 'char_synthetic', authorization: { source: 'current-request', reference: '接着练到专二' } }, { home: w.root });
  assert.deepEqual([prepared.manualTraining, prepared.paidAt, prepared.preplacementRequired], [true, { '1': at }, false]);
  assert.ok(prepared.history.some(entry => entry.kind === 'in-training-snapshot' && entry.rank === 1));
});

test('32 follow-on: facts needed to start no longer block preparation; the plan saves them and waits for a refresh', async t => {
  const f = scanned(trainingFixture()); f.snapshot.items.mat = 20;
  const w = await world(t, f), query = { ...f.request, target: 2, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const authorization = { source: 'current-request', reference: '合成干员一技能练到专二' };
  // The room level is not confirmed and the snapshot has none: the plan is saved, the start is closed and names the fact.
  const noRoom = { ...query, facts: { source: 'user-confirmed', availableAssistants: ['char_helper', 'char_locked'] } };
  const plan = await prepareTrainingPlan({ query: noRoom, binding, currentTrainee: null, authorization }, { home: w.root });
  assert.deepEqual([plan.state, plan.materialReady, plan.startIssues], ['pending', false, ['training:room-unverified', 'training:room-rank-unavailable']]);
  const held = await applyTrainingPlan({ id: plan.id, host: 'codex', closedConfirmed: true }, w.maa, { home: w.root });
  assert.deepEqual([held.status, held.reason], ['check-required', 'training-facts-required'], 'not even the preplacement is armed');
  const refreshed = await refreshTrainingMaterials({ id: plan.id, query: { ...query, target: 1 } }, { home: w.root });
  assert.deepEqual([refreshed.materialReady, refreshed.startIssues], [true, undefined]);
  // A later tier's missing estimate is checked again before that tier; the first tier's assistant is recorded.
  const later = scanned(trainingFixture()); later.snapshot.items.mat = 20; later.tables.characters.char_synthetic.skills[0]!.levelUpCostCond[1]!.lvlUpTime = 0;
  await writeFile(w.tablesFile, JSON.stringify(later.tables));
  const second = await prepareTrainingPlan({ query, binding, currentTrainee: null, authorization }, { home: w.root });
  assert.deepEqual([second.assistants, second.startIssues, second.materialReady], [{ '1': '合成助手' }, undefined, true]);
  // A fact that makes the plan itself unknowable still refuses: the user's in-training statement the inventory cannot vouch for.
  await assert.rejects(prepareTrainingPlan({ query: { ...query, inTraining: { source: 'user-confirmed', rank: 2 } }, binding, currentTrainee: 'char_synthetic', authorization }, { home: w.root }),
    /training-facts-required/);
});

test('32 follow-on: every training issue the estimate can raise is classified once as a prepare fact or a start fact', async () => {
  const text = await readFile(resolve('skills/maa-core/scripts/training-time.ts'), 'utf8');
  const raised = [...new Set([...text.matchAll(/issues\.push\('(training:[a-z0-9-]+)'\)/g)].map(match => match[1]!))];
  assert.ok(raised.length >= 8, raised.join(','));
  for (const issue of [...raised, 'training:stage-1-pending', 'training:stage-3-pending']) assert.ok(['prepare', 'start'].includes(trainingIssuePhase(issue, 1)), issue);
  assert.equal(trainingIssuePhase('training:stage-1-pending', 1), 'prepare', 'the first tier needs an assistant for any MAA write');
  assert.equal(trainingIssuePhase('training:stage-3-pending', 1), 'start');
  assert.equal(trainingIssuePhase('training:some-future-code', 1), 'start', 'a new code never blocks preparation by default');
  assert.equal(trainingIssuePhase('progress:rooms:invalid', 1), 'prepare', 'invalid input is refused at once');
});

test('32 FO1-2/FO1-6/FO1-8: a refusal keeps every reason; a room limit holds only the tier it limits; the plan says which snapshot and room level it used', async t => {
  const f = scanned(trainingFixture()); f.snapshot.items.mat = 20; f.snapshot.operators[0]!.mastery = { '1': 0 } as never;
  const w = await world(t, f), query = { ...f.request, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const authorization = { source: 'current-request', reference: '合成干员一技能练到专三' };
  // FO1-2: the user's stated rank contradicts the snapshot: the cost tool's reason stays in the refusal.
  await assert.rejects(prepareTrainingPlan({ query: { ...query, target: 3, current: { ...f.request.current, mastery: { '1': 1 } } }, binding, currentTrainee: null, authorization }, { home: w.root }),
    (error: Error & { details?: { issues?: string[] } }) => error.message === 'training-facts-required' && Boolean(error.details?.issues?.some(issue => issue.includes('conflict'))));
  // FO1-6: a level-2 room can train M1 and M2; M3 waits for its own refresh, it does not hold M1.
  const plan = await prepareTrainingPlan({ query: { ...query, target: 3, facts: { ...f.request.facts, trainingRoomLevel: 2 } }, binding, currentTrainee: null, authorization }, { home: w.root });
  assert.deepEqual([plan.startIssues, plan.materialReady], [undefined, true]);
  // FO1-8: the plan records the snapshot and the room level it was prepared from, and the summary shows them.
  assert.deepEqual([plan.snapshotUsed?.file, plan.snapshotUsed?.chosen, plan.trainingRoom], ['snapshot.json', 'explicit', { level: 2, source: 'user-confirmed' }]);
  // A room that cannot train the next tier holds it (level 1, M1 done, next is M2).
  const low = scanned(trainingFixture()); low.snapshot.items.mat = 20;
  await writeFile(w.snapshotFile, JSON.stringify(low.snapshot));
  const held = await prepareTrainingPlan({ query: { ...query, target: 2, current: { ...f.request.current, mastery: { '1': 1 } }, facts: { ...f.request.facts, trainingRoomLevel: 1 } },
    binding, currentTrainee: null, authorization }, { home: w.root });
  assert.deepEqual(held.startIssues, ['training:room-rank-unavailable']);
});

test('32 FO2-1: prepare and refresh stop on missing facts through one predicate, keeping every reason', async t => {
  const f = scanned(trainingFixture()); f.snapshot.items.mat = 20; f.snapshot.operators[0]!.mastery = { '1': 0 } as never;
  const w = await world(t, f), query = { ...f.request, target: 1, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile };
  const plan = await prepareTrainingPlan({ query, binding, currentTrainee: null, authorization: { source: 'current-request', reference: '合成干员一技能练到专一' } }, { home: w.root });
  const conflicting = { ...query, current: { ...f.request.current, mastery: { '1': 1 } } };
  const facts = (error: Error & { details?: { issues?: string[] } }) => error.message === 'training-facts-required' && Boolean(error.details?.issues?.some(issue => issue.includes('conflict')));
  await assert.rejects(prepareTrainingPlan({ query: conflicting, binding, currentTrainee: null, authorization: { source: 'current-request', reference: 'x' } }, { home: w.root }), facts);
  await assert.rejects(refreshTrainingMaterials({ id: plan.id, query: conflicting }, { home: w.root }), facts, 'not "target changed"');
  // A real target change still says so.
  await assert.rejects(refreshTrainingMaterials({ id: plan.id, query: { ...query, target: 2 } }, { home: w.root }), /training-refresh-target-changed/);
});

test('32 FO2-3: with no tier left to start, the room level is not reported as unable', () => {
  // Level-1 room (limit M1) training the last tier M1: nothing is left to start, so the room is not "unable".
  const f = trainingFixture(); f.snapshot.items.mat = 20;
  for (const operator of f.snapshot.operators) Object.assign(operator, { skillLevel: 7, mastery: { '1': 0, '2': 0, '3': 0 } });
  const at = '2026-11-12T00:00:00.000Z';
  Object.assign(f.snapshot, { source: 'skland', readAt: at, sourceTimes: { operators: at, inventory: at },
    base: { rooms: [{ type: 'training', slotId: 'slot_train', level: 1, operators: [{ id: 'char_synthetic', role: 'trainee', targetSkill: 0, remainSecs: 3600, moodRaw: 0, moodAt: at }] }] },
    coverage: { operators: { status: 'complete', issues: [] }, inventory: { status: 'complete', issues: [] }, base: { status: 'complete', issues: [] } } });
  const last = calculateTraining(f.tables, f.snapshot, { ...f.request, target: 1, facts: { ...f.request.facts, trainingRoomLevel: 1 } });
  assert.equal(last.inTrainingRank, 1); assert.ok(!last.issues.includes('training:room-rank-unavailable'), last.issues.join(','));
});

test('32 FO2-2: when a recipe needs a stage nobody confirmed, the training output says how to record the user\'s one-line confirmation', () => {
  const f = craftable(trainingFixture());
  Object.assign((f.tables.building.workshopFormulas as Record<string, object>).synthetic!, { requireStages: [{ stageId: 'stage_synthetic', rank: 2 }] });
  Object.assign(f.tables, { stages: { stages: { stage_synthetic: { stageId: 'stage_synthetic', code: 'SYN-1' } } } });
  const asked = formatTraining(calculateTraining(f.tables, f.snapshot, { ...f.request, target: 1, progress: workshop }), 'zh-CN');
  assert.match(asked, /confirmedStages:\["stage_synthetic"\]/); assert.match(asked, /不填 stageRanks/);
  const confirmed = formatTraining(calculateTraining(f.tables, f.snapshot, { ...f.request, target: 1, progress: { ...workshop, confirmedStages: ['stage_synthetic'] } }), 'zh-CN');
  assert.doesNotMatch(confirmed, /confirmedStages/);
});

/**
 * Ticket 32 FO3 (recurrence rule: the stop-reason class came back in FO1-2, FO2-1 and FO3-2/FO3-3). Every input that can stop a
 * plan, through every producer (prepare, refresh) and the consumer (apply reading what refresh saved), comes from one decision.
 */
test('32 FO3 conformance: where prepare, refresh and apply stop, for every kind of input', async t => {
  const current = (mastery?: number, skill = '1') => ({ source: 'user-confirmed', skillLevel: 7, ...(mastery === undefined ? {} : { mastery: { [skill]: mastery } }) });
  const roomOnly = { source: 'user-confirmed', availableAssistants: ['char_helper', 'char_locked'] };
  type Outcome = { prepare: string; refresh: string; saved: string[] | null; apply: string };
  const facts = 'training-facts-required', changed = 'training-refresh-target-changed', go = 'proceeds';
  // The plan under refresh: M1 finished with real completion evidence (paid at the snapshot's inventory time); M2 is next.
  const cases: { name: string; mastery?: number; query: Record<string, unknown>; expect: Outcome }[] = [
    { name: 'snapshot older than the plan completion, current = that completion (FO3-1)', mastery: 0, query: { current: current(1) },
      expect: { prepare: facts, refresh: go, saved: null, apply: go } },
    { name: 'snapshot older than the plan completion, no stated rank', mastery: 0, query: { current: current() }, expect: { prepare: 'saved', refresh: go, saved: null, apply: go } },
    { name: 'no current rank anywhere', query: { current: current() },
      expect: { prepare: facts, refresh: facts, saved: ['targets:incomplete', 'current.mastery.1:unknown-or-invalid'], apply: facts } },
    { name: 'stated rank conflicts with a snapshot as new as the plan', mastery: 1, query: { current: current(0) },
      expect: { prepare: facts, refresh: facts, saved: ['targets:incomplete', 'current.mastery.1:conflict'], apply: facts } },
    { name: 'snapshot one tier ahead of the plan', mastery: 2, query: { current: current() }, expect: { prepare: 'saved', refresh: changed, saved: null, apply: 'waiting' } },
    { name: 'snapshot two tiers ahead (FO3-2)', mastery: 3, query: { current: current() }, expect: { prepare: facts, refresh: changed, saved: null, apply: 'waiting' } },
    { name: 'snapshot two tiers ahead, stated rank = the plan completion', mastery: 3, query: { current: current(1) }, expect: { prepare: facts, refresh: changed, saved: null, apply: 'waiting' } },
    { name: 'another operator', query: { name: '合成助手', current: current(1) }, expect: { prepare: 'saved', refresh: changed, saved: null, apply: 'waiting' } },
    { name: 'another skill', query: { skill: 2, current: current(0, '2') }, expect: { prepare: facts, refresh: changed, saved: null, apply: 'waiting' } },
    { name: 'another target', query: { target: 3, current: current(1) }, expect: { prepare: 'saved', refresh: changed, saved: null, apply: 'waiting' } },
    { name: 'no assistant for the next tier (FO3-3)', query: { current: current(1), facts: { ...roomOnly, trainingRoomLevel: 3, availableAssistants: [] } },
      expect: { prepare: facts, refresh: facts, saved: ['training:stage-2-pending'], apply: facts } },
    { name: 'training room unverified', query: { current: current(1), facts: roomOnly },
      expect: { prepare: 'saved', refresh: facts, saved: ['training:room-unverified', 'training:room-rank-unavailable'], apply: facts } },
  ];
  const outcome = async (run: () => Promise<unknown>) => { try { await run(); return 'ok'; } catch (error) { return (error as Error).message; } };
  for (const row of cases) {
    const f = scanned(trainingFixture()); f.snapshot.items.mat = 2;
    if (row.mastery !== undefined) f.snapshot.operators[0]!.mastery = { '1': row.mastery } as never;
    // Separate worlds: a plan prepared in one would be reserved by the refresh in the other.
    const p = await world(t, f), r = await world(t, f);
    const query = (w: typeof p) => ({ ...f.request, target: 2, snapshotFile: w.snapshotFile, tablesFile: w.tablesFile, ...row.query });
    const prepared = await outcome(() => prepareTrainingPlan({ query: query(p), binding, currentTrainee: null, authorization: { source: 'current-request', reference: 'x' } }, { home: p.root }));
    const plan = between({ '1': f.snapshot.readAt }); await storePlan(r, plan);
    const refreshed = await outcome(() => refreshTrainingMaterials({ id: plan.id, query: query(r) }, { home: r.root }));
    const saved = (await readTrainingPlan(plan.id, { home: r.root })).startIssues ?? null;
    const applied = await applyTrainingPlan({ id: plan.id, host: 'codex', closedConfirmed: true }, r.maa, { home: r.root });
    const actual: Outcome = { prepare: prepared === 'ok' ? 'saved' : prepared, refresh: refreshed === 'ok' ? go : refreshed, saved,
      apply: applied.status === 'check-required' ? String(applied.reason) : applied.status === 'waiting' ? 'waiting' : go };
    assert.deepEqual(actual, row.expect, row.name);
  }
});

test('32 FO5-3: a reconcile whose cleanup needs checking names the plan and keeps the MAA version drift', () => {
  const plan = between({ '1': '2026-11-10T00:00:00.000Z' });
  const versions = { state: 'same', recorded: { maaVersion: 'v6.22.0', recordVersion: 3 }, current: { maaVersion: 'v6.22.0', recordVersion: 3 }, changed: [] };
  const printed = reconcileCheckRequired({ plan, cleanup: checkRequired('training-timer-ownership-changed'), versions });
  assert.equal(isCheckRequired(printed), true);
  assert.deepEqual(printed.details, { plan: plan.id, state: plan.state, rank: plan.rank, versions });
});
