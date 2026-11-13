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
    const stated = await recordStageProgress({ privateDirectory: c.paths.privateDirectory, runId: c.runId, reference: '用户：每关都打满了', stages: fullProgress });
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
    const stated = await recordStageProgress({ privateDirectory: c.paths.privateDirectory, runId: c.runId, reference: '用户：SYN-1 打完一次，就是失败的那次', stages: [{ stageId: 'synthetic_01', completedRuns: 1 }] });
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
  await assert.rejects(recordStageProgress({ privateDirectory: c.paths.privateDirectory, runId: c.runId, reference: '用户：一次都没打完', stages: [{ stageId: 'synthetic_01', completedRuns: 0 }] }),
    /progress-contradicts-evidence/);
  const stated = await recordStageProgress({ privateDirectory: c.paths.privateDirectory, runId: c.runId, reference: '用户：SYN-1 结算过一次', stages: [{ stageId: 'synthetic_01', completedRuns: 1 }] });
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
