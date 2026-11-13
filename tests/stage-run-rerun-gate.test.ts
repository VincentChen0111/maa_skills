import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decideStageRun, observeStageRun, recordStageProgress, startStageRun, verifyStageRun } from '../skills/maa-core/scripts/stage-run.ts';
import { attempt, chainEnd, connection, copilotStart, core, gui, preparedBatch, type PreparedBatch } from './fixtures/stage-run-data.ts';

/**
 * Conformance for the one re-run gate (`rerunGate` in stage-run-state.ts): every entry point that could lead to fighting
 * the batch again (offered decisions, decide, start without and with retryOf) must refuse while an attempt may have
 * entered battle and its outcome is unknown, and must agree with each other in the one allowed case.
 */
const chain = { taskchain: 'Copilot', taskid: 1 };
const loaded = (second: number, file: string) => core(second, 'SubTaskExtraInfo', { ...chain, class: 'asst::MultiCopilotTaskPlugin', what: 'CopilotListLoadTaskFileSuccess', details: { stage_name: 'synthetic', file_name: file, id: 0 } });
const endOfAction = (second: number) => core(second, 'SubTaskStart', { ...chain, class: 'asst::ProcessTask', subtask: 'ProcessTask', details: { task: 'Copilot@EndOfAction' } });
type Case = { name: string; allowed: boolean; run(batch: PreparedBatch, observe: () => Promise<unknown>): Promise<void> };
const cases: Case[] = [
  { name: 'settlement screen reached, then disconnect', allowed: false, run: async batch => {
    await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'open', [endOfAction(80), connection(81, 'Reconnecting'), connection(85, 'Disconnect')]),
      ...chainEnd(86, 'TaskChainError')]);
  } },
  { name: 'MAA process gone mid-battle', allowed: false, run: async (batch, observe) => {
    await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'open')]);
    Object.assign(batch.state, { running: false, treeExited: true, ready: false });
    await observe();
    Object.assign(batch.state, { running: true, treeExited: false, ready: true });
  } },
  { name: 'taken over mid-battle', allowed: false, run: async batch => {
    await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'open')]);
    await batch.gui([gui(100, 'Scheduled start: Timer Index: 1'), gui(101, 'Not idle, Stop and CloseDown')]);
    await batch.core([core(102, 'TaskChainStopped', chain), core(103, 'TaskChainStart', { taskchain: 'CloseDown', taskid: 2 })]);
  } },
  { name: 'log gap over the run', allowed: false, run: async (batch, observe) => {
    await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'three-star')]);
    await observe();
    await writeFile(join(batch.maaDirectory, 'debug/asst.log'), '');
    await batch.core([...attempt(60, 1, batch.files[1]!, 'open', [connection(80, 'Disconnect')]), ...chainEnd(81, 'TaskChainError')]);
  } },
  { name: 'environment failure before battle', allowed: true, run: async batch => {
    await batch.core([...copilotStart(0, { files: batch.files }), loaded(10, batch.files[0]!), connection(12, 'Disconnect'), ...chainEnd(13, 'TaskChainError')]);
  } },
];

test('every re-run entry point refuses while an outcome is unknown and agrees in the allowed case', async t => {
  for (const item of cases) {
    const batch = await preparedBatch(); t.after(() => batch.dispose());
    Object.assign(batch.state, { running: true, treeExited: false, ready: true });
    const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
    const { runId } = await startStageRun({ ...paths, operation: batch.operation, reference: '开始' });
    const observe = () => observeStageRun({ ...paths, runId }, batch.maa);
    await item.run(batch, observe);
    const observed = await observe();
    assert.notEqual(observed.execution, 'tracking', item.name);
    const verified = await verifyStageRun({ ...paths, runId }, batch.maa);
    assert.equal(verified.verification.clear, true, item.name);
    assert.deepEqual(verified.allowedDecisions, item.allowed ? ['retry-within-approval', 'switch-alternate', 'stop-and-tell-user'] : ['stop-and-tell-user'], item.name);
    await assert.rejects(startStageRun({ ...paths, operation: batch.operation, reference: '重新开始' }), /run-unresolved/, item.name);
    if (!item.allowed) {
      for (const decision of ['retry-within-approval', 'switch-alternate'] as const) {
        await assert.rejects(decideStageRun({ privateDirectory: batch.privateDirectory, runId, decision, reason: '想再打一次' }), /decision-not-allowed/, `${item.name} ${decision}`);
      }
      await assert.rejects(startStageRun({ ...paths, operation: batch.operation, reference: '重试', retryOf: runId }), /retry-not-decided/, item.name);
      continue;
    }
    await decideStageRun({ privateDirectory: batch.privateDirectory, runId, decision: 'retry-within-approval', reason: '没进战斗就断连，连接已恢复' });
    const retry = await startStageRun({ ...paths, operation: batch.operation, reference: '用户再点开始', retryOf: runId });
    assert.equal(retry.retryOf, runId);
    await assert.rejects(startStageRun({ ...paths, operation: batch.operation, reference: '再重试', retryOf: runId }), /run-unresolved|retry-not-decided/);
  }
});

test('an unknown battle outcome reopens retry only after the user states the stage progress', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  Object.assign(batch.state, { running: true, treeExited: false, ready: true });
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
  const { runId } = await startStageRun({ ...paths, operation: batch.operation, reference: '开始' });
  await cases[0]!.run(batch, async () => undefined);
  await observeStageRun({ ...paths, runId }, batch.maa);
  const verified = await verifyStageRun({ ...paths, runId }, batch.maa);
  assert.equal(verified.next, 'ask-progress');
  await assert.rejects(recordStageProgress({ privateDirectory: batch.privateDirectory, runId, reference: '打了', stages: [{ stageId: 'synthetic_01', completedRuns: 3 }] }), /progress-invalid/);
  const stated = await recordStageProgress({ privateDirectory: batch.privateDirectory, runId, reference: '合成用户：SYN-1 第一次已经三星打完了', stages: [{ stageId: 'synthetic_01', completedRuns: 1 }] });
  assert.deepEqual(stated.allowedDecisions, ['retry-within-approval', 'switch-alternate', 'stop-and-tell-user']);
  assert.equal(stated.next, 'decide');
  assert.deepEqual(stated.progress.map(item => item.stages), [[{ stageId: 'synthetic_01', completedRuns: 1 }]]);
});

test('start is refused while another record of the batch is still tracking; a run closed before its chain started can be restarted', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
  const first = await startStageRun({ ...paths, operation: batch.operation, reference: '开始' });
  await assert.rejects(startStageRun({ ...paths, operation: batch.operation, reference: '又说一次开始' }), /run-unresolved/);
  const closed = await decideStageRun({ ...paths, runId: first.runId, decision: 'stop-and-tell-user', reason: '用户还没点开始，先不跟踪' });
  assert.equal(closed.execution, 'unknown'); assert.equal(closed.executionReason, 'closed-before-start');
  await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'open')]);
  assert.equal((await observeStageRun({ ...paths, runId: first.runId }, batch.maa)).stages[0]!.attempts.length, 0, 'a closed record does not pick up a later chain');
  const fresh = await batch.dispose().then(() => preparedBatch());
  t.after(() => fresh.dispose());
  const freshPaths = { maaDirectory: fresh.maaDirectory, privateDirectory: fresh.privateDirectory };
  const taken = await startStageRun({ ...freshPaths, operation: fresh.operation, reference: '开始' });
  await fresh.gui([gui(5, 'Scheduled start: Timer Index: 0')]);
  await fresh.core([core(6, 'TaskChainStart', { taskchain: 'Fight', taskid: 1 })]);
  assert.equal((await observeStageRun({ ...freshPaths, runId: taken.runId }, fresh.maa)).takeover?.source, 'native-schedule');
  const again = await startStageRun({ ...freshPaths, operation: fresh.operation, reference: '日常跑完了，现在点开始' });
  assert.equal(again.retryOf, null);
});

test('a late report of manual play or a manual login turns the last job-type result into an environment failure', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  Object.assign(batch.state, { running: true, treeExited: false, ready: true });
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
  const { runId } = await startStageRun({ ...paths, operation: batch.operation, reference: '开始' });
  await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'wait-exceeded'), ...chainEnd(45, 'TaskChainError')]);
  assert.equal((await observeStageRun({ ...paths, runId }, batch.maa)).stages[0]!.result, 'timeout');
  const after = await observeStageRun({ ...paths, runId, userReport: { kind: 'manual-login', quote: '合成用户：刚才我在手机上登录了，把 MAA 顶下线了' } }, batch.maa);
  assert.deepEqual(after.stages[0]!.attempts.map(item => [item.result, item.note]), [['unknown', 'user-report:manual-login']]);
  assert.equal(after.stages[0]!.result, 'unknown');
  assert.deepEqual(after.environment.map(item => item.category), ['manual-login']);
  assert.equal(after.next, 'verify');
});
