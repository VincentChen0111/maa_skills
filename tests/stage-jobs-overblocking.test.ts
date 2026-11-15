import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchStageJobs, collectStageJobs, formatStageJobs, withInstalledMaaVersion, type Job, type StageRequest } from '../skills/maa-core/scripts/stage-jobs.ts';
import { CheckRequiredError } from '../skills/maa-core/scripts/check-required.ts';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { stageTables, stageRequest, stageSnapshot, stageSklandSnapshot, stageModules, stageJob, masteryJob } from './fixtures/stage-data.ts';

// Over-blocking review, accepted by the dispatcher on 2026-11-16 as a follow-on package for this branch. Trial evidence:
// one malformed job (110140) hid all 14 TL-S-4 candidates (OB-1); every TL-S candidate stayed unknown on prerequisites with
// no reason and no question (OB-2); `maaVersion: ''` left minimum_required jobs unknown although the same call reads the
// installed version (OB-3); the owner's 「我核实了，都是满足的。直接开始。」 could not be used (one confirmation per job).

const snapshot = stageSnapshot();
const withContent = (id: number, content: Record<string, unknown>, difficulty = 1): Job => ({ ...stageJob(id, difficulty), content: { ...stageJob(id, difficulty).content, ...content } });
const said = '我核实了，都是满足的。直接开始。';
const script = fileURLToPath(new URL('../skills/maa-core/scripts/stage-jobs.ts', import.meta.url));

test('OB-1: a malformed job is one blocked candidate with job-content-invalid:<code>; the rest of the stage and the batch are matched', () => {
  const request: StageRequest = { ...stageRequest, stages: [stageRequest.stages[0]!, { stageId: 'synthetic_01#f#', code: 'SYN-1', difficulty: 'raid', loops: 1 }],
    completions: { synthetic_00: 'PASS', synthetic_01: 'COMPLETE' } };
  // A single operator's group name is its own name, so 合成甲 twice is the trial's duplicate-group failure.
  const duplicate = withContent(61, { opers: [{ name: '合成甲', requirements: { elite: 2 } }], groups: [{ name: '合成甲', opers: [{ name: '合成乙', requirements: { elite: 1 } }] }] }, 3);
  const notObject = withContent(62, { opers: [42] }, 3);
  const unreadable = { ...stageJob(63, 3), content: 'not a job' } as unknown as Job;
  const report = matchStageJobs(snapshot, stageTables, request, [duplicate, notObject, unreadable, stageJob(64, 3)]);
  assert.equal(report.stages.length, 2);
  for (const stage of report.stages) {
    const by = (id: number) => stage.candidates.find(candidate => candidate.id === id)!;
    assert.equal(by(61).status, 'blocked'); assert.ok(by(61).reasons.includes('job-content-invalid:job-group-name-duplicate'), JSON.stringify(by(61).reasons));
    assert.equal(by(62).status, 'blocked'); assert.ok(by(62).reasons.includes('job-content-invalid:object-required'), JSON.stringify(by(62).reasons));
    assert.equal(by(63).status, 'blocked'); assert.ok(by(63).reasons.includes('job-content-invalid:content-not-object'), JSON.stringify(by(63).reasons));
    for (const id of [61, 62, 63]) assert.equal(by(id).execution, null);
    assert.equal(by(64).status, 'ready'); assert.equal(stage.primary, 64);
  }
  // Preparation re-runs the matcher on the saved report and must reach the same result.
  assert.equal(matchStageJobs(report.snapshot, report.tables, report.request, report.jobs, report.search).hash, report.hash);
  assert.match(formatStageJobs(report), /作业内容不合法（job-group-name-duplicate）/);
});

test('OB-1 online: a job whose content is not JSON stays a blocked candidate instead of failing the whole query', async () => {
  const fetcher: typeof fetch = async url => String(url).includes('/query?')
    ? Response.json({ status_code: 200, data: { has_next: false, data: [{ id: 71 }, { id: 72 }] } })
    : Response.json({ status_code: 200, data: { id: Number(String(url).split('/').at(-1)), content: String(url).endsWith('/71') ? '{"stage_name": ' : JSON.stringify(stageJob(72).content) } });
  const report = await collectStageJobs(snapshot, stageTables, stageRequest, fetcher);
  const [broken, fine] = report.stages[0]!.candidates;
  assert.equal(broken!.status, 'blocked'); assert.ok(broken!.reasons.includes('job-content-invalid:content-not-object'), JSON.stringify(broken!.reasons));
  assert.equal(fine!.status, 'ready'); assert.equal(report.stages[0]!.primary, 72);
  assert.equal(report.stages[0]!.searchResult.outcome, 'found');
});

test('OB-2: an unverified or unmet prerequisite is named on every candidate, with its stage code; the user\'s one answer settles it', () => {
  const tables = { stages: { ...stageTables.stages, synthetic_00: { stageId: 'synthetic_00', code: 'SYN-0', levelId: 'Obt/Synthetic/level_synthetic_00', zoneId: 'synthetic_map', difficulty: 'NORMAL', unlockCondition: [] } } };
  const { completions: _completions, completionEvidence: _evidence, ...bare } = stageRequest;
  const unasked = matchStageJobs(snapshot, tables, bare, [stageJob(81)]);
  const stage = unasked.stages[0]!;
  assert.equal(stage.candidates[0]!.status, 'unknown');
  assert.deepEqual(stage.candidates[0]!.reasons, ['prerequisite-unverified:synthetic_00:PASS']);
  assert.deepEqual(stage.prerequisites[0], { stageId: 'synthetic_00', code: 'SYN-0', required: 'PASS', actual: null, status: 'unknown' });
  assert.match(formatStageJobs(unasked), /前置 SYN-0（synthetic_00）要求 PASS：unknown/);
  assert.match(formatStageJobs(unasked), /prerequisite-unverified：/);
  // The saved report carries the prerequisite's table entry, so preparation re-verifies identically.
  assert.ok(Object.hasOwn(unasked.tables.stages, 'synthetic_00'));
  assert.equal(matchStageJobs(unasked.snapshot, unasked.tables, unasked.request, unasked.jobs, unasked.search).hash, unasked.hash);
  // Completions without the user's own words do not count; with them the gate opens.
  const noWords = matchStageJobs(snapshot, tables, { ...bare, completions: { synthetic_00: 'PASS' } }, [stageJob(81)]).stages[0]!;
  assert.deepEqual(noWords.candidates[0]!.reasons, ['prerequisite-unverified:synthetic_00:PASS']);
  const answered = matchStageJobs(snapshot, tables, { ...bare, completions: { synthetic_00: 'PASS' }, completionEvidence: '用户：SYN-0 打过了' }, [stageJob(81)]).stages[0]!;
  assert.equal(answered.candidates[0]!.status, 'ready'); assert.deepEqual(answered.candidates[0]!.reasons, []);
  // The raid needs its normal stage three-starred: a plain pass keeps it guarded, now with a reason.
  const raid = matchStageJobs(snapshot, tables, { ...bare, stages: [{ stageId: 'synthetic_01#f#', code: 'SYN-1', difficulty: 'raid', loops: 1 }],
    completions: { synthetic_01: 'PASS' }, completionEvidence: '用户：SYN-1 打过但没三星' }, [stageJob(82, 3)]).stages[0]!;
  assert.equal(raid.candidates[0]!.status, 'blocked'); assert.deepEqual(raid.candidates[0]!.reasons, ['prerequisite-unmet:synthetic_01:COMPLETE']);
});

test('OB-3: a request without an MAA version uses the installed version stamp, and the report records where the version came from', () => {
  const job = stageJob(91); // minimum_required v6.0.0
  for (const missing of [undefined, '', '  ']) {
    const filled = withInstalledMaaVersion({ ...stageRequest, maaVersion: missing as unknown as string }, '6.22.0');
    assert.equal(filled.request.maaVersion, '6.22.0'); assert.equal(filled.maaVersionSource, 'installed');
    const report = matchStageJobs(snapshot, stageTables, filled.request, [job], undefined, { maaVersionSource: filled.maaVersionSource });
    assert.equal(report.stages[0]!.candidates[0]!.status, 'ready'); assert.equal(report.maaVersionSource, 'installed');
    assert.match(formatStageJobs(report), /MAA 版本：6\.22\.0（读自已安装的 MAA）/);
    assert.equal(matchStageJobs(report.snapshot, report.tables, report.request, report.jobs, report.search, { maaVersionSource: report.maaVersionSource }).hash, report.hash);
  }
  const given = withInstalledMaaVersion(stageRequest, '6.22.0');
  assert.equal(given.request.maaVersion, 'v6.21.4'); assert.equal(given.maaVersionSource, 'request');
  const unread = withInstalledMaaVersion({ ...stageRequest, maaVersion: '' }, null);
  assert.equal(unread.maaVersionSource, 'unavailable');
  const report = matchStageJobs(snapshot, stageTables, unread.request, [job], undefined, { maaVersionSource: unread.maaVersionSource });
  assert.equal(report.stages[0]!.candidates[0]!.status, 'unknown'); assert.ok(report.stages[0]!.candidates[0]!.reasons.includes('version-unverified'));
  assert.match(formatStageJobs(report), /MAA 版本：未知/);
});

test('one user confirmation per job covers its row-level unknowns and makes the job ready', () => {
  const tables = { ...stageTables, characters: { char_synthetic_c: { name: '合成丙', profession: 'CASTER' } } };
  const job = withContent(101, {
    opers: [{ name: '合成甲', skill: 2, role: '先锋', requirements: { elite: 2, skill_level: 10, extra: 1 } }],
    groups: [{ name: '支援', opers: [{ name: '合成乙' }] }],
    actions: [{ type: 'Deploy', name: '合成丙' }, { type: 'Deploy', name: '神秘装置' }], doc: { title: '合成作业', details: '开局先放合成甲' } });
  const plain = matchStageJobs(snapshot, tables, stageRequest, [job]).stages[0]!.candidates[0]!;
  assert.equal(plain.status, 'unknown');
  const everywhere = [...plain.reasons, ...plain.requirements.flatMap(row => row.reasons)];
  for (const reason of ['unknown-mastery', 'role-unverified', 'unknown-requirement:extra', 'requirements-unstated', 'action-operator-undeclared', 'action-name-unrecognized', 'document-conditions-unverified'])
    assert.ok(everywhere.includes(reason), `${reason} in ${JSON.stringify(everywhere)}`);
  const request: StageRequest = { ...stageRequest, jobConfirmations: [{ jobId: 101, contentHash: plain.hash, source: 'user-confirmed', reference: said }] };
  const confirmed = matchStageJobs(snapshot, tables, request, [job]);
  const candidate = confirmed.stages[0]!.candidates[0]!;
  assert.equal(candidate.status, 'ready', JSON.stringify(candidate.reasons)); assert.notEqual(candidate.execution, null); assert.equal(confirmed.stages[0]!.primary, 101);
  assert.deepEqual(candidate.confirmation, { reference: said });
  assert.ok(candidate.requirements.every(row => row.status === 'ready' && row.confirmed === true));
  assert.equal(matchStageJobs(confirmed.snapshot, confirmed.tables, confirmed.request, confirmed.jobs, confirmed.search).hash, confirmed.hash);
  assert.match(formatStageJobs(confirmed), /用户确认（整份作业一次）：我核实了，都是满足的。直接开始。/);
});

test('a job confirmation never overrides what is known insufficient, invalid, conflicting, unowned, or outside the operator rows', () => {
  const confirm = (job: Job, extra: Partial<StageRequest> = {}, account: unknown = snapshot) => {
    const base = { ...stageRequest, ...extra };
    const hash = matchStageJobs(account, { ...stageTables, modules: stageModules }, base, [job]).stages[0]!.candidates[0]!.hash;
    return matchStageJobs(account, { ...stageTables, modules: stageModules }, { ...base, jobConfirmations: [{ jobId: job.id, contentHash: hash, source: 'user-confirmed', reference: said }] }, [job]).stages[0]!.candidates[0]!;
  };
  assert.equal(confirm(withContent(111, { opers: [{ name: '合成甲', requirements: { elite: 2, level: 80 } }] })).status, 'blocked', 'known insufficient level');
  assert.equal(confirm(withContent(112, { opers: [{ name: '合成甲', requirements: { elite: 'two' } }] })).status, 'unknown', 'invalid requirement');
  assert.notEqual(confirm(withContent(113, { opers: [{ name: '合成甲', requirements: { elite: 2 } }, { name: '合成丁', requirements: { elite: 1 } }] })).status, 'ready', 'operator provably not owned');
  assert.equal(confirm(stageJob(114), { maaVersion: '' }).status, 'unknown', 'version unverified');
  assert.equal(confirm(stageJob(115), { completions: undefined }).status, 'unknown', 'prerequisite unverified');
  assert.equal(confirm(withContent(116, { groups: [{ name: '空组', opers: [] }] })).status, 'unknown', 'empty group');
  assert.notEqual(confirm(withContent(117, { stage_name: 'synthetic_99' })).status, 'ready', 'stage not resolved');
  // A user fact that contradicts a known Skland value stays a conflict.
  const conflict = confirm(masteryJob(118), { operatorFacts: [{ name: '合成甲', source: 'user-confirmed', reference: '用户：二技能专一', mastery: { 2: 1 } }] }, stageSklandSnapshot());
  assert.equal(conflict.status, 'unknown'); assert.ok(conflict.requirements[0]!.reasons.includes('operator-fact-conflict:mastery'));
  // A confirmation for other content does not apply, and says so.
  const changed = matchStageJobs(snapshot, stageTables, { ...stageRequest, jobConfirmations: [{ jobId: 119, contentHash: 'a'.repeat(64), source: 'user-confirmed', reference: said }] },
    [withContent(119, { opers: [{ name: '合成甲' }] })]).stages[0]!.candidates[0]!;
  assert.equal(changed.status, 'unknown'); assert.ok(changed.reasons.includes('job-confirmation-content-changed')); assert.equal(changed.confirmation, null);
});

test('malformed job confirmations refuse the request with their own reason', () => {
  const entry = { jobId: 121, contentHash: 'b'.repeat(64), source: 'user-confirmed' as const, reference: said };
  for (const jobConfirmations of [[entry, entry], [{ ...entry, reference: '' }], [{ ...entry, source: 'assumed' }], [{ ...entry, extra: true }], [{ ...entry, jobId: 0 }], [{ ...entry, contentHash: 'xyz' }], 'all'])
    assert.throws(() => matchStageJobs(snapshot, stageTables, { ...stageRequest, jobConfirmations } as unknown as StageRequest, [stageJob(121)]),
      (error: unknown) => error instanceof CheckRequiredError && error.reason === 'stage-jobs-job-confirmations-invalid', JSON.stringify(jobConfirmations));
});

test('OB-9 and OB-3 through the CLI: without snapshotFile the query reads the Skland snapshot whole when it covers skills, and records the version source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maa-stage-select-')); t.after(() => rm(root, { recursive: true, force: true }));
  const privateDirectory = join(root, 'private'), maaDirectory = join(root, 'maa'); await mkdir(privateDirectory); await mkdir(maaDirectory);
  await updateSettings({ language: 'zh-CN', privateDirectory, maaDirectory }, root);
  await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(stageSnapshot()));
  const tablesFile = join(root, 'tables.json'), jobsFile = join(root, 'jobs.json');
  await writeFile(tablesFile, JSON.stringify({ ...stageTables, modules: stageModules })); await writeFile(jobsFile, JSON.stringify([masteryJob(131)]));
  const { maaVersion: _version, ...request } = stageRequest;
  const run = (format?: 'markdown') => spawnSync(process.execPath, [script, 'query'], { input: JSON.stringify({ request, tablesFile, jobsFile, ...(format ? { format } : {}) }),
    encoding: 'utf8', env: { ...process.env, MAA_SKILLS_HOME: root } });
  // Only the MAA snapshot: it is read, and the missing skills stay visible.
  const alone = run(); assert.equal(alone.status, 0, alone.stdout + alone.stderr);
  const maaReport = JSON.parse(alone.stdout).report;
  assert.deepEqual(maaReport.snapshotSelection, { source: 'maa', readAt: '2026-11-11T00:00:00.000Z', chosen: 'maa-default', lacking: ['skills'] });
  assert.ok(maaReport.stages[0].candidates[0].requirements[0].reasons.includes('unknown-mastery'));
  // No MAA.exe in this temporary directory: the version cannot be read, so it is recorded as unavailable, not guessed.
  assert.equal(maaReport.maaVersionSource, 'unavailable'); assert.equal(maaReport.versions.maaVersion, null);
  await writeFile(join(privateDirectory, 'account-snapshot-skland.json'), JSON.stringify(stageSklandSnapshot()));
  const both = run(); assert.equal(both.status, 0, both.stdout + both.stderr);
  const report = JSON.parse(both.stdout).report;
  assert.equal(report.snapshotSource, 'skland');
  assert.deepEqual(report.snapshotSelection, { source: 'skland', readAt: '2026-11-16T00:00:00.000Z', chosen: 'skland-covers', lacking: ['skills'] });
  assert.deepEqual(report.stages[0].candidates[0].requirements[0].reasons, []);
  const markdown = run('markdown'); assert.equal(markdown.status, 0, markdown.stdout + markdown.stderr);
  assert.match(markdown.stdout, /整份改读森空岛快照，两份不合并/); assert.match(markdown.stdout, /不是游戏内的数据时间/);
});

test('review round 1 (F2): with prerequisites still open, confirmable says whether their answer plus one job confirmation makes the job ready', () => {
  const tables = { stages: { ...stageTables.stages, synthetic_00: { stageId: 'synthetic_00', code: 'SYN-0', levelId: 'Obt/Synthetic/level_synthetic_00', zoneId: 'synthetic_map', difficulty: 'NORMAL', unlockCondition: [] } } };
  const { completions: _completions, completionEvidence: _evidence, ...bare } = stageRequest;
  const job = withContent(141, { opers: [{ name: '合成甲' }], doc: { title: '合成作业', details: '开局先放合成甲' } });
  // The trial's TL-S shape: prerequisites unverified and row-level unknowns. One question can cover both.
  const open = matchStageJobs(snapshot, tables, bare, [job]);
  const candidate = open.stages[0]!.candidates[0]!;
  assert.equal(candidate.status, 'unknown'); assert.equal(candidate.confirmable, true);
  assert.match(formatStageJobs(open), /前置也没核实：把前置和这份作业的确认放进同一个问题/);
  // A prerequisite known unmet keeps the job out of reach: nothing to ask about it.
  const raid = matchStageJobs(snapshot, tables, { ...bare, stages: [{ stageId: 'synthetic_01#f#', code: 'SYN-1', difficulty: 'raid', loops: 1 }],
    completions: { synthetic_01: 'PASS' }, completionEvidence: '用户：SYN-1 打过但没三星' }, [withContent(142, { opers: [{ name: '合成甲' }] }, 3)]).stages[0]!.candidates[0]!;
  assert.equal(raid.status, 'blocked'); assert.equal(raid.confirmable, false);
  // Answered prerequisites plus the confirmation: ready, and the saved report re-verifies.
  const answered = matchStageJobs(snapshot, tables, { ...bare, completions: { synthetic_00: 'PASS' }, completionEvidence: '用户：SYN-0 打过了，作业也核实过',
    jobConfirmations: [{ jobId: 141, contentHash: candidate.hash, source: 'user-confirmed', reference: said }] }, [job]);
  assert.equal(answered.stages[0]!.candidates[0]!.status, 'ready');
  assert.equal(matchStageJobs(open.snapshot, open.tables, open.request, open.jobs, open.search).hash, open.hash);
});
