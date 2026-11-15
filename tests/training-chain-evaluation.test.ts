// Ticket 32: each unattended-chaining scenario is graded `pass` when the installed CLI is driven the way the training
// reference describes, and `fail` for the tempting wrong move. No model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { trainingChainScenarios, trainingFollowOnScenarios } from '../eval/maa-daily/training-scenarios.ts';
import type { ScenarioDefinition } from '../scripts/eval-run.ts';

const binding = { profile: 0, infrastTask: 0, progressTask: 1, timer: 0 };
const scenario = (id: string) => trainingChainScenarios.find(entry => entry.id === id)!;
async function drive(t: { after(fn: () => Promise<unknown>): void }, definition: ScenarioDefinition) {
  const fixture = await createFixture({ skillDirectory: resolve('skills/maa-daily'), companionSkills: { 'maa-core': resolve('skills/maa-core') },
    jsonInputs: definition.jsonInputs, jsonFiles: definition.jsonFiles, ...(definition.maaProcess ? { maaProcess: definition.maaProcess } : {}) });
  t.after(() => fixture.dispose());
  const outputs: string[] = [];
  const invoke = (script: string, action: string, input: unknown) => {
    const run = spawnSync(process.execPath, [join(fixture.workspace, '.agents/skills/maa-core/scripts', script), action],
      { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8' });
    outputs.push(run.stdout); return run;
  };
  const request = JSON.parse(await readFile(join(fixture.workspace, 'training-request.json'), 'utf8'));
  assert.equal(invoke('preferences.ts', 'read', { language: 'zh-CN' }).status, 0);
  const graded = async () => {
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs });
    return grade({ ...definition.policy, secrets: fixture.policy.secrets }, evidence);
  };
  return { invoke, request, graded };
}

test('32: the prepare-only chain scenarios pass with the documented inputs', async t => {
  const cases: [string, (request: Record<string, unknown>) => Record<string, unknown>][] = [
    ['training-chain-five-hour-goal', request => ({ query: request, currentTrainee: null, authorization: { source: 'current-request', reference: '合成干员一技能练到专三' } })],
    ['training-chain-in-progress', request => ({ query: { ...request, inTraining: { source: 'user-confirmed', rank: 1 } }, currentTrainee: 'char_synthetic',
      authorization: { source: 'current-request', reference: '专一练完接着练专二、专三' } })],
    ['training-chain-crafting', request => ({ query: { ...request, progress: { source: 'user-confirmed', rooms: { WORKSHOP: [3] } } }, currentTrainee: 'char_synthetic',
      authorization: { source: 'current-request', reference: '合成干员一技能练到专一' }, crafting: { reference: '缺的材料让 MAA 自动去加工站合成' } })],
  ];
  for (const [id, body] of cases) {
    const { invoke, request, graded } = await drive(t, scenario(id));
    const prepared = invoke('training-plan.ts', 'prepare', { ...body(request), binding });
    assert.equal(prepared.status, 0, `${id}: ${prepared.stderr}`);
    const result = await graded(); assert.equal(result.status, 'pass', `${id}: ${JSON.stringify(result)}`);
  }
  // The tempting shortcuts: no in-training fact, or no crafting approval, leave the wrong record and fail.
  const plain = await drive(t, scenario('training-chain-in-progress'));
  assert.equal(plain.invoke('training-plan.ts', 'prepare', { query: plain.request, binding, currentTrainee: 'char_synthetic', manualTraining: true,
    authorization: { source: 'current-request', reference: '专一练完接着练专二、专三' } }).status, 0);
  assert.equal((await plain.graded()).status, 'fail');
  const uncrafted = await drive(t, scenario('training-chain-crafting'));
  assert.equal(uncrafted.invoke('training-plan.ts', 'prepare', { query: { ...uncrafted.request, progress: { source: 'user-confirmed', rooms: { WORKSHOP: [3] } } }, binding,
    currentTrainee: 'char_synthetic', authorization: { source: 'current-request', reference: '合成干员一技能练到专一' } }).status, 0);
  assert.equal((await uncrafted.graded()).status, 'fail');
});

test('32: unattended re-entry stops while a stopped plan holds the training room, and moves to the next operator once the previous plan is complete', async t => {
  const held = await drive(t, scenario('training-chain-reentry-held'));
  const listed = held.invoke('training-plan.ts', 'list', {});
  assert.equal(listed.status, 0, listed.stderr); assert.equal(JSON.parse(listed.stdout).result[0].holdsTrainingRoom, true);
  assert.equal((await held.graded()).status, 'pass');
  const pushed = await drive(t, scenario('training-chain-reentry-held'));
  pushed.invoke('training-plan.ts', 'list', {});
  pushed.invoke('training-plan.ts', 'prepare', { query: pushed.request, binding, currentTrainee: 'char_synthetic', authorization: { source: 'current-request', reference: 'synthetic' } });
  assert.equal((await pushed.graded()).status, 'fail');

  const next = await drive(t, scenario('training-chain-next-operator'));
  assert.equal(next.invoke('training-plan.ts', 'list', {}).status, 0);
  const prepared = next.invoke('training-plan.ts', 'prepare', { query: next.request, binding, currentTrainee: 'char_synthetic',
    authorization: { source: 'current-request', reference: '合成干员一技能练到专二，然后合成助手一技能练到专一，按顺序无人值守续接' } });
  assert.equal(prepared.status, 0, prepared.stderr);
  // MAA is closed and nobody can confirm it is unused: the writer refuses before writing, and the run stops there.
  const applied = next.invoke('training-plan.ts', 'apply', { id: JSON.parse(prepared.stdout).result.id, host: 'codex' });
  assert.equal(applied.status, 1); assert.equal(JSON.parse(applied.stdout).result.reason, 'closed-confirmation-required');
  assert.equal((await next.graded()).status, 'pass');
  const confirmed = await drive(t, scenario('training-chain-next-operator'));
  confirmed.invoke('training-plan.ts', 'list', {});
  const plan = confirmed.invoke('training-plan.ts', 'prepare', { query: confirmed.request, binding, currentTrainee: 'char_synthetic',
    authorization: { source: 'current-request', reference: 'synthetic' } });
  confirmed.invoke('training-plan.ts', 'apply', { id: JSON.parse(plan.stdout).result.id, host: 'codex', closedConfirmed: true });
  assert.equal((await confirmed.graded()).status, 'fail', 'an unattended run that confirms a closed MAA by itself writes without permission');
});

const followOn = (id: string) => trainingFollowOnScenarios.find(entry => entry.id === id)!;
test('32 follow-on: the new chain scenarios pass with the documented moves and fail with the tempting wrong ones', async t => {
  // R2-2: a waiting plan is refreshed with the latest snapshot before apply; apply alone keeps waiting and fails the scenario.
  const refreshed = await drive(t, followOn('training-chain-waiting-refresh'));
  assert.equal(refreshed.invoke('training-plan.ts', 'list', {}).status, 0);
  const done = refreshed.invoke('training-plan.ts', 'refresh', { id: 'synthetic-plan', query: refreshed.request });
  assert.equal(done.status, 0, done.stderr); assert.equal(JSON.parse(done.stdout).result.materialReady, true); assert.match(JSON.parse(done.stdout).result.summary, /训练估算/);
  const applied = refreshed.invoke('training-plan.ts', 'apply', { id: 'synthetic-plan', host: 'codex' });
  assert.equal(applied.status, 1, applied.stdout);
  assert.equal((await refreshed.graded()).status, 'pass', JSON.stringify(await refreshed.graded()));
  const applyOnly = await drive(t, followOn('training-chain-waiting-refresh'));
  applyOnly.invoke('training-plan.ts', 'list', {});
  const waited = applyOnly.invoke('training-plan.ts', 'apply', { id: 'synthetic-plan', host: 'codex' });
  assert.equal(JSON.parse(waited.stdout).result.next, 'refresh');
  assert.equal((await applyOnly.graded()).status, 'fail');
  // OB-6, OB-4/OB-9, item 7: preparing straight from the request is the documented move.
  for (const [id, trainee] of [['training-chain-lower-bound', null], ['training-chain-skland-facts', null], ['training-chain-skland-in-progress', 'char_synthetic']] as const) {
    const run = await drive(t, followOn(id));
    const prepared = run.invoke('training-plan.ts', 'prepare', { query: run.request, binding, currentTrainee: trainee, authorization: { source: 'current-request', reference: 'synthetic' } });
    assert.equal(prepared.status, 0, `${id}: ${prepared.stderr}`);
    assert.equal((await run.graded()).status, 'pass', `${id}: ${JSON.stringify(await run.graded())}`);
  }
  // Asking instead of preparing (nothing saved), or naming nobody in the room while the snapshot shows the trainee, fails.
  const asked = await drive(t, followOn('training-chain-skland-facts'));
  assert.equal((await asked.graded()).status, 'fail');
  const nobody = await drive(t, followOn('training-chain-skland-in-progress'));
  assert.equal(nobody.invoke('training-plan.ts', 'prepare', { query: nobody.request, binding, currentTrainee: null, authorization: { source: 'current-request', reference: 'synthetic' } }).status, 1);
  assert.equal((await nobody.graded()).status, 'fail');
});
