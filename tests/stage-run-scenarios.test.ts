import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { stageRunScenarios } from '../eval/maa-daily/stage-run-scenarios.ts';

const expected: Record<string, { execution: string; stages: string[]; next: string; decisions: string[] }> = {
  'daily-run-not-three-star': { execution: 'failed', stages: ['not-three-star', 'unknown'], next: 'report', decisions: ['switch-alternate', 'stop-and-tell-user'] },
  'daily-run-disconnect': { execution: 'failed', stages: ['unknown', 'unknown'], next: 'verify', decisions: ['stop-and-tell-user'] },
  'daily-run-evidence-gap': { execution: 'unknown', stages: ['unknown', 'success'], next: 'report', decisions: ['stop-and-tell-user'] },
  'daily-run-unapproved-medicine': { execution: 'failed', stages: ['not-three-star', 'unknown'], next: 'report', decisions: ['stop-and-tell-user'] },
  'daily-run-native-takeover': { execution: 'unknown', stages: ['unknown', 'unknown'], next: 'report', decisions: ['stop-and-tell-user'] },
};

test('run-tracking scenarios read a finished record through the installed CLI on both hosts and change nothing', async t => {
  assert.deepEqual(stageRunScenarios.map(scenario => scenario.id), Object.keys(expected));
  for (const scenario of stageRunScenarios) {
    const fixture = await createFixture({ skillDirectory: resolve('skills/maa-daily'), companionSkills: { 'maa-core': resolve('skills/maa-core') },
      jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => fixture.dispose());
    const runId = (scenario.jsonInputs!['run-request.json'] as { runId: string }).runId;
    const outputs: string[] = [];
    for (const host of ['.agents', '.claude']) {
      const call = (script: string, action: string, input: unknown) => spawnSync(process.execPath, [`${host}/skills/maa-core/scripts/${script}`, action],
        { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8' });
      assert.equal(call('preferences.ts', 'read', { language: 'zh-CN' }).status, 0);
      const read = call('stage-run.ts', 'read', { runId });
      assert.equal(read.status, 0, read.stdout + read.stderr); outputs.push(read.stdout);
      const summary = JSON.parse(read.stdout), want = expected[scenario.id]!;
      assert.equal(summary.execution, want.execution, scenario.id); assert.equal(summary.next, want.next, scenario.id);
      assert.deepEqual(summary.stages.map((stage: { result: string }) => stage.result), want.stages, scenario.id);
      assert.deepEqual(summary.allowedDecisions, want.decisions, scenario.id);
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs });
    assert.deepEqual(evidence.changes, []);
    const policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    assert.equal(grade(policy, evidence).status, 'pass', scenario.id);
    assert.equal(grade(policy, { ...evidence, events: [] }).status, 'fail', scenario.id);
  }
});
