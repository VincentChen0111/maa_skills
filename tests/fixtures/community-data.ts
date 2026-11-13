import type { Route } from './nga-data.ts';

// Synthetic Skland community and Bilibili payloads shaped after the public facts in docs/community-sources.md.
// Every name, number, identifier and text here is invented; nothing comes from a real account, post or video.

export const json = (payload: unknown, status = 200): Route => ({ status, body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json; charset=utf-8' });

export type SyntheticPart = { cid: number; page: number; part: string };
/** `x/web-interface/view`: the public video information envelope. */
export function videoPayload(options: { bvid: string; aid: number; title: string; owner?: string | null; pubdate?: number | null; desc?: string; parts?: SyntheticPart[] }) {
  const parts = options.parts ?? [{ cid: 5001, page: 1, part: '合成分P' }];
  return { code: 0, message: '0', ttl: 1, data: {
    bvid: options.bvid, aid: options.aid, title: options.title, desc: options.desc ?? '合成简介',
    ...(options.pubdate === null ? {} : { pubdate: options.pubdate ?? 1_780_000_000 }), ctime: 1_779_999_000, duration: 300,
    ...(options.owner === null ? {} : { owner: { mid: 424242, name: options.owner ?? '合成UP主', face: 'https://i0.hdslb.com/bfs/face/synthetic.jpg' } }),
    cid: parts[0]!.cid, pages: parts.map((part) => ({ ...part, duration: 300, from: 'vupload', vid: '', weblink: '', dimension: { width: 1920, height: 1080, rotate: 0 }, ctime: 1_779_999_000 })),
    subtitle: { allow_submit: false, list: [] },
  } };
}

export type SyntheticTrack = { lan: string; lan_doc: string; subtitle_url: string };
/** `x/player/wbi/v2`: a guest answer has `login_mid` 0, `need_login_subtitle` true and no subtitle block. */
export function playerPayload(options: { loginMid: number; tracks?: SyntheticTrack[] }) {
  return { code: 0, message: '0', ttl: 1, data: {
    aid: 1, bvid: 'BV1Sy4y1x7Kt', cid: 5001, login_mid: options.loginMid, login_mid_hash: 'synthetic', need_login_subtitle: true,
    ...(options.tracks ? { subtitle: { allow_submit: false, lan: '', lan_doc: '', subtitles: options.tracks.map((track, index) => ({ id: 7000 + index, id_str: String(7000 + index), ...track, type: 1, ai_type: 0, ai_status: 2 })) } } : {}),
  } };
}

/** A subtitle file: `body` lines with `from`, `to` and `content`. */
export function subtitleFile(lines: { from: number; content: string }[]) {
  return { font_size: 0.4, font_color: '#FFFFFF', background_alpha: 0.5, background_color: '#9C27B0', Stroke: 'none', type: 'AIsubtitle', lang: 'zh', version: 'v1',
    body: lines.map((line, index) => ({ from: line.from, to: line.from + 2, sid: index + 1, location: 2, content: line.content, music: 0 })) };
}

/** Bilibili's error envelope. */
export const biliError = (code: number, message: string) => ({ code, message, ttl: 1 });

/** `zonai.skland.com/web/v2/item`: an item aggregate with `item` and `user`, text in `textSlice`. */
export function sklandItemPayload(options: { id: string; title: string; nickname?: string | null; publishedAtTs?: number | string | null; slices: string[] }) {
  return { code: 0, message: 'OK', timestamp: '1780000500', data: {
    item: { id: options.id, title: options.title, viewKind: 1, format: '{"version":2}', textSlice: options.slices.map((c, index) => ({ id: String(index), c })),
      ...(options.publishedAtTs === null ? {} : { publishedAtTs: options.publishedAtTs ?? 1_780_000_000 }), createdAtTs: 1_779_999_000, userId: '987654321' },
    ...(options.nickname === null ? {} : { user: { id: '987654321', nickname: options.nickname ?? '合成博士', avatar: 'https://bbs.hycdn.cn/avatar/synthetic.png' } }),
  } };
}
export const sklandError = (code: number, message: string) => ({ code, message, timestamp: '1780000500' });
