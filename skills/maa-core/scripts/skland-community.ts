import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './preferences.ts';
import { inspectCredentials } from './credentials.ts';
import type { Protector } from './credential-protection.ts';
import { cacheKey, contentNotice, formatResearchMarkdown, getCached, putCached, readGateState, researchDirectory, systemClock, withResearchGate, type Clock,
  type PageOutcome, type ResearchItem, type ResearchResult } from './research.ts';
import { assembleResult, cacheAnswers, clip, contentShapes, displayName, integer, object, readContents, RunLog, tidy, type Served } from './research-fetch.ts';
import { openSklandSession, sklandMaximumResponseBytes, sklandRequestTimeoutMs, SklandReadFailure, type CredentialReport, type SklandFetch,
  type SklandIssue } from './skland-session.ts';

/**
 * Read-only reader for Skland community posts the user names. Since 2026-11-14 (owner: "its perfectly fine
 * to use it") it reads with the user's own Skland credential through the one shared session in
 * skland-session.ts, signing exactly as the account snapshot reader does. It sends one signed GET of
 * `/web/v2/item` per post, plus the session's own exchange and refresh requests; it does not search, list,
 * post, like, comment, follow or check in, and it writes no account snapshot. Without a usable credential it
 * sends nothing: the anonymous read was shown to always fail, so there is no anonymous fallback.
 */
export const sklandCommunityLimits = {
  // One read (exchange, at most one refresh per level, the post) holds the gate: at most eight requests of 20 s each.
  minIntervalMs: 3_000, riskStopMs: 30 * 60_000, lockStaleMs: 180_000, maxWaitMs: 150_000, timeoutMs: sklandRequestTimeoutMs, maxResponseBytes: sklandMaximumResponseBytes,
  postTtlMs: 24 * 3_600_000, storedChars: 4_000, excerptChars: 600,
} as const;
const source = 'skland-community';
const postPath = '/web/v2/item';
const linkHosts = new Set(['www.skland.com', 'skland.com']);

export type SklandCommunityOptions = { privateDirectory: string; fetcher?: SklandFetch; protector?: Protector; clock?: Clock; now?: () => Date };
export type SklandReadRequest = { post: string | number; fresh?: boolean; cacheOnly?: boolean };
/** The account reader's repair vocabulary. */
export type SklandRepair = 'enter-credential' | 'reenter-credential' | 'use-windows' | 'check-system-time' | 'retry-later' | 'report-issue';
export type SklandCommunityResult = ResearchResult & { credential: CredentialReport; repair: SklandRepair | null };

const invalid = () => new Error('request-invalid');
/** A post id, or a skland.com article link of which only the `id` is used. */
function postId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string' || value.length > 500) throw invalid();
  const text = value.trim();
  if (/^[1-9]\d{0,19}$/.test(text)) return text;
  let url: URL;
  try { url = new URL(text); } catch { throw invalid(); }
  const id = url.searchParams.get('id');
  if (!['https:', 'http:'].includes(url.protocol) || !linkHosts.has(url.hostname) || !/^\/article\/?$/.test(url.pathname) || id === null || !/^[1-9]\d{0,19}$/.test(id)) throw invalid();
  return id;
}
function readRequest(value: unknown) {
  const input = object(value);
  if (!input || Object.keys(input).some((key) => !['post', 'fresh', 'cacheOnly'].includes(key))) throw invalid();
  const post = postId(input.post);
  for (const key of ['fresh', 'cacheOnly']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw invalid();
  if (input.fresh === true && input.cacheOnly === true) throw invalid();
  return { post, fresh: input.fresh === true, cacheOnly: input.cacheOnly === true };
}

// ---- what an answer means: the one classifier of this reader ---------------------------------------

type Seen = { status: number; html: boolean } | undefined;
type Blocked = { outcome: PageOutcome; reason: string };
type ReadOutcome = { data: Record<string, unknown> } | Blocked;
const riskMessage = /频繁|过快|稍后|验证|风控|captcha|too many/i;
/** HTTP-level risk signals of the last response: 412, 429, any 5xx, any redirect, or a web page where data was asked for. */
function httpRisk(seen: Seen): string | undefined {
  if (!seen) return undefined;
  if (seen.status === 412 || seen.status === 429 || seen.status >= 500 || (seen.status >= 300 && seen.status < 400)) return `http-${seen.status}`;
  return seen.html ? 'page-instead-of-data' : undefined;
}
/**
 * A session failure. A risk signal on the response that caused it wins, so a throttled exchange is never read as
 * an expired token. A refused cred issue or another refusal the service does not tie to the credential is also
 * handled as risk control: the run stops and the source pauses instead of retrying.
 */
function failed(issue: SklandIssue, seen: Seen): Blocked {
  const risk = httpRisk(seen);
  if (risk) return { outcome: 'risk-control', reason: risk };
  if (issue === 'credential-rejected') return { outcome: 'credential-rejected', reason: 'credential-expired' };
  if (issue === 'signature-rejected') return { outcome: 'signature-rejected', reason: 'signature-rejected' };
  if (issue === 'network-failed') return { outcome: 'network-failed', reason: 'network-failed' };
  if (issue === 'service-error') return { outcome: 'risk-control', reason: 'service-error' };
  return { outcome: 'incomplete', reason: 'response-invalid' };
}
/** The post reply after the session's own handling of 10000 and 10002. 10003 is an anti-abuse answer the session does not repair. */
function answered(reply: Record<string, unknown>, seen: Seen): ReadOutcome {
  const risk = httpRisk(seen);
  if (risk) return { outcome: 'risk-control', reason: risk };
  const code = integer(reply.code);
  const message = typeof reply.message === 'string' ? reply.message : '';
  if (code === undefined) return { outcome: 'incomplete', reason: 'data-unrecognized' };
  if (code !== 0) {
    if (riskMessage.test(message)) return { outcome: 'risk-control', reason: 'site-message' };
    if (code === 10003) return { outcome: 'risk-control', reason: 'site-code-10003' };
    return { outcome: 'unavailable', reason: `site-code-${Math.abs(code)}` };
  }
  if (seen && seen.status !== 200) return { outcome: 'unavailable', reason: `http-${seen.status}` };
  const data = object(reply.data);
  return data ? { data } : { outcome: 'incomplete', reason: 'data-unrecognized' };
}
const repairs: Partial<Record<PageOutcome, SklandRepair>> = { 'credential-required': 'enter-credential', 'credential-unreadable': 'reenter-credential',
  'credential-rejected': 'reenter-credential', 'signature-rejected': 'check-system-time', 'risk-control': 'retry-later', 'risk-stopped': 'retry-later',
  'busy': 'retry-later', 'network-failed': 'retry-later', 'incomplete': 'report-issue' };

// ---- post content --------------------------------------------------------------------------------

type StoredPost = { id: string; title: string | null; author: string | null; publishedAt: string | null; text: string; textTruncated: boolean };
const sliceRow = (value: unknown) => { const text = object(value)?.c; return typeof text === 'string' ? text : undefined; };
/**
 * Every content field this reader takes from a post answer, with its shape. Fields are read only through
 * `readContents`, so an unrecognised one makes the answer incomplete instead of an empty read.
 * tests/community-content.test.ts enumerates exactly these.
 */
export const sklandCommunityContent = {
  post: { title: { path: ['item', 'title'], shape: contentShapes.text }, author: { path: ['user'], shape: contentShapes.named('nickname') },
    published: { path: ['item', 'publishedAtTs'], shape: contentShapes.seconds }, text: { path: ['item', 'textSlice'], shape: contentShapes.list(sliceRow) } },
};
/** Title, author nickname, publish time and the text fragments of the post; never the author's account id or other blocks. */
function parsePost(data: Record<string, unknown>, id: string): StoredPost | undefined {
  const item = object(data.item);
  const itemId = typeof item?.id === 'string' || typeof item?.id === 'number' ? String(item.id) : undefined;
  if (!item || itemId !== id) return undefined;
  const content = readContents(data, sklandCommunityContent.post);
  if (!content) return undefined;
  const text = clip(tidy((content.text ?? []).join('\n')), sklandCommunityLimits.storedChars);
  return { id, title: displayName(content.title), author: displayName(content.author), publishedAt: content.published, text: text.text, textTruncated: text.truncated };
}
const isText = (value: unknown) => value === null || typeof value === 'string';
function validPost(value: unknown): value is StoredPost {
  const post = object(value);
  return !!post && typeof post.id === 'string' && isText(post.title) && isText(post.author) && isText(post.publishedAt) && typeof post.text === 'string' && typeof post.textTruncated === 'boolean';
}

// ---- one read ------------------------------------------------------------------------------------

type Watch = { requests: number; seen: Seen };
/**
 * Counts the requests the session sends and keeps the status and type of the last answer; it reads no body and no other
 * header. It asks for `redirect: 'manual'` instead of the session's `error`: Node's fetch then returns the 3xx itself, so
 * a redirect (often a captcha or login page) is classified as risk control and pauses the source, instead of ending as a
 * network failure that a retry a few seconds later would repeat with the user's token. A redirect is never followed.
 */
function observed(fetcher: SklandFetch, watch: Watch): SklandFetch {
  return async (url, init) => {
    watch.seen = undefined;
    watch.requests += 1;
    const response = await fetcher(url, { ...init, redirect: 'manual' });
    watch.seen = { status: response.status, html: /text\/html/i.test(response.headers.get('content-type') ?? '') };
    return response;
  };
}
type SignedRead = { requests: number; credential: CredentialReport; stoppedUntil: string | null } & ({ post: StoredPost; at: number } | { blocked: Blocked });
/**
 * The network part of one read. A source pause or an unset or unreadable credential sends nothing (there is no
 * anonymous attempt). Otherwise the whole session (exchange, at most one refresh per level, the post) runs in
 * one hold of the source's gate, so the classification and a risk stop are recorded together for every process.
 */
async function signedRead(post: string, options: SklandCommunityOptions & { directory: string; clock: Clock }): Promise<SignedRead> {
  const { directory, clock } = options;
  const gate = await readGateState(directory, clock.now());
  if (gate.stopped) return { requests: 0, credential: 'unchanged', stoppedUntil: gate.stoppedUntil, blocked: { outcome: 'risk-stopped', reason: gate.stopReason ?? 'stopped' } };
  const watch: Watch = { requests: 0, seen: undefined };
  const opened = await openSklandSession({ privateDirectory: options.privateDirectory, fetcher: observed(options.fetcher ?? ((url, init) => fetch(url, init)), watch),
    ...(options.protector ? { protector: options.protector } : {}), ...(options.now ? { now: options.now } : {}) });
  if (opened.status !== 'ready') {
    return { requests: 0, credential: opened.credential, stoppedUntil: null,
      blocked: opened.status === 'credential-unset' ? { outcome: 'credential-required', reason: 'credential-unset' } : { outcome: 'credential-unreadable', reason: opened.status } };
  }
  const { session, credential } = opened;
  let decision;
  try {
    decision = await withResearchGate(directory, { minIntervalMs: sklandCommunityLimits.minIntervalMs, stopMs: sklandCommunityLimits.riskStopMs,
      lockStaleMs: sklandCommunityLimits.lockStaleMs, maxWaitMs: sklandCommunityLimits.maxWaitMs }, clock, async () => {
      const at = clock.now();
      let outcome: ReadOutcome;
      try {
        await session.start();
        const reply = await session.reply(postPath, new URLSearchParams({ id: post }).toString());
        outcome = answered(reply, watch.seen);
        if (reply.code === 0 && !httpRisk(watch.seen)) await credential.record('usable');
      } catch (error) {
        const blocked = failed(error instanceof SklandReadFailure ? error.issue : 'response-invalid', watch.seen);
        if (blocked.outcome === 'credential-rejected') await credential.record('expired');
        outcome = blocked;
      }
      return { value: { outcome, at }, ...('outcome' in outcome && outcome.outcome === 'risk-control' ? { stop: 'risk-control' } : {}) };
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'research-busy') throw error;
    return { requests: watch.requests, credential: credential.report, stoppedUntil: null, blocked: { outcome: 'busy', reason: 'research-busy' } };
  }
  const done = { requests: watch.requests, credential: credential.report };
  if (!decision.performed) return { ...done, stoppedUntil: decision.stoppedUntil, blocked: { outcome: 'risk-stopped', reason: decision.reason } };
  const { outcome, at } = decision.value;
  if ('data' in outcome) {
    const parsed = parsePost(outcome.data, post);
    return parsed ? { ...done, stoppedUntil: null, post: parsed, at } : { ...done, stoppedUntil: null, blocked: { outcome: 'incomplete', reason: 'data-unrecognized' } };
  }
  return { ...done, stoppedUntil: outcome.outcome === 'risk-control' ? (await readGateState(directory, clock.now())).stoppedUntil : null, blocked: outcome };
}

/** Reads one post the user named. A cache entry that answers the request is served without reading the credential or sending anything. */
export async function readSklandPost(value: SklandReadRequest, options: SklandCommunityOptions): Promise<SklandCommunityResult> {
  const request = readRequest(value);
  const clock = options.clock ?? systemClock;
  const privateDirectory = resolve(options.privateDirectory);
  const directory = researchDirectory(privateDirectory, source);
  const log = new RunLog();
  const target = `post ${request.post}`;
  const key = cacheKey({ source, kind: 'post', post: request.post });
  const cached = await getCached(directory, key, clock.now(), validPost);
  let credential: CredentialReport = 'unchanged';
  let blocked: Blocked | undefined;
  let post: Served<StoredPost> | undefined;
  if (cacheAnswers(cached, request)) post = log.offer(target, 'cached', cached);
  else if (request.cacheOnly) post = log.offer(target, 'not-cached', cached);
  else {
    const read = await signedRead(request.post, { ...options, privateDirectory, directory, clock });
    log.requests += read.requests; log.stoppedUntil = read.stoppedUntil; credential = read.credential;
    if ('post' in read) {
      await putCached(directory, key, read.post, sklandCommunityLimits.postTtlMs, read.at);
      post = log.fresh(target, read.post, read.at);
    } else {
      blocked = read.blocked;
      post = log.offer(target, blocked.outcome, cached, blocked.reason);
    }
  }
  const items: ResearchItem[] = [];
  if (post) {
    const p = post.value;
    const excerpt = clip(p.text, sklandCommunityLimits.excerptChars);
    const truncated = excerpt.truncated || p.textTruncated;
    items.push({ source, kind: 'post', title: p.title, url: `https://www.skland.com/article?id=${p.id}`, location: null, author: p.author, authorStatus: p.author === null ? 'unknown' : 'known',
      publishedAt: p.publishedAt, excerpt: excerpt.text, excerptTruncated: truncated, reliability: 'community-opinion',
      limitations: [...(p.author === null ? ['author-unknown'] : []), ...(p.publishedAt === null ? ['date-unknown'] : []), ...(truncated ? ['excerpt-truncated'] : []), 'text-order-approximate'],
      origin: post.origin, readAt: post.readAt, stale: post.stale, meta: { post: p.id } });
  }
  const result = assembleResult({ source, sourceLabel: '森空岛社区 / Skland community', experimental: false, log, items, clock, request: { kind: 'post', post: request.post },
    limitations: [], reliabilityNote: 'Skland community posts are personal player experience and opinion; they are not verified by this tool and may be outdated by game updates.', notice: contentNotice });
  const repair = !blocked ? null : blocked.reason === 'windows-required' ? 'use-windows' : blocked.reason === 'protection-failed' ? 'retry-later' : repairs[blocked.outcome] ?? null;
  return { ...result, credential, repair };
}

/** Read-only state: whether a risk-control stop is in force, the last request time and the Skland credential state (shared with the account reader). */
export async function sklandCommunityStatus(options: { privateDirectory: string; clock?: Clock }) {
  const clock = options.clock ?? systemClock;
  const privateDirectory = resolve(options.privateDirectory);
  const gate = await readGateState(researchDirectory(privateDirectory, source), clock.now());
  const credential = (await inspectCredentials(privateDirectory, new Date(clock.now()))).credentials.find((item) => item.service === 'skland')?.state ?? 'unknown';
  return { stopped: gate.stopped, stoppedUntil: gate.stopped ? gate.stoppedUntil : null, stopReason: gate.stopped ? gate.stopReason : null, lastRequestAt: gate.lastRequestAt, credential };
}

const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  const action = process.argv[2];
  try {
    if (process.argv.length !== 3 || !['read', 'status'].includes(action!)) throw invalid();
    let settings;
    try { settings = await readSettings(); } catch { throw new Error('settings-unreadable'); }
    if (action === 'status') console.log(JSON.stringify({ ok: true, status: await sklandCommunityStatus({ privateDirectory: settings.privateDirectory }) }));
    else {
      let raw = '';
      for await (const chunk of process.stdin) { raw += String(chunk); if (Buffer.byteLength(raw) > 64 * 1024) throw invalid(); }
      let input: Record<string, unknown> | undefined;
      try { input = object(JSON.parse(raw)); } catch { throw invalid(); }
      if (!input) throw invalid();
      const { format, ...request } = input;
      if (format !== undefined && format !== 'json' && format !== 'markdown') throw invalid();
      const result = await readSklandPost(request as SklandReadRequest, { privateDirectory: settings.privateDirectory });
      console.log(format === 'markdown' ? formatResearchMarkdown(result, (settings.language ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en') : JSON.stringify({ ok: true, result }));
      if (result.status !== 'ok') process.exitCode = 1;
    }
  } catch (error) {
    const code = error instanceof Error && ['request-invalid', 'settings-unreadable'].includes(error.message) ? error.message : 'research-failed';
    console.log(JSON.stringify({ ok: false, error: code }));
    process.exitCode = code === 'research-failed' ? 2 : 1;
  }
}
