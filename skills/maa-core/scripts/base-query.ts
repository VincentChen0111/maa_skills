// Query projection adapted from the maintainer's base-skills prototype.
// Source fingerprints and removed dependencies: docs/base-sources.md in the repository.
import type { AccountSnapshot } from './account-snapshot.ts';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, stdinJsonCode } from './stdin-json.ts';
import { readSettings, startup } from './preferences.ts';
import { readPublicJson, type PublicJsonResult } from './public-data.ts';

export type BaseSkill = { id: string; name: string; room: string | null; text: string; slot: number;
  unlock: { elite: number; level: number } | null; status: 'active' | 'locked' | 'superseded' | 'unknown'; supersededBy: string | null };
export type BaseOperator = { id: string; name: string; ownership: 'owned' | 'unknown'; elite: number | null; level: number | null; skills: BaseSkill[] };
export type BaseTables = { characters: unknown; building: unknown; crossCheck?: unknown };
export type BaseQuery = { operators?: string[]; room?: string };
type ComparisonSkill = { name: string; room: string | null; elite: number | null; level: number | null; text: string };
type CrossCheck = { status: 'not-requested' | 'compared' | 'unavailable'; differences: { operatorId: string; onlyIn: 'game' | 'cross-check'; skill: ComparisonSkill }[]; issues: string[] };
export type BaseResult = { operators: BaseOperator[]; warnings: string[]; snapshotReadAt: string; limits: string[]; crossCheck: CrossCheck;
  source: { mode: 'supplied' | 'public'; files: PublicJsonResult['source'][] } };
const limits = ['Unlock status does not prove current assignment or that effect conditions are met.',
  'Faction combinations, global effects, morale, products and other conditions are not modelled.',
  'Final yield is not calculated; percentages remain source text, never a ranking or total.',
  'Unobserved ownership and training remain unknown; recognition completion does not prove roster completeness.'];
const rooms: Record<string, string> = { CONTROL: '控制中枢', MANUFACTURE: '制造站', TRADING: '贸易站', POWER: '发电站',
  MEETING: '会客室', HIRE: '办公室', WORKSHOP: '加工站', TRAINING: '训练室', DORMITORY: '宿舍', RECYCLE: '回收站' };
/** A source room outside this vocabulary is unknown, not proof of a different known facility. */
export function isBaseRoom(value: unknown): value is string { return typeof value === 'string' && Object.hasOwn(rooms, value); }
const crossRooms: Record<string, string> = { control_center: 'CONTROL', factory: 'MANUFACTURE', trading_post: 'TRADING', power_plant: 'POWER',
  reception_room: 'MEETING', office: 'HIRE', workshop: 'WORKSHOP', training_room: 'TRAINING', dormitory: 'DORMITORY', recycle_station: 'RECYCLE' };
class AmbiguousName extends Error {
  candidates: string[];
  constructor(candidates: string[]) { super(`base-name-ambiguous:${candidates.join(',')}`); this.candidates = candidates; }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('base-data-invalid');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('base-data-invalid');
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('base-data-invalid');
  return value;
}
function projectSkills(entry: unknown, buffs: Record<string, unknown>, elite: number | null, level: number | null, warnings: string[]): BaseSkill[] {
  return list(object(entry).buffChar).flatMap((rawSlot, slot) => {
    const skills: BaseSkill[] = list(object(rawSlot).buffData).map(raw => {
      const data = object(raw), id = label(data.buffId), buff = object(buffs[id] ?? {}), cond = object(data.cond ?? {});
      const unlock = typeof cond.phase === 'string' && /^PHASE_[0-2]$/.test(cond.phase) && Number.isSafeInteger(cond.level) && Number(cond.level) >= 1 && Number(cond.level) <= 100
        ? { elite: Number(cond.phase.slice(6)), level: Number(cond.level) } : null;
      const complete = unlock !== null && typeof buff.buffName === 'string' && typeof buff.roomType === 'string' && typeof buff.description === 'string';
      if (!complete) warnings.push(`game-skill-incomplete:${id}`);
      const status = !complete || elite === null ? 'unknown' : elite > unlock.elite ? 'active' : elite < unlock.elite ? 'locked'
        : level === null ? 'unknown' : level >= unlock.level ? 'active' : 'locked';
      return { id, name: typeof buff.buffName === 'string' ? buff.buffName : id, room: typeof buff.roomType === 'string' ? buff.roomType : null,
        text: typeof buff.description === 'string' ? buff.description.replace(/<[^>]*>/g, '') : '', slot, unlock, status, supersededBy: null };
    });
    const active = skills.findLastIndex(skill => skill.status === 'active');
    for (let i = 0; i < active; i++) { skills[i]!.status = 'superseded'; skills[i]!.supersededBy = skills[active]!.id; }
    if (active >= 0 && skills.slice(active + 1).some(skill => skill.status === 'unknown')) skills[active]!.status = 'unknown';
    return skills;
  });
}

function accountInput(input: unknown): AccountSnapshot {
  try {
    const data = object(input), coverage = object(object(data.coverage).operators);
    if (data.version !== 1 || !['maa', 'skland'].includes(String(data.source)) || typeof data.readAt !== 'string' || !Number.isFinite(Date.parse(data.readAt))
      || !['complete', 'partial', 'pending', 'missing', 'invalid', 'unavailable'].includes(String(coverage.status))) throw new Error();
    const ids = new Set<string>();
    for (const raw of list(data.operators)) {
      const row = object(raw), id = label(row.id);
      if (!/^[A-Za-z0-9_]+$/.test(id) || ids.has(id) || !['complete', 'partial'].includes(String(coverage.status))) throw new Error();
      ids.add(id); label(row.name);
      if (row.elite !== null && (!Number.isSafeInteger(row.elite) || Number(row.elite) < 0 || Number(row.elite) > 2)) throw new Error();
      if (row.level !== null && (!Number.isSafeInteger(row.level) || Number(row.level) < 1 || Number(row.level) > 100)) throw new Error();
    }
    return input as AccountSnapshot;
  } catch { throw new Error('base-snapshot-invalid'); }
}

function crossCheckSkills(operators: BaseOperator[], value: unknown, room?: string): CrossCheck {
  const result: CrossCheck = { status: value === undefined ? 'not-requested' : 'compared', differences: [], issues: [] };
  if (value === undefined) return result;
  try {
    const rows = list(object(value).operators).map(object);
    for (const operator of operators) {
      const matches = rows.filter(row => row.name === operator.name);
      if (matches.length !== 1) { result.issues.push(`${matches.length ? 'cross-name-ambiguous' : 'cross-operator-missing'}:${operator.id}`); continue; }
      const reference: ComparisonSkill[] = list(matches[0]!.skills).map(raw => {
        const skill = object(raw), facility = label(skill.facility);
        if (!Number.isSafeInteger(skill.elite) || Number(skill.elite) < 0 || Number(skill.elite) > 2
          || !Number.isSafeInteger(skill.required_level) || Number(skill.required_level) < 1 || Number(skill.required_level) > 100) throw new Error();
        return { name: label(skill.skill_name), room: crossRooms[facility] ?? facility, elite: Number(skill.elite), level: Number(skill.required_level), text: label(skill.description).replace(/<[^>]*>/g, '') };
      }).filter(skill => !room || skill.room === room);
      const game: ComparisonSkill[] = operator.skills.filter(skill => !room || skill.room === room)
        .map(skill => ({ name: skill.name, room: skill.room, elite: skill.unlock?.elite ?? null, level: skill.unlock?.level ?? null, text: skill.text }));
      // Compare multisets of source facts. Neither source's derived bonuses are used.
      const remaining = [...reference];
      for (const skill of game) {
        const index = remaining.findIndex(other => JSON.stringify(other) === JSON.stringify(skill));
        if (index >= 0) remaining.splice(index, 1);
        else result.differences.push({ operatorId: operator.id, onlyIn: 'game', skill });
      }
      for (const skill of remaining) result.differences.push({ operatorId: operator.id, onlyIn: 'cross-check', skill });
    }
  } catch { throw new Error('base-cross-check-invalid'); }
  return result;
}

/** Read-only query; snapshot and game tables remain unchanged. */
export function queryBaseSkills(input: unknown, tables: BaseTables, query: BaseQuery): BaseResult {
  const snapshot = accountInput(input);
  const characters = Object.fromEntries(Object.entries(object(tables.characters)).filter(([id]) => /^char_[A-Za-z0-9_]+$/.test(id))), building = object(tables.building);
  const chars = object(building.chars), buffs = object(building.buffs);
  const operators: BaseOperator[] = [], warnings: string[] = [];
  const room = query.room ? Object.keys(rooms).find(key => key === query.room || rooms[key] === query.room) : undefined;
  if (query.room && !room) throw new Error('base-room-invalid');
  const selected = new Set<string>();
  for (const requested of query.operators ?? []) {
    const candidates = { ...Object.fromEntries(snapshot.operators.map(row => [row.id, row])), ...characters };
    const ids = Object.hasOwn(candidates, requested) ? [requested] : Object.entries(candidates).filter(([, row]) => object(row).name === requested).map(([id]) => id);
    if (ids.length > 1) throw new AmbiguousName(ids);
    if (!ids.length) warnings.push(`operator-not-found:${requested}`);
    ids.forEach(id => selected.add(id));
  }
  for (const [id, raw] of Object.entries(characters)) {
    const name = label(object(raw).name);
    if (query.operators?.length && !selected.has(id)) continue;
    const own = snapshot.operators.find(row => row.id === id);
    if (!own && !query.operators?.length) continue;
    if (!own) warnings.push(`ownership-unobserved:${id}`);
    if (!Object.hasOwn(chars, id)) { warnings.push(`game-operator-incomplete:${id}`); operators.push({ id, name, ownership: own ? 'owned' : 'unknown', elite: own?.elite ?? null, level: own?.level ?? null, skills: [] }); continue; }
    const skills = projectSkills(chars[id], buffs, own?.elite ?? null, own?.level ?? null, warnings);
    operators.push({ id, name, ownership: own ? 'owned' : 'unknown', elite: own?.elite ?? null, level: own?.level ?? null, skills });
  }
  for (const own of snapshot.operators) {
    if (Object.hasOwn(characters, own.id) || query.operators?.length && !selected.has(own.id)) continue;
    warnings.push(`game-operator-incomplete:${own.id}`);
    operators.push({ id: own.id, name: own.name, ownership: 'owned', elite: own.elite, level: own.level, skills: [] });
  }
  const crossCheck = crossCheckSkills(operators, tables.crossCheck, room);
  const matching = room ? operators.map(operator => ({ ...operator, skills: operator.skills.filter(skill => skill.room === room) })).filter(operator => operator.skills.length) : operators;
  return { operators: matching, warnings, snapshotReadAt: snapshot.readAt, limits: [...limits], crossCheck, source: { mode: 'supplied', files: [] } };
}

/** The fixed game mirror commit; the base plan tool (ticket 22) reads its tables from the same pin. */
export const baseGameSource = { repository: 'Kengxxiao/ArknightsGameData', commit: '6f63c14e27b847ef74b53b00fe51fc322b3cd7ff' } as const;
/** Fetch only the fixed public tables; no game data is bundled, cached or written. */
export async function queryPublicBaseSkills(snapshot: unknown, query: BaseQuery, fetcher: typeof fetch = fetch): Promise<BaseResult> {
  accountInput(snapshot);
  const game = baseGameSource;
  const [characters, building, crossCheck] = await Promise.allSettled([
    readPublicJson({ ...game, file: 'zh_CN/gamedata/excel/character_table.json' }, fetcher),
    readPublicJson({ ...game, file: 'zh_CN/gamedata/excel/building_data.json' }, fetcher),
    readPublicJson({ repository: 'KayChung17/arknights-base-skill', commit: '368ea6d83d14409a3e7354df4359960adba6b36b', file: 'skills/ark-base-schedule/assets/operator-skills.json' }, fetcher),
  ]);
  if (characters.status === 'rejected') throw characters.reason;
  if (building.status === 'rejected') throw building.reason;
  const tables = { characters: characters.value.value, building: building.value.value };
  let result: BaseResult;
  try { result = queryBaseSkills(snapshot, { ...tables, crossCheck: crossCheck.status === 'fulfilled' ? crossCheck.value.value : undefined }, query); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'base-cross-check-invalid') throw error;
    result = queryBaseSkills(snapshot, tables, query);
    result.crossCheck = { status: 'unavailable', differences: [], issues: ['cross-check-invalid'] };
  }
  result.source = { mode: 'public', files: [characters.value.source, building.value.source, ...(crossCheck.status === 'fulfilled' ? [crossCheck.value.source] : [])] };
  if (crossCheck.status === 'rejected') result.crossCheck = { status: 'unavailable', differences: [], issues: ['cross-check-unavailable'] };
  return result;
}

const cell = (value: string) => value.replace(/[\r\n]+/g, ' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;');
/** Render exactly the query result; no additional game decisions occur in this formatter. */
export function formatBaseSkills(result: BaseResult, language = 'zh-CN'): string {
  const english = !language.toLowerCase().startsWith('zh');
  const status = english ? { active: 'active when conditions hold', locked: 'future unlock', superseded: 'superseded', unknown: 'pending verification' }
    : { active: '当前有效（条件待核）', locked: '后续解锁', superseded: '已替换', unknown: '待核' };
  const lines = [english ? '# Base skills' : '# 基建技能查询', '', `${english ? 'Snapshot read at' : '账号快照读取时间'}：${result.snapshotReadAt}`, '',
    result.source.mode === 'supplied' ? english ? 'Source: supplied input; not fetched or authenticated against the public mirror in this run.' : '来源：所提供的数据；本次未从公开镜像获取或核验。' : english ? 'Source: fixed public commits.' : '来源：公开固定提交。', '',
    ...result.source.files.map(source => `- ${source.repository}@${source.commit} / ${source.file} / SHA256 ${source.sha256} / ${source.readAt}`), '',
    ...(english ? result.limits : ['已解锁不证明当前进驻或条件已满足。', '阵营组合、全局效果、心情、配方及其他条件未建模。',
      '文本百分比不是最终收益，不作收益排名或加总。', '未观察到的持有和练度保持待核；识别完成不代表账号名册完整。']).map(text => `- ${text}`), ''];
  for (const operator of result.operators) {
    const ownership = operator.ownership === 'owned' ? english ? 'owned' : '已持有' : english ? 'ownership unknown' : '持有待核';
    lines.push(`## ${cell(operator.name)} (${cell(operator.id)})`, '', `${ownership}；${english ? 'Elite / level' : '精英阶段 / 等级'}：${operator.elite ?? '?'} / ${operator.level ?? '?'}`, '',
      english ? '| Skill | Room | Unlock | Status | Conditions (source text) |' : '| 技能 | 房间 | 解锁 | 状态 | 条件（来源全文） |', '| --- | --- | --- | --- | --- |');
    for (const skill of operator.skills) {
      const unlock = skill.unlock ? english ? `Elite ${skill.unlock.elite}, level ${skill.unlock.level}` : `精${skill.unlock.elite} ${skill.unlock.level}级` : '?';
      lines.push(`| ${cell(skill.name)} | ${cell(skill.room ? english ? skill.room : rooms[skill.room] ?? skill.room : '?')} | ${unlock} | ${status[skill.status]}${skill.supersededBy ? ` (${cell(skill.supersededBy)})` : ''} | ${cell(skill.text || '?')} |`);
    }
    lines.push('');
  }
  if (!result.operators.length) lines.push(english ? 'No matching observed operators.' : '没有匹配的已观察干员。', '');
  lines.push(`${english ? 'Cross-check' : '交叉核对'}：${result.crossCheck.status}；${result.crossCheck.differences.length} ${english ? 'differences' : '条差异'}`, '');
  for (const diff of result.crossCheck.differences) lines.push(`- ${cell(diff.operatorId)} / ${diff.onlyIn} / ${cell(diff.skill.name)} / ${cell(diff.skill.room ?? '?')} / ${diff.skill.elite ?? '?'}:${diff.skill.level ?? '?'} / ${cell(diff.skill.text)}`);
  for (const issue of result.crossCheck.issues) lines.push(`- ${cell(issue)}`);
  if (result.warnings.length) lines.push(english ? 'Pending checks:' : '待核项：', '', ...result.warnings.map(warning => `- ${cell(warning)}`), '');
  return lines.join('\n');
}

type Request = BaseQuery & { tablesFile?: string; snapshotFile?: string; format?: 'json' | 'markdown'; currentLanguage?: string };
function request(value: unknown): Request {
  const data = object(value);
  for (const key of Object.keys(data)) if (!['operators', 'room', 'tablesFile', 'snapshotFile', 'format', 'currentLanguage'].includes(key)) throw new Error('base-input-invalid');
  for (const key of ['room', 'tablesFile', 'snapshotFile', 'currentLanguage']) if (data[key] !== undefined) label(data[key]);
  if (data.operators !== undefined && (!Array.isArray(data.operators) || data.operators.some(value => typeof value !== 'string' || !value.trim()))) throw new Error('base-input-invalid');
  if (data.format !== undefined && !['json', 'markdown'].includes(String(data.format))) throw new Error('base-input-invalid');
  return data as Request;
}
const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    if (process.argv[2] !== 'query') throw new Error('base-input-invalid');
    const input = request(await readStdinJson({ maxBytes: null, invalidCode: 'base-input-invalid' })), settings = await readSettings();
    const language = startup(settings, input.currentLanguage ?? 'zh-CN').language;
    const snapshotFile = input.snapshotFile ?? (settings?.privateDirectory ? join(settings.privateDirectory, 'account-snapshot.json') : null);
    if (!snapshotFile) throw new Error('base-snapshot-required');
    const snapshot: unknown = JSON.parse(await readFile(snapshotFile, 'utf8'));
    let result: BaseResult;
    if (input.tablesFile) {
      const supplied = object(JSON.parse(await readFile(input.tablesFile, 'utf8')));
      result = queryBaseSkills(snapshot, { characters: supplied.characters, building: supplied.building, crossCheck: supplied.crossCheck }, input);
    } else result = await queryPublicBaseSkills(snapshot, input);
    const summary = formatBaseSkills(result, language);
    if (input.format === 'markdown') process.stdout.write(summary);
    else process.stdout.write(JSON.stringify({ ok: true, result, summary }));
  } catch (error) {
    const stable = new Set(['base-data-invalid', 'base-input-invalid', 'base-snapshot-invalid', 'base-snapshot-required', 'base-room-invalid', 'base-cross-check-invalid',
      'public-data-input-invalid', 'public-data-network-failed', 'public-data-http-failed', 'public-data-too-large', 'public-data-json-invalid']);
    console.error(JSON.stringify(error instanceof AmbiguousName ? { ok: false, error: 'base-name-ambiguous', candidates: error.candidates }
      : { ok: false, error: stdinJsonCode(error) ?? (error instanceof Error && stable.has(error.message) ? error.message : 'base-query-check-required') }));
    process.exitCode = 1;
  }
}
