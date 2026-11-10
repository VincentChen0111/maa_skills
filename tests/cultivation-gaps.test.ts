import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCultivationGaps, queryCultivationGaps, formatCultivationGapsMarkdown, craftingSources } from '../skills/maa-core/scripts/cultivation-gaps.ts';
import { operatorCostSources } from '../skills/maa-core/scripts/operator-cost.ts';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { symlink } from 'node:fs/promises';
import { costTables, costSnapshot } from './fixtures/cost-data.ts';

function fixture() {
  const tables = { ...costTables(), building: { workshopFormulas: {}, manufactFormulas: {} }, stages: { stages: {} } };
  Object.assign(tables.characters, { char_second: { ...structuredClone(tables.characters.char_synthetic), name: '合成二号' } });
  const snapshot = costSnapshot(); snapshot.operators.push({ ...structuredClone(snapshot.operators[0]!), id: 'char_second', name: '合成二号' });
  Object.assign(snapshot.items, { exp_card: 0 });
  return { tables, snapshot };
}
const goal = (name = '合成干员') => ({ name, target: { elite: 1, level: 1 } });
const progress = { source: 'user-confirmed', rooms: { WORKSHOP: [3], MANUFACTURE: [3] }, stageRanks: { stage_synthetic: 2 },
  voucherValidity: { premium_material_voucher_perm: true, advanced_material_voucher_perm: true, precious_material_voucher_perm: true } };
function recipe(output = 'mat', input = 'ore', count = 2) {
  return { formulaId: `recipe_${output}`, formulaType: 'F_EVOLVE', itemId: output, count: 1, goldCost: 5, apCost: 360000,
    costs: [{ id: input, count, type: 'MATERIAL' }], requireRooms: [{ roomId: 'WORKSHOP', roomLevel: 3, roomCount: 1 }],
    requireStages: [{ stageId: 'stage_synthetic', rank: 2 }] };
}

test('a known sufficient inventory covers the actual incremental cost without spending or changing inputs', () => {
  const tables = { ...costTables(), building: { workshopFormulas: {}, manufactFormulas: {} }, stages: { stages: {} } };
  const snapshot = costSnapshot(); Object.assign(snapshot.items, { exp_card: 1 });
  const saved = structuredClone({ tables, snapshot });
  const result = calculateCultivationGaps(tables, snapshot, { targets: [{ name: '合成干员', target: { elite: 1, level: 1 } }] });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.raw, { materials: { mat: 2 }, lmd: 102, exp: 20 });
  assert.deepEqual(result.comparison?.craft.materials.mat, { required: 2, available: 5, existing: 2, crafted: 0, voucher: 0, remaining: 0 });
  assert.equal(result.comparison?.craft.lmd.remaining, 0);
  assert.equal(result.comparison?.craft.exp.remaining, 0);
  assert.deepEqual(result.comparison?.craft.steps, []);
  assert.deepEqual({ tables, snapshot }, saved);
});

test('crafting consumes only spare materials and LMD, with independently computed no-craft comparison', () => {
  const { tables, snapshot } = fixture(); snapshot.items.mat = 0; Object.assign(snapshot.items, { ore: 4 });
  Object.assign(tables.building.workshopFormulas, { mat: recipe() });
  const result = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress });
  const { craft, noCraft } = result.comparison!;
  assert.equal(craft.materials.mat?.crafted, 2); assert.equal(craft.materials.mat?.remaining, 0);
  assert.equal(noCraft.materials.mat?.remaining, 2); assert.deepEqual(noCraft.steps, []);
  assert.equal(craft.steps[0]?.lmd, 10); assert.deepEqual(craft.steps[0]?.inputs, { ore: 4 });
  assert.equal(craft.lmd.required, 112); assert.equal(craft.ledger.ore?.closing, 0);
  assert.equal(craft.ledger.mat?.crafted, 2); assert.equal(craft.ledger.mat?.allocated, 2);
  assert.equal(craft.targets[0]?.materials.mat?.crafted, 2);
});

test('unconfirmed recipe conditions and ingredient stocks block coverage with explicit reasons', () => {
  const { tables, snapshot } = fixture(); snapshot.items.mat = 0; Object.assign(snapshot.items, { ore: 4 });
  Object.assign(tables.building.workshopFormulas, { mat: recipe() });
  for (const supplied of [undefined, { source: 'user-confirmed', rooms: { WORKSHOP: [2] } }, { ...progress, stageRanks: {} }]) {
    const plan = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress: supplied }).comparison!.craft;
    assert.equal(plan.materials.mat?.crafted, 0); assert.ok(plan.blocked.some(block => block.issues.some(issue => /room|stage/.test(issue))));
  }
  const unknown = structuredClone(snapshot); delete (unknown.items as Record<string, number>).ore;
  const plan = calculateCultivationGaps(tables, unknown, { targets: [goal()], progress }).comparison!.craft;
  assert.equal(plan.materials.mat?.crafted, 0); assert.ok(plan.blocked.some(block => block.issues.includes('inventory:ore:unknown')));
});

test('recursive production reserves raw intermediate demand and reuses batch surplus exactly once', () => {
  const { tables, snapshot } = fixture(); snapshot.items.mat = 0;
  Object.assign(snapshot.items, { ore: 0, dust: 4 }); snapshot.lmd = 500;
  Object.assign(tables.characters.char_synthetic.phases[1]!, { evolveCost: [{ id: 'mat', count: 1 }] });
  Object.assign(tables.characters, { char_second: { ...structuredClone(tables.characters.char_synthetic), name: '合成二号',
    phases: [{ maxLevel: 3 }, { maxLevel: 3, evolveCost: [{ id: 'ore', count: 1 }] }] } });
  Object.assign(tables.building.workshopFormulas, { mat: recipe('mat', 'ore', 2), ore: { ...recipe('ore', 'dust', 2), count: 3 } });
  const plan = calculateCultivationGaps(tables, snapshot, { targets: [goal(), goal('合成二号')], progress }).comparison!.craft;
  assert.equal(plan.materials.mat?.remaining, 0); assert.equal(plan.materials.ore?.remaining, 0);
  assert.deepEqual(plan.steps.map(step => step.output), [{ id: 'ore', count: 3 }, { id: 'mat', count: 1 }]);
  assert.equal(plan.ledger.dust?.closing, 2);
  assert.equal(plan.ledger.ore?.allocated, 1); assert.equal(plan.ledger.ore?.consumed, 2);
  for (const row of Object.values(plan.ledger)) assert.equal(row.opening! + row.crafted + row.voucher - row.allocated - row.consumed, row.closing);
  // Already-held intermediate materials belong to the raw target before any upper-tier crafting.
  Object.assign(snapshot.items, { ore: 1, dust: 0 });
  const reserved = calculateCultivationGaps(tables, snapshot, { targets: [goal(), goal('合成二号')], progress }).comparison!.craft;
  assert.equal(reserved.materials.ore?.existing, 1); assert.equal(reserved.materials.mat?.crafted, 0);
});

test('crafting fees cannot displace another target LMD need, and failed chains leave no consumed inputs', () => {
  const { tables, snapshot } = fixture(); snapshot.items.mat = 0; Object.assign(snapshot.items, { ore: 4 });
  Object.assign(tables.building.workshopFormulas, { mat: recipe() }); snapshot.lmd = 209;
  const plan = calculateCultivationGaps(tables, snapshot, { targets: [goal(), goal('合成二号')], progress }).comparison!.craft;
  assert.equal(plan.materials.mat?.crafted, 1); assert.equal(plan.lmd.required, 209); assert.equal(plan.ledger.ore?.closing, 2);
  const unknown = { ...snapshot, lmd: null };
  const blocked = calculateCultivationGaps(tables, unknown, { targets: [goal()], progress }).comparison!.craft;
  assert.deepEqual(blocked.steps, []); assert.equal(blocked.lmd.remaining, null);
  assert.ok(blocked.blocked.some(row => row.issues.includes('inventory:lmd:unknown')));
});

function vouchers(tables: ReturnType<typeof fixture>['tables']) {
  Object.assign(tables.items.items, {
    mat: { name: '合成材料', voucherRelateList: [{ voucherId: 'premium_material_voucher_perm', voucherItemType: 'MATERIAL_ISSUE_VOUCHER' }, { voucherId: 'advanced_material_voucher_perm', voucherItemType: 'MATERIAL_ISSUE_VOUCHER' }] },
    other: { name: '合成材料二', voucherRelateList: [{ voucherId: 'premium_material_voucher_perm', voucherItemType: 'MATERIAL_ISSUE_VOUCHER' }] },
    premium_material_voucher_perm: { name: '合成通用券', itemType: 'MATERIAL_ISSUE_VOUCHER' },
    advanced_material_voucher_perm: { name: '合成专用券', itemType: 'MATERIAL_ISSUE_VOUCHER' },
  });
}
test('voucher recommendations conserve shared vouchers and handle competing eligible choices', () => {
  const { tables, snapshot } = fixture(); vouchers(tables); snapshot.items.mat = 0;
  Object.assign(snapshot.items, { other: 0, premium_material_voucher_perm: 1, advanced_material_voucher_perm: 1 });
  Object.assign(tables.characters.char_synthetic.phases[1]!, { evolveCost: [{ id: 'mat', count: 1 }] });
  Object.assign(tables.characters, { char_second: { ...structuredClone(tables.characters.char_synthetic), name: '合成二号', phases: [{ maxLevel: 3 }, { maxLevel: 3, evolveCost: [{ id: 'other', count: 1 }] }] } });
  const plan = calculateCultivationGaps(tables, snapshot, { targets: [goal(), goal('合成二号')], progress }).comparison!.noCraft;
  assert.equal(plan.materials.mat?.voucher, 1); assert.equal(plan.materials.other?.voucher, 1);
  assert.equal(plan.materials.mat?.remaining, 0);
  assert.equal(plan.voucherAllocations.reduce((sum, row) => sum + row.count, 0), 2);
  assert.deepEqual(plan.voucherAllocations, [
    { voucherId: 'premium_material_voucher_perm', itemId: 'other', count: 1 },
    { voucherId: 'advanced_material_voucher_perm', itemId: 'mat', count: 1 },
  ]);
  assert.equal(snapshot.items.mat, 0);
  for (const row of Object.values(plan.ledger)) assert.equal(row.opening! + row.crafted + row.voucher - row.allocated - row.consumed, row.closing);
  Object.assign(snapshot.items, { advanced_material_voucher_perm: 0 });
  const partial = calculateCultivationGaps(tables, snapshot, { targets: [goal(), goal('合成二号')], progress }).comparison!.noCraft;
  assert.equal(Object.values(partial.materials).reduce((sum, row) => sum + row.remaining!, 0), 1);
});

test('unknown voucher counts and unconfirmed timed validity never become zero or usable coverage', () => {
  const { tables, snapshot } = fixture(); snapshot.items.mat = 0;
  Object.assign(tables.items.items, {
    mat: { name: '合成材料', voucherRelateList: [{ voucherId: 'premium_material_issue_voucher', voucherItemType: 'MATERIAL_ISSUE_VOUCHER' }] },
    premium_material_issue_voucher: { name: '合成限时券', itemType: 'MATERIAL_ISSUE_VOUCHER' },
  });
  Object.assign(snapshot.items, { premium_material_issue_voucher: 1 });
  const unknown = calculateCultivationGaps(tables, snapshot, { targets: [goal()] }).comparison!.craft;
  assert.equal(unknown.materials.mat?.voucher, 0); assert.equal(unknown.materials.mat?.remaining, null);
  const valid = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress: { source: 'user-confirmed', voucherValidity: { premium_material_issue_voucher: true } } }).comparison!.craft;
  assert.equal(valid.materials.mat?.voucher, 1); assert.equal(valid.materials.mat?.remaining, 1);
  const expired = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress: { source: 'user-confirmed', voucherValidity: { premium_material_issue_voucher: false } } }).comparison!.craft;
  assert.equal(expired.materials.mat?.voucher, 0); assert.equal(expired.materials.mat?.remaining, 2);
  const absent = structuredClone(snapshot); delete (absent.items as Record<string, number>).premium_material_issue_voucher;
  assert.equal(calculateCultivationGaps(tables, absent, { targets: [goal()] }).comparison?.craft.materials.mat?.remaining, null);
});

test('multiple goals share one stock budget in input order and cannot repeat an operator', () => {
  const { tables, snapshot } = fixture(); snapshot.items.mat = 3;
  const result = calculateCultivationGaps(tables, snapshot, { targets: [goal(), goal('合成二号')] });
  const plan = result.comparison!.noCraft;
  assert.equal(result.raw?.materials.mat, 4);
  assert.equal(plan.materials.mat?.remaining, 1);
  assert.deepEqual(plan.targets.map(t => t.materials.mat?.existing), [2, 1]);
  assert.deepEqual(plan.targets.map(t => t.materials.mat?.remaining), [0, 1]);
  assert.equal(plan.lmd.remaining, 54);
  assert.equal(calculateCultivationGaps(tables, snapshot, { targets: [goal(), goal()] }).comparison, null);
});

test('missing inventory stays unknown and malformed requests cannot silently change the requested scope', () => {
  const { tables, snapshot } = fixture(); snapshot.items = {} as typeof snapshot.items;
  const result = calculateCultivationGaps(tables, snapshot, { targets: [goal()] });
  assert.equal(result.comparison?.craft.materials.mat?.remaining, null);
  assert.equal(result.comparison?.craft.targets[0]?.materials.mat?.existing, null);
  for (const request of [{ targets: [goal()], typo: true }, { targets: [{ ...goal(), mode: 'raw' }] }, { targets: [null] }]) {
    assert.equal(calculateCultivationGaps(tables, snapshot, request).comparison, null);
  }
});

test('explicit confirmed inventory can fill unknown values but cannot overwrite known stock', () => {
  const { tables, snapshot } = fixture(); snapshot.items = {} as typeof snapshot.items;
  const result = calculateCultivationGaps(tables, snapshot, { targets: [goal()], inventory: { source: 'user-confirmed', items: { mat: 2, exp_card: 1 } } });
  assert.equal(result.comparison?.craft.materials.mat?.remaining, 0);
  assert.equal(result.inputSources.inventory.mat, 'user-confirmed');
  snapshot.items.mat = 1;
  const conflict = calculateCultivationGaps(tables, snapshot, { targets: [goal()], inventory: { source: 'user-confirmed', items: { mat: 2 } } });
  assert.equal(conflict.comparison, null); assert.ok(conflict.issues.includes('inventory:mat:conflicts-with-snapshot'));
  for (const request of [
    { inventory: { items: { mat: 2 } } }, { inventory: { source: 'user-confirmed', items: { mat: -1 } } },
    { progress: { source: 'user-confirmed', rooms: { WORKSHOP: [99] } } }, { progress: { source: 'user-confirmed', stageRanks: { stage_synthetic: 99 } } },
    { progress: { source: 'user-confirmed', voucherValidity: { premium_material_issue_voucher: 'yes' } } }, { mode: 'silent-default' },
  ]) assert.equal(calculateCultivationGaps(tables, snapshot, { targets: [goal()], ...request }).comparison, null);
});

test('unknown unlocking remains pending, with known coverage arithmetic shown separately from final certainty', () => {
  const { tables, snapshot } = fixture(); snapshot.items.mat = 0; Object.assign(snapshot.items, { ore: 4 });
  Object.assign(tables.building.workshopFormulas, { mat: recipe() });
  const result = calculateCultivationGaps(tables, snapshot, { targets: [goal()] });
  assert.equal(result.status, 'partial'); assert.equal(result.comparison?.craft.materials.mat?.remaining, null);
  assert.equal(result.comparison?.noCraft.materials.mat?.remaining, 2);
});

test('the public query and both native CLI paths read real snapshots, hash synthetic network bytes, and render matching Markdown', async t => {
  const { tables, snapshot } = fixture(); snapshot.items.mat = 0; Object.assign(snapshot.items, { ore: 4 });
  Object.assign(tables.building.workshopFormulas, { mat: recipe() });
  const network = Object.fromEntries(Object.entries({ ...operatorCostSources, ...craftingSources }).map(([key, source]) => [
    `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`, tables[key as keyof typeof tables],
  ]));
  const isolated = await createFixture({ companionSkills: { 'maa-core': resolve('skills/maa-core') }, networkFixtures: network, jsonInputs: {
    'private/config.json': { language: 'zh-CN', privateDirectory: '{{private}}' }, 'private/account-snapshot.json': snapshot,
  } }); t.after(() => isolated.dispose());
  const request = { targets: [goal()], progress, mode: 'no-craft' };
  const fetcher: typeof fetch = async input => { assert.ok(Object.hasOwn(network, String(input))); return new Response(JSON.stringify(network[String(input)])); };
  const direct = await queryCultivationGaps(request, { home: resolve(isolated.workspace, 'private'), fetcher });
  assert.equal(direct.selected, 'no-craft');
  const source = direct.costs[0]!.sources.find(s => s.file.endsWith('building_data.json'))!;
  assert.equal(source.sha256, createHash('sha256').update(JSON.stringify(tables.building)).digest('hex'));
  assert.equal(direct.costs[0]!.sources.length, 9);
  for (const host of ['.agents', '.claude']) {
    const script = `${host}/skills/maa-core/scripts/cultivation-gaps.ts`;
    const run = (format: string) => spawnSync(process.execPath, [script, 'query', '--no-craft'], { cwd: isolated.workspace, env: isolated.env,
      input: JSON.stringify({ ...request, mode: undefined, format }), encoding: 'utf8' });
    const json = run('json'); assert.equal(json.status, 0, json.stderr); assert.ok(json.stdout.trim());
    const result = JSON.parse(json.stdout); assert.deepEqual(result.comparison, direct.comparison); assert.equal(result.selected, 'no-craft');
    const markdown = run('markdown'); assert.equal(markdown.status, 0, markdown.stderr);
    const withoutReadTimes = (text: string) => text.replace(/读取 \d{4}-[^\s]+/g, '读取 <actual-time>');
    assert.equal(withoutReadTimes(markdown.stdout.trim()), withoutReadTimes(formatCultivationGapsMarkdown(result).trim()));
    assert.match(markdown.stdout, /原始需求.*已有.*加工.*凭证.*仍缺/); assert.match(markdown.stdout, /recipe_mat/);
    const bad = spawnSync(process.execPath, [script, 'query', '--unexpected'], { cwd: isolated.workspace, env: isolated.env, input: '{}', encoding: 'utf8' });
    assert.equal(bad.status, 1); assert.match(bad.stderr, /gaps-action-invalid/);
  }
  if (process.platform === 'win32') {
    const link = resolve(isolated.root, 'development-core');
    await symlink(resolve(isolated.workspace, '.agents/skills/maa-core'), link, 'junction');
    const linked = spawnSync(process.execPath, [resolve(link, 'scripts/cultivation-gaps.ts'), 'query'], { cwd: isolated.workspace, env: isolated.env, input: JSON.stringify(request), encoding: 'utf8' });
    assert.equal(linked.status, 0, linked.stderr); assert.ok(linked.stdout.trim()); assert.deepEqual(JSON.parse(linked.stdout).comparison, direct.comparison);
  }
  assert.deepEqual((await collectEvidence(isolated, { completed: true, calls: [], outputs: [] })).changes, []);
  await assert.rejects(queryCultivationGaps(request, { home: resolve(isolated.workspace, 'private'), fetcher: async () => new Response('', { status: 503 }) }), /source-unavailable/);
});

test('manufactured dual chips use their source recipe and malformed or cyclic formulas cannot claim coverage', () => {
  const { tables, snapshot } = fixture(); Object.assign(snapshot.items, { '3213': 0, chip: 4, catalyst: 2 });
  Object.assign(tables.characters.char_synthetic.phases[1]!, { evolveCost: [{ id: '3213', count: 2 }] });
  Object.assign(tables.building.manufactFormulas, { synthetic: { formulaId: 'dual', formulaType: 'F_ASC', itemId: '3213', count: 1,
    costs: [{ id: 'chip', count: 2 }, { id: 'catalyst', count: 1 }], requireRooms: [{ roomId: 'MANUFACTURE', roomLevel: 3, roomCount: 1 }], requireStages: [] } });
  const plan = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress }).comparison!.craft;
  assert.equal(plan.materials['3213']?.remaining, 0); assert.equal(plan.steps[0]?.kind, 'manufacture'); assert.equal(plan.steps[0]?.lmd, 0);
  assert.equal(plan.ledger.chip?.consumed, 4); assert.equal(plan.ledger.catalyst?.closing, 0);
  const broken = fixture(); broken.snapshot.items.mat = 0; Object.assign(broken.snapshot.items, { ore: 0 });
  for (const row of [{ ...recipe(), count: 0 }, { ...recipe(), costs: [{ id: '__proto__', count: 1 }] }, { ...recipe(), requireStages: [{ stageId: 'stage_synthetic', rank: 99 }] }]) {
    Object.assign(broken.tables.building.workshopFormulas, { mat: row });
    const bad = calculateCultivationGaps(broken.tables, broken.snapshot, { targets: [goal()], progress });
    assert.equal(bad.status, 'partial'); assert.deepEqual(bad.comparison?.craft.steps, []); assert.equal(bad.comparison?.craft.materials.mat?.remaining, null);
  }
  Object.assign(broken.tables.building.workshopFormulas, { mat: recipe(), ore: recipe('ore', 'mat', 1) });
  const cyclic = calculateCultivationGaps(broken.tables, broken.snapshot, { targets: [goal()], progress }).comparison!.craft;
  assert.deepEqual(cyclic.steps, []); assert.ok(cyclic.blocked.some(row => row.issues.some(issue => issue.endsWith(':cycle'))));
});

test('vouchers already allocated as raw requirements cannot cover another material as well', () => {
  const { tables, snapshot } = fixture(); vouchers(tables); snapshot.items.mat = 0;
  Object.assign(snapshot.items, { premium_material_voucher_perm: 1, advanced_material_voucher_perm: 0 });
  Object.assign(tables.characters.char_synthetic.phases[1]!, { evolveCost: [{ id: 'mat', count: 1 }, { id: 'premium_material_voucher_perm', count: 1 }] });
  const plan = calculateCultivationGaps(tables, snapshot, { targets: [goal()] }).comparison!.noCraft;
  assert.equal(plan.materials.mat?.voucher, 0); assert.equal(plan.materials.mat?.remaining, 1);
  assert.equal(plan.ledger.premium_material_voucher_perm?.allocated, 1); assert.equal(plan.ledger.premium_material_voucher_perm?.closing, 0);
});

function voucherChain(timed = false) {
  const data = fixture(), voucher = timed ? 'premium_material_issue_voucher' : 'premium_material_voucher_perm';
  data.snapshot.items.mat = 0; Object.assign(data.snapshot.items, { ore: 0, [voucher]: 4 });
  Object.assign(data.tables.building.workshopFormulas, { mat: recipe() });
  Object.assign(data.tables.items.items, { ore: { name: '合成下级材料', voucherRelateList: [{ voucherId: voucher, voucherItemType: 'MATERIAL_ISSUE_VOUCHER' }] },
    [voucher]: { name: '合成加工投入券', itemType: 'MATERIAL_ISSUE_VOUCHER' } });
  return { ...data, voucher };
}
test('vouchers can supply lower-tier inputs for a verified crafting route without affecting no-craft', () => {
  const { tables, snapshot, voucher } = voucherChain();
  const { craft, noCraft } = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress }).comparison!;
  assert.equal(craft.materials.mat?.remaining, 0); assert.equal(craft.materials.mat?.crafted, 2);
  assert.equal(noCraft.materials.mat?.remaining, 2); assert.equal(noCraft.ledger[voucher]?.consumed, 0);
  assert.equal(craft.ledger[voucher]?.consumed, 4); assert.equal(craft.ledger.ore?.voucher, 4); assert.equal(craft.ledger.ore?.consumed, 4);
  assert.equal(craft.lmd.required, 112);
  assert.deepEqual(craft.route.map(step => step.kind), ['voucher', 'craft']);
  for (const row of Object.values(craft.ledger)) assert.equal(row.opening! + row.crafted + row.voucher - row.allocated - row.consumed, row.closing);
});

test('failed voucher/craft routes retain coupons for other goals and cannot assume unlocks, expiry or funding', () => {
  const { tables, snapshot, voucher } = voucherChain(true);
  for (const confirmed of [undefined, progress]) {
    const plan = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress: confirmed }).comparison!.craft;
    assert.equal(plan.materials.mat?.crafted, 0); assert.equal(plan.materials.mat?.remaining, null); assert.equal(plan.ledger[voucher]?.consumed, 0);
  }
  const valid = { ...progress, voucherValidity: { [voucher]: true } };
  assert.equal(calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress: valid }).comparison?.craft.materials.mat?.remaining, 0);
  Object.assign(tables.characters, { char_second: { ...structuredClone(tables.characters.char_synthetic), name: '合成二号', phases: [{ maxLevel: 3 }, { maxLevel: 3, evolveCost: [{ id: 'ore', count: 1 }] }] } });
  snapshot.lmd = 205;
  const failed = calculateCultivationGaps(tables, snapshot, { targets: [goal(), goal('合成二号')], progress: valid }).comparison!.craft;
  assert.equal(failed.materials.mat?.crafted, 0); assert.equal(failed.materials.ore?.voucher, 1);
  assert.equal(failed.ledger[voucher]?.consumed, 1); assert.equal(failed.ledger[voucher]?.closing, 3);
  assert.deepEqual(failed.steps, []);
});

test('partial facts or inconsistent cross-check sources never change raw requirements or allocate an unknown goal', () => {
  const { tables, snapshot } = voucherChain();
  tables.crossCultivate.synthetic.evolve[0]!['4001'] = 999;
  const result = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress });
  assert.equal(result.costs[0]?.crossCheck.status, 'different'); assert.equal(result.raw?.lmd, 102);
  assert.equal(result.comparison?.craft.lmd.required, 112);
  assert.match(formatCultivationGapsMarkdown(result), /999/);
  Object.assign(snapshot.operators[1]!, { elite: null });
  const unknown = calculateCultivationGaps(tables, snapshot, { targets: [goal(), goal('合成二号')], progress });
  assert.equal(unknown.status, 'needs-input'); assert.equal(unknown.raw, null); assert.equal(unknown.comparison, null);
});

test('overflowing source ingredient totals cannot allocate coupons or materials', () => {
  const { tables, snapshot, voucher } = voucherChain();
  Object.assign(tables.building.workshopFormulas, { mat: { ...recipe(), costs: [{ id: 'ore', count: Number.MAX_SAFE_INTEGER }, { id: 'ore', count: 1 }] } });
  const result = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress });
  const plan = result.comparison!.craft;
  assert.equal(result.status, 'partial'); assert.deepEqual(plan.steps, []); assert.equal(plan.ledger.mat!.allocated, 0);
  assert.equal(plan.voucherAllocations.length, 0); assert.equal(snapshot.items[voucher as keyof typeof snapshot.items], 4);
});

test('Markdown explains the actual voucher-to-crafting order and labels the selected route rather than an optimal minimum', () => {
  const { tables, snapshot } = voucherChain();
  const markdown = formatCultivationGapsMarkdown(calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress }));
  assert.ok(markdown.indexOf('1. 凭证') < markdown.indexOf('2. 加工')); assert.match(markdown, /选定方案仍缺/);
  assert.match(markdown, /未穷举替代路线/);
});

test('permanent-looking IDs disclose an inference and still require the relevant voucher validity fact', () => {
  const { tables, snapshot, voucher } = voucherChain();
  const result = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress: { ...progress, voucherValidity: {} } });
  const plan = result.comparison!.craft;
  assert.equal(plan.materials.mat?.crafted, 0); assert.equal(plan.materials.mat?.remaining, null);
  assert.equal(plan.vouchers.find(row => row.id === voucher)?.rule, 'permanent-name-inference');
  assert.equal(plan.vouchers.find(row => row.id === voucher)?.validity, 'unknown');
  assert.match(formatCultivationGapsMarkdown(result), /premium_material_voucher_perm.*unknown/);
});

test('deterministic competing-goal cases reconcile every stock, coupon, cost and per-goal share', () => {
  for (let seed = 0; seed < 36; seed++) {
    const { tables, snapshot, voucher } = voucherChain();
    snapshot.items.mat = seed % 3; Object.assign(snapshot.items, { ore: seed % 5, [voucher]: seed % 7 }); snapshot.lmd = 190 + seed;
    const result = calculateCultivationGaps(tables, snapshot, { targets: [goal(), goal('合成二号')], progress });
    for (const plan of Object.values(result.comparison!)) {
      for (const row of Object.values(plan.ledger)) {
        if (row.opening === null || row.closing === null) continue;
        assert.equal(BigInt(row.opening) + BigInt(row.crafted) + BigInt(row.voucher), BigInt(row.allocated) + BigInt(row.consumed) + BigInt(row.closing));
        assert.ok(row.closing >= 0);
      }
      for (const [id, row] of Object.entries(plan.materials)) for (const key of ['required', 'existing', 'crafted', 'voucher'] as const) {
        assert.equal(plan.targets.reduce((sum, target) => sum + (target.materials[id]?.[key] ?? 0), 0), row[key]);
      }
      assert.equal(plan.lmd.required, result.raw!.lmd + plan.steps.reduce((sum, step) => sum + step.lmd, 0));
      assert.ok(plan.steps.reduce((sum, step) => sum + step.lmd, 0) <= Math.max(0, snapshot.lmd - result.raw!.lmd));
      for (const coupon of plan.vouchers) assert.equal(coupon.used, plan.voucherAllocations.filter(row => row.voucherId === coupon.id).reduce((sum, row) => sum + row.count, 0));
    }
  }
});

test('an unsupported voucher rule cannot inherit a JavaScript object property as an approved rule', () => {
  const { tables, snapshot } = fixture(); snapshot.items.mat = 0; Object.assign(snapshot.items, { toString: 1 });
  Object.assign(tables.items.items, { toString: { itemType: 'MATERIAL_ISSUE_VOUCHER', name: '合成未知券' },
    mat: { name: '合成材料', voucherRelateList: [{ voucherId: 'toString', voucherItemType: 'MATERIAL_ISSUE_VOUCHER' }] } });
  const plan = calculateCultivationGaps(tables, snapshot, { targets: [goal()], progress: { source: 'user-confirmed', voucherValidity: { toString: true } } }).comparison!.noCraft;
  assert.equal(plan.vouchers[0]?.rule, 'unverified'); assert.equal(plan.vouchers[0]?.validity, 'unknown');
  assert.equal(plan.materials.mat?.voucher, 0); assert.equal(plan.materials.mat?.remaining, null);
  assert.equal(Object.entries(plan.ledger).find(([id]) => id === 'toString')?.[1].closing, 1);
});

test('invalid or ambiguous lower-tier formulas remain pending through the public function and both real CLI paths', async t => {
  for (const kind of ['missing-fee', 'invalid-count', 'invalid-first-duplicate', 'valid-first-duplicate']) {
    const { tables, snapshot } = fixture(); snapshot.items.mat = 0; snapshot.lmd = 1000;
    Object.assign(snapshot.items, { ore: 0, dust: 20 });
    const child = { ...recipe('ore', 'dust', 1), ...(kind === 'missing-fee' ? { goldCost: undefined } : kind === 'valid-first-duplicate' ? {} : { count: 0 }) };
    Object.assign(tables.building.workshopFormulas, { mat: recipe(), ore: child });
    if (kind.endsWith('duplicate')) Object.assign(tables.building.workshopFormulas, { ore_second: { ...recipe('ore', 'dust', 1), formulaId: 'recipe_ore_second' } });
    const request = { targets: [goal()], progress };
    const check = (result: ReturnType<typeof calculateCultivationGaps>) => {
      assert.equal(result.status, 'partial', kind); const plan = result.comparison!.craft;
      assert.equal(plan.materials.mat?.remaining, null); assert.equal(plan.materials.mat?.crafted, 0);
      assert.deepEqual(plan.route, []); assert.deepEqual(plan.voucherAllocations, []); assert.equal(plan.lmd.required, 102);
      assert.ok(plan.blocked.some(row => row.issues.includes(`recipe:ore:${kind.endsWith('duplicate') ? 'ambiguous' : 'invalid'}`)));
      assert.deepEqual(result.comparison!.noCraft.materials.mat, { required: 2, available: 0, existing: 0, crafted: 0, voucher: 0, remaining: 2 });
    };
    check(calculateCultivationGaps(tables, snapshot, request));
    const networkFixtures = Object.fromEntries(Object.entries({ ...operatorCostSources, ...craftingSources }).map(([key, source]) => [
      `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`, tables[key as keyof typeof tables],
    ]));
    const isolated = await createFixture({ companionSkills: { 'maa-core': resolve('skills/maa-core') }, networkFixtures, jsonInputs: {
      'private/config.json': { language: 'zh-CN', privateDirectory: '{{private}}' }, 'private/account-snapshot.json': snapshot,
    } }); t.after(() => isolated.dispose());
    for (const host of ['.agents', '.claude']) {
      const cli = spawnSync(process.execPath, [`${host}/skills/maa-core/scripts/cultivation-gaps.ts`, 'query'], { cwd: isolated.workspace, env: isolated.env, input: JSON.stringify(request), encoding: 'utf8' });
      assert.equal(cli.status, 0, cli.stderr); check(JSON.parse(cli.stdout));
    }
    assert.deepEqual((await collectEvidence(isolated, { completed: false, calls: [], outputs: [] })).changes, []);
    // An unused bad recipe does not invalidate already-known input stock.
    Object.assign(snapshot.items, { ore: 4 });
    assert.equal(calculateCultivationGaps(tables, snapshot, request).comparison?.craft.materials.mat?.remaining, 0);
  }
});
