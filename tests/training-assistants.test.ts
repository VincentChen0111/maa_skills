import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { calculateTraining } from '../skills/maa-core/scripts/training-time.ts';
import { prepareTrainingPlan } from '../skills/maa-core/scripts/training-plan.ts';
import { trainingFixture } from './fixtures/training-data.ts';
import { configFixture } from './fixtures/training-runtime.ts';

type Fixture = ReturnType<typeof trainingFixture>;
const ordinary = (f: Fixture) => Object.assign(f.tables.building.buffs.synthetic_speed, { roomType: 'MANUFACTURE', description: '进驻制造站时，生产力+15%' });
const selectHelper = (f: Fixture) => { f.request.facts.availableAssistants = ['char_helper']; return f; };
async function prepare(t: { after(fn: () => Promise<unknown>): void }, f: Fixture) {
  const runtime = await configFixture(t), before = await readFile(runtime.file);
  await writeFile(join(runtime.root, 'config.json'), JSON.stringify({ language: 'en', maaDirectory: runtime.maaDirectory, privateDirectory: runtime.privateDirectory }));
  const snapshotFile = join(runtime.root, 'snapshot.json'), tablesFile = join(runtime.root, 'tables.json');
  await writeFile(snapshotFile, JSON.stringify(f.snapshot)); await writeFile(tablesFile, JSON.stringify(f.tables));
  try {
    return await prepareTrainingPlan({ query: { ...f.request, snapshotFile, tablesFile }, currentTrainee: null,
      binding: { profile: 0, infrastTask: 0, progressTask: 1, timer: 0 }, authorization: { source: 'current-request', reference: 'synthetic approved training' } }, { home: runtime.root });
  } finally { assert.deepEqual(await readFile(runtime.file), before); }
}

test('known ordinary and locked-training assistants use the base bonus and can prepare the approved target', async t => {
  for (const kind of ['ordinary', 'no-skills', 'locked-training', 'active-training']) {
    const f = selectHelper(trainingFixture());
    if (kind === 'ordinary') ordinary(f);
    if (kind === 'no-skills') f.tables.building.chars.char_helper.buffChar = [];
    if (kind === 'locked-training') f.tables.building.chars.char_helper.buffChar[0]!.buffData[0]!.cond.phase = 'PHASE_2';
    if (kind === 'locked-training') f.snapshot.operators.find(row => row.id === 'char_helper')!.elite = 0;
    const before = JSON.stringify(f), result = calculateTraining(f.tables, f.snapshot, f.request), stage = result.stages[0]!;
    const helper = stage.assistants.find(row => row.id === 'char_helper');
    assert.ok(helper, kind); assert.equal(result.status, 'ok', kind);
    assert.equal(helper.speedBonus, kind === 'active-training' ? 0.5 : 0.05, kind);
    assert.equal(stage.estimatedSeconds, kind === 'active-training' ? 2400 : 3429, kind);
    assert.equal(stage.recommendedAssistant, 'char_helper', kind);
    assert.equal(JSON.stringify(f), before);
    const plan = await prepare(t, f); assert.equal(plan.state, 'pending'); assert.equal(plan.assistants['1'], '合成助手');
  }
});

test('missing or incomplete assistant source facts remain unknown instead of becoming zero extra bonus', async t => {
  const mutations: [string, (f: Fixture) => void][] = [
    ['building entry', f => { Reflect.deleteProperty(f.tables.building.chars, 'char_helper'); }],
    ['character entry', f => { Reflect.deleteProperty(f.tables.characters, 'char_helper'); }],
    ['buff entry', f => { Reflect.deleteProperty(f.tables.building.buffs, 'synthetic_speed'); }],
    ['buff name', f => { Reflect.deleteProperty(f.tables.building.buffs.synthetic_speed, 'buffName'); }],
    ['buff description', f => { Reflect.deleteProperty(f.tables.building.buffs.synthetic_speed, 'description'); }],
    ['empty description', f => { f.tables.building.buffs.synthetic_speed.description = ''; }],
    ['room missing', f => { Reflect.deleteProperty(f.tables.building.buffs.synthetic_speed, 'roomType'); }],
    ['room unknown', f => { f.tables.building.buffs.synthetic_speed.roomType = 'SYNTHETIC_UNKNOWN_ROOM'; }],
    ['unlock definition', f => { Reflect.deleteProperty(f.tables.building.chars.char_helper.buffChar[0]!.buffData[0]!, 'cond'); }],
    ['training unlock unobserved', f => { f.tables.building.buffs.synthetic_speed.roomType = 'TRAINING'; Object.assign(f.snapshot.operators.find(row => row.id === 'char_helper')!, { elite: null }); }],
  ];
  for (const [label, mutate] of mutations) {
    const f = selectHelper(trainingFixture()); ordinary(f); mutate(f);
    const result = calculateTraining(f.tables, f.snapshot, f.request), stage = result.stages[0]!, helper = stage.assistants.find(row => row.id === 'char_helper');
    assert.ok(helper, label); assert.equal(helper.speedBonus, null, label); assert.equal(helper.estimatedSeconds, null, label);
    assert.equal(stage.recommendedAssistant, null, label); assert.equal(result.status, 'needs-input', label);
    await assert.rejects(prepare(t, f), /training-facts-required/, label);
  }
});

test('malformed assistant table structures retain the shared input rejection and never prepare a plan', async t => {
  const mutations: [string, (f: Fixture) => void][] = [
    ['buffChar missing', f => { Reflect.deleteProperty(f.tables.building.chars.char_helper, 'buffChar'); }],
    ['buffChar malformed', f => { Object.assign(f.tables.building.chars.char_helper, { buffChar: {} }); }],
    ['buffData missing', f => { Reflect.deleteProperty(f.tables.building.chars.char_helper.buffChar[0]!, 'buffData'); }],
    ['buffData malformed', f => { Object.assign(f.tables.building.chars.char_helper.buffChar[0]!, { buffData: {} }); }],
    ['slot malformed', f => { Object.assign(f.tables.building.chars.char_helper, { buffChar: [null] }); }],
    ['buff id missing', f => { Reflect.deleteProperty(f.tables.building.chars.char_helper.buffChar[0]!.buffData[0]!, 'buffId'); }],
    ['buff object malformed', f => { Object.assign(f.tables.building.buffs, { synthetic_speed: [] }); }],
    ['unlock object malformed', f => { Object.assign(f.tables.building.chars.char_helper.buffChar[0]!.buffData[0]!, { cond: 1 }); }],
  ];
  for (const [label, mutate] of mutations) {
    const f = selectHelper(trainingFixture()); ordinary(f); mutate(f);
    assert.throws(() => calculateTraining(f.tables, f.snapshot, f.request), /base-data-invalid/, label);
    await assert.rejects(prepare(t, f), /base-data-invalid/, label);
  }
});

test('non-training unlock uncertainty does not invent a training bonus or hide known base-only availability', async t => {
  const f = selectHelper(trainingFixture()); ordinary(f);
  Object.assign(f.snapshot.operators.find(row => row.id === 'char_helper')!, { elite: null, level: null });
  const result = calculateTraining(f.tables, f.snapshot, f.request), helper = result.stages[0]!.assistants.find(row => row.id === 'char_helper');
  assert.equal(result.status, 'ok'); assert.equal(helper?.speedBonus, 0.05); assert.equal(helper?.estimatedSeconds, 3429);
  assert.deepEqual(helper?.conditions, []); assert.equal((await prepare(t, f)).state, 'pending');
});

test('ordinary assistants still require observed ownership and confirmed availability and exclude the trainee', async t => {
  for (const kind of ['not-listed', 'unconfirmed', 'unowned', 'trainee-only']) {
    const f = selectHelper(trainingFixture()); ordinary(f);
    if (kind === 'not-listed') f.request.facts.availableAssistants = [];
    if (kind === 'unconfirmed') f.request.facts.source = 'unverified';
    if (kind === 'unowned') f.snapshot.operators = f.snapshot.operators.filter(row => row.id !== 'char_helper');
    if (kind === 'trainee-only') f.request.facts.availableAssistants = ['char_synthetic'];
    const result = calculateTraining(f.tables, f.snapshot, f.request), stage = result.stages[0]!;
    assert.equal(stage.recommendedAssistant, null, kind); assert.equal(result.status, 'needs-input', kind);
    assert.equal(stage.assistants.some(row => row.id === 'char_synthetic'), false, kind);
    if (kind === 'unowned') assert.equal(stage.assistants.some(row => row.id === 'char_helper'), false);
    else assert.equal(stage.assistants.find(row => row.id === 'char_helper')?.speedBonus, 0.05, kind);
    await assert.rejects(prepare(t, f), /training-facts-required/, kind);
  }
});

test('other-room skills are not parsed as active training effects', () => {
  const f = selectHelper(trainingFixture());
  Object.assign(f.tables.building.buffs, { synthetic_other: { buffName: '合成其他房间', roomType: 'MANUFACTURE', description: '进驻制造站时，生产力+95%' } });
  f.tables.building.chars.char_helper.buffChar.push({ buffData: [{ buffId: 'synthetic_other', cond: { phase: 'PHASE_0', level: 1 } }] });
  const result = calculateTraining(f.tables, f.snapshot, f.request), helper = result.stages[0]!.assistants.find(row => row.id === 'char_helper');
  assert.equal(result.status, 'ok'); assert.equal(helper?.speedBonus, 0.5); assert.equal(helper?.estimatedSeconds, 2400);
  assert.deepEqual(helper?.conditions, ['进驻训练室协助位时，近卫干员的专精技能训练速度+45%']);
});
