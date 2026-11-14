// Deterministic coverage suggestions; never executes crafting or voucher exchange.
import { calculateOperatorCost, loadOperatorCostTables, formatOperatorCostMarkdown, operatorCostSources, type CostTables, type CostResult } from './operator-cost.ts';
import { readPublicJson, type PublicJsonSource } from './public-data.ts';
import { readSettings } from './preferences.ts';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, stdinJsonCode } from './stdin-json.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
type Cost = NonNullable<CostResult['total']>;
export type GapTables = CostTables & { building: unknown; stages: unknown };
export type GapRow = { required: number; available: number | null; existing: number | null; crafted: number; voucher: number; remaining: number | null };
type TargetShare = Omit<GapRow, 'available'>;
type LedgerEntry = { opening: number | null; allocated: number; consumed: number; crafted: number; voucher: number; closing: number | null };
type CraftStep = { recipeId: string; kind: string; batches: number; inputs: Record<string, number>; output: { id: string; count: number }; lmd: number; baseMorale: number;
  requirements: { rooms: unknown[]; stages: unknown[] } };
type VoucherAllocation = { voucherId: string; itemId: string; count: number };
type RouteStep = { kind: 'voucher'; allocation: VoucherAllocation } | { kind: 'craft'; step: CraftStep };
export type GapPlan = { materials: Record<string, GapRow>; lmd: GapRow; exp: GapRow; steps: CraftStep[];
  ledger: Record<string, LedgerEntry>; blocked: { item: string; issues: string[] }[];
  vouchers: { id: string; available: number | null; used: number; remaining: number | null; rule: 'permanent-name-inference' | 'timed-explicit' | 'unverified';
    validity: 'confirmed-valid' | 'confirmed-expired' | 'unknown'; choices: string[] }[];
  voucherAllocations: VoucherAllocation[]; route: RouteStep[];
  targets: { operatorId: string; materials: Record<string, TargetShare>; lmd: TargetShare; exp: TargetShare }[] };
export type GapResult = { status: 'ok' | 'partial' | 'needs-input'; issues: string[]; costs: CostResult[]; raw: Cost | null;
  selected: 'craft' | 'no-craft'; inputSources: { inventory: Record<string, 'snapshot' | 'user-confirmed' | 'unknown'>; progress: 'user-confirmed' | 'unknown' };
  policy: { allocation: 'raw-reservation-then-input-order'; search: 'deterministic-not-exhaustive'; remaining: 'selected-route-not-global-minimum'; execution: 'suggestion-only'; byproducts: 'excluded' };
  stageCodes: Record<string, string | null>;
  comparison: { craft: GapPlan; noCraft: GapPlan } | null };

/** Every target draws from one shared inventory; comparison alternatives get separate ledgers. */
export function calculateCultivationGaps(tables: GapTables, snapshotInput: unknown, input: unknown): GapResult {
  const request = object(input), snapshot = object(snapshotInput);
  const targets = Array.isArray(request.targets) ? request.targets : [];
  const costs = targets.map(target => calculateOperatorCost(tables, snapshot, { ...object(target), mode: 'raw' }));
  const result: GapResult = { status: 'needs-input', issues: [], costs, raw: null, comparison: null,
    selected: request.mode === 'no-craft' ? 'no-craft' : 'craft', inputSources: { inventory: {}, progress: 'unknown' }, stageCodes: {},
    policy: { allocation: 'raw-reservation-then-input-order', search: 'deterministic-not-exhaustive', remaining: 'selected-route-not-global-minimum', execution: 'suggestion-only', byproducts: 'excluded' } };
  if (Object.keys(request).some(key => !['targets', 'progress', 'inventory', 'mode', 'snapshotFile', 'format'].includes(key)) ||
    targets.some(target => Object.keys(object(target)).some(key => !['name', 'operatorId', 'target', 'current'].includes(key)))) {
    result.issues.push('request:unsupported-field'); return result;
  }
  const progress = object(request.progress), inventory = object(request.inventory);
  const shape = (value: ObjectValue, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
  if (request.mode !== undefined && !['craft', 'no-craft'].includes(String(request.mode)) ||
    request.format !== undefined && !['json', 'markdown'].includes(String(request.format)) ||
    request.progress !== undefined && (progress !== request.progress || progress.source !== 'user-confirmed' || !shape(progress, ['source', 'rooms', 'stageRanks', 'voucherValidity'])) ||
    request.inventory !== undefined && (inventory !== request.inventory || inventory.source !== 'user-confirmed' || !shape(inventory, ['source', 'items', 'lmd']))) {
    result.issues.push('request:invalid-confirmation-or-option'); return result;
  }
  for (const key of ['rooms', 'stageRanks', 'voucherValidity']) {
    const value = progress[key]; if (value === undefined) continue;
    if (object(value) !== value || Object.entries(object(value)).some(([id, field]) => !identifier(id) ||
      (key === 'rooms' ? !Array.isArray(field) || field.some(level => !integer(level) || level > 3) :
        key === 'stageRanks' ? !integer(field) || field > 2 : typeof field !== 'boolean'))) result.issues.push(`progress:${key}:invalid`);
  }
  if (inventory.items !== undefined && (object(inventory.items) !== inventory.items || Object.entries(object(inventory.items)).some(([id, count]) => !identifier(id) || id === '4001' || !integer(count))) ||
    inventory.lmd !== undefined && !integer(inventory.lmd)) result.issues.push('inventory:invalid');
  if (result.issues.length) return result;
  result.inputSources.progress = progress.source === 'user-confirmed' ? 'user-confirmed' : 'unknown';
  if (!costs.length || costs.some(cost => !cost.total)) { result.issues.push('targets:incomplete'); return result; }
  if (new Set(costs.map(cost => cost.operator!.id)).size !== costs.length) { result.issues.push('targets:duplicate-operator-combine-goals'); return result; }
  const raw: Cost = { materials: {}, lmd: 0, exp: 0 };
  for (const cost of costs) {
    raw.lmd += cost.total!.lmd; raw.exp += cost.total!.exp;
    for (const [id, count] of Object.entries(cost.total!.materials)) raw.materials[id] = (raw.materials[id] ?? 0) + count;
  }
  if (![raw.lmd, raw.exp, ...Object.values(raw.materials)].every(integer)) { result.issues.push('total:overflow'); return result; }
  const recipes = indexRecipes(tables);
  for (const id of relevantItems(Object.keys(raw.materials), recipes)) for (const recipe of recipes.get(id) ?? []) if (recipe) for (const value of recipe.stages) {
    const stage = object(value); if (!identifier(stage.stageId)) continue;
    const code = object(object(object(tables.stages).stages)[stage.stageId]).code;
    result.stageCodes[stage.stageId] = typeof code === 'string' ? code : null;
  }
  const validInventory = ['complete', 'partial'].includes(String(object(object(snapshot.coverage).inventory).status));
  const items = object(snapshot.items);
  const supplied = object(inventory.items);
  const known = (id: string): number | null => {
    const value = id === '4001' ? snapshot.lmd : items[id], confirmed = id === '4001' ? inventory.lmd : supplied[id];
    const observed = validInventory && integer(value) ? value : null;
    if (observed !== null && confirmed !== undefined && confirmed !== observed) {
      const code = `inventory:${id}:conflicts-with-snapshot`; if (!result.issues.includes(code)) result.issues.push(code);
    }
    result.inputSources.inventory[id] = observed !== null ? 'snapshot' : integer(confirmed) ? 'user-confirmed' : 'unknown';
    return observed ?? (integer(confirmed) ? confirmed : null);
  };
  for (const id of Object.keys(supplied)) known(id); if (inventory.lmd !== undefined) known('4001');
  if (result.issues.length) return result;
  const row = (required: number, available: number | null): GapRow => ({ required, available,
    existing: required === 0 ? 0 : available === null ? null : Math.min(required, available), crafted: 0, voucher: 0,
    remaining: required === 0 ? 0 : available === null ? null : Math.max(0, required - available) });
  const cards = Object.entries(object(object(tables.items).expItems)); let exp: number | null = cards.length ? 0 : null;
  for (const [id, card] of cards) {
    const count = known(id), gain = object(card).gainExp;
    exp = exp !== null && count !== null && integer(gain) && gain > 0 ? exp + count * gain : null;
  }
  if (exp !== null && !integer(exp)) exp = null;
  const plan: GapPlan = { materials: Object.fromEntries(Object.entries(raw.materials).map(([id, count]) => [id, row(count, known(id))])),
    lmd: row(raw.lmd, known('4001')), exp: row(raw.exp, exp), steps: [], targets: [], ledger: {}, blocked: [], vouchers: [], voucherAllocations: [], route: [] };
  for (const [id, value] of Object.entries(plan.materials)) plan.ledger[id] = { opening: value.available, allocated: value.existing ?? 0,
    consumed: 0, crafted: 0, voucher: 0, closing: value.available === null ? null : value.available - value.existing! };
  const craft = structuredClone(plan);
  applyCrafting(craft, tables, request.progress, known);
  applyVouchers(plan, tables, request.progress, known);
  applyVouchers(craft, tables, request.progress, known);
  applyCrafting(craft, tables, request.progress, known, true);
  craft.blocked = craft.blocked.filter(block => knownGap(craft.materials[block.item]!) !== 0);
  for (const block of craft.blocked) if (block.issues.some(issue => /unknown|invalid|ambiguous|cycle|overflow/.test(issue))) craft.materials[block.item]!.remaining = null;
  allocateTargets(plan, costs); allocateTargets(craft, costs);
  result.raw = raw; result.comparison = { craft, noCraft: plan };
  result.status = [craft, plan].some(p => [...Object.values(p.materials), p.lmd, p.exp].some(row => row.remaining === null)) ? 'partial' : 'ok';
  return result;
}

// Usage confirms one item per voucher; the relation confirms eligible choices only.
// *_perm is a naming inference, not proof of validity. Both classes need the user's current validity fact.
const voucherRules: Record<string, 'permanent-name-inference' | 'timed-explicit'> = {
  precious_material_voucher_perm: 'permanent-name-inference', premium_material_voucher_perm: 'permanent-name-inference', advanced_material_voucher_perm: 'permanent-name-inference',
  premium_material_issue_voucher: 'timed-explicit', advanced_material_issue_voucher: 'timed-explicit',
};
function applyVouchers(plan: GapPlan, tables: GapTables, progressInput: unknown, stock: (id: string) => number | null): void {
  const items = object(object(tables.items).items), progress = object(progressInput), confirmed = object(progress.voucherValidity);
  const relevant = relevantItems(Object.keys(plan.materials), indexRecipes(tables));
  const uncertain = new Set<string>(), edges = new Map<string, Map<string, number>>();
  const edge = (from: string, to: string, capacity: number) => {
    if (!edges.has(from)) edges.set(from, new Map()); if (!edges.has(to)) edges.set(to, new Map());
    edges.get(from)!.set(to, capacity); edges.get(to)!.set(from, 0);
  };
  for (const [id, item] of Object.entries(items)) {
    if (!identifier(id) || object(item).itemType !== 'MATERIAL_ISSUE_VOUCHER') continue;
    const choices = [...relevant].filter(material => {
      const related = object(items[material]).voucherRelateList;
      return Array.isArray(related) && related.some(value => object(value).voucherId === id && object(value).voucherItemType === 'MATERIAL_ISSUE_VOUCHER');
    });
    if (!choices.length) continue;
    const available = stock(id), spendable = Object.hasOwn(plan.ledger, id) ? plan.ledger[id]!.closing : available;
    const rule = Object.hasOwn(voucherRules, id) ? voucherRules[id] : undefined;
    const validity = rule !== undefined && progress.source === 'user-confirmed' && typeof confirmed[id] === 'boolean'
      ? confirmed[id] ? 'confirmed-valid' : 'confirmed-expired' : 'unknown';
    plan.vouchers.push({ id, available, used: 0, remaining: available, rule: rule ?? 'unverified', validity, choices });
    if (spendable === 0 || validity === 'confirmed-expired') continue;
    if (spendable === null || validity === 'unknown') { for (const itemId of choices) uncertain.add(itemId); continue; }
    edge('$source', `voucher:${id}`, spendable);
    for (const itemId of choices) {
      const gap = plan.materials[itemId] ? knownGap(plan.materials[itemId]!) : null;
      if (gap !== null && gap > 0) edge(`voucher:${id}`, `item:${itemId}`, Math.min(spendable, gap));
    }
  }
  for (const [id, row] of Object.entries(plan.materials)) { const gap = knownGap(row); if (gap !== null && gap > 0) edge(`item:${id}`, '$sink', gap); }
  // Integral residual flow resolves overlapping choices without spending a voucher twice.
  // It maximizes the count covered, with stable input order; it assigns no economic value.
  for (;;) {
    const previous = new Map<string, string>(), queue = ['$source']; previous.set('$source', '');
    for (let i = 0; i < queue.length && !previous.has('$sink'); i++) {
      for (const [next, capacity] of edges.get(queue[i]!) ?? []) if (capacity > 0 && !previous.has(next)) { previous.set(next, queue[i]!); queue.push(next); }
    }
    if (!previous.has('$sink')) break;
    let amount = Number.MAX_SAFE_INTEGER;
    for (let at = '$sink'; at !== '$source'; at = previous.get(at)!) amount = Math.min(amount, edges.get(previous.get(at)!)!.get(at)!);
    for (let at = '$sink'; at !== '$source'; at = previous.get(at)!) {
      const from = previous.get(at)!; edges.get(from)!.set(at, edges.get(from)!.get(at)! - amount); edges.get(at)!.set(from, edges.get(at)!.get(from)! + amount);
    }
  }
  for (const voucher of plan.vouchers) {
    for (const itemId of voucher.choices) {
      const count = edges.get(`item:${itemId}`)?.get(`voucher:${voucher.id}`) ?? 0; if (!count) continue;
      const row = plan.materials[itemId]!; row.voucher += count;
      if (row.remaining !== null) row.remaining -= count; if (knownGap(row) === 0) row.remaining = 0;
      voucher.used += count;
      plan.ledger[itemId]!.voucher += count; plan.ledger[itemId]!.allocated += count;
      const allocation = { voucherId: voucher.id, itemId, count };
      plan.voucherAllocations.push(allocation); plan.route.push({ kind: 'voucher', allocation });
    }
    const ledger = Object.hasOwn(plan.ledger, voucher.id) ? plan.ledger[voucher.id]! : { opening: voucher.available, allocated: 0, consumed: 0, crafted: 0, voucher: 0, closing: voucher.available };
    ledger.consumed += voucher.used; if (ledger.closing !== null) ledger.closing -= voucher.used;
    voucher.remaining = ledger.closing; plan.ledger[voucher.id] = ledger;
  }
  for (const id of uncertain) if (plan.materials[id] && plan.materials[id]!.remaining !== 0) { plan.materials[id]!.remaining = null; plan.blocked.push({ item: id, issues: ['voucher:count-or-validity-unknown'] }); }
}

function knownGap(row: GapRow): number | null { return row.existing === null ? null : row.required - row.existing - row.crafted - row.voucher; }

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) && !['constructor', 'prototype'].includes(value);
type Recipe = { id: string; kind: string; output: string; count: number; inputs: Record<string, number>; fee: number; morale: number;
  rooms: unknown[]; stages: unknown[] };
function relevantItems(outputs: string[], recipes: Map<string, (Recipe | null)[]>): Set<string> {
  const relevant = new Set(outputs);
  for (const id of relevant) for (const recipe of recipes.get(id) ?? []) if (recipe) for (const input of Object.keys(recipe.inputs)) relevant.add(input);
  return relevant;
}
function readRecipe(input: unknown, manufacture: boolean): Recipe | null {
  const row = object(input);
  if (!identifier(row.formulaId) || !identifier(row.itemId) || !integer(row.count) || row.count < 1 || !Array.isArray(row.costs) || !row.costs.length ||
    !Array.isArray(row.requireRooms) || !Array.isArray(row.requireStages) || !manufacture && (!integer(row.goldCost) || !integer(row.apCost))) return null;
  // Manufacture uses its complete costs array, including explicit 4001/GOLD when present.
  // Workshop has a separate required goldCost field; its absence is invalid, never zero.
  const inputs: Record<string, number> = {}; let fee = manufacture ? 0 : Number(row.goldCost);
  for (const value of row.costs) {
    const cost = object(value); if (!identifier(cost.id) || !integer(cost.count) || cost.count < 1) return null;
    if (cost.id === '4001') fee += cost.count;
    else inputs[cost.id] = (inputs[cost.id] ?? 0) + cost.count;
  }
  if (![fee, ...Object.values(inputs)].every(integer)) return null;
  return { id: row.formulaId, kind: manufacture ? 'manufacture' : String(row.formulaType), output: row.itemId, count: row.count,
    inputs, fee, morale: manufacture ? 0 : Number(row.apCost) / 360000, rooms: row.requireRooms, stages: row.requireStages };
}
function indexRecipes(tables: GapTables): Map<string, (Recipe | null)[]> {
  const recipes = new Map<string, (Recipe | null)[]>();
  for (const [manufacture, rows] of [[false, object(object(tables.building).workshopFormulas)], [true, object(object(tables.building).manufactFormulas)]] as const) {
    for (const value of Object.values(rows)) {
      const row = object(value);
      if (!identifier(row.itemId) || (manufacture ? row.formulaType !== 'F_ASC' || !/^32\d3$/.test(row.itemId) : !['F_EVOLVE', 'F_SKILL'].includes(String(row.formulaType)))) continue;
      recipes.set(row.itemId, [...recipes.get(row.itemId) ?? [], readRecipe(value, manufacture)]);
    }
  }
  return recipes;
}
function applyCrafting(plan: GapPlan, tables: GapTables, progressInput: unknown, stock: (id: string) => number | null, withVouchers = false): void {
  const progress = object(progressInput), rooms = object(progress.rooms), stageRanks = object(progress.stageRanks), recipes = indexRecipes(tables);
  const conditionIssues = (recipe: Recipe): string[] => {
    const issues: string[] = [];
    for (const value of recipe.rooms) {
      const room = object(value);
      if (!identifier(room.roomId) || !integer(room.roomLevel) || room.roomLevel < 1 || room.roomLevel > 3 || !integer(room.roomCount) || room.roomCount < 1) { issues.push('recipe:room-condition-invalid'); continue; }
      const available = rooms[room.roomId];
      if (progress.source !== 'user-confirmed' || !Array.isArray(available) || !available.every(integer)) issues.push(`room:${room.roomId}:unknown`);
      else if (available.filter(level => level >= Number(room.roomLevel)).length < room.roomCount) issues.push(`room:${room.roomId}:insufficient`);
    }
    for (const value of recipe.stages) {
      const stage = object(value);
      if (!identifier(stage.stageId) || !integer(stage.rank) || stage.rank > 2) { issues.push('recipe:stage-condition-invalid'); continue; }
      const rank = stageRanks[stage.stageId];
      if (progress.source !== 'user-confirmed' || !integer(rank)) issues.push(`stage:${stage.stageId}:unknown`);
      else if (rank < stage.rank) issues.push(`stage:${stage.stageId}:insufficient`);
    }
    return issues;
  };
  type Trial = { ledger: GapPlan['ledger']; steps: CraftStep[]; route: RouteStep[]; allocations: VoucherAllocation[]; fees: number; spareLmd: number | null };
  let state: Trial = { ledger: plan.ledger, steps: [], route: [], allocations: [], fees: 0, spareLmd: plan.lmd.available === null ? null : plan.lmd.available - (plan.lmd.existing ?? 0) };
  const entry = (trial: Trial, id: string): LedgerEntry => {
    if (!Object.hasOwn(trial.ledger, id)) { const opening = stock(id); trial.ledger[id] = { opening, allocated: 0, consumed: 0, crafted: 0, voucher: 0, closing: opening }; }
    return trial.ledger[id]!;
  };
  const supplyVouchers = (trial: Trial, id: string, required: number): boolean => {
    let unknown = false;
    for (const voucher of plan.vouchers) {
      if (!withVouchers || !voucher.choices.includes(id) || voucher.validity === 'confirmed-expired') continue;
      const coupon = entry(trial, voucher.id), item = entry(trial, id);
      if (coupon.closing === 0) continue;
      if (coupon.closing === null || voucher.validity === 'unknown') { unknown = true; continue; }
      if (item.closing === null) return true;
      const count = Math.min(Math.max(0, required - item.closing), coupon.closing); if (!count) continue;
      coupon.closing -= count; coupon.consumed += count; item.closing += count; item.voucher += count;
      const allocation = { voucherId: voucher.id, itemId: id, count };
      trial.allocations.push(allocation); trial.route.push({ kind: 'voucher', allocation });
    }
    return unknown;
  };
  const produce = (trial: Trial, id: string, batches: number, path: string[]): string[] => {
    if (path.includes(id)) return [`recipe:${id}:cycle`];
    const choices = recipes.get(id);
    if (!choices?.length) return [`recipe:${id}:unavailable`];
    if (choices.length !== 1) return [`recipe:${id}:ambiguous`];
    const recipe = choices[0]; if (!recipe) return [`recipe:${id}:invalid`];
    const issues = conditionIssues(recipe); if (issues.length) return issues;
    const output = recipe.count * batches, fee = recipe.fee * batches;
    const inputs = Object.fromEntries(Object.entries(recipe.inputs).map(([key, count]) => [key, count * batches]));
    if (![output, fee, ...Object.values(inputs)].every(integer)) return ['craft:overflow'];
    for (const [input, required] of Object.entries(inputs)) {
      const available = entry(trial, input);
      if (available.closing === null) return [`inventory:${input}:unknown`];
      const unknownVoucher = available.closing < required && supplyVouchers(trial, input, required);
      if (available.closing < required) {
        const children = recipes.get(input);
        if (!children?.length) return [`inventory:${input}:insufficient`, ...(unknownVoucher ? ['voucher:count-or-validity-unknown'] : [])];
        if (children.length !== 1) return [`recipe:${input}:ambiguous`];
        const child = children[0]; if (!child) return [`recipe:${input}:invalid`];
        const failed = produce(trial, input, Math.ceil((required - available.closing) / child.count), [...path, id]);
        if (failed.length) return [...failed, ...(unknownVoucher ? ['voucher:count-or-validity-unknown'] : [])];
      }
      available.closing! -= required; available.consumed += required;
      if (!integer(available.consumed) || !integer(available.closing)) return ['craft:overflow'];
    }
    if (fee > 0 && trial.spareLmd === null) return ['inventory:lmd:unknown'];
    if (fee > (trial.spareLmd ?? 0)) return ['inventory:lmd:insufficient-after-raw-reservation'];
    const available = entry(trial, id); if (available.closing === null) return [`inventory:${id}:unknown`];
    available.closing += output; available.crafted += output; trial.fees += fee;
    if (![available.closing, available.crafted, trial.fees, plan.lmd.required + trial.fees].every(integer)) return ['craft:overflow'];
    if (trial.spareLmd !== null) trial.spareLmd -= fee;
    const step = { recipeId: recipe.id, kind: recipe.kind, batches, inputs, output: { id, count: output }, lmd: fee,
      baseMorale: recipe.morale * batches, requirements: { rooms: structuredClone(recipe.rooms), stages: structuredClone(recipe.stages) } };
    trial.steps.push(step); trial.route.push({ kind: 'craft', step });
    return [];
  };
  for (const [id, row] of Object.entries(plan.materials)) {
    const remaining = knownGap(row); if (remaining === 0) continue;
    if (remaining === null) { if (!withVouchers) plan.blocked.push({ item: id, issues: [`inventory:${id}:unknown`] }); continue; }
    if (withVouchers) plan.blocked = plan.blocked.filter(block => block.item !== id || block.issues.some(issue => issue.startsWith('voucher:')));
    const surplus = entry(state, id), reused = Math.min(remaining, surplus.closing ?? 0);
    row.remaining = remaining;
    surplus.closing! -= reused; surplus.allocated += reused; row.crafted += reused; row.remaining -= reused;
    if (row.remaining === 0) continue;
    const recipe = recipes.get(id)?.[0];
    if (!recipe || recipes.get(id)!.length !== 1) {
      plan.blocked.push({ item: id, issues: [recipes.get(id)?.length ? `recipe:${id}:${recipes.get(id)!.length > 1 ? 'ambiguous' : 'invalid'}` : `recipe:${id}:unavailable`] }); continue;
    }
    let low = 0, high = Math.ceil(row.remaining / recipe.count), best = state;
    const maximum = high;
    while (low < high) {
      const batches = low + Math.ceil((high - low) / 2), trial = structuredClone(state);
      if (produce(trial, id, batches, []).length) high = batches - 1;
      else { low = batches; best = trial; }
    }
    if (low < maximum) {
      const failed = produce(structuredClone(state), id, low + 1, []);
      plan.blocked.push({ item: id, issues: failed });
    }
    state = best;
    const available = entry(state, id), covered = Math.min(row.remaining, available.closing ?? 0);
    available.closing! -= covered; available.allocated += covered;
    row.crafted += covered; row.remaining -= covered;
  }
  plan.ledger = state.ledger; plan.steps.push(...state.steps); plan.route.push(...state.route); plan.voucherAllocations.push(...state.allocations); plan.lmd.required += state.fees;
  for (const voucher of plan.vouchers) {
    voucher.used += state.allocations.filter(allocation => allocation.voucherId === voucher.id).reduce((sum, allocation) => sum + allocation.count, 0);
    voucher.remaining = state.ledger[voucher.id]!.closing;
  }
  if (plan.lmd.available !== null) { plan.lmd.existing = Math.min(plan.lmd.required, plan.lmd.available); plan.lmd.remaining = Math.max(0, plan.lmd.required - plan.lmd.available); }
}

function allocateTargets(plan: GapPlan, costs: CostResult[]): void {
  const credits: Record<string, GapRow> = structuredClone({ ...plan.materials, $lmd: plan.lmd, $exp: plan.exp });
  const share = (id: string, required: number): TargetShare => {
    const credit = credits[id]!;
    if (credit.existing === null) return { required, existing: required === 0 ? 0 : null, crafted: 0, voucher: 0, remaining: required === 0 ? 0 : null };
    const existing = Math.min(required, credit.existing); credit.existing -= existing;
    const crafted = Math.min(required - existing, credit.crafted); credit.crafted -= crafted;
    const voucher = Math.min(required - existing - crafted, credit.voucher); credit.voucher -= voucher;
    const gap = required - existing - crafted - voucher;
    return { required, existing, crafted, voucher, remaining: gap === 0 ? 0 : credit.remaining === null ? null : gap };
  };
  plan.targets = costs.map(cost => ({ operatorId: cost.operator!.id,
    materials: Object.fromEntries(Object.entries(cost.total!.materials).map(([id, count]) => [id, share(id, count)])),
    lmd: share('$lmd', cost.total!.lmd), exp: share('$exp', cost.total!.exp) }));
}

export const craftingSources: Record<string, PublicJsonSource> = {
  building: { ...operatorCostSources.items!, file: 'zh_CN/gamedata/excel/building_data.json' },
  stages: { ...operatorCostSources.items!, file: 'zh_CN/gamedata/excel/stage_table.json' },
};

/** The pinned cost and recipe tables every gap calculation uses; the cultivation report reuses this loader. */
export async function loadGapTables(fetcher?: typeof fetch): Promise<GapTables> {
  const tables = await loadOperatorCostTables(fetcher);
  const load = async (key: string) => {
    try { return await readPublicJson(craftingSources[key]!, fetcher); } catch { throw new Error(`gaps-source-unavailable:${key}`); }
  };
  const [building, stages] = await Promise.all([load('building'), load('stages')]);
  return { ...tables, building: building.value, stages: stages.value,
    sources: [...tables.sources ?? [], building.source, stages.source].sort((a, b) => a.file.localeCompare(b.file)) };
}

/** Reads only the selected snapshot and pinned public sources; no recognition, reports or account writes. */
export async function queryCultivationGaps(input: unknown, options: { home?: string; fetcher?: typeof fetch } = {}): Promise<GapResult> {
  const request = object(input), settings = await readSettings(options.home);
  const file = typeof request.snapshotFile === 'string' ? resolve(request.snapshotFile) : settings.privateDirectory ? join(settings.privateDirectory, 'account-snapshot.json') : null;
  if (!file) throw new Error('gaps-snapshot-directory-required');
  let snapshot: unknown;
  try { snapshot = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('gaps-snapshot-unavailable'); }
  return calculateCultivationGaps(await loadGapTables(options.fetcher), snapshot, input);
}

const cell = (value: unknown) => String(value).replace(/[\r\n|]/g, ' ');
export function formatCultivationGapsMarkdown(result: GapResult): string {
  const number = (value: number | null) => value === null ? '未知/待核' : String(value);
  const lines = ['# 培养材料缺口', `状态：${result.status}；当前选项：${result.selected}`,
    '以下是独立比较的覆盖建议，不进行加工、兑换或设备操作。先保留原始需求，按输入目标顺序分配；未穷举替代路线，不代表经济最优或所有方案的最小缺口。随机副产物未计入，当前干员心情、生产排队与即时可操作状态未核实。'];
  if (result.issues.length) lines.push(`待核：${result.issues.map(cell).join('、')}`);
  for (const [id, code] of Object.entries(result.stageCodes)) lines.push(`关卡标识：${cell(id)} → ${cell(code ?? '未知')}；条件 rank 保留公开原码，不推断星数。`);
  for (const cost of result.costs) lines.push('', formatOperatorCostMarkdown(cost));
  if (result.comparison) for (const [mode, plan] of Object.entries(result.comparison)) {
    lines.push('', `## ${mode === 'craft' ? '开启加工' : '不加工 --no-craft'}`, '',
      '| 资源 | 原始需求 | 已知库存 | 已有分配 | 加工补足 | 凭证直接覆盖 | 已核覆盖后差额 | 选定方案仍缺 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [id, row] of Object.entries(plan.materials)) lines.push(`| ${cell(id)} | ${row.required} | ${number(row.available)} | ${number(row.existing)} | ${row.crafted} | ${row.voucher} | ${number(knownGap(row))} | ${number(row.remaining)} |`);
    lines.push(`龙门币：原始 ${result.raw!.lmd}；加工费用 ${plan.steps.reduce((sum, step) => sum + step.lmd, 0)}；合计 ${plan.lmd.required}；库存 ${number(plan.lmd.available)}；仍缺 ${number(plan.lmd.remaining)}。`,
      `经验：原始 ${plan.exp.required}；库存折合 ${number(plan.exp.available)}；仍缺 ${number(plan.exp.remaining)}。`);
    lines.push('', '| 加工步骤 | 批数 | 投入 | 产出 | 龙门币 | 配方基础心情 | 解锁条件 |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const step of plan.steps) lines.push(`| ${cell(step.recipeId)} (${cell(step.kind)}) | ${step.batches} | ${cell(JSON.stringify(step.inputs))} | ${cell(step.output.id)} × ${step.output.count} | ${step.lmd} | ${step.baseMorale} | ${cell(JSON.stringify(step.requirements))} |`);
    lines.push('', '选定可行路线（建议，未执行；凭证作为加工投入的覆盖计入最终加工列）：', '');
    for (const [index, route] of plan.route.entries()) lines.push(route.kind === 'voucher'
      ? `${index + 1}. 凭证 ${cell(route.allocation.voucherId)} → ${cell(route.allocation.itemId)} × ${route.allocation.count}`
      : `${index + 1}. 加工 ${cell(route.step.recipeId)}：${cell(JSON.stringify(route.step.inputs))} → ${cell(route.step.output.id)} × ${route.step.output.count}；龙门币 ${route.step.lmd}`);
    for (const target of plan.targets) lines.push(`- 目标 ${cell(target.operatorId)}：${cell(JSON.stringify(target))}`);
    for (const voucher of plan.vouchers) lines.push(`- 凭证 ${cell(voucher.id)}：已知 ${number(voucher.available)}，建议分配 ${voucher.used}，余量 ${number(voucher.remaining)}，有效性 ${voucher.validity}，分类依据 ${voucher.rule}；物品表候选 ${voucher.choices.map(cell).join('、')}`);
    for (const allocation of plan.voucherAllocations) lines.push(`- 凭证建议：${cell(allocation.voucherId)} → ${cell(allocation.itemId)} × ${allocation.count}（每券一份，未兑换）`);
    for (const block of plan.blocked) lines.push(`- 待核/未覆盖 ${cell(block.item)}：${block.issues.map(cell).join('、')}`);
    lines.push(`库存守恒账本：${cell(JSON.stringify(plan.ledger))}`);
  }
  lines.push('', `输入来源：${cell(JSON.stringify(result.inputSources))}`,
    '券的限时分类来自公开 usage，永久分类仅为固定 ID 命名推断；实际有效性均接受当次用户确认后才计入。原始成本与配方来源、提交、响应 SHA-256 和实际读取时间见各目标来源；arkntools 只报告差异，不修正主源。');
  return lines.join('\n') + '\n';
}

const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    if (process.argv[2] !== 'query' || process.argv.length > 4 || process.argv[3] !== undefined && process.argv[3] !== '--no-craft') throw new Error('gaps-action-invalid');
    const parsed = await readStdinJson({ maxBytes: null, invalidCode: 'gaps-input-invalid' });
    if (object(parsed) !== parsed) throw new Error('gaps-input-invalid');
    const input = process.argv[3] === '--no-craft' ? { ...object(parsed), mode: 'no-craft' } : parsed;
    const result = await queryCultivationGaps(input);
    console.log(object(input).format === 'markdown' ? formatCultivationGapsMarkdown(result) : JSON.stringify(result));
  } catch (error) {
    const code = stdinJsonCode(error) ?? (error instanceof Error && /^(gaps|cost)-[a-z-]+(?::[A-Za-z]+)?$/.test(error.message) ? error.message : 'gaps-input-invalid');
    console.error(JSON.stringify({ error: code })); process.exitCode = 1;
  }
}
