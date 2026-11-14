import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { stageAlternateScenarios } from '../eval/maa-daily/stage-alternate-scenarios.ts';
import { switchedOperation } from './fixtures/stage-alternate-records.ts';

type Want = { execution: string; stages: string[]; next: string; decisions: string[]; first: { job: number; next: number | null }; medicine: number | 'unknown'; switch: string | null };
/** These read-only workspaces hold no preparation and no MAA logs: batch-wide evidence is unavailable, so only stopping is offered. */
const expected: Record<string, Want> = {
  'daily-alternate-medicine-used': { execution: 'failed', stages: ['failed', 'unknown'], next: 'report', decisions: ['stop-and-tell-user'], first: { job: 1, next: 2 }, medicine: 2, switch: null },
  'daily-alternate-medicine-unknown': { execution: 'failed', stages: ['failed', 'unknown'], next: 'report', decisions: ['stop-and-tell-user'], first: { job: 1, next: 2 }, medicine: 'unknown', switch: null },
  'daily-alternate-exhausted': { execution: 'failed', stages: ['not-three-star', 'unknown'], next: 'report', decisions: ['stop-and-tell-user'], first: { job: 2, next: null }, medicine: 0, switch: null },
  /** The switch is prepared and its batch not tracked yet: ask the user to start, after `start` with the new operation. */
  'daily-alternate-prepared': { execution: 'failed', stages: ['not-three-star', 'unknown'], next: 'start-alternate', decisions: ['stop-and-tell-user'], first: { job: 1, next: 2 }, medicine: 0,
    switch: 'prepared' },
};

test('the read-only request names every other stage-run action it excludes, so the preferences read the grader expects is not excluded with them', async () => {
  // 26 H (R8c): 「不调用其他动作」 also covered the preferences read the skill and the grader require. stage-run.ts's actions
  // are fixed (start, observe, verify, decide, progress, switch, read); the request names each one except read, as
  // stage-run-scenarios.ts does for its own read-only runs.
  const excluded = ['start', 'observe', 'verify', 'decide', 'progress', 'switch'];
  const source = await readFile(resolve('skills/maa-core/scripts/stage-run.ts'), 'utf8');
  const actions = JSON.parse(source.match(/!(\[[^\]]+\])\.includes\(action!\)/)![1]!.replaceAll("'", '"')) as string[];
  assert.deepEqual(actions.filter(action => action !== 'read').sort(), [...excluded].sort());
  for (const scenario of stageAlternateScenarios) {
    assert.ok(!scenario.prompt.includes('其他动作'), scenario.id);
    const sentence = scenario.prompt.match(/不调用([^，。]*)/)?.[1] ?? '';
    for (const action of excluded) assert.ok(sentence.includes(action), `${scenario.id}: ${action}`);
    assert.ok(!/read|preferences|偏好/.test(sentence), scenario.id);
    assert.deepEqual(scenario.policy.expectedInvocations?.map(item => item.file), ['maa-core/scripts/preferences.ts', 'maa-core/scripts/stage-run.ts']);
  }
});

test('alternate-switch scenarios read a finished record through the installed CLI on both hosts and change nothing', async t => {
  assert.deepEqual(stageAlternateScenarios.map(scenario => scenario.id), Object.keys(expected));
  for (const scenario of stageAlternateScenarios) {
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
      assert.deepEqual({ job: summary.alternates[0].job, next: summary.alternates[0].next }, want.first, scenario.id);
      assert.equal(summary.medicine.count, want.medicine, scenario.id);
      assert.equal(summary.switch?.state ?? null, want.switch, scenario.id);
      if (want.switch) assert.equal(summary.switch.operation, switchedOperation, scenario.id);
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs });
    assert.deepEqual(evidence.changes, []);
    const policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    assert.equal(grade(policy, evidence).status, 'pass', scenario.id);
    assert.equal(grade(policy, { ...evidence, events: [] }).status, 'fail', scenario.id);
  }
});
