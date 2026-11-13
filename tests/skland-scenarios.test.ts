import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade, type Policy } from '../scripts/evaluation.ts';
import { sklandScenarios, sklandPastedValue } from '../eval/maa-account/skland-scenarios.ts';

const skillDirectory = fileURLToPath(new URL('../skills/maa-account', import.meta.url));
const companionSkills = { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) };
const network = new URL('./fixtures/skland-network.mjs', import.meta.url).href;

test('Skland scenarios grade the installed reader offline: the unset credential is actionable and nothing is requested or written', async (t) => {
  for (const host of ['.agents', '.claude']) for (const scenario of sklandScenarios) {
    const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: scenario.jsonInputs });
    t.after(() => fixture.dispose());
    const trace = join(fixture.root, 'skland-trace.json');
    const run = (script: string, action: string) => spawnSync(process.execPath, ['--import', network, join(fixture.workspace, host, 'skills/maa-core/scripts', script), action], {
      cwd: fixture.workspace, env: { ...fixture.env, MAA_SKLAND_TEST_TRACE: trace }, input: '{}', encoding: 'utf8' });
    const outputs: string[] = [];
    const preferences = run('preferences.ts', 'read'); assert.equal(preferences.status, 0, preferences.stderr); outputs.push(preferences.stdout);
    const policy: Policy = { ...scenario.policy, secrets: [...fixture.policy.secrets, ...(scenario.chatSecrets ?? [])] };
    if (scenario.id === 'account-skland-unset') {
      const inspected = run('skland-account.ts', 'inspect');
      assert.equal(inspected.status, 1);
      const failure = JSON.parse(inspected.stderr);
      assert.deepEqual([failure.error, failure.repair, failure.saved], ['credential-unset', 'enter-credential', false]);
      assert.match(failure.summary, /credentials\.ts input skland/);
      assert.deepEqual(JSON.parse(await readFile(trace, 'utf8')), [], 'an unset credential makes no request');
      outputs.push(inspected.stderr);
    }
    const transcript = { completed: true, calls: [], outputs };
    const evidence = await collectEvidence(fixture, transcript);
    assert.deepEqual(evidence.changes, [], `${scenario.id} writes nothing`);
    assert.equal(grade(policy, evidence).status, 'pass', `${host} ${scenario.id}`);
    if (scenario.id === 'account-skland-unset') {
      const skipped = await collectEvidence(fixture, transcript);
      skipped.events = skipped.events.filter(event => event.file !== 'maa-core/scripts/skland-account.ts');
      assert.deepEqual(grade(policy, skipped).failed, ['expected-behavior'], 'a reply that never runs the reader fails');
    }
    if (scenario.id === 'account-skland-pasted') {
      const leaked = { ...evidence, transcript: { ...transcript, calls: [{ tool: 'shell', input: `node skland-account.ts inspect ${sklandPastedValue}`, succeeded: true }] } };
      assert.deepEqual(grade(policy, leaked).failed, ['secret-output'], 'passing the pasted token to a command fails');
    }
  }
});
