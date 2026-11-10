import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTraining, nextTrainingAction, type TrainingPlan } from '../skills/maa-core/scripts/training-state.ts';

import { plan, log, confirmation, countdown } from './fixtures/training-runtime.ts';

test('only confirmation plus matching live countdown establishes a start and its actual completion estimate', () => {
  const result = reconcileTraining(plan(), confirmation() + countdown(), '2026-11-11T01:06:00.000Z');
  assert.equal(result.state, 'started'); assert.equal(result.expectedCompleteAt, '2026-11-11T02:05:10.000Z');
  assert.equal(result.startedAt, '2026-11-11T01:05:01.000Z');
  assert.equal(result.assistantState, 'unverified');
  assert.deepEqual(reconcileTraining(result, confirmation() + countdown(), '2026-11-11T01:07:00.000Z'), result);
  for (const text of [confirmation(), countdown(), log('2026-11-11T01:05:01.000Z', 'AllTasksCompleted', { taskchain: 'OperProgress' })]) assert.notEqual(reconcileTraining(plan(), text, '2026-11-11T01:06:00.000Z').state, 'started');
});

test('preplacement completion anchors a separate native start at least six minutes later and remains unverified placement', () => {
  const input = plan(); input.action!.kind = 'preplace';
  const result = reconcileTraining(input, log('2026-11-11T01:06:00.000Z', 'TaskChainCompleted', { taskchain: 'Infrast', taskid: 4 }), '2026-11-11T01:07:00.000Z');
  assert.equal(result.state, 'preplaced'); assert.equal(result.startedAt, undefined);
  assert.deepEqual(nextTrainingAction(result, '2026-11-11T01:07:00.000Z'), { kind: 'start', dueAt: '2026-11-11T01:12:00.000Z' });
  assert.equal(result.assistantState, 'unverified');
});

test('actual completion advances one rank and a delayed countdown replaces the original estimate', () => {
  const started = reconcileTraining(plan(), confirmation() + countdown(), '2026-11-11T01:06:00.000Z');
  const delayed = reconcileTraining(started, countdown('2026-11-11T01:10:00.000Z'), '2026-11-11T01:11:00.000Z');
  assert.equal(delayed.expectedCompleteAt, '2026-11-11T02:10:00.000Z');
  assert.notEqual(reconcileTraining(delayed, '', '2026-11-11T02:12:00.000Z').state, 'complete');
  const finished = reconcileTraining(delayed, log('2026-11-11T02:11:00.000Z', 'SubTaskExtraInfo', { taskchain: 'Infrast', taskid: 9, what: 'InfrastTrainingCompleted', details: { operator: '合成干员', skill: '合成技能', level: 1 } }), '2026-11-11T02:12:00.000Z');
  assert.equal(finished.rank, 2); assert.equal(finished.target.currentRank, 1); assert.equal(finished.state, 'pending');
  assert.equal(nextTrainingAction(finished, '2026-11-11T02:12:00.000Z')?.kind, 'start');
});

test('target-already-met contradictions stop dependent scheduling while genuinely satisfied and manual stages are not replayed', () => {
  const event = log('2026-11-11T01:05:02.000Z', 'SubTaskExtraInfo', { taskchain: 'OperProgress', taskid: 4, what: 'OperProgressDetail',
    details: { role: 'Warrior', name: '合成干员', result: 'Success', result_detail: 'AlreadySatisfied', skill_mastery: [1, 0, 0] } });
  const failed = reconcileTraining(plan(), event, '2026-11-11T01:06:00.000Z');
  assert.equal(failed.state, 'failed'); assert.ok(failed.issues.includes('training:known-rank-contradiction')); assert.equal(nextTrainingAction(failed, '2026-11-11T01:06:00.000Z'), null);
  const known = plan(); known.target.currentRank = 1;
  assert.equal(reconcileTraining(known, event, '2026-11-11T01:06:00.000Z').state, 'satisfied');
  const manual = plan(); manual.manualTraining = true;
  const running = reconcileTraining(manual, countdown(), '2026-11-11T01:06:00.000Z');
  assert.equal(running.state, 'started'); assert.notEqual(nextTrainingAction(running, '2026-11-11T01:06:00.000Z')?.kind, 'start');
});

test('a confirmed native start schedules only observation until a later countdown proves it, and completes that observation', () => {
  const initial = reconcileTraining(plan(), confirmation() + log('2026-11-11T01:05:03.000Z', '10002', { taskchain: 'OperProgress', taskid: 4 }), '2026-11-11T01:06:00.000Z');
  assert.equal(initial.state, 'unknown'); assert.ok(initial.action?.completedAt);
  assert.equal(nextTrainingAction(initial, '2026-11-11T01:06:00.000Z')?.kind, 'observe');
  initial.action = { kind: 'observe', dueAt: '2026-11-11T01:11:00.000Z', armedAt: '2026-11-11T01:06:00.000Z' };
  const observed = reconcileTraining(initial, countdown('2026-11-11T01:11:01.000Z'), '2026-11-11T01:12:00.000Z');
  assert.equal(observed.state, 'started'); assert.ok(observed.action?.completedAt);
  assert.equal(nextTrainingAction(observed, '2026-11-11T01:12:00.000Z')?.kind, 'assistant');
});

test('wrong target, reversed evidence, future logs, and confirmation during preplacement never become started', () => {
  for (const text of [confirmation() + countdown(undefined, { operator: '前一位干员' }) + countdown(),
    confirmation('2026-11-11T01:05:20.000Z') + countdown(), confirmation('2026-11-11T01:10:00.000Z') + confirmation() + countdown()]) {
    assert.notEqual(reconcileTraining(plan(), text, '2026-11-11T01:06:00.000Z').state, 'started');
  }
  const preplace = plan(); preplace.action!.kind = 'preplace';
  assert.notEqual(reconcileTraining(preplace, confirmation() + countdown(), '2026-11-11T01:06:00.000Z').state, 'started');
});

test('assistant execution is not proof of placement and its pre-change countdown cannot schedule the next rank', () => {
  const initial = reconcileTraining(plan(), confirmation() + countdown(), '2026-11-11T01:06:00.000Z');
  initial.action = { kind: 'assistant', dueAt: '2026-11-11T01:11:00.000Z', armedAt: '2026-11-11T01:06:00.000Z' };
  const changed = reconcileTraining(initial, countdown('2026-11-11T01:11:01.000Z')
    + log('2026-11-11T01:11:05.000Z', 'TaskChainCompleted', { taskchain: 'Infrast' }), '2026-11-11T01:12:00.000Z');
  assert.equal(changed.assistantState, 'unverified'); assert.equal(changed.expectedCompleteAt, undefined);
  assert.equal(nextTrainingAction(changed, '2026-11-11T01:12:00.000Z')?.kind, 'observe');
});

test('a native trainee-not-found callback cannot be erased by task-chain completion', () => {
  const input = plan(); input.action!.kind = 'preplace';
  const result = reconcileTraining(input, log('2026-11-11T01:05:10.000Z', 'SubTaskExtraInfo', { taskchain: 'Infrast', what: 'CustomInfrastTraineeNotFound', details: { candidates: ['合成干员'] } })
    + log('2026-11-11T01:05:20.000Z', 'TaskChainCompleted', { taskchain: 'Infrast' }), '2026-11-11T01:06:00.000Z');
  assert.equal(result.state, 'unknown'); assert.equal(nextTrainingAction(result, '2026-11-11T01:06:00.000Z'), null);
});
