import './fixtures/offline-network.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveCredential } from '../skills/maa-core/scripts/credentials.ts';
import type { Protector } from '../skills/maa-core/scripts/credential-protection.ts';
import type { Clock, ResearchResult } from '../skills/maa-core/scripts/research.ts';
import * as bilibiliReader from '../skills/maa-core/scripts/bilibili.ts';
import * as sklandReader from '../skills/maa-core/scripts/skland-community.ts';
import { transportDouble } from './fixtures/nga-data.ts';
import { json, playerPayload, sklandItemPayload, subtitleFile, videoPayload } from './fixtures/community-data.ts';
import { sklandSecrets } from './fixtures/skland-data.ts';
import type { SklandFetch } from '../skills/maa-core/scripts/skland-session.ts';

const sklandDoubles = await import(new URL('./fixtures/skland-double.mjs', import.meta.url).href) as {
  createSklandDouble(scenario?: { steps?: Record<string, unknown[]> }): { fetch: SklandFetch; trace: { kind: string }[] } };

// Conformance for the one rule on fetched content (research-fetch.ts `readContents`): for every content field
// either reader takes from a site, the site's explicit "none" is an honest empty result, the known shape is read,
// and anything else (missing, renamed, another type, a list with no entry in the known shape) is reported as
// incomplete `data-unrecognized` and is never cached. The case list must name exactly the fields the readers declare.

const protector: Protector = {
  protect: async (plain, entropy) => Buffer.concat([Buffer.from(`${entropy}|`), Buffer.from(plain.map((byte) => byte ^ 0x5a))]),
  unprotect: async (cipher, entropy) => Buffer.from(cipher.subarray(Buffer.from(`${entropy}|`).length).map((byte) => byte ^ 0x5a)),
};
const bvid = 'BV1Sy4y1x7Kt';
type Json = Record<string, any>;
type Payloads = { video: Json; player: Json; file: Json; post: Json };
const base = (): Payloads => structuredClone({
  video: videoPayload({ bvid, aid: 9001, title: '合成干员专精推荐', desc: '合成简介' }),
  player: playerPayload({ loginMid: 1, tracks: [{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: '//i0.hdslb.com/bfs/subtitle/synthetic.json' }] }),
  file: subtitleFile([{ from: 3, content: '三技能专精收益最高。' }]),
  post: sklandItemPayload({ id: '1234567', title: '合成干员培养心得', slices: ['合成干员建议先专精三技能。'] }),
});

/** Which request carries the field, which result page reports it, and what an honest empty result looks like. */
type Case = { reader: 'bilibili' | 'skland'; field: string; request: 'view' | 'player' | 'file' | 'post'; page: number;
  empty: [string, (p: Payloads) => void][]; unrecognised: [string, (p: Payloads) => void][]; emptyResult: (result: ResearchResult) => void };
const videoItem = (result: ResearchResult) => result.items.find((item) => item.kind === 'video')!;
const cases: Case[] = [
  { reader: 'bilibili', field: 'video.title', request: 'view', page: 0,
    empty: [['empty string', (p) => { p.video.data.title = ''; }], ['null', (p) => { p.video.data.title = null; }]],
    unrecognised: [['missing', (p) => { delete p.video.data.title; }], ['renamed', (p) => { p.video.data.title_v2 = p.video.data.title; delete p.video.data.title; }], ['another type', (p) => { p.video.data.title = { text: 'x' }; }]],
    emptyResult: (result) => { assert.equal(videoItem(result).title, null); } },
  { reader: 'bilibili', field: 'video.author', request: 'view', page: 0,
    empty: [['null owner', (p) => { p.video.data.owner = null; }]],
    unrecognised: [['missing owner', (p) => { delete p.video.data.owner; }], ['renamed name', (p) => { p.video.data.owner = { mid: 1, nickname: '改名字段' }; }]],
    emptyResult: (result) => { assert.deepEqual([videoItem(result).author, videoItem(result).authorStatus], [null, 'unknown']); assert.ok(videoItem(result).limitations.includes('author-unknown')); } },
  { reader: 'bilibili', field: 'video.published', request: 'view', page: 0,
    empty: [['zero', (p) => { p.video.data.pubdate = 0; }], ['null', (p) => { p.video.data.pubdate = null; }]],
    unrecognised: [['missing', (p) => { delete p.video.data.pubdate; }], ['milliseconds', (p) => { p.video.data.pubdate = 1_780_000_000_000; }], ['text', (p) => { p.video.data.pubdate = '昨天'; }]],
    emptyResult: (result) => { assert.equal(videoItem(result).publishedAt, null); assert.ok(videoItem(result).limitations.includes('date-unknown')); } },
  { reader: 'bilibili', field: 'video.description', request: 'view', page: 0,
    empty: [['empty string', (p) => { p.video.data.desc = ''; }]],
    unrecognised: [['only desc_v2', (p) => { delete p.video.data.desc; p.video.data.desc_v2 = [{ raw_text: '真正的简介', type: 1 }]; }], ['another type', (p) => { p.video.data.desc = ['简介']; }]],
    emptyResult: (result) => { assert.equal(videoItem(result).excerpt, ''); } },
  { reader: 'bilibili', field: 'video.parts', request: 'view', page: 0,
    empty: [['empty list', (p) => { p.video.data.pages = []; }]],
    unrecognised: [['missing', (p) => { delete p.video.data.pages; }], ['renamed rows', (p) => { p.video.data.pages = [{ p: 1, cid_v2: 5001 }]; }]],
    emptyResult: (result) => { assert.deepEqual([result.pages[1]!.outcome, result.pages[1]!.reason], ['unavailable', 'part-missing']); } },
  { reader: 'bilibili', field: 'session.signedIn', request: 'player', page: 1,
    empty: [['zero', (p) => { p.player.data.login_mid = 0; delete p.player.data.subtitle; }]],
    unrecognised: [['missing', (p) => { delete p.player.data.login_mid; }], ['text', (p) => { p.player.data.login_mid = 'yes'; }]],
    emptyResult: (result) => { assert.deepEqual([result.pages[1]!.outcome, result.pages[1]!.reason], ['unavailable', 'login-not-recognized']); } },
  { reader: 'bilibili', field: 'subtitleList.tracks', request: 'player', page: 1,
    empty: [['empty list', (p) => { p.player.data.subtitle.subtitles = []; }]],
    unrecognised: [['subtitle block missing', (p) => { delete p.player.data.subtitle; }], ['rows renamed', (p) => { p.player.data.subtitle.subtitles = [{ lan: 'zh-CN', url: '//i0.hdslb.com/bfs/subtitle/synthetic.json' }]; }],
      ['list missing', (p) => { delete p.player.data.subtitle.subtitles; }]],
    emptyResult: (result) => { assert.deepEqual([result.pages[1]!.outcome, result.pages[1]!.reason], ['unavailable', 'no-subtitles']); } },
  { reader: 'bilibili', field: 'subtitleFile.lines', request: 'file', page: 1,
    empty: [['empty body', (p) => { p.file.body = []; }]],
    unrecognised: [['body missing', (p) => { delete p.file.body; }], ['rows renamed', (p) => { p.file.body = p.file.body.map(({ content, ...rest }: Json) => ({ ...rest, text: content })); }]],
    emptyResult: (result) => { assert.equal(result.pages[1]!.outcome, 'fresh'); assert.deepEqual(result.items.map((item) => item.kind), ['video']); assert.ok(!videoItem(result).limitations.includes('subtitles-not-read')); } },
  { reader: 'skland', field: 'post.title', request: 'post', page: 0,
    empty: [['empty string', (p) => { p.post.data.item.title = ''; }], ['null', (p) => { p.post.data.item.title = null; }]],
    unrecognised: [['missing', (p) => { delete p.post.data.item.title; }], ['another type', (p) => { p.post.data.item.title = 7; }]],
    emptyResult: (result) => { assert.equal(result.items[0]!.title, null); } },
  { reader: 'skland', field: 'post.author', request: 'post', page: 0,
    empty: [['null user', (p) => { p.post.data.user = null; }]],
    unrecognised: [['missing user', (p) => { delete p.post.data.user; }], ['renamed nickname', (p) => { p.post.data.user = { id: '1', name: '改名字段' }; }]],
    emptyResult: (result) => { assert.deepEqual([result.items[0]!.author, result.items[0]!.authorStatus], [null, 'unknown']); } },
  { reader: 'skland', field: 'post.published', request: 'post', page: 0,
    empty: [['null', (p) => { p.post.data.item.publishedAtTs = null; }], ['zero', (p) => { p.post.data.item.publishedAtTs = 0; }]],
    unrecognised: [['missing', (p) => { delete p.post.data.item.publishedAtTs; }], ['milliseconds', (p) => { p.post.data.item.publishedAtTs = 1_780_000_000_000; }]],
    emptyResult: (result) => { assert.equal(result.items[0]!.publishedAt, null); assert.ok(result.items[0]!.limitations.includes('date-unknown')); } },
  { reader: 'skland', field: 'post.text', request: 'post', page: 0,
    empty: [['empty list', (p) => { p.post.data.item.textSlice = []; }]],
    unrecognised: [['missing', (p) => { delete p.post.data.item.textSlice; }], ['rows renamed', (p) => { p.post.data.item.textSlice = [{ id: '0', text: '甲' }]; }]],
    emptyResult: (result) => { assert.equal(result.items[0]!.excerpt, ''); } },
];

function manualClock(start = Date.parse('2026-11-13T00:00:00.000Z')) {
  let now = start;
  const clock: Clock = { now: () => now, sleep: async (ms) => { now += ms; } };
  return { clock, advance: (ms: number) => { now += ms; } };
}
const requestOf = (url: URL): Case['request'] | undefined => url.pathname === '/x/web-interface/view' ? 'view' : url.pathname === '/x/player/wbi/v2' ? 'player'
  : url.hostname === 'i0.hdslb.com' ? 'file' : url.hostname === 'zonai.skland.com' ? 'post' : undefined;

/** Runs the case's reader twice, a minute apart, on fresh temporary state; returns both results and how often the field's request was sent. */
async function run(reader: Case['reader'], edit: (p: Payloads) => void) {
  const root = await mkdtemp(join(tmpdir(), 'maa-content-'));
  try {
    const privateDirectory = join(root, 'private');
    if (reader === 'bilibili') await saveCredential('bilibili', `synthetic-sessdata-${randomUUID()}`, { privateDirectory, protector });
    else await saveCredential('skland', sklandSecrets.userValue, { privateDirectory, protector });
    const payloads = base(); edit(payloads);
    // The Skland post is read with the user's own Skland session through the account network double.
    const skland = sklandDoubles.createSklandDouble({ steps: { item: [{ data: payloads.post.data }] } });
    const { transport, calls } = transportDouble((url) => { const kind = requestOf(url); return kind ? json(payloads[kind === 'view' ? 'video' : kind]) : undefined; });
    const { clock, advance } = manualClock();
    const read = () => reader === 'bilibili' ? bilibiliReader.readBilibiliVideo({ video: bvid }, { privateDirectory, transport, protector, clock })
      : sklandReader.readSklandPost({ post: '1234567' }, { privateDirectory, fetcher: skland.fetch, protector, clock });
    const first = await read();
    advance(60_000);
    const second = await read();
    return { first, second, sent: (kind: Case['request']) => kind === 'post' ? skland.trace.filter((entry) => entry.kind === 'item').length
      : calls.filter((call) => requestOf(new URL(call.url)) === kind).length };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('the case list names exactly the content fields each reader declares', () => {
  const declared = (tables: unknown) => Object.entries((tables ?? {}) as Record<string, Record<string, unknown>>).flatMap(([group, fields]) => Object.keys(fields).map((name) => `${group}.${name}`)).sort();
  assert.deepEqual(cases.filter((item) => item.reader === 'bilibili').map((item) => item.field).sort(), declared((bilibiliReader as Record<string, unknown>).bilibiliContent));
  assert.deepEqual(cases.filter((item) => item.reader === 'skland').map((item) => item.field).sort(), declared((sklandReader as Record<string, unknown>).sklandCommunityContent));
});

test('every content field: the known shape is read and cached', async () => {
  for (const reader of ['bilibili', 'skland'] as const) {
    const { first, second } = await run(reader, () => undefined);
    assert.deepEqual([first.status, first.complete, second.requests], ['ok', true, 0], reader);
  }
});

for (const item of cases) {
  test(`${item.field}: the site's explicit none is an honest empty result; anything unrecognised is incomplete and not cached`, async () => {
    for (const [name, edit] of item.empty) {
      const { first } = await run(item.reader, edit);
      assert.notEqual(first.pages[item.page]!.outcome, 'incomplete', `${item.field} / ${name}: an explicit none is not a format change`);
      item.emptyResult(first);
    }
    for (const [name, edit] of item.unrecognised) {
      const { first, second, sent } = await run(item.reader, edit);
      assert.deepEqual([first.pages[item.page]!.outcome, first.pages[item.page]!.reason], ['incomplete', 'data-unrecognized'], `${item.field} / ${name}`);
      assert.equal(first.complete, false, `${item.field} / ${name}`);
      assert.equal(sent(item.request), 2, `${item.field} / ${name}: an unrecognised answer is not cached`);
      if (item.page === 0) assert.deepEqual(first.items, [], `${item.field} / ${name}: nothing is claimed as read`);
    }
  });
}
