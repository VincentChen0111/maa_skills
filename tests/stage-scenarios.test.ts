import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { stageScenarios } from '../eval/maa-daily/stage-scenarios.ts';

test('stage scenarios run the installed shared CLI and leave candidate-only requests read-only', async () => {
  for (const scenario of stageScenarios.filter((item) => !item.maaProcess)) {
    const fixture = await createFixture({ skillDirectory: resolve('skills/maa-daily'), companionSkills: { 'maa-core': resolve('skills/maa-core') }, jsonInputs: scenario.jsonInputs });
    try {
      for (const host of ['.agents', '.claude']) {
        const execution = spawnSync(process.execPath, [`${host}/skills/maa-core/scripts/stage-jobs.ts`, 'query'], { cwd: fixture.workspace, env: fixture.env, encoding: 'utf8',
          input: JSON.stringify({ request: scenario.jsonInputs!['request.json'], tablesFile: 'tables.json', jobsFile: 'jobs.json' }) });
        assert.equal(execution.status, 0, execution.stdout + execution.stderr);
        const report = JSON.parse(execution.stdout).report;
        assert.equal(report.authorization, 'none'); assert.equal(report.stages.length, 1); assert.equal(report.stages[0].loops, 3);
        assert.equal(report.stages[0].candidates[0].status, ['daily-stage-unknown-elite', 'daily-stage-prerequisite', 'daily-stage-data-not-authority'].includes(scenario.id) ? 'unknown' : 'ready');
        if (scenario.id === 'daily-stage-alternative-requirements') assert.equal(report.stages[0].candidates[0].assignment['合成组'], '合成乙');
      }
      const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] }); assert.deepEqual(evidence.changes, []); assert.equal(evidence.events.length, 2);
    } finally { await fixture.dispose(); }
  }
});

test('the approved preparation scenario grades query, read, prepare and read-back through the shared writer', async (t) => {
  const scenario = stageScenarios.find((item) => item.id === 'daily-stage-prepare-approved')!;
  for (const host of ['.agents', '.claude']) await t.test(host, async (t) => {
    const fixture = await createFixture({ skillDirectory: resolve('skills/maa-daily'), companionSkills: { 'maa-core': resolve('skills/maa-core') }, maaProcess: scenario.maaProcess!,
      jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => fixture.dispose());
    const startedAt = new Date().toISOString();
    const call = (script: string, action: string, input: unknown) => {
      const result = spawnSync(process.execPath, [`${host}/skills/maa-core/scripts/${script}.ts`, action], { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
    };
    call('preferences', 'read', { currentLanguage: 'zh-CN' });
    const { report } = call('stage-jobs', 'query', { request: scenario.jsonInputs!['request.json'], tablesFile: 'tables.json', jobsFile: 'jobs.json', saveReport: true });
    const { configuration } = call('maa-config', 'read', {});
    const reference = scenario.policy.writerTransaction!.reference;
    const prepared = call('stage-jobs', 'prepare', { approval: { reportHash: report.hash, map: 'synthetic_map', reference,
      selections: [{ stageId: 'synthetic_01', primary: 1, alternates: [2], loops: 3 }] }, profile: configuration.currentProfile, host: host === '.agents' ? 'codex' : 'claude', expectedRevision: configuration.revision });
    assert.equal(prepared.status, 'complete');
    assert.equal(call('maa-config', 'read', {}).configuration.profiles[0].jobCount, 3);
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
    evidence.executionWindow = { startedAt, endedAt: new Date().toISOString() };
    const policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    assert.equal(grade(policy, evidence).status, 'pass', JSON.stringify(grade(policy, evidence)));
    const wrongPlan = { ...policy, writerTransaction: { ...policy.writerTransaction!, jobPlan: { map: 'synthetic_map', entries: [{ stageId: 'synthetic_01', loops: 2, primary: 1, alternates: [2] }] } } };
    assert.equal(grade(wrongPlan, evidence).status, 'fail', 'a different approved loop count is not this transaction');
  });
});
