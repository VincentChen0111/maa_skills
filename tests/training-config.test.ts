import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTrainingChanges, type TrainingGrant } from '../skills/maa-core/scripts/training-config.ts';
import { executeConfigWrite, inspectConfiguration, type MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';

import { configFixture, trainingGrant, trainingConfig } from './fixtures/training-runtime.ts';

test('preplacement uses the existing transaction to install, bind and read back its immutable training-only asset', async t => {
  const f = await configFixture(t), grant = trainingGrant();
  const prepared = buildTrainingChanges(f.config, grant, f.privateDirectory);
  const result = await executeConfigWrite({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true,
    expectedRevision: (await inspectConfiguration(f.maaDirectory)).revision, authorization: { source: 'current-request', reference: 'synthetic', trainingPlan: grant }, changes: prepared.changes }, f.maa);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  const after = JSON.parse(await readFile(f.file, 'utf8')), queue = after.Configurations.synthetic.TaskQueue;
  assert.equal(queue[0].IsEnable, true); assert.equal(queue[1].IsEnable, false); assert.equal(queue[0].ContinueTraining, false);
  assert.deepEqual(queue[0].RoomList, [{ Room: 'Training', IsEnabled: true }, { Room: 'Mfg', IsEnabled: false }]);
  const asset = JSON.parse(await readFile(queue[0].Filename, 'utf8'));
  assert.deepEqual(asset.plans[0].rooms.training, [{ operatorsA: ['合成助手'], operatorsB: ['合成干员'] }]);
  assert.equal(after.Timers.List[0].IsEnabled, null); assert.equal(after.Timers.CustomConfig, true);
  assert.equal((await readdir(join(f.privateDirectory, 'maa-config-backups'))).length, 1);
  assert.equal((await readdir(join(f.maaDirectory, 'config'))).includes('.maa-skills.lock'), false);
  assert.match(await readFile(join(f.privateDirectory, 'daily-pending.jsonl'), 'utf8'), /trainingPlan/);
});

test('training grants reject extra writes, task creation, competing timers, daily slots and missing current authorization', async t => {
  const f = await configFixture(t), grant = trainingGrant(), prepared = buildTrainingChanges(f.config, grant, f.privateDirectory);
  const request = { maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex' as const, closedConfirmed: true,
    expectedRevision: (await inspectConfiguration(f.maaDirectory)).revision, authorization: { source: 'current-request' as const, reference: 'synthetic', trainingPlan: grant }, changes: prepared.changes };
  assert.equal((await executeConfigWrite({ ...request, changes: [...prepared.changes, { path: ['Current'], value: 'other' }] }, f.maa)).status, 'rejected');
  const absent = trainingConfig(); absent.Configurations.synthetic.TaskQueue.pop(); absent.Configurations.synthetic.TaskQueue.pop();
  assert.throws(() => buildTrainingChanges(absent, grant, f.privateDirectory));
  for (const enabled of [true, null]) {
    const used = trainingConfig(); Object.assign(used.Timers.List[0]!, { IsEnabled: enabled });
    assert.throws(() => buildTrainingChanges(used, grant, f.privateDirectory), /not-free/);
  }
  const conflict = trainingConfig(); conflict.Timers.List.push({ Id: 1, IsEnabled: true, Config: 'synthetic', Hour: 4, Minute: 0 });
  assert.throws(() => buildTrainingChanges(conflict, grant, f.privateDirectory), /conflict/);
  assert.equal(await readFile(f.file, 'utf8'), JSON.stringify(f.config));
  assert.equal((await executeConfigWrite({ ...request, authorization: { ...request.authorization, reference: '' } }, f.maa)).status, 'rejected');
});

test('shutdown asset drift blocks writes and restart asset drift retains unknown with original backup and manifest', async t => {
  for (const phase of ['shutdown', 'restart']) {
    const f = await configFixture(t), grant = trainingGrant(), prepared = buildTrainingChanges(f.config, grant, f.privateDirectory);
    let running = true;
    const mutate = async () => { await mkdir(join(f.privateDirectory, 'training-assets'), { recursive: true }); await writeFile(prepared.asset!.file, '{"tampered":true}'); };
    const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }),
      close: async () => { running = false; if (phase === 'shutdown') await mutate(); }, start: async () => { running = true; if (phase === 'restart') await mutate(); } };
    const result = await executeConfigWrite({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex',
      expectedRevision: (await inspectConfiguration(f.maaDirectory)).revision, authorization: { source: 'current-request', reference: 'synthetic', trainingPlan: grant }, changes: prepared.changes }, maa);
    assert.equal(result.status, 'unknown');
    assert.equal((await readdir(join(f.maaDirectory, 'config'))).includes('.maa-skills.lock'), true);
    assert.match(await readFile(join(f.privateDirectory, 'daily-pending.jsonl'), 'utf8'), /trainingManifest/);
    if (phase === 'shutdown') assert.equal(await readFile(f.file, 'utf8'), JSON.stringify(f.config));
    else assert.equal((await readdir(join(f.privateDirectory, 'maa-config-backups'))).length, 1);
  }
});
