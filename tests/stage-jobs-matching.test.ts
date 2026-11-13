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

const characters = {
  char_synthetic_a: { name: '合成甲', profession: 'CASTER' }, char_synthetic_c: { name: '合成丙', profession: 'SNIPER' },
  trap_synthetic_device: { name: '合成装置', profession: 'TRAP' }, token_synthetic_summon: { name: '合成召唤物', profession: 'TOKEN' },
  char_synthetic_twin: { name: '合成双名', profession: 'MEDIC' }, trap_synthetic_twin: { name: '合成双名', profession: 'TRAP' },
  char_unrelated: { name: '无关干员', profession: 'MEDIC' },
};
const catalogTables = { ...stageTables, characters };
const acting = (id: number, actions: unknown[], extra: Record<string, unknown> = {}) => withOpers(id, [{ name: '合成甲', requirements: { elite: 2, level: 40 } }], { actions, ...extra });

test('operators referenced by actions but not declared in opers or groups keep the job 待核', () => {
  const deployed = [{ type: 'Deploy', name: '合成甲', location: [1, 1], direction: 'Left' }];
  const undeclared = first([acting(61, [...deployed, { type: 'Deploy', name: '合成丙', location: [2, 1], direction: 'Left' }])], catalogTables).candidates[0]!;
  assert.equal(undeclared.status, 'unknown'); assert.ok(undeclared.reasons.includes('action-operator-undeclared'));
  assert.deepEqual(undeclared.actionNames, { undeclared: ['合成丙'], unrecognized: [] });
  // Group names, group members, summons and devices (TOKEN/TRAP in the pinned character table) are not undeclared operators.
  const grouped = withOpers(62, [], { groups: [{ name: '合成组', opers: [{ name: '合成甲', requirements: { elite: 2 } }] }],
    actions: [{ type: 'Deploy', name: '合成组', location: [1, 1], direction: 'Left' }, { type: 'Skill', name: '合成甲' }, { type: '部署', name: '合成装置', location: [3, 3], direction: 'None' }, { type: 'Retreat', name: '合成召唤物' }] });
  const groupedCandidate = first([grouped], catalogTables).candidates[0]!;
  assert.equal(groupedCandidate.status, 'ready'); assert.deepEqual(groupedCandidate.actionNames, { undeclared: [], unrecognized: [] });
  // A name that is both an operator and a device is treated as an operator.
  assert.deepEqual(first([acting(63, [...deployed, { type: 'Skill', name: '合成双名' }])], catalogTables).candidates[0]!.actionNames.undeclared, ['合成双名']);
  // Names the catalog does not know stay 待核 unless the job registers them as a unit with SetUnitLocation.
  const unknownUnit = first([acting(64, [...deployed, { type: 'Skill', name: '神秘单位' }])], catalogTables).candidates[0]!;
  assert.equal(unknownUnit.status, 'unknown'); assert.deepEqual(unknownUnit.actionNames.unrecognized, ['神秘单位']); assert.ok(unknownUnit.reasons.includes('action-name-unrecognized'));
  const registered = acting(65, [...deployed, { type: 'SetUnitLocation', name: '神秘单位', location: [4, 4] }, { type: 'SkillUsage', name: '神秘单位', skill_usage: 1 }]);
  assert.equal(first([registered], catalogTables).candidates[0]!.status, 'ready');
  // Without a character catalog the same operator name cannot be classified and stays 待核.
  const offline = first([acting(66, [{ type: 'Deploy', name: '合成丙', location: [2, 1], direction: 'Left' }])]).candidates[0]!;
  assert.equal(offline.status, 'unknown'); assert.deepEqual(offline.actionNames.unrecognized, ['合成丙']);
  // The report keeps only the catalog entries it used, so preparation can re-verify the same classification.
  const report = matchStageJobs(snapshot, catalogTables, stageRequest, [acting(61, [...deployed, { type: 'Deploy', name: '合成丙', location: [2, 1], direction: 'Left' }, { type: 'Skill', name: '合成召唤物' }])]);
  assert.deepEqual(Object.keys(report.tables.characters).sort(), ['char_synthetic_c', 'token_synthetic_summon']);
  assert.equal(matchStageJobs(report.snapshot, report.tables, report.request, report.jobs, report.search).hash, report.hash);
  assert.match(formatStageJobs(report), /动作引用了未声明的干员：合成丙（待核）/);
  assert.match(formatStageJobs(matchStageJobs(snapshot, catalogTables, stageRequest, [acting(64, [{ type: 'Skill', name: '神秘单位' }])])), /动作引用了无法识别的名字：神秘单位（待核）/);
});

test('online table loading reads the pinned character table for queries and degrades to unclassified names when it is unavailable', async () => {
  const { loadStageTables, characterTableSource } = await import('../skills/maa-core/scripts/stage-jobs.ts');
  const urls: string[] = [];
  const serve = (failCharacters: boolean): typeof fetch => async url => {
    urls.push(String(url));
    if (String(url).endsWith('character_table.json')) return failCharacters ? new Response('no', { status: 503 }) : Response.json(characters);
    return Response.json(stageTables);
  };
  const loaded = await loadStageTables(undefined, true, serve(false)) as Record<string, any>;
  assert.equal(loaded.characters.char_synthetic_c.name, '合成丙'); assert.equal(loaded.charactersSource.file, characterTableSource.file);
  assert.ok(urls.some(url => url.includes('6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/character_table.json')));
  const degraded = await loadStageTables(undefined, true, serve(true)) as Record<string, any>;
  assert.equal(degraded.characters, undefined); assert.deepEqual(degraded.charactersSource, { kind: 'unavailable' });
  urls.length = 0; await loadStageTables(undefined, false, serve(false));
  assert.ok(urls.every(url => !url.endsWith('character_table.json')));
  const report = matchStageJobs(snapshot, degraded, stageRequest, [acting(66, [{ type: 'Deploy', name: '合成丙', location: [2, 1], direction: 'Left' }])]);
  assert.deepEqual(report.stages[0]!.candidates[0]!.actionNames.unrecognized, ['合成丙']);
  assert.match(formatStageJobs(report), /干员名表来源：\{"kind":"unavailable"\}/);
});

const borrowed = { name: '合成丁', skill: 2, requirements: { elite: 2, level: 60 } };
const owned = { name: '合成甲', requirements: { elite: 2, level: 40 } };

test('a job missing exactly one operator the account does not own is listed separately as 需借助战', () => {
  const stage = first([withOpers(71, [owned, borrowed]), stageJob(72)]);
  const candidate = stage.candidates[0]!;
  assert.equal(candidate.status, 'support');
  assert.deepEqual(candidate.support, { slot: 'operator-1', members: [{ name: '合成丁', skill: 2, required: { elite: 2, level: 60 }, effectiveRequired: { elite: 2, level: 60 } }] });
  assert.deepEqual(candidate.assignment, { 'operator-0': '合成甲' });
  assert.deepEqual(candidate.execution!.content.opers, [owned, borrowed]);
  assert.equal(stage.primary, 72); assert.deepEqual(stage.alternates, []); assert.deepEqual(stage.supportCandidates, [71]);
  // A group slot whose members are all unowned keeps every member so MAA can borrow any of them.
  const group = { name: '借位', opers: [borrowed, { name: '合成戊', requirements: { elite: 1, level: 1 } }] };
  const grouped = first([withOpers(73, [owned], { groups: [group] })]).candidates[0]!;
  assert.equal(grouped.status, 'support'); assert.equal(grouped.support!.slot, '借位');
  assert.deepEqual(grouped.execution!.content.groups, [group]);
  // Borrowing never relaxes other slots, and only an unowned slot can be borrowed.
  assert.equal(first([withOpers(74, [owned, borrowed, { name: '合成己' }])]).candidates[0]!.status, 'unknown');
  assert.equal(first([withOpers(75, [{ name: '合成乙', requirements: { elite: 2 } }, borrowed])]).candidates[0]!.status, 'blocked');
  assert.equal(first([withOpers(76, [{ name: '合成甲' }, borrowed])]).candidates[0]!.status, 'unknown');
  assert.equal(first([withOpers(77, [owned], { groups: [{ name: '借位', opers: [{ name: '合成乙', requirements: { elite: 2 } }, borrowed] }] })]).candidates[0]!.status, 'unknown');
  // The borrowed slot must state readable requirements, otherwise there is nothing to tell the user to borrow.
  assert.equal(first([withOpers(80, [owned, { name: '合成丁' }])]).candidates[0]!.status, 'unknown');
  assert.equal(first([withOpers(81, [owned, { name: '合成丁', requirements: { elite: 'two' } }])]).candidates[0]!.status, 'unknown');
  const documented = withOpers(78, [owned, borrowed], { doc: { title: '合成作业', details: '需要额外条件' } });
  assert.equal(first([documented]).candidates[0]!.status, 'unknown');
  // Without a usable ownership list nobody is known to be missing.
  const empty = JSON.parse(JSON.stringify(snapshot)); empty.operators = []; empty.coverage.operators = { status: 'partial', issues: ['empty-recognition'] };
  assert.equal(matchStageJobs(empty, stageTables, stageRequest, [withOpers(79, [borrowed])]).stages[0]!.candidates[0]!.status, 'unknown');
  const markdown = formatStageJobs(matchStageJobs(snapshot, stageTables, stageRequest, [withOpers(71, [owned, borrowed])]));
  assert.match(markdown, /需借助战候选（不进默认建议，批准时须点名）：71/);
  assert.match(markdown, /作业 71：support（需借助战）/);
  assert.match(markdown, /需借助战：缺 operator-1，可借 合成丁（S2，要求 \{"elite":2,"level":60\}）；MAA 只按干员名和技能从助战列表挑选，不核对作业写的精英化和等级，助战练度需要自己确认；开始前在自动战斗页勾选「借助战」并选「补漏」/);
});

test('a 需借助战 job is prepared only when the approval names it; the plan records the borrowed slot', async t => {
  const { prepareStageJobs } = await import('../skills/maa-core/scripts/stage-jobs.ts');
  const { inspectConfiguration } = await import('../skills/maa-core/scripts/maa-config.ts');
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'maa-stage-support-')); t.after(() => rm(root, { recursive: true, force: true }));
  const maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private'); await mkdir(join(maaDirectory, 'config'), { recursive: true });
  const configFile = join(maaDirectory, 'config/gui.new.json');
  const config = { Current: 'Synthetic', Configurations: { Synthetic: { TaskQueue: [], Copilot: { TaskList: [], LoopTimes: 7, EnableUserAdditional: true, SupportMode: 3 } } }, Timers: { List: [] } };
  await writeFile(configFile, JSON.stringify(config));
  const report = matchStageJobs(snapshot, stageTables, stageRequest, [withOpers(71, [owned, borrowed]), stageJob(72)]);
  let running = false; const actions: string[] = [];
  const maa = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; actions.push('close'); }, start: async () => { running = true; actions.push('reopen'); } };
  const approval = { reportHash: report.hash, reference: '合成用户点名批准作业 71 借助战补 合成丁，三次仅准备', map: 'synthetic_map', selections: [{ stageId: 'synthetic_01', primary: 71, alternates: [72], loops: 3 }] };
  const input = { report, approval, snapshot, maaDirectory, privateDirectory, profile: 0, host: 'claude' as const, closedConfirmed: true, expectedRevision: (await inspectConfiguration(maaDirectory)).revision };
  await assert.rejects(() => prepareStageJobs(input, maa), /approval-requires-ready-candidate/);
  await assert.rejects(() => prepareStageJobs({ ...input, approval: { ...approval, selections: [{ ...approval.selections[0]!, supportJobs: [71, 72] }] } }, maa), /approval-mismatch/);
  await assert.rejects(() => prepareStageJobs({ ...input, approval: { ...approval, selections: [{ ...approval.selections[0]!, supportJobs: [99] }] } }, maa), /approval-mismatch/);
  assert.deepEqual(actions, []); assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), config);
  const named = { ...approval, selections: [{ ...approval.selections[0]!, supportJobs: [71] }] };
  const result = await prepareStageJobs({ ...input, approval: named }, maa);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  const copilot = JSON.parse(await readFile(configFile, 'utf8')).Configurations.Synthetic.Copilot;
  assert.deepEqual(copilot.TaskList.map((item: Record<string, unknown>) => item.CopilotId), [71, 71, 71]);
  // Borrowing is a GUI runtime switch; the persisted support mode and loop count are left as they were.
  assert.equal(copilot.SupportMode, 3); assert.equal(copilot.LoopTimes, 7); assert.equal(copilot.EnableUserAdditional, false);
  assert.deepEqual(JSON.parse(await readFile(copilot.TaskList[0].FilePath, 'utf8')).opers, [owned, borrowed]);
  const pending = JSON.parse((await readFile(join(privateDirectory, 'daily-pending.jsonl'), 'utf8')).trim());
  assert.deepEqual(pending.authorization.jobPlan.entries[0].primary.support, { slot: 'operator-1', members: ['合成丁'] });
  assert.equal(pending.authorization.jobPlan.entries[0].alternates[0].support, undefined);
});

test('reports in the earlier match structure no longer verify, so their approvals do not carry over', async () => {
  const { prepareStageJobs } = await import('../skills/maa-core/scripts/stage-jobs.ts');
  const report = matchStageJobs(snapshot, stageTables, stageRequest, [stageJob(1)]);
  const { hash, ...displayed } = structuredClone(report) as Record<string, any>; void hash;
  for (const stage of displayed.stages) { delete stage.supportCandidates; delete stage.searchResult; for (const candidate of stage.candidates) { delete candidate.rating; delete candidate.actionNames; delete candidate.support; } }
  for (const item of displayed.search) delete item.ids;
  const { createHash } = await import('node:crypto');
  const older = { ...displayed, hash: createHash('sha256').update(JSON.stringify(displayed)).digest('hex') } as typeof report;
  const approval = { reportHash: older.hash, reference: '旧报告上的批准', map: 'synthetic_map', selections: [{ stageId: 'synthetic_01', primary: 1, alternates: [], loops: 3 }] };
  const maa = { inspect: async () => { throw new Error('must-not-inspect'); }, close: async () => {}, start: async () => {} };
  await assert.rejects(() => prepareStageJobs({ report: older, approval, snapshot, maaDirectory: 'unused', privateDirectory: 'unused', profile: 0, host: 'codex', expectedRevision: 'unused' }, maa), /approval-mismatch/);
  assert.notEqual(older.hash, report.hash);
});

test('the six-star #s stage spelling is listed but not matched: the pinned copilot protocol has no difficulty bit for it', async () => {
  const { findStages } = await import('../skills/maa-core/scripts/stage-jobs.ts');
  const tables = { stages: { ...stageTables.stages,
    synthetic_02: { stageId: 'synthetic_02', code: 'SYN-2', levelId: 'Obt/Synthetic/level_synthetic_02', zoneId: 'synthetic_map', difficulty: 'NORMAL', unlockCondition: [] },
    'synthetic_02#s': { stageId: 'synthetic_02#s', code: 'SYN-2', levelId: 'Obt/Synthetic/level_synthetic_02', zoneId: 'synthetic_map', difficulty: 'SIX_STAR', unlockCondition: [] } } };
  assert.deepEqual(findStages(tables, ['SYN-2']).map(stage => [stage.stageId, stage.difficulty, stage.tableDifficulty]), [['synthetic_02', 'normal', 'NORMAL'], ['synthetic_02#s', 'unsupported', 'SIX_STAR']]);
  const request = (stageId: string, difficulty: 'normal' | 'raid') => ({ ...stageRequest, stages: [{ stageId, code: 'SYN-2', difficulty, loops: 1 }] });
  for (const difficulty of ['normal', 'raid'] as const) assert.throws(() => matchStageJobs(snapshot, tables, request('synthetic_02#s', difficulty), []), /stage-identity-mismatch/);
  const sixStarJob = { ...stageJob(91), content: { ...stageJob(91).content, stage_name: 'synthetic_02#s' } };
  const normalJob = { ...stageJob(92), content: { ...stageJob(92).content, stage_name: 'synthetic_02' } };
  const stage = matchStageJobs(snapshot, tables, request('synthetic_02', 'normal'), [sixStarJob, normalJob]).stages[0]!;
  assert.deepEqual(stage.candidates.map(candidate => [candidate.id, candidate.status]), [[91, 'blocked'], [92, 'ready']]);
  assert.ok(stage.candidates[0]!.reasons.includes('map-mismatch'));
});
