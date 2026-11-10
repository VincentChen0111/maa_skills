import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { accountScenarios } from '../eval/maa-account/scenarios.ts';

const skillDirectory = fileURLToPath(new URL('../skills/maa-account', import.meta.url));
const companionSkills = { 'maa-help': fileURLToPath(new URL('../skills/maa-help', import.meta.url)) };
test('both installed account layouts use a single sibling implementation for inspect and import', async (t) => {
  const scenario = accountScenarios[0]!;
  for (const host of ['.agents', '.claude']) {
    const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: scenario.jsonInputs });
    t.after(() => fixture.dispose());
    const license = await readFile(join(fixture.workspace, host, 'skills/maa-help/LICENSE'), 'utf8');
    assert.match(license, /Copyright \(c\) 2026 nhyo/);
    assert.match(license, /Permission is hereby granted/);
    assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
    const commands = [['preferences.ts', 'read', {}], ['account-snapshot.ts', 'inspect', { callbackFile: 'callbacks.json' }]] as const;
    const outputs: string[] = [];
    for (const [script, action, input] of commands) {
      const result = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-help/scripts', script), action], {
        cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr); outputs.push(result.stdout);
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs });
    assert.equal(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence).status, 'pass');
    const imported = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-help/scripts/account-snapshot.ts'), 'import'], {
      cwd: fixture.workspace, env: fixture.env, input: '{"callbackFile":"callbacks.json"}', encoding: 'utf8',
    });
    assert.equal(imported.status, 0, imported.stderr);
    const snapshot = JSON.parse(await readFile(join(fixture.workspace, 'private/account-snapshot.json'), 'utf8'));
    assert.equal(snapshot.items['30012'], 7);
    assert.equal(snapshot.operators[0].elite, null);
    assert.equal(snapshot.coverage.operators.status, 'partial');
  }
});
