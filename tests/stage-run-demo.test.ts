import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStageRunDemo } from '../scripts/stage-run-demo.ts';

test('installed CLIs track a prepared batch from the user start signal to a per-stage result without operating MAA or a device', async () => {
  const result = await runStageRunDemo();
  assert.deepEqual(result, {
    startSignal: '合成用户：准备好了，我现在点开始',
    whileRunning: { execution: 'tracking', next: 'keep-observing', stages: [['SYN-1', 'not-evaluated'], ['SYN-2', 'not-evaluated']] },
    final: { execution: 'failed', next: 'report', stages: [['SYN-1', 'success', 'unknown'], ['SYN-2', 'not-three-star', 'unknown']],
      reported: ['gui-marker', 'stage-result', 'chain-end'], medicine: { count: 0, approved: 0, unapproved: false, enabledAtStart: false, final: true },
      allowedDecisions: ['switch-alternate', 'stop-and-tell-user'] },
    processActions: ['reopen'], trackingProcessActions: [], actualGameRun: false,
  });
});
