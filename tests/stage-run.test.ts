import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { observeStageRun, readStageRun, startStageRun, verifyStageRun, decideStageRun, summarizeStageRun } from '../skills/maa-core/scripts/stage-run.ts';
import { attempt, chainEnd, connection, copilotStart, core, drops, gui, medicineConfirm, medicineUsed, offlinePopup, preparedBatch, syntheticAdb, syntheticDevice, type PreparedBatch }
  from './fixtures/stage-run-data.ts';

async function tracked(t: test.TestContext) {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  Object.assign(batch.state, { running: true, treeExited: false, idle: true, ready: true });
  const started = await startStageRun({ maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory, operation: batch.operation, reference: '合成用户：我现在点开始' });
  return { batch, runId: started.runId, observe: (extra: Record<string, unknown> = {}) =>
    observeStageRun({ maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory, runId: started.runId, ...extra }, batch.maa) };
}
const run = (batch: PreparedBatch, outcome: Parameters<typeof attempt>[3]) => [...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, outcome)];
const results = (summary: Awaited<ReturnType<typeof observeStageRun>>) => summary.stages.map(stage => [stage.code, stage.result, stage.attempts.map(item => item.result)]);

test('normal: links batch, stages and run; three 3-star attempts finish as completed and success', async t => {
  const { batch, runId, observe } = await tracked(t);
  const waiting = await observe();
  assert.equal(waiting.execution, 'tracking'); assert.equal(waiting.next, 'keep-observing');
  assert.deepEqual(waiting.batch, { operation: batch.operation, reportHash: batch.reportHash, map: 'synthetic_map',
    stages: [{ stageId: 'synthetic_01', code: 'SYN-1', loops: 2 }, { stageId: 'synthetic_02', code: 'SYN-2', loops: 1 }] });
  assert.deepEqual(results(waiting), [['SYN-1', 'not-evaluated', []], ['SYN-2', 'not-evaluated', []]]);
  await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'three-star'), ...attempt(60, 1, batch.files[1]!, 'three-star'),
    ...attempt(120, 2, batch.files[2]!, 'three-star'), ...chainEnd(180, 'TaskChainCompleted')]);
  await batch.gui([gui(1, 'Start Task Chain: Copilot, Task ID: 1'), gui(180, 'Completed Task Chain: Copilot, Task ID: 1'), gui(181, '完成任务: 自动战斗')]);
  const done = await observe();
  assert.equal(done.execution, 'completed'); assert.equal(done.next, 'report');
  assert.deepEqual(results(done), [['SYN-1', 'success', ['success', 'success']], ['SYN-2', 'success', ['success']]]);
  assert.deepEqual(done.stages.map(stage => stage.stageCheck), ['unknown', 'unknown']);
  assert.deepEqual(done.medicine, { count: 0, approved: 0, unapproved: false, enabledAtStart: false, final: true });
  assert.equal(done.evidence.complete, true); assert.equal(done.gui.verdict, 'completed');
  assert.equal((await readStageRun(batch.privateDirectory, runId)).runId, runId);
  assert.ok(!done.findings.some(finding => finding.kind === 'stage-result'), 'pre-anchor TaskChainError must not count');
});

test('failure, not 3-star and explicit wait timeout keep MAA message names and are reported as soon as they appear', async t => {
  for (const [outcome, expected] of [['failed', 'failed'], ['not-three-star', 'not-three-star'], ['wait-exceeded', 'timeout']] as const) {
    const { batch, observe } = await tracked(t);
    await batch.core(run(batch, outcome));
    const early = await observe();
    assert.equal(early.execution, 'tracking');
    assert.deepEqual(results(early)[0], ['SYN-1', expected, [expected]]);
    const finding = early.newFindings.find(item => item.kind === 'stage-result')!;
    assert.equal(finding.terminal, expected); assert.equal(finding.message, 'SubTaskError'); assert.equal(finding.subtask, 'ProcessTask');
    await batch.core(chainEnd(60, 'TaskChainError'));
    await batch.gui([gui(60, '任务出错: 自动战斗', 'ERR'), gui(60, '战斗出错', 'ERR'), gui(61, '完成任务: 自动战斗')]);
    const done = await observe();
    assert.equal(done.execution, 'failed'); assert.equal(done.gui.verdict, 'error', 'completion marker must not override the error marker');
    assert.deepEqual(results(done), [['SYN-1', expected, [expected]], ['SYN-2', 'unknown', []]]);
    assert.deepEqual(done.stages.map(stage => stage.stageCheck), ['unknown', 'not-fought']);
    assert.ok(!done.newFindings.some(item => item.id === finding.id), 'a finding is reported once');
    assert.deepEqual(done.allowedDecisions, expected === 'timeout' ? ['stop-and-tell-user'] : ['switch-alternate', 'stop-and-tell-user']);
  }
});

test('no sanity needs the recovery popup in callbacks; a bare start error stays unknown, never failure or success', async t => {
  const { batch, observe } = await tracked(t);
  await batch.core([...run(batch, 'no-sanity'), ...chainEnd(20, 'TaskChainError')]);
  const sanity = await observe();
  assert.deepEqual(results(sanity)[0], ['SYN-1', 'no-sanity', ['no-sanity']]); assert.deepEqual(sanity.allowedDecisions, ['stop-and-tell-user']);
  const bare = await tracked(t);
  await bare.batch.core([...run(bare.batch, 'start-error'), ...chainEnd(20, 'TaskChainError')]);
  const unknown = await bare.observe();
  assert.equal(unknown.execution, 'failed'); assert.deepEqual(results(unknown)[0], ['SYN-1', 'unknown', ['unknown']]);
  assert.deepEqual(unknown.allowedDecisions, ['stop-and-tell-user']);
});

test('silence or a quiet log is not failure; a run duration limit with a stop is an explicit timeout', async t => {
  const { batch, observe } = await tracked(t);
  await batch.core(run(batch, 'open'));
  for (let index = 0; index < 2; index++) {
    const quiet = await observe();
    assert.equal(quiet.execution, 'tracking'); assert.deepEqual(results(quiet)[0], ['SYN-1', 'not-evaluated', ['not-evaluated']]);
    assert.ok(!quiet.findings.some(item => item.kind === 'stage-result'));
  }
  await batch.gui([gui(900, 'Run duration limit reached: 15 min, stopping')]);
  await batch.core(chainEnd(901, 'TaskChainStopped'));
  const stopped = await observe();
  assert.equal(stopped.execution, 'failed'); assert.deepEqual(results(stopped)[0], ['SYN-1', 'timeout', ['timeout']]);
  const plainStop = await tracked(t);
  await plainStop.batch.core([...run(plainStop.batch, 'open'), ...chainEnd(40, 'TaskChainStopped')]);
  const manual = await plainStop.observe();
  assert.equal(manual.execution, 'unknown'); assert.deepEqual(results(manual)[0], ['SYN-1', 'unknown', ['unknown']]);
});

test('disconnect is an environment failure: not a stage failure, verified before the model may retry within approval', async t => {
  const { batch, runId, observe } = await tracked(t);
  await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'open', [connection(20, 'Reconnecting'), connection(40, 'Disconnect')]),
    ...chainEnd(41, 'TaskChainError')]);
  const failed = await observe();
  assert.equal(failed.execution, 'failed'); assert.deepEqual(results(failed)[0], ['SYN-1', 'unknown', ['unknown']]);
  assert.deepEqual(failed.environment.map(item => [item.category, item.message, item.what]), [['connection', 'ConnectionInfo', 'Reconnecting'], ['connection', 'ConnectionInfo', 'Disconnect']]);
  assert.deepEqual(Object.keys(failed.environment[1]!.diagnosis).sort(), ['id', 'reason', 'repair', 'status']);
  assert.equal(failed.next, 'verify'); assert.deepEqual(failed.allowedDecisions, ['stop-and-tell-user']);
  await assert.rejects(decideStageRun({ privateDirectory: batch.privateDirectory, runId, decision: 'retry-within-approval', reason: '断连后重试' }), /decision-not-allowed/);
  const verified = await verifyStageRun({ maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory, runId }, batch.maa);
  assert.equal(verified.verification.clear, true); assert.equal(verified.verification.preparedList, 'matches');
  assert.deepEqual(verified.verification.unknown, ['sanity', 'medicine-inventory', 'originium', 'stage-progress']);
  assert.deepEqual(verified.allowedDecisions, ['retry-within-approval', 'switch-alternate', 'stop-and-tell-user']); assert.equal(verified.next, 'decide');
  const decided = await decideStageRun({ privateDirectory: batch.privateDirectory, runId, decision: 'retry-within-approval', reason: '连接已恢复，原批准范围内由用户再点开始' });
  assert.equal(decided.decisions.at(-1)!.decision, 'retry-within-approval');
  const retry = await startStageRun({ maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory, operation: batch.operation, reference: '合成用户：重新点开始', retryOf: runId });
  assert.equal(retry.retryOf, runId);
  await assert.rejects(startStageRun({ maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory, operation: batch.operation, reference: '再来', retryOf: retry.runId }), /retry-not-decided/);
});

test('a manual session kicking MAA off, or the user saying they are playing, is an environment failure and approval-time state is not reused', async t => {
  const { batch, observe } = await tracked(t);
  await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'open', [offlinePopup(30)]), ...chainEnd(31, 'TaskChainError')]);
  const kicked = await observe();
  assert.deepEqual(kicked.environment.map(item => item.category), ['game-session']);
  assert.deepEqual(results(kicked)[0], ['SYN-1', 'unknown', ['unknown']]);
  const told = await tracked(t);
  const playing = await told.observe({ userReport: { kind: 'manual-play', quote: '我刚才在模拟器上自己打了一把' } });
  assert.deepEqual(playing.environment.map(item => [item.category, item.message]), [['manual-play', 'user-report']]);
  assert.equal(playing.next, 'verify');
});

test('exit code 0 never overrides a failure callback; MAA gone without a terminal callback is unknown', async t => {
  const { batch, observe } = await tracked(t);
  await batch.core([...run(batch, 'not-three-star'), ...chainEnd(60, 'TaskChainError')]);
  Object.assign(batch.state, { running: false, treeExited: true, ready: false });
  const exited = await observe({ processExitCode: 0 });
  assert.equal(exited.execution, 'failed'); assert.deepEqual(results(exited)[0], ['SYN-1', 'not-three-star', ['not-three-star']]);
  const gone = await tracked(t);
  await gone.batch.core(run(gone.batch, 'open'));
  Object.assign(gone.batch.state, { running: false, treeExited: true, ready: false });
  const vanished = await gone.observe({ processExitCode: 0 });
  assert.equal(vanished.execution, 'unknown'); assert.deepEqual(vanished.environment.map(item => item.category), ['maa']);
  assert.deepEqual(results(vanished)[0], ['SYN-1', 'unknown', ['unknown']]);
});

test('a rotation mid-run is followed; a log that cannot be connected makes the result and medicine unknown', async t => {
  const { batch, observe } = await tracked(t);
  await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'three-star')]);
  await rename(join(batch.maaDirectory, 'debug/asst.log'), join(batch.maaDirectory, 'debug/asst.bak.log'));
  await batch.core([...attempt(60, 1, batch.files[1]!, 'three-star'), ...attempt(120, 2, batch.files[2]!, 'three-star'), ...chainEnd(180, 'TaskChainCompleted')]);
  const rotated = await observe();
  assert.equal(rotated.execution, 'completed'); assert.equal(rotated.evidence.rotated, true); assert.equal(rotated.evidence.complete, true);
  const broken = await tracked(t);
  await broken.batch.core([...copilotStart(0, { files: broken.batch.files }), ...attempt(10, 0, broken.batch.files[0]!, 'three-star')]);
  await broken.observe();
  await writeFile(join(broken.batch.maaDirectory, 'debug/asst.log'), '');
  await broken.batch.core([...attempt(60, 1, broken.batch.files[1]!, 'three-star'), ...attempt(120, 2, broken.batch.files[2]!, 'three-star'), ...chainEnd(180, 'TaskChainCompleted')]);
  const gap = await broken.observe();
  assert.equal(gap.evidence.complete, false); assert.equal(gap.execution, 'unknown');
  assert.equal(gap.medicine.count, 'unknown'); assert.deepEqual(gap.allowedDecisions, ['stop-and-tell-user']);
  assert.ok(gap.newFindings.some(item => item.kind === 'evidence-gap'));
});

test('completion callbacks with a GUI error marker in the same run are not reported as completed', async t => {
  const { batch, observe } = await tracked(t);
  await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'three-star'), ...attempt(60, 1, batch.files[1]!, 'three-star'),
    ...attempt(120, 2, batch.files[2]!, 'three-star'), ...chainEnd(180, 'TaskChainCompleted')]);
  await batch.gui([gui(170, '任务出错: 自动战斗', 'ERR'), gui(181, '完成任务: 自动战斗')]);
  const conflict = await observe();
  assert.equal(conflict.gui.verdict, 'error'); assert.equal(conflict.execution, 'unknown');
  const startFailure = await tracked(t);
  await startFailure.batch.gui([gui(5, '作业启动失败', 'ERR')]);
  const onlyGui = await startFailure.observe();
  assert.equal(onlyGui.execution, 'unknown'); assert.equal(onlyGui.gui.verdict, 'error');
});

test('a native schedule takeover ends attribution: later callbacks are not counted and the result is unknown', async t => {
  const { batch, observe } = await tracked(t);
  await batch.core(run(batch, 'three-star'));
  await batch.gui([gui(100, 'Scheduled start: Timer Index: 2'), gui(101, 'Not idle, Stop and CloseDown')]);
  await batch.core([core(102, 'TaskChainStopped', { taskchain: 'Copilot', taskid: 1 }), core(103, 'TaskChainStart', { taskchain: 'CloseDown', taskid: 2 }),
    core(200, 'TaskChainStart', { taskchain: 'Fight', taskid: 3 }), medicineUsed(210, 6)]);
  const taken = await observe();
  assert.equal(taken.execution, 'unknown'); assert.equal(taken.takeover?.source, 'native-schedule');
  assert.deepEqual(results(taken)[0], ['SYN-1', 'unknown', ['success']]);
  assert.equal(taken.medicine.count, 'unknown'); assert.deepEqual(taken.allowedDecisions, ['stop-and-tell-user']);
  const other = await tracked(t);
  await other.batch.core([...run(other.batch, 'open'), core(50, 'TaskChainStart', { taskchain: 'Fight', taskid: 2 })]);
  assert.equal((await other.observe()).takeover?.source, 'other-task-chain');
});

test('stage check uses only drop callbacks: match, mismatch, not fought or unknown', async t => {
  const { batch, observe } = await tracked(t);
  await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'three-star', [drops(30, 'synthetic_01', 'SYN-1')]),
    ...attempt(60, 1, batch.files[1]!, 'three-star', [drops(80, 'synthetic_01', 'SYN-1')]), ...attempt(120, 2, batch.files[2]!, 'three-star', [drops(140, 'other_stage', 'OTH-1')]),
    ...chainEnd(180, 'TaskChainCompleted')]);
  assert.deepEqual((await observe()).stages.map(stage => stage.stageCheck), ['match', 'mismatch']);
});

test('medicine reported by MAA is summed and is unapproved; unreadable usage is unknown, never 0', async t => {
  const { batch, observe } = await tracked(t);
  await batch.core([...copilotStart(0, { files: batch.files, medicine: true }), ...attempt(10, 0, batch.files[0]!, 'three-star', [medicineConfirm(12), medicineUsed(13, 2), medicineConfirm(14), medicineUsed(15, 1)])]);
  const used = await observe();
  assert.deepEqual(used.medicine, { count: 3, approved: 0, unapproved: true, enabledAtStart: true, final: false });
  assert.ok(used.newFindings.some(item => item.kind === 'medicine'));
  await batch.core(chainEnd(200, 'TaskChainError'));
  assert.deepEqual((await observe()).allowedDecisions, ['stop-and-tell-user']);
  for (const lines of [[medicineConfirm(12)], [medicineUsed(13, 'two')]]) {
    const unknown = await tracked(t);
    await unknown.batch.core([...copilotStart(0, { files: unknown.batch.files, medicine: true }), ...attempt(10, 0, unknown.batch.files[0]!, 'three-star', lines), ...chainEnd(100, 'TaskChainError')]);
    const summary = await unknown.observe();
    assert.equal(summary.medicine.count, 'unknown'); assert.equal(summary.medicine.unapproved, 'unknown');
  }
});

test('run record and summaries keep paths only for MAA debug images and never device ids, connection details or job paths', async t => {
  const { batch, runId, observe } = await tracked(t);
  await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'open', [connection(20, 'Disconnect')]), ...chainEnd(41, 'TaskChainError')]);
  const { mkdir, utimes } = await import('node:fs/promises');
  await mkdir(join(batch.maaDirectory, 'debug/interface'), { recursive: true }); await mkdir(join(batch.maaDirectory, 'debug/drops'), { recursive: true });
  await writeFile(join(batch.maaDirectory, 'debug/interface/failure.png'), 'not really an image');
  await writeFile(join(batch.maaDirectory, 'debug/drops/old.png'), 'older');
  await utimes(join(batch.maaDirectory, 'debug/drops/old.png'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const summary = await observe();
  assert.deepEqual(summary.screenshots, ['debug/interface/failure.png']);
  const record = await readFile(join(batch.privateDirectory, 'stage-runs', `${runId}.json`), 'utf8');
  for (const text of [JSON.stringify(summary), record, JSON.stringify(summarizeStageRun(await readStageRun(batch.privateDirectory, runId)))]) {
    for (const secret of [syntheticDevice, syntheticAdb.address, syntheticAdb.config, batch.files[0]!, batch.privateDirectory, batch.maaDirectory, 'Synthetic profile']) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
  }
});

test('a copilot run started without list mode is not attributed to the approved batch', async t => {
  const { batch, observe } = await tracked(t);
  await batch.core([...copilotStart(0, { singleFile: true }), ...chainEnd(60, 'TaskChainCompleted')]);
  const single = await observe();
  assert.equal(single.execution, 'unknown'); assert.equal(single.executionReason, 'list-mismatch');
  assert.deepEqual(single.allowedDecisions, ['stop-and-tell-user']);
  assert.ok(single.newFindings.some(item => item.kind === 'list-mismatch' && item.detail === 'not-list-mode'));
});
