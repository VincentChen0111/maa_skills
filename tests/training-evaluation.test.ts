import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { trainingScenarios } from '../eval/maa-daily/training-scenarios.ts';

test('fixed training scenarios require actual installed CLI calls, preserve inputs, and retain unknown facts', async t => {
  for (const scenario of trainingScenarios) {
    const fixture = await createFixture({ skillDirectory: resolve('skills/maa-daily'), companionSkills: { 'maa-core': resolve('skills/maa-core') },
      jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => fixture.dispose());
    const invoke = (script: string, action: string, input: unknown) => spawnSync(process.execPath, [join(fixture.workspace, '.agents/skills/maa-core/scripts', script), action],
      { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8' });
    const preference = invoke('preferences.ts', 'read', { language: 'zh-CN' }); assert.equal(preference.status, 0);
    const read = scenario.id === 'training-contradiction';
    const output = invoke(read ? 'training-plan.ts' : 'training-time.ts', read ? 'read' : 'query', read ? { id: 'synthetic-plan' }
      : JSON.parse(await readFile(join(fixture.workspace, 'training-request.json'), 'utf8')));
    assert.equal(output.status, 0, output.stderr);
    const result = JSON.parse(output.stdout).result;
    if (scenario.id === 'training-active') assert.equal(result.stages[0].afterStartAssistant, 'char_helper');
    if (scenario.id === 'training-unknown') assert.equal(result.status, 'needs-input');
    if (scenario.id === 'training-material-shortage') assert.ok(result.materials.comparison.noCraft.materials.mat.remaining > 0);
    if (read) { assert.equal(result.state, 'failed'); assert.equal(result.startedAt, undefined); }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [output.stdout] });
    assert.deepEqual(evidence.changes, []);
    const policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    assert.equal(grade(policy, evidence).status, 'pass');
    assert.equal(grade(policy, { ...evidence, events: [] }).status, 'fail');
  }
});
