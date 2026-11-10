import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectTracker, renderIndex } from '../scripts/tracker.ts';

test('tracker derives readiness from progress and rejects a stale index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-tracker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/issues'), { recursive: true });
  await writeFile(join(root, 'docs/spec.md'), '# Spec');
  const ticket = (id: string, progress: string, blocked: string) => `# ${id}: Sample ${id}

Type: task
Labels: task
Status: ready-for-agent
Assignee: unassigned
Parent: [spec](../spec.md)
GitHub Issue: [#${Number(id) + 2}](https://github.com/example/maa/issues/${Number(id) + 2})
Blocked by: ${blocked}

实施进度：${progress}。
`;
  await writeFile(join(root, 'docs/issues/01-first.md'), ticket('01', '已完成', 'None (can start immediately)'));
  await writeFile(join(root, 'docs/issues/02-next.md'), ticket('02', '未开始', '[01](01-first.md)'));
  await writeFile(join(root, 'docs/issues/03-last.md'), ticket('03', '未开始', '[01](01-first.md), [02](02-next.md)'));
  await writeFile(join(root, 'docs/issues/INDEX.md'), '<!-- tracker:start -->\nstale\n<!-- tracker:end -->');
  const stale = await inspectTracker(root);
  assert.deepEqual(stale.ready, ['02']);
  assert.ok(stale.errors.some((error) => error.includes('stale-index')));
  await writeFile(join(root, 'docs/issues/INDEX.md'), renderIndex(stale.tickets));
  assert.deepEqual((await inspectTracker(root)).errors, []);
  const path = join(root, 'docs/issues/01-first.md');
  const original = await readFile(path, 'utf8');
  for (const [before, after, code] of [
    ['Type: task', '', 'missing-field'],
    ['Status: ready-for-agent', 'Status: done', 'invalid-status'],
    ['实施进度：已完成。', '实施进度：done。', 'invalid-progress'],
    ['Blocked by: None (can start immediately)', 'Blocked by: [02](02-next.md)', 'dependency-cycle'],
    ['Blocked by: None (can start immediately)', 'Blocked by: [99](99-missing.md)', 'missing-dependency'],
    ['Blocked by: None (can start immediately)', 'Blocked by: later', 'invalid-dependency'],
    ['Parent: [spec](../spec.md)', 'Parent: [spec](../missing.md)', 'broken-link'],
  ]) {
    await writeFile(path, original.replace(before!, after!));
    const result = await inspectTracker(root);
    assert.ok(result.errors.some((error) => error.includes(code!)), code);
    assert.deepEqual(result.ready, [], 'invalid trackers must never offer work');
  }
});
