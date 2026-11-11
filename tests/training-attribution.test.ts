import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTraining, nextTrainingAction, type TrainingActionKind } from '../skills/maa-core/scripts/training-state.ts';
import { plan, log, nativeTask } from './fixtures/training-evidence.ts';

test('R1-4 every action requires its submitted parameters, task ID, process and chain start before completion', () => {
  for (const kind of ['start', 'preplace', 'assistant', 'observe'] as TrainingActionKind[]) {
    for (const evidence of ['bare-completion', 'wrong-params', 'wrong-id', 'wrong-process', 'wrong-chain', 'no-start']) {
      const input = plan(); input.action!.kind = kind;
      const chain = kind === 'start' ? 'OperProgress' : 'Infrast';
      let text = evidence === 'bare-completion' ? '' : nativeTask(input, undefined, 4, evidence === 'wrong-params' ? { params: { facility: ['Mfg'] } } : {});
      if (evidence === 'no-start') text = text.split('\n').filter(row => !row.includes('TaskChainStart')).join('\n') + '\n';
      text += log('2026-11-11T01:06:00.000Z', 'TaskChainCompleted', { taskchain: evidence === 'wrong-chain' ? chain === 'Infrast' ? 'OperProgress' : 'Infrast' : chain,
        taskid: evidence === 'wrong-id' ? 91 : 4 }, evidence === 'wrong-process' ? 18 : 17);
      const result = reconcileTraining(input, text, '2026-11-11T01:07:00.000Z');
      assert.equal(result.action?.completedAt, undefined, `${kind}/${evidence}`);
      assert.equal(result.preplacedAt, undefined); assert.equal(result.assistantAttempted, undefined);
    }
  }
});

test('owned native evidence persists across log chunks while ambiguous submissions and parameter edits stay unknown', () => {
  const input = plan(); input.action!.kind = 'preplace';
  const first = reconcileTraining(input, nativeTask(input), '2026-11-11T01:05:30.000Z');
  const completion = log('2026-11-11T01:06:00.000Z', 'TaskChainCompleted', { taskchain: 'Infrast', taskid: 4 });
  assert.equal(reconcileTraining(first, completion, '2026-11-11T01:07:00.000Z').state, 'preplaced');
  for (const more of [nativeTask(input, '2026-11-11T01:05:30.000Z', 6),
    '[2026-11-11T01:05:30.000Z][INF][Px17][Tx20] asst::Assistant::set_task_params 4 {"facility":["Mfg"]}\n']) {
    const result = reconcileTraining(first, more + completion, '2026-11-11T01:07:00.000Z');
    assert.equal(result.state, 'unknown'); assert.equal(result.action?.completedAt, undefined);
  }
});

test('a persisted completion claim without native ownership cannot grant a new start', () => {
  const input = plan(); input.action!.completedAt = '2026-11-11T01:06:00.000Z'; input.preplacementRequired = false;
  assert.equal(nextTrainingAction(input, '2026-11-11T01:07:00.000Z'), null);
});
