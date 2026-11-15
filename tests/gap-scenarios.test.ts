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
    const shared = scenario.id.endsWith('shared-stock'), unknown = scenario.id.endsWith('unknown-progress') || scenario.id.endsWith('base-materials'), noCraft = scenario.id.endsWith('no-craft');
    // Ticket 32 follow-on item 8: one confirmation over exactly the reported stage IDs.
    const stagesConfirmed = scenario.id.endsWith('confirm-stages');
    const query = invoke('cultivation-gaps', { targets: shared ? [gapGoal, { ...gapGoal, name: '合成二号' }] : [gapGoal], progress: unknown ? undefined : stagesConfirmed ? { source: 'user-confirmed', rooms: { WORKSHOP: [3] }, confirmedStages: ['stage_synthetic'] } : gapProgress }, noCraft ? ['--no-craft'] : []);
    assert.equal(query.status, 0, query.stderr); const result = JSON.parse(query.stdout);
    assert.equal(result.stageCodes.stage_synthetic, 'SYN-1');
    if (unknown) { assert.equal(result.status, 'partial'); assert.equal(result.comparison.craft.materials.mat.remaining, null); }
    else if (shared) { assert.equal(result.comparison.craft.materials.mat.crafted, 1); assert.equal(result.comparison.craft.lmd.required, 209); }
    else if (stagesConfirmed) { assert.equal(result.comparison.craft.materials.mat.remaining, 0); assert.ok(!JSON.stringify(result.comparison.craft.blocked).includes('stage:stage_synthetic')); }
    else if (noCraft) { assert.equal(result.selected, 'no-craft'); assert.equal(result.comparison.noCraft.materials.mat.remaining, 2); }
    else { assert.equal(result.comparison.craft.materials.mat.remaining, 0); assert.equal(result.comparison.craft.voucherAllocations[0].count, 4); }
    // Ticket 32: with no LMD and no confirmed unlocks the shortage still decomposes to base materials, with labelled assumptions.
    if (scenario.id.endsWith('base-materials')) {
      const decomposition = result.comparison.craft.decomposition;
      assert.deepEqual(decomposition.short, { ore: 4 }); assert.equal(decomposition.lmdGap, result.comparison.craft.lmd.required + 10);
      assert.deepEqual(decomposition.assumptions, ['room:WORKSHOP:unknown', 'stage:stage_synthetic:unknown']); assert.equal(decomposition.vouchers[0].choices[0].item, 'ore');
    }
    // This is offline seam validation, not a real-model baseline or a forged terminal model event.
    const evidence = await collectEvidence(fixture, { completed: false, calls: [], outputs: [] });
    assert.deepEqual(evidence.changes, []); assert.equal(evidence.events.filter(event => event.kind === 'invocation').length, 2);
    assert.equal(grade(fixture.policy, evidence).status, 'unverified');
  }
});
