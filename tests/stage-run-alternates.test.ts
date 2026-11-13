import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectConfiguration } from '../skills/maa-core/scripts/maa-config.ts';
import { approvedJobFile, approvedJobList, type ApprovedJobPlan } from '../skills/maa-core/scripts/stage-job-plan.ts';
import { decideStageRun, observeStageRun, readStageRun, startStageRun, switchStageRun, verifyStageRun } from '../skills/maa-core/scripts/stage-run.ts';
import { attempt, chainEnd, connection, copilotStart, preparedBatch, type PreparedBatch } from './fixtures/stage-run-data.ts';

const pendingPlan = async (privateDirectory: string, operation: string): Promise<ApprovedJobPlan> => {
  const lines = (await readFile(join(privateDirectory, 'daily-pending.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  return lines.find(entry => entry.id === operation).authorization.jobPlan;
};
const key = 'a'.repeat(64), from = { operation: '6f3d8a52-0c1e-4b7a-9d2f-1a2b3c4d5e6f', runId: '6a0f4c1e-2b3d-4e5f-8a9b-0c1d2e3f4a51', key };

test('a continuation expands only approved jobs of each stage, in plan order, never more runs than approved', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  const plan = await pendingPlan(batch.privateDirectory, batch.operation);
  const continued: ApprovedJobPlan = { ...plan, continuation: { from, stages: [{ stageId: 'synthetic_01', job: 2, runs: 2 }, { stageId: 'synthetic_02', job: 4, runs: 1 }] } };
  const list = approvedJobList(continued, batch.privateDirectory);
  assert.deepEqual(list.map(item => [item.Name, item.CopilotId, item.Index, item.IsChecked]), [['SYN-1', 2, 0, true], ['SYN-1', 2, 1, true], ['SYN-2', 4, 2, true]]);
  assert.equal(list[0]!.FilePath, approvedJobFile(batch.privateDirectory, batch.reportHash, 2));
  const finished = approvedJobList({ ...plan, continuation: { from, stages: [{ stageId: 'synthetic_02', job: 4, runs: 1 }] } }, batch.privateDirectory);
  assert.deepEqual(finished.map(item => [item.Name, item.CopilotId, item.Index]), [['SYN-2', 4, 0]], 'a stage with nothing left drops out of the list');
  for (const stages of [[{ stageId: 'synthetic_01', job: 4, runs: 1 }], [{ stageId: 'synthetic_01', job: 3, runs: 1 }], [{ stageId: 'synthetic_01', job: 2, runs: 3 }],
    [{ stageId: 'synthetic_01', job: 2, runs: 0 }], [{ stageId: 'synthetic_03', job: 2, runs: 1 }], [], [{ stageId: 'synthetic_01', job: 2, runs: 1 }, { stageId: 'synthetic_01', job: 1, runs: 1 }]]) {
    assert.throws(() => approvedJobList({ ...plan, continuation: { from, stages } }, batch.privateDirectory), /job-plan-invalid/, JSON.stringify(stages));
  }
});

/** Fixture log seconds relative to now (the fixture's clock starts at 2026-11-13 02:00 UTC). */
const fromNow = (seconds: number) => Math.floor((Date.now() - Date.UTC(2026, 10, 13, 2, 0, 0)) / 1000) + seconds;
const retag = (lines: string[], taskid: number) => lines.map(line => line.replace(/"taskid":1([,}])/g, `"taskid":${taskid}$1`).replace('task_id: 1', `task_id: ${taskid}`));
/** A Fight task with medicine, stone and expiring-medicine fields: a switch must leave every byte of it alone. */
const fight = { TaskType: 'Fight', IsEnable: true, UseMedicine: true, MedicineCount: 2, UseStone: false, StoneCount: 0, UseExpireMedicine: false, Stage1: '1-7' };
type Tracked = { batch: PreparedBatch; paths: { maaDirectory: string; privateDirectory: string }; runId: string };
async function tracked(t: test.TestContext): Promise<Tracked> {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  Object.assign(batch.state, { running: true, treeExited: false, idle: true, ready: true });
  const file = join(batch.maaDirectory, 'config/gui.new.json'), config = JSON.parse(await readFile(file, 'utf8'));
  config.Configurations['Synthetic profile'].TaskQueue = [fight];
  await writeFile(file, JSON.stringify(config));
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
  const { runId } = await startStageRun({ ...paths, operation: batch.operation, reference: '合成用户：我现在点开始' });
  return { batch, paths, runId };
}
const observe = (c: Tracked, runId = c.runId) => observeStageRun({ ...c.paths, runId }, c.batch.maa);
const revision = async (c: Tracked) => (await inspectConfiguration(c.batch.maaDirectory)).revision;
const profile = async (c: Tracked) => JSON.parse(await readFile(join(c.batch.maaDirectory, 'config/gui.new.json'), 'utf8')).Configurations['Synthetic profile'];
const switchRequest = async (c: Tracked, runId = c.runId) => ({ ...c.paths, runId, stageId: 'synthetic_01', expectedRevision: await revision(c), host: 'claude' as const });

test('a MAA-reported failure switches to the next approved alternate through the unified writer; the alternate then finishes the batch', async t => {
  const c = await tracked(t), t0 = fromNow(-600);
  await c.batch.core([...copilotStart(t0, { files: c.batch.files }), ...attempt(t0 + 10, 0, c.batch.files[0]!, 'failed'), ...chainEnd(t0 + 60, 'TaskChainError')]);
  const failed = await observe(c);
  assert.deepEqual(failed.allowedDecisions, ['switch-alternate', 'stop-and-tell-user']);
  assert.equal(failed.next, 'decide');
  assert.deepEqual(failed.alternates, [{ stageId: 'synthetic_01', job: 1, next: 2, left: 1 }, { stageId: 'synthetic_02', job: 4, next: null, left: 0 }]);
  await assert.rejects(switchStageRun(await switchRequest(c), c.batch.maa), /switch-not-decided/);
  const decided = await decideStageRun({ ...c.paths, runId: c.runId, decision: 'switch-alternate', reason: 'MAA 报告 SYN-1 作战失败，按批准顺序换备选 2' });
  assert.equal(decided.next, 'switch');
  const before = await profile(c);
  const switched = await switchStageRun(await switchRequest(c), c.batch.maa);
  assert.equal(switched.state, 'prepared'); assert.equal(switched.repeated, false);
  assert.deepEqual([switched.stageId, switched.from, switched.to, switched.trigger, switched.start, switched.next], ['synthetic_01', 1, 2, 'job-failure', 'user', 'start-alternate']);
  assert.deepEqual(switched.runs, [{ stageId: 'synthetic_01', job: 2, runs: 2 }, { stageId: 'synthetic_02', job: 4, runs: 1 }]);
  const after = await profile(c);
  assert.deepEqual(after.Copilot.TaskList.map((item: { CopilotId: number; Index: number; IsChecked: boolean }) => [item.CopilotId, item.Index, item.IsChecked]), [[2, 0, true], [2, 1, true], [4, 2, true]]);
  assert.equal(after.Copilot.EnableUserAdditional, false);
  assert.equal(JSON.stringify(after.TaskQueue), JSON.stringify(before.TaskQueue), 'every Fight task field, medicine and stone counts included, is unchanged');
  const old = await observe(c);
  assert.deepEqual(old.allowedDecisions, ['stop-and-tell-user']); assert.equal(old.next, 'start-alternate');
  assert.deepEqual(old.switch && [old.switch.state, old.switch.operation], ['prepared', switched.operation]);

  const next = await startStageRun({ ...c.paths, operation: switched.operation!, reference: '合成用户：备选换好了，我点开始' });
  assert.deepEqual(next.batch.stages, [{ stageId: 'synthetic_01', code: 'SYN-1', loops: 2 }, { stageId: 'synthetic_02', code: 'SYN-2', loops: 1 }]);
  const files = [2, 2, 4].map(id => approvedJobFile(c.batch.privateDirectory, c.batch.reportHash, id)), t1 = fromNow(60);
  await c.batch.core(retag([...copilotStart(t1, { files }), ...attempt(t1 + 10, 0, files[0]!, 'three-star'), ...attempt(t1 + 60, 1, files[1]!, 'three-star'),
    ...attempt(t1 + 120, 2, files[2]!, 'three-star'), ...chainEnd(t1 + 180, 'TaskChainCompleted')], 2));
  const done = await observe(c, next.runId);
  assert.equal(done.execution, 'completed');
  assert.deepEqual(done.stages.map(stage => [stage.code, stage.result]), [['SYN-1', 'success'], ['SYN-2', 'success']]);
  assert.equal(done.next, 'report');
  assert.equal((await observe(c)).next, 'report', 'the old run hands over once the alternate batch is tracked');
});
