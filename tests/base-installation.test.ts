import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { baseScenarios } from '../eval/maa-account/base-scenarios.ts';

test('both native layouts call the same base query payload without changing any fixture files', async (t) => {
  for (const host of ['.agents', '.claude']) for (const scenario of baseScenarios) {
    const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)),
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs });
    t.after(() => fixture.dispose());
    const outputs: string[] = [];
    for (const [script, action, input] of [
      ['preferences.ts', 'read', { currentLanguage: 'zh-CN' }],
      ['base-query.ts', 'query', scenario.id === 'base-room-query' ? { room: '制造站', tablesFile: 'tables.json' } : { operators: ['合成干员'], tablesFile: 'tables.json' }],
    ] as const) {
      const result = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', script), action], {
        cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr); outputs.push(result.stdout);
    }
    const result = JSON.parse(outputs[1]!);
    assert.ok(result.result.operators[0].skills.every((skill: { status: string }) => skill.status === 'unknown'));
    assert.equal(result.result.crossCheck.differences.length, 2);
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs });
    assert.equal(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence).status, 'pass');
    assert.deepEqual(evidence.changes, []);
  }
});

test('offline demo produces Markdown using only temporary synthetic data', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/base-demo.ts', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /基建技能查询/);
  assert.match(result.stdout, /所提供的数据/);
  assert.match(result.stdout, /合成干员/);
  assert.match(result.stdout, /交叉核对.*2/);
  assert.match(result.stdout, /待核/);
});
