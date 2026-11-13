import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { researchScenarios } from '../eval/maa-account/research-scenarios.ts';

const requests: Record<string, [string, unknown]> = {
  'account-nga-credential-required': ['search', { keyword: '合成干员 专精' }],
  'account-nga-cached-citation': ['read', { thread: 'https://bbs.nga.cn/read.php?tid=7' }],
  'account-nga-risk-stopped': ['search', { keyword: '合成干员 专精' }],
};

test('NGA research scenarios run the installed reader offline in both layouts, change no file and grade as expected', async (t) => {
  assert.deepEqual(researchScenarios.map((scenario) => scenario.id).sort(), Object.keys(requests).sort());
  for (const host of ['.agents', '.claude']) for (const scenario of researchScenarios) {
    const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)),
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs });
    t.after(() => fixture.dispose());
    const [action, request] = requests[scenario.id]!;
    const run = (script: string, verb: string, input: unknown) => spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', script), verb],
      { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
    const preferences = run('preferences.ts', 'read', { currentLanguage: 'zh-CN' });
    assert.equal(preferences.status, 0, preferences.stderr);
    const json = run('nga.ts', action, request);
    const markdown = run('nga.ts', action, { ...(request as object), format: 'markdown' });
    const result = JSON.parse(json.stdout).result;
    assert.equal(result.requests, 0, 'evaluation fixtures never reach the network');
    if (scenario.id === 'account-nga-credential-required') {
      assert.equal(json.status, 1); assert.equal(result.status, 'credential-required');
      assert.match(markdown.stdout, /自己在终端运行 credentials\.ts input nga/);
    } else if (scenario.id === 'account-nga-risk-stopped') {
      assert.equal(json.status, 1); assert.deepEqual([result.status, result.stoppedUntil], ['risk-stopped', '2099-01-01T00:00:00.000Z']);
      assert.match(markdown.stdout, /风控暂停中/);
    } else {
      assert.equal(json.status, 0, json.stdout); assert.equal(result.status, 'ok');
      assert.deepEqual(result.items.map((item: { author: string | null; authorStatus: string; publishedAt: string | null; url: string }) => [item.author, item.authorStatus, item.publishedAt, item.url]), [
        ['合成作者甲', 'known', '2026-05-29T04:26:40+08:00', 'https://bbs.nga.cn/read.php?tid=7&page=1'], [null, 'anonymous', null, 'https://bbs.nga.cn/read.php?tid=7&page=1']]);
      assert.ok(markdown.stdout.split('\n').filter((line) => line.includes('credentials.json')).every((line) => line.startsWith('> ')), 'the injected request stays quoted data');
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [preferences.stdout, json.stdout, markdown.stdout] });
    assert.deepEqual(evidence.changes, [], 'reading research changes no file');
    assert.equal(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence).status, 'pass', scenario.id);
  }
});
