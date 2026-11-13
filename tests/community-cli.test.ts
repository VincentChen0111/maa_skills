import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { biliError, playerPayload, sklandError, sklandItemPayload, subtitleFile, videoPayload } from './fixtures/community-data.ts';

const core = fileURLToPath(new URL('../skills/maa-core', import.meta.url));
const loaders = ['--import', new URL('./fixtures/credential-boundary.mjs', import.meta.url).href, '--import', new URL('./fixtures/community-boundary.mjs', import.meta.url).href];

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
  const input = spawnSync(process.execPath, [loaders[0]!, loaders[1]!, join(core, 'scripts/credentials.ts'), 'input', 'bilibili', '--stdin'],
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

test('the Skland community CLI reads one named public post anonymously and reports a signature demand without imitating the client', { timeout: 180_000 }, async (t) => {
  const f = await setup(t, 'en');
  await f.routes({
    'https://zonai.skland.com/web/v2/item?id=1234567': { status: 200, payload: sklandItemPayload({ id: '1234567', title: '合成干员培养心得', slices: ['合成干员建议先专精三技能。'] }) },
    'https://zonai.skland.com/web/v2/item?id=7654321': { status: 401, payload: sklandError(10000, '请求异常') },
  });
  const read = await cli(f, 'skland-community.ts', 'read', { post: 'https://www.skland.com/article?id=1234567', format: 'markdown' });
  assert.equal(read.code, 0, read.stdout + read.stderr);
  assert.match(read.stdout, /^# 森空岛社区 \/ Skland community$/m);
  assert.match(read.stdout, /- Source: https:\/\/www\.skland\.com\/article\?id=1234567/); assert.match(read.stdout, /> 合成干员建议先专精三技能。/);
  assert.deepEqual((await f.journal()).map((request) => request.headers), [['Accept', 'User-Agent']], 'no credential, cookie, signature or device header');
  for (const action of ['post', 'like', 'comment', 'search']) {
    const run = await cli(f, 'skland-community.ts', action, { post: '1234567' });
    assert.deepEqual([run.code, JSON.parse(run.stdout)], [1, { ok: false, error: 'request-invalid' }], action);
  }
  const refused = await cli(f, 'skland-community.ts', 'read', { post: '7654321' });
  assert.equal(refused.code, 1);
  const result = JSON.parse(refused.stdout).result;
  assert.deepEqual([result.status, result.pages[0].reason, result.items.length], ['risk-control', 'signature-required', 0]);
  const status = JSON.parse((await cli(f, 'skland-community.ts', 'status')).stdout).status;
  assert.deepEqual([status.stopped, status.stopReason], [true, 'risk-control']);
  assert.equal((await f.journal()).length, 2);
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
