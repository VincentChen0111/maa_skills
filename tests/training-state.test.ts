import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTraining, nextTrainingAction, type TrainingPlan } from '../skills/maa-core/scripts/training-state.ts';
import { plan, log, nativeTask, confirmation, countdown } from './fixtures/training-evidence.ts';

function confirmed() {
  const input = plan();
  return reconcileTraining(input, nativeTask(input) + confirmation()
    + log('2026-11-11T01:05:03.000Z', 'TaskChainCompleted', { taskchain: 'OperProgress', taskid: 4 }), '2026-11-11T01:06:00.000Z');
}
function observe(input: TrainingPlan, dueAt = '2026-11-11T01:05:05.000Z') {
  const next = structuredClone(input); next.action = { kind: 'observe', dueAt, armedAt: input.createdAt }; return next;
}
function running() {
  const input = observe(confirmed());
  return reconcileTraining(input, nativeTask(input, undefined, 5) + countdown(), '2026-11-11T01:06:00.000Z');
}
function completion(at: string, taskid = 5) {
  return log(at, 'SubTaskExtraInfo', { taskchain: 'Infrast', taskid, what: 'InfrastTrainingCompleted', details: { operator: '合成干员', skill: '合成技能', level: 1 } });
}

test('owned confirmation needs a later matching observation; task completion alone does not prove start', () => {
  const initial = confirmed(); assert.equal(initial.state, 'unknown'); assert.ok(initial.action?.completedAt);
  assert.equal(nextTrainingAction(initial, '2026-11-11T01:06:00.000Z')?.kind, 'observe');
  const result = running(); assert.equal(result.state, 'started'); assert.equal(result.expectedCompleteAt, '2026-11-11T02:05:10.000Z');
  assert.equal(result.startedAt, '2026-11-11T01:05:01.000Z'); assert.equal(result.assistantState, 'unverified');
  assert.deepEqual(reconcileTraining(result, countdown(), '2026-11-11T01:07:00.000Z'), result);
  const noConfirmation = observe(plan());
  assert.notEqual(reconcileTraining(noConfirmation, nativeTask(noConfirmation, undefined, 5) + countdown(), '2026-11-11T01:06:00.000Z').state, 'started');
});

test('owned preplacement completion anchors a separate start six minutes later without proving placement', () => {
  const input = plan(); input.action!.kind = 'preplace';
  const result = reconcileTraining(input, nativeTask(input) + log('2026-11-11T01:06:00.000Z', 'TaskChainCompleted', { taskchain: 'Infrast', taskid: 4 }), '2026-11-11T01:07:00.000Z');
  assert.equal(result.state, 'preplaced'); assert.equal(result.startedAt, undefined);
  assert.deepEqual(nextTrainingAction(result, '2026-11-11T01:07:00.000Z'), { kind: 'start', dueAt: '2026-11-11T01:12:00.000Z' });
});

test('latest countdown updates estimates but only actual later completion advances the rank', () => {
  const delayed = reconcileTraining(running(), countdown('2026-11-11T01:10:00.000Z'), '2026-11-11T01:11:00.000Z');
  assert.equal(delayed.expectedCompleteAt, '2026-11-11T02:10:00.000Z');
  assert.notEqual(reconcileTraining(delayed, '', '2026-11-11T02:12:00.000Z').state, 'complete');
  const finished = reconcileTraining(delayed, completion('2026-11-11T02:11:00.000Z'), '2026-11-11T02:12:00.000Z');
  assert.equal(finished.rank, 2); assert.equal(finished.target.currentRank, 1); assert.equal(finished.materialReady, false);
});

test('owned AlreadySatisfied contradictions stop scheduling, while a known fulfilled target is satisfied', () => {
  const input = plan(), event = nativeTask(input) + log('2026-11-11T01:05:02.000Z', 'SubTaskExtraInfo', { taskchain: 'OperProgress', taskid: 4, what: 'OperProgressDetail',
    details: { role: 'Warrior', name: '合成干员', result: 'Success', result_detail: 'AlreadySatisfied', skill_mastery: [1, 0, 0] } });
  const failed = reconcileTraining(input, event, '2026-11-11T01:06:00.000Z');
  assert.equal(failed.state, 'failed'); assert.equal(nextTrainingAction(failed, '2026-11-11T01:06:00.000Z'), null);
  const known = plan(); known.target.currentRank = 1;
  assert.equal(reconcileTraining(known, event, '2026-11-11T01:06:00.000Z').state, 'satisfied');
});

test('wrong targets, future records and reversed confirmation/countdown cannot be promoted by later success', () => {
  const input = observe(confirmed());
  for (const body of [countdown(undefined, { operator: '前一位干员' }) + countdown(), countdown('2026-11-11T01:10:00.000Z') + countdown()])
    assert.equal(reconcileTraining(input, nativeTask(input, undefined, 5) + body, '2026-11-11T01:06:00.000Z').state, 'unknown');
  input.confirmationAt = '2026-11-11T01:05:20.000Z';
  assert.equal(reconcileTraining(input, nativeTask(input, undefined, 5) + countdown(), '2026-11-11T01:06:00.000Z').state, 'unknown');
});

test('owned assistant completion remains unverified and discards its pre-change countdown estimate', () => {
  const input = running(); input.action = { kind: 'assistant', dueAt: '2026-11-11T01:11:00.000Z', armedAt: input.createdAt };
  const changed = reconcileTraining(input, nativeTask(input, undefined, 5) + countdown('2026-11-11T01:11:01.000Z')
    + log('2026-11-11T01:11:05.000Z', 'TaskChainCompleted', { taskchain: 'Infrast', taskid: 5 }), '2026-11-11T01:12:00.000Z');
  assert.equal(changed.assistantState, 'unverified'); assert.equal(changed.expectedCompleteAt, undefined); assert.equal(changed.assistantAttempted, true);
  assert.equal(nextTrainingAction(changed, '2026-11-11T01:12:00.000Z')?.kind, 'observe');
});

test('trainee-not-found cannot be erased by its chain completion', () => {
  const input = plan(); input.action!.kind = 'preplace';
  const result = reconcileTraining(input, nativeTask(input)
    + log('2026-11-11T01:05:10.000Z', 'SubTaskExtraInfo', { taskchain: 'Infrast', taskid: 4, what: 'CustomInfrastTraineeNotFound', details: { candidates: ['合成干员'] } })
    + log('2026-11-11T01:05:20.000Z', 'TaskChainCompleted', { taskchain: 'Infrast', taskid: 4 }), '2026-11-11T01:06:00.000Z');
  assert.equal(result.state, 'unknown'); assert.equal(nextTrainingAction(result, '2026-11-11T01:06:00.000Z'), null);
});

test('R1-1 manual protection ends with its completed rank and preserves the approved next rank', () => {
  const input = observe(plan()); input.manualTraining = true;
  const manual = reconcileTraining(input, nativeTask(input, undefined, 5) + countdown(), '2026-11-11T01:06:00.000Z');
  assert.equal(manual.state, 'started'); assert.notEqual(nextTrainingAction(manual, '2026-11-11T01:06:00.000Z')?.kind, 'start');
  const done = reconcileTraining(manual, completion('2026-11-11T02:06:00.000Z'), '2026-11-11T02:07:00.000Z');
  assert.equal(done.rank, 2); assert.equal(done.manualTraining, false); assert.equal(done.materialReady, false);
  assert.equal(nextTrainingAction(done, '2026-11-11T02:07:00.000Z')?.kind, 'start');
});

test('R1-2 old fragments, clock rollback and reversed observations never advance current training', () => {
  const input = observe(confirmed(), '2026-11-11T01:05:00.000Z');
  const started = reconcileTraining(input, nativeTask(input, undefined, 5) + countdown(), '2026-11-11T01:06:00.000Z');
  for (const at of ['2026-11-11T01:05:00.000Z', '2026-11-11T01:05:05.000Z']) {
    const done = reconcileTraining(started, completion(at), '2026-11-11T01:07:00.000Z');
    assert.equal(done.rank, 1); assert.equal(done.target.currentRank, 0); assert.equal(done.state, 'unknown');
    assert.equal(nextTrainingAction(done, '2026-11-11T01:07:00.000Z'), null);
  }
  const reversed = reconcileTraining(started, countdown('2026-11-11T01:06:00.000Z') + completion('2026-11-11T01:05:30.000Z'), '2026-11-11T01:07:00.000Z');
  assert.equal(reversed.rank, 1); assert.equal(reversed.state, 'unknown');
});
