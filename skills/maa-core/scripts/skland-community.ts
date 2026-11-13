import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './preferences.ts';
import type { ResearchTransport, TransportResponse } from './research-transport.ts';
import { cacheKey, contentNotice, formatResearchMarkdown, getCached, putCached, readGateState, researchDirectory, systemClock, type Clock, type PageOutcome,
  type ResearchItem, type ResearchResult } from './research.ts';
import { assembleResult, blockedOutcome, cacheAnswers, clip, contentShapes, decodeJson, defaultTransport, displayName, gatedGet, httpSignal, integer, object,
  readContents, researchUserAgent, RunLog, tidy, type Classified, type Served, type SourceContext } from './research-fetch.ts';

/**
 * Read-only reader for public Skland community posts. It is separate from the Skland account snapshot
 * on purpose: it never imports the credential store, never sends the account token, a cookie or any
 * login state, and never imitates the official client's request signature or device id. It sends one
 * anonymous GET for one post the user named; it does not search, post, like or comment.
 */
export const sklandCommunityLimits = {
  minIntervalMs: 3_000, riskStopMs: 30 * 60_000, lockStaleMs: 120_000, maxWaitMs: 150_000, timeoutMs: 20_000, maxResponseBytes: 4 * 1024 * 1024,
  postTtlMs: 24 * 3_600_000, storedChars: 4_000, excerptChars: 600,
} as const;
export const sklandApiOrigin = 'https://zonai.skland.com';
const source = 'skland-community';
const linkHosts = new Set(['www.skland.com', 'skland.com']);

export type SklandCommunityOptions = { privateDirectory: string; transport?: ResearchTransport; clock?: Clock };
export type SklandReadRequest = { post: string | number; fresh?: boolean; cacheOnly?: boolean };

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

/** Codes the official web client answers by refreshing its signing token (seen in its public bundle, 2026-11-13). */
const signatureCodes = new Set([10000, 10002, 10003]);
/**
 * The one place that decides what a Skland answer means. A demand for the official client's signature
 * (HTTP 401, or one of the codes above) is the site's anti-abuse layer refusing an anonymous reader: it
 * is risk control, so the run stops and the source pauses rather than retrying or imitating the client.
 */
function classify(response: TransportResponse): Classified<Record<string, unknown>> {
  const signal = httpSignal(response);
  if (signal) return signal;
  const value = decodeJson(response.body).value!;
  const code = integer(value.code);
  const message = typeof value.message === 'string' ? value.message : '';
  if (response.status === 401 || (code !== undefined && signatureCodes.has(code))) return { kind: 'risk-control', reason: 'signature-required' };
  if (code === undefined) return response.status >= 500 ? { kind: 'network-failed', reason: `http-${response.status}` } : { kind: 'incomplete', reason: 'data-unrecognized' };
  if (code !== 0) {
    if (/频繁|过快|稍后|验证|风控|captcha|too many/i.test(message)) return { kind: 'risk-control', reason: 'site-message' };
    if (response.status >= 500) return { kind: 'network-failed', reason: `http-${response.status}` };
    return { kind: 'unavailable', reason: `site-code-${Math.abs(code)}` };
  }
  if (response.status >= 500) return { kind: 'network-failed', reason: `http-${response.status}` };
  if (response.status !== 200) return { kind: 'unavailable', reason: `http-${response.status}` };
  const data = object(value.data);
  return data ? { kind: 'data', data } : { kind: 'incomplete', reason: 'data-unrecognized' };
}

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

/** Reads one public post the user named: at most one request per run. */
export async function readSklandPost(value: SklandReadRequest, options: SklandCommunityOptions): Promise<ResearchResult> {
  const request = readRequest(value);
  const clock = options.clock ?? systemClock;
  const context: SourceContext = { directory: researchDirectory(resolve(options.privateDirectory), source), limits: sklandCommunityLimits, clock, transport: defaultTransport(options.transport) };
  const log = new RunLog();
  const target = `post ${request.post}`;
  const key = cacheKey({ source, kind: 'post', post: request.post });
  const cached = await getCached(context.directory, key, clock.now(), validPost);
  let post: Served<StoredPost> | undefined;
  if (cacheAnswers(cached, request)) post = log.offer(target, 'cached', cached);
  else if (request.cacheOnly) post = log.offer(target, 'not-cached', cached);
  else {
    // Only an honest, anonymous request: no Cookie, credential, signature, platform, timestamp or device id header.
    const attempt = await gatedGet(context, { url: `${sklandApiOrigin}/web/v2/item?${new URLSearchParams({ id: request.post })}`,
      headers: { 'User-Agent': researchUserAgent, 'Accept': 'application/json' } }, classify);
    if (attempt.kind === 'answered') log.requests += 1;
    if (attempt.kind === 'stopped') log.stoppedUntil = attempt.stoppedUntil;
    if (attempt.kind === 'answered' && attempt.stoppedUntil) log.stoppedUntil = attempt.stoppedUntil;
    const parsed = attempt.kind === 'answered' && attempt.classified.kind === 'data' ? parsePost(attempt.classified.data, request.post) : undefined;
    if (parsed && attempt.kind === 'answered') {
      await putCached(context.directory, key, parsed, sklandCommunityLimits.postTtlMs, attempt.at);
      post = log.fresh(target, parsed, attempt.at);
    } else {
      const blocked = blockedOutcome(attempt) ?? { outcome: 'incomplete' as PageOutcome, reason: 'data-unrecognized' };
      post = log.offer(target, blocked.outcome === 'credential-rejected' ? 'unavailable' : blocked.outcome, cached, blocked.reason);
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
  return assembleResult({ source, sourceLabel: '森空岛社区 / Skland community', experimental: false, log, items, clock, request: { kind: 'post', post: request.post },
    limitations: log.pages.some((page) => page.reason === 'signature-required') ? ['client-signature-required'] : [],
    reliabilityNote: 'Skland community posts are personal player experience and opinion; they are not verified by this tool and may be outdated by game updates.', notice: contentNotice });
}

/** Read-only state: whether a risk-control stop is in force and the last request time. This reader has no credential. */
export async function sklandCommunityStatus(options: { privateDirectory: string; clock?: Clock }) {
  const clock = options.clock ?? systemClock;
  const gate = await readGateState(researchDirectory(resolve(options.privateDirectory), source), clock.now());
  return { stopped: gate.stopped, stoppedUntil: gate.stopped ? gate.stoppedUntil : null, stopReason: gate.stopped ? gate.stopReason : null, lastRequestAt: gate.lastRequestAt };
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
