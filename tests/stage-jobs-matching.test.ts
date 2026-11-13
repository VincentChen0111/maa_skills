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
