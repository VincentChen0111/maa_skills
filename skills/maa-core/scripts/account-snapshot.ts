import { mkdir, readFile, open, rename, unlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, stdinJsonCode } from './stdin-json.ts';
import { randomUUID } from 'node:crypto';
import { readSettings as readSettingsFile, settingsHome, startup } from './preferences.ts';
import { CheckRequiredError, checkRequiredFor } from './check-required.ts';
/** Settings that exist but cannot be read are refused by their own code, not as an unclassified failure. */
const readSettings = (home?: string) => readSettingsFile(home).catch(() => { throw new Error('settings-unreadable'); });
/** A recognition file or MAA cache that cannot be read is reported as such, without its path or the system message. */
const readInput = (path: string) => readFile(path, 'utf8').catch(error => {
  throw Object.assign(new CheckRequiredError('account-input-unreadable'), { code: (error as NodeJS.ErrnoException).code });
});
// Adapted from nhyo/dsh-maa-cli src/operators/{depot,operator-box}.js
// at cdeaa8fac12bdc1db5b4ea5c33fca358dc6cf43b. Copyright (c) 2026 nhyo.
// Installed MIT license: ../LICENSE. Source details: THIRD_PARTY_NOTICES.md in the repository.
export type Coverage = { status: 'complete' | 'partial' | 'pending' | 'missing' | 'invalid' | 'unavailable'; issues: string[] };
/** `mastery` is keyed by skill slot ("1"-"3"), `modules` by module ID; null means unknown. MAA recognition leaves all three null. */
export type Operator = { id: string; name: string; rarity: number | null; elite: number | null; level: number | null; potential: number | null;
  skillLevel: number | null; mastery: Record<string, number | null> | null; modules: Record<string, number | null> | null };
/** Raw mood (0-8,640,000) as of `moodAt`; Skland reports it, MAA recognition does not provide a base layout. */
export type BaseOperator = { id: string; role?: 'trainee' | 'trainer'; moodRaw: number | null; moodAt: string | null };
export type BaseRoom = { type: 'control' | 'power' | 'manufacture' | 'trading' | 'dormitory' | 'meeting' | 'hire' | 'training'; slotId: string; level: number | null; operators: BaseOperator[] };
export type AccountSnapshot = { version: 1; source: 'maa' | 'skland'; readAt: string; operators: Operator[]; items: Record<string, number>; lmd: number | null;
  base: { rooms: BaseRoom[] } | null; sourceTimes: { operators: string | null; inventory: string | null };
  coverage: { operators: Coverage; inventory: Coverage; base: Coverage; medicine?: Coverage; vouchers?: Coverage; stageClears?: Coverage } };
export const snapshotFiles = { maa: 'account-snapshot.json', skland: 'account-snapshot-skland.json' } as const;

/**
 * What a query needs from a snapshot: owned operators with elite/level/potential, per-operator skill level, mastery and
 * modules, the depot, or the base layout. MAA recognition never provides skills or the base (see `parseMaaSnapshot`).
 */
export type SnapshotDomain = 'operators' | 'skills' | 'inventory' | 'base';
/** Whether a snapshot provides a domain. `complete` demands an unqualified read (the bar for switching to Skland). */
export function snapshotCovers(value: unknown, domain: SnapshotDomain, complete = false): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, any>, coverage = snapshot.coverage ?? {};
  const read = (status: unknown) => complete ? status === 'complete' : status === 'complete' || status === 'partial';
  const operators = Array.isArray(snapshot.operators) && snapshot.operators.length > 0 && read(coverage.operators?.status)
    && !(Array.isArray(coverage.operators?.issues) && coverage.operators.issues.includes('empty-recognition'));
  if (domain === 'operators') return operators;
  if (domain === 'skills') return operators && snapshot.operators.some((operator: Record<string, unknown>) => Number.isSafeInteger(operator?.skillLevel)
    || operator?.mastery && typeof operator.mastery === 'object' || operator?.modules && typeof operator.modules === 'object');
  if (domain === 'inventory') return read(coverage.inventory?.status) && !!snapshot.items && typeof snapshot.items === 'object';
  return read(coverage.base?.status) && Array.isArray(snapshot.base?.rooms);
}
export class SnapshotSelectionError extends Error {
  readonly kind: 'missing' | 'unreadable';
  constructor(kind: 'missing' | 'unreadable') { super(`snapshot-${kind}`); this.name = 'SnapshotSelectionError'; this.kind = kind; }
}
export type SnapshotSelection = { snapshot: Record<string, unknown>; source: 'maa' | 'skland' | null; readAt: string | null;
  /** explicit: the request named the file; maa-default: the MAA snapshot covered the query or no better one existed;
   * skland-covers: the MAA snapshot lacked a needed domain the Skland snapshot covers completely; maa-missing /
   * maa-unreadable: there was no usable MAA snapshot, so the Skland snapshot was read. */
  chosen: 'explicit' | 'maa-default' | 'skland-covers' | 'maa-missing' | 'maa-unreadable'; lacking: SnapshotDomain[] };
/**
 * The one owner of "which saved snapshot does this query read" (over-blocking review OB-9, 2026-11-16). One whole file is
 * read, never two merged (spec: 两份快照不合并): an explicit `snapshotFile` as it is; otherwise the MAA recognition snapshot,
 * unless it lacks a needed domain that the Skland snapshot covers completely, or there is no usable MAA snapshot at all.
 * Callers print the source and read time it returns.
 */
export async function selectSnapshot(privateDirectory: string, needed: readonly SnapshotDomain[], explicitFile?: string): Promise<SnapshotSelection> {
  const load = async (file: string): Promise<Record<string, unknown> | 'missing' | 'unreadable'> => {
    let raw: string;
    try { raw = await readFile(file, 'utf8'); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'; }
    try { return object(JSON.parse(raw.replace(/^﻿/, ''))); } catch { return 'unreadable'; }
  };
  const result = (snapshot: Record<string, unknown>, chosen: SnapshotSelection['chosen'], lacking: SnapshotDomain[]): SnapshotSelection => ({ snapshot,
    source: snapshot.source === 'maa' || snapshot.source === 'skland' ? snapshot.source : null, readAt: typeof snapshot.readAt === 'string' ? snapshot.readAt : null, chosen, lacking });
  if (explicitFile !== undefined) {
    const named = await load(resolve(explicitFile));
    if (typeof named === 'string') throw new SnapshotSelectionError(named);
    return result(named, 'explicit', needed.filter(domain => !snapshotCovers(named, domain)));
  }
  const maa = await load(join(privateDirectory, snapshotFiles.maa));
  const lacking = typeof maa === 'string' ? [...needed] : needed.filter(domain => !snapshotCovers(maa, domain));
  if (typeof maa !== 'string' && !lacking.length) return result(maa, 'maa-default', []);
  const skland = await load(join(privateDirectory, snapshotFiles.skland));
  if (typeof skland !== 'string') {
    if (typeof maa === 'string') return result(skland, maa === 'missing' ? 'maa-missing' : 'maa-unreadable', needed.filter(domain => !snapshotCovers(skland, domain)));
    if (lacking.every(domain => snapshotCovers(skland, domain, true))) return result(skland, 'skland-covers', lacking);
  }
  if (typeof maa === 'string') throw new SnapshotSelectionError(maa);
  return result(maa, 'maa-default', lacking);
}
/** One line for the user: which snapshot was read, why, and its read time (Skland's is not the in-game data time). */
export function snapshotSourceLine(selection: Pick<SnapshotSelection, 'source' | 'readAt' | 'chosen' | 'lacking'>): string {
  const names: Record<SnapshotDomain, string> = { operators: '干员', skills: '技能等级、专精和模组', inventory: '仓库', base: '基建' };
  const why = selection.chosen === 'skland-covers' ? `（MAA 识别快照没有${selection.lacking.map(domain => names[domain]).join('、')}，森空岛快照完整，整份改读森空岛快照，两份不合并）`
    : selection.chosen === 'maa-missing' ? '（没有 MAA 识别快照，改读森空岛快照）' : selection.chosen === 'maa-unreadable' ? '（MAA 识别快照读不了，改读森空岛快照）'
    : selection.chosen === 'explicit' ? '（请求指定的快照）' : '';
  const source = selection.source === 'skland' ? '森空岛快照' : selection.source === 'maa' ? 'MAA 识别快照' : '来源未标明的快照';
  const caveat = selection.source === 'skland' ? '；读取时间是本次从森空岛读的时间，不是游戏内的数据时间，森空岛比游戏内滞后多久没有测过' : '';
  const gap = selection.lacking.length && selection.chosen !== 'skland-covers' ? `；这份快照没有${selection.lacking.map(domain => names[domain]).join('、')}，相关项待核` : '';
  return `账号来源：${source}${why}，读取时间 ${selection.readAt ?? '未知'}${caveat}${gap}。`;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object-required');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error('invalid-number');
  return value as number;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 96) throw new Error('invalid-string');
  return value;
}
function optionalNumber(value: unknown, field: string, min: number, max: number, coverage: Coverage): number | null {
  if (value === undefined || value === null) { coverage.issues.push('missing-' + field); return null; }
  return integer(value, min, max);
}
export function parseMaaSnapshot(text: string, readAt = new Date().toISOString()): AccountSnapshot {
  if (new Date(readAt).toISOString() !== readAt) throw new Error('invalid-read-time');
  const snapshot: AccountSnapshot = { version: 1, source: 'maa', readAt, operators: [], items: {}, lmd: null, base: null,
    sourceTimes: { operators: null, inventory: null }, coverage: { operators: { status: 'missing', issues: [] }, inventory: { status: 'missing', issues: [] }, base: { status: 'unavailable', issues: ['not-provided-by-recognition'] } } };
  let callbacks: Record<string, unknown>[];
  try {
    const input = JSON.parse(text);
    if (input && typeof input === 'object' && !Array.isArray(input) && ('depot' in input || 'operBox' in input)) {
      callbacks = [];
      if ('depot' in input) callbacks.push({ taskchain: 'Depot', what: 'DepotInfo', details: input.depot });
      if ('operBox' in input) callbacks.push({ taskchain: 'OperBox', what: 'OperBoxInfo', details: input.operBox });
    } else callbacks = (Array.isArray(input) ? input : [input]).map(object);
  } catch {
    for (const field of ['operators', 'inventory'] as const) snapshot.coverage[field] = { status: 'invalid', issues: ['invalid-json'] };
    return snapshot;
  }
  const depot = callbacks.filter(value => value.taskchain === 'Depot' && ['DepotInfo', 'DepotTemplateLoadError'].includes(String(value.what))).at(-1);
  if (depot) {
    try {
      if (depot.what !== 'DepotInfo') throw new Error('recognition-failed');
      const details = object(depot.details);
      snapshot.sourceTimes.inventory = scanTime(details.syncTime);
      if (typeof details.done !== 'boolean') throw new Error('done-required');
      snapshot.coverage.inventory.status = 'pending';
      if (details.done) {
        const data = object(typeof details.data === 'string' ? JSON.parse(details.data) : details.data);
        const items: Record<string, number> = {};
        for (const [id, count] of Object.entries(data)) {
          if (!/^[A-Za-z0-9_@.-]{1,96}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('invalid-item-id');
          items[id] = integer(count, 0, 2_147_483_647);
        }
        snapshot.items = items;
        snapshot.coverage.inventory = Object.keys(items).length ? { status: 'complete', issues: [] } : { status: 'partial', issues: ['empty-recognition'] };
        snapshot.lmd = snapshot.items['4001'] ?? null;
      }
    } catch { snapshot.coverage.inventory = { status: 'invalid', issues: ['invalid-depot'] }; }
  }
  const box = callbacks.filter(value => value.taskchain === 'OperBox' && value.what === 'OperBoxInfo').at(-1);
  if (box) {
    try {
      const details = object(box.details);
      if (details.source !== undefined && details.source !== 'local') throw new Error('unsupported-source');
      snapshot.sourceTimes.operators = scanTime(details.syncTime);
      if (typeof details.done !== 'boolean') throw new Error('done-required');
      snapshot.coverage.operators.status = 'pending';
      if (details.done) {
        if (!Array.isArray(details.own_opers)) throw new Error('operators-required');
        const ids = new Set<string>();
        const operators = details.own_opers.map((entry: unknown) => {
          const raw = object(entry);
          const id = string(raw.id);
          if (raw.own !== true || ids.has(id)) throw new Error('invalid-ownership');
          ids.add(id);
          return { id, name: string(raw.name), rarity: optionalNumber(raw.rarity, 'rarity', 1, 6, snapshot.coverage.operators),
            elite: optionalNumber(raw.elite, 'elite', 0, 2, snapshot.coverage.operators), level: optionalNumber(raw.level, 'level', 1, 100, snapshot.coverage.operators),
            potential: optionalNumber(raw.potential, 'potential', 1, 6, snapshot.coverage.operators), skillLevel: null, mastery: null, modules: null };
        });
        snapshot.operators = operators;
        if (!operators.length) snapshot.coverage.operators.issues.push('empty-recognition');
        snapshot.coverage.operators.status = snapshot.coverage.operators.issues.length ? 'partial' : 'complete';
      }
    } catch { snapshot.coverage.operators = { status: 'invalid', issues: ['invalid-operbox'] }; }
  }
  return snapshot;
}

function scanTime(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('invalid-scan-time');
  return new Date(value).toISOString();
}


export type ImportRequest = { callbackFile?: string; depotFile?: string; operBoxFile?: string; currentLanguage?: string; format?: 'json' | 'markdown' };
function importRequest(value: unknown): ImportRequest {
  const input = object(value);
  if (Object.keys(input).some(key => !['callbackFile', 'depotFile', 'operBoxFile', 'currentLanguage', 'format'].includes(key))) throw new Error('invalid-request');
  for (const key of ['callbackFile', 'depotFile', 'operBoxFile', 'currentLanguage'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key])) throw new Error('invalid-request');
  }
  if (input.format !== undefined && input.format !== 'json' && input.format !== 'markdown') throw new Error('invalid-format');
  if (input.callbackFile && (input.depotFile || input.operBoxFile)) throw new Error('conflicting-input');
  return { ...input } as ImportRequest;
}
export async function inspectMaaSnapshot(value: unknown, home = settingsHome()): Promise<AccountSnapshot> {
  const input = importRequest(value);
  const configured = !input.callbackFile && !input.depotFile && !input.operBoxFile;
  if (configured) {
    const { maaDirectory } = await readSettings(home);
    if (!maaDirectory) throw new Error('maa-directory-required');
    input.depotFile = join(maaDirectory, 'data/DepotData.json');
    input.operBoxFile = join(maaDirectory, 'data/OperBoxData.json');
  }
  let text: string;
  if (input.callbackFile) text = await readInput(input.callbackFile);
  else {
    const data: Record<string, unknown> = {};
    for (const [key, path] of [['depot', input.depotFile], ['operBox', input.operBoxFile]] as const) if (path) {
      let raw: string;
      try { raw = await readInput(path); }
      catch (error) { if (configured && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      try { data[key] = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { data[key] = null; }
    }
    text = JSON.stringify(data);
  }
  return parseMaaSnapshot(text.replace(/^\uFEFF/, ''));
}
export async function importMaaSnapshot(value: unknown, home = settingsHome()): Promise<AccountSnapshot> {
  const { privateDirectory } = await readSettings(home);
  return saveAccountSnapshot(privateDirectory, snapshotFiles.maa, () => inspectMaaSnapshot(value, home));
}
/**
 * The one writer for account snapshots of every source: a shared exclusive lock (never taken over
 * automatically; EEXIST means busy), a private temporary file and an atomic rename into the private directory.
 */
export async function saveAccountSnapshot(privateDirectory: string, fileName: (typeof snapshotFiles)[keyof typeof snapshotFiles],
  produce: () => Promise<AccountSnapshot>): Promise<AccountSnapshot> {
  // A writing step that fails is a save failure; a held lock (EEXIST) stays busy, and errors of produce() keep their own code.
  const saving = <T>(step: Promise<T>) => step.catch(error => { throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? error : new CheckRequiredError('account-save-failed'); });
  await saving(mkdir(privateDirectory, { recursive: true }));
  const lockFile = join(privateDirectory, '.account-snapshot.lock');
  const lock = await saving(open(lockFile, 'wx', 0o600));
  const temporary = join(privateDirectory, `.account-snapshot-${randomUUID()}.tmp`);
  try {
    await saving(lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })));
    const snapshot = await produce();
    const file = await saving(open(temporary, 'wx', 0o600));
    try { await saving(file.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`)); await saving(file.sync()); }
    finally { await file.close(); }
    await saving(rename(temporary, join(privateDirectory, fileName)));
    return snapshot;
  } finally {
    try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await lock.close(); await unlink(lockFile);
  }
}
export function formatAccountSummary(snapshot: AccountSnapshot, language = 'zh-CN'): string {
  const english = !language.toLowerCase().startsWith('zh');
  const labels = english
    ? ['MAA account snapshot', 'Read at', 'Source: MAA recognition (cached results may be older)', 'Operators', 'Inventory', 'LMD', 'Unknown', 'Base layout: unavailable', 'Skills, mastery and modules: unknown', 'Only observed facts are available; absent inventory is unknown, not zero.']
    : ['MAA 账号快照', '读取时间', '来源：MAA 识别（缓存可能早于本次读取）', '干员', '仓库', '龙门币', '未知', '基建布局：不可得', '技能、专精和模组：未知', '只包含已识别事实；未列出的库存是未知，不是零。'];
  const scanLabel = english ? 'Original scan time (operators / inventory)' : '原扫描时间（干员 / 仓库）';
  return `# ${labels[0]}\n\n${labels[2]}\n\n${labels[1]}：${snapshot.readAt}\n\n${scanLabel}：${snapshot.sourceTimes.operators ?? labels[6]} / ${snapshot.sourceTimes.inventory ?? labels[6]}\n\n- ${labels[3]}：${snapshot.coverage.operators.status} (${snapshot.operators.length})\n- ${labels[4]}：${snapshot.coverage.inventory.status} (${Object.keys(snapshot.items).length})\n- ${labels[5]}：${snapshot.lmd ?? labels[6]}\n- ${labels[7]}\n- ${labels[8]}\n\n${labels[9]}\n`;
}
/** Static codes thrown above (request checks, callback parsing, settings); each names its own cause and carries no input. */
const accountErrorCodes: ReadonlySet<string> = new Set(['unknown-action', 'object-required', 'invalid-request', 'invalid-format', 'conflicting-input',
  'maa-directory-required', 'settings-unreadable', 'recognition-failed', 'done-required', 'invalid-item-id', 'unsupported-source', 'operators-required',
  'invalid-ownership', 'invalid-number', 'invalid-string', 'invalid-read-time', 'invalid-scan-time']);
const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    const action = process.argv[2];
    if (!['inspect', 'import'].includes(action ?? '')) throw new Error('unknown-action');
    const input = importRequest(await readStdinJson({ maxBytes: null }));
    const settings = await readSettings();
    const { language } = startup(settings, input.currentLanguage ?? 'zh-CN');
    const snapshot = action === 'import' ? await importMaaSnapshot(input) : await inspectMaaSnapshot(input);
    const summary = formatAccountSummary(snapshot, language);
    if (input.format === 'markdown') process.stdout.write(summary);
    else console.log(JSON.stringify({ ok: true, saved: action === 'import', readAt: snapshot.readAt, sourceTimes: snapshot.sourceTimes, coverage: snapshot.coverage,
      operatorCount: snapshot.operators.length, itemCount: Object.keys(snapshot.items).length, lmd: snapshot.lmd, summary }));
  } catch (error) {
    // Ticket 26: the static codes this script throws are reported as they are, so a refusal says why. Anything else (a file
    // that cannot be read, a failed save, an unclassified failure) is a specific check-required result (owner trial item 10)
    // that prints no path or system message.
    const code = stdinJsonCode(error) ?? (error instanceof CheckRequiredError ? null : (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'account-busy'
      : error instanceof Error && accountErrorCodes.has(error.message) ? error.message : null);
    console.error(JSON.stringify(code ? { ok: false, error: code } : checkRequiredFor('account-snapshot', error)));
    process.exitCode = 1;
  }
}
