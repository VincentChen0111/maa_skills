import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('installation smoke drives query, prepare and read CLIs in a fresh synthetic home', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/training-smoke.ts'), resolve('skills/maa-core')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, checks: ['query', 'prepare', 'read'], state: 'pending', estimatedSeconds: 2400 });
});
