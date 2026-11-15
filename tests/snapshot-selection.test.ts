import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectSnapshot, snapshotCovers, SnapshotSelectionError } from '../skills/maa-core/scripts/account-snapshot.ts';
import { stageSnapshot, stageSklandSnapshot } from './fixtures/stage-data.ts';

// Over-blocking review OB-9 (dispatcher triage, 2026-11-16): one predicate decides which saved snapshot a query reads. The
// MAA recognition snapshot stays the default; when it lacks a domain the query needs and the Skland snapshot covers that
// domain completely, the Skland snapshot is read whole, never merged, and the choice is reported with its source.

const maa = stageSnapshot(), skland = stageSklandSnapshot();
const world = async (t: { after: (fn: () => Promise<void>) => void }, files: { maa?: unknown; skland?: unknown }) => {
  const directory = await mkdtemp(join(tmpdir(), 'maa-select-')); t.after(() => rm(directory, { recursive: true, force: true }));
  if (files.maa !== undefined) await writeFile(join(directory, 'account-snapshot.json'), typeof files.maa === 'string' ? files.maa : JSON.stringify(files.maa));
  if (files.skland !== undefined) await writeFile(join(directory, 'account-snapshot-skland.json'), typeof files.skland === 'string' ? files.skland : JSON.stringify(files.skland));
  return directory;
};

test('domain coverage: MAA recognition never covers skills or base; a complete Skland read covers every domain', () => {
  assert.equal(snapshotCovers(maa, 'operators'), true);
  assert.equal(snapshotCovers(maa, 'skills'), false);
  assert.equal(snapshotCovers(maa, 'base'), false);
  for (const domain of ['operators', 'skills', 'inventory'] as const) assert.equal(snapshotCovers(skland, domain, true), true, domain);
  assert.equal(snapshotCovers({ ...skland, coverage: { ...skland.coverage, operators: { status: 'partial', issues: ['missing-mastery'] } } }, 'skills', true), false);
});

test('the MAA snapshot stays the default when it covers what the query needs', async t => {
  const directory = await world(t, { maa, skland });
  const chosen = await selectSnapshot(directory, ['operators']);
  assert.equal(chosen.source, 'maa'); assert.equal(chosen.chosen, 'maa-default'); assert.deepEqual(chosen.lacking, []);
  assert.equal(chosen.readAt, maa.readAt);
});

test('a domain the MAA snapshot lacks and the Skland snapshot covers selects the Skland snapshot whole', async t => {
  const directory = await world(t, { maa, skland });
  const chosen = await selectSnapshot(directory, ['operators', 'skills']);
  assert.equal(chosen.source, 'skland'); assert.equal(chosen.chosen, 'skland-covers'); assert.deepEqual(chosen.lacking, ['skills']);
  assert.deepEqual(chosen.snapshot, skland, 'read whole, never merged');
  // A Skland read that does not cover the domain completely leaves the default in place, with the gap reported.
  const partial = await world(t, { maa, skland: { ...skland, coverage: { ...skland.coverage, operators: { status: 'partial', issues: ['missing-mastery'] } } } });
  const kept = await selectSnapshot(partial, ['operators', 'skills']);
  assert.equal(kept.source, 'maa'); assert.equal(kept.chosen, 'maa-default'); assert.deepEqual(kept.lacking, ['skills']);
  // Without a Skland snapshot the default is read and the gap stays visible.
  const alone = await selectSnapshot(await world(t, { maa }), ['operators', 'skills']);
  assert.equal(alone.source, 'maa'); assert.deepEqual(alone.lacking, ['skills']);
});

test('without a usable MAA snapshot the Skland snapshot is read; with neither the error says which', async t => {
  const missing = await selectSnapshot(await world(t, { skland }), ['operators']);
  assert.equal(missing.source, 'skland'); assert.equal(missing.chosen, 'maa-missing');
  const unreadable = await selectSnapshot(await world(t, { maa: '{"broken": ', skland }), ['operators']);
  assert.equal(unreadable.source, 'skland'); assert.equal(unreadable.chosen, 'maa-unreadable');
  await assert.rejects(selectSnapshot(await world(t, {}), ['operators']), (error: unknown) => error instanceof SnapshotSelectionError && error.kind === 'missing');
  await assert.rejects(selectSnapshot(await world(t, { maa: '{"broken": ' }), ['operators']), (error: unknown) => error instanceof SnapshotSelectionError && error.kind === 'unreadable');
});

test('an explicit snapshotFile is read as it is, whatever the domains', async t => {
  const directory = await world(t, { maa, skland });
  const chosen = await selectSnapshot(directory, ['operators', 'skills'], join(directory, 'account-snapshot.json'));
  assert.equal(chosen.source, 'maa'); assert.equal(chosen.chosen, 'explicit');
  await assert.rejects(selectSnapshot(directory, ['operators'], join(directory, 'absent.json')), (error: unknown) => error instanceof SnapshotSelectionError && error.kind === 'missing');
});
