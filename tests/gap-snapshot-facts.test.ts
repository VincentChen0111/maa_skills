// Ticket 32 follow-on: the gap tool reads room levels the snapshot holds (OB-7), accepts one user confirmation over exactly
// the stage IDs it reported (item 8), and without a named snapshot uses the one whole snapshot that covers what it needs (OB-9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateCultivationGaps, queryCultivationGaps, craftingSources } from '../skills/maa-core/scripts/cultivation-gaps.ts';
import { operatorCostSources } from '../skills/maa-core/scripts/operator-cost.ts';
import { gapTables, gapSnapshot, gapGoal } from './fixtures/gap-data.ts';

/** The synthetic recipe additionally needs a level-3 manufacture (like the dual chips); ore covers one mat. */
function manufactured() {
  const tables = gapTables();
  tables.building.workshopFormulas.synthetic.requireRooms.push({ roomId: 'MANUFACTURE', roomLevel: 3, roomCount: 1 });
  const snapshot = gapSnapshot(); Object.assign(snapshot.items, { ore: 2 });
  return { tables, snapshot };
}
const base = (level: number, status = 'complete') => ({ base: { rooms: [{ type: 'manufacture', slotId: 'slot_manu_1', level, operators: [] }, { type: 'manufacture', slotId: 'slot_manu_2', level: 1, operators: [] }] },
  coverage: { ...gapSnapshot().coverage, base: { status, issues: [] } } });
const progress = { source: 'user-confirmed', rooms: { WORKSHOP: [3] }, stageRanks: { stage_synthetic: 2 } };
const crafted = (result: ReturnType<typeof calculateCultivationGaps>) => result.comparison!.craft.steps.reduce((sum, step) => sum + step.output.count, 0);

test('32 OB-7: recipe room levels come from the snapshot base when the user did not confirm them; WORKSHOP still needs the user', () => {
  const { tables, snapshot } = manufactured();
  const unknown = calculateCultivationGaps(tables, snapshot, { targets: [gapGoal], progress });
  assert.equal(crafted(unknown), 0); assert.ok(JSON.stringify(unknown.comparison!.craft.blocked).includes('room:MANUFACTURE:unknown'));
  const read = calculateCultivationGaps(tables, { ...snapshot, ...base(3) }, { targets: [gapGoal], progress });
  assert.equal(crafted(read), 1); assert.deepEqual(read.inputSources.rooms, { MANUFACTURE: 'snapshot', WORKSHOP: 'user-confirmed' });
  // A level the user confirmed overrides the snapshot; an incomplete base read is not used.
  const confirmed = calculateCultivationGaps(tables, { ...snapshot, ...base(3) }, { targets: [gapGoal], progress: { ...progress, rooms: { WORKSHOP: [3], MANUFACTURE: [2] } } });
  assert.equal(crafted(confirmed), 0); assert.ok(JSON.stringify(confirmed.comparison!.craft.blocked).includes('room:MANUFACTURE:insufficient'));
  assert.equal(crafted(calculateCultivationGaps(tables, { ...snapshot, ...base(3, 'partial') }, { targets: [gapGoal], progress })), 0);
  // The snapshot never has the workshop: without the user's level it stays unknown.
  const noWorkshop = calculateCultivationGaps(tables, { ...snapshot, ...base(3) }, { targets: [gapGoal], progress: { source: 'user-confirmed', stageRanks: { stage_synthetic: 2 } } });
  assert.ok(JSON.stringify(noWorkshop.comparison!.craft.blocked).includes('room:WORKSHOP:unknown'));
});

test('32 item 8: one confirmation over the reported stage IDs settles them; an ID no recipe requires is refused', () => {
  const tables = gapTables(), snapshot = gapSnapshot(); Object.assign(snapshot.items, { ore: 2 });
  const asked = calculateCultivationGaps(tables, snapshot, { targets: [gapGoal], progress: { source: 'user-confirmed', rooms: { WORKSHOP: [3] } } });
  assert.ok(JSON.stringify(asked.comparison!.craft.blocked).includes('stage:stage_synthetic:unknown')); assert.deepEqual(asked.stageCodes, { stage_synthetic: 'SYN-1' });
  const settled = calculateCultivationGaps(tables, snapshot, { targets: [gapGoal], progress: { source: 'user-confirmed', rooms: { WORKSHOP: [3] }, confirmedStages: Object.keys(asked.stageCodes) } });
  assert.equal(crafted(settled), 1);
  const invented = calculateCultivationGaps(tables, snapshot, { targets: [gapGoal], progress: { source: 'user-confirmed', rooms: { WORKSHOP: [3] }, confirmedStages: ['stage_never_required'] } });
  assert.ok(invented.issues.includes('progress:confirmedStages:invalid'), invented.issues.join(','));
});

test('32 OB-9: without a named snapshot the gap query reads the Skland snapshot whole when it covers what the default lacks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gap-select-')); t.after(() => rm(root, { recursive: true, force: true }));
  const privateDirectory = join(root, 'private'); await mkdir(privateDirectory, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory }));
  const { tables, snapshot } = manufactured();
  await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(snapshot));
  const sk = { ...structuredClone(snapshot), ...base(3), source: 'skland', readAt: '2026-11-12T00:00:00.000Z',
    operators: snapshot.operators.map(row => ({ ...row, skillLevel: 7, mastery: { '1': 0 } })) };
  Object.assign(sk.coverage, { operators: { status: 'complete', issues: [] }, inventory: { status: 'complete', issues: [] } });
  await writeFile(join(privateDirectory, 'account-snapshot-skland.json'), JSON.stringify(sk));
  const network = Object.fromEntries(Object.entries({ ...operatorCostSources, ...craftingSources }).map(([key, source]) => [
    `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`, (tables as Record<string, unknown>)[key]]));
  const fetcher: typeof fetch = async input => new Response(JSON.stringify(network[String(input)]));
  const chosen = await queryCultivationGaps({ targets: [gapGoal], progress }, { home: root, fetcher });
  assert.deepEqual(chosen.snapshotUsed, { file: 'account-snapshot-skland.json', source: 'skland', readAt: '2026-11-12T00:00:00.000Z', selected: 'skland-covers-more' });
  assert.equal(crafted(chosen), 1, 'the manufacture level came from the Skland snapshot it read');
  const named = await queryCultivationGaps({ targets: [gapGoal], progress, snapshotFile: join(privateDirectory, 'account-snapshot.json') }, { home: root, fetcher });
  assert.deepEqual([named.snapshotUsed?.file, named.snapshotUsed?.selected, crafted(named)], ['account-snapshot.json', 'named', 0]);
});
