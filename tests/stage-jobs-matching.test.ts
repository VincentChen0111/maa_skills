import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { matchStageJobs, formatStageJobs, type Job } from '../skills/maa-core/scripts/stage-jobs.ts';
import { stageSnapshot, stageTables, stageRequest, stageJob } from './fixtures/stage-data.ts';

const snapshot = stageSnapshot();
const withOpers = (id: number, opers: unknown[], extra: Record<string, unknown> = {}): Job => ({ ...stageJob(id), content: { ...stageJob(id).content, opers, ...extra } });
const first = (jobs: Job[], tables: unknown = stageTables) => matchStageJobs(snapshot, tables, stageRequest, jobs).stages[0]!;

test('operator entries without written requirements stay 待核 instead of passing on ownership alone', () => {
  for (const requirements of [undefined, null, {}]) {
    const oper = requirements === undefined ? { name: '合成甲' } : { name: '合成甲', requirements };
    const stage = first([withOpers(11, [oper])]);
    const candidate = stage.candidates[0]!;
    assert.equal(candidate.status, 'unknown', JSON.stringify(requirements));
    assert.ok(candidate.requirements[0]!.reasons.includes('requirements-unstated'));
    assert.equal(stage.primary, null);
  }
  // Skill-derived floors are still shown, but they do not make an unstated entry satisfied.
  const skilled = first([withOpers(12, [{ name: '合成甲', skill: 2 }])]).candidates[0]!;
  assert.equal(skilled.status, 'unknown'); assert.equal(skilled.requirements[0]!.effectiveRequired.elite, 1);
  // An explicit written value, even "no requirement", is the author's statement and is checked as before.
  assert.equal(first([withOpers(13, [{ name: '合成甲', requirements: { elite: -1 } }])]).candidates[0]!.status, 'ready');
  assert.equal(first([withOpers(14, [{ name: '合成甲', requirements: { elite: 0, level: 1 } }])]).candidates[0]!.status, 'ready');
  const markdown = formatStageJobs(matchStageJobs(snapshot, stageTables, stageRequest, [withOpers(11, [{ name: '合成甲' }])]));
  assert.match(markdown, /要求未写明，待核/);
});

test('CLI query reports unstated requirements as 待核 in Markdown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maa-stage-unstated-')); t.after(() => rm(root, { recursive: true, force: true }));
  const privateDirectory = join(root, 'private'); await mkdir(privateDirectory);
  await updateSettings({ language: 'zh-CN', privateDirectory }, root);
  await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(snapshot));
  const tablesFile = join(root, 'tables.json'), jobsFile = join(root, 'jobs.json');
  await writeFile(tablesFile, JSON.stringify(stageTables)); await writeFile(jobsFile, JSON.stringify([withOpers(21, [{ name: '合成甲' }])]));
  const script = fileURLToPath(new URL('../skills/maa-core/scripts/stage-jobs.ts', import.meta.url));
  const cli = spawnSync(process.execPath, [script, 'query'], { input: JSON.stringify({ request: stageRequest, tablesFile, jobsFile, format: 'markdown' }), encoding: 'utf8', env: { ...process.env, MAA_SKILLS_HOME: root } });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /作业 21：unknown/); assert.match(cli.stdout, /合成甲.*要求未写明，待核/);
  assert.match(cli.stdout, /主作业候选：待核/);
});

const rated = (id: number, like: number, dislike: number, notEnoughRating: boolean): Job => ({ ...stageJob(id),
  rating: { like, dislike, notEnoughRating, ratingLevel: Math.round(like / Math.max(1, like + dislike) * 10), ratingRatio: Math.round(like / Math.max(1, like + dislike) * 10) / 10,
    source: { url: 'https://prts.maa.plus/copilot/query?page=1', readAt: '2026-11-13T00:00:00.000Z' } } });

test('ratings only reorder ready candidates: enough and well-liked first, then not-enough or unknown, then low like ratio', () => {
  const jobs = [rated(31, 3, 0, true), rated(32, 60, 40, false), rated(33, 95, 5, false), stageJob(34), rated(35, 30, 2, false)];
  const stage = first(jobs);
  assert.deepEqual(stage.candidates.map(candidate => candidate.id), [31, 32, 33, 34, 35]);
  assert.ok(stage.candidates.every(candidate => candidate.status === 'ready'));
  assert.equal(stage.primary, 33); assert.deepEqual(stage.alternates, [35, 31, 34]);
  const flags = Object.fromEntries(stage.candidates.map(candidate => [candidate.id, candidate.rating.flag]));
  assert.deepEqual(flags, { 31: 'not-enough', 32: 'low', 33: 'ok', 34: 'unknown', 35: 'ok' });
  const low = stage.candidates.find(candidate => candidate.id === 32)!.rating;
  assert.equal(low.votes, 100); assert.equal(low.likeRatio, 0.6); assert.equal(low.requiredRatio, 0.85);
  // The required ratio rises with votes from 65% at 5 votes to a cap of 85% at 100 votes.
  const required = (like: number, dislike: number) => first([rated(40, like, dislike, false)]).candidates[0]!.rating.requiredRatio;
  assert.equal(required(9, 2), 0.7026); assert.equal(required(40, 10), 0.8037); assert.equal(required(900, 100), 0.85);
  assert.equal(first([rated(41, 80, 20, false)]).candidates[0]!.rating.flag, 'low');
  assert.equal(first([rated(42, 85, 15, false)]).candidates[0]!.rating.flag, 'ok');
  // Rating never replaces requirement checks: a well-rated job that is not ready is never suggested.
  const blocked = { ...rated(43, 500, 0, false), content: { ...stageJob(43).content, difficulty: 2 } };
  const mixed = first([blocked, rated(44, 1, 9, false)]);
  assert.equal(mixed.primary, 44); assert.equal(mixed.candidates[0]!.status, 'blocked');
  // Malformed rating data is unknown, not a crash and not a preference.
  const broken = { ...stageJob(45), rating: { like: -1, dislike: 'x', notEnoughRating: 'no' } } as unknown as Job;
  assert.equal(first([broken]).candidates[0]!.rating.flag, 'unknown');
  const markdown = formatStageJobs(matchStageJobs(snapshot, stageTables, stageRequest, jobs));
  assert.match(markdown, /作业 32：ready[\s\S]*评分：赞 60 \/ 踩 40（好评率 60%，所需 85%）；好评率低，排在后面/);
  assert.match(markdown, /作业 31：ready[\s\S]*评分：赞 3 \/ 踩 0；作业站标记评分不足/);
  assert.match(markdown, /作业 34：ready[\s\S]*评分：未知/);
});

test('online collection reads rating counts from the query summary, not the cached detail view', async () => {
  const fetcher: typeof fetch = async url => String(url).includes('/query?')
    ? Response.json({ status_code: 200, data: { has_next: false, data: [{ id: 51, like: 95, dislike: 5, not_enough_rating: false, rating_level: 10, rating_ratio: 1.0 }, { id: 52 }] } })
    : Response.json({ status_code: 200, data: { id: Number(String(url).split('/').at(-1)), like: 0, dislike: 0, not_enough_rating: true, content: JSON.stringify(stageJob(51).content) } });
  const { collectStageJobs } = await import('../skills/maa-core/scripts/stage-jobs.ts');
  const report = await collectStageJobs(snapshot, stageTables, stageRequest, fetcher);
  const [withRating, withoutRating] = report.stages[0]!.candidates;
  assert.equal(withRating!.rating.flag, 'ok'); assert.equal(withRating!.rating.votes, 100);
  assert.match(withRating!.rating.source!.url, /\/copilot\/query\?/); assert.match(withRating!.rating.source!.sha256!, /^[a-f0-9]{64}$/);
  assert.equal(withoutRating!.rating.flag, 'unknown');
  assert.equal(report.jobs[0]!.rating!.like, 95);
});

const pagedFetcher = (pages: { stageName: string; ids: number[] }[], hasNext: (page: number) => boolean): typeof fetch => async url => {
  const parsed = new URL(String(url));
  if (parsed.pathname.endsWith('/query')) {
    const page = Number(parsed.searchParams.get('page')), current = pages[page - 1] ?? { ids: [] };
    return Response.json({ status_code: 200, data: { has_next: hasNext(page), data: current.ids.map(id => ({ id })) } });
  }
  const id = Number(parsed.pathname.split('/').at(-1)), stageName = pages.find(item => item.ids.includes(id))!.stageName;
  return Response.json({ status_code: 200, data: { id, content: JSON.stringify({ ...stageJob(id).content, stage_name: stageName }) } });
};

test('search results distinguish no jobs, unrelated fallback results and insufficient coverage', async () => {
  const { collectStageJobs } = await import('../skills/maa-core/scripts/stage-jobs.ts');
  const run = (pages: { stageName: string; ids: number[] }[], hasNext: (page: number) => boolean) => collectStageJobs(snapshot, stageTables, stageRequest, pagedFetcher(pages, hasNext));
  const unrelated = await run([1, 2, 3].map(page => ({ stageName: 'unrelated_stage_9', ids: [page * 10, page * 10 + 1] })), () => true);
  assert.deepEqual(unrelated.stages[0]!.searchResult, { outcome: 'fallback-suspected', returned: 6, belonging: 0 });
  assert.deepEqual(unrelated.search[0]!.ids, [10, 11, 20, 21, 30, 31]);
  const fallbackText = formatStageJobs(unrelated);
  assert.match(fallbackText, /检索结果：返回的 6 份作业都不属于这一关，查询疑似退回到了关键字搜索，结果与这一关无关；覆盖不足，不能据此判断这一关没有作业。/);
  assert.equal(unrelated.stages[0]!.primary, null);
  const empty = await run([], () => false);
  assert.deepEqual(empty.stages[0]!.searchResult, { outcome: 'empty', returned: 0, belonging: 0 });
  assert.match(formatStageJobs(empty), /检索结果：接口没有返回作业，本次检索条件下这一关没有作业。/);
  const near = await run([{ stageName: 'synthetic_010', ids: [61] }], () => false);
  assert.equal(near.stages[0]!.searchResult.outcome, 'other-stages');
  assert.match(formatStageJobs(near), /检索结果：返回的 1 份作业都属于名称相近的其他关卡；本次检索条件下这一关没有作业。/);
  const nearTruncated = await run([1, 2, 3].map(page => ({ stageName: 'synthetic_010', ids: [70 + page] })), () => true);
  assert.equal(nearTruncated.stages[0]!.searchResult.outcome, 'insufficient');
  assert.match(formatStageJobs(nearTruncated), /检索结果：读完 3 页共 3 份，没有一份属于这一关；覆盖不足，不能据此判断这一关没有作业。/);
  const found = await run([{ stageName: 'synthetic_01', ids: [81] }, { stageName: 'unrelated_stage_9', ids: [82] }], page => page < 2);
  assert.deepEqual(found.stages[0]!.searchResult, { outcome: 'found', returned: 2, belonging: 1 });
  assert.match(formatStageJobs(found), /检索结果：返回 2 份，其中 1 份属于这一关。/);
  // Offline inputs make no search claim; coverage ids must name supplied jobs and fit the page bound.
  assert.equal(first([stageJob(1)]).searchResult.outcome, 'offline');
  const jobs = [stageJob(1)];
  for (const ids of [[2], [1, 1], Array.from({ length: 21 }, (_, index) => index + 1)]) {
    assert.throws(() => matchStageJobs(snapshot, stageTables, stageRequest, jobs, [{ stageId: 'synthetic_01', mode: 'online', pages: 1, truncated: false, ids }]), /search-coverage-invalid/);
  }
  assert.throws(() => matchStageJobs(snapshot, stageTables, stageRequest, jobs, [{ stageId: 'synthetic_01', mode: 'offline', pages: 0, truncated: false, ids: [1] }]), /search-coverage-invalid/);
});
