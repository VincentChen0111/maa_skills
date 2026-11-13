import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decideStageRun, loadBatchView, observeStageRun, recordStageProgress, startStageRun, switchStageRun, verifyStageRun } from '../skills/maa-core/scripts/stage-run.ts';
import { rerunGate, type BatchView, type Decision } from '../skills/maa-core/scripts/stage-run-state.ts';
import { inspectConfiguration } from '../skills/maa-core/scripts/maa-config.ts';
import { approvedJobFile } from '../skills/maa-core/scripts/stage-job-plan.ts';
import { matchStageJobs, prepareStageJobs } from '../skills/maa-core/scripts/stage-jobs.ts';
import { stageJob, stageSnapshot, stageTables } from './fixtures/stage-data.ts';
import { attempt, chainEnd, connection, copilotStart, core, gui, medicineConfirm, medicineUsed, preparedBatch, runJobs, runRequest, runTables, type PreparedBatch }
  from './fixtures/stage-run-data.ts';

/**
 * Conformance for the one re-run gate (`rerunGate`). Every producer of "a chain may have run / the outcome is unproven"
 * is run against every consumer: the decisions offered in a summary, `decide`, `progress`, `start` without `retryOf`, and
 * `start` with `retryOf` (first and second use, and with a retry decision injected into the batch view so the batch-wide
 * judgement is exercised even where `decide` already refuses).
 */
const chain = (taskid: number) => ({ taskchain: 'Copilot', taskid });
const retag = (lines: string[], taskid: number) => lines.map(line => line.replace(/"taskid":1([,}])/g, `"taskid":${taskid}$1`).replace('task_id: 1', `task_id: ${taskid}`));
const loaded = (second: number, file: string, taskid = 1) => core(second, 'SubTaskExtraInfo', { ...chain(taskid), class: 'asst::MultiCopilotTaskPlugin', what: 'CopilotListLoadTaskFileSuccess', details: { stage_name: 'synthetic', file_name: file, id: 0 } });
const endOfAction = (second: number) => core(second, 'SubTaskStart', { ...chain(1), class: 'asst::ProcessTask', subtask: 'ProcessTask', details: { task: 'Copilot@EndOfAction' } });
type Context = { batch: PreparedBatch; paths: { maaDirectory: string; privateDirectory: string }; runId: string };
async function context(t: test.TestContext, beforeStart: (batch: PreparedBatch) => string[] = () => []): Promise<Context> {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  Object.assign(batch.state, { running: true, treeExited: false, idle: true, ready: true });
  const early = beforeStart(batch); if (early.length) await batch.core(early);
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
  const { runId } = await startStageRun({ ...paths, operation: batch.operation, reference: '开始' });
  return { batch, paths, runId };
}
const observe = (c: Context, runId = c.runId) => observeStageRun({ ...c.paths, runId }, c.batch.maa);
const verify = (c: Context, runId = c.runId) => verifyStageRun({ ...c.paths, runId }, c.batch.maa);
const beforeBattle = async (c: Context) => c.batch.core([...copilotStart(0, { files: c.batch.files }), loaded(10, c.batch.files[0]!), connection(12, 'Disconnect'), ...chainEnd(13, 'TaskChainError')]);
const settledThenDisconnect = async (c: Context) => c.batch.core([...copilotStart(0, { files: c.batch.files }),
  ...attempt(10, 0, c.batch.files[0]!, 'open', [endOfAction(80), connection(81, 'Reconnecting'), connection(85, 'Disconnect')]), ...chainEnd(86, 'TaskChainError')]);
async function injected(c: Context, decision: Decision): Promise<BatchView> {
  const { batch } = await loadBatchView(c.paths, c.runId);
  const latest = batch.records.at(-1)!;
  latest.decisions = [...latest.decisions, { at: new Date().toISOString(), decision, reason: 'injected' }];
  return batch;
}
const injectedRetry = (c: Context) => injected(c, 'retry-within-approval');
/** Ticket 17's consumer: carrying out an alternate switch. It is refused before any write when the gate refuses. */
const switchRequest = async (c: Context) => ({ ...c.paths, runId: c.runId, stageId: 'synthetic_01', expectedRevision: (await inspectConfiguration(c.batch.maaDirectory)).revision, host: 'codex' as const });
const fullProgress = [{ stageId: 'synthetic_01', completedRuns: 2 }, { stageId: 'synthetic_02', completedRuns: 1 }];

type Producer = { name: string; unlockedByProgress?: boolean; run(t: test.TestContext): Promise<Context> };
const producers: Producer[] = [
  { name: 'chain started before the anchor (user clicked Start first)', run: async t => {
    const c = await context(t, () => copilotStart(0, { files: [] }));
    await c.batch.core([...attempt(10, 0, c.batch.files[0]!, 'open'), connection(30, 'Disconnect'), ...chainEnd(31, 'TaskChainError')]);
    return c;
  } },
  { name: 'copilot chain after the record was taken over', run: async t => {
    const c = await context(t);
    await c.batch.core([core(1, 'TaskChainStart', { taskchain: 'Fight', taskid: 1 }), core(50, 'TaskChainCompleted', { taskchain: 'Fight', taskid: 1 })]);
    await observe(c);
    await c.batch.core([...retag(copilotStart(100, { files: c.batch.files }), 2), ...retag(attempt(110, 0, c.batch.files[0]!, 'open', [connection(181, 'Disconnect')]), 2),
      ...retag(chainEnd(182, 'TaskChainError'), 2)]);
    return c;
  } },
  { name: 'copilot chain after the tracking was closed', run: async t => {
    const c = await context(t);
    await decideStageRun({ ...c.paths, runId: c.runId, decision: 'stop-and-tell-user', reason: '用户说先不开始' });
    await c.batch.core([...copilotStart(100, { files: c.batch.files }), ...attempt(110, 0, c.batch.files[0]!, 'open'), ...chainEnd(190, 'TaskChainError')]);
    return c;
  } },
  { name: 'log gap since the earliest anchor', run: async t => {
    const c = await context(t);
    await c.batch.core([...copilotStart(0, { files: c.batch.files }), loaded(10, c.batch.files[0]!)]);
    await observe(c);
    await writeFile(join(c.batch.maaDirectory, 'debug/asst.log'), '');
    await c.batch.core([connection(12, 'Disconnect'), ...chainEnd(13, 'TaskChainError')]);
    return c;
  } },
  { name: 'Copilot callback with no attributed chain', run: async t => {
    const c = await context(t);
    await beforeBattle(c);
    await c.batch.core([core(14, 'SubTaskStart', { ...chain(7), class: 'asst::BattleProcessTask', subtask: 'BattleProcessTask', details: {} })]);
    return c;
  } },
  { name: 'settlement reached, then disconnect', unlockedByProgress: true, run: async t => { const c = await context(t); await settledThenDisconnect(c); return c; } },
  { name: 'MAA process gone mid-battle', unlockedByProgress: true, run: async t => {
    const c = await context(t);
    await c.batch.core([...copilotStart(0, { files: c.batch.files }), ...attempt(10, 0, c.batch.files[0]!, 'open')]);
    Object.assign(c.batch.state, { running: false, treeExited: true, ready: false });
    await observe(c);
    Object.assign(c.batch.state, { running: true, treeExited: false, ready: true });
    return c;
  } },
];

test('every consumer refuses a re-run for every producer of an unproven chain or outcome', async t => {
  for (const producer of producers) {
    const c = await producer.run(t), name = producer.name;
    assert.notEqual((await observe(c)).execution, 'tracking', name);
    const verified = await verify(c);
    assert.deepEqual(verified.allowedDecisions, ['stop-and-tell-user'], name);
    for (const decision of ['retry-within-approval', 'switch-alternate'] as const) {
      await assert.rejects(decideStageRun({ ...c.paths, runId: c.runId, decision, reason: '再打' }), /decision-not-allowed/, `${name} ${decision}`);
    }
    let batch = await injectedRetry(c);
    assert.equal(rerunGate(batch, { kind: 'start', retryOf: c.runId }).allowed, false, `${name}: even with a recorded retry decision`);
    await assert.rejects(switchStageRun(await switchRequest(c), c.batch.maa), /switch-not-decided/, `${name}: switch`);
    assert.equal(rerunGate(await injected(c, 'switch-alternate'), { kind: 'switch', runId: c.runId, stageId: 'synthetic_01' }).allowed, false,
      `${name}: even with a recorded switch decision`);
    const stated = await recordStageProgress({ ...c.paths, runId: c.runId, reference: '用户：每关都打满了', stages: fullProgress });
    if (producer.unlockedByProgress) assert.ok(stated.allowedDecisions.includes('retry-within-approval'), `${name}: the user's statement settles the unknown attempt`);
    else assert.deepEqual(stated.allowedDecisions, ['stop-and-tell-user'], `${name}: a statement does not lift a batch-wide hold`);
    assert.ok(!stated.allowedDecisions.includes('switch-alternate'), `${name}: every run stated done leaves nothing to switch`);
    batch = await injectedRetry(c);
    assert.equal(rerunGate(batch, { kind: 'start', retryOf: c.runId }).allowed, false, `${name}: after the statement (hold or finished entries still ticked)`);
    assert.equal(rerunGate(await injected(c, 'switch-alternate'), { kind: 'switch', runId: c.runId, stageId: 'synthetic_01' }).allowed, false, `${name}: switch after the statement`);
    await assert.rejects(startStageRun({ ...c.paths, operation: c.batch.operation, reference: '重新开始' }), /run-unresolved/, name);
    for (const use of ['first', 'second']) {
      await assert.rejects(startStageRun({ ...c.paths, operation: c.batch.operation, reference: '重试', retryOf: c.runId }), /retry-not-decided|run-unresolved|chain-already-started/, `${name} ${use}`);
    }
  }
});

/**
 * Issue #48 (ticket 17, acceptance 4): MAA reported medicine use, or its use cannot be read, or the medicine toggle was on
 * or unknown at start. Even with a MAA-reported failure and an approved alternate, nothing switches or retries: the run
 * stops and waits for the user's decision; a progress statement does not change that.
 */
const medicineProducers: { name: string; reason: string; count: number | 'unknown'; lines(c: Context): string[] }[] = [
  { name: 'MAA reported medicine use', reason: 'medicine-used', count: 2,
    lines: c => [...copilotStart(0, { files: c.batch.files, medicine: true }), ...attempt(10, 0, c.batch.files[0]!, 'failed', [medicineConfirm(11), medicineUsed(12, 2)]), ...chainEnd(60, 'TaskChainError')] },
  { name: 'medicine use unreadable (confirmed, no count reported)', reason: 'medicine-unknown', count: 'unknown',
    lines: c => [...copilotStart(0, { files: c.batch.files, medicine: true }), ...attempt(10, 0, c.batch.files[0]!, 'failed', [medicineConfirm(11)]), ...chainEnd(60, 'TaskChainError')] },
  { name: 'medicine toggle on at start, none reported', reason: 'medicine-toggle', count: 0,
    lines: c => [...copilotStart(0, { files: c.batch.files, medicine: true }), ...attempt(10, 0, c.batch.files[0]!, 'failed'), ...chainEnd(60, 'TaskChainError')] },
  { name: 'medicine toggle unknown (submission not seen)', reason: 'medicine-toggle', count: 0,
    lines: c => [...copilotStart(0, { files: c.batch.files }).slice(2), ...attempt(10, 0, c.batch.files[0]!, 'failed'), ...chainEnd(60, 'TaskChainError')] },
];
test('medicine reported, unreadable or possibly enabled: no alternate switch, no retry, wait for the user (issue #48)', async t => {
  for (const producer of medicineProducers) {
    const c = await context(t), name = producer.name;
    await c.batch.core(producer.lines(c));
    const observed = await observe(c);
    assert.equal(observed.stages[0]!.result, 'failed', name);
    assert.equal(observed.medicine.count, producer.count, name);
    assert.deepEqual(observed.alternates[0], { stageId: 'synthetic_01', job: 1, next: 2, left: 1 }, `${name}: an approved alternate is there`);
    assert.deepEqual(observed.allowedDecisions, ['stop-and-tell-user'], name); assert.equal(observed.next, 'report', `${name}: report and wait`);
    assert.deepEqual((await verify(c)).allowedDecisions, ['stop-and-tell-user'], name);
    for (const decision of ['retry-within-approval', 'switch-alternate'] as const) {
      await assert.rejects(decideStageRun({ ...c.paths, runId: c.runId, decision, reason: '授权应该够用' }), /decision-not-allowed/, `${name} ${decision}`);
    }
    await assert.rejects(switchStageRun(await switchRequest(c), c.batch.maa), /switch-not-decided/, name);
    assert.deepEqual(rerunGate(await injected(c, 'switch-alternate'), { kind: 'switch', runId: c.runId, stageId: 'synthetic_01' }), { allowed: false, reason: producer.reason }, name);
    assert.equal(rerunGate(await injectedRetry(c), { kind: 'start', retryOf: c.runId }).allowed, false, name);
    const stated = await recordStageProgress({ ...c.paths, runId: c.runId, reference: '用户：SYN-1 打完一次，就是失败的那次', stages: [{ stageId: 'synthetic_01', completedRuns: 1 }] });
    assert.deepEqual(stated.allowedDecisions, ['stop-and-tell-user'], `${name}: a statement does not lift it`);
    const list = (await readFile(join(c.batch.maaDirectory, 'config/gui.new.json'), 'utf8'));
    assert.ok(!list.includes(`"CopilotId": 2`) && !list.includes('"CopilotId":2'), `${name}: the alternate was never written`);
  }
});

test('the only unlock without a user statement: an environment failure before battle, one chain per retry decision', async t => {
  const c = await context(t);
  await beforeBattle(c);
  await observe(c);
  assert.deepEqual((await verify(c)).allowedDecisions, ['retry-within-approval', 'switch-alternate', 'stop-and-tell-user']);
  assert.equal(rerunGate(await injectedRetry(c), { kind: 'start', retryOf: c.runId }).allowed, true);
  await assert.rejects(startStageRun({ ...c.paths, operation: c.batch.operation, reference: '重新开始' }), /run-unresolved/);
  await decideStageRun({ ...c.paths, runId: c.runId, decision: 'retry-within-approval', reason: '没进战斗就断连，已核对' });
  const retry = await startStageRun({ ...c.paths, operation: c.batch.operation, reference: '用户再点开始', retryOf: c.runId });
  assert.equal(retry.retryOf, c.runId);
  await assert.rejects(startStageRun({ ...c.paths, operation: c.batch.operation, reference: '再重试', retryOf: c.runId }), /run-unresolved/);
  await c.batch.core([...retag(copilotStart(200, { files: c.batch.files }), 2), ...retag(chainEnd(205, 'TaskChainStopped'), 2)]);
  await observeStageRun({ ...c.paths, runId: retry.runId }, c.batch.maa);
  await assert.rejects(startStageRun({ ...c.paths, operation: c.batch.operation, reference: '第三次', retryOf: c.runId }), /chain-already-started/);
});

test('a chain the user started before start retryOf consumes the retry decision: first and second use refused', async t => {
  const c = await context(t);
  await beforeBattle(c);
  await observe(c); await verify(c);
  await decideStageRun({ ...c.paths, runId: c.runId, decision: 'retry-within-approval', reason: '已核对' });
  await c.batch.core(retag(copilotStart(200, { files: c.batch.files }), 2));
  for (const use of ['first', 'second']) {
    await assert.rejects(startStageRun({ ...c.paths, operation: c.batch.operation, reference: '重试', retryOf: c.runId }), /untracked-chain|chain-already-started/, use);
  }
});

test('stage progress below the callback evidence is refused; a retry needs the finished entries unticked', async t => {
  const c = await context(t);
  await settledThenDisconnect(c);
  await observe(c);
  assert.equal((await verify(c)).next, 'ask-progress');
  await assert.rejects(recordStageProgress({ ...c.paths, runId: c.runId, reference: '用户：一次都没打完', stages: [{ stageId: 'synthetic_01', completedRuns: 0 }] }),
    /progress-contradicts-evidence/);
  const stated = await recordStageProgress({ ...c.paths, runId: c.runId, reference: '用户：SYN-1 结算过一次', stages: [{ stageId: 'synthetic_01', completedRuns: 1 }] });
  assert.deepEqual(stated.allowedDecisions, ['retry-within-approval', 'switch-alternate', 'stop-and-tell-user']);
  await decideStageRun({ ...c.paths, runId: c.runId, decision: 'retry-within-approval', reason: '用户已说明进度' });
  await assert.rejects(startStageRun({ ...c.paths, operation: c.batch.operation, reference: '全部还勾着', retryOf: c.runId }), /finished-items-ticked/);
  const file = join(c.batch.maaDirectory, 'config/gui.new.json'), config = JSON.parse(await readFile(file, 'utf8'));
  config.Configurations['Synthetic profile'].Copilot.TaskList[0].IsChecked = false;
  await writeFile(file, JSON.stringify(config));
  assert.equal((await startStageRun({ ...c.paths, operation: c.batch.operation, reference: '取消勾选了已打完的一项', retryOf: c.runId })).retryOf, c.runId);
});

test('an unverified blocking environment failure allows only stop, even after a MAA-reported failure', async t => {
  const c = await context(t);
  await c.batch.core([...copilotStart(0, { files: c.batch.files }), connection(5, 'ScreencapFailed'), ...attempt(10, 0, c.batch.files[0]!, 'failed'), ...chainEnd(60, 'TaskChainError')]);
  const observed = await observe(c);
  assert.equal(observed.next, 'verify'); assert.deepEqual(observed.allowedDecisions, ['stop-and-tell-user']);
  await assert.rejects(decideStageRun({ ...c.paths, runId: c.runId, decision: 'switch-alternate', reason: '换备选' }), /decision-not-allowed/);
  assert.deepEqual((await verify(c)).allowedDecisions, ['switch-alternate', 'stop-and-tell-user'], 'a MAA-reported failure is not retried with the same job');
});

test('start is refused while another record of the batch is still tracking; a record without any chain does not block', async t => {
  const c = await context(t);
  await assert.rejects(startStageRun({ ...c.paths, operation: c.batch.operation, reference: '又说一次开始' }), /run-unresolved/);
  const closed = await decideStageRun({ ...c.paths, runId: c.runId, decision: 'stop-and-tell-user', reason: '用户还没点开始，先不跟踪' });
  assert.equal(closed.execution, 'unknown'); assert.equal(closed.executionReason, 'closed-before-start');
  assert.equal((await startStageRun({ ...c.paths, operation: c.batch.operation, reference: '现在点开始' })).retryOf, null);
  const taken = await context(t);
  await taken.batch.gui([gui(5, 'Scheduled start: Timer Index: 0')]);
  await taken.batch.core([core(6, 'TaskChainStart', { taskchain: 'Fight', taskid: 1 }), core(40, 'TaskChainCompleted', { taskchain: 'Fight', taskid: 1 })]);
  assert.equal((await observe(taken)).takeover?.source, 'native-schedule');
  assert.equal((await startStageRun({ ...taken.paths, operation: taken.batch.operation, reference: '日常跑完了，现在点开始' })).retryOf, null);
});

test('a batch whose approved job was already loaded before any tracking is not started', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  const later = fromNow(60);
  await batch.core([...copilotStart(later, { files: batch.files }), loaded(later + 10, batch.files[0]!), ...chainEnd(later + 60, 'TaskChainCompleted')]);
  await assert.rejects(startStageRun({ maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory, operation: batch.operation, reference: '开始' }), /batch-may-have-run/);
});

/** Fixture log seconds relative to now (the fixture's clock starts at 2026-11-13 02:00 UTC). */
function fromNow(seconds: number) { return Math.floor((Date.now() - Date.UTC(2026, 10, 13, 2, 0, 0)) / 1000) + seconds; }
/** Re-prepares from a report with MAA closed, as `prepare` requires, and leaves MAA running again. */
async function prepareAgain(batch: PreparedBatch, report: ReturnType<typeof matchStageJobs>, selections: { stageId: string; primary: number; alternates: number[]; loops: number }[]) {
  Object.assign(batch.state, { running: false, treeExited: true, ready: false });
  const result = await prepareStageJobs({ report, approval: { reportHash: report.hash, reference: '合成用户再次批准', map: 'synthetic_map', selections }, snapshot: stageSnapshot(),
    maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory, profile: 0, host: 'codex', closedConfirmed: true,
    expectedRevision: (await inspectConfiguration(batch.maaDirectory)).revision }, batch.maa);
  Object.assign(batch.state, { running: true, treeExited: false, idle: true, ready: true });
  assert.equal(result.status, 'complete');
  return result.operation as string;
}

test('job files mentioned only before this preparation do not block its first start: the same report re-prepared', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
  Object.assign(batch.state, { running: true, treeExited: false, idle: true, ready: true });
  const first = await startStageRun({ ...paths, operation: batch.operation, reference: '开始第一批' });
  const earlier = fromNow(-600);
  await batch.core([...copilotStart(earlier, { files: batch.files }), ...attempt(earlier + 10, 0, batch.files[0]!, 'three-star'), ...attempt(earlier + 50, 1, batch.files[1]!, 'three-star'),
    ...attempt(earlier + 90, 2, batch.files[2]!, 'three-star'), ...chainEnd(earlier + 130, 'TaskChainCompleted')]);
  assert.equal((await observe({ batch, paths, runId: first.runId })).execution, 'completed');
  const report = matchStageJobs(stageSnapshot(), runTables, runRequest, runJobs());
  assert.equal(report.hash, batch.reportHash, 'the same report writes the same job file paths');
  const selections = [{ stageId: 'synthetic_01', primary: 1, alternates: [2], loops: 2 }, { stageId: 'synthetic_02', primary: 4, alternates: [], loops: 1 }];
  const again = await prepareAgain(batch, report, selections);
  assert.equal((await startStageRun({ ...paths, operation: again, reference: '再跑一批' })).retryOf, null);
  const third = await prepareAgain(batch, report, selections);
  await batch.core(copilotStart(fromNow(60), { files: batch.files }));
  await assert.rejects(startStageRun({ ...paths, operation: third, reference: '第三批' }), /batch-may-have-run/, 'a submission after this preparation still refuses');
});

test('two batches sharing one job file (normal and raid): the second batch starts after the first was tracked', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
  const request = { stages: [{ stageId: 'synthetic_01', code: 'SYN-1', difficulty: 'normal' as const, loops: 1 }, { stageId: 'synthetic_01#f#', code: 'SYN-1', difficulty: 'raid' as const, loops: 1 }],
    completions: { synthetic_00: 'PASS' as const, synthetic_01: 'COMPLETE' as const }, completionEvidence: '合成用户确认前置通过', maaVersion: 'v6.21.4' };
  const report = matchStageJobs(stageSnapshot(), stageTables, request, [stageJob(7, 3)]);
  const normal = await prepareAgain(batch, report, [{ stageId: 'synthetic_01', primary: 7, alternates: [], loops: 1 }]);
  const run = await startStageRun({ ...paths, operation: normal, reference: '开始普通难度' });
  const file = approvedJobFile(batch.privateDirectory, report.hash, 7), earlier = fromNow(-600);
  await batch.core([...copilotStart(earlier, { files: [file] }), ...attempt(earlier + 10, 0, file, 'three-star'), ...chainEnd(earlier + 50, 'TaskChainCompleted')]);
  assert.equal((await observe({ batch, paths, runId: run.runId })).execution, 'completed');
  const raid = await prepareAgain(batch, report, [{ stageId: 'synthetic_01#f#', primary: 7, alternates: [], loops: 1 }]);
  assert.equal((await startStageRun({ ...paths, operation: raid, reference: '开始突袭' })).retryOf, null);
});

test('a job file submission whose time cannot be read counts as after the preparation', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  const unreadable = copilotStart(0, { files: batch.files })[0]!.replace(/^\[[^\]]+\]/, '[not-a-time]');
  await batch.core([unreadable]);
  await assert.rejects(startStageRun({ maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory, operation: batch.operation, reference: '开始' }), /batch-may-have-run/);
});

test('a late report of manual play or a manual login turns the last job-type result into an environment failure', async t => {
  const c = await context(t);
  await c.batch.core([...copilotStart(0, { files: c.batch.files }), ...attempt(10, 0, c.batch.files[0]!, 'wait-exceeded'), ...chainEnd(45, 'TaskChainError')]);
  assert.equal((await observe(c)).stages[0]!.result, 'timeout');
  const after = await observeStageRun({ ...c.paths, runId: c.runId, userReport: { kind: 'manual-login', quote: '合成用户：刚才我在手机上登录了，把 MAA 顶下线了' } }, c.batch.maa);
  assert.deepEqual(after.stages[0]!.attempts.map(item => [item.result, item.note]), [['unknown', 'user-report:manual-login']]);
  assert.equal(after.stages[0]!.result, 'unknown');
  assert.deepEqual(after.environment.map(item => item.category), ['manual-login']);
  assert.equal(after.next, 'verify');
});

/**
 * Ticket 17 review round 1 (P1): runs done per stage are the latest user statement plus the 3-star runs proven in runs
 * started after it, and never fewer than the batch's proven 3-star runs. Both consumers use that one count: the alternate
 * switch (runs written) and the retry start (entries still ticked). SYN-1 is approved 3 times; run 1 ends unknown in
 * battle and the user states 1 done; the retry clears SYN-1 once more, then its next item fails or disconnects.
 */
async function statedThenProven(t: test.TestContext, lastItem: 'failed' | 'disconnect' | null) {
  const batch = await preparedBatch(3); t.after(() => batch.dispose());
  Object.assign(batch.state, { running: true, treeExited: false, idle: true, ready: true });
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory }, files = batch.files, t0 = fromNow(-900), t1 = fromNow(-300);
  const first = await startStageRun({ ...paths, operation: batch.operation, reference: '开始' });
  const c: Context = { batch, paths, runId: first.runId };
  await batch.core([...copilotStart(t0, { files }), ...attempt(t0 + 10, 0, files[0]!, 'open', [connection(t0 + 20, 'Disconnect')]), ...chainEnd(t0 + 21, 'TaskChainError')]);
  await observe(c); assert.equal((await verify(c)).next, 'ask-progress');
  await recordStageProgress({ ...paths, runId: first.runId, reference: '用户：断连那一把打完了，三星', stages: [{ stageId: 'synthetic_01', completedRuns: 1 }] });
  await decideStageRun({ ...paths, runId: first.runId, decision: 'retry-within-approval', reason: '用户说明 SYN-1 完成一次' });
  const file = join(batch.maaDirectory, 'config/gui.new.json'), config = JSON.parse(await readFile(file, 'utf8'));
  config.Configurations['Synthetic profile'].Copilot.TaskList[0].IsChecked = false;
  await writeFile(file, JSON.stringify(config));
  const second = await startStageRun({ ...paths, operation: batch.operation, reference: '重新点开始', retryOf: first.runId });
  const retry: Context = { ...c, runId: second.runId };
  if (!lastItem) return { first: c, retry, file };
  const third = core(t1 + 60, 'SubTaskExtraInfo', { ...chain(1), class: 'asst::MultiCopilotTaskPlugin', what: 'CopilotListLoadTaskFileSuccess',
    details: { stage_name: 'synthetic', file_name: files[2], id: 2 } });
  const last = lastItem === 'failed' ? attempt(t1 + 60, 2, files[2]!, 'failed') : [third, connection(t1 + 62, 'Disconnect')];
  await batch.core(retag([...copilotStart(t1, { files: files.slice(1) }), ...attempt(t1 + 10, 1, files[1]!, 'three-star'), ...last, ...chainEnd(t1 + 100, 'TaskChainError')], 2));
  return { first: c, retry, file };
}
test('runs done = the latest statement plus 3-star runs proven after it, for both the switch and the retry start (ticket 17 review)', async t => {
  const consumers: { name: string; lastItem: 'failed' | 'disconnect'; check(context: Awaited<ReturnType<typeof statedThenProven>>): Promise<void> }[] = [
    { name: 'switch writes only the runs left', lastItem: 'failed', check: async ({ retry }) => {
      await observe(retry);
      await decideStageRun({ ...retry.paths, runId: retry.runId, decision: 'switch-alternate', reason: 'MAA 报告 SYN-1 作战失败' });
      const switched = await switchStageRun({ ...await switchRequest(retry), runId: retry.runId }, retry.batch.maa);
      assert.deepEqual(switched.runs[0], { stageId: 'synthetic_01', job: 2, runs: 1 }, '3 approved - (1 stated + 1 proven after it)');
    } },
    { name: 'retry start allows only the runs left ticked', lastItem: 'disconnect', check: async ({ retry, file }) => {
      await observe(retry);
      assert.ok((await verify(retry)).allowedDecisions.includes('retry-within-approval'));
      await decideStageRun({ ...retry.paths, runId: retry.runId, decision: 'retry-within-approval', reason: '没进战斗就断连，已核对' });
      await assert.rejects(startStageRun({ ...retry.paths, operation: retry.batch.operation, reference: '再点开始', retryOf: retry.runId }), /finished-items-ticked/,
        'items 1 and 2 still ticked, but only 3 - (1 + 1) = 1 run is left');
      const config = JSON.parse(await readFile(file, 'utf8'));
      config.Configurations['Synthetic profile'].Copilot.TaskList[1].IsChecked = false;
      await writeFile(file, JSON.stringify(config));
      assert.equal((await startStageRun({ ...retry.paths, operation: retry.batch.operation, reference: '取消勾选了打完的', retryOf: retry.runId })).retryOf, retry.runId);
    } },
  ];
  for (const consumer of consumers) await t.test(consumer.name, async sub => consumer.check(await statedThenProven(sub, consumer.lastItem)));
});
test('a progress statement is refused while a later run of the batch is still tracking', async t => {
  const { first } = await statedThenProven(t, null);
  await assert.rejects(recordStageProgress({ ...first.paths, runId: first.runId, reference: '用户：又打完一次', stages: [{ stageId: 'synthetic_01', completedRuns: 2 }] }),
    /run-unresolved/);
});

/**
 * Ticket 17 review round 2 (P2, same class as round 1's P1): runs done per stage never go down. A new statement is the
 * total so far, so it may not be lower than the runs already recorded (the previous statement plus the 3-stars MAA proved
 * since); only 3-stars in records started after it are added. Dimension: a second statement lower, equal or higher than
 * the current count, given before or after an intervening proven 3-star. Every consumer: the progress gate, the summary
 * (both records), the retryOf tick limit and the switch's remaining runs. SYN-1 is approved 3 times; the first statement is 1.
 */
type Timing = 'before' | 'after';
const secondCases: { timing: Timing; level: string; second: number; accepted: boolean; done: number }[] = [
  { timing: 'before', level: 'lower', second: 0, accepted: false, done: 1 },
  { timing: 'before', level: 'equal', second: 1, accepted: true, done: 1 },
  { timing: 'before', level: 'higher', second: 2, accepted: true, done: 2 },
  { timing: 'after', level: 'lower', second: 1, accepted: false, done: 2 },
  { timing: 'after', level: 'equal', second: 2, accepted: true, done: 2 },
  { timing: 'after', level: 'higher', second: 3, accepted: true, done: 3 },
];
async function secondStatement(t: test.TestContext, timing: Timing, second: number) {
  const batch = await preparedBatch(3); t.after(() => batch.dispose());
  Object.assign(batch.state, { running: true, treeExited: false, idle: true, ready: true });
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory }, files = batch.files, t0 = fromNow(-900), t1 = fromNow(-600);
  const configFile = join(batch.maaDirectory, 'config/gui.new.json');
  /** Ticks exactly the last `count` SYN-1 entries (indexes 0-2); SYN-2 stays ticked. */
  const tick = async (count: number) => {
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.Configurations['Synthetic profile'].Copilot.TaskList.forEach((item: { IsChecked: boolean }, index: number) => { if (index < 3) item.IsChecked = index >= 3 - count; });
    await writeFile(configFile, JSON.stringify(config));
  };
  const first: Context = { batch, paths, runId: (await startStageRun({ ...paths, operation: batch.operation, reference: '开始' })).runId };
  await batch.core([...copilotStart(t0, { files }), ...attempt(t0 + 10, 0, files[0]!, 'open', [connection(t0 + 20, 'Disconnect')]), ...chainEnd(t0 + 21, 'TaskChainError')]);
  await observe(first); await verify(first);
  await recordStageProgress({ ...paths, runId: first.runId, reference: '用户：第一次说明，打完 1 次', stages: [{ stageId: 'synthetic_01', completedRuns: 1 }] });
  let last = first;
  if (timing === 'after') {
    await decideStageRun({ ...paths, runId: first.runId, decision: 'retry-within-approval', reason: '用户说明完成一次' });
    await tick(2);
    last = { ...first, runId: (await startStageRun({ ...paths, operation: batch.operation, reference: '重新点开始', retryOf: first.runId })).runId };
    await batch.core(retag([...copilotStart(t1, { files: files.slice(1) }), ...attempt(t1 + 10, 1, files[1]!, 'three-star'),
      ...attempt(t1 + 60, 2, files[2]!, 'open', [connection(t1 + 70, 'Disconnect')]), ...chainEnd(t1 + 71, 'TaskChainError')], 2));
    await observe(last); assert.equal((await verify(last)).next, 'ask-progress');
  }
  const outcome = await recordStageProgress({ ...paths, runId: last.runId, reference: `用户：第二次说明，打完 ${second} 次`,
    stages: [{ stageId: 'synthetic_01', completedRuns: second }] }).then(() => 'accepted', (error: Error) => error.message);
  return { batch, paths, first, last, outcome, tick, files };
}
test('runs done never go down: a second statement lower, equal or higher, before or after a proven 3-star, for every consumer (ticket 17 review 2)', async t => {
  for (const item of secondCases) {
    const name = `${item.timing} a proven 3-star, ${item.level} (${item.second})`, stated = item.accepted ? item.second : 1;
    await t.test(`${name}: progress gate, summary and retry tick limit`, async sub => {
      const s = await secondStatement(sub, item.timing, item.second);
      assert.equal(s.outcome, item.accepted ? 'accepted' : 'progress-contradicts-evidence');
      for (const record of [s.first, s.last]) {
        const summary = await observe(record);
        assert.deepEqual([summary.runsDone[0]!.done, summary.runsDone[0]!.statement?.runs], [item.done, stated], `summary of ${record === s.first ? 'the first' : 'the last'} record`);
      }
      const retryOf = s.last.runId;
      const decided = decideStageRun({ ...s.paths, runId: retryOf, decision: 'retry-within-approval', reason: '已核对' });
      if (item.timing === 'after' && !item.accepted) { await assert.rejects(decided, /decision-not-allowed/, 'the retry run is still unresolved'); return; }
      await decided;
      const limit = 3 - item.done;
      await s.tick(limit + 1);
      await assert.rejects(startStageRun({ ...s.paths, operation: s.batch.operation, reference: '多勾了一项', retryOf }), /finished-items-ticked/, `limit ${limit}`);
      await s.tick(limit);
      assert.equal((await startStageRun({ ...s.paths, operation: s.batch.operation, reference: '勾选正好', retryOf })).retryOf, retryOf);
    });
    await t.test(`${name}: switch remaining runs`, async sub => {
      const s = await secondStatement(sub, item.timing, item.second);
      let source = s.last, expected = 3 - item.done;
      if (item.timing === 'before') {
        await decideStageRun({ ...s.paths, runId: s.first.runId, decision: 'retry-within-approval', reason: '已核对' });
        const count = 3 - item.done, t2 = fromNow(-300);
        await s.tick(count);
        source = { ...s.first, runId: (await startStageRun({ ...s.paths, operation: s.batch.operation, reference: '重新点开始', retryOf: s.first.runId })).runId };
        const lines = count >= 2 ? [...attempt(t2 + 10, 1, s.files[1]!, 'three-star'), ...attempt(t2 + 60, 2, s.files[2]!, 'failed')] : attempt(t2 + 10, 2, s.files[2]!, 'failed');
        await s.batch.core(retag([...copilotStart(t2, { files: s.files.slice(3 - count) }), ...lines, ...chainEnd(t2 + 100, 'TaskChainError')], 2));
        await observe(source);
        expected = 3 - item.done - (count >= 2 ? 1 : 0);
      } else await verify(source);
      const decided = decideStageRun({ ...s.paths, runId: source.runId, decision: 'switch-alternate', reason: '换备选' });
      if (!item.accepted && item.timing === 'after' || expected < 1) { await assert.rejects(decided, /decision-not-allowed/, `nothing to switch (${expected} left)`); return; }
      await decided;
      const switched = await switchStageRun({ ...await switchRequest(source), runId: source.runId }, s.batch.maa);
      assert.deepEqual(switched.runs[0], { stageId: 'synthetic_01', job: 2, runs: expected });
    });
  }
});
