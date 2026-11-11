import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTraining } from '../skills/maa-core/scripts/training-time.ts';
import { trainingFixture } from './fixtures/training-data.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('approved training uses shared costs, real ownership and active skills to estimate each next rank', () => {
  const { tables, snapshot, request } = trainingFixture();
  const result = calculateTraining(tables, snapshot, request);
  assert.equal(result.status, 'ok');
  assert.equal(result.operator?.id, 'char_synthetic');
  assert.equal(result.materials.raw?.materials.mat, 3);
  assert.deepEqual(result.stages.map(stage => [stage.rank, stage.recommendedAssistant, stage.estimatedSeconds]), [[1, 'char_helper', 2400], [2, 'char_helper', 4800]]);
  assert.equal(result.stages[0]?.assistants.find(row => row.id === 'char_locked')?.speedBonus, 0.3);
  assert.equal(result.skillName, '合成技能');
});

test('five-hour reduction requires continuous same-person evidence and cannot be replaced by the native mentor score', () => {
  const { tables, snapshot, request } = trainingFixture();
  Object.assign(tables.building.buffs, { synthetic_reduce: { buffName: '合成时长条件', roomType: 'TRAINING', description: '进驻训练室单次协助一名干员训练时长达5小时，则该名干员下次训练所需时间-50%（任意一方离开训练室时，效果消失）' } });
  tables.building.chars.char_helper.buffChar.push({ buffData: [{ buffId: 'synthetic_reduce', cond: { phase: 'PHASE_0', level: 1 } }] });
  const helper = (facts: unknown) => calculateTraining(tables, snapshot, { ...request, target: 1, facts }).stages[0]?.assistants.find(row => row.id === 'char_helper');
  assert.equal(helper(request.facts)?.estimatedSeconds, null);
  const evidence = { assistantId: 'char_helper', traineeId: 'char_synthetic', seconds: 18000, remainedTogether: true };
  assert.equal(helper({ ...request.facts, previousAssistance: evidence })?.estimatedSeconds, 1200);
  assert.equal(helper({ ...request.facts, previousAssistance: { ...evidence, seconds: 17999 } })?.estimatedSeconds, 2400);
  assert.equal(helper({ ...request.facts, previousAssistance: { ...evidence, remainedTogether: false } })?.estimatedSeconds, 2400);
  assert.equal(helper({ ...request.facts, previousAssistance: { ...evidence, traineeId: 'char_other' } })?.estimatedSeconds, 2400);
});

test('the installed query CLI reads synthetic files and renders the same computed ranks in English', async t => {
  const root = await mkdtemp(join(tmpdir(), 'training-query-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { tables, snapshot, request } = trainingFixture();
  await writeFile(join(root, 'config.json'), JSON.stringify({ language: 'en', privateDirectory: root }));
  await writeFile(join(root, 'account-snapshot.json'), JSON.stringify(snapshot));
  await writeFile(join(root, 'tables.json'), JSON.stringify(tables));
  const run = (format: string) => spawnSync(process.execPath, [resolve('skills/maa-core/scripts/training-time.ts'), 'query'], {
    input: JSON.stringify({ ...request, tablesFile: join(root, 'tables.json'), format }), encoding: 'utf8', env: { ...process.env, MAA_SKILLS_HOME: root } });
  const json = run('json'); assert.equal(json.status, 0, json.stderr); assert.equal(JSON.parse(json.stdout).result.stages[0].estimatedSeconds, 2400);
  const md = run('markdown'); assert.equal(md.status, 0, md.stderr); assert.match(md.stdout, /Training estimate/); assert.match(md.stdout, /2400/);
});

test('rank conditions add only for the actual rank and unresolved branch conditions stay unknown', () => {
  const { tables, snapshot, request } = trainingFixture();
  tables.building.buffs.synthetic_speed.description = '进驻训练室协助位时，近卫干员的专精技能训练速度+30%，如果本次训练专精技能至2级，则训练速度额外+45%';
  const result = calculateTraining(tables, snapshot, request);
  assert.deepEqual(result.stages.map(stage => stage.assistants.find(row => row.id === 'char_helper')?.speedBonus), [0.35, 0.8]);
  tables.building.buffs.synthetic_speed.description = '进驻训练室协助位时，近卫干员的专精技能训练速度+30%，如果训练位干员分支为合成分支，则训练速度额外+45%';
  assert.equal(calculateTraining(tables, snapshot, request).stages[0]?.assistants.find(row => row.id === 'char_helper')?.speedBonus, null);
  assert.equal(calculateTraining(tables, snapshot, { ...request, facts: { ...request.facts, branchName: '合成分支' } }).stages[0]?.assistants.find(row => row.id === 'char_helper')?.speedBonus, 0.8);
});

test('mood clauses are retained without treating them as speed, and post-start recommendations exclude the prior-stage reduction', () => {
  const { tables, snapshot, request } = trainingFixture();
  tables.building.buffs.synthetic_speed.description = '进驻训练室协助位时，近卫与狙击干员的专精技能训练速度+50%，心情每小时消耗+1';
  Object.assign(tables.building.buffs, { synthetic_reduce: { buffName: '合成时长条件', roomType: 'TRAINING', description: '进驻训练室单次协助一名干员训练时长达5小时，则该名干员下次训练所需时间-50%（任意一方离开训练室时，效果消失）' } });
  tables.building.chars.char_locked.buffChar.push({ buffData: [{ buffId: 'synthetic_reduce', cond: { phase: 'PHASE_0', level: 1 } }] });
  const result = calculateTraining(tables, snapshot, { ...request, target: 1, facts: { ...request.facts,
    previousAssistance: { assistantId: 'char_locked', traineeId: 'char_synthetic', seconds: 18000, remainedTogether: true } } });
  assert.equal(result.stages[0]?.recommendedAssistant, 'char_locked');
  assert.equal(result.stages[0]?.afterStartAssistant, 'char_helper');
  assert.equal(result.stages[0]?.assistants.find(row => row.id === 'char_helper')?.speedBonus, 0.55);
  assert.match(result.stages[0]!.assistants[0]!.conditions.join(''), /心情/);
});
