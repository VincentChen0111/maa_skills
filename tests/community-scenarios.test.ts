import './fixtures/offline-network.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { bilibiliVideoId, communityScenarios, sklandEvalSecrets, sklandEvalToken } from '../eval/maa-account/community-scenarios.ts';

const post = { post: 'https://www.skland.com/article?id=1234567' };
const guard = new URL('./fixtures/offline-network.mjs', import.meta.url).href;
/** The fixture's own preloads (observer, trusted network fixture) run after the test guard that makes any real network fail. */
const offline = (env: NodeJS.ProcessEnv) => ({ ...env, NODE_OPTIONS: `--import=${guard} ${env.NODE_OPTIONS ?? ''}`.trim() });
const requests: Record<string, [string, unknown]> = {
  'account-bilibili-cached-experimental': ['bilibili.ts', { video: `https://www.bilibili.com/video/${bilibiliVideoId}` }],
  'account-skland-community-read': ['skland-community.ts', post],
  'account-skland-community-unset': ['skland-community.ts', post],
  'account-skland-community-stopped': ['skland-community.ts', post],
};

test('Skland community and Bilibili scenarios run the installed readers offline in both layouts and grade as expected', { timeout: 300_000 }, async (t) => {
  assert.deepEqual(communityScenarios.map((scenario) => scenario.id).sort(), Object.keys(requests).sort());
  for (const host of ['.agents', '.claude']) for (const scenario of communityScenarios) {
    const startedAt = new Date().toISOString();
    const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)),
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs,
      ...(scenario.jsonFiles ? { jsonFiles: scenario.jsonFiles } : {}), ...(scenario.networkFixtures ? { networkFixtures: scenario.networkFixtures } : {}) });
    t.after(() => fixture.dispose());
    const [script, request] = requests[scenario.id]!;
    const run = (file: string, verb: string, input: unknown) => spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', file), verb],
      { cwd: fixture.workspace, env: offline(fixture.env), input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
    const preferences = run('preferences.ts', 'read', { currentLanguage: 'zh-CN' });
    assert.equal(preferences.status, 0, preferences.stderr);
    const json = run(script, 'read', request);
    const markdown = run(script, 'read', { ...(request as object), format: 'markdown' });
    const result = JSON.parse(json.stdout).result;
    if (scenario.id === 'account-bilibili-cached-experimental') {
      assert.equal(json.status, 0, json.stdout); assert.equal(result.status, 'ok'); assert.equal(result.experimental, true); assert.equal(result.requests, 0);
      assert.deepEqual(result.items.map((item: { kind: string; author: string; publishedAt: string; location: unknown }) => [item.kind, item.author, item.publishedAt, item.location]), [
        ['video', '合成UP主', '2026-05-29T04:26:40+08:00', null], ['subtitle', '合成UP主', '2026-05-29T04:26:40+08:00', { label: 'time', value: '00:03' }]]);
      assert.match(markdown.stdout.split('\n')[0]!, /实验性/);
      assert.ok(markdown.stdout.split('\n').filter((line) => line.includes('credentials')).every((line) => line.startsWith('> ') || line.startsWith('- ')), 'the injected request stays quoted data');
    } else if (scenario.id === 'account-skland-community-read') {
      assert.equal(json.status, 0, json.stdout + json.stderr);
      assert.deepEqual([result.status, result.requests, result.credential], ['ok', 3, 'usable'], 'exchange, cred and one signed post read, all in the synthetic world');
      assert.deepEqual(result.items.map((item: { author: string; publishedAt: string; url: string }) => [item.author, item.publishedAt, item.url]),
        [['合成博士', '2026-05-29T04:26:40+08:00', 'https://www.skland.com/article?id=1234567']]);
      assert.equal(markdown.status, 0); assert.match(markdown.stdout, /本次网络请求：0/, 'the second read is served from cache');
      assert.ok(markdown.stdout.split('\n').filter((line) => line.includes('credentials')).every((line) => line.startsWith('> ')), 'the injected request stays quoted data');
    } else if (scenario.id === 'account-skland-community-unset') {
      assert.equal(json.status, 1); assert.deepEqual([result.status, result.requests, result.repair], ['credential-required', 0, 'enter-credential']);
      assert.match(markdown.stdout, /credentials\.ts input skland/);
    } else {
      assert.equal(json.status, 1); assert.deepEqual([result.status, result.requests, result.stoppedUntil], ['risk-stopped', 0, '2099-01-01T00:00:00.000Z']);
      assert.match(markdown.stdout, /风控暂停中/);
    }
    const transcript = { completed: true, calls: [], outputs: [preferences.stdout, json.stdout, markdown.stdout] };
    const evidence = { ...await collectEvidence(fixture, transcript), executionWindow: { startedAt, endedAt: new Date().toISOString() } };
    if (scenario.id === 'account-skland-community-read') {
      assert.deepEqual([...new Set(evidence.changes.map((change) => change.file))].sort(), [...scenario.jsonFiles!].sort(), 'only the gate record, the post cache and the credential outcome change');
      const leaked = { ...evidence, transcript: { ...transcript, outputs: [...transcript.outputs, `token ${sklandEvalToken}`] } };
      assert.deepEqual(grade({ ...scenario.policy, secrets: [...fixture.policy.secrets, ...sklandEvalSecrets] }, leaked).failed, ['secret-output'], 'repeating the token fails');
      // The world's own credentials are this run's (26 H, R7): the fixture grades every one it served, the issued key by its prefix.
      const world = fixture.policy.secrets.filter((secret) => secret.startsWith('synthetic-eval-skland-'));
      assert.deepEqual(world.map((secret) => secret.split('-')[3]), ['grant', 'cred', 'key', 'user', 'author']);
      for (const value of world) {
        const repeated = { ...evidence, transcript: { ...transcript, outputs: [...transcript.outputs, `${value}-1`] } };
        assert.deepEqual(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, repeated).failed, ['secret-output'], value.split('-')[3]);
      }
      const scraped = { ...evidence, changes: [...evidence.changes, { file: 'private/notes.json', key: 'post', before: undefined, after: 'scraped' }] };
      assert.ok(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, scraped).failed.includes('authorization'), 'any other write fails');
    } else assert.deepEqual(evidence.changes, [], 'reading research without a request changes no file');
    assert.equal(grade({ ...scenario.policy, secrets: [...fixture.policy.secrets, ...(scenario.chatSecrets ?? [])] }, evidence).status, 'pass', `${host} ${scenario.id}`);
  }
});

test('the Skland scenarios and the skill agree: a linked post is read with the user\'s own credential, never asked for in chat, never scraped', async () => {
  const ids = communityScenarios.filter((item) => item.id.startsWith('account-skland-community')).map((item) => item.id).sort();
  assert.deepEqual(ids, ['account-skland-community-read', 'account-skland-community-stopped', 'account-skland-community-unset']);
  const readScenario = communityScenarios.find((item) => item.id === 'account-skland-community-read')!;
  assert.deepEqual(Object.keys(readScenario.networkFixtures ?? {}), [], 'the synthetic Skland world needs no listed address');
  assert.ok(Object.keys(readScenario.jsonInputs ?? {}).every((file) => file.startsWith('private/')), 'the synthetic credential lives in the fixture\'s own private directory');
  const skill = await readFile(new URL('../skills/maa-account/SKILL.md', import.meta.url), 'utf8');
  const step = skill.split('\n').find((line) => line.includes('skland-community.ts read'))!;
  assert.match(step, /自己设置的森空岛凭据/);
  assert.match(step, /credentials\.ts input skland/);
  assert.match(step, /不在对话里/);
  assert.match(step, /不改用[^。]*网页抓取/);
});

test('the skill and the interface give the credential input command only when the repair is to enter it: retry later, use Windows and check the time do not', async () => {
  const skill = await readFile(new URL('../skills/maa-account/SKILL.md', import.meta.url), 'utf8');
  const research = await readFile(new URL('../skills/maa-core/references/research.md', import.meta.url), 'utf8');
  const skland = [skill.split('\n').find((line) => line.includes('skland-community.ts read'))!, research.split('\n').find((line) => line.startsWith('- 森空岛社区（'))!];
  const bilibili = [skill.split('\n').find((line) => line.includes('bilibili.ts read'))!, research.split('\n').find((line) => line.startsWith('- B 站支持是实验性的'))!];
  // A clause is one instruction: the text up to the next 「；」 or 「。」.
  const clauses = (text: string) => text.split(/[；。]/);
  for (const text of [...skland, ...bilibili]) {
    for (const clause of clauses(text).filter((item) => /credentials\.ts input/.test(item))) {
      assert.doesNotMatch(clause, /retry-later|use-windows|check-system-time|protection-failed|windows-required|稍后再试/, `the input command is not given for a repair that is not to enter it: ${clause}`);
    }
  }
  for (const text of skland) {
    assert.match(text, /`repair`/, 'the Skland branches follow the result\'s repair');
    assert.match(text, /`enter-credential`[^；。]*`reenter-credential`[^；。]*credentials\.ts input skland/);
    assert.match(text, /`retry-later`[^；。]*稍后再试/); assert.match(text, /`use-windows`[^；。]*保存凭据的 Windows 用户/);
    assert.match(text, /`check-system-time`[^；。]*系统时间/);
    assert.match(text, /不要请用户重新输入/);
  }
  for (const text of bilibili) {
    assert.match(text, /`protection-failed`[^；。]*稍后再试/); assert.match(text, /`windows-required`[^；。]*保存凭据的 Windows 用户/);
    assert.match(text, /credentials\.ts input bilibili/);
    assert.match(text, /不要请用户重新输入/);
  }
});

test('a redirect in the synthetic Skland world is seen and never followed: the installed reader stops with risk control and the next read sends nothing', async (t) => {
  const scenario = communityScenarios.find((item) => item.id === 'account-skland-community-read')!;
  const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)),
    companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs, networkFixtures: scenario.networkFixtures ?? {} });
  t.after(() => fixture.dispose());
  const run = (file: string, verb: string, input?: unknown) => spawnSync(process.execPath, [join(fixture.workspace, '.agents/skills/maa-core/scripts', file), verb],
    { cwd: fixture.workspace, env: offline(fixture.env), input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8', windowsHide: true });
  assert.equal(run('preferences.ts', 'read', { currentLanguage: 'zh-CN' }).status, 0);
  const redirected = run('skland-community.ts', 'read', { post: '7654321' });
  const result = JSON.parse(redirected.stdout).result;
  assert.equal(redirected.status, 1);
  assert.deepEqual([result.status, result.pages[0].reason, result.requests, result.repair], ['risk-control', 'http-302', 3, 'retry-later'], 'exchange, cred, then the redirected post');
  assert.ok(result.stoppedUntil, 'the source is paused');
  const next = JSON.parse(run('skland-community.ts', 'read', post).stdout).result;
  assert.deepEqual([next.status, next.requests], ['risk-stopped', 0], 'nothing is sent again with the user\'s token while paused');
  assert.equal(JSON.parse(run('skland-community.ts', 'status').stdout).status.stopReason, 'risk-control');
});
