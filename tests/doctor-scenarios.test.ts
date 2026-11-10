import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { doctorScenarios } from '../eval/maa-doctor/scenarios.ts';
import { grade } from '../scripts/evaluation.ts';

test('doctor scenarios observe actual installed CLI checks and exact redacted latest records', async (t) => {
  for (const scenario of doctorScenarios) await t.test(scenario.id, async (t) => {
    const f = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-doctor', import.meta.url)),
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => f.dispose()); f.policy = { ...scenario.policy, secrets: f.policy.secrets };
    const startedAt = new Date().toISOString();
    for (const [script, action, input] of [['preferences.ts', 'read', { userLanguage: 'zh-CN' }], ['doctor.ts', 'check', {}]] as const) {
      const result = spawnSync(process.execPath, [join(f.workspace, '.agents/skills/maa-core/scripts', script), action, ...(script === 'doctor.ts' ? ['--json'] : [])],
        { cwd: f.workspace, env: f.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, script === 'doctor.ts' && scenario.id !== 'doctor-inspect' ? 1 : 0, result.stdout + result.stderr);
    }
    const evidence = await collectEvidence(f, { completed: true, calls: [], outputs: [] });
    evidence.executionWindow = { startedAt, endedAt: new Date().toISOString() };
    assert.equal(grade(f.policy, evidence).status, 'pass', JSON.stringify(grade(f.policy, evidence)));
  });
});
