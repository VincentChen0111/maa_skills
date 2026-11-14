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
import './fixtures/maa-version-guard.ts';

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

// 27: the expiring-medicine grant may accompany a plan; medicine and stone quantities may not.
const consuming = { $type: 'FightTask', TaskType: 'Fight', IsEnable: true, StagePlan: ['SYN-1'], UseMedicine: false, MedicineCount: 0,
  UseStone: false, StoneCount: 0, UseStoneAllowSave: false, UseExpiringMedicine: false, MedicineExpireDays: 2, UseExpireMedicineForActivity: false };
/** A second profile whose enabled Fight task an already enabled timer reaches; the training write re-checks that timer. */
async function trainingWithOtherTimer(t: Parameters<typeof configFixture>[0], fight: Record<string, unknown>) {
  const f = await configFixture(t);
  Object.assign(f.config.Configurations, { other: { TaskQueue: [{ ...consuming, ...fight }] } });
  f.config.Timers.CustomConfig = true;
  f.config.Timers.List.push({ Id: 1, IsEnabled: true, Config: 'other', Hour: (new Date().getHours() + 3) % 24, Minute: 30 });
  await writeFile(f.file, JSON.stringify(f.config));
  const grant = trainingGrant();
  let processCalls = 0; const inspect = f.maa.inspect; f.maa.inspect = async () => { processCalls++; return inspect(); };
  const write = (extra: Record<string, unknown>) => executeConfigWrite({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
    expectedRevision: revisionOf(f.config), authorization: { source: 'current-request', reference: 'synthetic training approval', trainingPlan: grant, ...extra } as never,
    changes: buildTrainingChanges(f.config, grant, f.privateDirectory).changes }, f.maa);
  return { ...f, write, processCalls: () => processCalls };
}
const revisionOf = (config: unknown) => createHash('sha256').update(JSON.stringify(config)).digest('hex');

test('a training timer write that reaches open expiring medicine needs the current expiring grant, and open stone refuses it', async t => {
  const refusals: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    ['expiring medicine without a grant', { UseExpiringMedicine: true }, {}, 'training-expiring-grant-required'],
    ['activity expiring medicine without a grant', { UseExpireMedicineForActivity: true }, {}, 'training-expiring-grant-required'],
    ['open stone, even with an expiring grant', { UseStone: true, UseStoneAllowSave: true, StoneCount: 1 }, { expiringMedicine: { days: 2, forActivity: false } }, 'training-stone-enabled'],
    ['a medicine quantity with the plan', {}, { medicineCount: 1 }, 'conflicting-authorizations'],
    ['a stone quantity with the plan', {}, { stoneCount: 1 }, 'conflicting-authorizations'],
  ];
  for (const [name, fight, extra, reason] of refusals) await t.test(name, async t => {
    const f = await trainingWithOtherTimer(t, fight); const before = await readFile(f.file);
    const result = await f.write(extra);
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, reason);
    assert.equal(f.processCalls(), 0); assert.deepEqual(await readFile(f.file), before);
    await assert.rejects(readFile(join(f.privateDirectory, 'daily-pending.jsonl')), { code: 'ENOENT' });
  });
  await t.test('expiring medicine approved with the plan', async t => {
    const f = await trainingWithOtherTimer(t, { UseExpiringMedicine: true, UseExpireMedicineForActivity: true });
    const result = await f.write({ expiringMedicine: { days: 2, forActivity: true } });
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).Configurations.other, (f.config.Configurations as Record<string, unknown>).other);
  });
});

test('a job plan write enables nothing: open Fight consumption is left byte for byte, with or without an expiring grant', async t => {
  for (const extra of [{}, { expiringMedicine: { days: 2, forActivity: false } }, { stoneCount: 1 }]) await t.test(JSON.stringify(extra), async t => {
    const f = await configFixture(t);
    const open = { ...consuming, UseMedicine: true, MedicineCount: 3, UseStone: true, StoneCount: 2, UseStoneAllowSave: true, UseExpiringMedicine: true, UseExpireMedicineForActivity: true };
    f.config.Configurations.synthetic.TaskQueue.push(open as never);
    Object.assign(f.config.Configurations.synthetic, { Copilot: { TaskList: [], EnableUserAdditional: true } });
    await writeFile(f.file, JSON.stringify(f.config)); const before = await readFile(f.file);
    const content = { opers: [], actions: [] }, hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const jobPlan: ApprovedJobPlan = { reportHash: 'b'.repeat(64), map: 'synthetic', entries: [{ stageId: 'synthetic', code: 'SYN-1', difficulty: 'normal', difficultyGroup: 'NONE', loops: 1,
      primary: { id: 1, hash, sourceHash: hash, source: { url: 'https://prts.maa.plus/copilot/get/1', readAt: '2026-11-11T01:00:00.000Z' } }, alternates: [] }] };
    for (const file of [approvedJobFile(f.privateDirectory, jobPlan.reportHash, 1), approvedJobSourceFile(f.privateDirectory, jobPlan.reportHash, 1)]) {
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(content));
    }
    const result = await executeConfigWrite({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
      expectedRevision: revisionOf(f.config), authorization: { source: 'current-request', reference: 'synthetic job approval', jobPlan, ...extra } as never,
      changes: [{ path: ['Configurations', 'synthetic', 'Copilot', 'TaskList'], value: approvedJobList(jobPlan, f.privateDirectory) },
        { path: ['Configurations', 'synthetic', 'Copilot', 'EnableUserAdditional'], value: false }] }, f.maa);
    if (Object.hasOwn(extra, 'stoneCount')) {
      assert.equal(result.reason, 'conflicting-authorizations'); assert.deepEqual(await readFile(f.file), before); return;
    }
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).Configurations.synthetic.TaskQueue.at(-1), open);
  });
});
