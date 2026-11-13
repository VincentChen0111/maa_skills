import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression fixture, not a security boundary against a hostile model. Never installed in product skills.
const workspace = dirname(fileURLToPath(import.meta.url));
let file;
try { file = relative(workspace, realpathSync(process.argv[1])).replaceAll('\\', '/'); } catch {}
if (/^\.(agents|claude)\/skills\/maa-core\/scripts\/(operator-cost|cultivation-gaps)\.ts$/.test(file ?? '') && process.argv[2] === 'query') {
  const responses = JSON.parse(readFileSync(join(workspace, '.eval-network-responses.json'), 'utf8'));
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET' || !Object.hasOwn(responses, url)) throw new Error('eval-network-unlisted');
    return new Response(JSON.stringify(responses[url]), { headers: { 'Content-Type': 'application/json' } });
  };
}
// Setup downloads: official release indexes and download samples come from the scenario's trusted
// `.eval-setup-network.json`. Each GET of a route marked as a download is recorded as a download event.
if (/^\.(agents|claude)\/skills\/maa-core\/scripts\/setup\.ts$/.test(file ?? '') && ['plan', 'download'].includes(process.argv[2])) {
  let routes = {};
  try { routes = JSON.parse(readFileSync(join(workspace, '.eval-setup-network.json'), 'utf8')); } catch {}
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const route = Object.hasOwn(routes, url) ? routes[url] : undefined;
    if (!route || !['GET', 'HEAD'].includes(method)) throw new TypeError('eval-network-unlisted');
    if (route.download && method === 'GET') appendFileSync(join(workspace, 'events.jsonl'), `${JSON.stringify({ kind: 'download', url })}\n`);
    const body = method === 'HEAD' ? null : route.json !== undefined ? JSON.stringify(route.json) : route.text ?? null;
    return new Response(body, { status: route.status ?? 200, headers: route.headers ?? {} });
  };
}
