import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { bilibiliVideoId, communityScenarios } from '../eval/maa-account/community-scenarios.ts';

const requests: Record<string, [string, unknown]> = {
  'account-bilibili-cached-experimental': ['bilibili.ts', { video: `https://www.bilibili.com/video/${bilibiliVideoId}` }],
  'account-skland-community-stopped': ['skland-community.ts', { post: 'https://www.skland.com/article?id=1234567' }],
};

test('Skland community and Bilibili scenarios run the installed readers offline in both layouts, change no file and grade as expected', async (t) => {
  assert.deepEqual(communityScenarios.map((scenario) => scenario.id).sort(), Object.keys(requests).sort());
  for (const host of ['.agents', '.claude']) for (const scenario of communityScenarios) {
    const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)),
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs });
    t.after(() => fixture.dispose());
    const [script, request] = requests[scenario.id]!;
    const run = (file: string, verb: string, input: unknown) => spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', file), verb],
      { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
    const preferences = run('preferences.ts', 'read', { currentLanguage: 'zh-CN' });
    assert.equal(preferences.status, 0, preferences.stderr);
    const json = run(script, 'read', request);
    const markdown = run(script, 'read', { ...(request as object), format: 'markdown' });
    const result = JSON.parse(json.stdout).result;
    assert.equal(result.requests, 0, 'evaluation fixtures never reach the network');
    if (scenario.id === 'account-bilibili-cached-experimental') {
      assert.equal(json.status, 0, json.stdout); assert.equal(result.status, 'ok'); assert.equal(result.experimental, true);
      assert.deepEqual(result.items.map((item: { kind: string; author: string; publishedAt: string; location: unknown }) => [item.kind, item.author, item.publishedAt, item.location]), [
        ['video', '合成UP主', '2026-05-29T04:26:40+08:00', null], ['subtitle', '合成UP主', '2026-05-29T04:26:40+08:00', { label: 'time', value: '00:03' }]]);
      assert.match(markdown.stdout.split('\n')[0]!, /实验性/);
      assert.ok(markdown.stdout.split('\n').filter((line) => line.includes('credentials')).every((line) => line.startsWith('> ') || line.startsWith('- ')), 'the injected request stays quoted data');
    } else {
      assert.equal(json.status, 1); assert.deepEqual([result.status, result.stoppedUntil], ['risk-stopped', '2099-01-01T00:00:00.000Z']);
      assert.match(markdown.stdout, /风控暂停中/);
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [preferences.stdout, json.stdout, markdown.stdout] });
    assert.deepEqual(evidence.changes, [], 'reading research changes no file');
    assert.equal(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence).status, 'pass', scenario.id);
  }
});
