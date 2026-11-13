import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, collectEvidence, renderPolicy } from '../scripts/eval-fixture.ts';
import { doctorScenarios } from '../eval/maa-doctor/scenarios.ts';
import { grade } from '../scripts/evaluation.ts';

// The commands a passing model run is expected to make; their exit codes come from the scenario itself.
const inputs: Record<string, unknown> = { 'preferences.ts read': { userLanguage: 'zh-CN' }, 'doctor.ts check': {}, 'doctor.ts analyze': { processExitCode: 0 } };

test('doctor scenarios observe actual installed CLI checks and exact redacted latest records in both native layouts', async (t) => {
  for (const host of ['.agents', '.claude']) for (const scenario of doctorScenarios.filter((item) => !item.maaProcess)) await t.test(`${host} ${scenario.id}`, async (t) => {
    const f = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-doctor', import.meta.url)),
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => f.dispose()); f.policy = { ...renderPolicy(scenario.policy, f.workspace), secrets: [...f.policy.secrets, ...(scenario.chatSecrets ?? [])] };
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

// Windows only: the scenario's expected behaviour is MAA on Windows; off Windows ticket 10's platform check is an error, so doctor's output differs.
test('the approved reconcile scenario runs check, the named repair and a closing check through the installed CLI and grades the exact recovery', { skip: process.platform !== 'win32' }, async (t) => {
  const scenario = doctorScenarios.find((item) => item.id === 'doctor-reconcile-approved')!;
  for (const host of ['.agents', '.claude']) await t.test(host, async (t) => {
    const f = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-doctor', import.meta.url)), maaProcess: scenario.maaProcess!,
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => f.dispose());
    const startedAt = new Date().toISOString();
    const run = (action: string, input: unknown = {}) => spawnSync(process.execPath, [join(f.workspace, host, 'skills/maa-core/scripts/doctor.ts'), action, '--json'],
      { cwd: f.workspace, env: f.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
    assert.equal(spawnSync(process.execPath, [join(f.workspace, host, 'skills/maa-core/scripts/preferences.ts'), 'read'], { cwd: f.workspace, env: f.env, input: '{}', encoding: 'utf8' }).status, 0);
    const checked = run('check'); assert.equal(checked.status, 1, checked.stdout);
    const revision = JSON.parse(checked.stdout).recovery.evidenceRevision;
    const policy = { ...renderPolicy(scenario.policy, f.workspace), secrets: f.policy.secrets };
    const repaired = run('repair', { host: host === '.agents' ? 'codex' : 'claude', approved: ['reconcile-lock'], evidenceRevision: revision, reference: '我点名批准 reconcile-lock' });
    assert.equal(repaired.status, 0, repaired.stdout); assert.equal(JSON.parse(repaired.stdout).status, 'complete');
    const closing = run('check'); assert.equal(closing.status, 0, closing.stdout);
    const evidence = await collectEvidence(f, { completed: true, calls: [], outputs: [] });
    evidence.executionWindow = { startedAt, endedAt: new Date().toISOString() };
    assert.equal(grade(policy, evidence).status, 'pass', JSON.stringify(grade(policy, evidence)));
    // A broad approval leaves everything in place, so the same policy fails on the missing recovery.
    const g = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-doctor', import.meta.url)), maaProcess: scenario.maaProcess!,
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => g.dispose());
    const unrepaired = await collectEvidence(g, { completed: true, calls: [], outputs: [] });
    unrepaired.executionWindow = { startedAt, endedAt: new Date().toISOString() };
    assert.equal(grade({ ...renderPolicy(scenario.policy, g.workspace), secrets: g.policy.secrets }, unrepaired).status, 'fail');
  });
});
