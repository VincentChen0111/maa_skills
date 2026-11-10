import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { stageScenarios } from '../eval/maa-daily/stage-scenarios.ts';

test('stage scenarios run the installed shared CLI and leave candidate-only requests read-only', async () => {
  for (const scenario of stageScenarios) {
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
