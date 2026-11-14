import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeConfigWrite, inspectConfiguration } from '../skills/maa-core/scripts/maa-config.ts';
import { decideConsumption } from '../skills/maa-core/scripts/consumption-grant.ts';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { approvedJobFile, approvedJobList, type ApprovedJobPlan } from '../skills/maa-core/scripts/stage-job-plan.ts';
import { decideStageRun, loadBatchView, observeStageRun, readStageRun, recordStageProgress, stageRunOutcome, startStageRun, switchStageRun, verifyStageRun }
  from '../skills/maa-core/scripts/stage-run.ts';
import { attempt, chainEnd, connection, copilotStart, core, preparedBatch, type PreparedBatch } from './fixtures/stage-run-data.ts';

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
async function tracked(t: test.TestContext, syn1Loops = 2): Promise<Tracked> {
  const batch = await preparedBatch(syn1Loops); t.after(() => batch.dispose());
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

const failedPrimary = async (c: Tracked, outcome: 'failed' | 'not-three-star' = 'failed') => {
  const t0 = fromNow(-600);
  await c.batch.core([...copilotStart(t0, { files: c.batch.files }), ...attempt(t0 + 10, 0, c.batch.files[0]!, outcome), ...chainEnd(t0 + 60, 'TaskChainError')]);
  return observe(c);
};
const decideAndSwitch = async (c: Tracked, reason = 'MAA 报告这一关失败，按批准顺序换下一份备选') => {
  await decideStageRun({ ...c.paths, runId: c.runId, decision: 'switch-alternate', reason });
  return switchStageRun(await switchRequest(c), c.batch.maa);
};
const listed = async (c: Tracked) => (await profile(c)).Copilot.TaskList.map((item: { CopilotId: number; Index: number }) => [item.CopilotId, item.Index]);
const completions = async (c: Tracked) => (await readFile(join(c.batch.privateDirectory, 'daily-runs.jsonl'), 'utf8')).split(/\r?\n/).filter(line => line.includes('"status":"complete"')).length;
const ledgerFile = (c: Tracked, key: string) => join(c.batch.privateDirectory, 'stage-runs', 'switches', `${key}.json`);

test('not three stars after a 3-star run: the alternate makes up only the runs not yet cleared', async t => {
  const c = await tracked(t), t0 = fromNow(-600), files = c.batch.files;
  await c.batch.core([...copilotStart(t0, { files }), ...attempt(t0 + 10, 0, files[0]!, 'three-star'), ...attempt(t0 + 60, 1, files[1]!, 'not-three-star'), ...chainEnd(t0 + 100, 'TaskChainError')]);
  const failed = await observe(c);
  assert.deepEqual(failed.stages.map(stage => stage.result), ['not-three-star', 'unknown']);
  assert.deepEqual(failed.allowedDecisions, ['switch-alternate', 'stop-and-tell-user']);
  const switched = await decideAndSwitch(c);
  assert.deepEqual(switched.runs, [{ stageId: 'synthetic_01', job: 2, runs: 1 }, { stageId: 'synthetic_02', job: 4, runs: 1 }], 'the non-3-star run is not counted as done');
  assert.deepEqual(await listed(c), [[2, 0], [4, 1]]);
});

test('alternates used up: the next failure only stops and reports; nothing outside the approval is looked for', async t => {
  const c = await tracked(t);
  await failedPrimary(c);
  const switched = await decideAndSwitch(c);
  const next = await startStageRun({ ...c.paths, operation: switched.operation!, reference: '合成用户：备选换好了，我点开始' });
  const files = [2, 2, 4].map(id => approvedJobFile(c.batch.privateDirectory, c.batch.reportHash, id)), t1 = fromNow(60);
  await c.batch.core(retag([...copilotStart(t1, { files }), ...attempt(t1 + 10, 0, files[0]!, 'not-three-star'), ...chainEnd(t1 + 50, 'TaskChainError')], 2));
  const failed = await observe(c, next.runId);
  assert.deepEqual(failed.stages.map(stage => stage.result), ['not-three-star', 'unknown']);
  assert.deepEqual(failed.alternates, [{ stageId: 'synthetic_01', job: 2, next: null, left: 0 }, { stageId: 'synthetic_02', job: 4, next: null, left: 0 }]);
  assert.deepEqual(failed.allowedDecisions, ['stop-and-tell-user']); assert.equal(failed.next, 'report');
  await assert.rejects(decideStageRun({ ...c.paths, runId: next.runId, decision: 'switch-alternate', reason: '再换一份' }), /decision-not-allowed/);
  await assert.rejects(switchStageRun(await switchRequest(c, next.runId), c.batch.maa), /alternates-exhausted/);
  assert.deepEqual(await listed(c), [[2, 0], [2, 1], [4, 2]], 'the list is left as it was');
});

test('an environment failure is not a job failure: verify first, then the model may switch; the primary is set aside, not marked failed', async t => {
  const c = await tracked(t), t0 = fromNow(-600);
  const loaded = core(t0 + 10, 'SubTaskExtraInfo', { taskchain: 'Copilot', taskid: 1, class: 'asst::MultiCopilotTaskPlugin', what: 'CopilotListLoadTaskFileSuccess',
    details: { stage_name: 'synthetic', file_name: c.batch.files[0], id: 0 } });
  await c.batch.core([...copilotStart(t0, { files: c.batch.files }), loaded, connection(t0 + 12, 'Disconnect'), ...chainEnd(t0 + 13, 'TaskChainError')]);
  const observed = await observe(c);
  assert.equal(observed.next, 'verify'); assert.deepEqual(observed.allowedDecisions, ['stop-and-tell-user']);
  await assert.rejects(decideStageRun({ ...c.paths, runId: c.runId, decision: 'switch-alternate', reason: '断连了，换备选' }), /decision-not-allowed/);
  const verified = await verifyStageRun({ ...c.paths, home: c.batch.home, runId: c.runId }, c.batch.maa, c.batch.boundaries);
  assert.deepEqual(verified.allowedDecisions, ['retry-within-approval', 'switch-alternate', 'stop-and-tell-user']);
  const switched = await decideAndSwitch(c, '断连已核对清楚，模型决定换备选 2');
  assert.deepEqual([switched.trigger, switched.from, switched.to, switched.state], ['environment', 1, 2, 'prepared']);
  assert.deepEqual(switched.runs, [{ stageId: 'synthetic_01', job: 2, runs: 2 }, { stageId: 'synthetic_02', job: 4, runs: 1 }]);
  assert.deepEqual(switched.unknown, ['sanity', 'medicine-inventory', 'originium', 'stage-progress'], 'approval-time state is not reused');
  const outcome = stageRunOutcome(await readStageRun(c.batch.privateDirectory, c.runId), (await loadBatchView(c.paths, c.runId)).batch);
  assert.deepEqual(outcome.stages.map(stage => [stage.stageId, stage.result, stage.job]), [['synthetic_01', 'unknown', 1], ['synthetic_02', 'unknown', 4]]);
  assert.deepEqual(outcome.switch && [outcome.switch.trigger, outcome.switch.state], ['environment', 'prepared']);
});

test('a repeated switch request returns the existing record without writing again; the same key with a different input is refused, both digests kept', async t => {
  const c = await tracked(t);
  await failedPrimary(c);
  await decideStageRun({ ...c.paths, runId: c.runId, decision: 'switch-alternate', reason: 'MAA 报告失败' });
  const request = await switchRequest(c);
  const first = await switchStageRun(request, c.batch.maa), writes = await completions(c);
  const again = await switchStageRun(request, c.batch.maa);
  assert.deepEqual([again.repeated, again.key, again.state, again.operation], [true, first.key, 'prepared', first.operation]);
  assert.equal(await completions(c), writes, 'no second write');
  await assert.rejects(switchStageRun({ ...request, expectedRevision: await revision(c) }, c.batch.maa), /idempotency-conflict/);
  const ledger = JSON.parse(await readFile(ledgerFile(c, first.key), 'utf8'));
  assert.equal(ledger.conflicts.length, 1); assert.match(ledger.conflicts[0].input, /^[a-f0-9]{64}$/); assert.notEqual(ledger.conflicts[0].input, ledger.input);
  assert.equal(await completions(c), writes);
});

test('a switch the writer refused before writing anything may be requested again', async t => {
  const c = await tracked(t);
  await failedPrimary(c);
  Object.assign(c.batch.state, { running: false, treeExited: true, ready: false });
  const refused = await decideAndSwitch(c);
  assert.deepEqual([refused.state, refused.next, refused.write?.reason], ['rejected', 'retry-switch', 'closed-confirmation-required']);
  assert.deepEqual(await listed(c), [[1, 0], [1, 1], [4, 2]]);
  assert.equal((await observe(c)).next, 'switch');
  const done = await switchStageRun({ ...await switchRequest(c), closedConfirmed: true }, c.batch.maa);
  assert.deepEqual([done.state, done.repeated, done.key], ['prepared', false, refused.key]);
  assert.deepEqual(JSON.parse(await readFile(ledgerFile(c, done.key), 'utf8')).attempts.map((item: { status: string }) => item.status), ['rejected', 'complete']);
});

test('a switch left writing by a process that is gone reads as interrupted: verify only, never resumed', async t => {
  const c = await tracked(t);
  await failedPrimary(c);
  await decideStageRun({ ...c.paths, runId: c.runId, decision: 'switch-alternate', reason: 'MAA 报告失败' });
  const request = await switchRequest(c), first = await switchStageRun(request, c.batch.maa);
  const ledger = JSON.parse(await readFile(ledgerFile(c, first.key), 'utf8'));
  const exited = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  await writeFile(ledgerFile(c, first.key), JSON.stringify({ ...ledger, state: 'writing', write: null, owner: { pid: Number(exited.stdout.trim()), at: ledger.owner.at } }));
  const writes = await completions(c);
  const old = await observe(c);
  assert.deepEqual([old.switch?.state, old.next], ['interrupted', 'verify']); assert.deepEqual(old.allowedDecisions, ['stop-and-tell-user']);
  const again = await switchStageRun(request, c.batch.maa);
  assert.deepEqual([again.state, again.repeated, again.next, again.operation], ['interrupted', true, 'verify', null]);
  assert.equal(await completions(c), writes, 'not resumed');
});

test('the unified writer accepts only the continuation list of approved jobs; the generic write CLI refuses any continuation', async t => {
  const c = await tracked(t);
  const plan = await pendingPlan(c.batch.privateDirectory, c.batch.operation);
  const valid: ApprovedJobPlan = { ...plan, continuation: { from, stages: [{ stageId: 'synthetic_01', job: 2, runs: 1 }] } };
  const before = await revision(c);
  /** A continuation naming a job not approved for the stage, and a list that is not the continuation's expansion. */
  const refused: [ApprovedJobPlan, unknown][] = [[{ ...plan, continuation: { from, stages: [{ stageId: 'synthetic_01', job: 4, runs: 1 }] } }, approvedJobList(valid, c.batch.privateDirectory)],
    [valid, approvedJobList(plan, c.batch.privateDirectory)]];
  for (const [jobPlan, value] of refused) {
    const result = await executeConfigWrite({ maaDirectory: c.batch.maaDirectory, privateDirectory: c.batch.privateDirectory, host: 'claude', expectedRevision: before,
      authorization: { source: 'current-request', reference: '合成用户批准', jobPlan }, changes: [{ path: ['Configurations', 0, 'Copilot', 'TaskList'], value },
        { path: ['Configurations', 0, 'Copilot', 'EnableUserAdditional'], value: false }] }, c.batch.maa);
    assert.deepEqual([result.status, result.reason], ['rejected', 'request-invalid']);
  }
  assert.equal(await revision(c), before);
  await updateSettings({ language: 'zh-CN', privateDirectory: c.batch.privateDirectory, maaDirectory: c.batch.maaDirectory }, c.batch.root);
  const env = { ...process.env, MAA_SKILLS_HOME: c.batch.root };
  const script = (name: string) => fileURLToPath(new URL(`../skills/maa-core/scripts/${name}`, import.meta.url));
  const pending = await readFile(join(c.batch.privateDirectory, 'daily-pending.jsonl'), 'utf8');
  const cli = spawnSync(process.execPath, [script('maa-config.ts'), 'write'], { env, encoding: 'utf8', input: JSON.stringify({ host: 'claude', expectedRevision: '0'.repeat(64),
    authorization: { source: 'current-request', reference: '合成用户批准', jobPlan: valid },
    changes: [{ path: ['Configurations', 0, 'Copilot', 'TaskList'], value: approvedJobList(valid, c.batch.privateDirectory) }, { path: ['Configurations', 0, 'Copilot', 'EnableUserAdditional'], value: false }] }) });
  assert.deepEqual(JSON.parse(cli.stdout), { ok: false, status: 'check-required' });
  assert.equal(await readFile(join(c.batch.privateDirectory, 'daily-pending.jsonl'), 'utf8'), pending);
  await failedPrimary(c);
  const call = (input: unknown) => JSON.parse(spawnSync(process.execPath, [script('stage-run.ts'), 'switch'], { env, encoding: 'utf8', input: JSON.stringify(input) }).stdout);
  const body = { runId: c.runId, stageId: 'synthetic_01', expectedRevision: before, host: 'claude' };
  assert.deepEqual(call({ ...body, extra: 1 }), { ok: false, status: 'check-required', reason: 'request-invalid' });
  assert.deepEqual(call(body), { ok: false, status: 'check-required', reason: 'switch-not-decided' });
});

/**
 * Merge of 27 with 17 (2026-11-14), registered in tests/consumption-grant.test.ts's writer callers: the switch writes the
 * continuation's Copilot list through the unified writer, whose consumption checks run on every write. It never activates a
 * Fight task, and a medicine or stone quantity cannot ride along its job plan (the predicate's `conflicting-authorizations`).
 */
test('an alternate switch never activates a consuming task, and no quantity grant can ride along its job plan', async t => {
  const c = await tracked(t);
  const file = join(c.batch.maaDirectory, 'config/gui.new.json'), config = JSON.parse(await readFile(file, 'utf8'));
  const consuming = { $type: 'FightTask', TaskType: 'Fight', IsEnable: true, StagePlan: ['1-7'], UseMedicine: true, MedicineCount: 2, UseStone: true,
    UseStoneAllowSave: true, StoneCount: 3, UseExpiringMedicine: true, MedicineExpireDays: 2, UseExpireMedicineForActivity: false };
  config.Configurations['Synthetic profile'].TaskQueue = [consuming];
  await writeFile(file, JSON.stringify(config));
  const plan = await pendingPlan(c.batch.privateDirectory, c.batch.operation);
  const next: ApprovedJobPlan = { ...plan, continuation: { from, stages: [{ stageId: 'synthetic_01', job: 2, runs: 1 }] } };
  // The write exactly as `switchStageRun` makes it, with an optional extra grant.
  const write = async (extra: Record<string, unknown>) => executeConfigWrite({ maaDirectory: c.batch.maaDirectory, privateDirectory: c.batch.privateDirectory,
    host: 'claude', expectedRevision: await revision(c), authorization: { source: 'current-request', reference: '合成用户批准', jobPlan: next, ...extra } as never,
    changes: [{ path: ['Configurations', 0, 'Copilot', 'TaskList'], value: approvedJobList(next, c.batch.privateDirectory) },
      { path: ['Configurations', 0, 'Copilot', 'EnableUserAdditional'], value: false }] }, c.batch.maa);
  for (const grant of [{ medicineCount: 2 }, { stoneCount: 3 }]) {
    const refused = await write(grant);
    assert.deepEqual([refused.status, refused.reason], ['rejected', 'conflicting-authorizations'], JSON.stringify(grant));
    assert.equal(decideConsumption({ source: 'current-request', ...grant }, [], { consumer: 'writer-whitelist', plan: 'job' }).reason, 'conflicting-authorizations');
  }
  const written = await write({});
  assert.equal(written.status, 'complete', JSON.stringify(written));
  assert.deepEqual((await profile(c)).TaskQueue, [consuming], 'the Fight task with medicine, stone and expiring medicine on is left alone');
  assert.equal(decideConsumption({ source: 'current-request' }, [], { consumer: 'indirect-consumption', plan: 'job' }).allowed, true);
});

/**
 * Review round 1 (P1): a progress statement counts the runs done up to when it was made; 3-star runs proven in a run
 * started after it add to it. SYN-1 is approved 3 times: run 1 ends unknown in battle, the user states 1 done, the retry
 * clears SYN-1 once more and then MAA reports a failure. Only 1 run is left, so the alternate gets 1, not 2.
 */
test('runs done add a statement and the 3-star runs proven after it: the alternate gets only the runs left', async t => {
  const c = await tracked(t, 3), files = c.batch.files, t0 = fromNow(-900), t1 = fromNow(-300);
  await c.batch.core([...copilotStart(t0, { files }), ...attempt(t0 + 10, 0, files[0]!, 'open', [connection(t0 + 20, 'Disconnect')]), ...chainEnd(t0 + 21, 'TaskChainError')]);
  assert.equal((await observe(c)).next, 'verify');
  assert.equal((await verifyStageRun({ ...c.paths, home: c.batch.home, runId: c.runId }, c.batch.maa, c.batch.boundaries)).next, 'ask-progress');
  await recordStageProgress({ ...c.paths, runId: c.runId, reference: '合成用户：断连那一把其实打完了，三星', stages: [{ stageId: 'synthetic_01', completedRuns: 1 }] });
  await decideStageRun({ ...c.paths, runId: c.runId, decision: 'retry-within-approval', reason: '用户说明 SYN-1 完成一次，原批准范围内重试' });
  const file = join(c.batch.maaDirectory, 'config/gui.new.json'), config = JSON.parse(await readFile(file, 'utf8'));
  config.Configurations['Synthetic profile'].Copilot.TaskList[0].IsChecked = false;
  await writeFile(file, JSON.stringify(config));
  const retry = await startStageRun({ ...c.paths, operation: c.batch.operation, reference: '合成用户：重新点开始', retryOf: c.runId });
  await c.batch.core(retag([...copilotStart(t1, { files: files.slice(1) }), ...attempt(t1 + 10, 1, files[1]!, 'three-star'), ...attempt(t1 + 60, 2, files[2]!, 'failed'),
    ...chainEnd(t1 + 100, 'TaskChainError')], 2));
  const failed = await observe(c, retry.runId);
  assert.ok(failed.allowedDecisions.includes('switch-alternate'), JSON.stringify(failed.allowedDecisions));
  await decideStageRun({ ...c.paths, runId: retry.runId, decision: 'switch-alternate', reason: 'MAA 报告 SYN-1 作战失败，换备选 2' });
  const switched = await switchStageRun(await switchRequest(c, retry.runId), c.batch.maa);
  assert.deepEqual(switched.runs, [{ stageId: 'synthetic_01', job: 2, runs: 1 }, { stageId: 'synthetic_02', job: 4, runs: 1 }], '1 stated + 1 proven after it = 2 of 3 done');
  assert.deepEqual(await listed(c), [[2, 0], [4, 1]]);
});

/**
 * Review round 2 (P2): a second statement is the total so far. SYN-1 is approved 3 times: run 1 ends unknown in battle
 * and the user states 1; the retry clears SYN-1 once (proven) and then ends unknown in battle again. Runs done are now 2,
 * so a second statement of 1 (only the latest battle) is refused, and the summary shows what is already recorded.
 */
test('a second statement below the runs already recorded is refused; the summary shows the count and the statement it rests on', async t => {
  const c = await tracked(t, 3), files = c.batch.files, t0 = fromNow(-900), t1 = fromNow(-300);
  await c.batch.core([...copilotStart(t0, { files }), ...attempt(t0 + 10, 0, files[0]!, 'open', [connection(t0 + 20, 'Disconnect')]), ...chainEnd(t0 + 21, 'TaskChainError')]);
  await observe(c); await verifyStageRun({ ...c.paths, home: c.batch.home, runId: c.runId }, c.batch.maa, c.batch.boundaries);
  await recordStageProgress({ ...c.paths, runId: c.runId, reference: '合成用户：断连那一把打完了', stages: [{ stageId: 'synthetic_01', completedRuns: 1 }] });
  await decideStageRun({ ...c.paths, runId: c.runId, decision: 'retry-within-approval', reason: '用户说明完成一次' });
  const file = join(c.batch.maaDirectory, 'config/gui.new.json'), config = JSON.parse(await readFile(file, 'utf8'));
  config.Configurations['Synthetic profile'].Copilot.TaskList[0].IsChecked = false;
  await writeFile(file, JSON.stringify(config));
  const retry = await startStageRun({ ...c.paths, operation: c.batch.operation, reference: '重新点开始', retryOf: c.runId });
  await c.batch.core(retag([...copilotStart(t1, { files: files.slice(1) }), ...attempt(t1 + 10, 1, files[1]!, 'three-star'),
    ...attempt(t1 + 60, 2, files[2]!, 'open', [connection(t1 + 70, 'Disconnect')]), ...chainEnd(t1 + 71, 'TaskChainError')], 2));
  await observe(c, retry.runId);
  const asked = await verifyStageRun({ ...c.paths, home: c.batch.home, runId: retry.runId }, c.batch.maa, c.batch.boundaries);
  assert.equal(asked.next, 'ask-progress');
  assert.deepEqual(asked.runsDone[0], { stageId: 'synthetic_01', done: 2, statement: { runs: 1, quote: '合成用户：断连那一把打完了' }, provenSince: 1 }, 'the earlier statement is visible from the retry run');
  await assert.rejects(recordStageProgress({ ...c.paths, runId: retry.runId, reference: '合成用户：断连那次打完了，1 次', stages: [{ stageId: 'synthetic_01', completedRuns: 1 }] }),
    /progress-contradicts-evidence/);
  const stated = await recordStageProgress({ ...c.paths, runId: retry.runId, reference: '合成用户：一共打完 2 次，断连那次没打完', stages: [{ stageId: 'synthetic_01', completedRuns: 2 }] });
  assert.deepEqual(stated.runsDone[0], { stageId: 'synthetic_01', done: 2, statement: { runs: 2, quote: '合成用户：一共打完 2 次，断连那次没打完' }, provenSince: 0 });
  await decideStageRun({ ...c.paths, runId: retry.runId, decision: 'switch-alternate', reason: '断连已核对，换备选' });
  const switched = await switchStageRun(await switchRequest(c, retry.runId), c.batch.maa);
  assert.deepEqual(switched.runs[0], { stageId: 'synthetic_01', job: 2, runs: 1 });
});
