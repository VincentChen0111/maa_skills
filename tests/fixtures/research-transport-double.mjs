import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Test-only network boundary for CLI runs. Answers come from a JSON file of synthetic responses keyed by
// path and query; every request is journaled with its time and a hash of the Cookie header (never the value).
const answer = (url) => {
  const routes = JSON.parse(readFileSync(process.env.MAA_RESEARCH_TEST_ROUTES, 'utf8'));
  const parsed = new URL(url);
  return parsed.origin === 'https://bbs.nga.cn' ? routes[`${parsed.pathname}${parsed.search}`] : undefined;
};
const double = {
  name: 'fetch',
  async get(request) {
    const jar = request.headers.Cookie ?? '';
    appendFileSync(process.env.MAA_RESEARCH_TEST_JOURNAL, `${JSON.stringify({ url: request.url, at: Date.now(), jar: createHash('sha256').update(jar).digest('hex') })}\n`);
    const route = answer(request.url);
    if (!route) throw new Error('transport-failed');
    return { status: route.status, location: route.location ?? null, contentType: route.contentType ?? 'text/html; charset=GBK', body: Buffer.from(route.body ?? '', 'base64') };
  },
};
export const fetchTransport = double;
export const windowsTransport = double;
export function platformTransport() { return double; }
