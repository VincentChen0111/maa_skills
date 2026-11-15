// Ticket 32 follow-on: facts the account snapshot already holds are read from it instead of asked (OB-4 training room,
// item 7 in-progress tier, OB-9 snapshot choice). A user-confirmed value still overrides; nothing is guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateTraining, queryTraining } from '../skills/maa-core/scripts/training-time.ts';
import { trainingFixture } from './fixtures/training-data.ts';

type Fixture = ReturnType<typeof trainingFixture>;
const readAt = '2026-11-12T00:00:00.000Z';
/** A Skland-style snapshot of the synthetic world: skills, mastery and the base as read at `readAt`. */
function skland(f: Fixture, trainee: Record<string, unknown> | null = null, rooms: unknown[] = [{ type: 'training', slotId: 'slot_train', level: 3, operators: trainee ? [trainee] : [] }]) {
  for (const operator of f.snapshot.operators) Object.assign(operator, { skillLevel: 7, mastery: { '1': 0, '2': 0, '3': 0 } });
  Object.assign(f.snapshot, { source: 'skland', readAt, sourceTimes: { operators: readAt, inventory: readAt }, base: { rooms },
    coverage: { operators: { status: 'complete', issues: [] }, inventory: { status: 'complete', issues: [] }, base: { status: 'complete', issues: [] } } });
  return f;
}
const unconfirmedRoom = (f: Fixture) => { delete (f.request.facts as Record<string, unknown>).trainingRoomLevel; return f; };
const training = (id: string, targetSkill: number, remainSecs: number) => ({ id, role: 'trainee', targetSkill, remainSecs, moodRaw: 0, moodAt: readAt });

test('32 OB-4: the training room level comes from the snapshot when the user did not confirm one; a confirmed level overrides', () => {
  const f = unconfirmedRoom(skland(trainingFixture(), null, [{ type: 'training', slotId: 'slot_train', level: 2, operators: [] }]));
  const two = calculateTraining(f.tables, f.snapshot, { ...f.request, target: 2 });
  assert.deepEqual(two.trainingRoom, { level: 2, source: 'snapshot' }); assert.ok(!two.issues.includes('training:room-unverified'), two.issues.join(','));
  const three = calculateTraining(f.tables, f.snapshot, { ...f.request, target: 3 }).issues; // FO1-6: M3 waits for its own refresh, M1 is not held
  assert.ok(three.includes('training:stage-3-pending') && !three.includes('training:room-rank-unavailable'), three.join(','));
  const confirmed = calculateTraining(f.tables, f.snapshot, { ...f.request, target: 3, facts: { ...f.request.facts, trainingRoomLevel: 3 } });
  assert.deepEqual(confirmed.trainingRoom, { level: 3, source: 'user-confirmed' }); assert.ok(!confirmed.issues.includes('training:room-rank-unavailable'));
  // No room, two rooms or no level in the snapshot: still a fact to confirm.
  for (const rooms of [[], [{ type: 'training', slotId: 'a', level: 2, operators: [] }, { type: 'training', slotId: 'b', level: 3, operators: [] }], [{ type: 'training', slotId: 'a', level: null, operators: [] }]]) {
    const g = unconfirmedRoom(skland(trainingFixture(), null, rooms));
    const result = calculateTraining(g.tables, g.snapshot, { ...g.request, target: 2 });
    assert.equal(result.trainingRoom, null); assert.ok(result.issues.includes('training:room-unverified'), JSON.stringify(rooms));
  }
});

test('32 item 7: the Skland trainee training this skill with time left is the in-progress tier; idle, another skill or no time left is not', () => {
  const tier = (trainee: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => {
    const f = skland(trainingFixture(), trainee); f.snapshot.items.mat = 20;
    return calculateTraining(f.tables, f.snapshot, { ...f.request, target: 3, ...extra });
  };
  const live = tier(training('char_synthetic', 0, 3600));
  assert.deepEqual([live.inTrainingRank, live.inTrainingSource, live.costFromRank, live.inventoryAt], [1, 'snapshot', 1, readAt]);
  for (const trainee of [training('char_synthetic', -1, 0), training('char_synthetic', 1, 3600), training('char_synthetic', 0, 0), training('char_helper', 0, 3600),
    { id: 'char_synthetic', role: 'trainee', moodRaw: 0, moodAt: readAt }, null]) assert.equal(tier(trainee).inTrainingRank, null, JSON.stringify(trainee));
  // An MAA recognition snapshot never carries this evidence.
  const f = skland(trainingFixture(), training('char_synthetic', 0, 3600)); Object.assign(f.snapshot, { source: 'maa' });
  assert.equal(calculateTraining(f.tables, f.snapshot, { ...f.request, target: 3 }).inTrainingSource, null);
  // A user statement the same read contradicts (the snapshot shows the operator idle) is not counted as paid.
  const conflict = tier(training('char_synthetic', -1, 0), { inTraining: { source: 'user-confirmed', rank: 1 } });
  assert.equal(conflict.inTrainingRank, null); assert.ok(conflict.issues.includes('training:in-training-snapshot-conflict'), conflict.issues.join(','));
  // A snapshot without the training fields neither confirms nor contradicts the user.
  const older = tier({ id: 'char_synthetic', role: 'trainee', moodRaw: 0, moodAt: readAt }, { inTraining: { source: 'user-confirmed', rank: 1 } });
  assert.deepEqual([older.inTrainingRank, older.inTrainingSource], [1, 'user-confirmed']);
});

test('32 OB-9: without a named snapshot the query reads the Skland snapshot whole when it covers what the default lacks, and says which', async t => {
  const root = await mkdtemp(join(tmpdir(), 'training-select-')); t.after(() => rm(root, { recursive: true, force: true }));
  const privateDirectory = join(root, 'private'); await mkdir(privateDirectory, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory }));
  const maa = trainingFixture(), sk = skland(trainingFixture(), null, [{ type: 'training', slotId: 'slot_train', level: 3, operators: [] }]);
  const tablesFile = join(root, 'tables.json'); await writeFile(tablesFile, JSON.stringify(maa.tables));
  const query = { ...unconfirmedRoom(trainingFixture()).request, target: 1, tablesFile };
  delete (query as Record<string, unknown>).current;
  await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(maa.snapshot));
  // Only the default exists: it is used, and the facts it lacks stay to confirm.
  const alone = await queryTraining(query, { home: root });
  assert.deepEqual(alone.result.snapshotUsed, { file: 'account-snapshot.json', source: 'maa', readAt: maa.snapshot.readAt, selected: 'default' });
  assert.deepEqual([alone.result.currentRank, alone.result.status], [null, 'needs-input']);
  // The Skland snapshot covers skills and the base the MAA snapshot never has: it is read whole (its own inventory too).
  sk.snapshot.items.mat = 7; await writeFile(join(privateDirectory, 'account-snapshot-skland.json'), JSON.stringify(sk.snapshot));
  const chosen = await queryTraining(query, { home: root });
  assert.deepEqual(chosen.result.snapshotUsed, { file: 'account-snapshot-skland.json', source: 'skland', readAt, selected: 'skland-covers-more' });
  assert.deepEqual([chosen.result.currentRank, chosen.result.trainingRoom], [0, { level: 3, source: 'snapshot' }]);
  assert.equal(chosen.result.materials.comparison?.noCraft.materials.mat?.available, 7);
  // A Skland snapshot that lacks the inventory the default has is not a superset: the default stays.
  Object.assign(sk.snapshot.coverage, { inventory: { status: 'unavailable', issues: [] } }); Object.assign(maa.snapshot.coverage, { inventory: { status: 'complete' } });
  await writeFile(join(privateDirectory, 'account-snapshot-skland.json'), JSON.stringify(sk.snapshot));
  await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(maa.snapshot));
  assert.equal((await queryTraining(query, { home: root })).result.snapshotUsed?.selected, 'default');
  // A named snapshot is read as named.
  const named = await queryTraining({ ...query, snapshotFile: join(privateDirectory, 'account-snapshot-skland.json') }, { home: root });
  assert.deepEqual([named.result.snapshotUsed?.file, named.result.snapshotUsed?.selected], ['account-snapshot-skland.json', 'named']);
});

test('32 FO1-1: the Skland snapshot is not chosen over a default whose inventory is newer, whatever it covers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'training-fresh-')); t.after(() => rm(root, { recursive: true, force: true }));
  const privateDirectory = join(root, 'private'); await mkdir(privateDirectory, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory }));
  const maa = trainingFixture(); maa.snapshot.items.mat = 0;
  Object.assign(maa.snapshot, { readAt: '2026-11-12T01:00:00.000Z', sourceTimes: { operators: null, inventory: '2026-11-12T00:00:00.000Z' } });
  const sk = skland(trainingFixture(), null); sk.snapshot.items.mat = 20; Object.assign(sk.snapshot, { readAt: '2026-11-10T00:00:00.000Z' });
  const tablesFile = join(root, 'tables.json'); await writeFile(tablesFile, JSON.stringify(maa.tables));
  await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(maa.snapshot));
  await writeFile(join(privateDirectory, 'account-snapshot-skland.json'), JSON.stringify(sk.snapshot));
  const query = { ...trainingFixture().request, target: 1, tablesFile };
  const older = await queryTraining(query, { home: root });
  assert.deepEqual([older.result.snapshotUsed?.file, older.result.snapshotUsed?.selected], ['account-snapshot.json', 'default-inventory-newer']);
  // A default without a scan time is bounded by its import time: a Skland read after that import is newer.
  Object.assign(maa.snapshot, { sourceTimes: { operators: null, inventory: null } }); await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(maa.snapshot));
  Object.assign(sk.snapshot, { readAt: '2026-11-12T02:00:00.000Z' }); await writeFile(join(privateDirectory, 'account-snapshot-skland.json'), JSON.stringify(sk.snapshot));
  assert.equal((await queryTraining(query, { home: root })).result.snapshotUsed?.selected, 'skland-covers-more');
});

test('32 FO2-4: a default snapshot without inventory does not outrank a complete Skland snapshot by its import time', async t => {
  const root = await mkdtemp(join(tmpdir(), 'training-noinv-')); t.after(() => rm(root, { recursive: true, force: true }));
  const privateDirectory = join(root, 'private'); await mkdir(privateDirectory, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory }));
  const maa = trainingFixture();
  Object.assign(maa.snapshot, { items: {}, lmd: null, readAt: '2026-11-12T01:00:00.000Z', sourceTimes: { operators: '2026-11-12T00:00:00.000Z', inventory: null },
    coverage: { operators: { status: 'complete' }, inventory: { status: 'missing', issues: [] } } });
  const sk = skland(trainingFixture(), null); Object.assign(sk.snapshot, { readAt: '2026-11-10T00:00:00.000Z' });
  const tablesFile = join(root, 'tables.json'); await writeFile(tablesFile, JSON.stringify(maa.tables));
  await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(maa.snapshot));
  await writeFile(join(privateDirectory, 'account-snapshot-skland.json'), JSON.stringify(sk.snapshot));
  const chosen = await queryTraining({ ...trainingFixture().request, target: 1, tablesFile }, { home: root });
  assert.equal(chosen.result.snapshotUsed?.selected, 'skland-covers-more');
});
