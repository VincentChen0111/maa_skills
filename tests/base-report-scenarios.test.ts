import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { baseReportScenarios } from '../eval/maa-account/base-report-scenarios.ts';
import { observeReports, withReportEvidence } from '../eval/report-observer.ts';
import { observeBasePlans, withBasePlanEvidence } from '../eval/base-plan-observer.ts';
import { planInput, layout } from './fixtures/base-plan-data.ts';

// Offline seam validation for the base report scenarios: the installed product CLIs run in the evaluation fixture and
// the observers turn the saved records and plan file into grader evidence. This is not a model run; the reviewer is synthetic.
type Step = [string, string, unknown];
const draft = { goals: { source: 'user-stated', text: '我想要龙门币和赤金稳定' }, ...planInput() };
const runs: Record<string, (hash: () => string, sha: () => string) => Step[]> = {
  'base-report-default-review': (hash, sha) => [['base-report.ts', 'draft', draft], ['base-report.ts', 'brief', { get reportHash() { return hash(); } }],
    ['base-report.ts', 'review', { get reportHash() { return hash(); }, reviewer: { host: 'claude', method: 'fresh-context' }, get briefSha256() { return sha(); }, findings: [] }]],
  'base-report-skip-approve': (hash) => [['base-report.ts', 'draft', draft], ['base-report.ts', 'skip', { get reportHash() { return hash(); }, userWords: '这次跳过审查' }],
    ['base-report.ts', 'approve', { get reportHash() { return hash(); }, items: ['P1'], userWords: '我批准排班这一项 P1' }]],
  'base-plan-casual-candidates': () => [['base-plan.ts', 'candidates', { layout: layout().slice(0, 2) }]],
};
const skills = { skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)), companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) } };

test('base report scenarios run the installed product CLIs offline; the report-named plan file is graded with the report, nothing else changes', async (t) => {
  assert.deepEqual(baseReportScenarios.map(scenario => scenario.id).sort(), Object.keys(runs).sort());
  for (const [index, scenario] of baseReportScenarios.entries()) {
    const host = index % 2 ? '.claude' : '.agents';
    const fixture = await createFixture({ ...skills, jsonInputs: scenario.jsonInputs, networkFixtures: scenario.networkFixtures });
    t.after(() => fixture.dispose());
    const policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    const call = (script: string, action: string, input: unknown) => spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', script), action],
      { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
    let hash = '', sha = '';
    const outputs = [call('preferences.ts', 'read', { currentLanguage: 'zh-CN' }).stdout];
    for (const [script, action, input] of runs[scenario.id]!(() => hash, () => sha)) {
      const result = call(script, action, input);
      assert.equal(result.status, 0, `${scenario.id} ${action}: ${result.stdout}${result.stderr}`);
      const output = JSON.parse(result.stdout);
      if (action === 'draft') { hash = output.reportHash; assert.ok(output.unverified.includes('names:maa-directory-unset'), 'without a MAA directory the name check is listed as unverified'); }
      if (action === 'brief') sha = output.sha256;
      outputs.push(result.stdout);
    }
    const reports = await observeReports(fixture.workspace), plans = await observeBasePlans(fixture.workspace);
    const evidence = withBasePlanEvidence(withReportEvidence(await collectEvidence(fixture, { completed: true, calls: [], outputs }), reports), plans);
    assert.deepEqual(evidence.changes, [], `${scenario.id}: apart from report records and the plan they name, no file changes (MAA configuration untouched)`);
    assert.deepEqual(plans.unreferenced, []);
    assert.equal(grade(policy, evidence).status, 'pass', `${scenario.id}: ${JSON.stringify(grade(policy, evidence))}`);
    if (scenario.id === 'base-report-skip-approve') assert.deepEqual(reports.approvals.map(approval => approval.items), [['P1']]);
    else assert.deepEqual(reports.approvals, [], 'nothing is approved without the user saying so');
    if (scenario.id === 'base-plan-casual-candidates') { assert.deepEqual(reports.reports, []); assert.deepEqual(plans.files, [], 'a casual question saves no report and no plan'); }
  }
});

test('the same policies fail a report left pending and a plan file written outside the report flow', async (t) => {
  const scenario = baseReportScenarios.find(entry => entry.id === 'base-report-skip-approve')!;
  const fixture = await createFixture({ ...skills, jsonInputs: scenario.jsonInputs, networkFixtures: scenario.networkFixtures });
  t.after(() => fixture.dispose());
  const policy = { ...scenario.policy, secrets: fixture.policy.secrets };
  const call = (script: string, action: string, input: unknown) => spawnSync(process.execPath, [join(fixture.workspace, '.agents/skills/maa-core/scripts', script), action],
    { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
  const drafted = call('base-report.ts', 'draft', draft);
  assert.equal(drafted.status, 0, drafted.stdout);
  const observe = async (outputs: string[]) => withBasePlanEvidence(withReportEvidence(await collectEvidence(fixture, { completed: true, calls: [], outputs }),
    await observeReports(fixture.workspace)), await observeBasePlans(fixture.workspace));
  assert.ok(grade(policy, await observe([drafted.stdout])).failed.includes('report-review'), 'a report left pending is not graded as reviewed or skipped');
  const generated = call('base-plan.ts', 'generate', { ...planInput(), target: 'base-plans/loose.json' });
  assert.equal(generated.status, 0, generated.stdout);
  assert.deepEqual((await observeBasePlans(fixture.workspace)).unreferenced, ['private/base-plans/loose.json']);
  assert.ok(grade(policy, await observe([drafted.stdout, generated.stdout])).failed.includes('authorization'), 'a plan no report names needs a grant');
});
