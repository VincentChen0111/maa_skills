import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchStageJobs, formatStageJobs, type Job, type StageRequest } from '../skills/maa-core/scripts/stage-jobs.ts';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { stageTables, stageRequest, stageSnapshot, stageJob } from './fixtures/stage-data.ts';

// Owner trial item 9 (2026-11-16): 「这里战斗因为待核被阻挡了。1.为什么专精模组查不到？ 2. 怎么get over？」. Mastery and module
// requirements are checked against the snapshot's real data; the user can confirm what the snapshot lacks; only what is
// genuinely unknown stays 待核.

/** A saved Skland snapshot as a literal: 合成甲 has S1 M3, S2 M2, S3 M0, a Y module at level 2 and an X module still locked. */
const sklandSnapshot = (overrides: Record<string, unknown> = {}) => ({ version: 1, source: 'skland', readAt: '2026-11-16T00:00:00.000Z', operators: [
  { id: 'char_synthetic_a', name: '合成甲', rarity: 6, elite: 2, level: 90, potential: 1, skillLevel: 7, mastery: { 1: 3, 2: 2, 3: 0 },
    modules: { uniequip_001_synthetic_a: 1, uniequip_002_synthetic_a: 2, uniequip_003_synthetic_a: 0 }, ...overrides },
  { id: 'char_synthetic_b', name: '合成乙', rarity: 5, elite: 1, level: 30, potential: 1, skillLevel: 4, mastery: { 1: 0, 2: 0 }, modules: {} },
], items: {}, lmd: null, base: null, sourceTimes: { operators: null, inventory: null }, coverage: { operators: { status: 'complete', issues: [] },
  inventory: { status: 'complete', issues: [] }, base: { status: 'complete', issues: [] } } });
/** The pinned uniequip table, reduced to each module's operator and type letter (typeName2). */
const modules = { uniequip_001_synthetic_a: { charId: 'char_synthetic_a', typeName2: null }, uniequip_002_synthetic_a: { charId: 'char_synthetic_a', typeName2: 'Y' },
  uniequip_003_synthetic_a: { charId: 'char_synthetic_a', typeName2: 'X' } };
const tables = { ...stageTables, modules };
const withOper = (id: number, oper: Record<string, unknown>, extra: Record<string, unknown> = {}): Job => {
  const job = stageJob(id); job.content.opers = [oper]; Object.assign(job.content, extra); return job;
};
const first = (snapshot: unknown, jobs: Job[], request: StageRequest = stageRequest, tableValue: unknown = tables) => matchStageJobs(snapshot, tableValue, request, jobs).stages[0]!;
const row = (snapshot: unknown, oper: Record<string, unknown>, request?: StageRequest, tableValue?: unknown) => {
  const candidate = first(snapshot, [withOper(1, oper)], request, tableValue).candidates[0]!;
  return { status: candidate.status, reasons: candidate.requirements[0]!.reasons, candidate };
};

test('mastery is checked per skill against the snapshot: satisfied is ready, known short is blocked', () => {
  assert.equal(row(sklandSnapshot(), { name: '合成甲', skill: 1, requirements: { elite: 2, skill_level: 10 } }).status, 'ready');
  const short = row(sklandSnapshot(), { name: '合成甲', skill: 2, requirements: { elite: 2, skill_level: 10 } });
  assert.equal(short.status, 'blocked'); assert.ok(short.reasons.includes('insufficient-mastery'));
  assert.equal(row(sklandSnapshot(), { name: '合成甲', skill: 2, requirements: { elite: 2, skill_level: 9 } }).status, 'ready');
  // skill_level 1-7 is the shared skill level.
  assert.equal(row(sklandSnapshot(), { name: '合成甲', skill: 3, requirements: { elite: 2, skill_level: 7 } }).status, 'ready');
  assert.ok(row(sklandSnapshot(), { name: '合成乙', skill: 1, requirements: { elite: 1, skill_level: 7 } }).reasons.includes('insufficient-skill-level'));
});

test('without a mastery the snapshot knows, the requirement stays 待核 and says why', () => {
  const maa = row(stageSnapshot(), { name: '合成甲', skill: 2, requirements: { elite: 2, skill_level: 10 } });
  assert.equal(maa.status, 'unknown'); assert.ok(maa.reasons.includes('unknown-mastery'));
  const markdown = formatStageJobs(matchStageJobs(stageSnapshot(), tables, stageRequest, [withOper(1, { name: '合成甲', skill: 2, requirements: { elite: 2, skill_level: 10 } })]));
  assert.match(markdown, /MAA 识别不提供技能等级、专精和模组/);
  assert.match(markdown, /unknown-mastery：快照没有这个技能的专精/);
});

test('skill 0 keeps MAA default skill: mastery holds only when every skill has it', () => {
  assert.equal(row(sklandSnapshot({ mastery: { 1: 2, 2: 3, 3: 2 } }), { name: '合成甲', requirements: { elite: 2, skill_level: 9 } }).status, 'ready');
  assert.ok(row(sklandSnapshot({ mastery: { 1: 1, 2: 0, 3: 1 } }), { name: '合成甲', requirements: { elite: 2, skill_level: 9 } }).reasons.includes('insufficient-mastery'));
  const mixed = row(sklandSnapshot(), { name: '合成甲', requirements: { elite: 2, skill_level: 10 } });
  assert.equal(mixed.status, 'unknown'); assert.ok(mixed.reasons.includes('mastery-skill-unspecified'));
});

test('module requirements use MAA numbering (1-5 = X, Y, A, D, B) against the snapshot module of that type', () => {
  assert.equal(row(sklandSnapshot(), { name: '合成甲', skill: 1, requirements: { elite: 2, module: 2 } }).status, 'ready');
  assert.equal(row(sklandSnapshot(), { name: '合成甲', skill: 1, requirements: { elite: 2, module: 2, module_level: 2 } }).status, 'ready');
  const tooLow = row(sklandSnapshot(), { name: '合成甲', skill: 1, requirements: { elite: 2, module: 2, module_level: 3 } });
  assert.equal(tooLow.status, 'blocked'); assert.ok(tooLow.reasons.includes('insufficient-module'));
  const locked = row(sklandSnapshot(), { name: '合成甲', skill: 1, requirements: { elite: 2, module: 1 } });
  assert.equal(locked.status, 'blocked'); assert.ok(locked.reasons.includes('insufficient-module'));
  // A type the operator's modules do not include, or no module table at all, cannot be proved either way.
  assert.ok(row(sklandSnapshot(), { name: '合成甲', skill: 1, requirements: { elite: 2, module: 4 } }).reasons.includes('unknown-module'));
  assert.ok(row(sklandSnapshot(), { name: '合成甲', skill: 1, requirements: { elite: 2, module: 2 } }, stageRequest, stageTables).reasons.includes('unknown-module'));
  // module 0 picks "no module" on the branch page, which an unlocked module proves exists; -1 is no requirement.
  assert.equal(row(sklandSnapshot(), { name: '合成甲', skill: 1, requirements: { elite: 2, module: 0 } }).status, 'ready');
  assert.equal(row(sklandSnapshot(), { name: '合成甲', skill: 1, requirements: { elite: 2, module: -1 } }).status, 'ready');
  assert.ok(row(sklandSnapshot({ modules: { uniequip_003_synthetic_a: 0 } }), { name: '合成甲', skill: 1, requirements: { elite: 2, module: 0 } }).reasons.includes('unknown-module'));
  // MAA does not read module_level; without a module type it names nothing to check.
  assert.ok(row(sklandSnapshot(), { name: '合成甲', skill: 1, requirements: { elite: 2, module_level: 2 } }).reasons.includes('module-level-unattributed'));
  const report = matchStageJobs(sklandSnapshot(), tables, stageRequest, [withOper(1, { name: '合成甲', skill: 1, requirements: { elite: 2, module: 2 } })]);
  assert.deepEqual(Object.keys(report.tables.modules).sort(), Object.keys(modules).sort(), 'the report keeps the module entries it used');
  assert.equal(report.snapshotSource, 'skland');
  assert.match(formatStageJobs(report), /森空岛数据比游戏内滞后多久没有测过/);
});

test('user-confirmed facts fill what the snapshot lacks and never override what it knows', () => {
  const request = (facts: unknown) => ({ ...stageRequest, operatorFacts: facts }) as StageRequest;
  const oper = { name: '合成甲', skill: 2, requirements: { elite: 2, skill_level: 10, module: 2, module_level: 2 } };
  const confirmed = request([{ name: '合成甲', source: 'user-confirmed', reference: '合成用户：甲二技能专三，Y 模组二级', mastery: { 2: 3 }, moduleTypes: { Y: 2 } }]);
  const filled = row(stageSnapshot(), oper, confirmed);
  assert.equal(filled.status, 'ready', filled.reasons.join());
  assert.equal(filled.candidate.requirements[0]!.observed.mastery!['2']!.from, 'user-confirmed');
  assert.match(formatStageJobs(matchStageJobs(stageSnapshot(), tables, confirmed, [withOper(1, oper)])), /2 技能专精 3（用户确认）/);
  // A confirmed level below the requirement is known-insufficient.
  assert.equal(row(stageSnapshot(), oper, request([{ name: '合成甲', source: 'user-confirmed', reference: '合成用户原话', mastery: { 2: 1 }, moduleTypes: { Y: 2 } }])).status, 'blocked');
  // Against a snapshot that knows the value, a different fact is a conflict and stays 待核.
  const conflict = row(sklandSnapshot(), oper, request([{ name: '合成甲', source: 'user-confirmed', reference: '合成用户原话', mastery: { 2: 3 } }]));
  assert.equal(conflict.status, 'unknown'); assert.ok(conflict.reasons.includes('operator-fact-conflict:mastery'));
  // Malformed facts refuse the request with a specific reason.
  for (const facts of [[{ name: '合成甲', source: 'snapshot', reference: 'x', mastery: { 2: 3 } }], [{ name: '合成甲', source: 'user-confirmed', reference: '', mastery: { 2: 3 } }],
    [{ name: '合成甲', source: 'user-confirmed', reference: 'x', moduleTypes: { Z: 1 } }], [{ name: '合成甲', source: 'user-confirmed', reference: 'x' }],
    [{ name: '合成甲', source: 'user-confirmed', reference: 'x', mastery: { 2: 4 } }], 'all of them'])
    assert.throws(() => matchStageJobs(stageSnapshot(), tables, request(facts), [withOper(1, oper)]), /stage-jobs-operator-facts-invalid/);
});

test('duplicate group names, as MAA counts them, block that one candidate and leave the rest of the query', () => {
  const sameAsOperator = stageJob(1); sameAsOperator.content.groups = [{ name: '合成甲', opers: [{ name: '合成乙', requirements: { elite: 1 } }] }];
  const twoGroups = stageJob(2); twoGroups.content.opers = []; twoGroups.content.groups = [{ name: '组', opers: [{ name: '合成甲', requirements: { elite: 2 } }] },
    { name: '组', opers: [{ name: '合成乙', requirements: { elite: 1 } }] }];
  const operatorTwice = stageJob(3); operatorTwice.content.opers = [{ name: '合成甲', requirements: { elite: 2 } }, { name: '合成甲', requirements: { elite: 2 } }];
  // MAA's formation skips a group with no members, so it does not count as a repeat; the job stays 待核.
  const emptyGroup = stageJob(4); emptyGroup.content.groups = [{ name: '合成甲', opers: [] }];
  const stage = first(stageSnapshot(), [sameAsOperator, twoGroups, operatorTwice, emptyGroup, stageJob(5)]);
  for (const id of [1, 2, 3]) {
    const candidate = stage.candidates.find(item => item.id === id)!;
    assert.equal(candidate.status, 'blocked'); assert.ok(candidate.reasons.includes('job-group-name-duplicate'), String(id));
  }
  const empty = stage.candidates.find(item => item.id === 4)!;
  assert.equal(empty.status, 'unknown'); assert.ok(empty.reasons.includes('job-group-empty'));
  assert.deepEqual(empty.execution!.content.groups, [{ name: '合成甲', opers: [] }]);
  assert.equal(stage.primary, 5);
  assert.match(formatStageJobs(matchStageJobs(stageSnapshot(), tables, stageRequest, [sameAsOperator])), /MAA 自动编队会报「编队解析失败」/);
});

test('query reads the Skland snapshot through snapshotFile; prepare without it reads the kind the report used', async t => {
  const home = await mkdtemp(join(tmpdir(), 'maa-stage-skland-')); t.after(() => rm(home, { recursive: true, force: true }));
  const privateDirectory = join(home, 'private'), maaDirectory = join(home, 'maa'); await mkdir(privateDirectory); await mkdir(join(maaDirectory, 'config'), { recursive: true });
  await updateSettings({ language: 'zh-CN', privateDirectory, maaDirectory }, home);
  const skland = join(privateDirectory, 'account-snapshot-skland.json'); await writeFile(skland, JSON.stringify(sklandSnapshot()));
  const tablesFile = join(home, 'tables.json'), jobsFile = join(home, 'jobs.json');
  await writeFile(tablesFile, JSON.stringify(tables));
  await writeFile(jobsFile, JSON.stringify([withOper(1, { name: '合成甲', skill: 1, requirements: { elite: 2, skill_level: 10, module: 2 } })]));
  const script = fileURLToPath(new URL('../skills/maa-core/scripts/stage-jobs.ts', import.meta.url));
  const run = (action: string, input: unknown) => spawnSync(process.execPath, [script, action], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, MAA_SKILLS_HOME: home } });
  const query = run('query', { request: stageRequest, tablesFile, jobsFile, snapshotFile: skland, saveReport: true });
  assert.equal(query.status, 0, query.stdout + query.stderr);
  const report = JSON.parse(query.stdout).report;
  assert.equal(report.snapshotSource, 'skland'); assert.equal(report.stages[0].candidates[0].status, 'ready');
  const approval = { reportHash: report.hash, reference: '合成用户批准主作业 1', map: 'synthetic_map', selections: [{ stageId: 'synthetic_01', primary: 1, alternates: [], loops: 3 }] };
  // No MAA recognition snapshot exists: prepare passes the snapshot check only by reading the Skland snapshot the report used.
  const prepared = run('prepare', { approval, profile: 0, host: 'codex', expectedRevision: 'a'.repeat(64) });
  assert.notEqual(JSON.parse(prepared.stdout).reason, 'stage-jobs-snapshot-changed', prepared.stdout);
  assert.notEqual(JSON.parse(prepared.stdout).status, 'check-required', prepared.stdout);
  await writeFile(skland, JSON.stringify(sklandSnapshot({ level: 80 })));
  assert.equal(JSON.parse(run('prepare', { approval, profile: 0, host: 'codex', expectedRevision: 'a'.repeat(64) }).stdout).reason, 'stage-jobs-snapshot-changed');
});
