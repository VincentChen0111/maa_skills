import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('offline entry executes tests in an isolated home and propagates failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'tests/probe.test.ts'), `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    test('isolation probe', () => {
      assert.notEqual(process.env.HOME, process.env.ORIGINAL_TEST_HOME);
      assert.equal(process.env.HOME, process.env.USERPROFILE);
      assert.ok(process.env.MAA_SKILLS_HOME?.startsWith(process.env.HOME!));
      throw new Error('synthetic-test-failure');
    });
  `);
  const command = fileURLToPath(new URL('../scripts/check.ts', import.meta.url));
  const result = spawnSync(process.execPath, [command, root], {
    encoding: 'utf8', env: { ...process.env, ORIGINAL_TEST_HOME: process.env.HOME ?? '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /synthetic-test-failure/);
  assert.doesNotMatch(result.stdout + result.stderr, /ERR_ASSERTION/);
});
