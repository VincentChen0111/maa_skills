// Shared base schedule tool (ticket 22): builds, checks and writes MAA custom infrastructure plan files (排班文件).
// Advice only. The one thing it writes is the plan file inside the private directory: no MAA configuration, no MAA
// run, no game clicks, no device. Applying an approved plan belongs to maa-daily (ticket 23), which re-runs this check.
// MAA facts are pinned to v6.21.4 (52d0b2a) and game facts to the fixed game mirror; every source position and the
// reading behind each rule and gate are in docs/base-plan-verification.md of the repository.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseGameSource, queryBaseSkills } from './base-query.ts';
import { readPublicJson } from './public-data.ts';
import { readSettings } from './preferences.ts';
import { inline } from './research.ts';

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown): ObjectValue => isObject(value) ? value : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const filled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const epsilon = 1e-9;

// ---- MAA custom infrastructure protocol (v6.21.4) ---------------------------------------------------------------

export const facilities = ['control', 'manufacture', 'trading', 'power', 'meeting', 'hire', 'dormitory', 'processing', 'training', 'recycle'] as const;
export type Facility = typeof facilities[number];
const isFacility = (value: unknown): value is Facility => facilities.includes(value as Facility);
/** The game table room behind each MAA facility key. */
const gameRoom: Record<Facility, string> = { control: 'CONTROL', manufacture: 'MANUFACTURE', trading: 'TRADING', power: 'POWER', meeting: 'MEETING', hire: 'HIRE',
  dormitory: 'DORMITORY', processing: 'WORKSHOP', training: 'TRAINING', recycle: 'RECYCLE' };
/** The product strings MaaCore parses (case-sensitive), per facility. */
export const products: Partial<Record<Facility, string[]>> = { manufacture: ['Battle Record', 'Pure Gold', 'Originium Shard', 'Dualchip'], trading: ['LMD', 'Orundum'] };
/** Fixed game-table wording that ties a production skill to one product. */
const productWording: Record<string, RegExp> = { 'Battle Record': /作战记录类配方/, 'Pure Gold': /贵金属类配方/, 'Originium Shard': /源石类配方/, 'Dualchip': /芯片类配方/,
  'LMD': /赤金订单|贵金属订单/, 'Orundum': /合成玉订单/ };
const keys = {
  top: ['title', 'description', 'plans'], extension: ['layout', 'operators', 'metadata'],
  plan: ['name', 'description', 'description_post', 'period', 'duration', 'Fiammetta', 'drones', 'groups', 'rooms'],
  room: ['operators', 'sort', 'skip', 'autofill', 'product', 'candidates', 'use_operator_groups', 'operatorsA', 'operatorsB'],
  Fiammetta: ['enable', 'target', 'order'], drones: ['enable', 'room', 'index', 'rule', 'order'], group: ['name', 'operators'],
};
const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minuteOf = (value: unknown) => { const match = typeof value === 'string' ? clock.exec(value) : null; return match ? Number(match[1]) * 60 + Number(match[2]) : null; };
/** MAA compares hh:mm only, so `23:59` is the protocol's end of day; it closes the day for durations and coverage. */
const endMinute = (value: number) => value === 1439 ? 1440 : value;

// ---- inputs ---------------------------------------------------------------------------------------------------------

export type LayoutRoom = { type: Facility; level: number; product?: string; position?: string };
export type RoomSpec = { operators: string[]; sort?: true } | null;
export type ShiftSpec = { name: string; description: string | null; period: [string, string][]; rooms: Partial<Record<Facility, (RoomSpec | undefined)[]>>;
  fiammetta: { target: string; order: 'pre' | 'post' } | null; drones: { room: 'trading' | 'manufacture'; index: number; order: 'pre' | 'post' } | null; reasons: Record<string, string> };
export type MoodRate = { work: number; rest: number; basis: string };
export type Combo = { name?: string; members: string[]; dependsOn?: string[]; basis: string };
export type Exclusion = { members: string[]; basis: string };
export type EfficiencyClaim = { plan: number; room: string; base: number; skill: number; global: number; total?: number; basis: string; conditions?: string; unmodelled?: string };
export type PlanSpec = { title: string | null; description: string | null; layout: LayoutRoom[]; shifts: ShiftSpec[]; fill: boolean; mood?: Record<string, MoodRate>;
  moodDefault?: MoodRate; combos?: Combo[]; exclusions?: Exclusion[]; efficiency?: EfficiencyClaim[]; tolerance: number };
/** Design default 2026-11-13: a plan must still hold when the shift change happens one hour late or early. */
export const defaultTolerance = 1;

export function parseLayout(value: unknown): { layout?: LayoutRoom[]; issues: string[] } {
  if (!Array.isArray(value) || !value.length) return { issues: ['layout-required'] };
  const issues: string[] = [], layout: LayoutRoom[] = [];
  value.forEach((raw, index) => {
    const room = object(raw), type = room.type;
    const ok = isObject(raw) && Object.keys(room).every(key => ['type', 'level', 'product', 'position'].includes(key)) && isFacility(type)
      && Number.isSafeInteger(room.level) && Number(room.level) >= 1 && Number(room.level) <= 5
      && (room.product === undefined || (products[type] ?? []).includes(String(room.product))) && (room.position === undefined || filled(room.position));
    if (!ok) { issues.push(`layout-invalid:${index}`); return; }
    layout.push({ type, level: Number(room.level), ...(room.product === undefined ? {} : { product: String(room.product) }), ...(room.position === undefined ? {} : { position: String(room.position) }) });
  });
  return issues.length ? { issues } : { layout, issues };
}

/** `hh:mm-hh:mm` or MAA pairs; a pair that crosses midnight is split in two, as the MAA protocol writes it. */
function normalizePeriod(value: unknown): [string, string][] | null {
  const pairs = typeof value === 'string' ? [value.split('-')] : Array.isArray(value) ? value.map(list) : null;
  if (!pairs?.length) return null;
  const result: [string, string][] = [];
  for (const pair of pairs) {
    const [start, end] = pair as [string, string], from = minuteOf(start), to = minuteOf(end);
    if (pair.length !== 2 || from === null || to === null || from === to) return null;
    if (from < to) result.push([start, end]);
    else { result.push([start, '23:59']); if (to > 0) result.push(['00:00', end]); }
  }
  return result;
}
const names = (value: unknown) => Array.isArray(value) && value.every(filled) ? value as string[] : null;
const rate = (value: unknown): MoodRate | null => { const entry = object(value);
  return isObject(value) && Object.keys(entry).every(key => ['work', 'rest', 'basis'].includes(key)) && finite(entry.work) && finite(entry.rest) && entry.rest >= 0 && filled(entry.basis)
    ? { work: entry.work, rest: entry.rest, basis: entry.basis } : null; };

function parseShift(raw: unknown, index: number, layout: LayoutRoom[], issues: string[]): ShiftSpec | null {
  const shift = object(raw);
  if (!isObject(raw) || Object.keys(shift).some(key => !['name', 'description', 'period', 'rooms', 'fiammetta', 'drones', 'reasons'].includes(key)) || !filled(shift.name)
    || shift.description !== undefined && typeof shift.description !== 'string') { issues.push(`shift-invalid:${index}`); return null; }
  const period = normalizePeriod(shift.period);
  if (!period) issues.push(`shift-period-invalid:${index}`);
  const rooms: ShiftSpec['rooms'] = {};
  for (const [facility, entries] of Object.entries(object(shift.rooms))) {
    const count = layout.filter(room => room.type === facility).length;
    if (!isFacility(facility) || facility === 'training' || !Array.isArray(entries) || entries.length > count) { issues.push(`shift-room-invalid:${index}.${facility}`); continue; }
    rooms[facility] = entries.map(entry => {
      if (entry === null) return null;
      const operators = names(Array.isArray(entry) ? entry : object(entry).operators), sort = object(entry).sort;
      if (!operators || !Array.isArray(entry) && (Object.keys(object(entry)).some(key => !['operators', 'sort'].includes(key)) || sort !== undefined && typeof sort !== 'boolean')) {
        issues.push(`shift-room-invalid:${index}.${facility}`); return undefined;
      }
      return { operators, ...(sort === true ? { sort: true as const } : {}) };
    });
  }
  if (shift.rooms !== undefined && !isObject(shift.rooms)) issues.push(`shift-room-invalid:${index}`);
  const fia = object(shift.fiammetta), drone = object(shift.drones);
  const fiammetta = shift.fiammetta === undefined ? null : filled(fia.target) && [undefined, 'pre', 'post'].includes(fia.order as string) && Object.keys(fia).every(key => ['target', 'order'].includes(key))
    ? { target: fia.target, order: (fia.order ?? 'pre') as 'pre' | 'post' } : undefined;
  const drones = shift.drones === undefined ? null : ['trading', 'manufacture'].includes(drone.room as string) && Number.isSafeInteger(drone.index) && Number(drone.index) >= 1
    && [undefined, 'pre', 'post'].includes(drone.order as string) && Object.keys(drone).every(key => ['room', 'index', 'order'].includes(key))
    ? { room: drone.room as 'trading' | 'manufacture', index: Number(drone.index), order: (drone.order ?? 'pre') as 'pre' | 'post' } : undefined;
  if (fiammetta === undefined) issues.push(`shift-fiammetta-invalid:${index}`);
  if (drones === undefined) issues.push(`shift-drones-invalid:${index}`);
  const reasons = object(shift.reasons);
  if (shift.reasons !== undefined && (!isObject(shift.reasons) || Object.values(reasons).some(text => !filled(text)))) issues.push(`shift-reasons-invalid:${index}`);
  return { name: shift.name, description: typeof shift.description === 'string' ? shift.description : null, period: period ?? [], rooms,
    fiammetta: fiammetta ?? null, drones: drones ?? null, reasons: reasons as Record<string, string> };
}

const specKeys = ['title', 'description', 'layout', 'shifts', 'fill', 'mood', 'moodDefault', 'combos', 'exclusions', 'efficiency', 'tolerance'];
/** Validates the agent's proposal; returns issues instead of guessing. `allowed` names the caller's own extra keys. */
export function parsePlanSpec(value: unknown, allowed: string[] = []): { spec?: PlanSpec; issues: string[] } {
  const input = object(value);
  if (!isObject(value)) return { issues: ['input-invalid'] };
  const issues = Object.keys(input).filter(key => !specKeys.includes(key) && !allowed.includes(key)).map(key => `input-invalid:${key}`);
  const { layout, issues: layoutIssues } = parseLayout(input.layout);
  issues.push(...layoutIssues);
  if (!Array.isArray(input.shifts) || !input.shifts.length) issues.push('shifts-required');
  const shifts = layout ? list(input.shifts).map((raw, index) => parseShift(raw, index, layout, issues)) : [];
  for (const key of ['title', 'description']) if (input[key] !== undefined && !filled(input[key])) issues.push(`${key}-invalid`);
  if (input.fill !== undefined && typeof input.fill !== 'boolean') issues.push('fill-invalid');
  const mood: Record<string, MoodRate> = {};
  for (const [name, entry] of Object.entries(object(input.mood))) { const parsed = rate(entry); if (parsed) mood[name] = parsed; else issues.push(`mood-invalid:${name}`); }
  if (input.mood !== undefined && !isObject(input.mood)) issues.push('mood-invalid');
  const moodDefault = input.moodDefault === undefined ? undefined : rate(input.moodDefault);
  if (moodDefault === null) issues.push('mood-default-invalid');
  const groupList = (field: string, min: number, extra: string[]) => {
    if (input[field] === undefined) return undefined;
    const ok = Array.isArray(input[field]) && list(input[field]).every(raw => { const entry = object(raw);
      return isObject(raw) && Object.keys(entry).every(key => ['members', 'basis', ...extra].includes(key)) && names(entry.members) && list(entry.members).length >= min && filled(entry.basis)
        && (entry.dependsOn === undefined || names(entry.dependsOn)) && (entry.name === undefined || filled(entry.name)); });
    if (!ok) issues.push(`${field}-invalid`);
    return ok ? structuredClone(input[field]) as never : undefined;
  };
  const combos = groupList('combos', 1, ['name', 'dependsOn']) as Combo[] | undefined, exclusions = groupList('exclusions', 2, []) as Exclusion[] | undefined;
  let efficiency: EfficiencyClaim[] | undefined;
  if (input.efficiency !== undefined) {
    efficiency = [];
    for (const [index, raw] of list(input.efficiency).entries()) {
      const claim = object(raw);
      if (!isObject(raw) || Object.keys(claim).some(key => !['plan', 'room', 'base', 'skill', 'global', 'total', 'basis', 'conditions', 'unmodelled'].includes(key)) || !Number.isSafeInteger(claim.plan)
        || !filled(claim.room) || !finite(claim.base) || !finite(claim.skill) || !finite(claim.global) || claim.total !== undefined && !finite(claim.total) || !filled(claim.basis)
        || [claim.conditions, claim.unmodelled].some(text => text !== undefined && !filled(text))) { issues.push(`efficiency-invalid:${index}`); continue; }
      efficiency.push(structuredClone(claim) as EfficiencyClaim);
    }
    if (!Array.isArray(input.efficiency)) issues.push('efficiency-invalid');
  }
  const tolerance = input.tolerance === undefined ? defaultTolerance : input.tolerance;
  if (!finite(tolerance) || tolerance < 0 || tolerance > 24) issues.push('tolerance-invalid');
  if (issues.length || !layout) return { issues };
  return { spec: { title: typeof input.title === 'string' ? input.title : null, description: typeof input.description === 'string' ? input.description : null, layout,
    shifts: shifts as ShiftSpec[], fill: input.fill === true, ...(input.mood === undefined ? {} : { mood }), ...(moodDefault ? { moodDefault } : {}),
    ...(combos ? { combos } : {}), ...(exclusions ? { exclusions } : {}), ...(efficiency ? { efficiency } : {}), tolerance: tolerance as number }, issues };
}

// ---- tables, facts and the MAA name table ---------------------------------------------------------------------------

export type PlanTables = { characters: unknown; building: unknown; charMeta?: unknown };
export type SourceFile = { repository: string; commit: string; file: string; sha256: string; readAt: string };
export type LoadedTables = { tables: PlanTables; mode: 'public' | 'supplied'; files: SourceFile[] };
export const planTableSources = {
  characters: { ...baseGameSource, file: 'zh_CN/gamedata/excel/character_table.json' },
  building: { ...baseGameSource, file: 'zh_CN/gamedata/excel/building_data.json' },
  charMeta: { ...baseGameSource, file: 'zh_CN/gamedata/excel/char_meta_table.json' },
};
/** The fixed public tables, read at run time; nothing is bundled. Without the alternate-form table that one check stays unverified. */
export async function loadPlanTables(fetcher: typeof fetch = fetch): Promise<LoadedTables> {
  const [characters, building, charMeta] = await Promise.allSettled([readPublicJson(planTableSources.characters, fetcher), readPublicJson(planTableSources.building, fetcher),
    readPublicJson(planTableSources.charMeta, fetcher)]);
  if (characters.status === 'rejected') throw characters.reason;
  if (building.status === 'rejected') throw building.reason;
  const files = [characters.value, building.value, ...(charMeta.status === 'fulfilled' ? [charMeta.value] : [])]
    .map(({ source }) => ({ repository: source.repository, commit: source.commit, file: source.file, sha256: source.sha256, readAt: source.readAt }));
  return { tables: { characters: characters.value.value, building: building.value.value, charMeta: charMeta.status === 'fulfilled' ? charMeta.value.value : undefined }, mode: 'public', files };
}
/** Offline tables for replay and synthetic demos; labelled as supplied, never as the public mirror. */
export async function suppliedPlanTables(file: string): Promise<LoadedTables> {
  let text: string, value: ObjectValue;
  try { text = await readFile(file, 'utf8'); value = object(JSON.parse(text)); } catch { throw new Error('plan-tables-invalid'); }
  return { tables: { characters: value.characters, building: value.building, charMeta: value.charMeta }, mode: 'supplied',
    files: [{ repository: 'supplied', commit: 'supplied', file: 'tablesFile', sha256: digest(text), readAt: new Date().toISOString() }] };
}

export type GameFacts = { capacity: Partial<Record<Facility, number[]>>; maxCount: Partial<Record<Facility, number>>; moodCap: number | null; fiammettaRate: number | null;
  fiammettaIds: string[]; forms: Record<string, string> | null; ids: Record<string, string[]> };
const strip = (text: unknown) => typeof text === 'string' ? text.replace(/<[^>]*>/g, '') : '';
/** Facts read from the fixed game tables; a fact the tables do not yield stays null and its check stays unverified. */
export function gameFacts(tables: PlanTables): GameFacts {
  const building = object(tables.building), rooms = object(building.rooms), chars = object(building.chars), buffs = object(building.buffs);
  const capacity: GameFacts['capacity'] = {}, maxCount: GameFacts['maxCount'] = {};
  for (const facility of facilities) {
    const room = object(rooms[gameRoom[facility]]), sizes = list(room.phases).map(phase => object(phase).maxStationedNum);
    if (sizes.length && sizes.every(size => Number.isSafeInteger(size) && Number(size) >= 0)) capacity[facility] = sizes as number[];
    if (Number.isSafeInteger(room.maxCount) && Number(room.maxCount) > 0) maxCount[facility] = Number(room.maxCount);
  }
  // Mood cap: every operator's maxManpower over the display factor (8640000 / 360000 = 24 in the pinned table).
  const manpower = [...new Set(Object.values(chars).map(entry => object(entry).maxManpower))], factor = building.manpowerDisplayFactor;
  const moodCap = manpower.length === 1 && finite(manpower[0]) && manpower[0] > 0 && finite(factor) && factor > 0 ? manpower[0] / factor : null;
  // Fiammetta: the dorm skill that swaps mood when full, paired with 「自身心情每小时恢复+N」 and no other recovery source.
  let fiammettaRate: number | null = null;
  const fiammettaIds: string[] = [];
  for (const [id, entry] of Object.entries(chars)) {
    const buffIds = list(object(entry).buffChar).flatMap(slot => list(object(slot).buffData).map(data => String(object(data).buffId)));
    if (!buffIds.some(buff => buff.startsWith('dorm_exchangeAp'))) continue;
    fiammettaIds.push(id);
    for (const buff of buffIds.filter(buff => buff.startsWith('dorm_recExcludeOther'))) {
      const match = /自身心情每小时恢复\+(\d+(?:\.\d+)?)/.exec(strip(object(buffs[buff]).description));
      if (match) fiammettaRate = Number(match[1]);
    }
  }
  let forms: GameFacts['forms'] = null;
  const groups = object(tables.charMeta).spCharGroups;
  if (isObject(groups)) { forms = {}; for (const [group, members] of Object.entries(groups)) if (list(members).length > 1) for (const id of list(members)) forms[String(id)] = group; }
  const ids: GameFacts['ids'] = {};
  for (const [id, row] of Object.entries(object(tables.characters))) { const name = object(row).name; if (typeof name === 'string' && /^char_/.test(id)) (ids[name] ??= []).push(id); }
  return { capacity, maxCount, moodCap, fiammettaRate, fiammettaIds, forms, ids };
}

export type NameTable = { status: 'available'; names: string[]; sha256: string } | { status: 'unavailable'; reason: string };
/** MAA's own operator list: `chars[*].name` of non-token professions in resource/battle_data.json (BattleDataConfig). */
const professions = ['CASTER', 'MEDIC', 'PIONEER', 'SNIPER', 'SPECIAL', 'SUPPORT', 'TANK', 'WARRIOR'];
export function parseNameTable(text: string): NameTable {
  try {
    const found = new Set<string>();
    for (const row of Object.values(object(object(JSON.parse(text)).chars))) { const entry = object(row); if (professions.includes(String(entry.profession)) && filled(entry.name)) found.add(entry.name); }
    if (found.size) return { status: 'available', names: [...found].sort(), sha256: digest(text) };
  } catch { /* reported below */ }
  return { status: 'unavailable', reason: 'name-table-invalid' };
}
export async function readMaaNameTable(maaDirectory: string | null): Promise<NameTable> {
  if (!maaDirectory) return { status: 'unavailable', reason: 'maa-directory-unset' };
  let text: string;
  try { text = await readFile(join(maaDirectory, 'resource', 'battle_data.json'), 'utf8'); } catch { return { status: 'unavailable', reason: 'name-table-missing' }; }
  return parseNameTable(text);
}

export type OperatorFacts = { id: string | null; ownership: 'owned' | 'unobserved' | 'ambiguous' | 'not-found' | 'unknown'; elite: number | null; level: number | null;
  skills: { id: string; name: string; room: string | null; status: string; text: string }[] };
/**
 * Ownership and effective skills from the shared base skill query (ticket 21); nothing is re-derived here. A plan names
 * operators by display name, which a few game IDs share: the one form the snapshot owns is used; when the snapshot owns
 * none the name is unobserved, and when it owns several the name is owned but which skills apply stays unknown.
 * `id: null` always means the skills are unknown.
 */
export function operatorFacts(names: string[], snapshot: unknown, tables: PlanTables | null): Record<string, OperatorFacts> {
  const result: Record<string, OperatorFacts> = {};
  const query = (operator: string) => queryBaseSkills(snapshot, { characters: tables!.characters, building: tables!.building }, { operators: [operator] }).operators[0];
  for (const name of [...new Set(names)].sort()) {
    if (snapshot === null || snapshot === undefined || !tables) { result[name] = { id: null, ownership: 'unknown', elite: null, level: null, skills: [] }; continue; }
    let found;
    try { found = query(name); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('base-name-ambiguous')) throw error;
      const owned = list(object(snapshot).operators).map(object).filter(row => row.name === name);
      if (owned.length === 1) found = query(String(owned[0]!.id));
      else { result[name] = { id: null, ownership: owned.length ? 'ambiguous' : 'unobserved', elite: null, level: null, skills: [] }; continue; }
    }
    result[name] = found ? { id: found.id, ownership: found.ownership === 'owned' ? 'owned' : 'unobserved', elite: found.elite, level: found.level,
      skills: found.skills.filter(skill => skill.status === 'active' || skill.status === 'unknown').map(skill => ({ id: skill.id, name: skill.name, room: skill.room, status: skill.status, text: skill.text })) }
      : { id: null, ownership: 'not-found', elite: null, level: null, skills: [] };
  }
  return result;
}
/** Observed owned operators with their effective skills, in account snapshot order. */
function ownedRoster(snapshot: unknown, tables: PlanTables) {
  const rank = new Map(list(object(snapshot).operators).map((row, index) => [String(object(row).id), index]));
  return queryBaseSkills(snapshot, { characters: tables.characters, building: tables.building }, {}).operators.filter(entry => entry.ownership === 'owned')
    .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}
const specificTo = (text: string) => Object.entries(productWording).filter(([, pattern]) => pattern.test(text)).map(([product]) => product);
const mismatched = (text: string, product: string | undefined) => { const specific = specificTo(text); return product !== undefined && specific.length > 0 && !specific.includes(product); };

// ---- generation: fill and export -------------------------------------------------------------------------------------

export type Fill = { plan: number; room: string; operators: string[] };
const fillOrder: Facility[] = ['control', 'trading', 'manufacture', 'power', 'meeting', 'hire', 'processing', 'recycle'];
/**
 * Fills only rooms the proposal left out: owned operators, in snapshot order, with an active skill for that room and
 * no product mismatch, not already used in the shift and not on duty in the neighbouring shift (the previous one, and
 * for the last shift also the first, since shifts form a cycle). No benefit is compared.
 */
function fillShifts(spec: PlanSpec, owned: { name: string; skills: OperatorFacts['skills'] }[], facts: GameFacts): Fill[] {
  const fills: Fill[] = [];
  const working = (shift: ShiftSpec) => new Set(Object.entries(shift.rooms).filter(([facility]) => facility !== 'dormitory').flatMap(([, entries]) => (entries ?? []).flatMap(entry => entry?.operators ?? [])));
  spec.shifts.forEach((shift, index) => {
    const used = new Set(Object.values(shift.rooms).flatMap(entries => (entries ?? []).flatMap(entry => entry?.operators ?? [])));
    // The shifts form a cycle: the last shift is also followed by the first one.
    const previous = new Set([...index ? working(spec.shifts[index - 1]!) : [], ...index && index === spec.shifts.length - 1 ? working(spec.shifts[0]!) : []]);
    for (const facility of fillOrder) spec.layout.filter(room => room.type === facility).forEach((room, k) => {
      const entries = shift.rooms[facility] ??= [];
      const size = facts.capacity[facility]?.[room.level - 1];
      if (entries[k] !== undefined || !size) return;
      const pick = owned.filter(operator => !used.has(operator.name) && !previous.has(operator.name)
        && operator.skills.some(skill => skill.status === 'active' && skill.room === gameRoom[facility] && !mismatched(skill.text, room.product))).slice(0, size).map(operator => operator.name);
      if (!pick.length) return;
      entries[k] = { operators: pick };
      pick.forEach(name => used.add(name));
      fills.push({ plan: index, room: `${facility}[${k}]`, operators: pick });
    });
  });
  return fills;
}

/** The tool owns its known keys; a base file's unknown keys are kept; a wrong-case copy of a known key is dropped. */
function keep(base: unknown, owned: ObjectValue, ownedKeys: readonly string[], knownKeys: readonly string[], path: string, dropped: string[]): ObjectValue {
  const result: ObjectValue = { ...owned };
  for (const [key, value] of Object.entries(object(base))) {
    if (ownedKeys.includes(key) || Object.hasOwn(result, key)) continue;
    if (!knownKeys.includes(key) && knownKeys.some(known => known.toLowerCase() === key.toLowerCase())) { dropped.push(`${path}${key}`); continue; }
    result[key] = value;
  }
  return result;
}
const minutesOf = (period: [string, string][]) => period.reduce((sum, [start, end]) => sum + endMinute(minuteOf(end)!) - minuteOf(start)!, 0);
/**
 * Deterministic export: every facility key is written so MAA never falls back to its default algorithm. Layout rooms
 * without an assignment are `skip`; facilities the layout lacks are `[]` (kept as they are). No `product` is written,
 * so MAA is never asked to switch a production line. Re-exporting the same spec and base gives the same bytes.
 */
export function exportMaaPlan(spec: PlanSpec, base?: unknown): { plan: ObjectValue; text: string; dropped: string[] } {
  const dropped: string[] = [], oldPlans = list(object(base).plans);
  const plans = spec.shifts.map((shift, index) => {
    const before = object(oldPlans[index]), oldRooms = object(before.rooms), rooms: ObjectValue = {};
    for (const facility of facilities) {
      const oldEntries = list(oldRooms[facility]);
      rooms[facility] = spec.layout.filter(room => room.type === facility).map((_room, k) => {
        const entry = shift.rooms[facility]?.[k];
        return keep(oldEntries[k], entry ? { operators: [...entry.operators], ...(entry.sort ? { sort: true } : {}) } : { skip: true }, keys.room, keys.room,
          `plans[${index}].rooms.${facility}[${k}].`, dropped);
      });
    }
    const path = `plans[${index}].`;
    return keep(before, { name: shift.name, ...(shift.description ? { description: shift.description } : {}), period: shift.period.map(pair => [...pair]), duration: minutesOf(shift.period),
      ...(shift.fiammetta ? { Fiammetta: keep(before.Fiammetta, { enable: true, target: shift.fiammetta.target, order: shift.fiammetta.order }, keys.Fiammetta, keys.Fiammetta, `${path}Fiammetta.`, dropped) } : {}),
      ...(shift.drones ? { drones: keep(before.drones, { enable: true, room: shift.drones.room, index: shift.drones.index, order: shift.drones.order }, keys.drones, keys.drones, `${path}drones.`, dropped) } : {}),
      rooms: keep(oldRooms, rooms, facilities, facilities, `${path}rooms.`, dropped) }, keys.plan, keys.plan, path, dropped);
  });
  const plan = keep(base, { ...(spec.title ? { title: spec.title } : {}), ...(spec.description ? { description: spec.description } : {}), plans }, keys.top, [...keys.top, ...keys.extension], '', dropped);
  return { plan, text: `${JSON.stringify(plan, null, 2)}\n`, dropped };
}

// ---- the private directory -----------------------------------------------------------------------------------------

const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
function planPath(root: string, target: unknown): string {
  if (!filled(target) || !/\.json$/i.test(target)) throw new Error('plan-path-invalid');
  const file = resolve(root, target);
  if (!inside(root, file)) throw new Error('plan-path-outside-private');
  return file;
}
/** Reads a file whose real path (links resolved) is inside the private directory. */
export async function readPrivateFile(privateDirectory: string, target: unknown): Promise<string> {
  const root = await realpath(resolve(privateDirectory)), file = planPath(root, target);
  let real: string;
  try { real = await realpath(file); } catch { throw new Error('plan-file-missing'); }
  if (!inside(root, real)) throw new Error('plan-path-outside-private');
  return readFile(real, 'utf8');
}
/** Atomic replace inside the private directory; a path that leaves it, also through a link, is refused before writing. */
export async function writePlanFile(privateDirectory: string, target: unknown, text: string): Promise<{ file: string; relative: string }> {
  const root = await realpath(resolve(privateDirectory)), file = planPath(root, target);
  await mkdir(dirname(file), { recursive: true });
  const parent = await realpath(dirname(file));
  if (!inside(root, join(parent, basename(file)))) throw new Error('plan-path-outside-private');
  const final = join(parent, basename(file)), temporary = join(parent, `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, final);
  } finally { await unlink(temporary).catch(() => undefined); }
  return { file: final, relative: relative(root, final) };
}

// ---- check: the six rules, the MAA name table, periods and the 15 gates ---------------------------------------------

export type Verdict = 'pass' | 'fail' | 'unverified';
export type GateResult = { gate: number; verdict: Verdict; evidence: string[] };
export type CheckContext = { layout: LayoutRoom[]; snapshot: unknown; tables: PlanTables | null; names: NameTable; mood?: Record<string, MoodRate>; moodDefault?: MoodRate;
  combos?: Combo[]; exclusions?: Exclusion[]; efficiency?: EfficiencyClaim[]; tolerance?: number; shifts?: number; reexport?: string | null; texts?: string[] };
export type PlanCheck = { applicable: boolean; errors: string[]; warnings: string[]; unverified: string[]; gates: GateResult[];
  efficiency: { claims: (EfficiencyClaim & { total: number })[]; daily: Record<string, number | null> }; operators: Record<string, OperatorFacts>;
  facts: { moodCap: number | null; beds: number | null; fiammettaRate: number | null; tolerance: number } };
export const gateTitles = ['同班次不重复、不切换异格', '持有、房间存在、不超容量', '计划数与布局一致', '心情上限与恢复', '没有干员全班次在岗', '宿舍床位', '组合与挂件同班',
  '互斥技能不同时', '技能与产物匹配', '控制中枢满员、光环不重复', '无人机与菲亚梅塔', '效率三部分之和与按时长加权', '文件与重新导出一致', '晚上线或早上线仍成立', '不称最优'];
type Entry = { facility: Facility; index: number; path: string; operators: string[]; mentioned: string[]; dynamic: boolean; skip: boolean; autofill: boolean; product: unknown };
type Parsed = { path: string; name: string; segments: [number, number][] | null; hours: number | null; start: number; entries: Entry[]; missing: Facility[];
  fiammetta: { enable: boolean; target: unknown; order: unknown } | null; drones: { enable: boolean; room: unknown; index: unknown; order: unknown } | null; texts: string[] };

function caseErrors(value: unknown, known: readonly string[], path: string, errors: string[]) {
  for (const key of Object.keys(object(value))) if (!known.includes(key) && known.some(entry => entry.toLowerCase() === key.toLowerCase())) errors.push(`key-case:${path ? `${path}.` : ''}${key}`);
}
function parsePlan(raw: unknown, index: number, errors: string[], warnings: string[]): Parsed {
  const path = `plans[${index}]`, plan = object(raw);
  if (!isObject(raw)) errors.push(`plan-invalid:${path}`);
  caseErrors(plan, keys.plan, path, errors);
  let segments: [number, number][] | null = null;
  if (plan.period !== undefined) {
    segments = [];
    if (!Array.isArray(plan.period) || !plan.period.length) errors.push(`period-format:${path}`);
    list(plan.period).forEach((pair, k) => {
      const [start, end] = list(pair), from = minuteOf(start), to = minuteOf(end);
      if (list(pair).length !== 2 || from === null || to === null || from >= to) { errors.push(`period-format:${path}.period[${k}]`); return; }
      segments!.push([from, endMinute(to)]);
    });
  }
  const hours = segments?.length ? segments.reduce((sum, [from, to]) => sum + to - from, 0) / 60 : null;
  // A plan that crosses midnight starts at its segment that closes the day.
  const start = segments?.length ? (segments.some(([from]) => from === 0) && segments.some(([, to]) => to === 1440) && segments.length > 1
    ? segments.find(([, to]) => to === 1440)![0] : Math.min(...segments.map(([from]) => from))) : index;
  const rooms = object(plan.rooms), entries: Entry[] = [], missing: Facility[] = [];
  if (!isObject(plan.rooms)) errors.push(`plan-rooms-invalid:${path}`);
  caseErrors(rooms, facilities, `${path}.rooms`, errors);
  for (const key of Object.keys(rooms)) if (!facilities.some(facility => facility.toLowerCase() === key.toLowerCase())) warnings.push(`facility-unknown:${path}.rooms.${key}`);
  const groups = new Map(list(plan.groups).map((group, k) => { caseErrors(group, keys.group, `${path}.groups[${k}]`, errors);
    return [String(object(group).name), names(object(group).operators) ?? []] as const; }));
  for (const facility of facilities) {
    if (rooms[facility] === undefined) { missing.push(facility); continue; }
    if (!Array.isArray(rooms[facility])) { errors.push(`room-invalid:${path}.rooms.${facility}`); continue; }
    list(rooms[facility]).forEach((raw, k) => {
      const entryPath = `${path}.rooms.${facility}[${k}]`, entry = object(raw);
      caseErrors(entry, keys.room, entryPath, errors);
      const field = (name: string) => { if (entry[name] === undefined) return []; const value = names(entry[name]); if (!value) errors.push(`operator-name-invalid:${entryPath}.${name}`); return value ?? []; };
      const operators = field('operators'), candidates = field('candidates'), training = [...field('operatorsA'), ...field('operatorsB')], grouped = entry.use_operator_groups === true;
      const members = grouped ? operators.flatMap(group => groups.get(group) ?? []) : [];
      entries.push({ facility, index: k, path: entryPath, operators: grouped ? [] : operators, mentioned: [...(grouped ? [] : operators), ...members, ...candidates, ...training],
        dynamic: grouped || candidates.length > 0 || training.length > 0 || entry.autofill === true && facility !== 'dormitory', skip: entry.skip === true, autofill: entry.autofill === true, product: entry.product });
    });
  }
  const sub = (name: 'Fiammetta' | 'drones') => { if (plan[name] === undefined) return null; caseErrors(plan[name], keys[name], `${path}.${name}`, errors); return object(plan[name]); };
  const fia = sub('Fiammetta'), drone = sub('drones');
  return { path, name: typeof plan.name === 'string' ? plan.name : '', segments, hours, start, entries, missing,
    fiammetta: fia && { enable: fia.enable !== false, target: fia.target, order: fia.order ?? 'pre' },
    drones: drone && { enable: drone.enable !== false, room: drone.room, index: drone.index ?? 1, order: drone.order ?? 'pre' },
    texts: [plan.name, plan.description, plan.description_post].filter(filled) };
}

const verdict = (failed: boolean, open: boolean): Verdict => failed ? 'fail' : open ? 'unverified' : 'pass';
const hm = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const optimal = /最优|最佳|最好|最强|最高效|optimal|optimum|\bbest\b/i;

/** Parses a plan file and runs every rule and gate against it; a gate that cannot be decided says so. */
export function checkPlanText(text: string, context: CheckContext): PlanCheck {
  let file: unknown;
  try { file = JSON.parse(text); } catch { file = undefined; }
  const errors: string[] = [], warnings: string[] = [], open: string[] = [], gates: GateResult[] = [];
  const tolerance = context.tolerance ?? defaultTolerance, facts = context.tables ? gameFacts(context.tables) : null;
  const empty: PlanCheck = { applicable: false, errors, warnings, unverified: open, gates, efficiency: { claims: [], daily: {} }, operators: {},
    facts: { moodCap: facts?.moodCap ?? null, beds: null, fiammettaRate: facts?.fiammettaRate ?? null, tolerance } };
  if (!isObject(file) || !Array.isArray(file.plans)) {
    errors.push(file === undefined ? 'plan-json-invalid' : 'plan-structure-invalid');
    gateTitles.forEach((_title, index) => gates.push({ gate: index + 1, verdict: 'unverified', evidence: ['排班文件结构无效，无法检查'] }));
    open.push(...gates.map(entry => `gate-${entry.gate}`));
    return empty;
  }
  caseErrors(file, [...keys.top, ...keys.extension], '', errors);
  const plans = file.plans.map((raw, index) => parsePlan(raw, index, errors, warnings));
  const layoutOf = (facility: Facility) => context.layout.filter(room => room.type === facility);
  const capacityOf = (facility: Facility, k: number) => { const room = layoutOf(facility)[k]; return room ? facts?.capacity[facility]?.[room.level - 1] ?? null : null; };
  const live = (entry: Entry) => !entry.skip;
  const work = plans.map(plan => new Set(plan.entries.filter(entry => live(entry) && entry.facility !== 'dormitory').flatMap(entry => entry.operators)));
  const dorm = plans.map(plan => new Set(plan.entries.filter(entry => live(entry) && entry.facility === 'dormitory').flatMap(entry => entry.operators)));
  const mentioned = [...new Set(plans.flatMap(plan => [...plan.entries.flatMap(entry => entry.mentioned), ...(filled(plan.fiammetta?.target) ? [plan.fiammetta.target] : [])]))].sort();
  const operators = operatorFacts(mentioned, context.snapshot ?? null, context.tables);
  const dynamic = plans.some(plan => plan.entries.some(entry => entry.dynamic && live(entry)));
  const order = plans.map((_plan, index) => index).sort((a, b) => plans[a]!.start - plans[b]!.start);

  // Rule: plan count. MAA sets no upper limit (plan_index must lie inside plans); the count must equal the user's shifts.
  if (!plans.length) errors.push('plan-count:0');
  else if (context.shifts !== undefined && plans.length !== context.shifts) errors.push(`plan-count:${plans.length}/${context.shifts}`);
  // Periods: MAA's GUI picks the first plan in file order whose period contains now, and warns when only some have one.
  const timed = plans.filter(plan => plan.segments !== null);
  if (timed.length && timed.length !== plans.length) errors.push('period-mixed');
  for (let a = 0; a < plans.length; a += 1) for (let b = a + 1; b < plans.length; b += 1)
    if ((plans[a]!.segments ?? []).some(([s1, e1]) => (plans[b]!.segments ?? []).some(([s2, e2]) => s1 < e2 && s2 < e1))) errors.push(`period-overlap:${plans[a]!.path}:${plans[b]!.path}`);
  // Layout against the game tables.
  for (const facility of facilities) {
    const rooms = layoutOf(facility), most = facts?.maxCount[facility];
    if (most !== undefined && rooms.length > most) errors.push(`layout-count:${facility}:${rooms.length}>${most}`);
    rooms.forEach((room, k) => { const sizes = facts?.capacity[facility]; if (sizes && room.level > sizes.length) errors.push(`layout-level:${facility}[${k}]`); });
  }
  // Rule: room capacity (and rooms the layout does not have).
  let capacityOpen = false;
  const capacityFailures: string[] = [];
  for (const plan of plans) for (const entry of plan.entries.filter(live)) {
    if (entry.index >= layoutOf(entry.facility).length) { if (entry.operators.length || entry.dynamic) { errors.push(`room-missing:${entry.path}`); capacityFailures.push(`${entry.path} 不在布局里`); } continue; }
    const size = entry.facility === 'training' ? null : capacityOf(entry.facility, entry.index);
    if (size === null) { if (entry.facility !== 'training') capacityOpen = true; continue; }
    if (entry.operators.length > size) { errors.push(`room-capacity:${entry.path}:${entry.operators.length}>${size}`); capacityFailures.push(`${entry.path} ${entry.operators.length} 人，容量 ${size}`); }
  }
  // Rule: no operator twice in one plan (dormitories included).
  const duplicates: string[] = [];
  plans.forEach(plan => { const seen = new Set<string>();
    for (const name of plan.entries.filter(live).flatMap(entry => entry.operators)) { if (seen.has(name)) { errors.push(`plan-duplicate:${plan.path}:${name}`); duplicates.push(`${plan.path}：${name}`); } seen.add(name); } });
  // Rule: production lines. MaaCore switches a line whose product differs (except Dualchip); a plan never relies on that.
  for (const plan of plans) for (const entry of plan.entries.filter(entry => entry.product !== undefined)) {
    const allowed = products[entry.facility];
    if (!allowed) { warnings.push(`product-ignored:${entry.path}`); continue; }
    if (typeof entry.product !== 'string' || !allowed.includes(entry.product)) { errors.push(`product-invalid:${entry.path}`); continue; }
    const current = layoutOf(entry.facility)[entry.index]?.product;
    if (current === undefined) open.push(`product:${entry.path}`);
    else if (current !== entry.product) errors.push(`product-switch:${entry.path}:${current}>${entry.product}`);
  }
  // Rule: unowned operators are a warning; names MAA cannot match are an error, reported apart.
  const unowned = mentioned.filter(name => ['unobserved', 'not-found'].includes(operators[name]!.ownership));
  const ambiguous = mentioned.filter(name => operators[name]!.ownership === 'ambiguous');
  if (context.snapshot === null || context.snapshot === undefined || !context.tables) open.push('ownership');
  else { warnings.push(...unowned.map(name => `operator-unowned:${name}`)); open.push(...ambiguous.map(name => `ownership-ambiguous:${name}`)); }
  if (context.names.status === 'available') { const table = new Set(context.names.names); errors.push(...mentioned.filter(name => !table.has(name)).map(name => `name-unknown:${name}`)); }
  else open.push(`names:${context.names.reason}`);
  if (dynamic) open.push('assignments-chosen-by-maa');

  const add = (gate: number, failures: string[], unsure: string[], notes: string[] = []) => gates.push({ gate, verdict: verdict(failures.length > 0, unsure.length > 0),
    evidence: failures.length ? failures : unsure.length ? unsure : notes });

  // 1. Once per shift; no switching between alternate forms of one operator within the cycle.
  {
    const unsure: string[] = [], failures = duplicates.map(entry => `同一班次重复：${entry}`), stationed = [...new Set([...work, ...dorm].flatMap(set => [...set]))].sort();
    if (!facts?.forms) unsure.push('异格对照表不可用，未检查异格');
    else {
      const groups = new Map<string, string[]>();
      for (const name of stationed) {
        const ids = facts.ids[name] ?? [], id = operators[name]?.id ?? (ids.length === 1 ? ids[0]! : null);
        if (id === null) { unsure.push(`${name} 不能唯一对应游戏 ID`); continue; }
        const group = facts.forms[id];
        if (group) groups.set(group, [...groups.get(group) ?? [], name]);
      }
      for (const group of groups.values()) if (group.length > 1) failures.push(`同一周期用了同一干员的不同形态：${group.join('、')}`);
    }
    add(1, failures, unsure, ['每个班次每名干员只出现一次，没有异格形态切换']);
  }
  // 2. Owned, the room exists, within capacity.
  {
    const unsure = [...(capacityOpen ? ['房间容量没有从固定游戏表得到'] : []), ...(open.includes('ownership') ? ['没有账号快照或技能表，持有未核对'] : []),
      ...unowned.map(name => `${name} 不在账号快照的已观察干员里（警告）`), ...ambiguous.map(name => `${name} 对应多个游戏 ID，快照里都有，用的是哪个形态待核`)];
    add(2, capacityFailures, unsure, ['所有名字都已持有，房间存在且不超容量']);
  }
  // 3. Plans equal shifts; rooms equal the layout.
  {
    const failures: string[] = [], unsure: string[] = [];
    if (context.shifts === undefined) unsure.push('没有给出班次数');
    else if (plans.length !== context.shifts) failures.push(`计划 ${plans.length} 个，班次 ${context.shifts} 个`);
    for (const plan of plans) for (const facility of facilities) {
      const count = layoutOf(facility).length, entries = plan.entries.filter(entry => entry.facility === facility).length;
      if (count && plan.missing.includes(facility)) failures.push(`${plan.path} 缺少 ${facility}（MAA 会用默认算法换班）`);
      else if (count && entries !== count) failures.push(`${plan.path} 的 ${facility} 有 ${entries} 间，布局 ${count} 间`);
      else if (!count && entries) failures.push(`${plan.path} 写了布局没有的 ${facility}`);
    }
    add(3, failures, unsure, ['计划数等于班次数，房间数和布局一致']);
  }
  const fiammettaTargets = new Set(plans.filter(plan => plan.fiammetta?.enable && filled(plan.fiammetta.target)).map(plan => String(plan.fiammetta!.target)));
  const rateOf = (name: string) => context.mood?.[name] ?? context.moodDefault ?? null;
  const workers = [...new Set(work.flatMap(set => [...set]))].sort();
  const hours = plans.map(plan => plan.hours);
  const known = hours.every(value => value !== null);
  /** Longest run of consecutive shifts on duty, in time order and around the cycle. */
  const stretch = (name: string) => {
    if (order.every(index => work[index]!.has(name))) return order.reduce((sum, index) => sum + hours[index]!, 0);
    let best = 0, run = 0;
    for (const index of [...order, ...order]) { run = work[index]!.has(name) ? run + hours[index]! : 0; best = Math.max(best, run); }
    return best;
  };
  const totals = (name: string) => ({ on: plans.reduce((sum, _plan, index) => sum + (work[index]!.has(name) ? hours[index]! : 0), 0),
    rest: plans.reduce((sum, _plan, index) => sum + (dorm[index]!.has(name) ? hours[index]! : 0), 0) });
  const moodCheck = (extra: number, failures: string[], unsure: string[]) => {
    const cap = facts?.moodCap ?? null;
    if (cap === null) unsure.push('心情上限没有从固定游戏表得到');
    if (!known) unsure.push('有计划没有时间段，班次时长未知');
    const missing = workers.filter(name => !fiammettaTargets.has(name) && !rateOf(name));
    if (missing.length) unsure.push(`没有心情速率：${missing.join('、')}`);
    if (cap === null || !known) return;
    for (const name of workers.filter(name => !fiammettaTargets.has(name) && rateOf(name))) {
      const speed = rateOf(name)!, longest = stretch(name), { on, rest } = totals(name);
      if ((longest + extra) * speed.work > cap + epsilon) failures.push(`${name}：连续上班 ${longest + extra} 小时 × 每小时 ${speed.work} = ${+((longest + extra) * speed.work).toFixed(2)}，超过心情上限 ${cap}`);
      if (speed.work > 0 && (on + extra) * speed.work > Math.max(0, rest - extra) * speed.rest + epsilon)
        failures.push(`${name}：一个周期消耗 ${+((on + extra) * speed.work).toFixed(2)}，宿舍恢复 ${+(Math.max(0, rest - extra) * speed.rest).toFixed(2)}`);
    }
    if (dynamic) unsure.push('有房间由 MAA 运行时选人，这些人的心情无法核对');
  };
  // 4. Mood cap per continuous stretch; mood balance over the cycle.
  { const failures: string[] = [], unsure: string[] = []; moodCheck(0, failures, unsure); add(4, failures, unsure, ['连续上班不超过心情上限，周期内消耗不超过恢复（速率见输入，属推断）']); }
  // 5. Nobody is on duty in every shift, except the Fiammetta target draining at most her recovery per hour.
  {
    const failures: string[] = [], unsure: string[] = [];
    for (const name of workers.filter(name => plans.length > 0 && work.every(set => set.has(name)))) {
      if (!fiammettaTargets.has(name)) { failures.push(`${name} 每个班次都在岗`); continue; }
      const speed = rateOf(name), limit = facts?.fiammettaRate ?? null;
      if (!speed || limit === null) { unsure.push(`${name} 是菲亚梅塔的目标，但${speed ? '固定游戏表没有给出菲亚梅塔的恢复速率' : '没有心情速率'}`); continue; }
      if (speed.work > limit + epsilon) failures.push(`${name} 是菲亚梅塔的目标，每小时消耗 ${speed.work}，超过 ${limit}`);
    }
    if (dynamic && !failures.length) unsure.push('有房间由 MAA 运行时选人');
    add(5, failures, unsure, ['没有干员每个班次都在岗']);
  }
  // 6. Free beds = beds minus permanent dormitory residents; resting operators fit.
  let beds: number | null = null;
  {
    const failures: string[] = [], unsure: string[] = [], notes: string[] = [];
    const sizes = layoutOf('dormitory').map(room => facts?.capacity.dormitory?.[room.level - 1] ?? null);
    beds = sizes.every(size => size !== null) ? sizes.reduce((sum: number, size) => sum + size!, 0) : null;
    if (beds === null) unsure.push('宿舍床位没有从固定游戏表得到');
    else {
      const permanent = [...new Set(dorm.flatMap(set => [...set]))].filter(name => dorm.every(set => set.has(name)) && !work.some(set => set.has(name)));
      const free = beds - permanent.length;
      plans.forEach((plan, index) => {
        const resting = [...dorm[index]!].filter(name => !permanent.includes(name));
        if (resting.length > free) failures.push(`${plan.path} 休息 ${resting.length} 人，可用床位 ${free}（共 ${beds}，常驻 ${permanent.length}）`);
        else notes.push(`${plan.path} 休息 ${resting.length} 人，可用床位 ${free}（共 ${beds}，常驻 ${permanent.length}）`);
        if (plan.entries.some(entry => entry.facility === 'dormitory' && entry.autofill && live(entry))) notes.push(`${plan.path} 的宿舍由 MAA 自动补满`);
      });
    }
    add(6, failures, unsure, notes);
  }
  // 7. Cross-facility combination members and the operators they depend on share a shift.
  {
    const failures: string[] = [], unsure = context.combos ? [] : ['没有声明组合；本工具不从技能文字推断组合'];
    for (const combo of context.combos ?? []) plans.forEach((plan, index) => {
      if (!combo.members.some(name => work[index]!.has(name))) return;
      const absent = [...combo.members.filter(name => !work[index]!.has(name)), ...(combo.dependsOn ?? []).filter(name => !work[index]!.has(name) && !dorm[index]!.has(name))];
      if (absent.length) failures.push(`${plan.path} ${combo.name ?? combo.members.join('+')} 缺少 ${absent.join('、')}`);
    });
    if (dynamic && !failures.length && context.combos) unsure.push('有房间由 MAA 运行时选人');
    add(7, failures, unsure, [context.combos?.length ? '声明的组合都在同一班次（组合本身是推断）' : '声明没有跨设施组合（推断）']);
  }
  // 8. Mutually exclusive skills or combinations are not in trading posts and factories at the same time.
  {
    const failures: string[] = [], unsure = context.exclusions ? [] : ['没有声明互斥技能；本工具不从技能文字推断互斥'];
    for (const exclusion of context.exclusions ?? []) plans.forEach(plan => {
      const present = exclusion.members.filter(name => plan.entries.some(entry => live(entry) && (entry.facility === 'trading' || entry.facility === 'manufacture') && entry.operators.includes(name)));
      if (present.length > 1) failures.push(`${plan.path} 同时安排了互斥的 ${present.join('、')}`);
    });
    if (dynamic && !failures.length && context.exclusions) unsure.push('有房间由 MAA 运行时选人');
    add(8, failures, unsure, [context.exclusions?.length ? '声明的互斥技能没有同时安排（互斥本身是推断）' : '声明没有互斥技能（推断）']);
  }
  // 9. Skills match the room's product.
  {
    const failures: string[] = [], unsure: string[] = [], notes: string[] = [];
    for (const plan of plans) for (const entry of plan.entries.filter(entry => live(entry) && (entry.facility === 'manufacture' || entry.facility === 'trading'))) {
      const product = layoutOf(entry.facility)[entry.index]?.product;
      if (!product) { if (entry.operators.length) unsure.push(`${entry.path} 的产物没有在布局里给出`); continue; }
      for (const name of entry.operators) {
        const skills = operators[name]!.skills.filter(skill => skill.room === gameRoom[entry.facility]);
        if (operators[name]!.id === null) { unsure.push(`${name} 的技能未知（没有快照、名字对不上唯一形态或游戏表里没有）`); continue; }
        const active = skills.filter(skill => skill.status === 'active');
        if (active.some(skill => !mismatched(skill.text, product))) continue;
        if (active.length) failures.push(`${entry.path} ${name} 的技能只作用于 ${specificTo(active[0]!.text).join('、')}，房间产物是 ${product}`);
        else if (skills.some(skill => skill.status === 'unknown')) unsure.push(`${name} 的技能是否生效待核`);
        else notes.push(`${name} 在 ${entry.path} 没有该房间的生效技能（填充）`);
      }
      if (entry.dynamic) unsure.push(`${entry.path} 由 MAA 运行时选人`);
    }
    add(9, failures, unsure, notes.length ? notes : ['安排的技能和房间产物匹配']);
  }
  // 10. The control centre is full and holds no duplicate aura.
  {
    const failures: string[] = [], unsure: string[] = [];
    if (!layoutOf('control').length) unsure.push('布局里没有控制中枢');
    const size = capacityOf('control', 0);
    if (layoutOf('control').length && size === null) unsure.push('控制中枢容量没有从固定游戏表得到');
    for (const plan of plans) for (const entry of plan.entries.filter(entry => live(entry) && entry.facility === 'control' && entry.index === 0)) {
      if (size !== null && entry.operators.length < size && !entry.dynamic) failures.push(`${plan.path} 控制中枢 ${entry.operators.length} 人，容量 ${size}`);
      const auras = new Map<string, string[]>();
      for (const name of entry.operators) {
        if (operators[name]!.id === null) { unsure.push(`${name} 的技能未知（没有快照、名字对不上唯一形态或游戏表里没有）`); continue; }
        const skills = operators[name]!.skills.filter(skill => skill.room === 'CONTROL');
        if (skills.some(skill => skill.status === 'unknown')) unsure.push(`${name} 的控制中枢技能是否生效待核`);
        for (const skill of skills.filter(skill => skill.status === 'active')) auras.set(skill.id, [...auras.get(skill.id) ?? [], name]);
      }
      for (const [aura, holders] of auras) if (holders.length > 1) failures.push(`${plan.path} 同一光环 ${aura} 重复：${holders.join('、')}`);
      if (entry.dynamic) unsure.push(`${entry.path} 由 MAA 运行时选人`);
    }
    add(10, failures, unsure, ['控制中枢满员，光环不重复']);
  }
  // 11. One drone target per change; Fiammetta only at the shift start, at most once (one object per plan in the protocol).
  {
    const failures: string[] = [], unsure: string[] = [];
    for (const plan of plans) {
      if (plan.drones?.enable) {
        const count = isFacility(plan.drones.room) ? layoutOf(plan.drones.room).length : 0, at = plan.drones.index;
        if (!['trading', 'manufacture'].includes(String(plan.drones.room)) || !Number.isSafeInteger(at) || Number(at) < 1 || Number(at) > Math.min(5, count) || !['pre', 'post'].includes(String(plan.drones.order)))
          failures.push(`${plan.path} 无人机目标 ${String(plan.drones.room)} 第 ${String(at)} 间不在布局里或写法不对`);
      }
      if (plan.fiammetta?.enable) {
        if (!filled(plan.fiammetta.target) || !['pre', 'post'].includes(String(plan.fiammetta.order))) { failures.push(`${plan.path} 菲亚梅塔没有目标或顺序不对`); continue; }
        const index = plans.indexOf(plan);
        if (!work[index]!.has(plan.fiammetta.target) && !dorm[index]!.has(plan.fiammetta.target)) failures.push(`${plan.path} 菲亚梅塔的目标 ${plan.fiammetta.target} 不在这个班次`);
        const owner = facts?.fiammettaIds ?? [];
        if (!owner.length || context.snapshot === null || context.snapshot === undefined) unsure.push('是否持有菲亚梅塔未核对');
        else if (!list(object(context.snapshot).operators).some(row => owner.includes(String(object(row).id)))) failures.push('账号快照里没有菲亚梅塔');
      }
    }
    add(11, failures, unsure, ['每次换班最多一个无人机目标；菲亚梅塔只在换班开始时使用一次']);
  }
  // 12. Efficiency = base + skill + global; daily values weighted by shift length.
  const claims: PlanCheck['efficiency']['claims'] = [], daily: Record<string, number | null> = {};
  {
    const failures: string[] = [], unsure = context.efficiency?.length ? [] : ['没有报告效率数字'];
    for (const claim of context.efficiency ?? []) {
      const match = /^([a-z]+)\[(\d+)\]$/.exec(claim.room), total = claim.base + claim.skill + claim.global;
      if (!match || !isFacility(match[1]) || Number(match[2]) >= layoutOf(match[1]).length || !plans[claim.plan]) { failures.push(`效率条目 ${claim.room}（计划 ${claim.plan}）不在方案里`); continue; }
      if (claim.total !== undefined && Math.abs(claim.total - total) > epsilon) failures.push(`${claim.room} 计划 ${claim.plan}：总效率 ${claim.total} 不等于 ${claim.base}+${claim.skill}+${claim.global}=${total}`);
      claims.push({ ...claim, total });
    }
    for (const room of [...new Set(claims.map(claim => claim.room))].sort()) {
      const each = plans.map((_plan, index) => claims.find(claim => claim.room === room && claim.plan === index)?.total);
      daily[room] = known && each.every(value => value !== undefined) ? +(each.reduce((sum: number, value, index) => sum + value! * hours[index]!, 0) / hours.reduce((sum: number, value) => sum + value!, 0)).toFixed(6) : null;
      if (daily[room] === null) unsure.push(`${room} 不是每个计划都有效率数字或班次时长未知，没有按时长加权`);
    }
    add(12, failures, unsure, ['效率为基础、技能、全局三部分之和，每日数值按班次时长加权（数字本身是推断）']);
  }
  // 13. The delivered file equals a deterministic re-export of the same result.
  add(13, typeof context.reexport === 'string' && context.reexport !== text ? ['排班文件与重新导出的结果不同'] : [],
    typeof context.reexport === 'string' ? [] : ['不是这一次由本工具导出的文件，无法重新导出比较'], ['排班文件与重新导出的结果逐字节相同']);
  // 14. Still valid when the user switches late or early.
  {
    const failures: string[] = [], unsure: string[] = [], notes: string[] = [];
    if (timed.length === plans.length && plans.length) {
      const segments = plans.flatMap(plan => plan.segments ?? []).sort((a, b) => a[0] - b[0]);
      let cursor = 0;
      for (const [from, to] of segments) { if (from > cursor) failures.push(`${hm(cursor)}–${hm(from)} 没有计划（MAA 会退回第一个计划）`); cursor = Math.max(cursor, to); }
      if (cursor < 1440) failures.push(`${hm(cursor)}–24:00 没有计划（MAA 会退回第一个计划）`);
      notes.push('时间段覆盖全天（23:59 到 24:00 这一分钟 MAA 用第一个计划）');
    } else if (!timed.length) notes.push('没有时间段：MAA 每次换班后切到下一个计划，早晚上线不改变选中的计划');
    moodCheck(tolerance, failures, unsure);
    add(14, failures, unsure, [...notes, `晚或早 ${tolerance} 小时换班时心情仍不超限`]);
  }
  // 15. Wording: nothing unproven is called optimal.
  {
    const texts = [file.title, file.description, ...plans.flatMap(plan => plan.texts), ...(context.texts ?? [])].filter(filled);
    add(15, texts.filter(entry => optimal.test(entry)).map(entry => `用了「最优」一类说法：${entry}`), [], ['没有把未证明最优的方案称为最优']);
  }
  open.push(...gates.filter(entry => entry.verdict === 'unverified').map(entry => `gate-${entry.gate}`));
  return { applicable: errors.length === 0 && gates.every(entry => entry.verdict !== 'fail'), errors: [...new Set(errors)], warnings: [...new Set(warnings)], unverified: [...new Set(open)],
    gates, efficiency: { claims, daily }, operators, facts: { moodCap: facts?.moodCap ?? null, beds, fiammettaRate: facts?.fiammettaRate ?? null, tolerance } };
}

// ---- freshness ---------------------------------------------------------------------------------------------------------

export type PlanInputs = { snapshot: string | null; tables: string[][] | null; names: string | null; plan: string | null };
export type Freshness = 'fresh' | 'stale' | 'unknown';
/** The snapshot facts a plan depends on; read and scan times are not facts, so reading the same facts again stays fresh. */
export function snapshotFingerprint(snapshot: unknown): string {
  const value = object(snapshot);
  const rows = list(value.operators).map(object).map(row => [row.id ?? null, row.name ?? null, row.elite ?? null, row.level ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return digest(JSON.stringify({ operators: rows, coverage: object(object(value.coverage).operators).status ?? null, base: value.base ?? null }));
}
export const tablesFingerprint = (files: SourceFile[]) => files.map(file => [file.repository, file.commit, file.file, file.sha256]);
/** Three states per input: fresh (same content), stale (changed), unknown (cannot be read now). Any stale input makes the old check stale. */
export function planFreshness(recorded: PlanInputs, current: PlanInputs): Record<keyof PlanInputs | 'check', Freshness> {
  const state = (before: unknown, now: unknown): Freshness => before === null || now === null ? 'unknown' : JSON.stringify(before) === JSON.stringify(now) ? 'fresh' : 'stale';
  const result = { snapshot: state(recorded.snapshot, current.snapshot), tables: state(recorded.tables, current.tables), names: state(recorded.names, current.names), plan: state(recorded.plan, current.plan) };
  const states = Object.values(result);
  return { ...result, check: states.includes('stale') ? 'stale' : states.includes('unknown') ? 'unknown' : 'fresh' };
}

// ---- generate --------------------------------------------------------------------------------------------------------

export type GenerateOptions = { home?: string; fetcher?: typeof fetch; texts?: string[] };
export type GenerateResult = { status: 'needs-input'; issues: string[] } | { status: 'written'; file: string; relative: string; sha256: string; text: string; plan: ObjectValue;
  dropped: string[]; fills: Fill[]; check: PlanCheck; operators: Record<string, OperatorFacts>; spec: PlanSpec; inputs: PlanInputs; snapshot: { readAt: unknown; sourceTimes: unknown; coverage: unknown };
  sources: { mode: 'public' | 'supplied'; files: SourceFile[]; names: { file: 'resource/battle_data.json'; status: NameTable['status']; reason: string | null; sha256: string | null } } };
const generateKeys = ['target', 'base', 'snapshotFile', 'tablesFile', 'format'];
/** Agent-written text the wording audit reads. */
export function specTexts(spec: PlanSpec): string[] {
  return [spec.title, spec.description, ...spec.shifts.flatMap(shift => [shift.name, shift.description, ...Object.values(shift.reasons)]),
    ...Object.values(spec.mood ?? {}).map(entry => entry.basis), spec.moodDefault?.basis, ...(spec.combos ?? []).flatMap(combo => [combo.name, combo.basis]),
    ...(spec.exclusions ?? []).map(entry => entry.basis), ...(spec.efficiency ?? []).flatMap(claim => [claim.basis, claim.conditions, claim.unmodelled])].filter(filled);
}
export async function readSnapshot(root: string, snapshotFile: unknown): Promise<unknown> {
  try {
    const snapshot: unknown = JSON.parse(await readFile(snapshotFile === undefined ? join(root, 'account-snapshot.json') : resolve(String(snapshotFile)), 'utf8'));
    queryBaseSkills(snapshot, { characters: {}, building: { chars: {}, buffs: {} } }, {});
    return snapshot;
  } catch { throw new Error('plan-snapshot-unavailable'); }
}
/** Builds the plan from the proposal, fills what was left out if asked, exports, writes inside the private directory and checks the written file. */
export async function generateBasePlan(value: unknown, options: GenerateOptions = {}, extraKeys: string[] = []): Promise<GenerateResult> {
  const { spec, issues } = parsePlanSpec(value, [...generateKeys, ...extraKeys]);
  if (!spec) return { status: 'needs-input', issues };
  const input = object(value), settings = await readSettings(options.home);
  let root: string;
  try { root = await realpath(resolve(settings.privateDirectory)); } catch { throw new Error('plan-private-missing'); }
  if (input.target !== undefined) planPath(root, input.target);
  const snapshot = await readSnapshot(root, input.snapshotFile);
  const loaded = input.tablesFile !== undefined ? await suppliedPlanTables(String(input.tablesFile)) : await loadPlanTables(options.fetcher);
  const names = await readMaaNameTable(settings.maaDirectory), facts = gameFacts(loaded.tables);
  let base: unknown;
  if (input.base !== undefined) {
    const text = await readPrivateFile(root, input.base);
    try { base = JSON.parse(text); } catch { throw new Error('plan-base-invalid'); }
    if (!isObject(base)) throw new Error('plan-base-invalid');
  }
  const fills = spec.fill ? fillShifts(spec, ownedRoster(snapshot, loaded.tables), facts) : [];
  const exported = exportMaaPlan(spec, base), again = exportMaaPlan(spec, base);
  const written = await writePlanFile(root, input.target ?? `base-plans/plan-${digest(exported.text).slice(0, 16)}.json`, exported.text);
  const text = await readFile(written.file, 'utf8');
  const check = checkPlanText(text, { layout: spec.layout, snapshot, tables: loaded.tables, names, mood: spec.mood, moodDefault: spec.moodDefault, combos: spec.combos,
    exclusions: spec.exclusions, efficiency: spec.efficiency, tolerance: spec.tolerance, shifts: spec.shifts.length, reexport: again.text, texts: [...specTexts(spec), ...options.texts ?? []] });
  const shot = object(snapshot);
  return { status: 'written', file: written.file, relative: written.relative, sha256: digest(text), text, plan: exported.plan, dropped: exported.dropped, fills, check, operators: check.operators, spec,
    inputs: { snapshot: snapshotFingerprint(snapshot), tables: tablesFingerprint(loaded.files), names: names.status === 'available' ? names.sha256 : null, plan: digest(text) },
    snapshot: { readAt: shot.readAt, sourceTimes: shot.sourceTimes, coverage: shot.coverage },
    sources: { mode: loaded.mode, files: loaded.files, names: { file: 'resource/battle_data.json', status: names.status, reason: names.status === 'unavailable' ? names.reason : null,
      sha256: names.status === 'available' ? names.sha256 : null } } };
}

// ---- Markdown (Chinese template; the agent translates for other languages) ---------------------------------------

const verdictWords: Record<Verdict, string> = { pass: '通过', fail: '不通过', unverified: '未核实' };
export function formatPlanMarkdown(check: PlanCheck, file?: { relative: string; sha256: string; fills: Fill[]; dropped: string[] }): string {
  const failing = check.gates.filter(entry => entry.verdict === 'fail').map(entry => `第 ${entry.gate} 项（${gateTitles[entry.gate - 1]}）`);
  const lines = ['# 基建排班检查', '', `- 结论：${check.applicable ? '可应用（没有不通过的项；未核实的项见下，需要你权衡）' : `不可应用。${failing.length ? `不通过：${failing.join('、')}。` : ''}${check.errors.length ? '校验规则有错误。' : ''}`}`,
    '- 这是建议：本工具只在私有目录写排班文件，不写 MAA 配置、不启动 MAA、不点游戏、不操作设备；应用要你批准后由 maa-daily 重新检查再执行。'];
  if (file) lines.push(`- 排班文件：${inline(file.relative.replaceAll('\\', '/'))}；SHA-256 ${file.sha256}`,
    ...file.fills.map(fill => `- 工具填入（按快照顺序选有该房间生效技能的已持有干员，没有比较收益）：计划 ${fill.plan + 1} ${inline(fill.room)}：${fill.operators.map(inline).join('、')}`),
    ...(file.dropped.length ? [`- 基础文件里大小写写错的键已去掉：${file.dropped.map(inline).join('、')}`] : []));
  lines.push('', '## 验收门', '', '| 门 | 检查 | 结论 | 证据 |', '| --- | --- | --- | --- |',
    ...check.gates.map(entry => `| ${entry.gate} | ${gateTitles[entry.gate - 1]} | ${verdictWords[entry.verdict]} | ${entry.evidence.map(inline).join('；')} |`),
    '', '## 未核实的项', '', ...(check.unverified.length ? check.unverified.map(entry => { const gate = /^gate-(\d+)$/.exec(entry);
      return gate ? `- 第 ${gate[1]} 项（${gateTitles[Number(gate[1]) - 1]}）：${check.gates.find(item => item.gate === Number(gate[1]))!.evidence.map(inline).join('；')}` : `- ${inline(entry)}`; }) : ['- 无']),
    '', '未核实的项不算通过；是否仍然应用由你决定。', '', '## 校验规则', '', `- 错误：${check.errors.length ? check.errors.map(inline).join('、') : '无'}`,
    `- 警告：${check.warnings.length ? check.warnings.map(inline).join('、') : '无'}`, '', '## 效率（推断，按班次时长加权）', '');
  if (!check.efficiency.claims.length) lines.push('- 没有报告效率数字。');
  for (const claim of check.efficiency.claims) lines.push(`- 计划 ${claim.plan + 1} ${inline(claim.room)}：基础 ${claim.base} + 技能 ${claim.skill} + 全局 ${claim.global} = ${claim.total}；依据：${inline(claim.basis)}${
    claim.conditions ? `；条件：${inline(claim.conditions)}` : ''}${claim.unmodelled ? `；未建模：${inline(claim.unmodelled)}` : ''}`);
  for (const [room, value] of Object.entries(check.efficiency.daily)) lines.push(`- ${inline(room)} 每日加权：${value ?? '未核实'}`);
  lines.push('', `心情上限 ${check.facts.moodCap ?? '未知'}；宿舍床位 ${check.facts.beds ?? '未知'}；菲亚梅塔每小时恢复 ${check.facts.fiammettaRate ?? '未知'}；早晚容差 ${check.facts.tolerance} 小时。`);
  return `${lines.join('\n')}\n`;
}

// ---- CLI -------------------------------------------------------------------------------------------------------------

const checkKeys = ['planFile', 'layout', 'shifts', 'mood', 'moodDefault', 'combos', 'exclusions', 'efficiency', 'tolerance', 'snapshotFile', 'tablesFile', 'format'];
async function runCheck(input: ObjectValue): Promise<PlanCheck> {
  if (Object.keys(input).some(key => !checkKeys.includes(key))) throw new Error('plan-input-invalid');
  const { layout } = parseLayout(input.layout);
  if (!layout) throw new Error('plan-layout-invalid');
  const shifts = input.shifts;
  if (shifts !== undefined && (!Number.isSafeInteger(shifts) || Number(shifts) < 1)) throw new Error('plan-input-invalid');
  const { spec, issues } = parsePlanSpec({ layout: input.layout, shifts: [{ name: 'check', period: '00:00-23:59' }], ...Object.fromEntries(['mood', 'moodDefault', 'combos', 'exclusions', 'efficiency', 'tolerance']
    .filter(key => input[key] !== undefined).map(key => [key, input[key]])) });
  if (!spec) throw new Error(`plan-input-invalid`, { cause: issues });
  const settings = await readSettings(), root = await realpath(resolve(settings.privateDirectory)).catch(() => { throw new Error('plan-private-missing'); });
  const text = await readPrivateFile(root, input.planFile);
  const snapshot = await readSnapshot(root, input.snapshotFile);
  const loaded = input.tablesFile !== undefined ? await suppliedPlanTables(String(input.tablesFile)) : await loadPlanTables();
  return checkPlanText(text, { layout, snapshot, tables: loaded.tables, names: await readMaaNameTable(settings.maaDirectory), mood: spec.mood, moodDefault: spec.moodDefault,
    combos: spec.combos, exclusions: spec.exclusions, efficiency: spec.efficiency, tolerance: spec.tolerance, ...(shifts === undefined ? {} : { shifts: Number(shifts) }), reexport: null });
}
/** Owned operators with an active skill for each layout room; not ranked, since text percentages are not final yield. */
async function runCandidates(input: ObjectValue): Promise<{ room: string; product: string | null; operators: { name: string; skills: string[]; productMismatch: boolean }[] }[]> {
  if (Object.keys(input).some(key => !['layout', 'snapshotFile', 'tablesFile', 'format'].includes(key))) throw new Error('plan-input-invalid');
  const { layout } = parseLayout(input.layout);
  if (!layout) throw new Error('plan-layout-invalid');
  const settings = await readSettings(), root = await realpath(resolve(settings.privateDirectory)).catch(() => { throw new Error('plan-private-missing'); });
  const snapshot = await readSnapshot(root, input.snapshotFile);
  const loaded = input.tablesFile !== undefined ? await suppliedPlanTables(String(input.tablesFile)) : await loadPlanTables();
  const roster = ownedRoster(snapshot, loaded.tables);
  const counters: Record<string, number> = {};
  return layout.map(room => {
    const index = counters[room.type] = (counters[room.type] ?? -1) + 1;
    return { room: `${room.type}[${index}]`, product: room.product ?? null, operators: roster.flatMap(operator => {
      const skills = operator.skills.filter(skill => skill.status === 'active' && skill.room === gameRoom[room.type]);
      return skills.length ? [{ name: operator.name, skills: skills.map(skill => `${skill.name}：${skill.text}`), productMismatch: skills.every(skill => mismatched(skill.text, room.product)) }] : [];
    }) };
  });
}
const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    const action = process.argv[2];
    if (process.argv.length !== 3 || !['generate', 'check', 'candidates'].includes(action!)) throw new Error('plan-action-invalid');
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw) as unknown;
    if (!isObject(input) || input.format !== undefined && !['json', 'markdown'].includes(String(input.format))) throw new Error('plan-input-invalid');
    const markdown = input.format === 'markdown';
    if (action === 'generate') {
      const result = await generateBasePlan(input);
      if (result.status === 'needs-input') { process.stdout.write(JSON.stringify({ ok: false, status: 'needs-input', issues: result.issues })); process.exitCode = 1; }
      else process.stdout.write(markdown ? formatPlanMarkdown(result.check, result) : JSON.stringify({ ok: true, applicable: result.check.applicable, planFile: result.relative,
        sha256: result.sha256, source: result.sources.mode, errors: result.check.errors, warnings: result.check.warnings, unverified: result.check.unverified,
        gates: result.check.gates.map(entry => ({ gate: entry.gate, verdict: entry.verdict })), fills: result.fills, dropped: result.dropped }));
    } else if (action === 'check') {
      const result = await runCheck(input);
      process.stdout.write(markdown ? formatPlanMarkdown(result) : JSON.stringify({ ok: true, result }));
    } else {
      const rooms = await runCandidates(input);
      process.stdout.write(markdown ? `${['# 基建排班候选', '', '按账号快照顺序列出有该房间生效技能的已持有干员；技能文字里的百分比不是最终收益，这里不排序。', '',
        ...rooms.flatMap(room => [`## ${inline(room.room)}${room.product ? `（${inline(room.product)}）` : ''}`, '', ...(room.operators.length ? room.operators.map(operator =>
          `- ${inline(operator.name)}${operator.productMismatch ? '（技能只作用于其他产物）' : ''}：${operator.skills.map(inline).join('；')}`) : ['- 无']), ''])].join('\n')}\n`
        : JSON.stringify({ ok: true, rooms }));
    }
  } catch (error) {
    const code = error instanceof Error && /^(plan|base|public-data)-[a-z0-9-]+$/.test(error.message) ? error.message : 'plan-check-failed';
    process.stdout.write(JSON.stringify({ ok: false, error: code })); process.exitCode = 1;
  }
}
