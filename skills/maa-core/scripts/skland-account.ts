import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings, startup } from './preferences.ts';
import { CredentialError, readCredential, recordCredentialOutcome } from './credentials.ts';
import type { Protector } from './credential-protection.ts';
import { saveAccountSnapshot, snapshotFiles, type AccountSnapshot, type BaseOperator, type BaseRoom, type Coverage, type Operator } from './account-snapshot.ts';

/**
 * Read-only Skland account reader. It is the only user of the Skland account credential: the pasted
 * token is exchanged, requests are signed and the session refreshed in memory, and only the converted
 * snapshot (no token, cookie or account identifier) leaves the process. It never signs in for the user,
 * checks in, posts, likes, pays or writes; public Skland community research must not import this module.
 * Endpoints, signing and fields were checked against public MIT projects; see docs/skland-account-sources.md.
 */
export type SklandFetch = (url: string, init: RequestInit) => Promise<Response>;
export type SklandFailure = 'credential-unset' | 'credential-unreadable' | 'credential-expired' | 'windows-required' | 'protection-failed'
  | 'network-failed' | 'service-error' | 'signature-rejected' | 'response-invalid' | 'binding-missing' | 'binding-ambiguous';
export type CredentialReport = 'usable' | 'expired' | 'unreadable' | 'unset' | 'unchanged';
export type SklandRead = { status: 'ok'; snapshot: AccountSnapshot; credential: CredentialReport } | { status: SklandFailure; snapshot: null; credential: CredentialReport };
type Issue = 'network-failed' | 'service-error' | 'signature-rejected' | 'response-invalid' | 'credential-rejected' | 'binding-missing' | 'binding-ambiguous';
export type SnapshotDomain = 'operators' | 'inventory' | 'base';

const grantUrl = 'https://as.hypergryph.com/user/oauth2/v2/grant';
const zonai = 'https://zonai.skland.com';
const skland = { appCode: '4ca99fa6b56cc2ba', cred: '/api/v1/user/auth/generate_cred_by_code', refresh: '/api/v1/auth/refresh',
  binding: '/api/v1/game/player/binding', info: '/api/v1/game/player/info', cultivate: '/api/v1/game/cultivate/player' } as const;
const requestTimeoutMs = 20_000;
const maximumResponseBytes = 16 * 1024 * 1024;
const fullMood = 8_640_000;
export const sklandDisclosures = ['no-public-statement-as-of-2026-11-13', 'lag-unmeasured'] as const;

class ReadFailure extends Error {
  readonly issue: Issue;
  constructor(issue: Issue) { super(issue); this.issue = issue; }
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function object(value: unknown): Record<string, unknown> { if (!isObject(value)) throw new Error('object-required'); return value; }
const safeKey = (id: string) => !['__proto__', 'constructor', 'prototype'].includes(id);
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{1,96}$/.test(value) || !safeKey(value)) throw new Error('invalid-identifier');
  return value;
}

async function bodyText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > maximumResponseBytes) throw new ReadFailure('response-invalid');
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumResponseBytes) { await reader.cancel().catch(() => undefined); throw new ReadFailure('response-invalid'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** One request: fixed host, no redirects, bounded time and size. Errors carry only a fixed code, never the URL or the reply. */
async function call(fetcher: SklandFetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response; let text: string;
  try {
    response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs) });
    text = await bodyText(response);
  } catch (error) { throw error instanceof ReadFailure ? error : new ReadFailure('network-failed'); }
  if (response.status === 429 || response.status >= 500) throw new ReadFailure('service-error');
  try { return object(JSON.parse(text.replace(/^\uFEFF/, ''))); }
  catch { throw new ReadFailure(response.ok ? 'response-invalid' : 'service-error'); }
}
const json = { 'Content-Type': 'application/json' };
const status = (value: unknown) => Number.isSafeInteger(value) ? value as number : undefined;

/**
 * Session with the two-level refresh: a 10000 reply refreshes the signing key once with the cred; a 10002
 * reply, or a refresh that is refused or does not help, exchanges the saved token again once. Only a grant
 * the service explicitly refuses rejects the credential. Every data request follows a grant that accepted
 * the token in this same read, so 10000/10002 after both levels is a signature, clock or header problem.
 */
class SklandSession {
  private cred = ''; private key = ''; private refreshed = false; private exchangedAgain = false;
  private readonly fetcher: SklandFetch; private readonly userToken: string; private readonly clock: () => number;
  constructor(fetcher: SklandFetch, userToken: string, clock: () => number) { this.fetcher = fetcher; this.userToken = userToken; this.clock = clock; }
  async start() { await this.exchange(); }
  private async exchange() {
    const grant = await call(this.fetcher, grantUrl, { method: 'POST', headers: json, body: JSON.stringify({ appCode: skland.appCode, ['token']: this.userToken, type: 0 }) });
    const code = isObject(grant.data) ? grant.data.code : undefined;
    if (grant.status !== 0 || typeof code !== 'string' || !code) throw new ReadFailure(status(grant.status) !== undefined && grant.status !== 0 ? 'credential-rejected' : 'response-invalid');
    const issued = await call(this.fetcher, zonai + skland.cred, { method: 'POST', headers: json, body: JSON.stringify({ code, kind: 1 }) });
    const data = isObject(issued.data) ? issued.data : {};
    if (issued.code !== 0 || typeof data.cred !== 'string' || !data.cred || typeof data['token'] !== 'string' || !data['token']) {
      throw new ReadFailure(status(issued.code) !== undefined && issued.code !== 0 ? 'service-error' : 'response-invalid');
    }
    this.cred = data.cred; this.key = data['token'] as string;
  }
  private async refreshKey(): Promise<boolean> {
    const reply = await call(this.fetcher, zonai + skland.refresh, { method: 'GET', headers: { cred: this.cred } });
    const data = isObject(reply.data) ? reply.data : {};
    if (reply.code === 0 && typeof data['token'] === 'string' && data['token']) { this.key = data['token'] as string; return true; }
    if (status(reply.code) === undefined) throw new ReadFailure('response-invalid');
    return false;
  }
  private signed(path: string, query: string): Record<string, string> {
    const header = { platform: '', timestamp: String(Math.floor(this.clock() / 1000) - 1), dId: '', vName: '' };
    const hex = createHmac('sha256', this.key).update(`${path}${query}${header.timestamp}${JSON.stringify(header)}`).digest('hex');
    return { cred: this.cred, sign: createHash('md5').update(hex).digest('hex'), ...header };
  }
  async get(path: string, query = ''): Promise<Record<string, unknown>> {
    for (;;) {
      const reply = await call(this.fetcher, `${zonai}${path}${query ? `?${query}` : ''}`, { method: 'GET', headers: this.signed(path, query) });
      if (reply.code === 0) { if (!isObject(reply.data)) throw new ReadFailure('response-invalid'); return reply.data; }
      if (reply.code !== 10000 && reply.code !== 10002) throw new ReadFailure(status(reply.code) !== undefined ? 'service-error' : 'response-invalid');
      if (reply.code === 10000 && !this.refreshed && !this.exchangedAgain) { this.refreshed = true; if (await this.refreshKey()) continue; }
      if (this.exchangedAgain) throw new ReadFailure('signature-rejected');
      this.exchangedAgain = true; await this.exchange();
    }
  }
}

/** Skland's default Arknights role; several roles without a default stop the read instead of guessing. */
function chosenRole(binding: Record<string, unknown>): string {
  const app = (Array.isArray(binding.list) ? binding.list : []).filter(isObject).find(entry => entry.appCode === 'arknights');
  const roles = (app && Array.isArray(app.bindingList) ? app.bindingList : []).filter(isObject)
    .filter(entry => entry.isDelete !== true && typeof entry['uid'] === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(entry['uid'] as string));
  if (!roles.length) throw new ReadFailure('binding-missing');
  const marked = roles.filter(entry => entry.isDefault === true);
  const chosen = roles.find(entry => entry['uid'] === app!.defaultUid) ?? (marked.length === 1 ? marked[0] : undefined) ?? (roles.length === 1 ? roles[0] : undefined);
  if (!chosen) throw new ReadFailure('binding-ambiguous');
  return chosen['uid'] as string;
}

export async function readSklandAccount(options: { privateDirectory: string; fetcher?: SklandFetch; protector?: Protector; now?: () => Date }): Promise<SklandRead> {
  const privateDirectory = resolve(options.privateDirectory);
  let saved: { revision: string; values: Record<string, string> };
  try { saved = await readCredential('skland', { privateDirectory, ...(options.protector ? { protector: options.protector } : {}) }); }
  catch (error) {
    const code = error instanceof CredentialError ? error.message : 'protection-failed';
    if (code === 'credential-unset') return { status: 'credential-unset', snapshot: null, credential: 'unset' };
    if (code === 'credential-unreadable') return { status: 'credential-unreadable', snapshot: null, credential: 'unreadable' };
    return { status: code === 'windows-required' ? 'windows-required' : 'protection-failed', snapshot: null, credential: 'unchanged' };
  }
  let credential: CredentialReport = 'unchanged';
  const record = async (outcome: 'usable' | 'expired') => {
    if (await recordCredentialOutcome('skland', saved.revision, outcome, { privateDirectory }).catch(() => false)) credential = outcome;
  };
  const now = options.now ?? (() => new Date(Date.now()));
  const session = new SklandSession(options.fetcher ?? ((url, init) => fetch(url, init)), saved.values['token'] ?? '', () => now().getTime());
  try {
    await session.start();
    const binding = await session.get(skland.binding);
    await record('usable');
    const query = `uid=${encodeURIComponent(chosenRole(binding))}`;
    const info = await session.get(skland.info, query);
    // Player info without the checked operator structure means the interface changed: no usable read.
    if (operators(isObject(info) ? info : {}).coverage.status === 'invalid') throw new ReadFailure('response-invalid');
    let cultivate: unknown; let cultivateIssue: Issue | undefined;
    try { cultivate = await session.get(skland.cultivate, query); }
    catch (error) {
      if (!(error instanceof ReadFailure)) throw error;
      cultivateIssue = error.issue;
      if (error.issue === 'credential-rejected') await record('expired');
    }
    return { status: 'ok', snapshot: sklandSnapshot({ info, cultivate, cultivateIssue }, now().toISOString()), credential };
  } catch (error) {
    const issue: Issue = error instanceof ReadFailure ? error.issue : 'response-invalid';
    if (issue === 'credential-rejected') { await record('expired'); return { status: 'credential-expired', snapshot: null, credential }; }
    return { status: issue, snapshot: null, credential };
  }
}

// ---- conversion into the shared AccountSnapshot ----------------------------------------------------

type Parts = { info: unknown; cultivate?: unknown; cultivateIssue?: Issue };
const noSource = (): Coverage => ({ status: 'unavailable', issues: ['no-source'] });
function finish(issues: Set<string>, empty: boolean): Coverage {
  if (empty) issues.add('empty-response');
  return { status: issues.size ? 'partial' : 'complete', issues: [...issues] };
}
/** Integer field: absent is unknown (`missing-*`), out of range is unknown (`invalid-*`); offset converts 0-based counts. */
function field(value: unknown, name: string, min: number, max: number, issues: Set<string>, offset = 0): number | null {
  if (value === undefined || value === null) { issues.add(`missing-${name}`); return null; }
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) { issues.add(`invalid-${name}`); return null; }
  return (value as number) + offset;
}
const utcSeconds = (value: unknown, issues: Set<string>): string | null => {
  if (value === undefined || value === null) { issues.add('missing-mood-time'); return null; }
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 32_503_680_000) { issues.add('invalid-mood-time'); return null; }
  return new Date((value as number) * 1000).toISOString();
};

function operators(info: Record<string, unknown>): { operators: Operator[]; coverage: Coverage } {
  try {
    if (!Array.isArray(info.chars)) throw new Error('chars-required');
    const catalog = isObject(info.charInfoMap) ? info.charInfoMap : {};
    const issues = new Set<string>(); const ids = new Set<string>();
    const list = info.chars.map((raw): Operator => {
      const entry = object(raw); const id = identifier(entry.charId);
      if (ids.has(id)) throw new Error('duplicate-operator');
      ids.add(id);
      const meta = isObject(catalog[id]) ? catalog[id] as Record<string, unknown> : {};
      let name = id;
      if (typeof meta.name === 'string' && meta.name.trim() && meta.name.length <= 96) name = meta.name;
      else issues.add(meta.name === undefined ? 'missing-name' : 'invalid-name');
      let mastery: Operator['mastery'] = null;
      if (entry.skills === undefined || entry.skills === null) issues.add('missing-mastery');
      else if (!Array.isArray(entry.skills) || entry.skills.length > 3) issues.add('invalid-mastery');
      else mastery = Object.fromEntries(entry.skills.map((skill, index) => [String(index + 1),
        isObject(skill) ? field(skill.specializeLevel, 'mastery', 0, 3, issues) : (issues.add('invalid-mastery'), null)]));
      let modules: Operator['modules'] = null;
      if (entry.equip === undefined || entry.equip === null) issues.add('missing-modules');
      else if (!Array.isArray(entry.equip)) issues.add('invalid-modules');
      else {
        modules = {};
        for (const raw of entry.equip) {
          let module: string;
          try { module = identifier(object(raw).id); } catch { issues.add('invalid-modules'); continue; }
          if (Object.hasOwn(modules, module)) { issues.add('invalid-modules'); continue; }
          const value = object(raw);
          if (value.locked === true) modules[module] = 0;
          else if (value.locked === false) modules[module] = field(value.level, 'module-level', 0, 3, issues);
          else { issues.add('missing-module-lock'); modules[module] = null; }
        }
      }
      return { id, name, rarity: field(meta.rarity, 'rarity', 0, 5, issues, 1), elite: field(entry.evolvePhase, 'elite', 0, 2, issues),
        level: field(entry.level, 'level', 1, 100, issues), potential: field(entry.potentialRank, 'potential', 0, 5, issues, 1),
        skillLevel: field(entry.mainSkillLvl, 'skill-level', 1, 7, issues), mastery, modules };
    });
    return { operators: list, coverage: finish(issues, !list.length) };
  } catch { return { operators: [], coverage: { status: 'invalid', issues: ['invalid-player-info'] } }; }
}

const rooms: [string, BaseRoom['type'], boolean][] = [['control', 'control', true], ['powers', 'power', false], ['manufactures', 'manufacture', false],
  ['tradings', 'trading', false], ['dormitories', 'dormitory', false], ['meeting', 'meeting', true], ['hire', 'hire', true], ['training', 'training', true]];
function base(info: Record<string, unknown>): { base: AccountSnapshot['base']; coverage: Coverage } {
  if (info.building === undefined || info.building === null) return { base: null, coverage: { status: 'missing', issues: ['not-returned'] } };
  try {
    const building = object(info.building); const issues = new Set<string>(); const result: BaseRoom[] = [];
    const stationed = (raw: unknown, role?: 'trainee' | 'trainer'): BaseOperator => {
      const entry = object(raw);
      return { id: identifier(entry.charId), ...(role ? { role } : {}), moodRaw: field(entry.ap, 'mood', 0, fullMood, issues), moodAt: utcSeconds(entry.lastApAddTime, issues) };
    };
    const list = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new Error('list-required'); return value; };
    for (const [key, type, single] of rooms) {
      const value = building[key];
      if (value === undefined) { issues.add(`missing-${type}`); continue; }
      if (value === null && single) continue;
      for (const raw of single ? [value] : list(value)) {
        const room = object(raw);
        if (typeof room.slotId !== 'string' || !/^[A-Za-z0-9_]{1,96}$/.test(room.slotId)) throw new Error('invalid-slot');
        const operators = type === 'training'
          ? [...(room.trainer ? [stationed(room.trainer, 'trainer')] : []), ...(room.trainee ? [stationed(room.trainee, 'trainee')] : [])]
          : list(room.chars).map(entry => stationed(entry));
        result.push({ type, slotId: room.slotId, level: field(room.level, 'room-level', 1, 5, issues), operators });
      }
    }
    return { base: { rooms: result }, coverage: finish(issues, !result.length) };
  } catch { return { base: null, coverage: { status: 'invalid', issues: ['invalid-building'] } }; }
}

function inventory(parts: Parts): { items: Record<string, number>; coverage: Coverage } {
  if (parts.cultivateIssue) {
    const invalid = parts.cultivateIssue === 'response-invalid';
    return { items: {}, coverage: { status: invalid ? 'invalid' : 'unavailable', issues: [invalid ? 'invalid-cultivate' : parts.cultivateIssue] } };
  }
  try {
    const data = object(parts.cultivate);
    if (!Array.isArray(data.items)) throw new Error('items-required');
    const items: Record<string, number> = {}; const issues = new Set<string>();
    for (const raw of data.items) {
      const entry = object(raw);
      if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_@.-]{1,96}$/.test(entry.id) || !safeKey(entry.id) || Object.hasOwn(items, entry.id)) throw new Error('invalid-item');
      const count = typeof entry.count === 'string' && /^\d{1,10}$/.test(entry.count) ? Number(entry.count) : entry.count;
      if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 2_147_483_647) { issues.add('invalid-item-count'); continue; }
      items[entry.id] = count as number;
    }
    return { items, coverage: finish(issues, !Object.keys(items).length) };
  } catch { return { items: {}, coverage: { status: 'invalid', issues: ['invalid-cultivate'] } }; }
}

/**
 * Converts Skland player info and cultivation data. Rarity and potential count from 0 there and from 1 in
 * the snapshot. Account fields (role identifiers, nickname, avatar, status) are never copied. Medicine,
 * vouchers and per-stage clears have no verified source and are marked as such, never zero-filled.
 */
export function sklandSnapshot(parts: Parts, readAt: string): AccountSnapshot {
  if (new Date(readAt).toISOString() !== readAt) throw new Error('invalid-read-time');
  const info = isObject(parts.info) ? parts.info : {};
  const operatorPart = operators(info), basePart = base(info), inventoryPart = inventory(parts);
  return { version: 1, source: 'skland', readAt, operators: operatorPart.operators, items: inventoryPart.items,
    lmd: inventoryPart.items['4001'] ?? null, base: basePart.base, sourceTimes: { operators: null, inventory: null },
    coverage: { operators: operatorPart.coverage, inventory: inventoryPart.coverage, base: basePart.coverage,
      medicine: noSource(), vouchers: noSource(), stageClears: noSource() } };
}
/**
 * Domains this read did not obtain, because the request failed (`unavailable`), the reply did not have the
 * checked structure (`invalid`) or the domain was not returned (`missing`). Such a read never replaces an
 * existing Skland snapshot; it may only become the first one, with the reasons kept in `coverage`.
 */
export function incompleteDomains(snapshot: AccountSnapshot): SnapshotDomain[] {
  return (['operators', 'inventory', 'base'] as const).filter(domain => !['complete', 'partial'].includes(snapshot.coverage[domain].status));
}

// ---- comparing MAA and Skland snapshots ------------------------------------------------------------

type Side = { source: string; readAt: string | null; sourceTimes: { operators: string | null; inventory: string | null }; coverage: Record<string, string> };
export type Comparison = { sides: [Side, Side]; sameAccount: 'unverifiable';
  operators: { differences: { id: string; name: string; field: string; values: [unknown, unknown] }[]; onlyIn: Record<string, string[]> };
  items: { differences: { id: string; values: [number, number] }[]; onlyIn: Record<string, string[]> };
  lmd: { values: [number | null, number | null]; differs: boolean } };
const utc = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
function side(snapshot: Record<string, unknown>): Side {
  const coverage = isObject(snapshot.coverage) ? snapshot.coverage : {}, times = isObject(snapshot.sourceTimes) ? snapshot.sourceTimes : {};
  return { source: String(snapshot.source), readAt: utc(snapshot.readAt), sourceTimes: { operators: utc(times.operators), inventory: utc(times.inventory) },
    coverage: Object.fromEntries(Object.entries(coverage).map(([key, value]) => [key, isObject(value) ? String(value.status) : 'unknown'])) };
}
/** Lists every disagreement between two snapshots of different sources with their times. It never merges or rewrites either side. */
export function compareAccountSnapshots(leftInput: unknown, rightInput: unknown): Comparison {
  const [left, right] = [leftInput, rightInput].map(value => {
    const snapshot = object(value);
    if (snapshot.version !== 1 || !['maa', 'skland'].includes(String(snapshot.source)) || !Array.isArray(snapshot.operators) || !isObject(snapshot.items)) throw new Error('snapshot-invalid');
    return snapshot;
  }) as [Record<string, unknown>, Record<string, unknown>];
  if (left.source === right.source) throw new Error('same-source');
  const names = [String(left.source), String(right.source)] as const;
  const index = (snapshot: Record<string, unknown>) => new Map((snapshot.operators as unknown[]).filter(isObject).map(op => [String(op.id), op]));
  const [a, b] = [index(left), index(right)];
  const differences: Comparison['operators']['differences'] = [];
  for (const [id, x] of a) {
    const y = b.get(id); if (!y) continue;
    const name = String(x.name ?? y.name ?? id);
    for (const key of ['rarity', 'elite', 'level', 'potential', 'skillLevel']) {
      if (x[key] !== null && x[key] !== undefined && y[key] !== null && y[key] !== undefined && x[key] !== y[key]) differences.push({ id, name, field: key, values: [x[key], y[key]] });
    }
    for (const key of ['mastery', 'modules']) {
      if (!isObject(x[key]) || !isObject(y[key])) continue;
      const [xm, ym] = [x[key] as Record<string, unknown>, y[key] as Record<string, unknown>];
      for (const part of Object.keys(xm)) if (xm[part] != null && ym[part] != null && xm[part] !== ym[part]) differences.push({ id, name, field: `${key}.${part}`, values: [xm[part], ym[part]] });
    }
  }
  const [ia, ib] = [left.items, right.items] as Record<string, number>[];
  const itemDifferences = Object.keys(ia!).filter(id => Object.hasOwn(ib!, id) && ia![id] !== ib![id]).map(id => ({ id, values: [ia![id]!, ib![id]!] as [number, number] }));
  const lmd: [number | null, number | null] = [typeof left.lmd === 'number' ? left.lmd : null, typeof right.lmd === 'number' ? right.lmd : null];
  return { sides: [side(left), side(right)], sameAccount: 'unverifiable',
    operators: { differences, onlyIn: { [names[0]]: [...a.keys()].filter(id => !b.has(id)), [names[1]]: [...b.keys()].filter(id => !a.has(id)) } },
    items: { differences: itemDifferences, onlyIn: { [names[0]]: Object.keys(ia!).filter(id => !Object.hasOwn(ib!, id)), [names[1]]: Object.keys(ib!).filter(id => !Object.hasOwn(ia!, id)) } },
    lmd: { values: lmd, differs: lmd[0] !== null && lmd[1] !== null && lmd[0] !== lmd[1] } };
}

// ---- user-facing text --------------------------------------------------------------------------------

const zh = (language: string) => language.toLowerCase().startsWith('zh');
const repairs: Record<SklandFailure, string> = { 'credential-unset': 'enter-credential', 'credential-unreadable': 'reenter-credential', 'credential-expired': 'reenter-credential',
  'windows-required': 'use-windows', 'protection-failed': 'retry-later', 'network-failed': 'retry-later', 'service-error': 'retry-later',
  'signature-rejected': 'check-system-time', 'response-invalid': 'report-issue', 'binding-missing': 'bind-role-in-skland', 'binding-ambiguous': 'set-default-role-in-skland' };
/** A partial read: a domain whose reply had the wrong structure points to an interface change; a failed request to a retry. */
const partialRepair = (snapshot: AccountSnapshot) => incompleteDomains(snapshot).some(domain => snapshot.coverage[domain].status === 'invalid') ? 'report-issue' : 'retry-later';
const disclosureText = (language: string) => zh(language)
  ? ['请注意：', '1. 截至 2026-11-13，没有找到鹰角网络对第三方调用森空岛接口的公开表态。', '2. 森空岛数据比游戏内实际状态滞后多久没有测过；读取时间不等于游戏内的数据时间。']
  : ['Please note:', '1. As of 2026-11-13, we found no public statement from Hypergryph about third parties calling the Skland API.',
    '2. How far Skland data lags behind the game has not been measured; the read time is not the in-game data time.'];
export function formatSklandFailure(failure: SklandFailure, language = 'zh-CN'): string {
  const enter = 'node <maa-core>/scripts/credentials.ts input skland --language ' + (zh(language) ? 'zh-CN' : 'en');
  const text: Record<SklandFailure, [string, string]> = {
    'credential-unset': ['森空岛凭据还没有设置。请你自己打开终端运行 `' + enter + '`，粘贴你自己取得的 token；不要把 token 发到对话里。',
      'The Skland credential is not set. Open your own terminal and run `' + enter + '`, then paste the token you obtained yourself; do not paste it into the chat.'],
    'credential-unreadable': ['保存的森空岛凭据无法读取（记录损坏或不是当前 Windows 用户保存的）。请你自己在终端重新运行 `' + enter + '`。',
      'The saved Skland credential cannot be read (damaged, or saved by another Windows user). Run `' + enter + '` again in your own terminal.'],
    'credential-expired': ['森空岛拒绝了保存的 token，已记为已知过期。请你自己取得新的 token，在终端运行 `' + enter + '` 重新粘贴。',
      'Skland refused the saved token; it is now recorded as expired. Obtain a new token yourself and run `' + enter + '` in your own terminal.'],
    'windows-required': ['凭据只能在保存它的 Windows 用户下解开，本次没有读取。', 'The credential can only be opened by the Windows user who saved it; nothing was read.'],
    'protection-failed': ['解开凭据时出错，本次没有读取；稍后再试，仍失败时重新输入凭据。', 'Opening the credential failed; nothing was read. Try again later, or enter the credential again.'],
    'network-failed': ['连不上森空岛或超时。凭据状态不变，稍后再试。', 'Skland could not be reached or timed out. The credential state is unchanged; try again later.'],
    'service-error': ['森空岛拒绝了这次请求，但没有表明是凭据问题（可能是限流或风控）。凭据状态不变，本工具不会自动重试，请稍后再试。',
      'Skland refused this request without saying the credential is bad (possibly rate limiting or risk control). The credential state is unchanged; this tool does not retry automatically. Try again later.'],
    'signature-rejected': ['森空岛在本次读取中接受了 token，却仍拒绝请求签名，所以不是 token 过期，凭据状态不变。请检查电脑的系统时间和时区是否准确；时间正确仍失败时，接口可能已经变化，请报告问题。',
      'Skland accepted the token in this read but still refused the request signature, so the token has not expired and its state is unchanged. Check that the computer\'s clock and time zone are correct; if they are and it still fails, the interface may have changed, so please report it.'],
    'response-invalid': ['森空岛的回复格式和已核对的不一致，本次不采用。接口可能已经变化，请报告问题。',
      'The Skland reply does not match the checked format and was not used. The interface may have changed; please report it.'],
    'binding-missing': ['这个森空岛账号下没有可用的明日方舟角色。请先在森空岛 App 里绑定角色。', 'No usable Arknights role is bound to this Skland account. Bind one in the Skland app first.'],
    'binding-ambiguous': ['这个森空岛账号下有多个明日方舟角色且没有默认角色。请在森空岛 App 里设好默认角色后再读取。',
      'Several Arknights roles are bound and none is the default. Set a default role in the Skland app, then read again.'],
  };
  const first = zh(language) ? '没有读到新的账号数据；已有的森空岛快照（如果有）保持原样，不能当作本次读取的数据。' : 'No new account data was read; an existing Skland snapshot (if any) is unchanged and is not data from this read.';
  return `${first}\n\n${text[failure][zh(language) ? 0 : 1]}\n`;
}
export function formatSklandSummary(snapshot: AccountSnapshot, credential: CredentialReport, language = 'zh-CN', save?: 'saved' | 'first' | 'kept'): string {
  const z = zh(language), c = snapshot.coverage;
  const failed = incompleteDomains(snapshot).map(domain => z ? { operators: '干员', inventory: '仓库', base: '基建' }[domain] : domain).join(z ? '、' : ', ');
  const unknown = z ? '未知' : 'unknown';
  const lines = z ? ['# 森空岛账号快照', '', '来源：森空岛（只读；不保存账号标识）', '', `读取时间：${snapshot.readAt}（本次从森空岛读取的时间，不是游戏内的数据时间）`, '',
    `- 干员：${c.operators.status} (${snapshot.operators.length})`, '- 技能等级、专精和模组：来自森空岛；没有返回的保持未知',
    `- 仓库：${c.inventory.status} (${Object.keys(snapshot.items).length})`, `- 龙门币：${snapshot.lmd ?? unknown}`,
    `- 基建：${c.base.status}（${snapshot.base?.rooms.length ?? 0} 个房间；心情是原始值及其记录时间，满值 ${fullMood}）`,
    '- 理智药等药剂：无来源', '- 凭证和各类券：无来源', '- 逐关通关状态：无来源']
    : ['# Skland account snapshot', '', 'Source: Skland (read-only; no account identifiers are kept)', '', `Read at: ${snapshot.readAt} (when this read happened, not the in-game data time)`, '',
      `- Operators: ${c.operators.status} (${snapshot.operators.length})`, '- Skill level, mastery and modules: from Skland; anything not returned stays unknown',
      `- Inventory: ${c.inventory.status} (${Object.keys(snapshot.items).length})`, `- LMD: ${snapshot.lmd ?? unknown}`,
      `- Base: ${c.base.status} (${snapshot.base?.rooms.length ?? 0} rooms; mood is the raw value with its own time, full at ${fullMood})`,
      '- Sanity potions and other medicine: no source', '- Vouchers and tickets: no source', '- Per-stage clear status: no source'];
  const partial = (['operators', 'inventory', 'base'] as const).filter(key => c[key].issues.length).map(key => `${key}: ${c[key].issues.join(', ')}`);
  if (partial.length) lines.push('', (z ? '缺失或未采用：' : 'Missing or not used: ') + partial.join('; '));
  if (failed) {
    const retry = partialRepair(snapshot) === 'report-issue'
      ? (z ? '回复格式和已核对的不一致，接口可能已经变化，请报告问题。' : 'A reply did not have the checked format; the interface may have changed, so please report it.')
      : (z ? '请稍后再试。' : 'Try again later.');
    lines.push('', save === 'kept'
      ? (z ? `本次读取不完整（没有读到：${failed}），已有的森空岛快照保持不变，这次结果没有保存。${retry}` : `This read is incomplete (not read: ${failed}). The existing Skland snapshot is unchanged and this result was not saved. ${retry}`)
      : save === 'first'
        ? (z ? `本次读取不完整（没有读到：${failed}）。这是第一份森空岛快照，已保存，没读到的部分标为不可用或无效并写明原因；之后完整读取时会替换它。${retry}`
          : `This read is incomplete (not read: ${failed}). It is the first Skland snapshot and was saved with those parts marked unavailable or invalid with the reason; a later complete read replaces it. ${retry}`)
        : (z ? `本次读取不完整（没有读到：${failed}）。${retry}` : `This read is incomplete (not read: ${failed}). ${retry}`));
  }
  if (credential === 'expired') lines.push('', z ? '森空岛在本次读取中途拒绝了 token，已记为已知过期；请重新粘贴 token。' : 'Skland refused the token during this read; it is now recorded as expired. Paste a new token.');
  lines.push('', ...disclosureText(language), '', z ? '只包含已读取的事实；未列出的库存是未知，不是零。' : 'Only facts that were read are included; unlisted inventory is unknown, not zero.');
  return `${lines.join('\n')}\n`;
}
export function formatComparison(comparison: Comparison, language = 'zh-CN', limit = 50): string {
  const z = zh(language), cell = (value: unknown) => String(value ?? (z ? '未知' : 'unknown')).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const lines = [z ? '# 账号快照对比' : '# Account snapshot comparison', '',
    z ? '两份快照各自保留，本对比不合并、不改写任何一份；两份是否来自同一账号无法核对。' : 'Both snapshots stay as they are; this comparison does not merge or rewrite either. Whether both come from the same account cannot be checked.', ''];
  for (const s of comparison.sides) lines.push(z ? `- ${s.source}：读取时间 ${cell(s.readAt)}；原扫描时间（干员 / 仓库）${cell(s.sourceTimes.operators)} / ${cell(s.sourceTimes.inventory)}；覆盖 ${cell(JSON.stringify(s.coverage))}`
    : `- ${s.source}: read at ${cell(s.readAt)}; original scan time (operators / inventory) ${cell(s.sourceTimes.operators)} / ${cell(s.sourceTimes.inventory)}; coverage ${cell(JSON.stringify(s.coverage))}`);
  const [l, r] = comparison.sides.map(s => s.source);
  lines.push('', z ? `## 干员差异（${comparison.operators.differences.length}）` : `## Operator differences (${comparison.operators.differences.length})`, '', `| ${z ? '干员' : 'Operator'} | ${z ? '字段' : 'Field'} | ${l} | ${r} |`, '| --- | --- | --- | --- |');
  for (const d of comparison.operators.differences.slice(0, limit)) lines.push(`| ${cell(d.name)} | ${cell(d.field)} | ${cell(d.values[0])} | ${cell(d.values[1])} |`);
  if (comparison.operators.differences.length > limit) lines.push('', z ? `另有 ${comparison.operators.differences.length - limit} 项，见 JSON 输出。` : `${comparison.operators.differences.length - limit} more in the JSON output.`);
  lines.push('', z ? `## 仓库差异（${comparison.items.differences.length}）` : `## Inventory differences (${comparison.items.differences.length})`, '', `| ${z ? '物品' : 'Item'} | ${l} | ${r} |`, '| --- | --- | --- |');
  for (const d of comparison.items.differences.slice(0, limit)) lines.push(`| ${cell(d.id)} | ${cell(d.values[0])} | ${cell(d.values[1])} |`);
  if (comparison.items.differences.length > limit) lines.push('', z ? `另有 ${comparison.items.differences.length - limit} 项，见 JSON 输出。` : `${comparison.items.differences.length - limit} more in the JSON output.`);
  lines.push('', z ? `龙门币：${l} ${cell(comparison.lmd.values[0])}，${r} ${cell(comparison.lmd.values[1])}` : `LMD: ${l} ${cell(comparison.lmd.values[0])}, ${r} ${cell(comparison.lmd.values[1])}`);
  const only = (kind: 'operators' | 'items') => Object.entries(comparison[kind].onlyIn).map(([source, ids]) => `${source} ${ids.length}`).join(z ? '，' : ', ');
  lines.push('', z ? `只出现在一边（干员）：${only('operators')}；（物品）：${only('items')}。一边没有不代表没有，可能只是那一边没读到。` : `Only on one side (operators): ${only('operators')}; (items): ${only('items')}. Absent on one side does not mean absent from the account; that side may not have read it.`);
  return `${lines.join('\n')}\n`;
}

// ---- CLI -----------------------------------------------------------------------------------------------

type Request = { currentLanguage?: string; format?: 'json' | 'markdown'; maaFile?: string; sklandFile?: string };
class KeepExisting extends Error {}
/** Whether a snapshot file is there; anything but "does not exist" counts as present, so it is never replaced blindly. */
async function present(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}
function request(value: unknown, action: string): Request {
  const input = object(value);
  const allowed = action === 'compare' ? ['currentLanguage', 'format', 'maaFile', 'sklandFile'] : ['currentLanguage', 'format'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('invalid-request');
  for (const key of ['currentLanguage', 'maaFile', 'sklandFile']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key])) throw new Error('invalid-request');
  if (input.format !== undefined && input.format !== 'json' && input.format !== 'markdown') throw new Error('invalid-request');
  return input as Request;
}
const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  const fail = (body: Record<string, unknown>) => { console.error(JSON.stringify({ ok: false, saved: false, ...body })); process.exitCode = 1; };
  try {
    const action = process.argv[2] ?? '';
    if (!['inspect', 'import', 'compare'].includes(action)) throw new Error('unknown-action');
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const input = request(JSON.parse(raw || '{}'), action);
    const settings = await readSettings();
    const { language } = startup(settings, input.currentLanguage ?? 'zh-CN');
    if (action === 'compare') {
      const load = async (source: 'maa' | 'skland', path: string) => {
        try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as unknown; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: source }; throw error; }
      };
      const sides = [await load('maa', resolve(input.maaFile ?? join(settings.privateDirectory, snapshotFiles.maa))),
        await load('skland', resolve(input.sklandFile ?? join(settings.privateDirectory, snapshotFiles.skland)))];
      const missing = sides.flatMap(side => isObject(side) && typeof side.missing === 'string' ? [side.missing] : []);
      if (missing.length) fail({ error: 'snapshot-missing', missing });
      else {
        const comparison = compareAccountSnapshots(sides[0], sides[1]);
        const summary = formatComparison(comparison, language);
        if (input.format === 'markdown') process.stdout.write(summary); else console.log(JSON.stringify({ ok: true, comparison, summary }));
      }
    } else {
      const result = await readSklandAccount({ privateDirectory: settings.privateDirectory });
      if (result.status !== 'ok') fail({ error: result.status, credential: result.credential, repair: repairs[result.status], summary: formatSklandFailure(result.status, language) });
      else {
        const snapshot = result.snapshot, failedDomains = incompleteDomains(snapshot);
        let save: 'saved' | 'first' | 'kept' | undefined;
        if (action === 'import') {
          // Decided under the shared write lock: an incomplete read may only become the first Skland snapshot.
          const target = join(settings.privateDirectory, snapshotFiles.skland);
          await saveAccountSnapshot(settings.privateDirectory, snapshotFiles.skland, async () => {
            if (failedDomains.length && await present(target)) { save = 'kept'; throw new KeepExisting(); }
            save = failedDomains.length ? 'first' : 'saved';
            return snapshot;
          }).catch(error => { if (!(error instanceof KeepExisting)) throw error; });
        }
        const summary = formatSklandSummary(snapshot, result.credential, language, save);
        if (input.format === 'markdown') process.stdout.write(summary);
        else console.log(JSON.stringify({ ok: true, saved: save === 'saved' || save === 'first', source: 'skland', readAt: snapshot.readAt, coverage: snapshot.coverage,
          failedDomains, ...(failedDomains.length ? { repair: partialRepair(snapshot) } : {}),
          operatorCount: snapshot.operators.length, itemCount: Object.keys(snapshot.items).length, lmd: snapshot.lmd, baseRoomCount: snapshot.base?.rooms.length ?? 0,
          credential: result.credential, disclosures: sklandDisclosures, summary }));
      }
    }
  } catch (error) {
    fail({ error: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'account-busy' : 'account-check-required' });
  }
}
