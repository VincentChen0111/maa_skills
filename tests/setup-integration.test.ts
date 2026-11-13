import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { executeConfigWrite, executeSetupConfigWrite, inspectConfiguration, inspectConfigRecovery, executeConfigRecovery, type WriteRequest } from '../skills/maa-core/scripts/maa-config.ts';
import { discoverSetupConnections, type AdbBoundary } from '../skills/maa-core/scripts/setup.ts';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { approvedJobFile, approvedJobSourceFile, approvedJobList, type ApprovedJobPlan } from '../skills/maa-core/scripts/stage-job-plan.ts';
import { buildTrainingChanges } from '../skills/maa-core/scripts/training-config.ts';
import { configFixture, trainingGrant } from './fixtures/training-runtime.ts';

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const f = await configFixture(t), home = join(f.root, 'settings'), adbPath = join(f.maaDirectory, 'adb.exe');
  Object.assign(f.config.Configurations.synthetic, {
    Gui: { ConnectSettings: { AdbPath: '', Address: '', AutoDetect: true, AlwaysAutoDetect: true }, RuntimeSettings: { ClientType: 'Official' } },
    Copilot: { TaskList: [], EnableUserAdditional: true },
  });
  await writeFile(f.file, JSON.stringify(f.config)); await writeFile(adbPath, 'synthetic adb');
  await updateSettings({ language: 'en', maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory }, home);
  const content = { opers: [], actions: [] }, hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  const jobPlan: ApprovedJobPlan = { reportHash: 'b'.repeat(64), map: 'synthetic', entries: [{ stageId: 'synthetic', code: 'SYN-1', difficulty: 'normal', difficultyGroup: 'NONE', loops: 1,
    primary: { id: 1, hash, sourceHash: hash, source: { url: 'https://prts.maa.plus/copilot/get/1', readAt: '2026-11-11T01:00:00.000Z' } }, alternates: [] }] };
  const jobFiles = [approvedJobFile(f.privateDirectory, jobPlan.reportHash, 1), approvedJobSourceFile(f.privateDirectory, jobPlan.reportHash, 1)];
  for (const file of jobFiles) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(content)); }
  const jobChanges = [{ path: ['Configurations', 'synthetic', 'Copilot', 'TaskList'], value: approvedJobList(jobPlan, f.privateDirectory) },
    { path: ['Configurations', 'synthetic', 'Copilot', 'EnableUserAdditional'], value: false }];
  const trainingPlan = trainingGrant(), training = buildTrainingChanges(f.config, trainingPlan, f.privateDirectory);
  const adb: AdbBoundary = { run: async (_file, args) => ({ exitCode: 0, stdout: args[0] === 'devices' ? '127.0.0.1:5555 device\n' : args.at(-1) === 'get-state' ? 'device' : 'connected' }) };
  const context = { home, adbPaths: [adbPath], addresses: ['127.0.0.1:5555'] };
  const found = await discoverSetupConnections(context, adb);
  const setup = { discoveryRevision: found.discoveryRevision, host: 'codex' as const, reference: 'synthetic setup request', closedConfirmed: true };
  return { ...f, context, adb, setup, jobPlan, jobChanges, jobFiles, trainingPlan, training };
}

test('setup rejects complete job, training and medicine grants in request or context without creating a transaction', async t => {
  const f = await fixture(t), original = await readFile(f.file), revision = (await inspectConfiguration(f.maaDirectory)).revision;
  // 27: stone and expiring medicine are consumption grants too; the setup entry accepts none of them.
  const expiringMedicine = { days: 2, forActivity: false };
  const extras = [{ jobPlan: f.jobPlan }, { trainingPlan: f.trainingPlan }, { medicineCount: 1 }, { stoneCount: 1 }, { expiringMedicine }, { trainingManifest: f.training.asset },
    { authorization: { source: 'current-request', reference: 'synthetic', jobPlan: f.jobPlan } },
    { authorization: { source: 'current-request', reference: 'synthetic', trainingPlan: f.trainingPlan } },
    { authorization: { source: 'current-request', reference: 'synthetic', medicineCount: 1 } },
    { authorization: { source: 'current-request', reference: 'synthetic', stoneCount: 1 } },
    { authorization: { source: 'current-request', reference: 'synthetic', expiringMedicine } }, { changes: f.jobChanges }, { changes: f.training.changes }];
  for (const extra of extras) {
    assert.equal((await executeSetupConfigWrite({ ...f.setup, ...extra }, f.context, f.adb, f.maa)).reason, 'request-invalid');
    assert.equal((await executeSetupConfigWrite(f.setup, { ...f.context, ...extra }, f.adb, f.maa)).reason, 'request-invalid');
  }
  for (const grant of [{ jobPlan: f.jobPlan }, { trainingPlan: f.trainingPlan }, { medicineCount: 1 }, { stoneCount: 1 }, { expiringMedicine }]) {
    const result = await executeConfigWrite({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
      expectedRevision: revision, authorization: { source: 'current-request', reference: 'synthetic', ...grant },
      changes: [{ path: ['Configurations', 0, 'Gui', 'ConnectSettings', 'Address'], value: '127.0.0.1:5555' }] }, f.maa);
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'request-invalid');
  }
  assert.deepEqual(await readFile(f.file), original);
  for (const file of ['daily-pending.jsonl', 'daily-runs.jsonl']) await assert.rejects(readFile(join(f.privateDirectory, file)), { code: 'ENOENT' });
  await assert.rejects(readdir(join(f.privateDirectory, 'maa-config-backups')), { code: 'ENOENT' });
});

test('setup preserves existing approved jobs, training asset and timer while changing only current connection fields', async t => {
  const f = await fixture(t);
  for (const [grant, changes] of [[{ jobPlan: f.jobPlan }, f.jobChanges], [{ trainingPlan: f.trainingPlan }, f.training.changes]] as const) {
    const result = await executeConfigWrite({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
      expectedRevision: (await inspectConfiguration(f.maaDirectory)).revision, authorization: { source: 'current-request', reference: 'synthetic prior approval', ...grant }, changes: [...changes] }, f.maa);
    assert.equal(result.status, 'complete', JSON.stringify(result));
  }
  assert.ok(f.training.asset);
  const before = JSON.parse(await readFile(f.file, 'utf8')), asset = await readFile(f.training.asset.file), jobs = await Promise.all(f.jobFiles.map(file => readFile(file)));
  const found = await discoverSetupConnections(f.context, f.adb);
  const result = await executeSetupConfigWrite({ ...f.setup, discoveryRevision: found.discoveryRevision }, f.context, f.adb, f.maa);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  const after = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(after.Configurations.synthetic.Gui.ConnectSettings.AutoDetect, false);
  assert.equal(after.Configurations.synthetic.Gui.ConnectSettings.Address, '127.0.0.1:5555');
  after.Configurations.synthetic.Gui.ConnectSettings = before.Configurations.synthetic.Gui.ConnectSettings;
  assert.deepEqual(after, before); assert.deepEqual(await readFile(f.training.asset.file), asset);
  assert.deepEqual(await Promise.all(f.jobFiles.map(file => readFile(file))), jobs);
  const pending = (await readFile(join(f.privateDirectory, 'daily-pending.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(pending.at(-1).skill, 'maa-setup'); assert.deepEqual(Object.keys(pending.at(-1).authorization).sort(), ['reference', 'source']);
  assert.equal(Object.hasOwn(pending.at(-1), 'trainingManifest'), false);
  assert.equal((await readdir(join(f.privateDirectory, 'maa-config-backups'))).length, 3);
  await assert.rejects(readFile(join(f.maaDirectory, 'config/.maa-skills.lock')), { code: 'ENOENT' });
});

test('setup cannot pass interrupted job or training writes and doctor retains their unsupported asset evidence', async t => {
  for (const kind of ['job', 'training'] as const) await t.test(kind, async t => {
    const f = await fixture(t);
    const request: WriteRequest = { maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
      expectedRevision: (await inspectConfiguration(f.maaDirectory)).revision,
      authorization: { source: 'current-request', reference: 'synthetic interruption', ...(kind === 'job' ? { jobPlan: f.jobPlan } : { trainingPlan: f.trainingPlan }) },
      changes: kind === 'job' ? f.jobChanges : f.training.changes };
    const module = new URL('../skills/maa-core/scripts/maa-config.ts', import.meta.url).href;
    const input = `const {executeConfigWrite}=await import(${JSON.stringify(module)}); console.log(JSON.stringify(await executeConfigWrite(${JSON.stringify(request)}, {inspect:async()=>({running:false,treeExited:true,idle:true,ready:false}),close:async()=>{},start:async()=>{throw Error('synthetic restart failure')}})));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-'], { input, encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).status, 'unknown');
    const lock = join(f.maaDirectory, 'config/.maa-skills.lock'), pendingFile = join(f.privateDirectory, 'daily-pending.jsonl');
    const lockBefore = await readFile(lock), configBefore = await readFile(f.file), pendingBefore = await readFile(pendingFile);
    const found = await discoverSetupConnections(f.context, f.adb);
    const setup = await executeSetupConfigWrite({ ...f.setup, discoveryRevision: found.discoveryRevision }, f.context, f.adb, f.maa);
    assert.equal(setup.status, 'unknown'); assert.equal(setup.reason, 'lock-requires-reconciliation');
    const summary = await inspectConfigRecovery(f, f.maa);
    assert.equal(summary.lock, 'stale'); assert.equal(summary.comparison, 'unknown');
    assert.equal(summary.canRestore, false); assert.equal(summary.canReconcile, false);
    for (const action of ['restore-config', 'reconcile-lock'] as const) {
      const result = await executeConfigRecovery({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', action,
        reference: 'synthetic named recovery', evidenceRevision: summary.evidenceRevision, closedConfirmed: true }, f.maa);
      assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'reconciliation-unproven');
    }
    assert.deepEqual(await readFile(lock), lockBefore); assert.deepEqual(await readFile(f.file), configBefore); assert.deepEqual(await readFile(pendingFile), pendingBefore);
  });
});
