import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchTransport, platformTransport, windowsTransport, type ResearchTransport } from '../skills/maa-core/scripts/research-transport.ts';

type Seen = { method: string; path: string; jar: string | undefined; agent: string | undefined; bodyBytes: number };

/** A local HTTP server stands in for the remote site: the transports and the operating system stack stay real. */
async function site(t: { after(fn: () => Promise<unknown>): void }) {
  const seen: Seen[] = [];
  const gbkBytes = Buffer.from([0x7b, 0x22, 0x6d, 0x22, 0x3a, 0x22, 0xce, 0xb4, 0x22, 0x7d]);
  const server = createServer(async (request: IncomingMessage, response) => {
    let bodyBytes = 0; for await (const chunk of request) bodyBytes += (chunk as Buffer).length;
    seen.push({ method: request.method ?? '', path: request.url ?? '', jar: request.headers.cookie, agent: request.headers['user-agent'], bodyBytes });
    if (request.url === '/json') { response.writeHead(200, { 'Content-Type': 'application/json; charset=gbk' }); response.end(gbkBytes); }
    else if (request.url === '/redirect') { response.writeHead(302, { Location: 'https://other.example/login' }); response.end(); }
    else if (request.url === '/blocked') { response.writeHead(503, { 'Content-Type': 'text/html' }); response.end('<html>busy</html>'); }
    else if (request.url === '/big') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(Buffer.alloc(4096, 0x20)); }
    else if (request.url === '/slow') { setTimeout(() => { response.writeHead(200); response.end('{}'); }, 6000); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(() => done(undefined)); }));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, gbkBytes };
}

const headers: Record<string, string> = Object.fromEntries([['Cookie', 'synthetic_a=one; synthetic_b=two'], ['User-Agent', 'maa-skills-research-test'], ['Accept', 'application/json']]);
const limits = { timeoutMs: 15_000, maxBytes: 1024 };

async function exercise(transport: ResearchTransport, base: string) {
  const json = await transport.get({ url: `${base}/json`, headers }, limits);
  const redirect = await transport.get({ url: `${base}/redirect`, headers }, limits);
  const blocked = await transport.get({ url: `${base}/blocked`, headers }, limits);
  const big = await transport.get({ url: `${base}/big`, headers }, limits).then(() => 'resolved', (error: Error) => error.message);
  const slow = await transport.get({ url: `${base}/slow`, headers }, { ...limits, timeoutMs: 1500 }).then(() => 'resolved', (error: Error) => error.message);
  return { json, redirect: { status: redirect.status, location: redirect.location }, blocked: { status: blocked.status, body: blocked.body.toString('utf8') }, big, slow };
}

const transports: [string, ResearchTransport, boolean][] = [['fetch', fetchTransport, true], ['windows', windowsTransport, process.platform === 'win32']];
for (const [name, transport, available] of transports) {
  test(`the ${name} transport sends one plain GET with the given headers, returns raw bytes and never follows redirects`, { skip: !available && 'Windows only' }, async (t) => {
    const remote = await site(t);
    const outcome = await exercise(transport, remote.base);
    assert.equal(outcome.json.status, 200);
    assert.deepEqual(outcome.json.body, remote.gbkBytes, 'bytes are returned undecoded; the reading core owns decoding');
    assert.match(outcome.json.contentType ?? '', /application\/json/);
    assert.deepEqual(outcome.redirect, { status: 302, location: 'https://other.example/login' });
    assert.deepEqual(outcome.blocked, { status: 503, body: '<html>busy</html>' });
    assert.equal(outcome.big, 'transport-too-large');
    assert.equal(outcome.slow, 'transport-timeout');
    assert.ok(remote.seen.every((seen) => seen.method === 'GET' && seen.bodyBytes === 0), 'read-only: GET without a body');
    assert.ok(remote.seen.every((seen) => seen.jar === headers['Cookie'] && seen.agent === headers['User-Agent']));
    assert.equal(remote.seen.filter((seen) => seen.path === '/redirect').length, 1);
    assert.equal(remote.seen.some((seen) => seen.path.includes('login')), false, 'the redirect target is never requested');
  });
}

test('each platform has exactly one transport and there is no fallback between them', () => {
  assert.equal(platformTransport('win32'), windowsTransport);
  assert.equal(platformTransport('linux'), fetchTransport);
  assert.equal(platformTransport('darwin'), fetchTransport);
});

test('the Windows transport refuses to run elsewhere instead of switching transports', { skip: process.platform === 'win32' && 'non-Windows only' }, async () => {
  await assert.rejects(windowsTransport.get({ url: 'http://127.0.0.1:9/', headers }, limits), /transport-unavailable/);
});
