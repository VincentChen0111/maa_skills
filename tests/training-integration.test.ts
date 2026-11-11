import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { executeConfigWrite, inspectConfiguration, inspectConfigRecovery, executeConfigRecovery, type WriteRequest } from '../skills/maa-core/scripts/maa-config.ts';
import { approvedJobFile, approvedJobSourceFile, approvedJobList, type ApprovedJobPlan } from '../skills/maa-core/scripts/stage-job-plan.ts';
import { buildTrainingChanges } from '../skills/maa-core/scripts/training-config.ts';
import { configFixture, trainingGrant } from './fixtures/training-runtime.ts';

test('job, training and medicine grants cannot be combined in the shared writer', async t => {
  const f = await configFixture(t);
  Object.assign(f.config.Configurations.synthetic, { Copilot: { TaskList: [], EnableUserAdditional: true } });
  await writeFile(f.file, JSON.stringify(f.config));
  const content = { opers: [], actions: [] }, hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  const jobPlan: ApprovedJobPlan = { reportHash: 'a'.repeat(64), map: 'synthetic', entries: [{ stageId: 'synthetic', code: 'SYN-1', difficulty: 'normal', difficultyGroup: 'NONE', loops: 1,
    primary: { id: 1, hash, sourceHash: hash, source: { url: 'https://prts.maa.plus/copilot/get/1', readAt: '2026-11-11T01:00:00.000Z' } }, alternates: [] }] };
  for (const file of [approvedJobFile(f.privateDirectory, jobPlan.reportHash, 1), approvedJobSourceFile(f.privateDirectory, jobPlan.reportHash, 1)]) {
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(content));
  }
  const trainingPlan = trainingGrant(), revision = (await inspectConfiguration(f.maaDirectory)).revision;
  const jobChanges = [{ path: ['Configurations', 'synthetic', 'Copilot', 'TaskList'], value: approvedJobList(jobPlan, f.privateDirectory) },
    { path: ['Configurations', 'synthetic', 'Copilot', 'EnableUserAdditional'], value: false }];
  const trainingChanges = buildTrainingChanges(f.config, trainingPlan, f.privateDirectory).changes;
  const cases: Pick<WriteRequest, 'authorization' | 'changes'>[] = [
    { authorization: { source: 'current-request', reference: 'synthetic', jobPlan, medicineCount: 1 }, changes: jobChanges },
    { authorization: { source: 'current-request', reference: 'synthetic', trainingPlan, medicineCount: 1 }, changes: trainingChanges },
    { authorization: { source: 'current-request', reference: 'synthetic', jobPlan, trainingPlan }, changes: trainingChanges },
  ];
  for (const request of cases) {
    const result = await executeConfigWrite({ ...request, maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, expectedRevision: revision }, f.maa);
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.equal(await readFile(f.file, 'utf8'), JSON.stringify(f.config));
    await assert.rejects(readFile(join(f.privateDirectory, 'daily-pending.jsonl')), { code: 'ENOENT' });
  }
});

test('an actual interrupted training asset transaction stays unknown to doctor recovery', async t => {
  const f = await configFixture(t), grant = trainingGrant();
  const request: WriteRequest = { maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
    expectedRevision: (await inspectConfiguration(f.maaDirectory)).revision, authorization: { source: 'current-request', reference: 'synthetic', trainingPlan: grant },
    changes: buildTrainingChanges(f.config, grant, f.privateDirectory).changes };
  const module = new URL('../skills/maa-core/scripts/maa-config.ts', import.meta.url).href;
  const input = `const {executeConfigWrite}=await import(${JSON.stringify(module)}); const result=await executeConfigWrite(${JSON.stringify(request)}, {inspect:async()=>({running:false,treeExited:true,idle:true,ready:false}),close:async()=>{},start:async()=>{throw Error('synthetic restart failure')}});console.log(JSON.stringify(result));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-'], { input, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).status, 'unknown');
  const lock = join(f.maaDirectory, 'config/.maa-skills.lock'), lockBefore = await readFile(lock), configBefore = await readFile(f.file);
  const pending = JSON.parse((await readFile(join(f.privateDirectory, 'daily-pending.jsonl'), 'utf8')).trim());
  assert.equal(pending.trainingManifest.immutable, true);
  const summary = await inspectConfigRecovery(f, f.maa);
  assert.equal(summary.lock, 'stale'); assert.equal(summary.comparison, 'unknown');
  assert.equal(summary.canRestore, false); assert.equal(summary.canReconcile, false);
  for (const action of ['restore-config', 'reconcile-lock'] as const) {
    const result = await executeConfigRecovery({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', action,
      reference: 'synthetic named recovery', evidenceRevision: summary.evidenceRevision, closedConfirmed: true }, f.maa);
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'reconciliation-unproven');
    assert.deepEqual(await readFile(lock), lockBefore); assert.deepEqual(await readFile(f.file), configBefore);
  }
});
