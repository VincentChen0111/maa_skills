import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchStageJobs, collectStageJobs, formatStageJobs, prepareStageJobs, type Job } from '../skills/maa-core/scripts/stage-jobs.ts';
import { inspectConfiguration, type MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';
import { approvedJobFile } from '../skills/maa-core/scripts/stage-job-plan.ts';
import { stageSnapshot, stageTables, stageRequest, stageJob } from './fixtures/stage-data.ts';

const accountSnapshot = stageSnapshot();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceFile = (directory: string, reportHash: string, id: number) => join(directory, 'stage-jobs', reportHash, 'source', `${id}.json`);
const groupedJob = (): Job => ({ ...stageJob(7), content: { ...stageJob(7).content, opers: [], groups: [{ name: '合成槽', opers: [
  { name: '合成甲', requirements: { elite: 1, level: 20, potentiality: 6 } },
  { name: '合成乙', skill: 2, requirements: { elite: -1, level: 20, potentiality: 1 } },
] }] } });

test('approved execution pins the verified group member and normalized requirements while preserving source evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage-derived-')); t.after(() => rm(root, { recursive: true, force: true }));
  const maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private');
  await mkdir(join(maaDirectory, 'config'), { recursive: true });
  const file = join(maaDirectory, 'config/gui.new.json');
  const initial = { Current: 'Synthetic', Configurations: { Synthetic: { TaskQueue: [], Copilot: { TaskList: [], LoopTimes: 91, EnableUserAdditional: true } } }, Timers: { List: [] } };
  await writeFile(file, JSON.stringify(initial));
  const original = groupedJob(), originalBytes = JSON.stringify(original);
  const report = matchStageJobs(accountSnapshot, stageTables, stageRequest, [original, stageJob(8)]);
  const candidate = report.stages[0]!.candidates[0]!;
  assert.equal(candidate.status, 'ready');
  assert.equal(candidate.assignment['合成槽'], '合成乙');
  const approval = { reportHash: report.hash, reference: '批准已核分配和规范化，主 7 三次、备选 8；由用户开始', map: 'synthetic_map', selections: [{ stageId: 'synthetic_01', primary: 7, alternates: [8], loops: 3 }] };
  const actions: string[] = []; let running = false;
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; actions.push('close'); }, start: async () => { running = true; actions.push('reopen'); } };
  const result = await prepareStageJobs({ report, approval, snapshot: accountSnapshot, maaDirectory, privateDirectory, profile: 0, host: 'codex', closedConfirmed: true, expectedRevision: (await inspectConfiguration(maaDirectory)).revision }, maa);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  const saved = JSON.parse(await readFile(file, 'utf8')), list = saved.Configurations.Synthetic.Copilot.TaskList;
  assert.equal(list.length, 3); assert.deepEqual(list.map((item: any) => [item.CopilotId, item.Index]), [[7, 0], [7, 1], [7, 2]]);
  assert.equal(saved.Configurations.Synthetic.Copilot.LoopTimes, 91); assert.equal(saved.Configurations.Synthetic.Copilot.EnableUserAdditional, false);
  const execution = JSON.parse(await readFile(list[0].FilePath, 'utf8'));
  assert.deepEqual(execution.groups[0].opers, [{ name: '合成乙', skill: 2, requirements: { elite: 1, level: 20, potentiality: 1 } }]);
  assert.deepEqual(execution.actions, original.content.actions);
  assert.deepEqual(execution, candidate.execution!.content);
  assert.equal(hash(execution), candidate.execution!.hash); assert.notEqual(candidate.execution!.hash, candidate.hash);
  assert.deepEqual(JSON.parse(await readFile(sourceFile(privateDirectory, report.hash, 7), 'utf8')), original.content);
  assert.equal(JSON.stringify(original), originalBytes);
  const pending = JSON.parse((await readFile(join(privateDirectory, 'daily-pending.jsonl'), 'utf8')).trim());
  const plan = pending.authorization.jobPlan.entries[0];
  assert.equal(plan.primary.hash, candidate.execution!.hash); assert.equal(plan.primary.sourceHash, candidate.hash);
  assert.equal(plan.alternates[0].sourceHash, hash(stageJob(8).content));
  assert.deepEqual(actions, ['reopen']);
  assert.match(formatStageJobs(report), /执行分配.*合成槽.*合成乙/);
  assert.match(formatStageJobs(report), /规范化.*elite.*1/);
});

test('S3 elite -1/0/1 is normalized before matching and approval; unknown and insufficient elite or level stay unsafe', () => {
  const account = structuredClone(accountSnapshot); account.operators[0]!.name = '能天使'; account.operators[0]!.rarity = 6;
  for (const elite of [-1, 0, 1]) {
    const input = { ...stageJob(9), content: { ...stageJob(9).content, opers: [{ name: '能天使', skill: 3, requirements: { elite, level: 40 } }] } };
    const candidate = matchStageJobs(account, stageTables, stageRequest, [input]).stages[0]!.candidates[0]!;
    assert.equal(candidate.status, 'ready');
    assert.equal(candidate.execution!.content.opers[0].requirements.elite, 2);
    assert.equal(candidate.requirements[0]!.required.elite, elite);
    assert.equal(candidate.requirements[0]!.effectiveRequired.elite, 2);
    assert.equal(candidate.content.opers[0].requirements.elite, elite);
    const low = structuredClone(account); low.operators[0]!.level = 20;
    assert.equal(matchStageJobs(low, stageTables, stageRequest, [input]).stages[0]!.candidates[0]!.status, 'blocked');
    low.operators[0]!.elite = 1;
    assert.equal(matchStageJobs(low, stageTables, stageRequest, [input]).stages[0]!.candidates[0]!.status, 'blocked');
    low.operators[0]!.elite = null; low.operators[0]!.level = 50;
    const unknown = matchStageJobs(low, stageTables, stageRequest, [input]).stages[0]!.candidates[0]!;
    assert.equal(unknown.status, 'unknown'); assert.equal(unknown.execution, null);
  }
});

test('derived groups preserve the globally unique allocation and the exact chosen alternative requirements', () => {
  const input = { ...stageJob(7), content: { ...stageJob(7).content, opers: [], groups: [
    { name: '二选一', opers: [{ name: '合成甲' }, { name: '合成乙', requirements: { potentiality: 6 } }, { name: '合成乙', requirements: { potentiality: 1 } }] },
    { name: '仅甲', opers: [{ name: '合成甲' }] },
  ], actions: [{ type: 'Deploy', name: '二选一', location: [1, 1], direction: 'Right' }] } };
  const candidate = matchStageJobs(accountSnapshot, stageTables, stageRequest, [input]).stages[0]!.candidates[0]!;
  assert.equal(candidate.status, 'ready');
  assert.deepEqual(candidate.assignment, { '仅甲': '合成甲', '二选一': '合成乙' });
  assert.deepEqual(candidate.execution!.content.groups.map((group: any) => group.opers), [
    [{ name: '合成乙', requirements: { potentiality: 1 } }], [{ name: '合成甲' }],
  ]);
  assert.deepEqual(candidate.execution!.content.actions, input.content.actions);
});

test('approval binds displayed execution and search coverage as well as original source content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage-report-drift-')); t.after(() => rm(root, { recursive: true, force: true }));
  const report = matchStageJobs(accountSnapshot, stageTables, stageRequest, [groupedJob()]);
  const base = { report, approval: { reportHash: report.hash, reference: '合成批准', map: 'synthetic_map', selections: [{ stageId: 'synthetic_01', primary: 7, alternates: [], loops: 3 }] },
    snapshot: accountSnapshot, maaDirectory: join(root, 'maa'), privateDirectory: join(root, 'private'), profile: 0, host: 'codex' as const, expectedRevision: 'unused' };
  let inspections = 0;
  const maa: MaaProcess = { inspect: async () => { inspections++; throw new Error('must-not-inspect'); }, close: async () => {}, start: async () => {} };
  const changed = structuredClone(report); changed.stages[0]!.candidates[0]!.execution!.content.groups[0].opers[0].name = '合成甲';
  await assert.rejects(() => prepareStageJobs({ ...base, report: changed }, maa), /approval/);
  const searchChanged = structuredClone(report); searchChanged.search[0] = { stageId: 'synthetic_01', mode: 'online', pages: 3, truncated: true };
  await assert.rejects(() => prepareStageJobs({ ...base, report: searchChanged }, maa), /approval/);
  assert.equal(inspections, 0);
});

test('MAA version ordering supports prereleases and optional minimum patch without treating unknown versions as scope errors', () => {
  const cases = [
    ['v6.21.4', 'v6.8.0-beta.1', 'ready'], ['v6.8.0-beta.2', 'v6.8.0-beta.1', 'ready'],
    ['v6.8.0-beta.10', 'v6.8.0-beta.2', 'ready'], ['v6.8.0-rc.1', 'v6.8.0-beta.9', 'ready'],
    ['v6.8.0', 'v6.8.0-rc.1', 'ready'], ['v6.8.0-beta.1', 'v6.8.0', 'unknown'],
    ['v6.8.0-beta.1', 'v6.8.0-beta.1.1', 'unknown'], ['v6.8.0-1', 'v6.8.0-alpha', 'unknown'],
    ['v6.8.0', 'v6.8', 'ready'], ['v6.8', 'v6.8.0', 'unknown'],
    ['v6.8.0+build.2', 'v6.8.0+build.10', 'ready'], ['v6.8.0', 'v6.8.0+build', 'unknown'],
    ['v6.8.0+build', 'v6.8.0', 'ready'], ['development', 'v6.0.0', 'unknown'],
    ['v6.21.4', 'unknown', 'unknown'], ['v6.8.0-beta.01', 'v6.8.0-beta.1', 'unknown'],
    ['v06.8.0', 'v6.8.0', 'unknown'], ['v6.8.0-beta..1', 'v6.8.0-beta.1', 'unknown'],
  ];
  for (const [current, minimum, expected] of cases) {
    const report = matchStageJobs(accountSnapshot, stageTables, { ...stageRequest, maaVersion: current! }, [{ ...stageJob(1), content: { ...stageJob(1).content, minimum_required: minimum } }]);
    assert.equal(report.stages[0]!.candidates[0]!.status, expected, `${current} / ${minimum}`);
  }
});

test('each stage Markdown reports search coverage, including truncation and offline unsearched inputs', async () => {
  const request = { ...stageRequest, stages: [...stageRequest.stages, { ...stageRequest.stages[0]!, stageId: 'synthetic_01#f#', difficulty: 'raid' as const }], completions: { synthetic_00: 'PASS' as const, synthetic_01: 'COMPLETE' as const } };
  let calls = 0;
  const report = await collectStageJobs(accountSnapshot, stageTables, request, async () => {
    calls++; return Response.json({ status_code: 200, data: { data: [], has_next: calls <= 3 } });
  });
  assert.deepEqual(report.search.map(item => [item.pages, item.truncated]), [[3, true], [1, false]]);
  const markdown = formatStageJobs(report), sections = markdown.split('### ');
  assert.match(sections[1]!, /检索覆盖：3 页.*未穷尽/);
  assert.match(sections[2]!, /检索覆盖：1 页.*查询已结束/);
  assert.match(formatStageJobs(matchStageJobs(accountSnapshot, stageTables, stageRequest, [])), /检索覆盖：离线输入.*未进行在线检索/);
});

test('drift of either asset before write or at readback retains unknown and transaction evidence', async t => {
  for (const asset of ['source', 'execution']) for (const at of ['close', 'reopen']) {
    const root = await mkdtemp(join(tmpdir(), `stage-drift-${asset}-${at}-`)); t.after(() => rm(root, { recursive: true, force: true }));
    const maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private'); await mkdir(join(maaDirectory, 'config'), { recursive: true });
    const file = join(maaDirectory, 'config/gui.new.json');
    const initial = { Current: 'Synthetic', Configurations: { Synthetic: { TaskQueue: [], Copilot: { TaskList: [], EnableUserAdditional: false } } }, Timers: { List: [] } };
    await writeFile(file, JSON.stringify(initial));
    const report = matchStageJobs(accountSnapshot, stageTables, stageRequest, [groupedJob()]); let running = true;
    const drift = () => writeFile(asset === 'source' ? sourceFile(privateDirectory, report.hash, 7) : approvedJobFile(privateDirectory, report.hash, 7), '{}');
    const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }),
      close: async () => { running = false; if (at === 'close') await drift(); },
      start: async () => { assert.equal(at, 'reopen'); running = true; await drift(); } };
    const result = await prepareStageJobs({ report, approval: { reportHash: report.hash, reference: '合成批准', map: 'synthetic_map', selections: [{ stageId: 'synthetic_01', primary: 7, alternates: [], loops: 3 }] },
      snapshot: accountSnapshot, maaDirectory, privateDirectory, profile: 0, host: 'codex', expectedRevision: (await inspectConfiguration(maaDirectory)).revision }, maa);
    assert.equal(result.status, 'unknown');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (at === 'close') assert.deepEqual(saved, initial);
    else assert.equal(saved.Configurations.Synthetic.Copilot.TaskList.length, 3);
    assert.equal(JSON.parse(await readFile(join(maaDirectory, 'config/.maa-skills.lock'), 'utf8')).phase, at === 'close' ? 'backup' : 'readback');
    const runs = (await readFile(join(privateDirectory, 'daily-runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(runs.at(-1).status, 'unknown'); assert.ok(runs.every(run => run.status !== 'complete'));
  }
});
