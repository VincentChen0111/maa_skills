import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Test-only network boundary for CLI runs of the Skland community and Bilibili readers. Answers come from a
// JSON file of synthetic responses keyed by the full request URL; every request is journaled with its time,
// its header names and a hash of the Cookie header (never the value).
const double = {
  name: 'fetch',
  async get(request) {
    const jar = request.headers.Cookie ?? '';
    appendFileSync(process.env.MAA_RESEARCH_TEST_JOURNAL, `${JSON.stringify({ url: request.url, at: Date.now(), headers: Object.keys(request.headers).sort(),
      jar: jar ? createHash('sha256').update(jar).digest('hex') : null })}\n`);
    const route = JSON.parse(readFileSync(process.env.MAA_RESEARCH_TEST_ROUTES, 'utf8'))[request.url];
    if (!route) throw new Error('transport-failed');
    return { status: route.status, location: route.location ?? null, contentType: 'application/json; charset=utf-8', body: Buffer.from(route.body ?? '', 'base64') };
  },
};
export const fetchTransport = double;
export const windowsTransport = double;
export function platformTransport() { return double; }
