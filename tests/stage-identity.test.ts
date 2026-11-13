import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchStageJobs, collectStageJobs, formatStageJobs, resolveJobStage, type Job, type StageRequest } from '../skills/maa-core/scripts/stage-jobs.ts';
import { stageSnapshot } from './fixtures/stage-data.ts';
import { pinnedStages } from './fixtures/stage-identity-cases.ts';

const snapshot = stageSnapshot();
const pick = (...ids: string[]) => ({ stages: Object.fromEntries(ids.map(id => [id, pinnedStages[id]!])) });
const requestFor = (stageId: string, difficulty: 'normal' | 'raid'): StageRequest => ({ maaVersion: 'v6.21.4', completionEvidence: '合成用户本次确认前置通过',
  stages: [{ stageId, code: pinnedStages[stageId]!.code, difficulty, loops: 1 }],
  completions: Object.fromEntries(pinnedStages[stageId]!.unlockCondition.map((item: Record<string, string>) => [item.stageId, 'COMPLETE'])) });
const jobNamed = (id: number, stageName: string, difficulty?: number): Job => ({ id, source: { url: `https://prts.maa.plus/copilot/get/${id}`, readAt: '2026-11-13T00:00:00.000Z' },
  content: { stage_name: stageName, ...(difficulty === undefined ? {} : { difficulty }), minimum_required: 'v6.0.0', opers: [{ name: '合成甲', requirements: { elite: 2, level: 40 } }], groups: [],
    actions: [{ type: 'Deploy', name: '合成甲', location: [1, 1], direction: 'Left' }], doc: { title: '合成作业', details: '' } } });

test('a chapter-9 raid job named by the normal stageId is on this stage, and the search does not report "no jobs"', async () => {
  const tables = pick('main_09-01', 'main_09-01#f#');
  const fetcher: typeof fetch = async url => String(url).includes('/query?')
    ? Response.json({ status_code: 200, data: { has_next: false, data: [{ id: 501 }, { id: 502 }] } })
    : Response.json({ status_code: 200, data: { id: Number(String(url).split('/').at(-1)), content: JSON.stringify(jobNamed(501, 'main_09-01', 3).content) } });
  const report = await collectStageJobs(snapshot, tables, requestFor('main_09-01#f#', 'raid'), fetcher);
  const stage = report.stages[0]!;
  assert.deepEqual(stage.candidates.map(candidate => [candidate.id, candidate.status]), [[501, 'ready'], [502, 'ready']]);
  assert.equal(stage.searchResult.outcome, 'found'); assert.equal(stage.searchResult.belonging, 2);
  assert.equal(stage.primary, 501);
  assert.doesNotMatch(formatStageJobs(report), /这一关没有作业/);
});

test('stage identity conformance on pinned table cases: MAA resolves stage_name by exact stageId, code, levelId or name', () => {
  const all = { ...pinnedStages };
  const resolve = (name: string, selected: string) => resolveJobStage(all, name, all[selected]!).kind;
  // Every non-NONE shared-levelId pair in the pinned table: the 17 chapter-9 normal/raid twins (diffGroup NORMAL).
  for (let index = 1; index <= 17; index++) {
    const normal = `main_09-${String(index).padStart(2, '0')}`, raid = `${normal}#f#`;
    assert.equal(resolve(normal, raid), 'this-stage', raid); assert.equal(resolve(raid, raid), 'this-stage');
    assert.equal(resolve(raid, normal), 'this-stage'); assert.equal(resolve(normal, normal), 'this-stage');
    assert.equal(resolve(all[normal]!.levelId, raid), 'this-stage'); assert.equal(resolve(all[normal]!.code, raid), 'this-stage');
  }
  // act50side_ex01/ex02 have swapped levelIds; a job named after the other stageId is another stage, never this one.
  assert.equal(resolve('act50side_ex02', 'act50side_ex01'), 'other-stage');
  assert.equal(resolve('act50side_ex02', 'act50side_ex01#f#'), 'other-stage');
  assert.equal(resolve('act50side_ex01', 'act50side_ex02'), 'other-stage');
  assert.equal(resolve('act50side_ex01', 'act50side_ex01'), 'this-stage');
  assert.equal(resolve('Activities/act50side/level_act50side_ex02', 'act50side_ex01'), 'this-stage');
  assert.equal(resolve('TD-EX-1', 'act50side_ex01#f#'), 'this-stage');
  // A NONE stage named only by its levelId tail: MAA does not match tails, so it cannot be proven.
  assert.equal(resolve('training_1', 'tr_01'), 'unknown');
  assert.equal(resolve('tr_01', 'tr_01'), 'this-stage'); assert.equal(resolve('Obt/Training/level_training_1', 'tr_01'), 'this-stage');
  // An ordinary NONE normal/raid pair.
  assert.equal(resolve('main_01-07', 'main_01-07#f#'), 'this-stage'); assert.equal(resolve('main_01-07#f#', 'main_01-07'), 'this-stage');
  // #s shares the map but has no copilot difficulty bit: same map, unprovable.
  assert.equal(resolve('main_17-01#s', 'main_17-01'), 'same-map-unprovable');
  assert.equal(resolve('Obt/Main/level_main_17-01', 'main_17-01'), 'same-map-unprovable');
  assert.equal(resolve('main_17-01', 'main_17-01'), 'this-stage');
  // Shared codes across difficulty groups are ambiguous; another group's own stageId is another map.
  assert.equal(resolve('10-2', 'main_10-01'), 'unknown');
  assert.equal(resolve('tough_10-01', 'main_10-01'), 'other-stage'); assert.equal(resolve('main_10-01', 'tough_10-01'), 'other-stage');
  assert.equal(resolve('not-a-stage', 'main_10-01'), 'unknown'); assert.equal(resolveJobStage(all, 42, all['main_10-01']!).kind, 'unknown');
});

test('the per-job map check uses the same predicate and the report keeps the table entries it resolved against', () => {
  const tables = pick('act50side_ex01', 'act50side_ex01#f#', 'act50side_ex02', 'act50side_ex02#f#', 'main_17-01', 'main_17-01#s', 'tr_01');
  const swapped = matchStageJobs(snapshot, tables, requestFor('act50side_ex01', 'normal'), [jobNamed(1, 'act50side_ex02', 1), jobNamed(2, 'act50side_ex01', 1), jobNamed(3, 'TD-EX-1', 1)]);
  assert.deepEqual(swapped.stages[0]!.candidates.map(candidate => [candidate.id, candidate.status, candidate.stageMatch]), [[1, 'blocked', 'other-stage'], [2, 'ready', 'this-stage'], [3, 'ready', 'this-stage']]);
  assert.ok(swapped.stages[0]!.candidates[0]!.reasons.includes('map-mismatch'));
  assert.deepEqual(Object.keys(swapped.tables.stages), ['act50side_ex01', 'act50side_ex01#f#', 'act50side_ex02']);
  assert.equal(matchStageJobs(swapped.snapshot, swapped.tables, swapped.request, swapped.jobs, swapped.search).hash, swapped.hash);
  const sixStar = matchStageJobs(snapshot, tables, requestFor('main_17-01', 'normal'), [jobNamed(4, 'main_17-01#s', 1)]).stages[0]!.candidates[0]!;
  assert.equal(sixStar.status, 'blocked'); assert.ok(sixStar.reasons.includes('stage-same-map-unproven'));
  const tail = matchStageJobs(snapshot, tables, requestFor('tr_01', 'normal'), [jobNamed(5, 'training_1', 1)]).stages[0]!.candidates[0]!;
  assert.equal(tail.status, 'blocked'); assert.ok(tail.reasons.includes('stage-name-unresolved'));
  assert.match(formatStageJobs(matchStageJobs(snapshot, tables, requestFor('main_17-01', 'normal'), [jobNamed(4, 'main_17-01#s', 1)])), /作业写的关卡 main_17-01#s 与这一关同一张地图，但属于其他难度组或模式，无法证明适用/);
});

test('difficulty 0 or missing means normal only, as the pinned MAA GUI adds such jobs to the list', () => {
  const tables = pick('main_01-07', 'main_01-07#f#');
  for (const difficulty of [undefined, 0]) {
    assert.equal(matchStageJobs(snapshot, tables, requestFor('main_01-07', 'normal'), [jobNamed(6, 'main_01-07', difficulty)]).stages[0]!.candidates[0]!.status, 'ready', String(difficulty));
    const raid = matchStageJobs(snapshot, tables, requestFor('main_01-07#f#', 'raid'), [jobNamed(7, 'main_01-07', difficulty)]).stages[0]!.candidates[0]!;
    assert.equal(raid.status, 'blocked'); assert.deepEqual(raid.reasons, ['difficulty-unstated-normal-only']);
  }
  for (const difficulty of [4, -1, 1.5]) assert.ok(matchStageJobs(snapshot, tables, requestFor('main_01-07', 'normal'), [jobNamed(8, 'main_01-07', difficulty)]).stages[0]!.candidates[0]!.reasons.includes('difficulty-mismatch'));
});

test('search results on the same map or with unresolvable names are never reported as "no jobs"', async () => {
  const run = async (tables: { stages: Record<string, unknown> }, stageId: string, names: string[]) => collectStageJobs(snapshot, tables, requestFor(stageId, 'normal'), async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/query')) return Response.json({ status_code: 200, data: { has_next: false, data: names.map((_, index) => ({ id: 600 + index })) } });
    const id = Number(parsed.pathname.split('/').at(-1));
    return Response.json({ status_code: 200, data: { id, content: JSON.stringify(jobNamed(id, names[id - 600]!, 1).content) } });
  });
  const sameMap = await run(pick('main_17-01', 'main_17-01#s'), 'main_17-01', ['main_17-01#s']);
  assert.deepEqual(sameMap.stages[0]!.searchResult, { outcome: 'same-map-unproven', returned: 1, belonging: 0, sameMap: 1, unresolved: 0 });
  assert.match(formatStageJobs(sameMap), /检索结果：返回的 1 份作业中，1 份与这一关同一张地图，但属于其他难度组或模式，无法证明适用；不能据此判断这一关没有作业。/);
  const ambiguous = await run(pick('main_10-01', 'tough_10-01', 'easy_10-01'), 'main_10-01', ['10-2', 'main_10-010']);
  assert.deepEqual(ambiguous.stages[0]!.searchResult, { outcome: 'unresolved', returned: 2, belonging: 0, sameMap: 0, unresolved: 2 });
  assert.match(formatStageJobs(ambiguous), /检索结果：返回的 2 份作业中，2 份的关卡名对应不到唯一的关卡；不能据此判断这一关没有作业。/);
  for (const report of [sameMap, ambiguous]) assert.doesNotMatch(formatStageJobs(report), /本次检索条件下这一关没有作业/);
  // Both consumers of the predicate agree: the per-candidate verdicts are exactly what the search classification counted.
  for (const report of [sameMap, ambiguous]) for (const [index, stage] of report.stages.entries()) {
    const returned = stage.candidates.filter(candidate => report.search[index]!.ids.includes(candidate.id));
    assert.deepEqual([stage.searchResult.belonging, stage.searchResult.sameMap, stage.searchResult.unresolved],
      (['this-stage', 'same-map-unprovable', 'unknown'] as const).map(kind => returned.filter(candidate => candidate.stageMatch === kind).length));
  }
});
