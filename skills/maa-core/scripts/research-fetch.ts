import { platformTransport, type ResearchTransport, type TransportRequest, type TransportResponse } from './research-transport.ts';
import { plainText, readGateState, summarizePages, withResearchGate, type Clock, type PageOutcome, type ResearchItem, type ResearchPage,
  type ResearchResult } from './research.ts';

/**
 * Request steps shared by the community readers that came after NGA (Skland community, experimental
 * Bilibili): one gated GET through the shared cross-process gate, one way to read a JSON body, the
 * HTTP-level risk signals, cache offers and result assembly. Each reader keeps its own classifier for
 * the site's own envelope; the gate, cache and Markdown stay in research.ts.
 */
export const researchUserAgent = 'maa-skills-research (read-only; +https://github.com/VincentChen0111/maa_skills)';
export type SourceLimits = { minIntervalMs: number; riskStopMs: number; lockStaleMs: number; maxWaitMs: number; timeoutMs: number; maxResponseBytes: number };
export type Classified<T> = { kind: 'data'; data: T } | { kind: 'credential-rejected'; reason: string } | { kind: 'risk-control'; reason: string }
  | { kind: 'unavailable'; reason: string } | { kind: 'incomplete'; reason: string } | { kind: 'network-failed'; reason: string };
export type Attempt<T> = { kind: 'stopped'; stoppedUntil: string } | { kind: 'busy' }
  | { kind: 'answered'; classified: Classified<T>; at: number; stoppedUntil: string | null };
export type SourceContext = { directory: string; limits: SourceLimits; clock: Clock; transport: ResearchTransport };

export const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const integer = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && /^-?\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : undefined;
};

/** A JSON object from the body, or undefined when the body is not one. Invalid UTF-8 is replaced, never guessed. */
export function decodeJson(body: Buffer): { text: string; value: Record<string, unknown> | undefined; isJson: boolean } {
  // The decoder drops a leading byte order mark by itself.
  const text = new TextDecoder('utf-8').decode(body).trim();
  if (!text.startsWith('{')) return { text, value: undefined, isJson: false };
  try { return { text, value: object(JSON.parse(text)), isJson: true }; } catch { return { text, value: undefined, isJson: true }; }
}

/**
 * HTTP-level meaning shared by every community source: 412, 429, 503 and any redirect are risk control;
 * a page where data was asked for is risk control; 404/410 are unavailable; other 5xx are network
 * failures. Undefined means the body is JSON and the source's own envelope decides.
 */
export function httpSignal(response: TransportResponse): Classified<never> | undefined {
  const { status } = response;
  if (status === 412 || status === 429 || status === 503 || (status >= 300 && status < 400)) return { kind: 'risk-control', reason: `http-${status}` };
  const body = decodeJson(response.body);
  if (!body.isJson) {
    if (status === 404 || status === 410) return { kind: 'unavailable', reason: `http-${status}` };
    if (status >= 500) return { kind: 'network-failed', reason: `http-${status}` };
    if (status < 300 || status === 401 || status === 403) return { kind: 'risk-control', reason: status < 300 ? 'page-instead-of-data' : `http-${status}` };
    return { kind: 'unavailable', reason: `http-${status}` };
  }
  if (!body.value) return status >= 500 ? { kind: 'network-failed', reason: `http-${status}` } : { kind: 'incomplete', reason: 'data-unreadable' };
  return undefined;
}

/** One GET under the source's shared gate. A risk-control answer records the stop for every process and transport. */
export async function gatedGet<T>(context: SourceContext, request: TransportRequest, classify: (response: TransportResponse) => Classified<T>): Promise<Attempt<T>> {
  const { directory, limits, clock, transport } = context;
  let decision;
  try {
    decision = await withResearchGate(directory, { minIntervalMs: limits.minIntervalMs, stopMs: limits.riskStopMs, lockStaleMs: limits.lockStaleMs, maxWaitMs: limits.maxWaitMs }, clock, async () => {
      const at = clock.now();
      let classified: Classified<T>;
      try { classified = classify(await transport.get(request, { timeoutMs: limits.timeoutMs, maxBytes: limits.maxResponseBytes })); }
      catch (error) { classified = { kind: 'network-failed', reason: error instanceof Error && /^transport-[a-z-]+$/.test(error.message) ? error.message : 'transport-failed' }; }
      return { value: { classified, at }, ...(classified.kind === 'risk-control' ? { stop: 'risk-control' } : {}) };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'research-busy') return { kind: 'busy' };
    throw error;
  }
  if (!decision.performed) return { kind: 'stopped', stoppedUntil: decision.stoppedUntil };
  const { classified, at } = decision.value;
  const stoppedUntil = classified.kind === 'risk-control' ? (await readGateState(directory, clock.now())).stoppedUntil : null;
  return { kind: 'answered', classified, at, stoppedUntil };
}

export function defaultTransport(transport?: ResearchTransport): ResearchTransport { return transport ?? platformTransport(); }

export type CacheRead<T> = { state: 'missing' } | { state: 'fresh' | 'stale'; value: T; storedAt: string };
export type Served<T> = { value: T; origin: 'network' | 'cache'; readAt: string; stale: boolean };
/** Pages of one run, in order; a blocked page still offers an older cache entry, marked as such. */
export class RunLog {
  pages: ResearchPage[] = [];
  requests = 0;
  stoppedUntil: string | null = null;
  served = 0;
  fresh<T>(target: string, value: T, at: number): Served<T> {
    const readAt = new Date(at).toISOString();
    this.pages.push({ target, outcome: 'fresh', served: 'network', readAt });
    this.served += 1;
    return { value, origin: 'network', readAt, stale: false };
  }
  /** A cache entry used instead of a request: outcome `cached`, or the reason the request was not made or failed. */
  offer<T>(target: string, outcome: PageOutcome, cached: CacheRead<T>, reason?: string): Served<T> | undefined {
    if (cached.state === 'missing') { this.pages.push({ target, outcome, served: 'none', readAt: null, ...(reason ? { reason } : {}) }); return undefined; }
    this.pages.push({ target, outcome, served: cached.state === 'stale' ? 'stale-cache' : 'cache', readAt: cached.storedAt, ...(reason ? { reason } : {}) });
    this.served += 1;
    return { value: cached.value, origin: 'cache', readAt: cached.storedAt, stale: cached.state === 'stale' };
  }
}
/** Whether a cache entry answers the request without the network: always under cacheOnly, otherwise only when fresh and not asked to refresh. */
export function cacheAnswers<T>(cached: CacheRead<T>, flags: { fresh: boolean; cacheOnly: boolean }): boolean {
  return cached.state !== 'missing' && (flags.cacheOnly || (cached.state === 'fresh' && !flags.fresh));
}
/** Outcomes after which the rest of the run sends nothing. */
export const haltingOutcomes: PageOutcome[] = ['risk-control', 'risk-stopped', 'busy', 'network-failed'];


/** Collapses an attempt that did not return data into the page outcome it means. */
export function blockedOutcome(attempt: Attempt<unknown>): { outcome: PageOutcome; reason?: string } | undefined {
  if (attempt.kind === 'stopped') return { outcome: 'risk-stopped' };
  if (attempt.kind === 'busy') return { outcome: 'busy' };
  const { classified } = attempt;
  if (classified.kind === 'data') return undefined;
  return { outcome: classified.kind, reason: classified.kind === 'credential-rejected' ? undefined : classified.reason };
}

const pad = (value: number) => String(value).padStart(2, '0');
/** Both sites show China Standard Time; a Unix timestamp in seconds is rendered with the +08:00 offset. */
export function chinaTime(seconds: unknown): string | null {
  const value = integer(seconds);
  if (value === undefined || value < 1_000_000_000 || value > 9_999_999_999) return null;
  const shifted = new Date(value * 1000 + 8 * 3_600_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`;
}

// ---- fetched content: the one rule for "present but unrecognised" ---------------------------------

/** How one content field looks: the site's own way of saying "none", and how the known shape is read. */
export type ContentShape<T> = { empty: (value: unknown) => boolean; read: (value: unknown) => T | undefined };
export type ContentField<T> = { path: readonly string[]; shape: ContentShape<T> };
type ShapeValue<S> = S extends ContentShape<infer T> ? T : never;

/**
 * The single owner of "content present but unrecognised" for the readers after NGA. A field is read only
 * through its declared shape: the site's explicit "none" (per shape: an empty string, an empty list,
 * null, a zero time) is an honest empty result (`null`); the known shape is read; anything else — the
 * field missing, renamed, of another type, or a list none of whose entries has the known shape — makes
 * the whole answer unrecognised, and the caller reports `incomplete` / `data-unrecognized` and caches
 * nothing. Every content field each reader takes is declared in one table that
 * tests/community-content.test.ts enumerates.
 */
export function readContents<F extends Record<string, ContentField<unknown>>>(root: unknown, fields: F): { [K in keyof F]: ShapeValue<F[K]['shape']> | null } | undefined {
  const values: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const value = field.path.reduce<unknown>((node, key) => object(node)?.[key], root);
    if (field.shape.empty(value)) { values[name] = null; continue; }
    const read = field.shape.read(value);
    if (read === undefined) return undefined;
    values[name] = read;
  }
  return values as { [K in keyof F]: ShapeValue<F[K]['shape']> | null };
}
/** The shapes the community readers use; a new kind of field gets a shape here, not a check in a reader. */
export const contentShapes = {
  /** A string; an empty string or null is "none". */
  text: { empty: (value) => value === '' || value === null, read: (value) => typeof value === 'string' ? value : undefined } as ContentShape<string>,
  /** Unix seconds; 0 or null is "no time". Milliseconds, text and other numbers are not recognised. */
  seconds: { empty: (value) => value === null || integer(value) === 0, read: (value) => chinaTime(value) ?? undefined } as ContentShape<string>,
  /** An object carrying a display name under `key`; null is "no such person". */
  named: (key: string): ContentShape<string> => ({ empty: (value) => value === null,
    read: (value) => { const name = object(value)?.[key]; return typeof name === 'string' ? name : undefined; } }),
  /** A non-negative integer count or id; 0 is "none". Only whether it is positive is kept. */
  positiveFlag: { empty: (value) => integer(value) === 0, read: (value) => { const number = integer(value); return number !== undefined && number > 0 ? true : undefined; } } as ContentShape<true>,
  /** A list; [] is "none"; a non-empty list must have at least one entry in the known row shape, and only those are kept. */
  list: <T>(row: (value: unknown) => T | undefined): ContentShape<T[]> => ({ empty: (value) => Array.isArray(value) && value.length === 0,
    read: (value) => {
      if (!Array.isArray(value)) return undefined;
      const rows = value.flatMap((item) => { const read = row(item); return read === undefined ? [] : [read]; });
      return rows.length ? rows : undefined;
    } }),
};

/** Plain text with whitespace runs collapsed and blank-line runs limited; hidden and direction characters removed. */
export const tidy = (text: string) => plainText(text).replace(/[ \t\f\v 　]+/g, ' ').split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
/** A display name: one line, at most 80 characters, or null. */
export function displayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = tidy(value).replace(/\n/g, ' ');
  return text ? [...text].slice(0, 80).join('') : null;
}
/** Text cut to a number of characters (code points), with a flag when it was cut. */
export function clip(text: string, chars: number): { text: string; truncated: boolean } {
  const points = [...text];
  return points.length > chars ? { text: points.slice(0, chars).join(''), truncated: true } : { text, truncated: false };
}

export function assembleResult(options: { source: string; sourceLabel: string; experimental: boolean; request: Record<string, unknown>; log: RunLog; items: ResearchItem[];
  limitations: string[]; reliabilityNote: string; notice: string; clock: Clock }): ResearchResult {
  const { status, complete } = summarizePages(options.log.pages);
  const limitations = [...options.limitations];
  if (!complete && options.log.served > 0) limitations.push('partial');
  if (options.items.some((item) => item.stale)) limitations.push('stale-cache');
  return { schemaVersion: 1, source: options.source, sourceLabel: options.sourceLabel, experimental: options.experimental, request: options.request, status, complete,
    requests: options.log.requests, stoppedUntil: options.log.stoppedUntil, generatedAt: new Date(options.clock.now()).toISOString(), pages: options.log.pages, items: options.items,
    reliability: { level: 'community-opinion', note: options.reliabilityNote }, limitations: [...new Set(limitations)], notice: options.notice };
}
