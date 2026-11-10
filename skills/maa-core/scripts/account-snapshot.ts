import { mkdir, readFile, open, rename, unlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readSettings, settingsHome, startup } from './preferences.ts';
// Adapted from nhyo/dsh-maa-cli src/operators/{depot,operator-box}.js
// at cdeaa8fac12bdc1db5b4ea5c33fca358dc6cf43b. Copyright (c) 2026 nhyo.
// Installed MIT license: ../LICENSE. Source details: THIRD_PARTY_NOTICES.md in the repository.
export type Coverage = { status: 'complete' | 'partial' | 'pending' | 'missing' | 'invalid' | 'unavailable'; issues: string[] };
export type Operator = { id: string; name: string; rarity: number | null; elite: number | null; level: number | null; potential: number | null;
  skillLevel: null; mastery: null; modules: null };
export type AccountSnapshot = { version: 1; source: 'maa'; readAt: string; operators: Operator[]; items: Record<string, number>; lmd: number | null; base: null;
  sourceTimes: { operators: string | null; inventory: string | null }; coverage: { operators: Coverage; inventory: Coverage; base: Coverage } };
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
  if (input.callbackFile) text = await readFile(input.callbackFile, 'utf8');
  else {
    const data: Record<string, unknown> = {};
    for (const [key, path] of [['depot', input.depotFile], ['operBox', input.operBoxFile]] as const) if (path) {
      let raw: string;
      try { raw = await readFile(path, 'utf8'); }
      catch (error) { if (configured && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      try { data[key] = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { data[key] = null; }
    }
    text = JSON.stringify(data);
  }
  return parseMaaSnapshot(text.replace(/^\uFEFF/, ''));
}
export async function importMaaSnapshot(value: unknown, home = settingsHome()): Promise<AccountSnapshot> {
  const { privateDirectory } = await readSettings(home);
  await mkdir(privateDirectory, { recursive: true });
  const lockFile = join(privateDirectory, '.account-snapshot.lock');
  const lock = await open(lockFile, 'wx', 0o600);
  const temporary = join(privateDirectory, `.account-snapshot-${randomUUID()}.tmp`);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const snapshot = await inspectMaaSnapshot(value, home);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(privateDirectory, 'account-snapshot.json'));
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
const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    const action = process.argv[2];
    if (!['inspect', 'import'].includes(action ?? '')) throw new Error('unknown-action');
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const input = importRequest(JSON.parse(raw));
    const settings = await readSettings();
    const { language } = startup(settings, input.currentLanguage ?? 'zh-CN');
    const snapshot = action === 'import' ? await importMaaSnapshot(input) : await inspectMaaSnapshot(input);
    const summary = formatAccountSummary(snapshot, language);
    if (input.format === 'markdown') process.stdout.write(summary);
    else console.log(JSON.stringify({ ok: true, saved: action === 'import', readAt: snapshot.readAt, sourceTimes: snapshot.sourceTimes, coverage: snapshot.coverage,
      operatorCount: snapshot.operators.length, itemCount: Object.keys(snapshot.items).length, lmd: snapshot.lmd, summary }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'account-busy' : 'account-check-required' }));
    process.exitCode = 1;
  }
}
