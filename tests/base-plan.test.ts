import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateBasePlan, checkPlanText, exportMaaPlan, parsePlanSpec, parseNameTable, planFreshness, snapshotFingerprint, formatPlanMarkdown,
  type CheckContext } from '../skills/maa-core/scripts/base-plan.ts';
import { planTables, planNetwork, planSnapshot, nameTable, layout, shifts, planInput, planHome } from './fixtures/base-plan-data.ts';

// Synthetic layout, roster, skills and MAA name table only. The network is the only replaced boundary; files are real
// temporary directories. Nothing here writes MAA configuration: the plan file is advice kept in the private directory.
const script = fileURLToPath(new URL('../skills/maa-core/scripts/base-plan.ts', import.meta.url));
type Plan = { title?: string; plans: Record<string, any>[]; [key: string]: unknown };
const baseText = () => exportMaaPlan(parsePlanSpec(planInput()).spec!).text;
const context = (overrides: Partial<CheckContext> = {}): CheckContext => ({ layout: layout() as CheckContext['layout'], snapshot: planSnapshot(), tables: planTables(),
  names: parseNameTable(JSON.stringify(nameTable())), moodDefault: planInput().moodDefault, combos: [], exclusions: [], efficiency: planInput().efficiency,
  tolerance: 1, runs: ['08:00', '20:00'], shifts: 2, texts: [], ...overrides });
/** The periods as the user says the shifts, 08:00-20:00 and 20:00-08:00, with MAA taken to run at their starts (no runs). */
const atPeriodStarts = (plan: Plan, ctx: CheckContext) => { plan.plans[0]!.period = [['08:00', '20:00']]; plan.plans[1]!.period = [['20:00', '23:59'], ['00:00', '08:00']]; delete ctx.runs; };
function checked(mutate: (plan: Plan, ctx: CheckContext) => void = () => undefined, overrides: Partial<CheckContext> = {}) {
  const plan = JSON.parse(baseText()) as Plan, ctx = context(overrides);
  mutate(plan, ctx);
  const text = JSON.stringify(plan, null, 2);
  return checkPlanText(text, { reexport: text, ...ctx });
}
const gate = (result: ReturnType<typeof checkPlanText>, id: number) => result.gates.find(entry => entry.gate === id)!;

test('generation writes a plan file inside the private directory from the layout, roster and active skills; a consistent plan passes all 15 gates', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  const maaBefore = await readdir(join(home, 'maa'), { recursive: true });
  const result = await generateBasePlan(planInput(), { home, fetcher: planNetwork() });
  assert.equal(result.status, 'written', JSON.stringify(result));
  if (result.status !== 'written') return;
  assert.match(result.relative.replaceAll('\\', '/'), /^base-plans\/plan-[a-f0-9]{16}\.json$/);
  // The writer resolves the private directory to its real path (a CI temp dir may be an 8.3 short name).
  assert.ok(resolve(result.file).startsWith(await realpath(home)), 'the plan file stays in the private directory');
  const written = await readFile(result.file, 'utf8');
  assert.equal(written, result.text, 'the delivered file is the export');
  const plan = JSON.parse(written) as Plan;
  assert.deepEqual(plan.plans.map(entry => entry.period), [[['07:00', '19:00']], [['19:00', '23:59'], ['00:00', '07:00']]], 'a cross-day shift is split into two hh:mm segments');
  assert.deepEqual(plan.plans.map(entry => entry.duration), [720, 720]);
  assert.deepEqual(Object.keys(plan.plans[0]!.rooms), ['control', 'manufacture', 'trading', 'power', 'meeting', 'hire', 'dormitory', 'processing', 'training', 'recycle']);
  assert.deepEqual(plan.plans[0]!.rooms.power, [], 'a facility the layout does not have is left as it is, never the default algorithm');
  assert.deepEqual(plan.plans[0]!.rooms.manufacture, [{ operators: ['合成金一', '合成金二'] }], 'no product field: MAA is never asked to switch a production line');
  assert.deepEqual(plan.plans[0]!.drones, { enable: true, room: 'manufacture', index: 1, order: 'pre' });
  assert.deepEqual(result.check.gates.map(entry => [entry.gate, entry.verdict]), Array.from({ length: 15 }, (_, index) => [index + 1, 'pass']), JSON.stringify(result.check.gates));
  assert.deepEqual(result.check.errors, []);
  assert.equal(result.check.applicable, true);
  assert.deepEqual(result.check.efficiency.daily, { 'manufacture[0]': 165 }, 'daily value is the shift-length weighted total of base, skill and global parts');
  assert.deepEqual(result.operators['合成金一']!.skills.map(skill => [skill.name, skill.status, skill.text]), [['合成金工', 'active', '进驻制造站时，贵金属类配方的生产力+30%']]);
  assert.deepEqual(await readdir(join(home, 'maa'), { recursive: true }), maaBefore, 'nothing in the MAA directory changes');
  assert.deepEqual((await readdir(join(home, 'base-plans'))).filter(name => name.endsWith('.tmp')), [], 'atomic replace leaves no temporary file');
});

test('each of the 15 gates passes for the consistent plan and fails for a synthetic plan that breaks it', () => {
  const base = checked();
  assert.ok(base.gates.every(entry => entry.verdict === 'pass'), JSON.stringify(base.gates));
  const failing: Record<number, [string, (plan: Plan, ctx: CheckContext) => void][]> = {
    1: [['the same operator twice in one shift', plan => { plan.plans[0]!.rooms.dormitory[0].operators[4] = '合成金一'; }],
      ['two alternate forms of one operator in one cycle', plan => { plan.plans[0]!.rooms.trading[0].operators = ['合成形态']; plan.plans[1]!.rooms.trading[0].operators = ['合成形态异']; }]],
    2: [['more operators than the room holds', plan => { plan.plans[0]!.rooms.manufacture[0].operators.push('合成记一'); }]],
    3: [['fewer plans than shifts', (_plan, ctx) => { ctx.shifts = 3; }], ['a facility missing from one plan', plan => { delete plan.plans[1]!.rooms.trading; }]],
    4: [['continuous work beyond the mood cap', (_plan, ctx) => { ctx.mood = { 合成金一: { work: 2.5, rest: 3, basis: '合成假设' } }; }],
      ['a Fiammetta target still drains past the cap between two swaps', (plan, ctx) => { plan.plans[0]!.Fiammetta = { enable: true, target: '合成控一', order: 'pre' };
        fiammettaInDorms(plan); ctx.mood = { 合成控一: { work: 2.5, rest: 3, basis: '合成假设' } }; }]],
    5: [['an operator on duty in every shift', plan => { plan.plans[1]!.rooms.control[0].operators = ['合成控一']; plan.plans[1]!.rooms.dormitory[0].operators[1] = '合成控三'; }],
      ['a Fiammetta target that drains faster than 2 per hour', (plan, ctx) => { onDutyWithFiammetta(plan, [0, 1]); ctx.mood = { 合成控一: { work: 3, rest: 2, basis: '合成假设' } }; }],
      ['a target on duty in both shifts but swapped only once a day', (plan, ctx) => { onDutyWithFiammetta(plan, [0]); ctx.mood = { 合成控一: { work: 1.5, rest: 2, basis: '合成假设' } }; }],
      ['a target swapped every shift while Fiammetta is in no dormitory list', (plan, ctx) => { plan.plans[1]!.rooms.control[0].operators = ['合成控一'];
        plan.plans[1]!.rooms.dormitory[0].operators[1] = '合成控三'; for (const index of [0, 1]) plan.plans[index]!.Fiammetta = { enable: true, target: '合成控一', order: 'pre' };
        ctx.mood = { 合成控一: { work: 1.5, rest: 2, basis: '合成假设' } }; }]],
    6: [['more resting operators than free beds', plan => { plan.plans[0]!.rooms.dormitory.push({ operators: ['合成控三'] }); }]],
    7: [['a combination member without the operator it depends on', (_plan, ctx) => { ctx.combos = [{ members: ['合成金一'], dependsOn: ['合成贸三'], basis: '合成假设' }]; }]],
    8: [['two mutually exclusive skills at the same time', (_plan, ctx) => { ctx.exclusions = [{ members: ['合成金一', '合成金二'], basis: '合成假设' }]; }]],
    9: [['a skill for another product', plan => { plan.plans[0]!.rooms.manufacture[0].operators = ['合成记一', '合成金二']; }]],
    10: [['an unfilled control centre', (_plan, ctx) => { ctx.layout = ctx.layout.map(room => room.type === 'control' ? { ...room, level: 2 } : room); }],
      ['the same aura twice', (plan, ctx) => { ctx.layout = ctx.layout.map(room => room.type === 'control' ? { ...room, level: 2 } : room);
        plan.plans[0]!.rooms.control[0].operators = ['合成控一', '合成控二']; }]],
    11: [['a drone target outside the layout', plan => { plan.plans[0]!.drones = { enable: true, room: 'trading', index: 2, order: 'pre' }; }],
      ['a Fiammetta switch without a target', plan => { plan.plans[0]!.Fiammetta = { enable: true, target: '', order: 'pre' }; }]],
    12: [['a total that is not the sum of its parts', (_plan, ctx) => { ctx.efficiency = [{ plan: 0, room: 'manufacture[0]', base: 100, skill: 60, global: 5, total: 170, basis: '合成假设' }]; }]],
    14: [['an uncovered hour when the user is early', plan => { plan.plans[1]!.period = [['19:00', '23:59'], ['00:00', '06:00']]; }],
      ['a mood margin that breaks one hour late', (_plan, ctx) => { ctx.mood = { 合成金一: { work: 1.9, rest: 3, basis: '合成假设' } }; }],
      ['an early run keeps the previous plan until the next change', (plan, ctx) => { atPeriodStarts(plan, ctx); ctx.moodDefault = { work: 1.5, rest: 2, basis: '合成假设' }; }]],
    15: [['a claim that the plan is optimal', plan => { plan.title = '合成最优两班'; }]],
  };
  for (const [id, cases] of Object.entries(failing)) for (const [name, mutate] of cases) {
    const result = checked(mutate);
    assert.equal(gate(result, Number(id)).verdict, 'fail', `gate ${id}: ${name}: ${JSON.stringify(gate(result, Number(id)))}`);
    assert.equal(result.applicable, false, `gate ${id}: ${name}: a failing gate keeps the plan from being applicable`);
  }
  const text = baseText();
  const changed = checkPlanText(text, { ...context(), reexport: text.replace('白班', '早班') });
  assert.equal(gate(changed, 13).verdict, 'fail', 'gate 13: the delivered file differs from a deterministic re-export');
  assert.equal(gate(checked(undefined, { mood: { 合成金一: { work: 1.9, rest: 3, basis: '合成假设' } } }), 4).verdict, 'pass', 'gate 4 alone allows 22.8 of 24');
  const early = checked(atPeriodStarts, { moodDefault: { work: 1.5, rest: 2, basis: '合成假设' } });
  assert.equal(gate(early, 4).verdict, 'pass', '18 of 24 per 12-hour shift holds on time');
  // MAA runs at 07:00, still inside the night period: the night shift stays on from 20:00 until the 08:00 run a day later.
  assert.ok(gate(early, 14).evidence.some(entry => entry.includes('提前 1 小时（07:00）') && entry.includes('36 小时 × 每小时 1.5 = 54')), JSON.stringify(gate(early, 14)));
  const fiammetta = checked((plan, ctx) => { onDutyWithFiammetta(plan, [0, 1]); ctx.mood = { 合成控一: { work: 1.5, rest: 2, basis: '合成假设' } }; });
  for (const id of [4, 5]) assert.equal(gate(fiammetta, id).verdict, 'pass', `gate ${id}: a target swapped at every change, with Fiammetta resting in between, may stay on duty: ${JSON.stringify(gate(fiammetta, id))}`);
  // Four changes a day with two alternating plans: each stretch is 6 hours, not the 12 hours a plan holds in total.
  const rotation = checked((plan, ctx) => { delete ctx.runs; plan.plans[0]!.period = [['00:00', '06:00'], ['12:00', '18:00']]; plan.plans[1]!.period = [['06:00', '12:00'], ['18:00', '23:59']];
    ctx.mood = { 合成金一: { work: 2.5, rest: 3, basis: '合成假设' } }; });
  assert.equal(gate(rotation, 4).verdict, 'pass', JSON.stringify(gate(rotation, 4)));
});
/** Fiammetta rests in the dormitory in both shifts, in the bed the permanent resident 合成宿一 had. */
function fiammettaInDorms(plan: Plan) { for (const index of [0, 1]) plan.plans[index]!.rooms.dormitory[0].operators[0] = '合成菲'; }
/** 合成控一 stays in the control centre in both shifts; Fiammetta swaps with it at the start of the listed plans and rests in between. */
function onDutyWithFiammetta(plan: Plan, swaps: number[]) {
  plan.plans[1]!.rooms.control[0].operators = ['合成控一'];
  plan.plans[1]!.rooms.dormitory[0].operators[1] = '合成控三';
  fiammettaInDorms(plan);
  for (const index of swaps) plan.plans[index]!.Fiammetta = { enable: true, target: '合成控一', order: 'pre' };
}

test('an early run that MAA still sends to the previous plan names its remedy, and following the remedy passes gate 14', async (t) => {
  const rate = { work: 1.5, rest: 2, basis: '合成假设' };
  const before = gate(checked(atPeriodStarts, { moodDefault: rate }), 14), text = before.evidence.join('\n');
  assert.equal(before.verdict, 'fail');
  assert.match(text, /提前 1 小时（07:00）运行时 MAA 选 plans\[1\]/);
  assert.match(text, /把 plans\[0\] 时间段的开始提前到 07:00 或更早/);
  assert.match(text, /runs/, 'the remedy keeps MAA at 08:00 and says so in runs');
  // Following the message: both periods start an hour earlier while MAA still runs at 08:00 and 20:00.
  const earlier = (plan: Plan) => { plan.plans[0]!.period = [['07:00', '19:00']]; plan.plans[1]!.period = [['19:00', '23:59'], ['00:00', '07:00']]; };
  const after = checked(earlier, { moodDefault: rate, runs: ['08:00', '20:00'] });
  assert.equal(gate(after, 14).verdict, 'pass', JSON.stringify(gate(after, 14)));
  assert.equal(after.applicable, true, JSON.stringify(after.gates.filter(entry => entry.verdict !== 'pass')));
  assert.deepEqual(after.facts.runs, ['08:00', '20:00']);
  // Without runs the run is taken to be the period start again, so an hour early is again in the previous period.
  assert.equal(gate(checked((plan, ctx) => { earlier(plan); delete ctx.runs; }, { moodDefault: rate }), 14).verdict, 'fail');
  // Only the day period moved: the night change, an hour early at 19:00, is still in the day period.
  const half = gate(checked(plan => { plan.plans[0]!.period = [['07:00', '20:00']]; plan.plans[1]!.period = [['20:00', '23:59'], ['00:00', '07:00']]; },
    { moodDefault: rate, runs: ['08:00', '20:00'] }), 14);
  assert.equal(half.verdict, 'fail');
  assert.match(half.evidence.join('\n'), /提前 1 小时（19:00）运行时 MAA 选 plans\[0\]/);
  // The day plan's period is 13 hours, but MAA keeps each plan on duty from its run to the next: 12 hours each.
  const weighted = checked(plan => { plan.plans[0]!.period = [['07:00', '20:00']]; plan.plans[1]!.period = [['20:00', '23:59'], ['00:00', '07:00']]; },
    { efficiency: [{ plan: 0, room: 'manufacture[0]', base: 100, skill: 60, global: 5, basis: '合成假设' }, { plan: 1, room: 'manufacture[0]', base: 100, skill: 0, global: 5, basis: '合成假设' }] });
  assert.deepEqual(weighted.efficiency.daily, { 'manufacture[0]': 135 });
  // A plan no run time selects, and malformed run times, are refused.
  assert.equal(gate(checked(undefined, { runs: ['09:00', '10:00'] }), 3).verdict, 'fail', 'plans[1] is never selected');
  assert.ok(checked(undefined, { runs: ['8:00'] }).errors.includes('runs-invalid'));
  assert.deepEqual(parsePlanSpec({ ...planInput(), runs: ['08:00', '08:00'] }).issues, ['runs-invalid']);
  // The proposal carries the run times through generation into the check.
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  const input = { ...planInput(), moodDefault: rate };
  const result = await generateBasePlan(input, { home, fetcher: planNetwork() });
  if (result.status !== 'written') return assert.fail(JSON.stringify(result));
  assert.equal(gate(result.check, 14).verdict, 'pass', JSON.stringify(gate(result.check, 14)));
  assert.match(formatPlanMarkdown(result.check), /MAA 运行时间 08:00、20:00/);
});

test('Fiammetta order "post" is refused: MAA runs the pair after the dormitory task and dormitory 1 keeps only the target and Fiammetta', async (t) => {
  const input = planInput() as ReturnType<typeof planInput> & { shifts: Record<string, unknown>[] };
  input.shifts[0]!.fiammetta = { target: '合成控一', order: 'post' };
  assert.deepEqual(parsePlanSpec(input).issues, ['shift-fiammetta-post:0']);
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await generateBasePlan(input, { home, fetcher: planNetwork() }), { status: 'needs-input', issues: ['shift-fiammetta-post:0'] });
  input.shifts[0]!.fiammetta = { target: '合成控一' };
  assert.deepEqual((exportMaaPlan(parsePlanSpec(input).spec!).plan.plans as Plan['plans'])[0]!.Fiammetta, { enable: true, target: '合成控一', order: 'pre' });
  const post = checked((plan, ctx) => { onDutyWithFiammetta(plan, [0, 1]); for (const entry of plan.plans) entry.Fiammetta.order = 'post'; ctx.mood = { 合成控一: { work: 1.5, rest: 2, basis: '合成假设' } }; });
  assert.equal(gate(post, 11).verdict, 'fail');
  assert.ok(gate(post, 11).evidence.some(entry => entry.includes('post') && entry.includes('宿舍 1') && entry.includes('不恢复')), JSON.stringify(gate(post, 11)));
  assert.equal(post.applicable, false);
});

test('a room left unassigned keeps whoever MAA seated there last, so the previous shift stays on duty', () => {
  const result = checked(plan => { plan.plans[1]!.rooms.trading = [{ skip: true }]; plan.plans[1]!.rooms.dormitory[0].operators[4] = '合成贸三'; });
  assert.ok(gate(result, 5).evidence.some(entry => entry.startsWith('合成贸一 每个班次都在岗')), JSON.stringify(gate(result, 5)));
  assert.equal(gate(result, 4).verdict, 'fail', JSON.stringify(gate(result, 4)));
  assert.equal(result.applicable, false);
});

test('a gate that cannot be verified is listed separately and never counts as a pass', () => {
  const result = checked(undefined, { moodDefault: undefined, combos: undefined, exclusions: undefined, efficiency: undefined, snapshot: null });
  for (const id of [2, 4, 7, 8, 9, 10, 12, 14]) assert.equal(gate(result, id).verdict, 'unverified', `gate ${id}`);
  assert.deepEqual(result.unverified.filter(entry => entry.startsWith('gate-')).sort(), ['gate-10', 'gate-12', 'gate-14', 'gate-2', 'gate-4', 'gate-7', 'gate-8', 'gate-9']);
  assert.equal(result.applicable, true, 'unverified items are for the user to weigh; they do not fail the plan');
  const noMeta = checked(undefined, { tables: { ...planTables(), charMeta: undefined } });
  assert.equal(gate(noMeta, 1).verdict, 'unverified', 'without the alternate-form table the cycle check is unverified');
  const noCap = checked(undefined, { tables: { ...planTables(), building: { ...planTables().building, manpowerDisplayFactor: undefined } } });
  assert.equal(gate(noCap, 4).verdict, 'unverified', 'the mood cap is used only when the fixed game table yields it');
});

test('the six base rules: capacity, plan count, duplicates, key case, production lines and unowned warnings', () => {
  const codes = (mutate: (plan: Plan, ctx: CheckContext) => void, overrides: Partial<CheckContext> = {}) => checked(mutate, overrides);
  assert.ok(codes(plan => { plan.plans[0]!.rooms.manufacture[0].operators.push('合成记一'); }).errors.includes('room-capacity:plans[0].rooms.manufacture[0]:3>2'));
  assert.ok(codes(plan => { plan.plans = []; }).errors.includes('plan-count:0'));
  assert.ok(codes(() => undefined, { shifts: 3 }).errors.includes('plan-count:2/3'));
  assert.ok(codes(plan => { plan.plans[0]!.rooms.dormitory[0].operators[4] = '合成金一'; }).errors.includes('plan-duplicate:plans[0]:合成金一'));
  const cased = codes(plan => { plan.plans[0]!.rooms.Manufacture = plan.plans[0]!.rooms.manufacture; delete plan.plans[0]!.rooms.manufacture;
    plan.plans[0]!.fiammetta = { target: '合成控一' }; plan.plans[1]!.rooms.trading[0].Operators = ['合成贸二']; });
  for (const code of ['key-case:plans[0].rooms.Manufacture', 'key-case:plans[0].fiammetta', 'key-case:plans[1].rooms.trading[0].Operators']) assert.ok(cased.errors.includes(code), code);
  assert.ok(codes(plan => { plan.plans[0]!.rooms.manufacture[0].product = 'Battle Record'; }).errors.includes('product-switch:plans[0].rooms.manufacture[0]:Pure Gold>Battle Record'));
  assert.ok(codes(plan => { plan.plans[0]!.rooms.manufacture[0].product = 'pure gold'; }).errors.includes('product-invalid:plans[0].rooms.manufacture[0]'));
  assert.ok(codes(plan => { plan.plans[0]!.rooms.trading[0].product = 'Pure Gold'; }).errors.includes('product-invalid:plans[0].rooms.trading[0]'));
  assert.deepEqual(codes(plan => { plan.plans[0]!.rooms.manufacture[0].product = 'Pure Gold'; }).errors, [], 'the product the layout already makes is accepted');
  const unowned = codes(plan => { plan.plans[0]!.rooms.trading[0].operators = ['合成未观察']; });
  assert.ok(unowned.warnings.includes('operator-unowned:合成未观察'));
  assert.deepEqual(unowned.errors, [], 'an unobserved operator is a warning, not an error');
  assert.equal(gate(unowned, 2).verdict, 'unverified');
});

test('names are checked against the local MAA name table, separately from ownership', () => {
  const unknown = checked(plan => { plan.plans[0]!.rooms.trading[0].operators = ['合成不存在']; plan.plans[1]!.rooms.trading[0].operators = ['合成召唤物']; });
  assert.ok(unknown.errors.includes('name-unknown:合成不存在') && unknown.errors.includes('name-unknown:合成召唤物'), 'tokens are not operator names');
  assert.ok(unknown.warnings.includes('operator-unowned:合成不存在'), 'not owned is reported on its own');
  assert.equal(unknown.applicable, false);
  const unavailable = checked(undefined, { names: { status: 'unavailable', reason: 'maa-directory-unset' } });
  assert.ok(unavailable.unverified.includes('names:maa-directory-unset'));
  assert.equal(parseNameTable('{"chars":{}}').status, 'unavailable');
});

test('a display name shared by two game IDs resolves to the form the snapshot owns; otherwise its skills stay pending', () => {
  const place = (plan: Plan) => { plan.plans[0]!.rooms.trading[0].operators = ['合成同名']; };
  const owned = checked(place);
  assert.equal(owned.operators['合成同名']!.id, 'char_dup_b');
  assert.equal(owned.operators['合成同名']!.ownership, 'owned');
  assert.ok(!owned.warnings.some(entry => entry.includes('合成同名')));
  assert.equal(gate(owned, 9).verdict, 'pass', JSON.stringify(gate(owned, 9)));
  const neither = checked(place, { snapshot: planSnapshot(['char_ghost', 'char_dup_a', 'char_dup_b']) });
  assert.ok(neither.warnings.includes('operator-unowned:合成同名'), 'neither form observed: not owned as far as the snapshot shows');
  assert.equal(gate(neither, 9).verdict, 'unverified', 'which form, and so which skills, is unknown');
  const both = checked(place, { snapshot: planSnapshot(['char_ghost']) });
  assert.equal(both.operators['合成同名']!.ownership, 'ambiguous');
  assert.ok(!both.warnings.includes('operator-unowned:合成同名'), 'both forms are owned, so the name is owned');
  assert.ok(both.unverified.includes('ownership-ambiguous:合成同名'));
  assert.equal(gate(both, 9).verdict, 'unverified');
});

test('periods use hh:mm, split across midnight, and overlap or mixing is an error', () => {
  const spec = parsePlanSpec({ ...planInput(), shifts: [{ ...shifts()[0], period: [['22:00', '06:00']] }, { ...shifts()[1], period: '06:00-22:00' }] });
  assert.deepEqual(spec.spec!.shifts.map(shift => shift.period), [[['22:00', '23:59'], ['00:00', '06:00']], [['06:00', '22:00']]]);
  assert.deepEqual(parsePlanSpec({ ...planInput(), shifts: [{ ...shifts()[0], period: '8:00-20:00' }, shifts()[1]] }).issues, ['shift-period-invalid:0']);
  assert.deepEqual(parsePlanSpec({ ...planInput(), shifts: [{ ...shifts()[0], period: undefined }, shifts()[1]] }).issues, ['shift-period-invalid:0']);
  const errors = (mutate: (plan: Plan) => void) => checked(mutate).errors;
  assert.ok(errors(plan => { plan.plans[1]!.period = [['20:00', '08:00']]; }).includes('period-format:plans[1].period[0]'), 'an unsplit cross-day pair never matches in MAA');
  assert.ok(errors(plan => { plan.plans[1]!.period = [['24:00', '23:59']]; }).includes('period-format:plans[1].period[0]'));
  assert.ok(errors(plan => { plan.plans[1]!.period = [['19:00', '23:59'], ['00:00', '08:00']]; }).includes('period-overlap:plans[0]:plans[1]'), 'MAA would always pick the earlier plan');
  assert.ok(errors(plan => { delete plan.plans[1]!.period; }).includes('period-mixed'));
});

test('the plan file path is confined to the private directory; a base file keeps the fields this tool does not know', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  for (const target of ['../outside.json', join(tmpdir(), 'outside.json'), 'base-plans/../../outside.json', 'base-plans/plan.txt']) {
    await assert.rejects(generateBasePlan({ ...planInput(), target }, { home, fetcher: planNetwork() }), /plan-path-outside-private|plan-path-invalid/, target);
  }
  // A link inside the private directory that leads outside it is refused before anything is created there.
  const outside = await mkdtemp(join(tmpdir(), 'maa-base-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(home, 'linked'), 'junction');
  await assert.rejects(generateBasePlan({ ...planInput(), target: 'linked/new/plan.json' }, { home, fetcher: planNetwork() }), /plan-path-outside-private/);
  assert.deepEqual(await readdir(outside), [], 'no directory or file appears outside the private directory');
  await mkdir(join(home, 'base-plans'), { recursive: true });
  const base = JSON.parse(baseText()) as Plan;
  Object.assign(base, { author: '合成作者', Plans: [], layout: [{ type: 'control', level: 1 }] });
  Object.assign(base.plans[0]!, { 'x-note': '合成备注', Rooms: {} });
  base.plans[0]!.rooms.manufacture[0]['x-extra'] = 1;
  base.plans[0]!.rooms.future_room = [{ operators: ['合成控三'] }];
  await writeFile(join(home, 'base-plans', 'mine.json'), JSON.stringify(base));
  const result = await generateBasePlan({ ...planInput(), base: 'base-plans/mine.json', target: 'base-plans/mine.json' }, { home, fetcher: planNetwork() });
  assert.equal(result.status, 'written');
  if (result.status !== 'written') return;
  const written = JSON.parse(await readFile(join(home, 'base-plans', 'mine.json'), 'utf8')) as Plan;
  assert.equal(written.author, '合成作者'); assert.deepEqual(written.layout, [{ type: 'control', level: 1 }]);
  assert.equal(written.plans[0]!['x-note'], '合成备注'); assert.equal(written.plans[0]!.rooms.manufacture[0]['x-extra'], 1);
  assert.deepEqual(written.plans[0]!.rooms.future_room, [{ operators: ['合成控三'] }]);
  assert.ok(!('Plans' in written) && !('Rooms' in written.plans[0]!), 'a wrong-case copy of a known key is dropped, not kept');
  assert.deepEqual(result.dropped.sort(), ['Plans', 'plans[0].Rooms']);
  assert.equal(result.check.gates.find(entry => entry.gate === 13)!.verdict, 'pass', 'the file equals a re-export from the same base');
});

test('unassigned rooms are filled from owned operators whose active skills match the room, rotating between shifts', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  const input = planInput();
  for (const shift of input.shifts) delete (shift.rooms as Record<string, unknown>).trading;
  const result = await generateBasePlan({ ...input, fill: true }, { home, fetcher: planNetwork() });
  if (result.status !== 'written') return assert.fail(JSON.stringify(result));
  assert.deepEqual((result.plan as Plan).plans.map(plan => plan.rooms.trading), [[{ operators: ['合成贸一'] }], [{ operators: ['合成贸二'] }]]);
  assert.deepEqual(result.fills, [{ plan: 0, room: 'trading[0]', operators: ['合成贸一'] }, { plan: 1, room: 'trading[0]', operators: ['合成贸二'] }]);
  const unfilled = await generateBasePlan(input, { home, fetcher: planNetwork() });
  if (unfilled.status !== 'written') return assert.fail(JSON.stringify(unfilled));
  assert.deepEqual((unfilled.plan as Plan).plans[0]!.rooms.trading, [{ skip: true }], 'without fill an unassigned room keeps its operators');
  // The first shift follows the last one around the cycle: whoever the proposal puts on duty last is not filled in first.
  const cycle = planInput();
  delete (cycle.shifts[0]!.rooms as Record<string, unknown>).trading;
  cycle.shifts[1]!.rooms.trading = [['合成贸一']];
  cycle.shifts[1]!.rooms.dormitory = [['合成宿一', '合成控一', '合成金一', '合成金二', '合成贸二']];
  cycle.shifts[0]!.rooms.dormitory = [['合成宿一', '合成控二', '合成金三', '合成金四', '合成贸三']];
  const first = await generateBasePlan({ ...cycle, fill: true }, { home, fetcher: planNetwork() });
  if (first.status !== 'written') return assert.fail(JSON.stringify(first));
  assert.deepEqual(first.fills, [{ plan: 0, room: 'trading[0]', operators: ['合成贸二'] }], '合成贸一 works the last shift, so the first shift does not take it');
  // Three shifts: the first one avoids both neighbours, the one before it around the ring and the one after it.
  const ring = { ...planInput(), shifts: [
    { name: '合成早班', period: '06:00-14:00', rooms: { control: [['合成控一']], manufacture: [['合成金一', '合成金二']], dormitory: [['合成宿一', '合成控二', '合成金三', '合成金四', '合成控三']] } },
    { name: '合成中班', period: '14:00-22:00', rooms: { control: [['合成控二']], manufacture: [['合成金三', '合成金四']], trading: [['合成贸一']], dormitory: [['合成宿一', '合成控三', '合成金一', '合成金二', '合成贸三']] } },
    { name: '合成夜班', period: '22:00-06:00', rooms: { control: [['合成控三']], manufacture: [['合成金一', '合成金二']], trading: [['合成贸三']], dormitory: [['合成宿一', '合成控一', '合成金三', '合成金四', '合成贸一']] } },
  ] };
  const both = await generateBasePlan({ ...ring, fill: true }, { home, fetcher: planNetwork() });
  if (both.status !== 'written') return assert.fail(JSON.stringify(both));
  assert.deepEqual(both.fills, [{ plan: 0, room: 'trading[0]', operators: ['合成贸二'] }], '合成贸一 works the next shift and 合成贸三 the previous one');
});

test('a different layout and roster: three shifts and two factories with different products, filled only with skills that fit each product', async (t) => {
  const layoutB = [{ type: 'control', level: 1 }, { type: 'manufacture', level: 1, product: 'Battle Record' }, { type: 'manufacture', level: 1, product: 'Pure Gold' },
    { type: 'trading', level: 1, product: 'LMD' }, { type: 'dormitory', level: 1 }];
  const three = ['00:00-08:00', '08:00-16:00', '16:00-00:00'].map((period, index) => ({ name: `合成第${index + 1}班`, period, rooms: {} }));
  for (const [snapshot, records] of [[planSnapshot(), [['合成记一']]], [planSnapshot(['char_ghost', 'char_rec1']), []]] as const) {
    const home = await planHome(snapshot); t.after(() => rm(home, { recursive: true, force: true }));
    const result = await generateBasePlan({ layout: layoutB, shifts: three, fill: true }, { home, fetcher: planNetwork() });
    if (result.status !== 'written') return assert.fail(JSON.stringify(result));
    const plans = (result.plan as Plan).plans;
    assert.deepEqual(plans.map(plan => plan.period), [[['00:00', '08:00']], [['08:00', '16:00']], [['16:00', '23:59']]]);
    assert.deepEqual(result.fills.filter(fill => fill.room === 'manufacture[0]').map(fill => fill.operators), records, 'only the record skill goes to the record factory, and nobody works two shifts in a row');
    assert.deepEqual(plans.map(plan => plan.rooms.manufacture[1].operators), [['合成金一'], ['合成金二'], ['合成金三']], 'the last shift also avoids the first one');
    assert.deepEqual(plans.map(plan => plan.rooms.control[0].operators), [['合成控一'], ['合成控二'], ['合成控三']]);
    // The record factory is filled in the first shift only and skipped in the others, where MAA keeps whoever it
    // seated last: the record operator never leaves, and gate 5 says so.
    assert.deepEqual(plans.map(plan => plan.rooms.manufacture[0]), records.length ? [{ operators: ['合成记一'] }, { skip: true }, { skip: true }] : [{ skip: true }, { skip: true }, { skip: true }]);
    assert.deepEqual(gate(result.check, 5).evidence.filter(entry => entry.endsWith(' 每个班次都在岗')), records.length ? ['合成记一 每个班次都在岗'] : []);
    assert.equal(result.check.applicable, !records.length, JSON.stringify(result.check.gates.filter(entry => entry.verdict === 'fail')));
    for (const id of [1, 3, 9, 10, 11, 13, 15]) assert.equal(gate(result.check, id).verdict, 'pass', `gate ${id}: ${JSON.stringify(gate(result.check, id))}`);
    for (const id of [4, 7, 8, 12, 14]) assert.equal(gate(result.check, id).verdict, 'unverified', `gate ${id} has no declared rates, combinations, exclusions or figures`);
  }
});

test('freshness is fresh, stale or unknown, and an old check is not proof for changed data', () => {
  const snapshot = planSnapshot();
  const recorded = { snapshot: snapshotFingerprint(snapshot), tables: [['owner/repo', 'c'.repeat(40), 'building.json', 'a'.repeat(64)]], names: 'b'.repeat(64), plan: 'd'.repeat(64) };
  const later = { ...snapshot, readAt: '2099-01-01T00:00:00.000Z', sourceTimes: { operators: '2099-01-01T00:00:00.000Z', inventory: null } };
  assert.deepEqual(planFreshness(recorded, { ...recorded, snapshot: snapshotFingerprint(later) }),
    { snapshot: 'fresh', tables: 'fresh', names: 'fresh', plan: 'fresh', check: 'fresh' }, 'the same facts read again later are still fresh');
  const changed = planSnapshot(['char_ghost', 'char_trade3']);
  assert.deepEqual(planFreshness(recorded, { ...recorded, snapshot: snapshotFingerprint(changed) }).snapshot, 'stale');
  assert.equal(planFreshness(recorded, { ...recorded, snapshot: snapshotFingerprint(changed) }).check, 'stale');
  assert.deepEqual(planFreshness(recorded, { ...recorded, tables: null, names: null }), { snapshot: 'fresh', tables: 'unknown', names: 'unknown', plan: 'fresh', check: 'unknown' });
  assert.equal(planFreshness(recorded, { ...recorded, plan: 'e'.repeat(64) }).check, 'stale');
});

test('the CLI checks a plan file read-only and prints the same result as Markdown', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'tables.json'), JSON.stringify(planTables()));
  await mkdir(join(home, 'base-plans'));
  await writeFile(join(home, 'base-plans', 'mine.json'), baseText());
  const run = (action: string, input: unknown) => spawnSync(process.execPath, [script, action], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, MAA_SKILLS_HOME: home } });
  const { layout: rooms, moodDefault, combos, exclusions, efficiency, runs } = planInput();
  const json = run('check', { planFile: 'base-plans/mine.json', layout: rooms, shifts: 2, moodDefault, combos, exclusions, efficiency, runs, tablesFile: join(home, 'tables.json') });
  assert.equal(json.status, 0, json.stdout + json.stderr);
  const output = JSON.parse(json.stdout);
  assert.equal(output.ok, true); assert.equal(output.result.applicable, true);
  assert.equal(output.result.gates.find((entry: { gate: number }) => entry.gate === 13).verdict, 'unverified', 'a file not produced in this run has no re-export to compare');
  const markdown = run('check', { planFile: 'base-plans/mine.json', layout: rooms, shifts: 2, tablesFile: join(home, 'tables.json'), format: 'markdown' });
  assert.equal(markdown.status, 0, markdown.stderr);
  for (const text of ['# 基建排班检查', '| 4 | 心情上限与恢复 | 未核实 |', '未核实的项', '不写 MAA 配置']) assert.ok(markdown.stdout.includes(text), text);
  assert.equal(markdown.stdout, formatPlanMarkdown({ ...JSON.parse(run('check', { planFile: 'base-plans/mine.json', layout: rooms, shifts: 2, tablesFile: join(home, 'tables.json') }).stdout).result }) );
  const outside = run('check', { planFile: '../elsewhere.json', layout: rooms, tablesFile: join(home, 'tables.json') });
  assert.equal(outside.status, 1); assert.deepEqual(JSON.parse(outside.stdout), { ok: false, error: 'plan-path-outside-private' });
  const generated = run('generate', { ...planInput(), tablesFile: join(home, 'tables.json') });
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  const summary = JSON.parse(generated.stdout);
  assert.equal(summary.ok, true); assert.equal(summary.applicable, true); assert.match(summary.planFile.replaceAll('\\', '/'), /^base-plans\/plan-/);
  assert.equal(summary.source, 'supplied', 'offline tables are labelled as supplied, not as the public mirror');
});
