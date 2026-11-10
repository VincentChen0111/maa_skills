import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { gapScenarios } from '../eval/maa-account/gap-scenarios.ts';
import { gapGoal, gapProgress } from './fixtures/gap-data.ts';

test('gap scenarios exercise real product queries on synthetic FS/network without inventing model completion', async t => {
  for (const scenario of gapScenarios) {
    const fixture = await createFixture({ skillDirectory: resolve('skills/maa-account'), companionSkills: { 'maa-core': resolve('skills/maa-core') },
      jsonInputs: scenario.jsonInputs, networkFixtures: scenario.networkFixtures }); t.after(() => fixture.dispose());
    fixture.policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    const invoke = (name: string, input: unknown, flags: string[] = []) => spawnSync(process.execPath, [`.agents/skills/maa-core/scripts/${name}.ts`, name === 'preferences' ? 'read' : 'query', ...flags], {
      cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8',
    });
    assert.equal(invoke('preferences', { currentLanguage: 'zh-CN' }).status, 0);
    const shared = scenario.id.endsWith('shared-stock'), unknown = scenario.id.endsWith('unknown-progress'), noCraft = scenario.id.endsWith('no-craft');
    const query = invoke('cultivation-gaps', { targets: shared ? [gapGoal, { ...gapGoal, name: '合成二号' }] : [gapGoal], progress: unknown ? undefined : gapProgress }, noCraft ? ['--no-craft'] : []);
    assert.equal(query.status, 0, query.stderr); const result = JSON.parse(query.stdout);
    assert.equal(result.stageCodes.stage_synthetic, 'SYN-1');
    if (unknown) { assert.equal(result.status, 'partial'); assert.equal(result.comparison.craft.materials.mat.remaining, null); }
    else if (shared) { assert.equal(result.comparison.craft.materials.mat.crafted, 1); assert.equal(result.comparison.craft.lmd.required, 209); }
    else if (noCraft) { assert.equal(result.selected, 'no-craft'); assert.equal(result.comparison.noCraft.materials.mat.remaining, 2); }
    else { assert.equal(result.comparison.craft.materials.mat.remaining, 0); assert.equal(result.comparison.craft.voucherAllocations[0].count, 4); }
    // This is offline seam validation, not a real-model baseline or a forged terminal model event.
    const evidence = await collectEvidence(fixture, { completed: false, calls: [], outputs: [] });
    assert.deepEqual(evidence.changes, []); assert.equal(evidence.events.filter(event => event.kind === 'invocation').length, 2);
    assert.equal(grade(fixture.policy, evidence).status, 'unverified');
  }
});
