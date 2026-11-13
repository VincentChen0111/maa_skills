import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareBatches, readManifest, runBatch, runnerSources } from '../scripts/eval-batch.ts';
import { scenarioHashSources, type ScenarioDefinition } from '../scripts/eval-run.ts';
import { createFixture } from '../scripts/eval-fixture.ts';
import { entryId, scenarioCatalog, scenarioGroups, selectScenarios } from '../scripts/eval-scenarios.ts';
import { compareRuns, type RunRecord } from '../scripts/evaluation.ts';
import { accountScenarios } from '../eval/maa-account/scenarios.ts';
import { baseScenarios } from '../eval/maa-account/base-scenarios.ts';
import { costScenarios } from '../eval/maa-account/cost-scenarios.ts';
import { gapScenarios } from '../eval/maa-account/gap-scenarios.ts';
import { researchScenarios } from '../eval/maa-account/research-scenarios.ts';
import { sklandScenarios } from '../eval/maa-account/skland-scenarios.ts';
import { communityScenarios } from '../eval/maa-account/community-scenarios.ts';
import { reportScenarios } from '../eval/maa-account/report-scenarios.ts';
import { baseReportScenarios } from '../eval/maa-account/base-report-scenarios.ts';
import { coreScenarios } from '../eval/maa-core/scenarios.ts';
import { dailyScenarios } from '../eval/maa-daily/scenarios.ts';
import { stageScenarios } from '../eval/maa-daily/stage-scenarios.ts';
import { stageRunScenarios } from '../eval/maa-daily/stage-run-scenarios.ts';
import { stageAlternateScenarios } from '../eval/maa-daily/stage-alternate-scenarios.ts';
import { baseApplyScenarios } from '../eval/maa-daily/base-apply-scenarios.ts';
import { trainingScenarios } from '../eval/maa-daily/training-scenarios.ts';
import { doctorScenarios } from '../eval/maa-doctor/scenarios.ts';
import { helpScenarios } from '../eval/maa-help/scenarios.ts';
import { setupScenarios } from '../eval/maa-setup/scenarios.ts';
import { crossSkillScenarios } from '../eval/cross-skill/scenarios.ts';

const double = fileURLToPath(new URL('../eval/host-double.mjs', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'maa-batch-test-'));
const home = join(root, 'home'); const settings = join(root, 'settings');
await mkdir(home); await mkdir(settings);
await writeFile(join(settings, 'config.json'), JSON.stringify({ privateDirectory: join(root, 'private') }));
Object.assign(process.env, { USERPROFILE: home, HOME: home, MAA_SKILLS_HOME: settings });
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
let counter = 0;
const script = async (value: Record<string, unknown>) => { const file = join(root, `script-${counter++}.json`); await writeFile(file, JSON.stringify(value)); return file; };
// Each login directory carries a unique marker segment, so a leak is found in any spelling or escaping.
const login = async () => {
  const directory = join(root, `UniqueLoginMarker${counter++}x${Math.random().toString(36).slice(2, 8)}`, 'claude-config');
  await mkdir(directory, { recursive: true }); return directory;
};
const marker = (directory: string) => directory.split(/[\\/]/).at(-2)!;
const lines = async (file: string) => { try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
const planHost = { authStatus: { loggedIn: true, authMethod: 'claude.ai' }, steps: [{ fileRead: '{{sentinel}}', deny: true }, { shellRead: '{{sentinel}}', deny: true }] };
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result.push(...entry.isDirectory() ? await files(path) : [path]);
  }
  return result;
}

test('every eval scenario is reachable by id and group, once, with its skill and the companions it needs', async () => {
  const catalog = scenarioCatalog();
  const ids = catalog.map(entryId);
  const all = [accountScenarios, baseScenarios, costScenarios, gapScenarios, researchScenarios, coreScenarios, dailyScenarios, stageScenarios, trainingScenarios,
    stageRunScenarios, sklandScenarios, communityScenarios, reportScenarios, baseReportScenarios, stageAlternateScenarios, baseApplyScenarios, doctorScenarios, helpScenarios, setupScenarios,
    crossSkillScenarios].flat().map((scenario) => scenario.id);
  assert.deepEqual([...ids].sort(), [...all].sort());
  // Every scenario module under eval/<skill>/ is in the catalog: each exported array of definitions (objects with an id and a
  // prompt) is found by walking those directories, so a module added without a catalog group fails here.
  const evalDirectory = join(repository, 'eval');
  const exported: string[] = [];
  for (const file of (await files(evalDirectory)).filter((path) => path.endsWith('.ts') && relative(evalDirectory, path).split(/[\\/]/).length === 2)) {
    for (const value of Object.values(await import(pathToFileURL(file).href) as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length && value.every((item) => typeof item?.id === 'string' && typeof item?.prompt === 'string')) exported.push(...value.map((item) => item.id as string));
    }
  }
  assert.deepEqual([...ids].sort(), [...exported].sort(), 'every scenario exported under eval/<skill>/ is in the catalog');
  assert.equal(new Set(ids).size, ids.length, 'scenario ids are unique');
  for (const entry of catalog) {
    if (!['maa-core', 'maa-help'].includes(entry.group)) assert.ok(entry.companionSkills['maa-core'], `${entryId(entry)} installs maa-core`);
    if (entry.group === 'cross-skill') assert.ok(!entry.skillDirectory && Object.keys(entry.companionSkills).length > 1, `${entryId(entry)} installs several skills`);
  }
  assert.deepEqual(selectScenarios(['daily-inspect', 'maa-core', 'daily-inspect']).map(entryId), ['daily-inspect', ...coreScenarios.map((item) => item.id)]);
  assert.ok(scenarioGroups().includes('all'));
  assert.throws(() => selectScenarios(['no-such-scenario']), /unknown-scenario/);
});

test('a batch runs one host and one model strictly in sequence and lists every record in its manifest', async () => {
  const journal = join(root, 'serial.jsonl');
  const entries = selectScenarios(['maa-core']);
  const { directory, manifest } = await runBatch({ host: 'claude', model: 'fixed-model', entries, auth: 'host-double', executable: process.execPath,
    executableArgs: [double, await script({ host: 'claude', journal, steps: [], sleepMs: 200 })], batchParent: join(root, 'batches') });
  assert.equal(manifest.status, 'complete'); assert.equal(manifest.double, true);
  assert.deepEqual(manifest.runs.map((run) => run.scenario), entries.map(entryId));
  const runs = (await lines(journal)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  assert.equal(runs.length, entries.length);
  for (let index = 1; index < runs.length; index++) assert.ok(runs[index].startedAt >= runs[index - 1].endedAt, 'no two runs of one host overlap');
  for (const run of manifest.runs) assert.equal(JSON.parse(await readFile(join(directory, run.directory, 'run.json'), 'utf8')).double, true);
});

test('plan-login batches stop before any scenario when the auth preflight or the read-protection check fails', async () => {
  for (const [name, value, stage] of [
    ['not logged in', { authStatus: { loggedIn: false } }, 'auth-preflight'],
    ['command reads the sentinel', { ...planHost, steps: [{ fileRead: '{{sentinel}}', deny: true }, { shellRead: '{{sentinel}}' }] }, 'read-protection'],
    ['model never tries', { ...planHost, steps: [] }, 'read-protection'],
  ] as const) {
    const journal = join(root, `gate-${counter++}.jsonl`);
    const directory = await login();
    const { manifest } = await runBatch({ host: 'claude', model: 'fixed-model', entries: selectScenarios(['core-language']), executable: process.execPath,
      executableArgs: [double, await script({ host: 'claude', journal, ...value })], loginDirectory: directory, batchParent: join(root, 'batches') });
    assert.equal(manifest.status, 'aborted', name); assert.equal(manifest.abort?.stage, stage, name);
    assert.deepEqual(manifest.runs, [], `${name}: no scenario started`);
    assert.deepEqual(await readdir(directory), [], `${name}: the sentinel is gone and nothing else was added`);
  }
});

test('one host login directory serves one batch at a time, across processes, through a lock file beside it', async () => {
  const directory = await login();
  const lock = `${directory}.lock`;
  const options = { host: 'claude' as const, model: 'fixed-model', entries: selectScenarios(['core-language']), executable: process.execPath,
    executableArgs: [double, await script({ host: 'claude', ...planHost })], loginDirectory: directory, batchParent: join(root, 'batches') };
  await writeFile(lock, 'held by another batch');
  const busy = await runBatch(options);
  assert.equal(busy.manifest.status, 'aborted'); assert.deepEqual(busy.manifest.abort, { reason: 'login-directory-busy', stage: 'login-lock' });
  assert.deepEqual(busy.manifest.attempts.map((attempt) => Object.keys(attempt)), [['at']], 'no auth preflight or check started');
  assert.equal(await readFile(lock, 'utf8'), 'held by another batch', 'another batch\'s lock is never removed');
  await rm(lock);
  const [first, second] = await Promise.all([runBatch(options), runBatch(options)]);
  assert.deepEqual([first.manifest.status, second.manifest.status].sort(), ['aborted', 'complete'], 'two batches on one login directory: one runs, one is refused');
  assert.equal([first, second].find((item) => item.manifest.status === 'aborted')!.manifest.abort?.reason, 'login-directory-busy');
  await assert.rejects(readFile(lock), /ENOENT/, 'the lock is released when the batch ends');
  assert.deepEqual(await readdir(directory), [], 'the lock never sits inside the login directory');
});

test('an interrupted batch stops after the current host run, releases the lock, and resume runs the interrupted scenario again', async () => {
  const directory = await login();
  const lock = `${directory}.lock`;
  const journal = join(root, `interrupt-${counter++}.jsonl`);
  const options = { host: 'claude' as const, model: 'fixed-model', entries: selectScenarios(['maa-core']), executable: process.execPath,
    executableArgs: [double, await script({ host: 'claude', journal, ...planHost })], loginDirectory: directory, batchParent: join(root, 'batches') };
  const listeners = process.listenerCount('SIGINT');
  const early = await runBatch({ ...options, signal: AbortSignal.abort() });
  assert.deepEqual(early.manifest.abort, { reason: 'interrupted', stage: 'auth-preflight' }); assert.deepEqual(early.manifest.runs, []);
  await assert.rejects(readFile(lock), /ENOENT/);
  // Interrupt while the first scenario's host run is being recorded: the journal holds the preflight, the check and that run.
  const stop = new AbortController();
  const poll = setInterval(async () => { if ((await lines(journal)).length >= 3) stop.abort(); }, 1);
  const first = await runBatch({ ...options, signal: stop.signal }).finally(() => clearInterval(poll));
  assert.equal(first.manifest.status, 'aborted'); assert.equal(first.manifest.abort?.reason, 'interrupted');
  const last = first.manifest.runs.at(-1)!;
  assert.equal(last.reason, 'interrupted'); assert.equal(first.manifest.abort?.scenario, last.scenario);
  await assert.rejects(readFile(lock), /ENOENT/, 'an interrupt releases the lock');
  assert.equal(process.listenerCount('SIGINT'), listeners, 'no signal listener is left behind');
  const resumed = await runBatch({ ...options, resume: first.directory });
  assert.equal(resumed.manifest.status, 'complete');
  assert.equal(resumed.manifest.runs.filter((run) => run.scenario === last.scenario).length, 2, 'the interrupted scenario ran again');
});

test('a quota stop aborts the rest of the batch, resume runs only unfinished scenarios, and a changed fingerprint is refused', async () => {
  const directory = await login();
  const journal = join(root, 'quota.jsonl');
  const entries = selectScenarios(['maa-core']);
  const failing = { host: 'claude', journal, ...planHost, failures: [{ match: coreScenarios[1]!.prompt, failure: 'quota' }] };
  const file = await script(failing);
  const options = { host: 'claude' as const, model: 'fixed-model', entries, executable: process.execPath, executableArgs: [double, file], loginDirectory: directory, batchParent: join(root, 'batches') };
  const first = await runBatch(options);
  assert.equal(first.manifest.status, 'aborted'); assert.deepEqual(first.manifest.abort, { reason: 'quota-exhausted', stage: 'scenario', scenario: coreScenarios[1]!.id });
  assert.deepEqual(first.manifest.runs.map((run) => [run.scenario, run.reason]), [[coreScenarios[0]!.id, 'completed'], [coreScenarios[1]!.id, 'quota-exhausted']]);
  const quota = JSON.parse(await readFile(join(first.directory, first.manifest.runs[1]!.directory, 'run.json'), 'utf8'));
  assert.equal(quota.reason, 'quota-exhausted'); assert.equal(quota.grade.status, 'unverified', 'a quota stop is not a scenario failure');
  await assert.rejects(runBatch({ ...options, model: 'other-model', resume: first.directory }), /fingerprint-mismatch/);
  await writeFile(file, JSON.stringify({ ...failing, failures: [] }));
  const resumed = await runBatch({ ...options, resume: first.directory });
  assert.equal(resumed.manifest.status, 'complete');
  assert.deepEqual(resumed.manifest.runs.map((run) => run.scenario), [coreScenarios[0]!.id, coreScenarios[1]!.id, coreScenarios[1]!.id, coreScenarios[2]!.id]);
  assert.equal(resumed.manifest.attempts.length, 2, 'the resume repeats the auth preflight and read-protection check');
  const scenarioRuns = (await lines(journal)).length;
  assert.equal(scenarioRuns, (1 + 1 + 2) + (1 + 1 + 2), 'each attempt: preflight request, check, then scenarios; the finished first scenario never reran');
  // Nothing the batch writes names the login directory, in any spelling: search every file for its unique segment.
  for (const path of await files(first.directory)) {
    assert.ok(!(await readFile(path, 'utf8')).toLowerCase().includes(marker(directory).toLowerCase()), relative(first.directory, path));
  }
});

test('the tracked compare command reads saved records only and names each scenario conclusion and the scenarios needing three reruns', async () => {
  const batch = async (records: RunRecord[]) => {
    const directory = await mkdtemp(join(root, 'compare-'));
    const runs = [];
    for (const record of records) {
      await mkdir(join(directory, record.id)); await writeFile(join(directory, record.id, 'run.json'), JSON.stringify(record));
      runs.push({ scenario: record.scenario, directory: record.id, id: record.id, reason: record.reason ?? 'completed', grade: record.grade.status, ...(record.rerunOf ? { rerunOf: record.rerunOf } : {}) });
    }
    const rerunOf = Object.fromEntries(records.filter((record) => record.rerunOf).map((record) => [record.scenario, record.rerunOf!]));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ kind: 'maa-skills-evaluation-batch', version: 1, runs, ...(Object.keys(rerunOf).length ? { rerunOf } : {}) }));
    return directory;
  };
  // One payload fingerprint per batch, named by the id's letter (b…, a…, r…).
  const record = (id: string, scenario: string, status: 'pass' | 'fail', extra: Partial<RunRecord> = {}): RunRecord => ({ id, host: 'claude', hostVersion: '2.1.321', model: 'fixed-model',
    scenario, scenarioHash: `hash-${scenario}`, skillVersion: extra.skillVersion ?? 'skill-a', evidenceHash: `evidence-${id}`, grade: { status, score: status === 'pass' ? 8 : 7, total: 8, failed: [] },
    payloadFingerprint: `payload-${id.replace(/\d+$/, '')}`, ...extra });
  const before = await batch([record('b1', 'one', 'pass'), record('b2', 'two', 'pass')]);
  const after = await batch([record('a1', 'one', 'pass', { skillVersion: 'skill-b' }), record('a2', 'two', 'fail', { skillVersion: 'skill-b' })]);
  const snapshot = async (directory: string) => Promise.all((await files(directory)).map(async (path) => createHash('sha256').update(await readFile(path)).digest('hex')));
  const saved = [await snapshot(before), await snapshot(after)];
  const result = await compareBatches(before, after);
  assert.equal(result.overall.status, 'needs-reruns');
  assert.deepEqual(result.scenarios.map((item) => [item.scenario, item.status]), [['one', 'pass'], ['two', 'needs-reruns']]);
  assert.deepEqual(result.rerunScenarios, ['two']);
  const reruns = await batch([1, 2, 3].map((index) => record(`r${index}`, 'two', 'pass', { skillVersion: 'skill-b', rerunOf: 'a2' })));
  const rerun = await compareBatches(before, after, [reruns]);
  assert.equal(rerun.overall.status, 'unstable'); assert.deepEqual(rerun.rerunScenarios, []);
  assert.deepEqual([await snapshot(before), await snapshot(after)], saved, 'comparison never rewrites a record');
  const doubled = await batch([record('d1', 'one', 'pass', { double: true }), record('d2', 'two', 'pass', { double: true })]);
  assert.equal((await compareBatches(before, doubled)).overall.status, 'incomparable', 'double records never enter a comparison');
  // A resumed batch keeps the records of its host-level stops; only the records that count toward completion are compared.
  const stopped = (id: string, scenario: string, reason: string, extra: Partial<RunRecord> = {}) => record(id, scenario, 'pass', { skillVersion: 'skill-b', reason, ...extra, grade: { status: 'unverified', score: 0, total: 8, failed: [] } });
  const resumed = await batch([record('c1', 'one', 'pass', { skillVersion: 'skill-b' }), stopped('c2', 'two', 'quota-exhausted'), stopped('c3', 'two', 'auth-failed'),
    record('c4', 'two', 'pass', { skillVersion: 'skill-b' })]);
  const afterResume = await compareBatches(before, resumed);
  assert.equal(afterResume.overall.status, 'pass', 'a resumed batch compares like an uninterrupted one');
  assert.deepEqual(afterResume.scenarios.map((item) => [item.scenario, item.status]), [['one', 'pass'], ['two', 'pass']]);
  const resumedReruns = await batch([stopped('s0', 'two', 'network-unavailable', { rerunOf: 'a2' }), ...[1, 2, 3].map((index) => record(`s${index}`, 'two', 'pass', { skillVersion: 'skill-b', rerunOf: 'a2' }))]);
  assert.equal((await compareBatches(before, after, [resumedReruns])).overall.status, 'unstable', 'a resumed rerun batch counts its three finished reruns');
});

test('the batch CLI lists scenarios and refuses incomplete arguments; eval-run keeps its positional form', async () => {
  const env = { ...process.env };
  const list = spawnSync(process.execPath, ['scripts/eval-batch.ts', 'list'], { cwd: repository, env, encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  const listed = JSON.parse(list.stdout);
  assert.ok(listed.groups.includes('maa-daily') && listed.scenarios.some((item: { id: string }) => item.id === 'daily-inspect'));
  assert.equal(spawnSync(process.execPath, ['scripts/eval-batch.ts', 'run', 'claude'], { cwd: repository, env, encoding: 'utf8' }).status, 2);
  const single = spawnSync(process.execPath, [join(repository, 'scripts/eval-run.ts'), 'claude', 'fixed-model', 'approved-write', 'maa-synthetic-absent-cli'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(single.status, 1);
  const result = JSON.parse(single.stdout);
  assert.equal(result.status, 'unverified'); assert.equal(result.reason, 'host-unavailable');
  const manifest = await readManifest(join(root, result.batch));
  assert.equal(manifest.abort?.stage, 'auth-preflight');
});

test('every local module the run and the grader load is fingerprinted: runner modules in the scenario hash, product modules in the skill version', async () => {
  // Static imports, followed transitively; the dynamic import of the batch module is only the command-line entry of eval-run.
  const closure = new Set<string>();
  const visit = async (file: string) => {
    if (closure.has(file)) return;
    closure.add(file);
    const text = await readFile(join(repository, file), 'utf8');
    for (const match of text.matchAll(/^\s*(?:import|export)\b[^;]*?\sfrom\s+'(\.{1,2}\/[^']+)'/gm)) {
      await visit(relative(repository, join(repository, file, '..', match[1]!)).replaceAll('\\', '/'));
    }
  };
  await visit('scripts/evaluation.ts'); await visit('scripts/eval-run.ts');
  const hashed = scenarioHashSources.map((file) => relative(repository, join(repository, 'scripts', file)).replaceAll('\\', '/'));
  for (const file of closure) {
    assert.ok(runnerSources.includes(file), `${file} is in the runner fingerprint`);
    const product = file.match(/^skills\/([^/]+)\/(.+)$/);
    if (!product) { assert.ok(hashed.includes(file), `${file} is in the scenario hash`); continue; }
    // A product file never enters the scenario hash: a release changing it must stay comparable. It is part of the installed
    // skill instead, which the skill version (and the payload fingerprint) records.
    assert.ok(!hashed.includes(file), `${file} stays out of the scenario hash`);
    const fixture = await createFixture({ companionSkills: { [product[1]!]: join(repository, 'skills', product[1]!) } });
    try { assert.ok(fixture.original.has(`.agents/skills/${product[1]}/${product[2]}`), `${file} counts toward the skill version`); }
    finally { await fixture.dispose(); }
  }
  assert.ok(closure.has('scripts/eval-transaction.ts'));
  assert.ok(closure.has('skills/maa-core/scripts/preferences.ts'));
});

test('a release that changes only a product script stays comparable: same scenario hash, new skill version', async () => {
  // A copy of the runner and the skills, with one product script changed, against this checkout.
  const copy = await mkdtemp(join(root, 'release-'));
  for (const directory of ['scripts', 'eval', 'skills', 'tests/fixtures']) await cp(join(repository, directory), join(copy, directory), { recursive: true });
  await cp(join(repository, 'package.json'), join(copy, 'package.json'));
  const changed = join(copy, 'skills/maa-core/scripts/preferences.ts');
  await writeFile(changed, `${await readFile(changed, 'utf8')}\n// A product-only change.\n`);
  const records: RunRecord[] = [];
  for (const checkout of [repository, copy]) {
    const { runScenario } = await import(pathToFileURL(join(checkout, 'scripts/eval-run.ts')).href) as typeof import('../scripts/eval-run.ts');
    const { selectScenarios: select } = await import(pathToFileURL(join(checkout, 'scripts/eval-scenarios.ts')).href) as typeof import('../scripts/eval-scenarios.ts');
    const [entry] = select(['core-language']);
    const outcome = await runScenario({ host: 'claude', model: 'fixed-model', scenario: entry!.definition as ScenarioDefinition, executable: process.execPath,
      executableArgs: [join(checkout, 'eval/host-double.mjs'), await script({ host: 'claude', steps: [] })], auth: { mode: 'host-double' }, artifactParent: join(copy, 'runs'),
      ...(entry!.skillDirectory ? { skillDirectory: entry!.skillDirectory } : {}), companionSkills: entry!.companionSkills, payloadFingerprint: `payload-of-${checkout === copy ? 'release' : 'checkout'}` });
    // Compared as real records are: only the double mark and the grade differ from a model run.
    const { double: _double, ...record } = outcome.record;
    records.push({ ...record, grade: { ...record.grade, status: 'pass' } });
  }
  assert.equal(records[0]!.scenarioHash, records[1]!.scenarioHash, 'a product script is not part of the scenario');
  assert.notEqual(records[0]!.skillVersion, records[1]!.skillVersion, 'the skill version records the product change');
  assert.equal(compareRuns([records[0]!], [records[1]!]).status, 'pass');
});
