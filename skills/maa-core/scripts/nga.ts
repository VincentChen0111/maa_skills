import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialError, inspectCredentials, readCredential, recordCredentialOutcome } from './credentials.ts';
import type { Protector } from './credential-protection.ts';
import { readSettings } from './preferences.ts';
import { platformTransport, type ResearchTransport, type TransportResponse } from './research-transport.ts';
import { cacheKey, contentNotice, formatResearchMarkdown, getCached, plainText, putCached, readGateState, researchDirectory, summarizePages,
  systemClock, withResearchGate, type Clock, type PageOutcome, type ResearchItem, type ResearchPage, type ResearchResult } from './research.ts';

/**
 * The single NGA reading core: read-only search and thread reads, one parser and one classifier for
 * every platform's transport, the shared cross-process gate (interval and risk-control stop) and the
 * shared cache. The saved Cookie header is used in memory for the request only.
 */
export const ngaLimits = {
  minIntervalMs: 3_000, riskStopMs: 30 * 60_000, searchTtlMs: 6 * 3_600_000, threadTtlMs: 24 * 3_600_000,
  maxSearchPages: 3, maxThreadPages: 5, maxThreadPage: 1_000, timeoutMs: 20_000, maxResponseBytes: 4 * 1024 * 1024,
  lockStaleMs: 120_000, maxWaitMs: 150_000, keywordChars: 50, storedChars: 4_000, excerptChars: 600,
} as const;
export const ngaOrigin = 'https://bbs.nga.cn';
/** The 明日方舟 board, read from NGA's public board list on 2026-11-13 (docs/nga-sources.md). */
export const arknightsForumId = -34587507;
const linkHosts = new Set(['bbs.nga.cn', 'ngabbs.com', 'www.ngabbs.com', 'nga.178.com', 'bbs.ngacn.cc']);
const userAgent = 'maa-skills-research (read-only; +https://github.com/VincentChen0111/maa_skills)';
const source = 'nga';

export type NgaOptions = { privateDirectory: string; transport?: ResearchTransport; protector?: Protector; clock?: Clock };
export type NgaSearchRequest = { keyword: string; forum?: 'arknights' | 'all'; pages?: number; fresh?: boolean; cacheOnly?: boolean };
export type NgaReadRequest = { thread: number | string; pages?: number[]; fresh?: boolean; cacheOnly?: boolean };

const invalid = () => new Error('request-invalid');
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const integer = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && /^-?\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : undefined;
};
function mode(input: Record<string, unknown>) {
  for (const key of ['fresh', 'cacheOnly']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw invalid();
  if (input.fresh === true && input.cacheOnly === true) throw invalid();
  return { fresh: input.fresh === true, cacheOnly: input.cacheOnly === true };
}
function searchRequest(value: unknown) {
  const input = object(value);
  if (!input || Object.keys(input).some((key) => !['keyword', 'forum', 'pages', 'fresh', 'cacheOnly'].includes(key))) throw invalid();
  if (typeof input.keyword !== 'string' || /[\u0000-\u001f\u007f]/.test(input.keyword)) throw invalid();
  const keyword = input.keyword.split(/\s+/).filter(Boolean).join(' ');
  if (!keyword || [...keyword].length > ngaLimits.keywordChars) throw invalid();
  if (input.forum !== undefined && input.forum !== 'arknights' && input.forum !== 'all') throw invalid();
  const pages = input.pages === undefined ? 1 : integer(input.pages);
  if (pages === undefined || typeof input.pages === 'string' || pages < 1 || pages > ngaLimits.maxSearchPages) throw invalid();
  return { keyword, forum: (input.forum ?? 'arknights') as 'arknights' | 'all', pages, ...mode(input) };
}
function threadId(value: unknown): number {
  let id: number | undefined;
  if (typeof value === 'number') id = integer(value);
  else if (typeof value === 'string' && /^\d{1,10}$/.test(value.trim())) id = Number(value.trim());
  else if (typeof value === 'string') {
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw invalid(); }
    if (!['https:', 'http:'].includes(url.protocol) || !linkHosts.has(url.hostname) || url.pathname !== '/read.php') throw invalid();
    const tid = url.searchParams.get('tid');
    id = tid !== null && /^\d{1,10}$/.test(tid) ? Number(tid) : undefined;
  }
  if (id === undefined || id < 1 || id > 2_147_483_647) throw invalid();
  return id;
}
function readRequest(value: unknown) {
  const input = object(value);
  if (!input || Object.keys(input).some((key) => !['thread', 'pages', 'fresh', 'cacheOnly'].includes(key))) throw invalid();
  const thread = threadId(input.thread);
  const pages = input.pages === undefined ? [1] : input.pages;
  if (!Array.isArray(pages) || !pages.length || pages.length > ngaLimits.maxThreadPages || new Set(pages).size !== pages.length
    || pages.some((page) => typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > ngaLimits.maxThreadPage)) throw invalid();
  return { thread, pages: pages as number[], ...mode(input) };
}

// ---- response decoding and classification (one copy for every transport) ------------------------

/** UTF-8 when the bytes are valid UTF-8, otherwise GB18030 (a superset of the GBK that NGA declares). */
function decode(body: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return new TextDecoder('gb18030').decode(body); }
}
/** NGA leaves raw control characters inside JSON strings; escape them so the data parses as sent. */
function escapeControls(text: string): string {
  const out: string[] = []; let inString = false; let escaped = false;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (inString && !escaped && code < 0x20) { out.push(`\\u${code.toString(16).padStart(4, '0')}`); continue; }
    if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; }
    else if (char === '"') inString = true;
    out.push(char);
  }
  return out.join('');
}
function siteMessage(value: Record<string, unknown>): { code: number | null; text: string } | undefined {
  const message = object(object(value.data)?.__MESSAGE);
  const error = object(value.error);
  if (!message && !error) return undefined;
  const raw = typeof message?.['1'] === 'string' ? message['1'] : typeof error?.['0'] === 'string' ? error['0'].replace(/^\d+:/, '') : '';
  const fromError = typeof error?.['0'] === 'string' ? /^(\d+):/.exec(error['0'])?.[1] : undefined;
  return { code: integer(message?.['0']) ?? (fromError === undefined ? null : Number(fromError)), text: raw };
}
type Classified = { kind: 'data'; data: Record<string, unknown> } | { kind: 'credential-rejected' } | { kind: 'risk-control'; reason: string }
  | { kind: 'unavailable'; reason: string } | { kind: 'incomplete'; reason: string } | { kind: 'network-failed'; reason: string };
/**
 * The one place that decides what a response means. Risk control: 429, 503, any redirect, a non-data
 * page where data was asked for, or a site message about frequency or verification. Credential
 * rejection: only NGA's explicit not-signed-in message. Other refusals are per-item and unavailable.
 */
function classify(response: TransportResponse): Classified {
  const { status } = response;
  const text = decode(response.body).replace(/^﻿/, '').replace(/^\s*window\.script_muti_get_var_store\s*=\s*/, '').trim();
  if (status === 429 || status === 503 || (status >= 300 && status < 400)) return { kind: 'risk-control', reason: `http-${status}` };
  if (!text.startsWith('{')) {
    if (status === 404 || status === 410) return { kind: 'unavailable', reason: `http-${status}` };
    if (status >= 500) return { kind: 'network-failed', reason: `http-${status}` };
    if (status < 300 || status === 401 || status === 403) return { kind: 'risk-control', reason: status < 300 ? 'page-instead-of-data' : `http-${status}` };
    return { kind: 'unavailable', reason: `http-${status}` };
  }
  let value: Record<string, unknown> | undefined;
  try { value = object(JSON.parse(escapeControls(text))); } catch { return status >= 500 ? { kind: 'network-failed', reason: `http-${status}` } : { kind: 'incomplete', reason: 'data-unreadable' }; }
  if (!value) return { kind: 'incomplete', reason: 'data-unrecognized' };
  const message = siteMessage(value);
  if (message) {
    if (/频繁|过快|太快|稍后|验证码|人机|captcha|too many|too fast/i.test(message.text)) return { kind: 'risk-control', reason: 'site-message' };
    if (message.code === 1 && /登录/.test(message.text)) return { kind: 'credential-rejected' };
    return { kind: 'unavailable', reason: message.code === 5 ? 'too-old' : 'site-refused' };
  }
  if (status >= 500) return { kind: 'network-failed', reason: `http-${status}` };
  if (status !== 200) return { kind: 'unavailable', reason: `http-${status}` };
  const data = object(value.data);
  return data ? { kind: 'data', data } : { kind: 'incomplete', reason: 'data-unrecognized' };
}

// ---- parsing into whitelisted, cacheable values ---------------------------------------------------

type AuthorStatus = 'known' | 'anonymous' | 'unknown';
type StoredPost = { floor: number; author: string | null; authorStatus: AuthorStatus; publishedAt: string | null; timeAssumed: boolean; text: string; textTruncated: boolean; quotesRemoved: boolean };
type ThreadPage = { tid: number; page: number; title: string | null; totalPages: number | null; posts: StoredPost[] };
type StoredThread = { tid: number; title: string | null; author: string | null; authorStatus: AuthorStatus; publishedAt: string | null; lastReplyAt: string | null; replies: number | null };
type SearchPage = { page: number; totalResults: number | null; threads: StoredThread[] };

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
function entities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (all, name: string) => {
    if (name[0] !== '#') return named[name.toLowerCase()] ?? all;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : all;
  });
}
const tidy = (text: string) => plainText(text).replace(/[ \t\f\v 　]+/g, ' ').split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
function title(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = tidy(entities(value.replace(/<[^>]*>/g, ''))).replace(/\n/g, ' ');
  return text || null;
}
/** Post body to plain text: quotes of other people and reply headers are dropped so the text is the poster's own. */
function postText(value: unknown): { text: string; quotesRemoved: boolean } {
  if (typeof value !== 'string') return { text: '', quotesRemoved: false };
  let text = value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
  let quotesRemoved = false;
  for (let guard = 0; guard < 20 && /\[quote\][\s\S]*?\[\/quote\]/i.test(text); guard += 1) {
    text = text.replace(/\[quote\](?:(?!\[quote\])[\s\S])*?\[\/quote\]/gi, '\n'); quotesRemoved = true;
  }
  text = text
    .replace(/\[b\]\s*Reply to \[pid=[^\]]*\][\s\S]*?\[\/b\]/gi, '')
    .replace(/\[(?:pid|tid)=[^\]]*\][\s\S]*?\[\/(?:pid|tid)\]/gi, '')
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, ' ').replace(/\[s:[^\]]{1,40}\]/gi, '').replace(/\[del\][\s\S]*?\[\/del\]/gi, '')
    .replace(/\[url=([^\]]{1,500})\]([\s\S]*?)\[\/url\]/gi, '$2 ($1)').replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[collapse=([^\]]{1,200})\]/gi, '$1\n')
    .replace(/\[\/?(?:b|i|u|color|size|font|align|list|\*|h|code|collapse|flash|uid|stripbr|dice|crypt|randomblock|lessernuke|style|table|tr|td|span|r|l|quote)(?:=[^\]]*)?\]/gi, '');
  return { text: tidy(entities(text)), quotesRemoved };
}
const pad = (value: number) => String(value).padStart(2, '0');
/** NGA shows China Standard Time; a Unix timestamp is rendered with the +08:00 offset. */
function chinaTime(seconds: unknown): string | null {
  const value = integer(seconds);
  if (value === undefined || value <= 0) return null;
  const shifted = new Date(value * 1000 + 8 * 3_600_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`;
}
function author(name: unknown): { author: string | null; authorStatus: AuthorStatus } {
  if (typeof name !== 'string' || !name.trim()) return { author: null, authorStatus: 'unknown' };
  if (name.startsWith('#anony_')) return { author: null, authorStatus: 'anonymous' };
  const text = title(name);
  return text ? { author: text.slice(0, 80), authorStatus: 'known' } : { author: null, authorStatus: 'unknown' };
}
const rowsOf = (value: unknown): Record<string, unknown>[] | undefined => {
  if (Array.isArray(value)) return value.map(object).filter((row): row is Record<string, unknown> => !!row);
  const map = object(value);
  return map ? Object.keys(map).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map((key) => object(map[key])).filter((row): row is Record<string, unknown> => !!row) : undefined;
};

function parseThread(data: Record<string, unknown>, tid: number, page: number): ThreadPage | undefined {
  const rows = rowsOf(data.__R);
  if (!rows) return undefined;
  const users = object(data.__U) ?? {};
  const posts: StoredPost[] = [];
  for (const row of rows) {
    const floor = integer(row.lou);
    if (floor === undefined || floor < 0) continue;
    const id = integer(row.authorid);
    const who = author(id === undefined ? undefined : object(users[String(id)])?.username);
    let publishedAt = chinaTime(row.postdatetimestamp), timeAssumed = false;
    const shown = typeof row.postdate === 'string' ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/.exec(row.postdate) : null;
    if (!publishedAt && shown) { publishedAt = `${shown[1]}T${shown[2]}${shown[3] ?? ':00'}+08:00`; timeAssumed = true; }
    const body = postText(row.content);
    posts.push({ floor, ...who, publishedAt, timeAssumed, text: body.text.slice(0, ngaLimits.storedChars), textTruncated: body.text.length > ngaLimits.storedChars, quotesRemoved: body.quotesRemoved });
  }
  const total = integer(data.__ROWS), perPage = integer(data.__R__ROWS_PAGE) ?? 20;
  return { tid, page, title: title(object(data.__T)?.subject), totalPages: total !== undefined && total > 0 && perPage > 0 ? Math.ceil(total / perPage) : null, posts };
}
function parseSearch(data: Record<string, unknown>, page: number): SearchPage | undefined {
  const rows = rowsOf(data.__T);
  if (!rows) return undefined;
  const threads: StoredThread[] = [];
  for (const row of rows) {
    const tid = integer(row.tid), subject = title(row.subject);
    // NGA can mix a message row without author or time into the list; it is not a thread.
    if (tid === undefined || tid < 1 || !subject || (row.author === undefined && row.postdate === undefined)) continue;
    const replies = integer(row.replies);
    threads.push({ tid, title: subject, ...author(row.author), publishedAt: chinaTime(row.postdate), lastReplyAt: chinaTime(row.lastpost), replies: replies !== undefined && replies >= 0 ? replies : null });
  }
  const total = integer(data.__T__ROWS);
  return { page, totalResults: total !== undefined && total >= 0 ? total : null, threads };
}

const isText = (value: unknown) => value === null || typeof value === 'string';
const isCount = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const isStatus = (value: unknown) => value === 'known' || value === 'anonymous' || value === 'unknown';
function validThreadPage(value: unknown): value is ThreadPage {
  const page = object(value);
  return !!page && Number.isSafeInteger(page.tid) && Number.isSafeInteger(page.page) && isText(page.title) && isCount(page.totalPages) && Array.isArray(page.posts)
    && page.posts.every((item) => { const post = object(item); return !!post && Number.isSafeInteger(post.floor) && isText(post.author) && isStatus(post.authorStatus)
      && isText(post.publishedAt) && typeof post.timeAssumed === 'boolean' && typeof post.text === 'string' && typeof post.textTruncated === 'boolean' && typeof post.quotesRemoved === 'boolean'; });
}
function validSearchPage(value: unknown): value is SearchPage {
  const page = object(value);
  return !!page && Number.isSafeInteger(page.page) && isCount(page.totalResults) && Array.isArray(page.threads)
    && page.threads.every((item) => { const row = object(item); return !!row && Number.isSafeInteger(row.tid) && isText(row.title) && isText(row.author) && isStatus(row.authorStatus)
      && isText(row.publishedAt) && isText(row.lastReplyAt) && isCount(row.replies); });
}

// ---- one run: cache, credential, gate, request, record ------------------------------------------

type Served<T> = { value: T; origin: 'network' | 'cache'; readAt: string; stale: boolean };
type Target<T> = { label: string; key: string; url: string; ttlMs: number; valid: (value: unknown) => value is T; parse: (data: Record<string, unknown>) => T | undefined };
const iso = (ms: number) => new Date(ms).toISOString();
const credentialStates: Record<string, PageOutcome> = { unset: 'credential-required', expired: 'credential-rejected', unreadable: 'credential-unreadable', unknown: 'credential-unreadable' };

async function run<T>(targets: Target<T>[], flags: { fresh: boolean; cacheOnly: boolean }, options: NgaOptions) {
  const privateDirectory = resolve(options.privateDirectory);
  const directory = researchDirectory(privateDirectory, source);
  const clock = options.clock ?? systemClock;
  const transport = options.transport ?? platformTransport();
  const pages: ResearchPage[] = []; const served: Served<T>[] = [];
  let requests = 0, stoppedUntil: string | null = null, checked = false, succeeded = false, rejected = false;
  let blocked: { outcome: PageOutcome; repeat: boolean } | undefined;
  let credential: { revision: string; jar: string } | undefined;
  for (const target of targets) {
    const cached = await getCached(directory, target.key, clock.now(), target.valid);
    if (cached.state !== 'missing' && (flags.cacheOnly || (cached.state === 'fresh' && !flags.fresh))) {
      served.push({ value: cached.value, origin: 'cache', readAt: cached.storedAt, stale: cached.state === 'stale' });
      pages.push({ target: target.label, outcome: 'cached', served: cached.state === 'stale' ? 'stale-cache' : 'cache', readAt: cached.storedAt });
      continue;
    }
    const offer = (outcome: PageOutcome, reason?: string) => {
      if (cached.state === 'missing') { pages.push({ target: target.label, outcome, served: 'none', readAt: null, ...(reason ? { reason } : {}) }); return; }
      served.push({ value: cached.value, origin: 'cache', readAt: cached.storedAt, stale: cached.state === 'stale' });
      pages.push({ target: target.label, outcome, served: cached.state === 'stale' ? 'stale-cache' : 'cache', readAt: cached.storedAt, ...(reason ? { reason } : {}) });
    };
    if (flags.cacheOnly) { offer('not-cached'); continue; }
    if (!checked) {
      checked = true;
      const gate = await readGateState(directory, clock.now());
      if (gate.stopped) { stoppedUntil = gate.stoppedUntil; blocked = { outcome: 'risk-stopped', repeat: true }; }
      else {
        const state = (await inspectCredentials(privateDirectory, new Date(clock.now()))).credentials.find((item) => item.service === source)?.state ?? 'unknown';
        if (credentialStates[state]) blocked = { outcome: credentialStates[state]!, repeat: true };
        else {
          try { const saved = await readCredential(source, { privateDirectory, ...(options.protector ? { protector: options.protector } : {}) }); credential = { revision: saved.revision, jar: saved.values.cookie! }; }
          catch (error) { blocked = { outcome: error instanceof CredentialError && error.message === 'credential-unset' ? 'credential-required' : 'credential-unreadable', repeat: true }; }
        }
      }
    }
    if (blocked) { offer(blocked.repeat ? blocked.outcome : 'skipped'); continue; }
    const headers = Object.fromEntries([['Cookie', credential!.jar], ['User-Agent', userAgent], ['Accept', 'application/json, text/javascript, */*;q=0.1']]);
    let decision;
    try {
      decision = await withResearchGate(directory, { minIntervalMs: ngaLimits.minIntervalMs, stopMs: ngaLimits.riskStopMs, lockStaleMs: ngaLimits.lockStaleMs, maxWaitMs: ngaLimits.maxWaitMs }, clock, async () => {
        requests += 1;
        const at = clock.now();
        let classified: Classified;
        try { classified = classify(await transport.get({ url: target.url, headers }, { timeoutMs: ngaLimits.timeoutMs, maxBytes: ngaLimits.maxResponseBytes })); }
        catch (error) { classified = { kind: 'network-failed', reason: error instanceof Error && /^transport-[a-z-]+$/.test(error.message) ? error.message : 'transport-failed' }; }
        return { value: { classified, at }, ...(classified.kind === 'risk-control' ? { stop: 'risk-control' } : {}) };
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === 'research-busy')) throw error;
      blocked = { outcome: 'busy', repeat: false }; offer('busy'); continue;
    }
    if (!decision.performed) { stoppedUntil = decision.stoppedUntil; blocked = { outcome: 'risk-stopped', repeat: true }; offer('risk-stopped'); continue; }
    const { classified, at } = decision.value;
    if (classified.kind === 'data') {
      const value = target.parse(classified.data);
      if (value === undefined) { offer('incomplete', 'data-unrecognized'); continue; }
      await putCached(directory, target.key, value, target.ttlMs, at);
      served.push({ value, origin: 'network', readAt: iso(at), stale: false });
      pages.push({ target: target.label, outcome: 'fresh', served: 'network', readAt: iso(at) });
      succeeded = true;
    } else if (classified.kind === 'credential-rejected') { rejected = true; blocked = { outcome: 'credential-rejected', repeat: false }; offer('credential-rejected'); }
    else if (classified.kind === 'risk-control') {
      stoppedUntil = (await readGateState(directory, clock.now())).stoppedUntil; blocked = { outcome: 'risk-control', repeat: false }; offer('risk-control', classified.reason);
    } else if (classified.kind === 'network-failed') { blocked = { outcome: 'network-failed', repeat: false }; offer('network-failed', classified.reason); }
    else offer(classified.kind, classified.reason);
  }
  // Only NGA's explicit not-signed-in answer marks the saved value expired; risk control, network and parse problems never do.
  if (credential && rejected) await recordCredentialOutcome(source, credential.revision, 'expired', { privateDirectory, at: new Date(clock.now()) });
  else if (credential && succeeded) await recordCredentialOutcome(source, credential.revision, 'usable', { privateDirectory, at: new Date(clock.now()) });
  return { pages, served, requests, stoppedUntil };
}

function assemble(request: Record<string, unknown>, outcome: Awaited<ReturnType<typeof run>>, items: ResearchItem[], extra: string[], clock: Clock): ResearchResult {
  const { status, complete } = summarizePages(outcome.pages);
  const limitations = [...extra];
  if (!complete && outcome.served.length) limitations.push('partial');
  if (items.some((item) => item.stale)) limitations.push('stale-cache');
  return { schemaVersion: 1, source, sourceLabel: 'NGA', experimental: false, request, status, complete, requests: outcome.requests, stoppedUntil: outcome.stoppedUntil,
    generatedAt: iso(clock.now()), pages: outcome.pages, items, notice: contentNotice, limitations,
    reliability: { level: 'community-opinion', note: 'NGA posts are personal community experience and opinion; they are not verified by this tool and may be outdated by game updates.' } };
}
function authorLimits(entry: { authorStatus: AuthorStatus; publishedAt: string | null }) {
  return [...(entry.authorStatus === 'anonymous' ? ['anonymous-author'] : entry.authorStatus === 'unknown' ? ['author-unknown'] : []), ...(entry.publishedAt === null ? ['date-unknown'] : [])];
}

/** Read-only NGA search. Titles only: read a thread before citing what it says. */
export async function searchNga(value: NgaSearchRequest, options: NgaOptions): Promise<ResearchResult> {
  const request = searchRequest(value);
  const clock = options.clock ?? systemClock;
  const targets: Target<SearchPage>[] = Array.from({ length: request.pages }, (_, index) => {
    const page = index + 1;
    const params = new URLSearchParams({ key: request.keyword, ...(request.forum === 'arknights' ? { fid: String(arknightsForumId) } : {}), page: String(page), __output: '8' });
    return { label: `search page ${page}`, key: cacheKey({ source, kind: 'search', keyword: request.keyword, forum: request.forum, page }), url: `${ngaOrigin}/thread.php?${params}`,
      ttlMs: ngaLimits.searchTtlMs, valid: validSearchPage, parse: (data) => parseSearch(data, page) };
  });
  const outcome = await run(targets, request, options);
  const items = outcome.served.flatMap(({ value, origin, readAt, stale }) => value.threads.map((thread): ResearchItem => ({
    source, kind: 'thread', title: thread.title, url: `${ngaOrigin}/read.php?tid=${thread.tid}`, location: null, author: thread.author, authorStatus: thread.authorStatus,
    publishedAt: thread.publishedAt, excerpt: '', excerptTruncated: false, reliability: 'community-opinion', limitations: ['title-only', ...authorLimits(thread)],
    origin, readAt, stale, meta: { thread: thread.tid, replies: thread.replies, lastReplyAt: thread.lastReplyAt, page: value.page, totalResults: value.totalResults } })));
  return assemble({ kind: 'search', keyword: request.keyword, forum: request.forum, pages: request.pages }, outcome, items, ['title-only'], clock);
}

/** Read-only NGA thread pages (at most five per run) as citable posts. */
export async function readNgaThread(value: NgaReadRequest, options: NgaOptions): Promise<ResearchResult> {
  const request = readRequest(value);
  const clock = options.clock ?? systemClock;
  const targets: Target<ThreadPage>[] = request.pages.map((page) => ({
    label: `thread ${request.thread} page ${page}`, key: cacheKey({ source, kind: 'thread', thread: request.thread, page }),
    url: `${ngaOrigin}/read.php?${new URLSearchParams({ tid: String(request.thread), page: String(page), __output: '8' })}`,
    ttlMs: ngaLimits.threadTtlMs, valid: validThreadPage, parse: (data) => parseThread(data, request.thread, page) }));
  const outcome = await run(targets, request, options);
  const items = outcome.served.flatMap(({ value, origin, readAt, stale }) => value.posts.map((post): ResearchItem => {
    const truncated = post.textTruncated || [...post.text].length > ngaLimits.excerptChars;
    return { source, kind: 'post', title: value.title, url: `${ngaOrigin}/read.php?tid=${value.tid}&page=${value.page}`, location: { label: 'floor', value: String(post.floor) },
      author: post.author, authorStatus: post.authorStatus, publishedAt: post.publishedAt, excerpt: [...post.text].slice(0, ngaLimits.excerptChars).join(''), excerptTruncated: truncated,
      reliability: 'community-opinion', origin, readAt, stale,
      limitations: [...authorLimits(post), ...(post.timeAssumed ? ['time-assumed-utc8'] : []), ...(post.quotesRemoved ? ['quotes-removed'] : []), ...(truncated ? ['excerpt-truncated'] : [])],
      meta: { thread: value.tid, page: value.page, floor: post.floor, totalPages: value.totalPages } };
  }));
  return assemble({ kind: 'read', thread: request.thread, pages: request.pages }, outcome, items, [], clock);
}

/** Read-only state: whether a risk-control stop is in force, the last request time and the credential state. */
export async function ngaStatus(options: { privateDirectory: string; clock?: Clock }) {
  const clock = options.clock ?? systemClock;
  const privateDirectory = resolve(options.privateDirectory);
  const gate = await readGateState(researchDirectory(privateDirectory, source), clock.now());
  const credential = (await inspectCredentials(privateDirectory, new Date(clock.now()))).credentials.find((item) => item.service === source)?.state ?? 'unknown';
  return { stopped: gate.stopped, stoppedUntil: gate.stopped ? gate.stoppedUntil : null, stopReason: gate.stopped ? gate.stopReason : null, lastRequestAt: gate.lastRequestAt, credential };
}

const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  const action = process.argv[2];
  try {
    if (process.argv.length !== 3 || !['search', 'read', 'status'].includes(action!)) throw invalid();
    let settings;
    try { settings = await readSettings(); } catch { throw new Error('settings-unreadable'); }
    if (action === 'status') console.log(JSON.stringify({ ok: true, status: await ngaStatus({ privateDirectory: settings.privateDirectory }) }));
    else {
      let raw = '';
      for await (const chunk of process.stdin) { raw += String(chunk); if (Buffer.byteLength(raw) > 64 * 1024) throw invalid(); }
      let input: Record<string, unknown> | undefined;
      try { input = object(JSON.parse(raw)); } catch { throw invalid(); }
      if (!input) throw invalid();
      const { format, ...request } = input;
      if (format !== undefined && format !== 'json' && format !== 'markdown') throw invalid();
      const result = action === 'search' ? await searchNga(request as NgaSearchRequest, { privateDirectory: settings.privateDirectory })
        : await readNgaThread(request as NgaReadRequest, { privateDirectory: settings.privateDirectory });
      console.log(format === 'markdown' ? formatResearchMarkdown(result, (settings.language ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en') : JSON.stringify({ ok: true, result }));
      if (result.status !== 'ok') process.exitCode = 1;
    }
  } catch (error) {
    const code = error instanceof Error && ['request-invalid', 'settings-unreadable'].includes(error.message) ? error.message : 'research-failed';
    console.log(JSON.stringify({ ok: false, error: code }));
    process.exitCode = code === 'research-failed' ? 2 : 1;
  }
}
