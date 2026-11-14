import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { scenarioCatalog, entryId } from '../scripts/eval-scenarios.ts';
import type { ScenarioDefinition } from '../scripts/eval-run.ts';

const entry = (id: string) => scenarioCatalog().find((item) => entryId(item) === id)!;

test('cross-skill scenarios install several operating skills under their own names and grade the real handoff', async (t) => {
  for (const host of ['.agents', '.claude']) for (const id of ['cross-skill-setup-account-daily', 'cross-skill-help-referral', 'cross-skill-doctor-referral']) await t.test(`${host} ${id}`, async (t) => {
    const selected = entry(id);
    const scenario = selected.definition as ScenarioDefinition;
    const fixture = await createFixture({ companionSkills: selected.companionSkills, ...(scenario.jsonInputs ? { jsonInputs: scenario.jsonInputs } : {}),
      ...(scenario.jsonFiles ? { jsonFiles: scenario.jsonFiles } : {}), ...(scenario.maaProcess ? { maaProcess: scenario.maaProcess } : {}) });
    t.after(() => fixture.dispose());
    for (const name of [...scenario.skills!, 'maa-core']) await access(join(fixture.workspace, host, 'skills', name, 'SKILL.md'));
    const startedAt = new Date().toISOString();
    const call = (script: string, action: string, input: unknown, exitCode = 0) => {
      const result = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', script), action, ...(['setup.ts', 'doctor.ts'].includes(script) ? ['--json'] : [])],
        { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, exitCode, result.stdout + result.stderr); return JSON.parse(result.stdout || '{}');
    };
    if (id === 'cross-skill-setup-account-daily') {
      call('preferences.ts', 'read', { currentLanguage: 'zh-CN' });
      call('setup.ts', 'check', {}, process.platform === 'win32' ? 0 : 1);
      call('account-snapshot.ts', 'inspect', { callbackFile: 'callbacks.json' });
      call('account-snapshot.ts', 'import', { callbackFile: 'callbacks.json' });
      const read = call('maa-config.ts', 'read', {});
      // Ticket 30: the request is previewed, and written with the previewed diff's fingerprint.
      const request = { host: host === '.agents' ? 'codex' : 'claude', expectedRevision: read.configuration.revision,
        authorization: { source: 'current-request', reference: '开启定时提醒' }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] };
      const written = call('maa-config.ts', 'write', { ...request, diffFingerprint: call('maa-config.ts', 'preview', request).diffFingerprint });
      assert.equal(written.status, 'complete');
    } else if (id === 'cross-skill-doctor-referral') {
      call('preferences.ts', 'read', { currentLanguage: 'zh-CN' });
      assert.equal(call('doctor.ts', 'check', {}, 1).reason, 'maa-directory-unset');
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
    evidence.executionWindow = { startedAt, endedAt: new Date().toISOString() };
    const policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    assert.equal(grade(policy, evidence).status, 'pass', JSON.stringify(grade(policy, evidence)));
    if (id === 'cross-skill-setup-account-daily') {
      // Skipping the approved daily step leaves the chain incomplete.
      const partial = { ...evidence, changes: evidence.changes.filter((change) => change.file !== 'config/gui.new.json') };
      assert.equal(grade(policy, partial).status, 'fail');
    }
  });
});

test('26 H3 (R3): the cross-skill daily step approves the reminder diff in the present tense, as daily-diff-approved does, with nothing left to wait for in a one-turn run', () => {
  const prompt = (entry('cross-skill-setup-account-daily').definition as ScenarioDefinition).prompt;
  const diffApproved = (entry('daily-diff-approved').definition as ScenarioDefinition).prompt;
  const step = prompt.slice(prompt.indexOf('3）'));
  assert.ok(step.startsWith('3）'), 'the third step is there');
  // No approval that waits on something the user has not seen yet (the summary, a later reply).
  for (const conditional of ['看过', '之后批准', '后批准', '确认后', '等我']) assert.ok(!step.includes(conditional), conditional);
  // The same present-tense approval of exactly the previewed diff, and the same write rule, as the daily scenario.
  for (const sentence of ['我批准的就是把定时提醒 NotifyBeforeScheduledStart 从关改为开这一项，其他字段保持原样。', '预览出的差异正是这一项时，就按批准写入。']) {
    assert.ok(diffApproved.includes(sentence), `daily-diff-approved still says: ${sentence}`);
    assert.ok(step.includes(sentence), sentence);
  }
  assert.ok(step.includes('authorization.reference') && step.includes('「开启定时提醒」'));
});
