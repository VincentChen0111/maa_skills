import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { reportScenarios } from '../eval/maa-account/report-scenarios.ts';
import { observeReports, withReportEvidence } from '../eval/report-observer.ts';
import { reportDraft } from './fixtures/report-data.ts';

// Offline seam validation for the report scenarios: the installed product CLIs run in the evaluation fixture and
// the observer turns the saved records into grader evidence. This is not a model run; the reviewer is synthetic.
type Step = [string, string, unknown];
const draft = reportDraft();
const runs: Record<string, (hash: () => string, sha: () => string) => Step[]> = {
  'account-report-skip-review': (hash) => [['cultivation-report.ts', 'draft', draft], ['cultivation-report.ts', 'skip', { get reportHash() { return hash(); }, userWords: '这次赶时间，跳过审查' }]],
  'account-report-default-review': (hash, sha) => [['cultivation-report.ts', 'draft', draft], ['cultivation-report.ts', 'brief', { get reportHash() { return hash(); } }],
    ['cultivation-report.ts', 'review', { get reportHash() { return hash(); }, reviewer: { host: 'claude', method: 'fresh-context' }, get briefSha256() { return sha(); }, findings: [] }]],
  'account-report-approve-one': (hash) => [['cultivation-report.ts', 'draft', draft], ['cultivation-report.ts', 'skip', { get reportHash() { return hash(); }, userWords: '这次跳过审查' }],
    ['cultivation-report.ts', 'approve', { get reportHash() { return hash(); }, items: ['S1'], userWords: '我只批准第 1 步' }]],
  'account-report-casual': () => [['operator-cost.ts', 'query', { name: '合成干员', target: { elite: 1, level: 1 } }]],
};

test('report scenarios run the installed product CLIs offline and grade review marks, approvals and casual questions as expected', async (t) => {
  assert.deepEqual(reportScenarios.map(scenario => scenario.id).sort(), Object.keys(runs).sort());
  for (const [index, scenario] of reportScenarios.entries()) {
    const host = index % 2 ? '.claude' : '.agents';
    const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)),
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs, networkFixtures: scenario.networkFixtures });
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
      if (action === 'draft') hash = output.reportHash;
      if (action === 'brief') sha = output.sha256;
      outputs.push(result.stdout);
    }
    const observed = await observeReports(fixture.workspace);
    const evidence = withReportEvidence(await collectEvidence(fixture, { completed: true, calls: [], outputs }), observed);
    assert.deepEqual(evidence.changes, [], 'apart from report records, no file changes');
    assert.equal(grade(policy, evidence).status, 'pass', `${scenario.id}: ${JSON.stringify(grade(policy, evidence))}`);
    if (scenario.id === 'account-report-approve-one') assert.deepEqual(observed.approvals.map(approval => approval.items), [['S1']], 'only the named step is approved');
    else assert.deepEqual(observed.approvals, [], 'nothing is approved without the user saying so');
    if (scenario.id === 'account-report-casual') assert.deepEqual(observed.reports, [], 'a casual question saves no report');

    // The same policy fails when a report is left pending, including a report drafted for a casual question.
    {
      const pending = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)),
        companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs, networkFixtures: scenario.networkFixtures });
      t.after(() => pending.dispose());
      const drafted = spawnSync(process.execPath, [join(pending.workspace, host, 'skills/maa-core/scripts/cultivation-report.ts'), 'draft'],
        { cwd: pending.workspace, env: pending.env, input: JSON.stringify(draft), encoding: 'utf8', windowsHide: true });
      assert.equal(drafted.status, 0, drafted.stdout);
      const left = withReportEvidence(await collectEvidence(pending, { completed: true, calls: [], outputs: [drafted.stdout] }), await observeReports(pending.workspace));
      assert.ok(grade(policy, left).failed.includes('report-review'), `${scenario.id}: a report left pending is not graded as reviewed or skipped`);

      // A review whose accepted finding is never corrected is not a finished review; the corrected version is.
      if (scenario.id === 'account-report-default-review') {
        const run = (action: string, input: unknown) => {
          const result = spawnSync(process.execPath, [join(pending.workspace, host, 'skills/maa-core/scripts/cultivation-report.ts'), action],
            { cwd: pending.workspace, env: pending.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
          assert.equal(result.status, 0, `${action}: ${result.stdout}`); return JSON.parse(result.stdout);
        };
        const reportHash = JSON.parse(drafted.stdout).reportHash as string;
        const { sha256 } = run('brief', { reportHash });
        run('review', { reportHash, reviewer: { host: 'claude', method: 'fresh-context' }, briefSha256: sha256, findings: [{ id: 'F1', location: 'S1 推荐理由',
          problem: '理由与依据不符', evidence: '依据没有这么说', decision: 'accepted', reason: '可在报告中核实的真实错误' }] });
        const observe = async () => withReportEvidence(await collectEvidence(pending, { completed: true, calls: [], outputs: [drafted.stdout] }), await observeReports(pending.workspace));
        assert.deepEqual((await observeReports(pending.workspace)).reports.map(report => report.review), ['needs-correction']);
        assert.ok(grade(policy, await observe()).failed.includes('report-review'), 'an accepted finding left uncorrected fails the review mark');
        run('draft', { ...draft, revisionOf: { reportHash, corrections: [{ finding: 'F1', change: '按依据改写 S1 的推荐理由' }] } });
        assert.ok(!grade(policy, await observe()).failed.includes('report-review'), 'once corrected, the reviewed parent and its revision both count as reviewed');
      }
    }
  }
});
