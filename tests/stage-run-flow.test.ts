import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { observeStageRun, readStageRun, stageRunOutcome, startStageRun } from '../skills/maa-core/scripts/stage-run.ts';
import { attempt, copilotStart, preparedBatch } from './fixtures/stage-run-data.ts';

const script = fileURLToPath(new URL('../skills/maa-core/scripts/stage-run.ts', import.meta.url));

test('tracking starts only from a complete prepared batch whose list and job files are unchanged', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
  await assert.rejects(startStageRun({ ...paths, operation: '00000000-0000-4000-8000-000000000000', reference: '开始' }), /batch-not-prepared/);
  await assert.rejects(startStageRun({ ...paths, operation: batch.operation, reference: '' }), /reference-required/);
  const configFile = join(batch.maaDirectory, 'config/gui.new.json'), original = await readFile(configFile, 'utf8');
  const config = JSON.parse(original);
  config.Configurations['Synthetic profile'].Copilot.TaskList[1].IsChecked = false;
  await writeFile(configFile, JSON.stringify(config));
  const subset = await startStageRun({ ...paths, operation: batch.operation, reference: '只勾选了部分' });
  assert.equal((await readStageRun(batch.privateDirectory, subset.runId)).batch.listCheck, 'subset');
  config.Configurations['Synthetic profile'].Copilot.TaskList[1].CopilotId = 99;
  await writeFile(configFile, JSON.stringify(config));
  await assert.rejects(startStageRun({ ...paths, operation: batch.operation, reference: '列表被改过' }), /prepared-list-changed/);
  await writeFile(configFile, original);
  await writeFile(batch.files[0]!, '{"changed":true}\n');
  await assert.rejects(startStageRun({ ...paths, operation: batch.operation, reference: '作业文件被改过' }), /job-file-changed/);
});

test('a waiting observer returns as soon as MAA reports a failure instead of waiting out its window', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  Object.assign(batch.state, { running: true, treeExited: false, ready: true });
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
  const { runId } = await startStageRun({ ...paths, operation: batch.operation, reference: '开始' });
  await batch.core([...copilotStart(0, { files: batch.files }), ...attempt(10, 0, batch.files[0]!, 'open')]);
  await observeStageRun({ ...paths, runId }, batch.maa);
  setTimeout(() => { void batch.core(attempt(10, 0, batch.files[0]!, 'not-three-star').slice(2)); }, 400);
  const started = Date.now();
  const summary = await observeStageRun({ ...paths, runId, waitSeconds: 20 }, batch.maa);
  assert.ok(Date.now() - started < 15000, 'returned before the wait window');
  assert.ok(summary.newFindings.some(item => item.kind === 'stage-result' && item.terminal === 'not-three-star'));
  await assert.rejects(observeStageRun({ ...paths, runId, waitSeconds: 601 }, batch.maa), /wait-invalid/);
  const outcome = stageRunOutcome(await readStageRun(batch.privateDirectory, runId));
  assert.deepEqual(outcome.stages.map(stage => [stage.code, stage.primary, stage.alternates, stage.result]), [['SYN-1', 1, [2], 'not-three-star'], ['SYN-2', 4, [], 'not-evaluated']]);
  assert.equal(outcome.operation, batch.operation); assert.equal(outcome.lastDecision, null);
});

test('one observer at a time; a lock left by an exited process is taken over', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  const paths = { maaDirectory: batch.maaDirectory, privateDirectory: batch.privateDirectory };
  const { runId } = await startStageRun({ ...paths, operation: batch.operation, reference: '开始' });
  const lock = join(batch.privateDirectory, 'stage-runs', `${runId}.lock`);
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(observeStageRun({ ...paths, runId }, batch.maa), /run-busy/);
  const exited = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  await writeFile(lock, JSON.stringify({ pid: Number(exited.stdout.trim()) }));
  assert.equal((await observeStageRun({ ...paths, runId }, batch.maa)).execution, 'tracking');
});

test('CLI validates actions and keys and reports a reason code without private details', async t => {
  const batch = await preparedBatch(); t.after(() => batch.dispose());
  await updateSettings({ language: 'zh-CN', privateDirectory: batch.privateDirectory, maaDirectory: batch.maaDirectory }, batch.root);
  const env = { ...process.env, MAA_SKILLS_HOME: batch.root };
  const call = (action: string, input: unknown) => spawnSync(process.execPath, [script, action], { input: JSON.stringify(input), encoding: 'utf8', env });
  const started = call('start', { operation: batch.operation, reference: '合成用户：我点开始了' });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const { runId } = JSON.parse(started.stdout);
  assert.deepEqual(JSON.parse(call('start', { operation: batch.operation, reference: 'x', extra: 1 }).stdout), { ok: false, status: 'check-required', reason: 'request-invalid' });
  assert.deepEqual(JSON.parse(call('replay', {}).stdout).reason, 'action-invalid');
  const decided = call('decide', { runId, decision: 'retry-within-approval', reason: '直接重打' });
  assert.equal(decided.status, 1); assert.equal(JSON.parse(decided.stdout).reason, 'decision-not-allowed');
  const read = call('read', {});
  assert.equal(read.status, 0); assert.equal(JSON.parse(read.stdout).runId, runId);
  for (const output of [started.stdout, read.stdout]) for (const secret of [batch.privateDirectory, batch.maaDirectory, 'Synthetic profile']) assert.ok(!output.includes(secret));
});
