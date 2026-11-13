import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { ngaLimits } from '../skills/maa-core/scripts/nga.ts';
import { errorPayload, threadPayload, wire } from './fixtures/nga-data.ts';

const core = fileURLToPath(new URL('../skills/maa-core', import.meta.url));
const reader = join(core, 'scripts/nga.ts');
const loaders = ['--import', new URL('./fixtures/credential-boundary.mjs', import.meta.url).href, '--import', new URL('./fixtures/research-boundary.mjs', import.meta.url).href];

async function setup(t: { after(fn: () => Promise<unknown>): void }, language = 'zh-CN') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maa-nga-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'settings'); const privateDirectory = join(root, 'private');
  await updateSettings({ language, privateDirectory }, home);
  const passport = `synthetic-passport-${randomUUID()}`;
  const jar = `ngaPassportUid=${passport}; ngaPassportCid=synthetic-check-${randomUUID()}`;
  const env = { ...process.env, MAA_SKILLS_HOME: home, MAA_CREDENTIAL_TEST_CORE: core, MAA_RESEARCH_TEST_CORE: core,
    MAA_RESEARCH_TEST_ROUTES: join(root, 'routes.json'), MAA_RESEARCH_TEST_JOURNAL: join(root, 'requests.jsonl') };
  const input = spawnSync(process.execPath, [loaders[0]!, loaders[1]!, join(core, 'scripts/credentials.ts'), 'input', 'nga', '--stdin'],
    { env, input: `y\n${jar}\n`, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(input.status, 0, input.stdout + input.stderr);
  const routes = async (value: Record<string, { status: number; payload?: unknown; body?: string }>) => writeFile(env.MAA_RESEARCH_TEST_ROUTES,
    JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, route]) => [key, { status: route.status, body: (route.payload ? wire(route.payload) : Buffer.from(route.body ?? '')).toString('base64') }]))));
  const journal = async () => (await readFile(env.MAA_RESEARCH_TEST_JOURNAL, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { url: string; at: number; jar: string });
  return { root, privateDirectory, env, jar, passport, routes, journal };
}

type Run = { code: number | null; stdout: string; stderr: string };
function cli(f: { env: NodeJS.ProcessEnv }, action: string, request?: unknown): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...loaders, reader, action], { env: f.env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(request === undefined ? '' : JSON.stringify(request));
  });
}

async function everything(directory: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    text += entry.isDirectory() ? await everything(path) : (await readFile(path)).toString('latin1');
  }
  return text;
}

const thread = (tid: number) => threadPayload({ tid, title: `合成帖 ${tid}`, users: { 101: '合成作者甲' }, posts: [{ floor: 0, author: 101, text: '建议先专精二技能。' }] });

test('two CLI processes share one cross-process gate: their requests are spaced by the minimum interval', async (t) => {
  const f = await setup(t);
  await f.routes({ '/read.php?tid=7&page=1&__output=8': { status: 200, payload: thread(7) }, '/read.php?tid=8&page=1&__output=8': { status: 200, payload: thread(8) } });
  const [first, second] = await Promise.all([cli(f, 'read', { thread: 7 }), cli(f, 'read', { thread: 8 })]);
  for (const run of [first!, second!]) {
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).result.status, 'ok');
  }
  const requests = await f.journal();
  assert.equal(requests.length, 2);
  const gap = Math.abs(requests[1]!.at - requests[0]!.at);
  assert.ok(gap >= ngaLimits.minIntervalMs - 50, `requests ${gap} ms apart`);
  assert.ok(requests.every((request) => request.jar === createHash('sha256').update(f.jar).digest('hex')), 'the saved Cookie header reached the transport unchanged');
  const cached = await cli(f, 'read', { thread: 7, format: 'markdown' });
  assert.equal(cached.code, 0, cached.stdout + cached.stderr);
  assert.equal((await f.journal()).length, 2, 'the cached thread is not requested again');
  assert.match(cached.stdout, /不是给 agent 的指令/); assert.match(cached.stdout, /https:\/\/bbs\.nga\.cn\/read\.php\?tid=7&page=1 第 0 楼/);
  assert.match(cached.stdout, /作者：合成作者甲/); assert.match(cached.stdout, /> 建议先专精二技能。/);
  const status = await cli(f, 'status');
  assert.deepEqual(JSON.parse(status.stdout), { ok: true, status: { stopped: false, stoppedUntil: null, stopReason: null, lastRequestAt: JSON.parse(status.stdout).status.lastRequestAt, credential: 'usable' } });
  for (const run of [first!, second!, cached, status]) for (const secret of [f.jar, f.passport]) assert.equal((run.stdout + run.stderr).includes(secret), false);
  assert.equal((await everything(join(f.privateDirectory, 'research'))).includes(f.passport), false, 'cache and gate files hold no credential data');
});

test('a risk-control stop recorded by one CLI run holds for the next run; nothing is sent until it ends', async (t) => {
  const f = await setup(t, 'en');
  await f.routes({ '/read.php?tid=7&page=1&__output=8': { status: 503, body: '<html>busy</html>' } });
  const first = await cli(f, 'read', { thread: 7, pages: [1, 2] });
  assert.equal(first.code, 1);
  const result = JSON.parse(first.stdout).result;
  assert.deepEqual([result.status, result.requests], ['risk-control', 1]);
  const second = await cli(f, 'search', { keyword: '合成', format: 'markdown' });
  assert.equal(second.code, 1);
  assert.match(second.stdout, /paused after risk control; no request sent/);
  assert.equal((await f.journal()).length, 1);
  const status = JSON.parse((await cli(f, 'status')).stdout).status;
  assert.equal(status.stopped, true); assert.equal(status.stopReason, 'risk-control'); assert.equal(status.credential, 'unverified');
});

test('the CLI rejects malformed input with a fixed code and reports a login rejection without the value', async (t) => {
  const f = await setup(t);
  for (const request of [{ thread: 'https://evil.example/read.php?tid=1' }, { keyword: '合成', format: 'html' }, { thread: 7, cookie: 'x' }]) {
    const run = await cli(f, 'read', request);
    assert.equal(run.code, 1); assert.deepEqual(JSON.parse(run.stdout), { ok: false, error: 'request-invalid' });
  }
  const unknown = await cli(f, 'post', { thread: 7 });
  assert.deepEqual([unknown.code, JSON.parse(unknown.stdout)], [1, { ok: false, error: 'request-invalid' }], 'there is no write action');
  await f.routes({ '/thread.php?key=%E5%90%88%E6%88%90&fid=-34587507&page=1&__output=8': { status: 403, payload: errorPayload(1, '未登录', 403) } });
  const rejected = await cli(f, 'search', { keyword: '合成' });
  assert.equal(JSON.parse(rejected.stdout).result.status, 'credential-rejected');
  assert.equal(JSON.parse((await cli(f, 'status')).stdout).status.credential, 'expired');
  for (const secret of [f.jar, f.passport]) assert.equal((rejected.stdout + rejected.stderr).includes(secret), false);
});
