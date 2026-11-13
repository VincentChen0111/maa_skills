import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLogCursor, readLogSince } from '../skills/maa-core/scripts/maa-log-window.ts';

async function maaDirectory(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'maa-log-window-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'debug'));
  return root;
}

test('the anchor records offset, size, identity and tail hash; only later complete lines belong to the run', async t => {
  const root = await maaDirectory(t), log = join(root, 'debug/asst.log');
  await writeFile(log, 'before 1\nbefore 2\npartial-before');
  const anchor = await captureLogCursor(root, 'asst');
  assert.equal(anchor.present, true); assert.equal(anchor.offset, anchor.size); assert.match(anchor.tailHash!, /^[a-f0-9]{64}$/);
  assert.ok(anchor.identity); assert.equal(anchor.tailLength, anchor.size);
  await appendFile(log, ' still before\nrun 1\nrun 2\nincomplete');
  const first = await readLogSince(root, 'asst', anchor);
  assert.deepEqual(first.lines, ['run 1', 'run 2']); assert.equal(first.gap, null); assert.equal(first.rotated, false);
  await appendFile(log, ' line\r\nrun 3\n');
  const second = await readLogSince(root, 'asst', first.cursor);
  assert.deepEqual(second.lines, ['incomplete line', 'run 3']);
  assert.deepEqual((await readLogSince(root, 'asst', second.cursor)).lines, []);
});

test('a rotation into the .bak file is followed: rest of the old file, then the new file from its start', async t => {
  const root = await maaDirectory(t), log = join(root, 'debug/asst.log');
  await writeFile(log, 'old\n');
  const anchor = await captureLogCursor(root, 'asst');
  await appendFile(log, 'run before rotation\n');
  await rename(log, join(root, 'debug/asst.bak.log'));
  await writeFile(log, 'run after rotation\n');
  const read = await readLogSince(root, 'asst', anchor);
  assert.deepEqual(read.lines, ['run before rotation', 'run after rotation']);
  assert.equal(read.rotated, true); assert.equal(read.gap, null);
  await appendFile(log, 'later\n');
  assert.deepEqual((await readLogSince(root, 'asst', read.cursor)).lines, ['later']);
});

test('a log that cannot be connected to the anchor is a gap; the whole current file is not taken as this run', async t => {
  const root = await maaDirectory(t), log = join(root, 'debug/asst.log');
  await writeFile(log, 'old content that is long enough\n');
  const anchor = await captureLogCursor(root, 'asst');
  await rename(log, join(root, 'debug/asst.bak.log'));
  await writeFile(join(root, 'debug/asst.bak.log'), 'second rotation replaced the old file\n');
  await writeFile(log, 'unknown origin\n');
  const read = await readLogSince(root, 'asst', anchor);
  assert.equal(read.gap, 'rotated-unmatched'); assert.deepEqual(read.lines, []);
  await appendFile(log, 'after resync\n');
  assert.deepEqual((await readLogSince(root, 'asst', read.cursor)).lines, ['after resync']);

  const gui = join(root, 'debug/gui.log');
  await writeFile(gui, 'gui before the run started\n');
  const guiAnchor = await captureLogCursor(root, 'gui');
  await truncate(gui, 0); await writeFile(gui, 'rewritten\n');
  const truncated = await readLogSince(root, 'gui', guiAnchor);
  assert.equal(truncated.gap, 'truncated'); assert.deepEqual(truncated.lines, []);
});

test('a log missing at the anchor is read from its start once MAA creates it', async t => {
  const root = await maaDirectory(t);
  const anchor = await captureLogCursor(root, 'gui');
  assert.deepEqual({ present: anchor.present, offset: anchor.offset, identity: anchor.identity }, { present: false, offset: 0, identity: null });
  assert.deepEqual((await readLogSince(root, 'gui', anchor)).lines, []);
  await writeFile(join(root, 'debug/gui.log'), 'created during run\n');
  assert.deepEqual((await readLogSince(root, 'gui', anchor)).lines, ['created during run']);
});
