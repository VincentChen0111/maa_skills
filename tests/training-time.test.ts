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
  // Ticket 32: an unknown five-hour fact estimates without the reduction and keeps it pending; it never disqualifies the assistant.
  assert.equal(helper(request.facts)?.estimatedSeconds, 2400);
  assert.ok(helper(request.facts)?.issues.includes('assistant:five-hour-reduction-pending:synthetic_reduce'));
  const evidence = { assistantId: 'char_helper', traineeId: 'char_synthetic', seconds: 18000, remainedTogether: true };
  assert.equal(helper({ ...request.facts, previousAssistance: evidence })?.estimatedSeconds, 1200);
  assert.equal(helper({ ...request.facts, previousAssistance: { ...evidence, seconds: 17999 } })?.estimatedSeconds, 2400);
  assert.equal(helper({ ...request.facts, previousAssistance: { ...evidence, remainedTogether: false } })?.estimatedSeconds, 2400);
  assert.equal(helper({ ...request.facts, previousAssistance: { ...evidence, traineeId: 'char_other' } })?.estimatedSeconds, 2400);
});

test('32: a five-hour-condition assistant stays usable for every later tier, estimated without the reduction that is still pending', () => {
  const { tables, snapshot, request } = trainingFixture();
  Object.assign(tables.building.buffs, { synthetic_reduce: { buffName: '合成时长条件', roomType: 'TRAINING', description: '进驻训练室单次协助一名干员训练时长达5小时，则该名干员下次训练所需时间-50%（任意一方离开训练室时，效果消失）' } });
  tables.building.chars.char_helper.buffChar = [{ buffData: [{ buffId: 'synthetic_reduce', cond: { phase: 'PHASE_0', level: 1 } }] }];
  const facts = { ...request.facts, availableAssistants: ['char_helper'] };
  const pending = 'assistant:five-hour-reduction-pending:synthetic_reduce';
  const unknown = calculateTraining(tables, snapshot, { ...request, target: 3, facts });
  assert.equal(unknown.status, 'ok', JSON.stringify(unknown.issues));
  assert.deepEqual(unknown.stages.map(stage => [stage.rank, stage.recommendedAssistant, stage.estimatedSeconds]), [[1, 'char_helper', 3429], [2, 'char_helper', 6858], [3, 'char_helper', 13715]]);
  for (const stage of unknown.stages) assert.ok(stage.assistants.find(row => row.id === 'char_helper')!.issues.includes(pending), String(stage.rank));
  // A confirmed five-hour fact reduces only the next tier; later tiers depend on assistance that has not happened yet.
  const confirmed = calculateTraining(tables, snapshot, { ...request, target: 3, facts: { ...facts,
    previousAssistance: { assistantId: 'char_helper', traineeId: 'char_synthetic', seconds: 18000, remainedTogether: true } } });
  assert.equal(confirmed.status, 'ok');
  assert.deepEqual(confirmed.stages.map(stage => stage.estimatedSeconds), [1715, 6858, 13715]);
  assert.equal(confirmed.stages[0]!.assistants.find(row => row.id === 'char_helper')!.issues.includes(pending), false);
  assert.ok(confirmed.stages[1]!.assistants.find(row => row.id === 'char_helper')!.issues.includes(pending));
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

test('rank conditions add only for the actual rank; a branch condition reads the trainee branch from the tables and is a lower bound without them', () => {
  const { tables, snapshot, request } = trainingFixture();
  tables.building.buffs.synthetic_speed.description = '进驻训练室协助位时，近卫干员的专精技能训练速度+30%，如果本次训练专精技能至2级，则训练速度额外+45%';
  const result = calculateTraining(tables, snapshot, request);
  assert.deepEqual(result.stages.map(stage => stage.assistants.find(row => row.id === 'char_helper')?.speedBonus), [0.35, 0.8]);
  tables.building.buffs.synthetic_speed.description = '进驻训练室协助位时，近卫干员的专精技能训练速度+30%，如果训练位干员分支为合成分支，则训练速度额外+45%';
  // Ticket 32 follow-on OB-5/OB-6: without the branch table the class part stays as a lower bound and the extra is pending.
  const row = () => calculateTraining(tables, snapshot, request).stages[0]?.assistants.find(entry => entry.id === 'char_helper');
  assert.deepEqual([row()?.speedBonus, row()?.lowerBound], [0.35, true]);
  assert.ok(row()?.issues.some(issue => issue.startsWith('assistant:branch-unverified:')));
  Object.assign(tables.modules, { subProfDict: { 'synthetic-branch': { subProfessionId: 'synthetic-branch', subProfessionName: '合成分支' } } });
  assert.deepEqual([row()?.speedBonus, row()?.lowerBound], [0.8, false]);
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
