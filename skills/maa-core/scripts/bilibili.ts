import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialError, inspectCredentials, readCredential, recordCredentialOutcome } from './credentials.ts';
import type { Protector } from './credential-protection.ts';
import { readSettings } from './preferences.ts';
import type { ResearchTransport, TransportResponse } from './research-transport.ts';
import { cacheKey, contentNotice, formatResearchMarkdown, getCached, putCached, readGateState, researchDirectory, systemClock, type Clock, type PageOutcome,
  type ResearchItem, type ResearchResult } from './research.ts';
import { assembleResult, blockedOutcome, cacheAnswers, chinaTime, clip, decodeJson, defaultTransport, displayName, gatedGet, haltingOutcomes, httpSignal, integer,
  object, researchUserAgent, RunLog, tidy, type Attempt, type Classified, type Served, type SourceContext } from './research-fetch.ts';

/**
 * Experimental, read-only Bilibili reader: the public information of one user-named video and, when the
 * user has entered their own SESSDATA, its subtitles. It sends only GETs, never searches (search needs a
 * request signature and a browser device cookie that this tool does not imitate), never signs in, posts,
 * likes or comments. The SESSDATA value is used in memory for the player request only.
 */
export const bilibiliLimits = {
  minIntervalMs: 3_000, riskStopMs: 30 * 60_000, lockStaleMs: 120_000, maxWaitMs: 150_000, timeoutMs: 20_000, maxResponseBytes: 4 * 1024 * 1024,
  videoTtlMs: 24 * 3_600_000, subtitleTtlMs: 24 * 3_600_000, maxPart: 1_000, storedDescriptionChars: 4_000, storedSubtitleChars: 8_000, excerptChars: 600,
} as const;
export const bilibiliApiOrigin = 'https://api.bilibili.com';
export const experimentalNotice = 'Bilibili support is experimental: it may stop working at any time; do not rely on it.';
const source = 'bilibili';
const videoHosts = new Set(['www.bilibili.com', 'bilibili.com', 'm.bilibili.com']);
/** Subtitle files are fetched only from these Bilibili file hosts, and only from the address the player answer names. */
const subtitleHosts = new Set(['aisubtitle.hdslb.com', 'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com']);
const bvPattern = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;

export type BilibiliOptions = { privateDirectory: string; transport?: ResearchTransport; protector?: Protector; clock?: Clock };
export type BilibiliReadRequest = { video: string; part?: number; subtitles?: boolean; fresh?: boolean; cacheOnly?: boolean };
type VideoId = { kind: 'bvid'; value: string } | { kind: 'aid'; value: number };

const invalid = () => new Error('request-invalid');
function videoId(text: string): VideoId | undefined {
  if (bvPattern.test(text)) return { kind: 'bvid', value: text };
  const av = /^av(\d{1,16})$/i.exec(text);
  const aid = av ? Number(av[1]) : Number.NaN;
  return Number.isSafeInteger(aid) && aid > 0 ? { kind: 'aid', value: aid } : undefined;
}
/** A video id, or a bilibili.com video link of which only the id and the `p` part number are used. Short links need a redirect and are refused. */
function parseVideo(value: unknown): { id: VideoId; linkPart?: number } {
  if (typeof value !== 'string' || value.length > 500) throw invalid();
  const text = value.trim();
  const direct = videoId(text);
  if (direct) return { id: direct };
  let url: URL;
  try { url = new URL(text); } catch { throw invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || !videoHosts.has(url.hostname)) throw invalid();
  const match = /^\/video\/([A-Za-z0-9]{1,20})\/?$/.exec(url.pathname);
  const id = match ? videoId(match[1]!) : undefined;
  if (!id) throw invalid();
  const p = url.searchParams.get('p');
  if (p === null) return { id };
  if (!/^\d{1,4}$/.test(p)) throw invalid();
  return { id, linkPart: Number(p) };
}
function readRequest(value: unknown) {
  const input = object(value);
  if (!input || Object.keys(input).some((key) => !['video', 'part', 'subtitles', 'fresh', 'cacheOnly'].includes(key))) throw invalid();
  const { id, linkPart } = parseVideo(input.video);
  for (const key of ['subtitles', 'fresh', 'cacheOnly']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw invalid();
  if (input.fresh === true && input.cacheOnly === true) throw invalid();
  const part = input.part ?? linkPart ?? 1;
  if (typeof part !== 'number' || !Number.isInteger(part) || part < 1 || part > bilibiliLimits.maxPart) throw invalid();
  return { id, part, subtitles: input.subtitles !== false, fresh: input.fresh === true, cacheOnly: input.cacheOnly === true };
}

// ---- classification: the one place that decides what a Bilibili answer means ----------------------

/** Documented codes: -412 request intercepted, -352 risk check failed, -509 over limit, -799 too frequent, -503 overload protection. */
const riskCodes = new Set([-412, -352, -509, -799, -503]);
function classifyApi(response: TransportResponse): Classified<Record<string, unknown>> {
  const signal = httpSignal(response);
  if (signal) return signal;
  const value = decodeJson(response.body).value!;
  const code = integer(value.code);
  const message = typeof value.message === 'string' ? value.message : '';
  if (code === undefined) return response.status >= 500 ? { kind: 'network-failed', reason: `http-${response.status}` } : { kind: 'incomplete', reason: 'data-unrecognized' };
  if (code !== 0) {
    if (riskCodes.has(code) || /频繁|风控|拦截|稍后|验证|captcha|too many/i.test(message)) return { kind: 'risk-control', reason: `site-code-${Math.abs(code)}` };
    if (code === -101) return { kind: 'credential-rejected', reason: 'not-signed-in' };
    if (code === -500) return { kind: 'network-failed', reason: 'site-error' };
    return { kind: 'unavailable', reason: `site-code-${Math.abs(code)}` };
  }
  if (response.status >= 500) return { kind: 'network-failed', reason: `http-${response.status}` };
  if (response.status !== 200) return { kind: 'unavailable', reason: `http-${response.status}` };
  const data = object(value.data);
  return data ? { kind: 'data', data } : { kind: 'incomplete', reason: 'data-unrecognized' };
}
function classifyFile(response: TransportResponse): Classified<Record<string, unknown>> {
  const signal = httpSignal(response);
  if (signal) return signal;
  if (response.status >= 500) return { kind: 'network-failed', reason: `http-${response.status}` };
  if (response.status !== 200) return { kind: 'unavailable', reason: `http-${response.status}` };
  const value = decodeJson(response.body).value!;
  return Array.isArray(value.body) ? { kind: 'data', data: value } : { kind: 'incomplete', reason: 'data-unrecognized' };
}

// ---- parsing into whitelisted, cacheable values -----------------------------------------------------

type StoredVideo = { bvid: string; aid: number; title: string | null; author: string | null; publishedAt: string | null; description: string; descriptionTruncated: boolean;
  durationSeconds: number | null; parts: { page: number; cid: number }[] };
type StoredSubtitle = { bvid: string; part: number; language: string; machine: boolean; lines: { from: number; text: string }[]; truncated: boolean };

function parseVideoData(data: Record<string, unknown>, id: VideoId): StoredVideo | undefined {
  const bvid = typeof data.bvid === 'string' && bvPattern.test(data.bvid) ? data.bvid : undefined;
  const aid = integer(data.aid);
  if (!bvid || aid === undefined || aid <= 0 || (id.kind === 'bvid' ? bvid !== id.value : aid !== id.value)) return undefined;
  const parts = (Array.isArray(data.pages) ? data.pages : []).map(object).flatMap((row) => {
    const page = integer(row?.page), cid = integer(row?.cid);
    return page !== undefined && page >= 1 && page <= bilibiliLimits.maxPart && cid !== undefined && cid > 0 ? [{ page, cid }] : [];
  });
  const description = clip(tidy(typeof data.desc === 'string' ? data.desc : ''), bilibiliLimits.storedDescriptionChars);
  const duration = integer(data.duration);
  return { bvid, aid, title: displayName(data.title), author: displayName(object(data.owner)?.name), publishedAt: chinaTime(data.pubdate),
    description: description.text, descriptionTruncated: description.truncated, durationSeconds: duration !== undefined && duration >= 0 ? duration : null, parts };
}
type Track = { language: string; url: string };
/** The subtitle track to read: Chinese first, then machine Chinese, then the first listed. */
function chooseTrack(data: Record<string, unknown>): Track | undefined {
  const rows = object(data.subtitle)?.subtitles;
  const tracks = (Array.isArray(rows) ? rows : []).map(object).flatMap((row) => typeof row?.lan === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(row.lan)
    && typeof row.subtitle_url === 'string' && row.subtitle_url.length <= 2_000 ? [{ language: row.lan, url: row.subtitle_url }] : []);
  return tracks.find((track) => track.language.startsWith('zh')) ?? tracks.find((track) => track.language.startsWith('ai-zh')) ?? tracks[0];
}
/** The track address as a request URL, or undefined when it is not an https address on a Bilibili subtitle host. */
function subtitleAddress(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw.startsWith('//') ? `https:${raw}` : raw); } catch { return undefined; }
  if (!['https:', 'http:'].includes(url.protocol) || !subtitleHosts.has(url.hostname) || url.username || url.password || url.port) return undefined;
  url.protocol = 'https:';
  return /^[\x21-\x7e]+$/.test(url.href) ? url.href : undefined;
}
function parseSubtitle(data: Record<string, unknown>, video: StoredVideo, part: number, language: string): StoredSubtitle | undefined {
  const lines: { from: number; text: string }[] = [];
  let used = 0, truncated = false;
  for (const row of (data.body as unknown[]).map(object)) {
    const from = typeof row?.from === 'number' && Number.isFinite(row.from) && row.from >= 0 ? row.from : undefined;
    const text = typeof row?.content === 'string' ? tidy(row.content).replace(/\n/g, ' ') : '';
    if (from === undefined || !text) continue;
    const size = [...text].length;
    if (used + size > bilibiliLimits.storedSubtitleChars) { truncated = true; break; }
    lines.push({ from: Math.round(from * 10) / 10, text }); used += size;
  }
  return { bvid: video.bvid, part, language, machine: language.startsWith('ai-'), lines, truncated };
}

const isText = (value: unknown) => value === null || typeof value === 'string';
function validVideo(value: unknown): value is StoredVideo {
  const video = object(value);
  return !!video && typeof video.bvid === 'string' && bvPattern.test(video.bvid) && Number.isSafeInteger(video.aid) && isText(video.title) && isText(video.author)
    && isText(video.publishedAt) && typeof video.description === 'string' && typeof video.descriptionTruncated === 'boolean'
    && (video.durationSeconds === null || Number.isSafeInteger(video.durationSeconds)) && Array.isArray(video.parts)
    && video.parts.every((item) => { const row = object(item); return !!row && Number.isSafeInteger(row.page) && Number.isSafeInteger(row.cid); });
}
function validSubtitle(value: unknown): value is StoredSubtitle {
  const subtitle = object(value);
  return !!subtitle && typeof subtitle.bvid === 'string' && Number.isSafeInteger(subtitle.part) && typeof subtitle.language === 'string' && typeof subtitle.machine === 'boolean'
    && typeof subtitle.truncated === 'boolean' && Array.isArray(subtitle.lines)
    && subtitle.lines.every((item) => { const line = object(item); return !!line && typeof line.from === 'number' && typeof line.text === 'string'; });
}

// ---- one run -----------------------------------------------------------------------------------------

/** The only header that carries the saved value; it is built in memory for the player request and nowhere else. */
const sessionHeader = (value: string): Record<string, string> => Object.fromEntries([['Cookie', `SESSDATA=${value}`]]);
const credentialStates: Record<string, PageOutcome> ={ unset: 'credential-required', expired: 'credential-rejected', unreadable: 'credential-unreadable', unknown: 'credential-unreadable' };
const pad = (value: number) => String(value).padStart(2, '0');
function timecode(seconds: number) {
  const whole = Math.floor(seconds), hours = Math.floor(whole / 3600);
  return `${hours ? `${hours}:` : ''}${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`;
}
function authorLimits(video: StoredVideo) {
  return [...(video.author === null ? ['author-unknown'] : []), ...(video.publishedAt === null ? ['date-unknown'] : [])];
}

/** Reads one video part: its public information, and its subtitles when asked for and the user's own SESSDATA is set. At most three requests. */
export async function readBilibiliVideo(value: BilibiliReadRequest, options: BilibiliOptions): Promise<ResearchResult> {
  const request = readRequest(value);
  const privateDirectory = resolve(options.privateDirectory);
  const clock = options.clock ?? systemClock;
  const context: SourceContext = { directory: researchDirectory(privateDirectory, source), limits: bilibiliLimits, clock, transport: defaultTransport(options.transport) };
  const label = request.id.kind === 'bvid' ? request.id.value : `av${request.id.value}`;
  const log = new RunLog();
  const extra: string[] = [];
  const headers = { 'User-Agent': researchUserAgent, 'Accept': 'application/json' };
  let halted = false;
  const settle = (attempt: Attempt<unknown>) => {
    if (attempt.kind === 'answered') log.requests += 1;
    if (attempt.kind === 'stopped') log.stoppedUntil = attempt.stoppedUntil;
    if (attempt.kind === 'answered' && attempt.stoppedUntil) log.stoppedUntil = attempt.stoppedUntil;
  };

  const videoTarget = `video ${label}`;
  const videoKey = cacheKey({ source, kind: 'video', id: label });
  const cachedVideo = await getCached(context.directory, videoKey, clock.now(), validVideo);
  let video: Served<StoredVideo> | undefined;
  if (cacheAnswers(cachedVideo, request)) video = log.offer(videoTarget, 'cached', cachedVideo);
  else if (request.cacheOnly) log.offer(videoTarget, 'not-cached', cachedVideo);
  else {
    const params: Record<string, string> = request.id.kind === 'bvid' ? { bvid: request.id.value } : { aid: String(request.id.value) };
    const attempt = await gatedGet(context, { url: `${bilibiliApiOrigin}/x/web-interface/view?${new URLSearchParams(params)}`, headers }, classifyApi);
    settle(attempt);
    const parsed = attempt.kind === 'answered' && attempt.classified.kind === 'data' ? parseVideoData(attempt.classified.data, request.id) : undefined;
    if (parsed && attempt.kind === 'answered') {
      await putCached(context.directory, videoKey, parsed, bilibiliLimits.videoTtlMs, attempt.at);
      video = log.fresh(videoTarget, parsed, attempt.at);
    } else {
      // A sign-in answer here is about the video, not the user's credential: none was sent.
      let blocked = blockedOutcome(attempt) ?? { outcome: 'incomplete' as PageOutcome, reason: 'data-unrecognized' };
      if (blocked.outcome === 'credential-rejected') blocked = { outcome: 'unavailable', reason: 'login-required' };
      halted = haltingOutcomes.includes(blocked.outcome);
      video = log.offer(videoTarget, blocked.outcome, cachedVideo, blocked.reason);
    }
  }

  let subtitle: Served<StoredSubtitle> | undefined;
  let credential: { revision: string; sessdata: string } | undefined;
  let credentialResult: 'usable' | 'expired' | undefined;
  if (request.subtitles) {
    const target = `subtitles ${label} part ${request.part}`;
    const key = cacheKey({ source, kind: 'subtitles', id: label, part: request.part });
    const cached = await getCached(context.directory, key, clock.now(), validSubtitle);
    const cid = video?.value.parts.find((item) => item.page === request.part)?.cid;
    if (cacheAnswers(cached, request)) subtitle = log.offer(target, 'cached', cached);
    else if (request.cacheOnly) log.offer(target, 'not-cached', cached);
    else if (halted || !video) log.offer(target, 'skipped', cached);
    else if (cid === undefined) log.offer(target, 'unavailable', cached, 'part-missing');
    else {
      const state = (await inspectCredentials(privateDirectory, new Date(clock.now()))).credentials.find((item) => item.service === source)?.state ?? 'unknown';
      let blocked: { outcome: PageOutcome; reason?: string } | undefined = credentialStates[state] ? { outcome: credentialStates[state]! } : undefined;
      if (!blocked) {
        try {
          const saved = await readCredential(source, { privateDirectory, ...(options.protector ? { protector: options.protector } : {}) });
          credential = { revision: saved.revision, sessdata: saved.values.sessdata! };
        } catch (error) { blocked = { outcome: error instanceof CredentialError && error.message === 'credential-unset' ? 'credential-required' : 'credential-unreadable' }; }
      }
      if (blocked) log.offer(target, blocked.outcome, cached);
      else {
        const params = new URLSearchParams({ bvid: video.value.bvid, cid: String(cid) });
        const attempt = await gatedGet(context, { url: `${bilibiliApiOrigin}/x/player/wbi/v2?${params}`, headers: { ...headers, ...sessionHeader(credential!.sessdata) } }, classifyApi);
        settle(attempt);
        if (attempt.kind === 'answered' && attempt.classified.kind === 'data') {
          const data = attempt.classified.data;
          const signedIn = (integer(data.login_mid) ?? 0) > 0;
          const track = signedIn ? chooseTrack(data) : undefined;
          const address = track ? subtitleAddress(track.url) : undefined;
          if (signedIn) credentialResult = 'usable';
          if (!signedIn) { extra.push('login-not-recognized'); log.offer(target, 'unavailable', cached, 'login-not-recognized'); }
          else if (!track) log.offer(target, 'unavailable', cached, 'no-subtitles');
          else if (!address) log.offer(target, 'unavailable', cached, 'subtitle-host-refused');
          else {
            // The subtitle file host needs no credential: nothing but the address the player named is sent.
            const file = await gatedGet(context, { url: address, headers }, classifyFile);
            settle(file);
            const parsed = file.kind === 'answered' && file.classified.kind === 'data' ? parseSubtitle(file.classified.data, video.value, request.part, track.language) : undefined;
            if (parsed && file.kind === 'answered') {
              await putCached(context.directory, key, parsed, bilibiliLimits.subtitleTtlMs, file.at);
              subtitle = log.fresh(target, parsed, file.at);
            } else {
              const failed = blockedOutcome(file) ?? { outcome: 'incomplete' as PageOutcome, reason: 'data-unrecognized' };
              subtitle = log.offer(target, failed.outcome === 'credential-rejected' ? 'unavailable' : failed.outcome, cached, failed.reason);
            }
          }
        } else {
          const failed = blockedOutcome(attempt) ?? { outcome: 'incomplete' as PageOutcome, reason: 'data-unrecognized' };
          if (failed.outcome === 'credential-rejected') credentialResult = 'expired';
          subtitle = log.offer(target, failed.outcome, cached, failed.reason);
        }
      }
    }
  }
  // Only Bilibili's explicit "not signed in" (-101) marks the saved value expired; a guest answer, risk control,
  // network and parse problems never do. Usable needs Bilibili to have recognised the session.
  if (credential && credentialResult) await recordCredentialOutcome(source, credential.revision, credentialResult, { privateDirectory, at: new Date(clock.now()) });

  const items: ResearchItem[] = [];
  if (video) {
    const v = video.value;
    const excerpt = clip(v.description, bilibiliLimits.excerptChars);
    const truncated = excerpt.truncated || v.descriptionTruncated;
    items.push({ source, kind: 'video', title: v.title, url: `https://www.bilibili.com/video/${v.bvid}/?p=${request.part}`, location: null, author: v.author,
      authorStatus: v.author === null ? 'unknown' : 'known', publishedAt: v.publishedAt, excerpt: excerpt.text, excerptTruncated: truncated, reliability: 'community-opinion',
      limitations: [...authorLimits(v), ...(truncated ? ['excerpt-truncated'] : []), ...(subtitle ? [] : ['subtitles-not-read'])],
      origin: video.origin, readAt: video.readAt, stale: video.stale,
      meta: { bvid: v.bvid, aid: v.aid, part: request.part, parts: v.parts.length, durationSeconds: v.durationSeconds } });
    if (subtitle) {
      const s = subtitle.value;
      const segments: { from: number; text: string; cut: boolean }[] = [];
      for (const line of s.lines) {
        const last = segments.at(-1);
        if (last && [...last.text].length + 1 + [...line.text].length <= bilibiliLimits.excerptChars) last.text += `\n${line.text}`;
        else { const piece = clip(line.text, bilibiliLimits.excerptChars); segments.push({ from: line.from, text: piece.text, cut: piece.truncated }); }
      }
      segments.forEach((segment, index) => {
        const cut = segment.cut || (s.truncated && index === segments.length - 1);
        items.push({ source, kind: 'subtitle', title: v.title, url: `https://www.bilibili.com/video/${v.bvid}/?p=${request.part}`, location: { label: 'time', value: timecode(segment.from) },
          author: v.author, authorStatus: v.author === null ? 'unknown' : 'known', publishedAt: v.publishedAt, excerpt: segment.text, excerptTruncated: cut, reliability: 'community-opinion',
          limitations: [...authorLimits(v), ...(s.machine ? ['machine-subtitle'] : []), ...(cut ? ['excerpt-truncated'] : [])],
          origin: subtitle!.origin, readAt: subtitle!.readAt, stale: subtitle!.stale,
          meta: { bvid: v.bvid, aid: v.aid, part: request.part, language: s.language, startSeconds: segment.from } });
      });
    }
  }
  return assembleResult({ source, sourceLabel: 'Bilibili', experimental: true, log, items, clock, limitations: ['experimental-source', ...extra],
    request: { kind: 'video', video: label, part: request.part, subtitles: request.subtitles },
    reliabilityNote: 'Bilibili videos are personal creator content and opinion; they are not verified by this tool and may be outdated by game updates. Bilibili support is experimental.',
    notice: `${contentNotice} ${experimentalNotice}` });
}

/** Read-only state: experimental marker, whether a risk-control stop is in force, the last request time and the credential state. */
export async function bilibiliStatus(options: { privateDirectory: string; clock?: Clock }) {
  const clock = options.clock ?? systemClock;
  const privateDirectory = resolve(options.privateDirectory);
  const gate = await readGateState(researchDirectory(privateDirectory, source), clock.now());
  const credential = (await inspectCredentials(privateDirectory, new Date(clock.now()))).credentials.find((item) => item.service === source)?.state ?? 'unknown';
  return { experimental: true, stopped: gate.stopped, stoppedUntil: gate.stopped ? gate.stoppedUntil : null, stopReason: gate.stopped ? gate.stopReason : null,
    lastRequestAt: gate.lastRequestAt, credential };
}

const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  const action = process.argv[2];
  try {
    if (process.argv.length !== 3 || !['read', 'status'].includes(action!)) throw invalid();
    let settings;
    try { settings = await readSettings(); } catch { throw new Error('settings-unreadable'); }
    if (action === 'status') console.log(JSON.stringify({ ok: true, experimental: true, notice: experimentalNotice, status: await bilibiliStatus({ privateDirectory: settings.privateDirectory }) }));
    else {
      let raw = '';
      for await (const chunk of process.stdin) { raw += String(chunk); if (Buffer.byteLength(raw) > 64 * 1024) throw invalid(); }
      let input: Record<string, unknown> | undefined;
      try { input = object(JSON.parse(raw)); } catch { throw invalid(); }
      if (!input) throw invalid();
      const { format, ...request } = input;
      if (format !== undefined && format !== 'json' && format !== 'markdown') throw invalid();
      const result = await readBilibiliVideo(request as BilibiliReadRequest, { privateDirectory: settings.privateDirectory });
      console.log(format === 'markdown' ? formatResearchMarkdown(result, (settings.language ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en')
        : JSON.stringify({ ok: true, experimental: true, result }));
      if (result.status !== 'ok') process.exitCode = 1;
    }
  } catch (error) {
    const code = error instanceof Error && ['request-invalid', 'settings-unreadable'].includes(error.message) ? error.message : 'research-failed';
    console.log(JSON.stringify({ ok: false, experimental: true, error: code }));
    process.exitCode = code === 'research-failed' ? 2 : 1;
  }
}
