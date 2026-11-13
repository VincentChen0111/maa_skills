import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareBatches, runBatch } from '../scripts/eval-batch.ts';
import type { ScenarioDefinition } from '../scripts/eval-run.ts';
import { entryId, scenarioCatalog, selectScenarios, type ScenarioEntry } from '../scripts/eval-scenarios.ts';
import { compareRuns, type RunRecord } from '../scripts/evaluation.ts';

// Conformance test for the one comparability owner (scripts/evaluation.ts): what identifies a scenario, and when two record
// sets or batches may be compared. Inputs to scenario identity: runner sources, harness files, every scenario definition with
// its eval fixtures and network fixtures, and the product modules scenarios reference. Consumers: compareRuns (per scenario
// and overall), its baseline branch, compareBatches, the compare command's exit code, rerun batches and resume.
const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const double = join(repository, 'eval/host-double.mjs');
const root = await mkdtemp(join(tmpdir(), 'maa-comparability-test-'));
const home = join(root, 'home'); const settings = join(root, 'settings');
await mkdir(home); await mkdir(settings);
await writeFile(join(settings, 'config.json'), JSON.stringify({ privateDirectory: join(root, 'private') }));
Object.assign(process.env, { USERPROFILE: home, HOME: home, MAA_SKILLS_HOME: settings });
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
let counter = 0;
const script = async (value: Record<string, unknown>) => { const file = join(root, `script-${counter++}.json`); await writeFile(file, JSON.stringify(value)); return file; };
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result.push(...entry.isDirectory() ? await files(path) : [path]);
  }
  return result;
}

// A release that changes only the product: both pinned game-data commits move, and a product script changes.
let release: Promise<string> | undefined;
const productRelease = () => release ??= (async () => {
  const directory = await mkdtemp(join(root, 'release-'));
  for (const item of ['scripts', 'eval', 'skills', 'tests/fixtures']) await cp(join(repository, item), join(directory, item), { recursive: true });
  await cp(join(repository, 'package.json'), join(directory, 'package.json'));
  const cost = join(directory, 'skills/maa-core/scripts/operator-cost.ts');
  const text = await readFile(cost, 'utf8');
  const moved = text.replace(/const mainCommit = '[0-9a-f]{40}'/, `const mainCommit = '${'1'.repeat(40)}'`).replace(/const crossCommit = '[0-9a-f]{40}'/, `const crossCommit = '${'2'.repeat(40)}'`);
  assert.ok(moved.includes('1'.repeat(40)) && moved.includes('2'.repeat(40)), 'both pinned commits moved');
  await writeFile(cost, moved);
  const preferences = join(directory, 'skills/maa-core/scripts/preferences.ts');
  await writeFile(preferences, `${await readFile(preferences, 'utf8')}\n// A product-only change.\n`);
  return directory;
})();

test('scenario identity counts every scenario definition, eval fixture and network fixture, and no product file or product-derived value', async () => {
  const { scenarioIdentity } = await import('../scripts/evaluation.ts');
  const identities = (catalog: ScenarioEntry[]) => new Map(catalog.map((entry) => [entryId(entry),
    scenarioIdentity({ prompt: '', runner: {}, harness: {}, definition: entry.definition as ScenarioDefinition })]));
  const here = identities(scenarioCatalog());
  // Every product module a scenario definition references. A new one must have its product-derived values normalised in
  // scenarioIdentity (as the pinned commit in network fixture URLs is) and be added here.
  const references: string[] = [];
  for (const file of (await files(join(repository, 'eval'))).filter((path) => /\.(?:ts|mjs)$/.test(path))) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/from '((?:\.\.\/)+skills\/[^']+)'/g)) {
      references.push(`${relative(repository, file).replaceAll('\\', '/')} -> ${relative(repository, join(dirname(file), match[1]!)).replaceAll('\\', '/')}`);
    }
  }
  assert.deepEqual(references.sort(), ['eval/maa-account/cost-scenarios.ts -> skills/maa-core/scripts/operator-cost.ts',
    'eval/maa-account/gap-scenarios.ts -> skills/maa-core/scripts/cultivation-gaps.ts', 'eval/maa-account/gap-scenarios.ts -> skills/maa-core/scripts/operator-cost.ts']);
  // A product-only release keeps every scenario, although its network fixture URLs now name other commits.
  const copy = await productRelease();
  const released = (await import(pathToFileURL(join(copy, 'scripts/eval-scenarios.ts')).href) as typeof import('../scripts/eval-scenarios.ts')).scenarioCatalog();
  const cost = released.find((entry) => entryId(entry) === 'account-cost-raw')!.definition as ScenarioDefinition;
  assert.ok(Object.keys(cost.networkFixtures!).some((url) => url.includes('1'.repeat(40))), 'the release moved the fixture URLs');
  const there = identities(released);
  assert.deepEqual([...there.keys()].sort(), [...here.keys()].sort());
  for (const [id, identity] of here) assert.equal(there.get(id), identity, `${id}: a product-only release keeps the scenario`);
  // A real scenario change (prompt, grading, network fixture content, eval fixture content) changes that scenario only.
  const changed = (id: string, change: (definition: any) => void) => {
    const catalog = scenarioCatalog().map((entry) => ({ ...entry, definition: structuredClone(entry.definition) }));
    change(catalog.find((entry) => entryId(entry) === id)!.definition);
    const next = identities(catalog);
    assert.deepEqual([...here].filter(([key, value]) => next.get(key) !== value).map(([key]) => key), [id], `changing ${id}`);
  };
  changed('core-language', (definition) => { definition.prompt += '。'; });
  changed('setup-connection-write', (definition) => { definition.policy.writerTransaction.reference = 'another request'; });
  changed('account-cost-raw', (definition) => { const [url] = Object.keys(definition.networkFixtures); definition.networkFixtures[url!] = { changed: true }; });
  changed('account-cost-unknown', (definition) => { definition.jsonInputs['private/account-snapshot.json'].operators = []; });
});

test('the runner records the same scenario for repeated runs and across a product-only release, and a new skill version', async () => {
  const run = async (checkout: string, id: string) => {
    const { runScenario } = await import(pathToFileURL(join(checkout, 'scripts/eval-run.ts')).href) as typeof import('../scripts/eval-run.ts');
    const { selectScenarios: select } = await import(pathToFileURL(join(checkout, 'scripts/eval-scenarios.ts')).href) as typeof import('../scripts/eval-scenarios.ts');
    const [entry] = select([id]);
    const outcome = await runScenario({ host: 'claude', model: 'fixed-model', scenario: entry!.definition as ScenarioDefinition, executable: process.execPath,
      executableArgs: [join(checkout, 'eval/host-double.mjs'), await script({ host: 'claude', steps: [] })], auth: { mode: 'host-double' }, artifactParent: join(root, 'runs'),
      ...(entry!.skillDirectory ? { skillDirectory: entry!.skillDirectory } : {}), companionSkills: entry!.companionSkills });
    // Compared as real records are: only the double mark and the grade differ from a model run.
    const { double: _double, ...record } = outcome.record;
    return { ...record, grade: { ...record.grade, status: 'pass' as const } };
  };
  const copy = await productRelease();
  // core-language: maa-core alone; account-cost-raw: maa-account with network fixtures; setup-connection-write: a policy path
  // rendered into the run's own workspace.
  const ids = ['core-language', 'account-cost-raw', 'setup-connection-write'];
  const before: RunRecord[] = []; const again: RunRecord[] = []; const after: RunRecord[] = [];
  for (const id of ids) { before.push(await run(repository, id)); again.push(await run(repository, id)); after.push(await run(copy, id)); }
  const problems = ids.flatMap((id, index) => [
    ...(again[index]!.scenarioHash !== before[index]!.scenarioHash ? [`${id}: a repeated run is another scenario`] : []),
    ...(after[index]!.scenarioHash !== before[index]!.scenarioHash ? [`${id}: a product-only release is another scenario`] : []),
    ...(after[index]!.skillVersion === before[index]!.skillVersion ? [`${id}: the skill version misses the release`] : [])]);
  assert.deepEqual(problems, []);
  assert.equal(new Set(before.map((record) => record.skillVersion)).size, 3, 'each group installs its own skill set');
  assert.equal(compareRuns(before, again).status, 'pass', 'identical multi-group runs');
  assert.equal(compareRuns(before, after).status, 'pass', 'a product-only release');
});

test('every consumer compares per scenario: multi-group batches, baseline, batch comparison, exit code and rerun batches', async () => {
  const record = (id: string, scenario: string, extra: Partial<RunRecord> = {}): RunRecord => ({ id, host: 'claude', hostVersion: '2.1.321', model: 'fixed-model',
    scenario, scenarioHash: `hash-${scenario}`, skillVersion: `skills-of-${scenario}`, evidenceHash: `evidence-${id}`, grade: { status: 'pass', score: 8, total: 8, failed: [] }, ...extra });
  // One scenario from each kind of group: each installs a different skill set, so each has its own skill version.
  const scenarios = ['core-language', 'account-cost-raw', 'cross-skill-help-referral'];
  const suite = (prefix: string, change: Record<string, Partial<RunRecord>> = {}) => scenarios.map((scenario) => record(`${prefix}-${scenario}`, scenario, change[scenario]));
  const batch = async (records: RunRecord[]) => {
    const directory = await mkdtemp(join(root, 'batch-'));
    const runs = [];
    for (const item of records) {
      await mkdir(join(directory, item.id)); await writeFile(join(directory, item.id, 'run.json'), JSON.stringify(item));
      runs.push({ scenario: item.scenario, directory: item.id, id: item.id, reason: 'completed', grade: item.grade.status, ...(item.rerunOf ? { rerunOf: item.rerunOf } : {}) });
    }
    const rerunOf = Object.fromEntries(records.filter((item) => item.rerunOf).map((item) => [item.scenario, item.rerunOf!]));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ kind: 'maa-skills-evaluation-batch', version: 1, runs, ...(Object.keys(rerunOf).length ? { rerunOf } : {}) }));
    return directory;
  };
  const exitCode = (...args: string[]) => spawnSync(process.execPath, ['scripts/eval-batch.ts', 'compare', ...args], { cwd: repository, encoding: 'utf8', windowsHide: true }).status;
  const statuses = (result: Awaited<ReturnType<typeof compareBatches>>) => result.scenarios.map((item) => [item.scenario, item.status]);

  const before = suite('before');
  // Identical multi-group batches compare as a pass everywhere; a first run of them is a baseline.
  const same = suite('same');
  assert.equal(compareRuns(before, same).status, 'pass');
  assert.equal(compareRuns([], same).status, 'baseline');
  const [beforeBatch, sameBatch] = [await batch(before), await batch(same)];
  const identical = await compareBatches(beforeBatch, sameBatch);
  assert.equal(identical.overall.status, 'pass'); assert.deepEqual(statuses(identical), [...scenarios].sort().map((scenario) => [scenario, 'pass']));
  assert.equal(exitCode(beforeBatch, sameBatch), 0);
  // A product-only release: every skill version is new, every scenario the same.
  const released = suite('released', Object.fromEntries(scenarios.map((scenario) => [scenario, { skillVersion: `candidate-${scenario}` }])));
  assert.equal(compareRuns(before, released).status, 'pass');
  // A real change to one scenario makes that scenario incomparable and only that one; the overall verdict and the exit code follow.
  const changedBatch = await batch(suite('changed', { 'account-cost-raw': { scenarioHash: 'hash-changed' } }));
  const changed = await compareBatches(beforeBatch, changedBatch);
  assert.deepEqual(statuses(changed), [['account-cost-raw', 'incomparable'], ['core-language', 'pass'], ['cross-skill-help-referral', 'pass']]);
  assert.equal(changed.overall.status, 'incomparable');
  assert.equal(exitCode(beforeBatch, changedBatch), 1);
  // Rerun batches: a pass→fail scenario needs three reruns of the same skill version; the other scenarios keep their own versions.
  const failing = suite('failing', { 'core-language': { grade: { status: 'fail', score: 7, total: 8, failed: ['write-lock'] } } });
  const failingBatch = await batch(failing);
  const needs = await compareBatches(beforeBatch, failingBatch);
  assert.equal(needs.overall.status, 'needs-reruns'); assert.deepEqual(needs.rerunScenarios, ['core-language']);
  const target = failing[0]!;
  const reruns = await batch([1, 2, 3].map((index) => record(`rerun-${index}`, 'core-language', { skillVersion: target.skillVersion, rerunOf: target.id })));
  const rerun = await compareBatches(beforeBatch, failingBatch, [reruns]);
  assert.equal(rerun.overall.status, 'unstable'); assert.deepEqual(statuses(rerun), [['account-cost-raw', 'pass'], ['core-language', 'unstable'], ['cross-skill-help-referral', 'pass']]);
  const otherVersion = await batch([1, 2, 3].map((index) => record(`other-${index}`, 'core-language', { skillVersion: 'another-candidate', rerunOf: target.id })));
  assert.equal((await compareBatches(beforeBatch, failingBatch, [otherVersion])).overall.status, 'incomparable', 'reruns run the same skill version');
});

test('resume continues a batch only with the same payload, so one batch never mixes two candidates', async () => {
  const skill = join(root, 'skill-copy', 'maa-core');
  await cp(join(repository, 'skills/maa-core'), skill, { recursive: true });
  const [entry] = selectScenarios(['core-language']);
  const options = { host: 'claude' as const, model: 'fixed-model', entries: [{ ...entry!, skillDirectory: skill }], auth: 'host-double' as const, executable: process.execPath,
    executableArgs: [double, await script({ host: 'claude', steps: [] })], batchParent: join(root, 'resume') };
  const first = await runBatch(options);
  assert.equal(first.manifest.status, 'complete');
  assert.equal((await runBatch({ ...options, resume: first.directory })).manifest.status, 'complete', 'the same payload resumes');
  const changed = join(skill, 'scripts/preferences.ts');
  await writeFile(changed, `${await readFile(changed, 'utf8')}\n// Another candidate.\n`);
  await assert.rejects(runBatch({ ...options, resume: first.directory }), /fingerprint-mismatch/, 'another candidate is another batch');
});
