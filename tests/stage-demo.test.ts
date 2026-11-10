import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStageDemo } from '../scripts/stage-demo.ts';

test('installed stage CLI demonstrates scope to approval to configuration readback without starting play', async () => {
  const result = await runStageDemo();
  assert.deepEqual(result, { status: 'complete', approvedLoops: 3, preparedPrimaryEntries: 3, approvedAlternates: 1, processActions: ['reopen'], actualGameRun: false });
});
