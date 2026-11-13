import test from 'node:test';
import assert from 'node:assert/strict';
import { callbackMessageNames, parseCallbackBody, parseCallbackLine, parseCoreLogLine, parseTaskAssignment, parseTaskParamsChange, parseTaskSubmission }
  from '../skills/maa-core/scripts/maa-callback.ts';

const line = (body: string, time = '2026-11-13 10:00:00.123') => `[${time}][INF][Px4321][Tx77] Assistant::append_callback | ${body}`;

test('callback lines keep the MaaCore envelope: time, process, thread, message name and JSON payload', () => {
  const parsed = parseCallbackLine(line('SubTaskExtraInfo {"taskchain":"Copilot","taskid":3,"what":"UseMedicine","details":{"count":2},"uuid":"synthetic-device"}'));
  assert.ok(parsed);
  assert.equal(parsed.time, '2026-11-13 10:00:00.123'); assert.equal(parsed.processId, '4321'); assert.equal(parsed.threadId, '77');
  assert.equal(parsed.method, 'append_callback'); assert.equal(parsed.message, 'SubTaskExtraInfo');
  assert.deepEqual(parsed.payload.details, { count: 2 });
});

test('numeric message codes map to the fixed protocol names; unknown names stay as written', () => {
  assert.equal(parseCallbackBody('| 10000 {"taskchain":"Copilot","taskid":1}')?.message, 'TaskChainError');
  assert.equal(parseCallbackBody('| 2 {"what":"Disconnect"}')?.message, 'ConnectionInfo');
  assert.equal(parseCallbackBody('| 20000 {"subtask":"ProcessTask"}')?.message, 'SubTaskError');
  assert.equal(parseCallbackBody('| FutureMessage {"a":1}')?.message, 'FutureMessage');
  for (const [code, name] of Object.entries({ 0: 'InternalError', 3: 'AllTasksCompleted', 5: 'Destroyed', 10001: 'TaskChainStart', 10002: 'TaskChainCompleted', 10004: 'TaskChainStopped', 20003: 'SubTaskExtraInfo' })) {
    assert.equal(callbackMessageNames[code], name);
  }
});

test('non-callback text, broken JSON and non-object payloads are never read as callbacks', () => {
  assert.equal(parseCallbackLine('[2026-11-13 10:00:00.000][INF][Px1][Tx1] 任务出错: 自动战斗'), null);
  assert.equal(parseCallbackLine(line('SubTaskError {"taskchain":')), null);
  assert.equal(parseCallbackLine('Assistant::append_callback | SubTaskError {"a":1}'), null);
  assert.deepEqual(parseCallbackBody('| SubTaskError {"a":1}  ')?.payload, { a: 1 });
  assert.deepEqual(parseCallbackBody('| SubTaskError ["not-object"]'), null);
});

test('task submission, task id assignment and parameter change bodies use the same envelope', () => {
  const submission = parseCoreLogLine('[2026-11-13 10:00:00.000][INF][Px9][Tx2] asst::Assistant::append_task Copilot {"use_sanity_potion":false}');
  assert.equal(submission?.method, 'append_task');
  assert.deepEqual(parseTaskSubmission(submission!.body), { type: 'Copilot', params: { use_sanity_potion: false }, valid: true });
  assert.deepEqual(parseTaskSubmission('Copilot {broken}'), { type: 'Copilot', valid: false });
  assert.equal(parseTaskAssignment('| task_id: 12'), 12);
  assert.equal(parseTaskAssignment('Copilot {}'), null);
  assert.deepEqual(parseTaskParamsChange('12 {"enable":false}'), { taskId: 12, json: '{"enable":false}' });
  assert.equal(parseCoreLogLine('no envelope'), null);
});
