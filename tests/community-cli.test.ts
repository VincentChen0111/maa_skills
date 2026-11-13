import './fixtures/offline-network.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { biliError, playerPayload, subtitleFile, videoPayload } from './fixtures/community-data.ts';
import { sklandSecrets } from './fixtures/skland-data.ts';

const core = fileURLToPath(new URL('../skills/maa-core', import.meta.url));
/** Every spawned CLI also loads the test guard, so a request that no double answers fails instead of reaching a real service. */
const guard = ['--import', new URL('./fixtures/offline-network.mjs', import.meta.url).href];
const loaders = ['--import', new URL('./fixtures/credential-boundary.mjs', import.meta.url).href, '--import', new URL('./fixtures/community-boundary.mjs', import.meta.url).href, ...guard];

async function setup(t: { after(fn: () => Promise<unknown>): void }, language: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maa-community-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'settings'); const privateDirectory = join(root, 'private');
  await updateSettings({ language, privateDirectory }, home);
  const env = { ...process.env, MAA_SKILLS_HOME: home, MAA_CREDENTIAL_TEST_CORE: core, MAA_RESEARCH_TEST_CORE: core,
    MAA_RESEARCH_TEST_ROUTES: join(root, 'routes.json'), MAA_RESEARCH_TEST_JOURNAL: join(root, 'requests.jsonl') };
  const routes = async (value: Record<string, { status: number; payload: unknown }>) => writeFile(env.MAA_RESEARCH_TEST_ROUTES,
    JSON.stringify(Object.fromEntries(Object.entries(value).map(([url, route]) => [url, { status: route.status, body: Buffer.from(JSON.stringify(route.payload)).toString('base64') }]))));
  const journal = async () => (await readFile(env.MAA_RESEARCH_TEST_JOURNAL, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { url: string; headers: string[]; jar: string | null });
  return { root, privateDirectory, env, routes, journal };
}
type Run = { code: number | null; stdout: string; stderr: string };
function cli(f: { env: NodeJS.ProcessEnv }, script: string, action: string, request?: unknown): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...loaders, join(core, 'scripts', script), action], { env: f.env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(request === undefined ? '' : JSON.stringify(request));
  });
}
async function everything(directory: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    text += entry.isDirectory() ? await everything(path) : (await readFile(path)).toString('latin1');
  }
  return text;
}

const bvid = 'BV1Sy4y1x7Kt';
test('the Bilibili CLI marks every answer experimental, sends the user\'s SESSDATA only to the player request and offers no search', { timeout: 180_000 }, async (t) => {
  const f = await setup(t, 'zh-CN');
  const sessdata = `synthetic-sessdata-${randomUUID()}`;
  const input = spawnSync(process.execPath, [loaders[0]!, loaders[1]!, ...guard, join(core, 'scripts/credentials.ts'), 'input', 'bilibili', '--stdin'],
    { env: f.env, input: `y\n${sessdata}\n`, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(input.status, 0, input.stdout + input.stderr);
  await f.routes({
    [`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`]: { status: 200, payload: videoPayload({ bvid, aid: 9001, title: '合成干员专精推荐', desc: '合成简介' }) },
    [`https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=5001`]: { status: 200, payload: playerPayload({ loginMid: 1, tracks: [{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: '//i0.hdslb.com/bfs/subtitle/synthetic.json' }] }) },
    'https://i0.hdslb.com/bfs/subtitle/synthetic.json': { status: 200, payload: subtitleFile([{ from: 12, content: '三技能专精收益最高。' }]) },
    'https://api.bilibili.com/x/web-interface/view?bvid=BV1Ab4y1x7Kt': { status: 200, payload: biliError(-412, '请求被拦截') },
  });
  const read = await cli(f, 'bilibili.ts', 'read', { video: `https://www.bilibili.com/video/${bvid}/` });
  assert.equal(read.code, 0, read.stdout + read.stderr);
  const output = JSON.parse(read.stdout);
  assert.equal(output.experimental, true); assert.equal(output.result.experimental, true); assert.equal(output.result.status, 'ok');
  assert.match(output.result.notice, /experimental/);
  const requests = await f.journal();
  assert.deepEqual(requests.map((request) => [new URL(request.url).host, request.jar !== null]), [['api.bilibili.com', false], ['api.bilibili.com', true], ['i0.hdslb.com', false]]);
  assert.equal(requests[1]!.jar, createHash('sha256').update(`SESSDATA=${sessdata}`).digest('hex'), 'the saved value reached the player request unchanged');
  const markdown = await cli(f, 'bilibili.ts', 'read', { video: bvid, format: 'markdown' });
  assert.equal(markdown.code, 0, markdown.stdout + markdown.stderr);
  assert.match(markdown.stdout.split('\n')[0]!, /^# Bilibili（实验性）$/);
  assert.match(markdown.stdout, /B 站支持是实验性的/); assert.match(markdown.stdout, /> 三技能专精收益最高。/);
  assert.equal((await f.journal()).length, 3, 'the second run is served from cache');
  const status = JSON.parse((await cli(f, 'bilibili.ts', 'status')).stdout);
  assert.deepEqual([status.ok, status.experimental, status.status.experimental, status.status.credential], [true, true, true, 'usable']);
  for (const [action, request] of [['search', { keyword: '合成干员' }], ['read', { video: 'https://b23.tv/synthetic' }], ['like', { video: bvid }]] as const) {
    const run = await cli(f, 'bilibili.ts', action, request);
    assert.deepEqual([run.code, JSON.parse(run.stdout)], [1, { ok: false, experimental: true, error: 'request-invalid' }], action);
  }
  const blocked = await cli(f, 'bilibili.ts', 'read', { video: 'BV1Ab4y1x7Kt', format: 'markdown' });
  assert.equal(blocked.code, 1);
  assert.match(blocked.stdout, /遇到风控/);
  for (const run of [read, markdown, blocked]) assert.equal((run.stdout + run.stderr).includes(sessdata), false);
  assert.equal((await everything(join(f.privateDirectory, 'research'))).includes(sessdata), false, 'cache and gate files hold no credential');
});

const sklandLoaders = ['--import', new URL('./fixtures/credential-boundary.mjs', import.meta.url).href, '--import', new URL('./fixtures/skland-network.mjs', import.meta.url).href, ...guard];
/** One Skland community CLI run against the Skland network double; returns the run and the requests the double saw. */
function sklandCli(f: { root: string; env: NodeJS.ProcessEnv }, action: string, request: unknown, steps: Record<string, unknown[]> = {}) {
  const scenario = join(f.root, `skland-${randomUUID()}.json`), trace = `${scenario}.trace`;
  writeFileSync(scenario, JSON.stringify({ steps }));
  const run = spawnSync(process.execPath, [...sklandLoaders, join(core, 'scripts/skland-community.ts'), action], { env: { ...f.env, MAA_SKLAND_TEST_SCENARIO: scenario, MAA_SKLAND_TEST_TRACE: trace },
    input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  let requests: { kind: string; method: string; path: string }[] = [];
  try { requests = JSON.parse(readFileSync(trace, 'utf8')); } catch { /* no process exit record */ }
  return { code: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', requests };
}
test('the Skland community CLI reads one named post with the user\'s own Skland credential, reports refusals with a repair and prints no secret', { timeout: 180_000 }, async (t) => {
  const f = await setup(t, 'en');
  const unset = sklandCli(f, 'read', { post: '1234567', format: 'markdown' });
  assert.equal(unset.code, 1);
  assert.match(unset.stdout, /credentials\.ts input skland/, 'an unset credential says how the user sets it');
  assert.deepEqual(unset.requests, [], 'no anonymous attempt');
  const input = spawnSync(process.execPath, [sklandLoaders[0]!, sklandLoaders[1]!, ...guard, join(core, 'scripts/credentials.ts'), 'input', 'skland', '--stdin'],
    { env: f.env, input: `y\n${sklandSecrets.userValue}\n`, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(input.status, 0, input.stdout + input.stderr);
  assert.match(input.stdout, /community/, 'the consent text says the token also reads community posts the user links');

  const read = sklandCli(f, 'read', { post: 'https://www.skland.com/article?id=1234567' });
  assert.equal(read.code, 0, read.stdout + read.stderr);
  const result = JSON.parse(read.stdout).result;
  assert.deepEqual([result.status, result.requests, result.credential, result.repair], ['ok', 3, 'usable', null]);
  assert.deepEqual(read.requests.map((request) => `${request.kind} ${request.method} ${request.path}`),
    ['grant POST /user/oauth2/v2/grant', 'cred POST /api/v1/user/auth/generate_cred_by_code', 'item GET /web/v2/item']);
  const markdown = sklandCli(f, 'read', { post: '1234567', format: 'markdown' });
  assert.equal(markdown.code, 0, markdown.stdout + markdown.stderr);
  assert.match(markdown.stdout, /^# 森空岛社区 \/ Skland community$/m);
  assert.match(markdown.stdout, /- Source: https:\/\/www\.skland\.com\/article\?id=1234567/); assert.match(markdown.stdout, /> 合成干员建议先专精三技能。/);
  assert.deepEqual(markdown.requests, [], 'the second run is served from cache');
  for (const action of ['post', 'like', 'comment', 'search']) {
    const run = sklandCli(f, action, { post: '1234567' });
    assert.deepEqual([run.code, JSON.parse(run.stdout), run.requests], [1, { ok: false, error: 'request-invalid' }, []], action);
  }
  const refused = sklandCli(f, 'read', { post: '7654321' }, { item: [{ code: 10000 }] });
  assert.equal(refused.code, 1);
  const rejected = JSON.parse(refused.stdout).result;
  assert.deepEqual([rejected.status, rejected.repair, rejected.credential, rejected.items.length], ['signature-rejected', 'check-system-time', 'unchanged', 0]);
  const throttled = sklandCli(f, 'read', { post: '7654321', format: 'markdown' }, { item: [{ http: 429 }] });
  assert.equal(throttled.code, 1);
  assert.match(throttled.stdout, /risk control hit/);
  const status = JSON.parse(sklandCli(f, 'status', {}).stdout).status;
  assert.deepEqual([status.stopped, status.stopReason, status.credential], [true, 'risk-control', 'usable']);
  for (const run of [unset, read, markdown, refused, throttled]) {
    for (const value of [sklandSecrets.userValue, sklandSecrets.grantCode, sklandSecrets.cred, sklandSecrets.signKey, sklandSecrets.userId]) {
      assert.equal((run.stdout + run.stderr).includes(value), false);
    }
  }
  const saved = await everything(join(f.privateDirectory, 'research'));
  for (const value of [sklandSecrets.userValue, sklandSecrets.grantCode, sklandSecrets.cred, sklandSecrets.signKey, sklandSecrets.userId, '987654321']) {
    assert.equal(saved.includes(value), false, 'cache and gate files hold no secret or account identifier');
  }
});

test('every user entry for Bilibili research says it is experimental', async () => {
  const files = ['README.md', 'skills/maa-help/SKILL.md', 'skills/maa-account/SKILL.md', 'skills/maa-core/SKILL.md', 'skills/maa-core/references/research.md'];
  let mentions = 0;
  for (const file of files) {
    const text = await readFile(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
    for (const line of text.split('\n').filter((item) => /B 站|Bilibili|bilibili\.ts/.test(item))) {
      mentions += 1;
      assert.match(line, /实验性|experimental/, `${file}: ${line.slice(0, 80)}`);
    }
  }
  assert.ok(mentions >= 5, 'help, account, core and the interface all describe the Bilibili entry');
});
