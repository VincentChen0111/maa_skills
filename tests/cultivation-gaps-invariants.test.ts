import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCultivationGaps, type GapPlan, type GapResult } from '../skills/maa-core/scripts/cultivation-gaps.ts';
import { calculateOperatorCost } from '../skills/maa-core/scripts/operator-cost.ts';
import { gapTables, gapSnapshot, gapProgress } from './fixtures/gap-data.ts';

const voucherIds = [
  'precious_material_voucher_perm', 'premium_material_voucher_perm', 'advanced_material_voucher_perm',
  'premium_material_issue_voucher', 'advanced_material_issue_voucher',
];
type Formula = {
  formulaId: string; formulaType: string; itemId: string; count: number; goldCost: number; apCost: number;
  costs: { id: string; count: number; type: string }[];
  requireRooms: { roomId: string; roomLevel: number; roomCount: number }[];
  requireStages: { stageId: string; rank: number }[];
};
function formula(output: string, inputs: Record<string, number>, outputCount = 1, fee = 1): Formula {
  return { formulaId: `synthetic_${output}`, formulaType: 'F_EVOLVE', itemId: output, count: outputCount,
    goldCost: fee, apCost: 360000, costs: Object.entries(inputs).map(([id, count]) => ({ id, count, type: 'MATERIAL' })),
    requireRooms: [{ roomId: 'WORKSHOP', roomLevel: 3, roomCount: 1 }], requireStages: [{ stageId: 'stage_synthetic', rank: 2 }] };
}
function scenario(demands: Record<string, number>[], recipes: Formula[], inventory: Record<string, number | null>, spareLmd: number | null = 20,
  choices: Record<string, string[]> = {}) {
  const base = gapTables(), originalSnapshot = gapSnapshot();
  const characters: Record<string, typeof base.characters.char_synthetic> = {};
  const targets = demands.map((demand, index) => {
    const id = `char_case_${index}`, name = `合成目标${index}`;
    const character = structuredClone(base.characters.char_synthetic);
    character.name = name; character.phases[1]!.evolveCost = Object.entries(demand).map(([id, count]) => ({ id, count, type: 'MATERIAL' }));
    characters[id] = character;
    return { name, target: { elite: 1, level: 1 } };
  });
  const items: Record<string, { name: string; itemType?: string; voucherRelateList?: { voucherId: string; voucherItemType: string }[] }> = {
    ...base.items.items,
  };
  // Remove the baseline voucher relation: every scenario supplies its own eligibility graph.
  items.ore = { name: '合成下级材料' };
  for (const [id, vouchers] of Object.entries(choices)) items[id] = { name: `合成${id}`,
    voucherRelateList: vouchers.map(voucherId => ({ voucherId, voucherItemType: 'MATERIAL_ISSUE_VOUCHER' })) };
  for (const id of voucherIds) items[id] = { name: `合成券${id}`, itemType: 'MATERIAL_ISSUE_VOUCHER' };
  const tables = { ...base, characters, items: { ...base.items, items },
    building: { workshopFormulas: Object.fromEntries(recipes.map(row => [row.formulaId, row])), manufactFormulas: {} } };
  const inventoryItems: Record<string, number | null> = { exp_card: demands.length, ...inventory };
  const snapshot = { ...originalSnapshot, items: inventoryItems, lmd: spareLmd === null ? null : 102 * demands.length + spareLmd,
    operators: targets.map((target, index) => ({ ...originalSnapshot.operators[0]!, id: `char_case_${index}`, name: target.name })) };
  const progress: { source: string; rooms: Record<string, number[]>; stageRanks: Record<string, number>; voucherValidity: Record<string, boolean> } = {
    ...structuredClone(gapProgress), voucherValidity: Object.fromEntries(voucherIds.map(id => [id, true])),
  };
  return { tables, snapshot, input: { targets, progress }, recipes, demands };
}
type Scenario = ReturnType<typeof scenario>;

function sum(rows: number[]) { return rows.reduce((total, value) => total + value, 0); }
function nullableSum(rows: (number | null)[]) { return rows.some(row => row === null) ? null : sum(rows.map(row => row!)); }

/** Reconstruct resources from the fixture recipes and observed inventory, not from the reported ledger. */
function verifyPlan(plan: GapPlan, sample: Scenario, raw: NonNullable<GapResult['raw']>) {
  const inventory: Record<string, number | null> = sample.snapshot.items;
  const stock = new Map<string, number | null>(), consumed = new Map<string, number>(), produced = new Map<string, number>(), redeemed = new Map<string, number>();
  const increment = (map: Map<string, number>, id: string, count: number) => map.set(id, (map.get(id) ?? 0) + count);
  const balance = (id: string): number | null => {
    if (!stock.has(id)) stock.set(id, inventory[id] ?? null);
    return stock.get(id)!;
  };
  const spend = (id: string, count: number) => {
    const available = balance(id);
    assert.notEqual(available, null, `${id}: cannot spend unknown inventory`);
    assert.ok(available! >= count, `${id}: attempted ${count} from ${available}`);
    stock.set(id, available! - count);
  };
  const add = (id: string, count: number) => {
    assert.notEqual(balance(id), null, `${id}: cannot claim a known balance from unknown inventory`);
    stock.set(id, balance(id)! + count);
  };
  for (const [id, required] of Object.entries(raw.materials)) {
    const available = balance(id);
    if (available !== null) spend(id, Math.min(required, available));
  }
  const recipeById = new Map(sample.recipes.map(row => [row.formulaId, row]));
  let fees = 0;
  for (const route of plan.route) {
    if (route.kind === 'voucher') {
      const { voucherId, itemId, count } = route.allocation;
      assert.ok(Number.isSafeInteger(count) && count > 0);
      assert.equal(sample.input.progress.voucherValidity[voucherId], true, 'only confirmed valid vouchers can be used');
      assert.ok(sample.tables.items.items[itemId]?.voucherRelateList?.some(row => row.voucherId === voucherId));
      spend(voucherId, count); increment(consumed, voucherId, count);
      add(itemId, count); increment(redeemed, itemId, count);
      continue;
    }
    const step = route.step, recipe = recipeById.get(step.recipeId);
    assert.ok(recipe, `unknown recipe ${step.recipeId}`);
    assert.ok(Number.isSafeInteger(step.batches) && step.batches > 0);
    const expectedInputs: Record<string, number> = {};
    for (const input of recipe.costs) expectedInputs[input.id] = (expectedInputs[input.id] ?? 0) + input.count * step.batches;
    assert.deepEqual(step.inputs, expectedInputs, 'step inputs must agree with the supplied recipe');
    assert.deepEqual(step.output, { id: recipe.itemId, count: recipe.count * step.batches });
    assert.equal(step.lmd, recipe.goldCost * step.batches);
    for (const [id, count] of Object.entries(expectedInputs)) { spend(id, count); increment(consumed, id, count); }
    add(recipe.itemId, recipe.count * step.batches); increment(produced, recipe.itemId, recipe.count * step.batches);
    fees += recipe.goldCost * step.batches;
    assert.ok(fees <= (sample.snapshot.lmd === null ? 0 : Math.max(0, sample.snapshot.lmd - raw.lmd)), 'crafting must preserve every target LMD requirement');
  }
  assert.deepEqual(plan.route.flatMap(route => route.kind === 'craft' ? [route.step] : []), plan.steps);
  assert.deepEqual(plan.route.flatMap(route => route.kind === 'voucher' ? [route.allocation] : []), plan.voucherAllocations);
  assert.equal(plan.lmd.required, raw.lmd + fees);
  assert.equal(plan.lmd.existing, sample.snapshot.lmd === null ? null : Math.min(raw.lmd + fees, sample.snapshot.lmd));
  assert.equal(plan.lmd.remaining, sample.snapshot.lmd === null ? null : Math.max(0, raw.lmd + fees - sample.snapshot.lmd));
  for (const [id, row] of Object.entries(plan.materials)) {
    assert.equal(row.required, raw.materials[id]);
    assert.equal(row.available, inventory[id] ?? null);
    assert.equal(row.existing, inventory[id] == null ? null : Math.min(row.required, inventory[id]));
    if (balance(id) !== null) spend(id, row.crafted + row.voucher);
    const shares = plan.targets.map(target => target.materials[id]).filter(row => row !== undefined);
    for (const field of ['required', 'existing', 'crafted', 'voucher', 'remaining'] as const) {
      assert.equal(nullableSum(shares.map(share => share[field])), row[field], `${id}: target ${field} must sum to the total`);
    }
    if (row.remaining !== null) assert.equal(row.existing! + row.crafted + row.voucher + row.remaining, row.required);
  }
  assert.equal(plan.targets.length, sample.demands.length);
  for (const [index, target] of plan.targets.entries()) {
    assert.equal(target.operatorId, `char_case_${index}`);
    assert.deepEqual(Object.fromEntries(Object.entries(target.materials).map(([id, row]) => [id, row.required])), sample.demands[index]);
    assert.equal(target.lmd.required, 102);
    assert.equal(target.exp.required, 20);
  }
  assert.equal(sum(plan.targets.map(target => target.lmd.required)), raw.lmd);
  assert.equal(nullableSum(plan.targets.map(target => target.lmd.existing)), sample.snapshot.lmd === null ? null : Math.min(raw.lmd, sample.snapshot.lmd));
  assert.equal(nullableSum(plan.targets.map(target => target.lmd.remaining)), sample.snapshot.lmd === null ? null : Math.max(0, raw.lmd - sample.snapshot.lmd));
  assert.equal(sum(plan.targets.map(target => target.exp.required)), raw.exp);
  for (const field of ['existing', 'crafted', 'voucher', 'remaining'] as const) {
    assert.equal(nullableSum(plan.targets.map(target => target.exp[field])), plan.exp[field], `experience ${field} must sum to the total`);
  }
  for (const [id, row] of Object.entries(plan.ledger)) {
    assert.equal(row.opening, inventory[id] ?? null, `${id}: opening must equal the supplied inventory`);
    assert.equal(row.consumed, consumed.get(id) ?? 0, `${id}: consumed must follow actual recipes and redemptions`);
    assert.equal(row.crafted, produced.get(id) ?? 0, `${id}: crafted must follow recipe batch outputs`);
    assert.equal(row.voucher, redeemed.get(id) ?? 0, `${id}: voucher additions must follow redemptions`);
    const demand = plan.materials[id];
    assert.equal(row.allocated, demand ? (demand.existing ?? 0) + demand.crafted + demand.voucher : 0);
    assert.equal(row.closing, balance(id), `${id}: closing must match independent replay`);
    if (row.opening !== null) assert.equal(row.opening + row.crafted + row.voucher, row.allocated + row.consumed + row.closing!);
    else assert.equal(row.closing, null);
  }
  for (const id of stock.keys()) assert.ok(plan.ledger[id], `${id}: every affected material needs a ledger row`);
  for (const voucher of plan.vouchers) {
    const used = sum(plan.voucherAllocations.filter(row => row.voucherId === voucher.id).map(row => row.count));
    assert.equal(voucher.used, used);
    assert.equal(voucher.available, inventory[voucher.id] ?? null);
    assert.equal(voucher.remaining, balance(voucher.id));
    if (used) { assert.equal(voucher.validity, 'confirmed-valid'); assert.ok(used <= inventory[voucher.id]!); }
  }
}
function verify(sample: Scenario) {
  const before = structuredClone(sample);
  const result = calculateCultivationGaps(sample.tables, sample.snapshot, sample.input);
  assert.ok(result.raw && result.comparison, JSON.stringify(result.issues));
  const expectedRaw = { materials: {}, lmd: 102 * sample.demands.length, exp: 20 * sample.demands.length };
  for (const demand of sample.demands) for (const [id, count] of Object.entries(demand)) {
    const materials: Record<string, number> = expectedRaw.materials; materials[id] = (materials[id] ?? 0) + count;
  }
  assert.deepEqual(result.raw, expectedRaw, 'coverage cannot rewrite the original per-goal cost');
  const costs = sample.input.targets.map(target => calculateOperatorCost(sample.tables, sample.snapshot, { ...target, mode: 'raw' }));
  assert.deepEqual(result.costs, costs, 'issue 13 raw queries remain unchanged by coverage calculations');
  for (const plan of Object.values(result.comparison)) verifyPlan(plan, sample, result.raw);
  assert.deepEqual(result.comparison.noCraft.steps, []);
  assert.ok(result.comparison.noCraft.route.every(step => step.kind === 'voucher'));
  const otherMode = calculateCultivationGaps(sample.tables, sample.snapshot, { ...sample.input, mode: 'no-craft' });
  assert.equal(otherMode.selected, 'no-craft');
  assert.deepEqual(otherMode.comparison, result.comparison, 'each comparison must start with a fresh inventory');
  assert.deepEqual(calculateCultivationGaps(sample.tables, sample.snapshot, sample.input), result, 'identical input gives a deterministic result');
  assert.deepEqual(sample, before, 'suggestions must not mutate caller-owned inputs');
  return result.comparison;
}

test('small shared-stock cases replay independently with raw reservation and finite crafting fees', () => {
  for (const mat of [0, 1, 3]) for (const ore of [0, 1, 3, 5]) for (const dust of [0, 2, 5]) for (const spare of [0, 1, 4, 10]) {
    const sample = scenario([{ mat: 2 }, { ore: 1, mat: 1 }], [formula('mat', { ore: 2 }, 2, 2), formula('ore', { dust: 2 }, 3, 1)],
      { mat, ore, dust }, spare);
    assert.doesNotThrow(() => verify(sample), `inventory ${JSON.stringify({ mat, ore, dust, spare })}`);
  }
});

test('overlapping direct vouchers and voucher-fed multilevel recipes conserve every candidate stock', () => {
  const broad = voucherIds[0]!, narrow = voucherIds[1]!, lower = voucherIds[3]!;
  for (const ore of [0, 1, 3]) for (const broadCount of [0, 1, 3]) for (const narrowCount of [0, 1, 2]) for (const spare of [0, 3, 9]) {
    const sample = scenario([{ mat: 2 }, { other: 1, ore: 1 }],
      [formula('mat', { ore: 2 }, 1, 2), formula('ore', { dust: 1 }, 3, 1)],
      { mat: 0, other: 0, ore, dust: 0, [broad]: broadCount, [narrow]: narrowCount, [lower]: 2 }, spare,
      { mat: [broad, narrow], other: [broad], dust: [lower] });
    assert.doesNotThrow(() => verify(sample), JSON.stringify({ ore, broadCount, narrowCount, spare }));
  }
});

test('each of the five voucher categories requires explicit validity and known stock, including permanent-name IDs', () => {
  for (const voucherId of voucherIds) for (const count of [0, 1, 3, null]) for (const validity of [true, false, undefined]) {
    const sample = scenario([{ mat: 2 }], [], { mat: 0, [voucherId]: count }, 0, { mat: [voucherId] });
    if (validity === undefined) delete sample.input.progress.voucherValidity[voucherId];
    else sample.input.progress.voucherValidity[voucherId] = validity;
    const { craft, noCraft } = verify(sample);
    const expectedCovered = validity === true && count !== null ? Math.min(2, count) : 0;
    for (const plan of [craft, noCraft]) {
      assert.equal(plan.materials.mat!.voucher, expectedCovered);
      assert.equal(plan.vouchers[0]!.used, expectedCovered);
      const uncertain = count !== 0 && validity !== false && (validity === undefined || count === null);
      assert.equal(plan.materials.mat!.remaining, uncertain ? null : 2 - expectedCovered);
    }
  }
});

test('a failed route rolls back earlier child production, voucher exchange, inputs, and fees together', () => {
  const voucher = voucherIds[2]!;
  for (const failure of ['late-material', 'late-fee'] as const) {
    const sample = scenario([{ mat: 1 }], [formula('mat', { ore: 1, gate: 1 }, 1, 2), formula('ore', { dust: 1 }, 2, 1)],
      { mat: 0, ore: 0, dust: 0, gate: failure === 'late-material' ? 0 : 1, [voucher]: 1 }, failure === 'late-fee' ? 1 : 10,
      { dust: [voucher] });
    const { craft } = verify(sample);
    assert.equal(craft.materials.mat!.remaining, 1);
    assert.deepEqual(craft.route, []);
    assert.deepEqual(craft.steps, []);
    assert.deepEqual(craft.voucherAllocations, []);
    assert.equal(craft.vouchers[0]!.used, 0);
    assert.equal(craft.vouchers[0]!.remaining, 1);
    assert.equal(craft.lmd.required, 102);
    for (const entry of Object.values(craft.ledger)) { assert.equal(entry.consumed, 0); assert.equal(entry.crafted, 0); assert.equal(entry.voucher, 0); }
  }
});

test('unknown target stock, ingredient stock, LMD, and recipe conditions are never assumed sufficient', () => {
  for (const field of ['target', 'ingredient', 'lmd', 'room', 'stage'] as const) {
    const sample = scenario([{ mat: 2 }], [formula('mat', { ore: 1 }, 1, 1)],
      { mat: field === 'target' ? null : 0, ore: field === 'ingredient' ? null : 2 }, field === 'lmd' ? null : 10);
    if (field === 'room') delete sample.input.progress.rooms.WORKSHOP;
    if (field === 'stage') delete sample.input.progress.stageRanks.stage_synthetic;
    const { craft } = verify(sample);
    assert.equal(craft.materials.mat!.crafted, 0);
    assert.deepEqual(craft.steps, []);
    assert.equal(craft.materials.mat!.remaining, null);
  }
  for (const id of ['mat', 'ore']) {
    const sample = scenario([{ mat: 2 }], [formula('mat', { ore: 1 })], { mat: 0, ore: 2 });
    delete sample.snapshot.items[id];
    const { craft } = verify(sample);
    assert.equal(craft.materials.mat!.remaining, null);
    assert.deepEqual(craft.steps, []);
  }
});

test('fixed-seed branching routes remain feasible when targets, input stock, batch sizes, and vouchers compete', () => {
  let seed = 0x14c0ffee;
  const integer = (maximum: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  const broad = voucherIds[0]!, narrow = voucherIds[2]!, lower = voucherIds[4]!;
  for (let index = 0; index < 160; index++) {
    const sample = scenario([{ mat: 1 + integer(3), ore: 1 + integer(2) }, { other: 1 + integer(3), mat: 1 + integer(2) }],
      [formula('mat', { ore: 1 + integer(3), other: 1 + integer(2) }, 1 + integer(3), integer(4)),
        formula('other', { ore: 1 + integer(2) }, 1 + integer(3), integer(3)),
        formula('ore', { dust: 1 + integer(3) }, 1 + integer(3), integer(3))],
      { mat: integer(4), other: integer(4), ore: integer(5), dust: integer(6),
        [broad]: integer(4), [narrow]: integer(4), [lower]: integer(4) }, integer(15) - 3,
      { mat: [broad], other: [broad, narrow], ore: [broad], dust: [lower] });
    assert.doesNotThrow(() => verify(sample), `seed=0x14c0ffee case=${index}`);
  }
});
