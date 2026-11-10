import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readPublicJson } from '../skills/maa-core/scripts/public-data.ts';

const request = { repository: 'Synthetic/game-data', commit: 'a'.repeat(40), file: 'tables/characters.json' };

test('public data is read from a fixed revision with reproducible body provenance', async (t) => {
  const body = '{"operators":[{"name":"Synthetic Operator"}]}';
  let requestedPath = '';
  const server = createServer((incoming, response) => { requestedPath = incoming.url!; response.setHeader('content-type', 'text/plain'); response.end(body); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const started = Date.now();
  const result = await readPublicJson(request, (url, options) => {
    const source = new URL(String(url));
    assert.equal(source.origin, 'https://raw.githubusercontent.com');
    return fetch(`http://127.0.0.1:${address.port}${source.pathname}`, options);
  });
  assert.equal(requestedPath, `/Synthetic/game-data/${request.commit}/tables/characters.json`);
  assert.deepEqual(result.value, JSON.parse(body));
  assert.deepEqual({ ...result.source, readAt: undefined }, { ...request,
    url: `https://raw.githubusercontent.com/Synthetic/game-data/${request.commit}/tables/characters.json`,
    bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), readAt: undefined });
  assert.ok(Date.parse(result.source.readAt) >= started && Date.parse(result.source.readAt) <= Date.now());
});

test('branch names and noncanonical paths are refused before any network request', async () => {
  const network: typeof fetch = async () => assert.fail('invalid source must not access the network');
  for (const invalid of [{ ...request, commit: 'main' }, { ...request, repository: 'https://example.invalid/repo' },
    ...['../secret.json', '/secret.json', 'a//b.json', 'a/./b.json', 'a\\b.json', 'a/%2e%2e/b.json', 'a.json?mode=synthetic'].map(file => ({ ...request, file }))]) {
    await assert.rejects(readPublicJson(invalid, network), { message: 'public-data-input-invalid' });
  }
});

test('download failures never expose network messages or response bodies', async () => {
  const marker = 'synthetic-network-private-marker';
  for (const [network, code] of [
    [async () => { throw new Error(marker); }, 'public-data-network-failed'],
    [async () => new Response(marker, { status: 403 }), 'public-data-http-failed'],
    [async () => new Response(marker), 'public-data-json-invalid'],
  ] as const) await assert.rejects(readPublicJson(request, network), error => error instanceof Error && error.message === code && !String(error).includes(marker));
});

test('redirects do not turn a pinned source into another endpoint', async (t) => {
  let followed = false;
  const server = createServer((incoming, response) => {
    if (incoming.url === '/redirected') { followed = true; response.end('{}'); }
    else { response.writeHead(302, { Location: '/redirected' }); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await assert.rejects(readPublicJson(request, (_url, options) => fetch(`http://127.0.0.1:${address.port}/source`, options)), { message: 'public-data-network-failed' });
  assert.equal(followed, false);
});

test('declared and streamed response sizes are bounded before JSON parsing', async () => {
  await assert.rejects(readPublicJson(request, async () => new Response('{}', { headers: { 'content-length': String(65 * 1024 * 1024) } })), { message: 'public-data-too-large' });
  let cancelled = false; let chunks = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); chunks++; }, cancel() { cancelled = true; } });
  await assert.rejects(readPublicJson(request, async () => new Response(body)), { message: 'public-data-too-large' });
  assert.equal(cancelled, true); assert.ok(chunks <= 67);
});
