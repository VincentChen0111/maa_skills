import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade, type Policy } from '../scripts/evaluation.ts';
import { accountScenarios } from '../eval/maa-account/scenarios.ts';

const skillDirectory = fileURLToPath(new URL('../skills/maa-account', import.meta.url));
const companionSkills = { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) };
test('both installed account layouts use a single sibling implementation for inspect and import', async (t) => {
  const scenario = accountScenarios[0]!;
  for (const host of ['.agents', '.claude']) {
    const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: scenario.jsonInputs });
    t.after(() => fixture.dispose());
    const license = await readFile(join(fixture.workspace, host, 'skills/maa-core/LICENSE'), 'utf8');
    assert.match(license, /Copyright \(c\) 2026 VincentChen0111/);
    assert.match(license, /Copyright \(c\) 2026 nhyo/);
    assert.match(license, /Permission is hereby granted/);
    assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
    const commands = [['preferences.ts', 'read', {}], ['account-snapshot.ts', 'inspect', { callbackFile: 'callbacks.json' }]] as const;
    const outputs: string[] = [];
    for (const [script, action, input] of commands) {
      const result = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', script), action], {
        cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr); outputs.push(result.stdout);
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs });
    assert.equal(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence).status, 'pass');
    const imported = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts/account-snapshot.ts'), 'import'], {
      cwd: fixture.workspace, env: fixture.env, input: '{"callbackFile":"callbacks.json"}', encoding: 'utf8',
    });
    assert.equal(imported.status, 0, imported.stderr);
    const snapshot = JSON.parse(await readFile(join(fixture.workspace, 'private/account-snapshot.json'), 'utf8'));
    assert.equal(snapshot.items['30012'], 7);
    assert.equal(snapshot.operators[0].elite, null);
    assert.equal(snapshot.coverage.operators.status, 'partial');
  }
});

// 26 P2: the boundary scenario's two real failures. R4 (final candidate): a correct refusal sent before the preference read.
// R6 (older payload): the MAA config patched directly to turn gacha on, with no approval, lock or writer.
test('account-boundary passes a refusal that read preferences first, and fails one that skipped the read or patched gacha into the MAA config', async (t) => {
  const scenario = accountScenarios.find(value => value.id === 'account-boundary');
  assert.ok(scenario, 'the boundary scenario is required');
  for (const host of ['.agents', '.claude']) {
    const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => fixture.dispose());
    const policy: Policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    const reply = async (outputs: string[]) => grade(policy, await collectEvidence(fixture, { completed: true, calls: [], outputs }));
    assert.deepEqual((await reply([])).failed, ['expected-behavior'], 'a refusal without the preference read fails');
    const read = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts/preferences.ts'), 'read'], {
      cwd: fixture.workspace, env: fixture.env, input: '{"currentLanguage":"zh-CN"}', encoding: 'utf8',
    });
    assert.equal(read.status, 0, read.stderr);
    assert.equal((await reply([read.stdout])).status, 'pass');
    const config = join(fixture.workspace, 'maa/config.json');
    await writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config, 'utf8')), gacha: true }));
    assert.deepEqual((await reply([read.stdout])).failed, ['authorization', 'write-lock', 'allowed-keys', 'forbidden-settings']);
  }
});

test('the import scenario grades real CLI output and rejects altered snapshots or missing invocations', async (t) => {
  const scenario = accountScenarios.find(value => value.id === 'account-import');
  assert.ok(scenario, 'a positive import scenario is required');
  for (const host of ['.agents', '.claude']) {
    const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => fixture.dispose());
    const bypass = await createFixture({ skillDirectory, companionSkills, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => bypass.dispose());
    const policy: Policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    const startedAt = new Date().toISOString();
    const outputs: string[] = [];
    for (const [script, action, input] of [
      ['preferences.ts', 'read', {}],
      ['account-snapshot.ts', 'inspect', { callbackFile: 'callbacks.json' }],
      ['account-snapshot.ts', 'import', { callbackFile: 'callbacks.json' }],
    ] as const) {
      const execution = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', script), action], {
        cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8',
      });
      assert.equal(execution.status, 0, execution.stderr); outputs.push(execution.stdout);
    }
    const target = join(fixture.workspace, 'private/account-snapshot.json');
    const saved = await readFile(target, 'utf8');
    await writeFile(join(bypass.workspace, 'private/account-snapshot.json'), saved);
    const executionWindow = { startedAt, endedAt: new Date().toISOString() };
    const transcript = { completed: true, calls: [], outputs };
    const observe = async () => ({ ...await collectEvidence(fixture, transcript), executionWindow });
    const evidence = await observe();
    assert.equal(grade(policy, evidence).status, 'pass');
    const bypassGrade = grade(policy, { ...await collectEvidence(bypass, transcript), executionWindow });
    assert.deepEqual(bypassGrade.failed, ['expected-behavior'], 'the same file written without product CLI invocations fails');
    const snapshot = JSON.parse(saved);
    for (const altered of [
      { ...snapshot, readAt: new Date(Date.parse(startedAt) - 1).toISOString() },
      { ...snapshot, readAt: new Date(Date.parse(executionWindow.endedAt) + 1).toISOString() },
      { ...snapshot, readAt: 'not-a-time' }, { ...snapshot, readAt: undefined },
      { ...snapshot, lmd: 0 }, { ...snapshot, injected: true }, { ...snapshot, source: undefined },
    ]) {
      await writeFile(target, JSON.stringify(altered));
      assert.equal(grade(policy, await observe()).status, 'fail');
    }
    await unlink(target);
    assert.equal(grade(policy, await observe()).status, 'fail');
    await writeFile(target, JSON.stringify(snapshot));
    await writeFile(join(fixture.workspace, 'private/other.json'), '{}');
    assert.equal(grade(policy, await observe()).status, 'fail');
  }
});
