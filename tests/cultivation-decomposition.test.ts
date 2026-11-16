// Ticket 32 (owner, 2026-11-16): every finished-material shortage is decomposed into base materials. An LMD shortage
// or an unknown recipe unlock never suppresses the decomposition; LMD is its own gap and unknown unlocks are labelled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCultivationGaps, formatCultivationGapsMarkdown } from '../skills/maa-core/scripts/cultivation-gaps.ts';
import { gapTables, gapSnapshot, gapGoal, gapProgress } from './fixtures/gap-data.ts';

const confirmed = { source: 'user-confirmed', rooms: { WORKSHOP: [3] }, stageRanks: { stage_synthetic: 2 } };

test('32: with unknown unlocks the shortage still decomposes to base materials, and the unlocks are labelled assumptions', () => {
  const tables = gapTables(), snapshot = gapSnapshot();
  const result = calculateCultivationGaps(tables, snapshot, { targets: [gapGoal] });
  const craft = result.comparison!.craft, decomposition = craft.decomposition!;
  assert.deepEqual([craft.materials.mat!.crafted, craft.materials.mat!.remaining], [0, null], 'the conservative coverage route still crafts nothing without confirmed unlocks');
  assert.deepEqual(decomposition.short, { ore: 4 });
  assert.equal(decomposition.craftingLmd, 10);
  assert.deepEqual(decomposition.assumptions.sort(), ['room:WORKSHOP:unknown', 'stage:stage_synthetic:unknown']);
  assert.deepEqual(decomposition.steps.map(step => [step.recipeId, step.output, step.inputs]), [['recipe_mat', { id: 'mat', count: 2 }, { ore: 4 }]]);
  // Voucher advice names what each voucher can exchange among the shortages, without depending on the count.
  assert.deepEqual(decomposition.vouchers, [{ id: 'premium_material_voucher_perm', countKnown: true, validity: 'unknown', choices: [{ item: 'ore', short: 4 }] }]);
  assert.equal(result.comparison!.noCraft.decomposition, undefined, 'the no-craft comparison stays undecomposed');
});

test('32: an LMD shortage does not suppress the decomposition; stock inputs are used and LMD is reported as its own gap', () => {
  const tables = gapTables(), snapshot = gapSnapshot();
  Object.assign(snapshot.items, { ore: 10 }); snapshot.lmd = 0;
  const craft = calculateCultivationGaps(tables, snapshot, { targets: [gapGoal], progress: confirmed }).comparison!.craft;
  assert.ok(craft.blocked.some(block => block.issues.includes('inventory:lmd:insufficient-after-raw-reservation')), 'coverage still needs real LMD');
  const decomposition = craft.decomposition!;
  assert.deepEqual(decomposition.short, {}); assert.deepEqual(decomposition.fromStock, { ore: 4 });
  assert.equal(decomposition.craftingLmd, 10); assert.deepEqual(decomposition.assumptions, []);
  assert.equal(decomposition.lmdGap, craft.lmd.required + 10);
});

test('32: a known-locked recipe makes the finished material itself the thing to obtain, and nothing short means nothing to decompose', () => {
  const tables = gapTables(), snapshot = gapSnapshot();
  const locked = calculateCultivationGaps(tables, snapshot, { targets: [gapGoal], progress: { ...confirmed, stageRanks: { stage_synthetic: 1 } } }).comparison!.craft.decomposition!;
  assert.deepEqual(locked.short, { mat: 2 }); assert.equal(locked.craftingLmd, 0);
  assert.deepEqual(locked.pending, [{ item: 'mat', issues: ['stage:stage_synthetic:insufficient'] }]);
  Object.assign(snapshot.items, { mat: 5 });
  const covered = calculateCultivationGaps(tables, snapshot, { targets: [gapGoal], progress: gapProgress }).comparison!.craft.decomposition!;
  assert.deepEqual([covered.short, covered.fromStock, covered.craftingLmd, covered.steps], [{}, {}, 0, []]);
});

test('32: batch surplus is reused, unknown input stock is a labelled worst case, and the Markdown shows base materials and the LMD gap', () => {
  const tables = gapTables(), snapshot = gapSnapshot();
  Object.assign(tables.building.workshopFormulas.synthetic, { count: 3 });
  delete (snapshot.items as Record<string, number>).ore;
  const result = calculateCultivationGaps(tables, snapshot, { targets: [gapGoal, { name: '合成二号', target: { elite: 1, level: 1 } }], progress: confirmed });
  const decomposition = result.comparison!.craft.decomposition!;
  // Two goals need 4 mat; one batch makes 3, so two batches (6) and the surplus is reused rather than crafted again.
  assert.deepEqual(decomposition.steps.map(step => step.batches), [2]);
  assert.deepEqual(decomposition.short, { ore: 4 }); assert.ok(decomposition.assumptions.includes('inventory:ore:assumed-zero'));
  const markdown = formatCultivationGapsMarkdown(result);
  assert.match(markdown, /加工展开到基础材料/); assert.match(markdown, /ore/); assert.match(markdown, /龙门币缺口/);
});
