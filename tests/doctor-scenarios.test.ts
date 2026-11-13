import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { doctorScenarios } from '../eval/maa-doctor/scenarios.ts';
import { grade } from '../scripts/evaluation.ts';

// The commands a passing model run is expected to make; their exit codes come from the scenario itself.
const inputs: Record<string, unknown> = { 'preferences.ts read': { userLanguage: 'zh-CN' }, 'doctor.ts check': {}, 'doctor.ts analyze': { processExitCode: 0 } };

test('doctor scenarios observe actual installed CLI checks and exact redacted latest records in both native layouts', async (t) => {
  for (const host of ['.agents', '.claude']) for (const scenario of doctorScenarios) await t.test(`${host} ${scenario.id}`, async (t) => {
    const f = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-doctor', import.meta.url)),
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => f.dispose()); f.policy = { ...scenario.policy, secrets: [...f.policy.secrets, ...(scenario.chatSecrets ?? [])] };
    const startedAt = new Date().toISOString(); const outputs: string[] = [];
    for (const expected of scenario.policy.expectedInvocations ?? []) {
      const script = expected.file.split('/').at(-1)!;
      const result = spawnSync(process.execPath, [join(f.workspace, host, 'skills/maa-core/scripts', script), expected.action, ...(script === 'doctor.ts' ? ['--json'] : [])],
        { cwd: f.workspace, env: f.env, input: JSON.stringify(inputs[`${script} ${expected.action}`]), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, expected.exitCode ?? 0, result.stdout + result.stderr);
      outputs.push(result.stdout);
    }
    const evidence = await collectEvidence(f, { completed: true, calls: [], outputs });
    evidence.executionWindow = { startedAt, endedAt: new Date().toISOString() };
    assert.equal(grade(f.policy, evidence).status, 'pass', JSON.stringify(grade(f.policy, evidence)));
  });
});
