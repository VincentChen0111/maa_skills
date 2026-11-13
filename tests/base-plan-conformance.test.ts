import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlanText, exportMaaPlan, parsePlanSpec, parseNameTable, type CheckContext } from '../skills/maa-core/scripts/base-plan.ts';
import { planTables, planSnapshot, nameTable, layout, planInput } from './fixtures/base-plan-data.ts';

// Conformance: every gate that reads the shift timeline (4, 5, 11 and 14) must agree with an independent model of what
// MAA v6.21.4 does with the same plan file, minute by minute. The model is written from MAA's source, not from the
// checker:
// - InfrastTaskUserControlModel.cs 784-786: the GUI picks the first plan whose period holds the current time, both ends
//   inclusive; a run lands some seconds into its minute, so a run in a period's end minute (and any run during 23:59)
//   is outside it; nothing found means plan 0.
// - InfrastTask.cpp 478-527: the Fiammetta pair (dormitory 1 cleared and given the target, then cleared and given the
//   target and Fiammetta) runs before the facility tasks for "pre" and after them for "post".
// - A custom room is cleared and seated from its list; a skipped room is left as it is.
// - Fiammetta trades moods with the target when she is at full mood. Work rooms take the work rate per hour,
//   dormitories give the rest rate up to the cap, an operator in no room keeps its mood.
// Synthetic layout, roster and rates only.

type Rate = { work: number; rest: number };
type MaaRoom = { operators?: string[]; skip?: boolean };
type MaaPlan = { period?: [string, string][]; rooms: Record<string, MaaRoom[]>; Fiammetta?: { enable?: boolean; target?: string; order?: string } };
type MaaFile = { plans: MaaPlan[] };
const CAP = 24, FIAMMETTA = '合成菲', FIAMMETTA_RATE = 2, DAY = 1440, WARM = 30;
const clock = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
const rooms = (() => { const seen: Record<string, number> = {}; return layout().map(room => `${room.type}[${(seen[room.type] = (seen[room.type] ?? -1) + 1)}]`); })();

function maaModel(plans: MaaPlan[], rateOf: (name: string) => Rate) {
  const names = [...new Set([FIAMMETTA, ...plans.flatMap(plan => [...Object.values(plan.rooms).flatMap(list => list.flatMap(room => room.operators ?? [])),
    ...(plan.Fiammetta?.target ? [plan.Fiammetta.target] : [])])])];
  const index = new Map(names.map((name, k) => [name, k])), dorm = rooms.map(room => room.startsWith('dormitory['));
  const gain = names.map(name => name === FIAMMETTA ? FIAMMETTA_RATE : rateOf(name).rest), loss = names.map(name => rateOf(name).work);
  type State = { room: Int32Array; mood: Float64Array };
  const pick = (time: number) => {
    const now = ((time % DAY) + DAY) % DAY + 0.5;
    const found = plans.findIndex(plan => (plan.period ?? []).some(([from, to]) => clock(from) <= now && now <= clock(to)));
    return found < 0 ? 0 : found;
  };
  const seat = (state: State, room: number, list: string[]) => {
    state.room.forEach((value, k) => { if (value === room) state.room[k] = -1; });
    for (const name of list) state.room[index.get(name)!] = room;
  };
  const onDuty = (state: State) => names.filter((_name, k) => state.room[k]! >= 0 && !dorm[state.room[k]!]);
  const execute = (state: State, plan: MaaPlan) => {
    const fia = plan.Fiammetta, target = fia && fia.enable !== false && fia.target ? fia.target : null;
    let swap: { target: string; happened: boolean } | null = null;
    const pair = () => {
      const first = rooms.indexOf('dormitory[0]');
      seat(state, first, [target!]);
      seat(state, first, [target!, FIAMMETTA]);
      const mine = index.get(FIAMMETTA)!, theirs = index.get(target!)!, full = state.mood[mine]! >= CAP - 1e-6;
      if (full) { const kept = state.mood[theirs]!; state.mood[theirs] = state.mood[mine]!; state.mood[mine] = kept; }
      swap = { target: target!, happened: full };
    };
    if (target && fia!.order !== 'post') pair();
    for (const [facility, list] of Object.entries(plan.rooms)) list.forEach((room, k) => {
      const at = rooms.indexOf(`${facility}[${k}]`);
      if (at >= 0 && room.skip !== true && room.operators) seat(state, at, room.operators);
    });
    if (target && fia!.order === 'post') pair();
    return swap as { target: string; happened: boolean } | null;
  };
  /** Plays the runs (absolute minutes) from `from` to `to`; returns who went below zero and what each run left behind. */
  const play = (state: State, runs: number[], from: number, to: number) => {
    const exhausted = new Set<string>(), log: { plan: number; duty: string[]; swap: { target: string; happened: boolean } | null }[] = [];
    let next = 0;
    for (let time = from; time < to; time += 1) {
      while (next < runs.length && runs[next]! <= time) {
        const plan = pick(runs[next]!), swap = execute(state, plans[plan]!);
        log.push({ plan, duty: onDuty(state), swap });
        next += 1;
      }
      for (let k = 0; k < names.length; k += 1) {
        const room = state.room[k]!;
        if (room < 0) continue;
        if (dorm[room]) state.mood[k] = Math.min(CAP, state.mood[k]! + gain[k]! / 60);
        else { const value = state.mood[k]! - loss[k]! / 60; if (value < -1e-6) exhausted.add(names[k]!); state.mood[k] = Math.max(0, value); }
      }
    }
    return { exhausted: [...exhausted].sort(), log };
  };
  const start = (): State => ({ room: new Int32Array(names.length).fill(-1), mood: new Float64Array(names.length).fill(CAP) });
  const copy = (state: State): State => ({ room: state.room.slice(), mood: state.mood.slice() });
  return { play, start, copy, pick };
}

/**
 * Warms up for a month, then reads two steady days and one-off moved runs: by the whole tolerance either way, and to
 * both sides of every minute within it where the GUI's choice of plan changes.
 */
function maaOutcome(file: MaaFile, daily: number[], rateOf: (name: string) => Rate, tolerance: number) {
  const model = maaModel(file.plans, rateOf), state = model.start();
  const runs = (first: number, last: number, moved?: { day: number; run: number; by: number }) => {
    const list: number[] = [];
    for (let day = first; day <= last; day += 1) daily.forEach((at, run) => list.push(day * DAY + at + (moved && moved.day === day && moved.run === run ? moved.by : 0)));
    return list.sort((a, b) => a - b);
  };
  const origin = WARM * DAY + daily[0]!;
  model.play(state, runs(0, WARM), daily[0]!, origin);
  const steady = model.copy(state), nominal = model.play(state, runs(WARM, WARM + 2), origin, origin + 2 * DAY);
  const offsets = (at: number) => {
    const span = tolerance * 60, found = new Set([-span, span]);
    for (let by = 1 - span; by <= span; by += 1) if (model.pick(at + by) !== model.pick(at + by - 1)) for (const entry of [by - 1, by]) if (entry) found.add(entry);
    return [...found];
  };
  const deviations = daily.flatMap((at, run) => offsets(at).map(by => ({ at: at + by, by, picked: model.pick(at + by), nominal: model.pick(at),
    exhausted: model.play(model.copy(steady), runs(WARM, WARM + 6, { day: WARM + 1, run, by }), origin, origin + 6 * DAY).exhausted })));
  const always = nominal.log[0]!.duty.filter(name => nominal.log.every(entry => entry.duty.includes(name)));
  const unrelieved = always.filter(name => !(nominal.log.every(entry => entry.swap?.target === name && entry.swap.happened) && rateOf(name).work <= FIAMMETTA_RATE));
  return { nominal: nominal.exhausted, deviations, unrelieved, missedSwaps: nominal.log.filter(entry => entry.swap && !entry.swap.happened).length, log: nominal.log };
}

// ---- the plan matrix ---------------------------------------------------------------------------------------------------

type Shape = { name: string; file: () => MaaFile; daily: number[]; runs?: string[]; shifts: number };
const exported = (input: unknown) => JSON.parse(exportMaaPlan(parsePlanSpec(input).spec!).text) as MaaFile;
const two = () => exported(planInput());
const withPeriods = (periods: [string, string][][], make: () => MaaFile = two) => () => { const file = make(); periods.forEach((period, k) => { file.plans[k]!.period = period; }); return file; };
const three = () => exported({ ...planInput(), shifts: [
  { name: '合成一', period: '00:00-08:00', rooms: { control: [['合成控一']], manufacture: [['合成金一', '合成金二']], trading: [['合成贸一']], dormitory: [['合成控二', '合成金三', '合成金四', '合成贸二', '合成宿一']] } },
  { name: '合成二', period: '08:00-16:00', rooms: { control: [['合成控二']], manufacture: [['合成金三', '合成金四']], trading: [['合成贸二']], dormitory: [['合成控三', '合成记一', '合成贸三', '合成控一', '合成金一']] } },
  { name: '合成三', period: '16:00-00:00', rooms: { control: [['合成控三']], manufacture: [['合成记一']], trading: [['合成贸三']], dormitory: [['合成金二', '合成贸一', '合成控一', '合成金一', '合成宿一']] } },
] });
/** The night plan leaves the trading post as it is, so the day trader stays there (it is in no night list either). */
const skipped = () => { const file = withPeriods([[['08:00', '20:00']], [['20:00', '23:59'], ['00:00', '08:00']]])(); file.plans[1]!.rooms.trading = [{ skip: true }]; file.plans[1]!.rooms.dormitory![0]!.operators![4] = '合成贸三'; return file; };
const shapes: Shape[] = [
  { name: 'two shifts 08/20, runs at the period starts', file: withPeriods([[['08:00', '20:00']], [['20:00', '23:59'], ['00:00', '08:00']]]), daily: [480, 1200], shifts: 2 },
  { name: 'two shifts, periods one hour early, MAA runs 08:00/20:00', file: two, daily: [480, 1200], runs: ['08:00', '20:00'], shifts: 2 },
  { name: 'two shifts, only the day period early, MAA runs 08:00/20:00', file: withPeriods([[['07:00', '20:00']], [['20:00', '23:59'], ['00:00', '07:00']]]), daily: [480, 1200], runs: ['08:00', '20:00'], shifts: 2 },
  { name: 'three shifts at the period starts', file: three, daily: [0, 480, 960], shifts: 3 },
  { name: 'three shifts, MAA runs half past', file: three, daily: [30, 510, 990], runs: ['00:30', '08:30', '16:30'], shifts: 3 },
  { name: 'two plans in four six-hour segments', file: withPeriods([[['00:00', '06:00'], ['12:00', '18:00']], [['06:00', '12:00'], ['18:00', '23:59']]]), daily: [0, 360, 720, 1080], shifts: 2 },
  { name: 'two plans in uneven segments', file: withPeriods([[['00:00', '09:00'], ['11:00', '20:00']], [['09:00', '11:00'], ['20:00', '23:59']]]), daily: [0, 540, 660, 1200], shifts: 2 },
  { name: 'a trading post skipped at night', file: skipped, daily: [480, 1200], shifts: 2 },
];
type Variant = { name: string; post?: boolean; apply: (file: MaaFile) => void };
const onDuty = (file: MaaFile, inDorm: boolean) => {
  file.plans[1]!.rooms.control = [{ operators: ['合成控一'] }];
  file.plans[1]!.rooms.dormitory![0]!.operators![1] = '合成控三';
  if (inDorm) for (const plan of file.plans) plan.rooms.dormitory![0]!.operators![0] = FIAMMETTA;
};
const swapAt = (file: MaaFile, plans: number[], order: string) => { for (const k of plans) file.plans[k]!.Fiammetta = { enable: true, target: '合成控一', order }; };
const variants: Variant[] = [
  { name: 'no Fiammetta', apply: () => undefined },
  { name: 'Fiammetta pre at every change', apply: file => { onDuty(file, true); swapAt(file, file.plans.map((_plan, k) => k), 'pre'); } },
  { name: 'Fiammetta pre in the first plan only', apply: file => { onDuty(file, true); swapAt(file, [0], 'pre'); } },
  { name: 'Fiammetta post at every change', post: true, apply: file => { onDuty(file, true); swapAt(file, file.plans.map((_plan, k) => k), 'post'); } },
  { name: 'Fiammetta pre, in no dormitory list', apply: file => { onDuty(file, false); swapAt(file, file.plans.map((_plan, k) => k), 'pre'); } },
];
const rates: Rate[] = [{ work: 1, rest: 2 }, { work: 1.5, rest: 2 }, { work: 1.9, rest: 3 }, { work: 2.5, rest: 3 }];
type Case = { label: string; shape: Shape; variant: Variant; rate: Rate; rates?: Record<string, Rate>; tolerance: number };
const rateFor = (item: Case) => (name: string) => item.rates?.[name] ?? item.rate;
const cases: Case[] = [];
for (const shape of shapes) for (const variant of shape.shifts === 2 && !shape.name.includes('skipped') ? variants : variants.slice(0, 1)) for (const rate of rates)
  cases.push({ label: `${shape.name} / ${variant.name} / work ${rate.work} rest ${rate.rest}`, shape, variant, rate, tolerance: 1 });
for (const rate of rates) cases.push({ label: `two shifts, tolerance 2 / work ${rate.work} rest ${rate.rest}`, shape: shapes[1]!, variant: variants[0]!, rate, tolerance: 2 });
// The day period starts 45 minutes before its 08:00 run. An hour early (07:00) is still night: the night shift, at 0.5 an
// hour, works on for 36 hours and holds. 45 minutes early (07:15) is day: the day shift, at 1.8 an hour with 1.8 back,
// starts after 45 minutes less rest and works 45 minutes longer, and runs out (an hour late at 21:00 does too).
const boundary: Shape = { name: 'day period 45 minutes before its run', file: withPeriods([[['07:15', '19:00']], [['19:00', '23:59'], ['00:00', '07:15']]]), daily: [480, 1200], runs: ['08:00', '20:00'], shifts: 2 };
const dayFast = Object.fromEntries(['合成控一', '合成金一', '合成金二', '合成贸一'].map(name => [name, { work: 1.8, rest: 1.8 }]));
const nightSlow = Object.fromEntries(['合成控二', '合成金三', '合成金四', '合成贸二'].map(name => [name, { work: 0.5, rest: 2 }]));
cases.push({ label: 'a day period 45 minutes before its run', shape: boundary, variant: variants[0]!, rate: { work: 1, rest: 2 }, rates: { ...dayFast, ...nightSlow }, tolerance: 1 });

const checkOf = (item: Case, file: MaaFile) => {
  const text = JSON.stringify(file, null, 2);
  const context: CheckContext = { layout: layout() as CheckContext['layout'], snapshot: planSnapshot(), tables: planTables(), names: parseNameTable(JSON.stringify(nameTable())),
    moodDefault: { ...item.rate, basis: '合成假设' }, ...(item.rates ? { mood: Object.fromEntries(Object.entries(item.rates).map(([name, rate]) => [name, { ...rate, basis: '合成假设' }])) } : {}), combos: [], exclusions: [], tolerance: item.tolerance, shifts: item.shape.shifts, texts: [], reexport: text,
    ...(item.shape.runs ? { runs: item.shape.runs } : {}) };
  return checkPlanText(text, context);
};

test('the timeline gates agree with a minute-by-minute model of MAA over 2- and 3-shift, multi-segment, Fiammetta pre/post and early/late runs', (t) => {
  const tally: Record<string, Record<string, number>> = { 4: {}, 5: {}, 11: {}, 14: {} };
  const facts = checkOf(cases[0]!, cases[0]!.shape.file()).facts;
  assert.equal(facts.moodCap, CAP, 'the model uses the cap the fixed game table gives');
  assert.equal(facts.fiammettaRate, FIAMMETTA_RATE, 'the model uses the Fiammetta recovery the fixed game table gives');
  for (const item of cases) {
    const file = item.shape.file();
    item.variant.apply(file);
    const check = checkOf(item, file), maa = maaOutcome(file, item.shape.daily, rateFor(item), item.tolerance);
    const verdict = (id: number) => check.gates.find(entry => entry.gate === id)!;
    const late = maa.deviations.filter(entry => entry.exhausted.length).map(entry => `${entry.by > 0 ? 'late' : 'early'} ${entry.at} picks ${entry.picked}: ${entry.exhausted.join(',')}`);
    const expected: Record<number, boolean> = {
      4: maa.nominal.length > 0,
      5: maa.unrelieved.length > 0,
      11: item.variant.post === true || maa.missedSwaps > 0,
      14: maa.nominal.length > 0 || late.length > 0,
    };
    for (const id of [4, 5, 11, 14]) {
      const gate = verdict(id);
      assert.notEqual(gate.verdict, 'unverified', `${item.label}: gate ${id} has every fact it needs: ${JSON.stringify(gate)}`);
      assert.equal(gate.verdict === 'fail', expected[id], `${item.label}: gate ${id} says ${gate.verdict}; MAA model: on time ${JSON.stringify(maa.nominal)}, `
        + `always on duty ${JSON.stringify(maa.unrelieved)}, missed swaps ${maa.missedSwaps}, deviations ${JSON.stringify(late)}; evidence ${JSON.stringify(gate.evidence)}`);
      tally[id]![gate.verdict] = (tally[id]![gate.verdict] ?? 0) + 1;
    }
  }
  for (const id of [4, 5, 11, 14]) assert.ok(tally[id]!.pass && tally[id]!.fail, `gate ${id} passes and fails somewhere in the matrix: ${JSON.stringify(tally[id])}`);
  t.diagnostic(`${cases.length} plans; verdicts per gate: ${JSON.stringify(tally)}`);
});

test('named outcomes in the matrix: the early-run remedy, Fiammetta post, and a skipped room', () => {
  const play = (item: Case) => { const file = item.shape.file(); item.variant.apply(file); return { check: checkOf(item, file), maa: maaOutcome(file, item.shape.daily, rateFor(item), item.tolerance) }; };
  const run = (shape: number, variant: number, rate: Rate) => play({ label: '', shape: shapes[shape]!, variant: variants[variant]!, rate, tolerance: 1 });
  const gate = (check: ReturnType<typeof checkPlanText>, id: number) => check.gates.find(entry => entry.gate === id)!;
  // At the period starts an early day run still picks the night plan: the night shift works on until 20:00.
  const nominal = run(0, 0, { work: 1.5, rest: 2 });
  const early = nominal.maa.deviations.find(entry => entry.by < 0 && entry.at === 420)!;
  assert.deepEqual([early.picked, early.nominal], [1, 0]);
  assert.ok(early.exhausted.includes('合成控二'));
  assert.equal(gate(nominal.check, 14).verdict, 'fail');
  // Periods one hour early with MAA still at 08:00/20:00: the early run picks the day plan and nobody runs out.
  const remedied = run(1, 0, { work: 1.5, rest: 2 });
  assert.ok(remedied.maa.deviations.every(entry => entry.picked === entry.nominal && !entry.exhausted.length));
  assert.equal(gate(remedied.check, 14).verdict, 'pass', JSON.stringify(gate(remedied.check, 14)));
  // "post": the pair runs after the dormitory task, so dormitory 1 ends with only the target and Fiammetta.
  const post = run(0, 3, { work: 1, rest: 2 });
  assert.ok(post.maa.log.every(entry => !entry.duty.includes('合成控一')), 'the target leaves its work room at every run');
  assert.ok(post.maa.nominal.length > 0, 'the operators cleared out of dormitory 1 never recover');
  assert.equal(gate(post.check, 11).verdict, 'fail');
  assert.ok(gate(post.check, 11).evidence.some(entry => entry.includes('post')), JSON.stringify(gate(post.check, 11)));
  // Where MAA's choice flips inside the tolerance, both sides of the flip are tried, not only the two ends.
  const inside = play(cases.at(-1)!), moved = (by: number) => inside.maa.deviations.find(entry => entry.at === 480 + by)!;
  assert.deepEqual([moved(-60).picked, moved(-46).picked, moved(-45).picked], [1, 1, 0]);
  assert.deepEqual([moved(-60).exhausted, moved(-45).exhausted.length > 0], [[], true]);
  assert.ok(gate(inside.check, 14).evidence.some(entry => entry.startsWith('提前 0.75 小时（07:15）运行时 MAA 选 plans[0]：合成')), JSON.stringify(gate(inside.check, 14)));
  // A skipped room keeps whoever MAA seated there last.
  const skip = run(7, 0, { work: 1, rest: 2 });
  assert.deepEqual(skip.maa.unrelieved, ['合成贸一']);
  assert.ok(gate(skip.check, 5).evidence.some(entry => entry.includes('合成贸一')), JSON.stringify(gate(skip.check, 5)));
});
