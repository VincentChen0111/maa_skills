import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { costScenarios } from '../eval/maa-account/cost-scenarios.ts';

test('cost scenarios execute installed product CLI against the frozen synthetic network with no filesystem writes', async () => {
  for (const scenario of costScenarios) {
    const fixture = await createFixture({ skillDirectory: resolve('skills/maa-account'), companionSkills: { 'maa-core': resolve('skills/maa-core') }, jsonInputs: scenario.jsonInputs, networkFixtures: scenario.networkFixtures });
    try {
      for (const host of ['.agents', '.claude']) {
        const request = { name: '合成干员', target: { elite: scenario.id.endsWith('raw') || scenario.id.endsWith('no-craft') ? 2 : 1, level: scenario.id.endsWith('raw') || scenario.id.endsWith('no-craft') ? 2 : 1 }, mode: scenario.id.endsWith('no-craft') ? 'no-craft' : 'raw' };
        const execution = spawnSync(process.execPath, [`${host}/skills/maa-core/scripts/operator-cost.ts`, 'query'], { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(request), encoding: 'utf8' });
        assert.equal(execution.status, 0, execution.stderr); const result = JSON.parse(execution.stdout);
        assert.equal(result.status, scenario.id.endsWith('unknown') || scenario.id.endsWith('ambiguous') ? 'needs-input' : 'ok');
        if (result.status === 'ok') assert.deepEqual(result.total, { materials: { mat: 6 }, lmd: 314, exp: 140 });
        else assert.equal(result.total, null);
        if (scenario.id.endsWith('no-craft')) { assert.equal(result.inventory.materials.mat.deficit, 1); assert.equal(result.inventory.exp.deficit, null); }
        assert.equal(result.sources.length, 7);
      }
      const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
      assert.deepEqual(evidence.changes, []); assert.equal(evidence.events.length, 2);
    } finally { await fixture.dispose(); }
  }
});
