import type { ResearchTransport, TransportResponse } from '../../skills/maa-core/scripts/research-transport.ts';

// Synthetic NGA payloads shaped after the publicly documented `__output=8` structure (see docs/nga-sources.md).
// Every name, number and text here is invented; nothing comes from a real account or thread.

let table: Map<string, number[]> | undefined;
/** Encodes text as GBK through the platform decoder's own table, as NGA declares `"encode":"gbk"`. */
export function gbk(text: string): Buffer {
  if (!table) {
    table = new Map();
    const decoder = new TextDecoder('gbk', { fatal: true });
    for (let lead = 0x81; lead <= 0xfe; lead += 1) for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      try { const char = decoder.decode(Uint8Array.of(lead, trail)); if (!table.has(char)) table.set(char, [lead, trail]); } catch { /* unassigned */ }
    }
  }
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else { const pair = table.get(char); if (!pair) throw new Error(`not encodable: ${char}`); bytes.push(...pair); }
  }
  return Buffer.from(bytes);
}

export type SyntheticPost = { floor: number; pid?: number; author: number; text: string; time?: number | null; date?: string };
/** A thread page. `users` maps author numbers to user names; `extra` adds top-level data fields (for example a current-user block). */
export function threadPayload(options: { tid: number; title: string; posts: SyntheticPost[]; users: Record<number, string>; rows?: number; extra?: Record<string, unknown> }) {
  const replies = Object.fromEntries(options.posts.map((post, index) => [String(index), {
    lou: post.floor, pid: post.pid ?? 9000 + post.floor, authorid: post.author, content: post.text, subject: '',
    ...(post.time === null ? {} : { postdatetimestamp: post.time ?? 1_780_000_000 + post.floor * 60 }), ...(post.date ? { postdate: post.date } : {}),
  }]));
  const users = Object.fromEntries(Object.entries(options.users).map(([id, name]) => [id, { username: name }]));
  return { data: { __T: { tid: options.tid, subject: options.title, fid: -34587507, postdate: 1_780_000_000 }, __R: replies,
    __U: { ...users, __GROUPS: {}, __MEDALS: {} }, __ROWS: options.rows ?? options.posts.length, __R__ROWS: options.posts.length, __R__ROWS_PAGE: 20,
    ...options.extra }, encode: 'gbk', time: 1_780_000_500 };
}

export type SyntheticThread = { tid: number; subject: string; author: string; postdate?: number; replies?: number };
export function searchPayload(rows: SyntheticThread[], total = rows.length) {
  return { data: { __T: Object.fromEntries(rows.map((row, index) => [String(index), { tid: row.tid, subject: row.subject, author: row.author,
    postdate: row.postdate ?? 1_780_000_000, lastpost: (row.postdate ?? 1_780_000_000) + 600, replies: row.replies ?? 3, type: 0, fid: -34587507 }])),
    __T__ROWS: total, __T__ROWS_PAGE: 35 }, encode: 'gbk', time: 1_780_000_500 };
}

/** NGA's error envelope: `error` plus `data.__MESSAGE` carrying the code, the message and the HTTP status. */
export function errorPayload(code: number, message: string, status: number) {
  return { error: { 0: `${code}:${message}`, 1: '', 2: '' }, data: { __MESSAGE: { 0: code, 1: message, 2: '', 3: status } }, encode: 'gbk', time: 1_780_000_500 };
}

/** NGA JSON as sent: GBK bytes, raw control characters left in strings as the site does. */
export function wire(payload: unknown): Buffer {
  return gbk(JSON.stringify(payload).replace(/\\t/g, '\t'));
}

export type Route = { status: number; body?: Buffer | string; contentType?: string; location?: string };
export type Call = { url: string; headers: Record<string, string> };
/** Network boundary double: answers from `route` and records every request; an unlisted URL fails like a network error. */
export function transportDouble(route: (url: URL) => Route | Error | undefined) {
  const calls: Call[] = [];
  const transport: ResearchTransport = {
    name: 'fetch',
    async get(request): Promise<TransportResponse> {
      calls.push({ url: request.url, headers: { ...request.headers } });
      const answer = route(new URL(request.url));
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error('transport-failed');
      return { status: answer.status, location: answer.location ?? null, contentType: answer.contentType ?? 'text/html; charset=GBK',
        body: typeof answer.body === 'string' ? Buffer.from(answer.body) : answer.body ?? Buffer.alloc(0) };
    },
  };
  return { transport, calls };
}
