import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { helpScenarios } from '../eval/maa-help/scenarios.ts';

test('both temporary native layouts can execute the single packaged preferences implementation', async (t) => {
  const skillDirectory = fileURLToPath(new URL('../skills/maa-help', import.meta.url));
  const scenario = helpScenarios[0]!;
  for (const host of ['.agents', '.claude']) {
    const fixture = await createFixture({ skillDirectory, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => fixture.dispose());
    const script = join(fixture.workspace, host, 'skills/subject/scripts/preferences.ts');
    const outputs: string[] = [];
    for (const [action, input] of [
      ['read', { currentLanguage: 'zh-CN' }],
      ['set', { language: 'en' }],
      ['append', { date: '2026-11-10T06:00:00.000Z', source: 'synthetic-help-case', text: '以后用英文' }],
    ] as const) {
      const result = spawnSync(process.execPath, [script, action], { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      outputs.push(result.stdout);
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs });
    assert.equal(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence).status, 'pass');
  }
});
