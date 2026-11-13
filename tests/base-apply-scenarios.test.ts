import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { baseApplyScenarios, baseApplyWorlds } from '../eval/maa-daily/base-apply-scenarios.ts';

// Offline seam validation for the ticket 23 scenarios: the installed product CLIs run in the evaluation fixture the way
// the expected behaviour does (preferences, configuration summary, then the read-only check). Not a model run.
const expected: Record<string, { status: string; reasons: string[] }> = {
  'daily-base-apply-unapproved': { status: 'refused', reasons: ['report-item-not-approved'] },
  'daily-base-apply-changed-report': { status: 'refused', reasons: ['report-content-mismatch'] },
  'daily-base-apply-invalid-plan': { status: 'refused', reasons: ['base-plan-not-applicable'] },
  'daily-base-apply-unknown': { status: 'refused', reasons: ['lock-requires-reconciliation'] },
  'daily-base-apply-snapshot-changed': { status: 'refused', reasons: ['base-snapshot-changed'] },
  'daily-base-apply-failing-gate': { status: 'refused', reasons: ['base-plan-not-applicable'] },
  'daily-base-apply-path-outside': { status: 'refused', reasons: ['plan-path-outside-private'] },
  'daily-base-apply-unverified-accepted': { status: 'ready', reasons: [] },
  'daily-base-apply-copy-edited': { status: 'refused', reasons: ['base-plan-copy-changed'] },
  'daily-base-apply-weekly-schedule': { status: 'needs-decision', reasons: [] },
};
const skills = { skillDirectory: fileURLToPath(new URL('../skills/maa-daily', import.meta.url)), companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) } };
const decision = { acceptUnverified: ['gate-7', 'gate-8'], userWords: '第 7、8 项未核实我接受，仍然应用' };

test('base apply scenarios run the installed CLIs offline: every refusal is named, the accepted decision is ready, nothing changes', async (t) => {
  assert.deepEqual(baseApplyScenarios.map(scenario => scenario.id).sort(), Object.keys(expected).sort());
  for (const [index, scenario] of baseApplyScenarios.entries()) {
    const host = index % 2 ? '.claude' : '.agents';
    const fixture = await createFixture({ ...skills, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => fixture.dispose());
    const call = (script: string, action: string, input: unknown) => spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', script), action],
      { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
    const preferences = call('preferences.ts', 'read', { currentLanguage: 'zh-CN' });
    const summary = call('maa-config.ts', 'read', {});
    assert.equal(summary.status, 0, summary.stdout);
    const queue = JSON.parse(summary.stdout).configuration.profiles[0].queue.map((task: { type: string }) => task.type);
    assert.deepEqual(queue, ['Fight', 'Infrast'], 'the summary locates the Infrast task without printing names or paths');
    const reference = scenario.id === 'daily-base-apply-unapproved' ? baseApplyWorlds.unapproved.reference : scenario.id === 'daily-base-apply-path-outside'
      ? baseApplyWorlds.outside.reference : scenario.id === 'daily-base-apply-unverified-accepted' ? baseApplyWorlds.unverified.reference : baseApplyWorlds.approved.reference;
    assert.ok(scenario.prompt.includes(reference), `${scenario.id}: the prompt names the approved item`);
    const accepted = scenario.id === 'daily-base-apply-unverified-accepted';
    if (accepted) {
      const first = JSON.parse(call('base-apply.ts', 'check', { reference, profile: 0, task: 1 }).stdout);
      assert.equal(first.status, 'needs-decision'); assert.deepEqual(first.unverified.map((entry: { id: string }) => entry.id), ['gate-7', 'gate-8']);
    }
    const check = call('base-apply.ts', 'check', { reference, profile: 0, task: 1, ...accepted ? { decision } : {} });
    const output = JSON.parse(check.stdout);
    assert.equal(check.status, accepted ? 0 : 1, `${scenario.id}: ${check.stdout}${check.stderr}`);
    assert.equal(output.status, expected[scenario.id]!.status, `${scenario.id}: ${check.stdout}`);
    assert.deepEqual(output.reasons, expected[scenario.id]!.reasons, `${scenario.id}: ${check.stdout}`);
    if (scenario.id === 'daily-base-apply-failing-gate') assert.equal(output.check.gates.find((gate: { gate: number }) => gate.gate === 4).verdict, 'fail');
    if (scenario.id === 'daily-base-apply-invalid-plan') assert.ok(output.check.errors.some((error: string) => error.startsWith('name-unknown')));
    if (accepted) assert.deepEqual(output.configuration.changes, ['Mode', 'Filename', 'PlanSelect', 'CustomFileType']);
    if (scenario.id === 'daily-base-apply-copy-edited') assert.equal(output.configuration.copy, 'changed');
    if (scenario.id === 'daily-base-apply-weekly-schedule') {
      assert.deepEqual(output.unverified.map((entry: { id: string }) => entry.id), ['maa-weekly-schedule']);
      assert.ok(/周日/.test(output.unverified[0].evidence.join('')) && /周六/.test(output.unverified[0].evidence.join('')));
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [preferences.stdout, summary.stdout, check.stdout] });
    assert.deepEqual(evidence.changes, [], `${scenario.id}: the check writes nothing (no config, lock, copy or record)`);
    const policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    assert.equal(grade(policy, evidence).status, 'pass', `${scenario.id}: ${JSON.stringify(grade(policy, evidence))}`);
    assert.equal(grade(policy, { ...evidence, events: evidence.events.filter(event => event.file !== 'maa-core/scripts/base-apply.ts') }).status, 'fail',
      `${scenario.id}: without the real check invocation the scenario does not pass`);
  }
});
