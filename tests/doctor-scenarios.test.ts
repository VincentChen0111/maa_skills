import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { doctorScenarios } from '../eval/maa-doctor/scenarios.ts';
import { grade } from '../scripts/evaluation.ts';

test('doctor scenarios observe actual installed CLI checks and exact redacted latest records', async (t) => {
  for (const scenario of doctorScenarios.filter((item) => !item.maaProcess)) await t.test(scenario.id, async (t) => {
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

test('the approved reconcile scenario runs check, the named repair and a closing check through the installed CLI and grades the exact recovery', async (t) => {
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
    const policy = { ...scenario.policy, secrets: f.policy.secrets };
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
    assert.equal(grade({ ...scenario.policy, secrets: g.policy.secrets }, unrepaired).status, 'fail');
  });
});
