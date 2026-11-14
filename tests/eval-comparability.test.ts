import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { batchRecords, compareBatches, runBatch } from '../scripts/eval-batch.ts';
import type { ScenarioDefinition } from '../scripts/eval-run.ts';
import { entryId, scenarioCatalog, selectScenarios, type ScenarioEntry } from '../scripts/eval-scenarios.ts';
import { compareRuns, type RunRecord } from '../scripts/evaluation.ts';

// Conformance test for the one comparability owner (scripts/evaluation.ts): what identifies a scenario, and when two record
// sets or batches may be compared. Producers of identity inputs: the one scenarioIdentity call in runScenario, with runner
// sources, harness files, the prompt and every scenario definition (whose whole runtime import closure, eval fixtures and
// network fixtures included, reaches product code only through the allow-list). Consumers: compareRuns (per scenario and
// overall), its baseline branch, compareBatches with the batch conditions (batchIncomparability: only the payload may differ)
// and its scenario subset, the compare command's exit code, rerun batches, resume and the payload
// fingerprint checked during a batch and per side.
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
const repositoryPath = (path: string) => relative(repository, path).replaceAll('\\', '/');

// Harness files a run installs into its workspace under another name (scripts/eval-fixture.ts); an import of the installed
// name inside eval/ is an import of the source here.
const installedHarness: Record<string, string> = { '.eval-node-observer.mjs': 'eval/observe-node.mjs', '.eval-daily-observer.mjs': 'eval/daily-observer.mjs',
  '.eval-maa-process.mjs': 'eval/maa-process.mjs', '.eval-setup-boundary.mjs': 'eval/setup-boundary.mjs', '.eval-network-fixture.mjs': 'eval/network-fixture.mjs' };
type Edge = { from: string; to: string; names: string };
/**
 * Every import that runs: static imports and re-exports that are not `import type` / `export type`, side-effect imports and
 * dynamic imports. An `import { type A }` still loads the module, so it counts. A computed dynamic import cannot be followed.
 */
async function runtimeImports(file: string): Promise<Edge[]> {
  const text = await readFile(join(repository, file), 'utf8');
  const edges: Edge[] = [];
  const add = (specifier: string, names: string) => {
    if (specifier.startsWith('node:')) return;
    const installed = file.startsWith('eval/') ? installedHarness[specifier.replace(/^\.\//, '')] : undefined;
    const to = installed ?? (specifier.startsWith('.') ? repositoryPath(join(repository, dirname(file), specifier)) : `package:${specifier}`);
    edges.push({ from: file, to, names: names.replace(/\s+/g, ' ').trim() });
  };
  // Declarations start a line; the words inside strings (a command named `import`) do not.
  for (const match of text.matchAll(/^\s*import\s+(type\s+)?([^'";()=]*?)\s*from\s*(['"])(.+?)\3/gm)) if (!match[1]) add(match[4]!, match[2]!);
  for (const match of text.matchAll(/^\s*export\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])(.+?)\3/gm)) if (!match[1]) add(match[4]!, match[2]!);
  for (const match of text.matchAll(/^\s*import\s*(['"])(.+?)\1/gm)) add(match[2]!, '(side effect)');
  for (const match of text.matchAll(/\bimport\s*\(\s*(['"])(.+?)\1\s*\)/g)) add(match[2]!, '(dynamic)');
  if (/\bimport\s*\((?!\s*['"])/.test(text)) edges.push({ from: file, to: 'unresolved:computed-dynamic-import', names: '' });
  return edges;
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
  // The version doctor reports moves too (the doctor scenarios name it only by placeholder).
  const packageFile = join(directory, 'skills/maa-core/package.json');
  const manifest = JSON.parse(await readFile(packageFile, 'utf8')) as { version: string };
  await writeFile(packageFile, JSON.stringify({ ...manifest, version: `${manifest.version}-release` }, null, 2));
  // So does the packaged MAA verification record (ticket 25): a newly verified MAA version raises its own version.
  const recordFile = join(directory, 'skills/maa-core/references/verified-versions.json');
  const record = JSON.parse(await readFile(recordFile, 'utf8')) as { recordVersion: number; sourceVerified: string[] };
  await writeFile(recordFile, JSON.stringify({ ...record, recordVersion: record.recordVersion + 1, sourceVerified: [...record.sourceVerified, '6.99.0'] }, null, 2));
  const preferences = join(directory, 'skills/maa-core/scripts/preferences.ts');
  await writeFile(preferences, `${await readFile(preferences, 'utf8')}\n// A product-only change.\n`);
  // A parsing change: the snapshot reader reports another issue code (world data must not follow it).
  const snapshot = join(directory, 'skills/maa-core/scripts/account-snapshot.ts');
  const parser = await readFile(snapshot, 'utf8');
  assert.ok(parser.includes(`'missing-' + field`), 'the issue code the release changes');
  await writeFile(snapshot, parser.replace(`'missing-' + field`, `'absent-' + field`));
  // A research cache key scheme change and a run classifier change (longer finding ids): the cached NGA thread page and the
  // saved run records in world data must not follow them either.
  const research = join(directory, 'skills/maa-core/scripts/research.ts');
  const keys = await readFile(research, 'utf8');
  assert.ok(keys.includes('.update(JSON.stringify(canonical(parts)))'), 'the cache key scheme the release changes');
  await writeFile(research, keys.replace('.update(JSON.stringify(canonical(parts)))', `.update('v2:' + JSON.stringify(canonical(parts)))`));
  const runState = join(directory, 'skills/maa-core/scripts/stage-run-state.ts');
  const classifier = await readFile(runState, 'utf8');
  assert.ok(classifier.includes('${key}`).slice(0, 24)'), 'the finding id the release changes');
  await writeFile(runState, classifier.replace('${key}`).slice(0, 24)', '${key}`).slice(0, 32)'));
  return directory;
})();

test('scenario identity counts every scenario definition, eval fixture and network fixture, and no product file or product-derived value', async () => {
  const { scenarioIdentity } = await import('../scripts/evaluation.ts');
  const identities = (catalog: ScenarioEntry[]) => new Map(catalog.map((entry) => [entryId(entry),
    scenarioIdentity({ prompt: '', runner: {}, harness: {}, definition: entry.definition as ScenarioDefinition })]));
  const here = identities(scenarioCatalog());
  // Which product values can reach a scenario definition at all is decided by the import closure test below.
  // A product-only release keeps every scenario, although its network fixture URLs now name other commits and the snapshot
  // parser now reports another issue code.
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
  changed('account-report-approve-one', (definition) => { definition.policy.approvals = [['S2']]; });
  // The fixed distance of a tool-written expiry from the execution window (ticket 19's `offsetMs`) is grading too.
  changed('account-skland-community-read', (definition) => {
    const expiry = definition.policy.generatedUtcFields.find((field: { key: string }) => field.key === 'expiresAt');
    assert.equal(expiry.offsetMs, 86_400_000); expiry.offsetMs = 2 * 86_400_000;
  });
});

test('scenario world data runs no product code: the runtime import closure of every scenario module reaches the product only through the allow-list', async () => {
  // Roots: the scenario catalog and every module under eval/. The walk follows every runtime import into tests/fixtures,
  // scripts or anywhere else, and stops at product code (skills/), where each edge must be on the allow-list.
  const roots = ['scripts/eval-scenarios.ts', ...(await files(join(repository, 'eval'))).filter((path) => /\.(?:ts|mjs)$/.test(path)).map(repositoryPath)];
  const closure = new Set<string>(); const product: string[] = []; const unresolved: string[] = [];
  const visit = async (file: string) => {
    if (closure.has(file)) return;
    closure.add(file);
    for (const edge of await runtimeImports(file)) {
      const line = `${edge.from} -> ${edge.to} ${edge.names}`;
      if (edge.to.startsWith('skills/')) product.push(line);
      else if (edge.to.includes(':') || !(await readFile(join(repository, edge.to)).then(() => true, () => false))) unresolved.push(line);
      else await visit(edge.to);
    }
  };
  for (const file of roots) await visit(file);
  assert.deepEqual(unresolved, [], 'every runtime import resolves to a file in this repository');
  // The allow-list: product values that may reach world data, each normalised out of scenario identity. Today only the
  // public data source descriptors, used for network fixture URLs, whose pinned data commit scenarioIdentity drops.
  const allowedProductImports: Record<string, string> = {
    'eval/maa-account/cost-scenarios.ts -> skills/maa-core/scripts/operator-cost.ts { operatorCostSources }': 'network fixture URLs; pinned data commit normalised out',
    'eval/maa-account/gap-scenarios.ts -> skills/maa-core/scripts/operator-cost.ts { operatorCostSources }': 'network fixture URLs; pinned data commit normalised out',
    'eval/maa-account/gap-scenarios.ts -> skills/maa-core/scripts/cultivation-gaps.ts { craftingSources }': 'network fixture URLs; pinned data commit normalised out',
    'tests/fixtures/report-data.ts -> skills/maa-core/scripts/operator-cost.ts { operatorCostSources }': 'network fixture URLs; pinned data commit normalised out',
    'tests/fixtures/report-data.ts -> skills/maa-core/scripts/cultivation-gaps.ts { craftingSources }': 'network fixture URLs; pinned data commit normalised out',
    'tests/fixtures/base-plan-data.ts -> skills/maa-core/scripts/base-plan.ts { planTableSources }': 'network fixture URLs; pinned data commit normalised out',
  };
  assert.deepEqual([...new Set(product)].sort(), Object.keys(allowedProductImports).sort(), 'only allow-listed product values reach scenario world data');
  // A module of the closure can also read a product file without importing it (the doctor scenarios once read maa-core's
  // package.json version): every relative path literal into skills/ outside an import line is listed, and only the catalog's
  // skill directories (what a run installs; product files then count toward the skill version) may appear.
  const productPaths: string[] = [];
  for (const file of closure) {
    for (const line of (await readFile(join(repository, file), 'utf8')).split(/\r?\n/)) {
      // Module declarations (`import … from`, `export … from`, a side-effect import) are the import edges above.
      if (/^\s*(?:(?:import|export)\b[^'"`]*?\bfrom|import|\}\s*from)\s*['"]/.test(line)) continue;
      for (const match of line.matchAll(/(['"`])((?:\.\.\/)+skills\/[^'"`]*)\1/g)) productPaths.push(`${file} -> ${match[2]}`);
    }
  }
  assert.deepEqual(productPaths, ['scripts/eval-scenarios.ts -> ../skills/${name}'], 'world data reads no product file');
  // Every producer of a scenario definition (prompt, policy, eval fixtures, network fixtures): a new module in the closure
  // must be looked at and added here.
  // tests/fixtures/stage-run-records.ts, stage-alternate-records.ts and base-apply-worlds.ts hold the run records, switch ledger
  // and saved base reports of tickets 16, 17 and 23 as literals; the fixtures that run product code to make such data
  // (stage-run-data.ts, base-apply-data.ts) serve only the product's own tests and stay out of this closure.
  assert.deepEqual([...closure].sort(), ['eval/base-plan-observer.ts', 'eval/cross-skill/scenarios.ts', 'eval/daily-observer.mjs', 'eval/host-double.mjs',
    'eval/maa-account/base-report-scenarios.ts', 'eval/maa-account/base-scenarios.ts', 'eval/maa-account/community-scenarios.ts', 'eval/maa-account/cost-scenarios.ts',
    'eval/maa-account/gap-scenarios.ts', 'eval/maa-account/report-scenarios.ts', 'eval/maa-account/research-scenarios.ts', 'eval/maa-account/scenarios.ts', 'eval/maa-account/skland-scenarios.ts',
    'eval/maa-core/scenarios.ts', 'eval/maa-daily/base-apply-scenarios.ts', 'eval/maa-daily/scenarios.ts', 'eval/maa-daily/stage-alternate-scenarios.ts',
    'eval/maa-daily/stage-run-scenarios.ts', 'eval/maa-daily/stage-scenarios.ts', 'eval/maa-daily/training-scenarios.ts', 'eval/maa-doctor/scenarios.ts',
    'eval/maa-help/scenarios.ts', 'eval/maa-process.mjs', 'eval/maa-setup/scenarios.ts', 'eval/network-fixture.mjs', 'eval/observe-node.mjs', 'eval/probe.ts',
    'eval/report-observer.ts', 'eval/rule-samples.ts', 'eval/setup-boundary.mjs', 'scripts/eval-scenarios.ts', 'tests/fixtures/base-apply-worlds.ts',
    'tests/fixtures/base-plan-data.ts', 'tests/fixtures/cost-data.ts', 'tests/fixtures/gap-data.ts', 'tests/fixtures/report-data.ts', 'tests/fixtures/stage-alternate-records.ts',
    'tests/fixtures/stage-data.ts', 'tests/fixtures/stage-run-records.ts', 'tests/fixtures/training-data.ts', 'tests/fixtures/training-runtime.ts']);
  // The allow-listed values reach identity only as network fixture URLs, and only their pinned commit may vary: repository
  // and file stay part of the scenario (which URL serves which table), so a product change there fails here first.
  const sources = new Set(scenarioCatalog().flatMap((entry) => Object.keys((entry.definition as ScenarioDefinition).networkFixtures ?? {}))
    .map((url) => url.replace(/^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)[0-9a-f]{40}\//, '$1<commit>/')));
  const main = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/<commit>/zh_CN/gamedata/excel/';
  const cross = 'https://raw.githubusercontent.com/arkntools/arknights-toolbox-data/<commit>/assets/data/';
  assert.deepEqual([...sources].sort(), [...['building_data', 'char_meta_table', 'char_patch_table', 'character_table', 'gamedata_const', 'item_table', 'stage_table', 'uniequip_table']
    .map((name) => `${main}${name}.json`), `${cross}cultivate.json`, `${cross}level.json`]);
});

test('every producer of a scenario identity input and every consumer of the scenario hash is listed', async () => {
  const code = (await Promise.all(['scripts', 'eval', 'skills'].map((directory) => files(join(repository, directory))))).flat()
    .filter((path) => /\.(?:ts|mjs)$/.test(path)).map(repositoryPath).sort();
  const uses = async (pattern: RegExp) => {
    const result: Record<string, number> = {};
    for (const file of code) { const count = [...(await readFile(join(repository, file), 'utf8')).matchAll(pattern)].length; if (count) result[file] = count; }
    return result;
  };
  // Producer: one call computes a scenario hash (scripts/eval-run.ts); the other match is the definition in the owner.
  assert.deepEqual(await uses(/\bscenarioIdentity\(/g), { 'scripts/eval-run.ts': 1, 'scripts/evaluation.ts': 1 });
  // Its four inputs. prompt and definition: the scenario catalog, whose runtime closure the test above enumerates.
  // runner: scenarioHashSources, checked against the runner's import closure in tests/eval-batch.test.ts.
  // harness: exactly the files scripts/eval-fixture.ts installs.
  const run = await import('../scripts/eval-run.ts') as Record<string, unknown>;
  const installed = [...new Set((await readFile(join(repository, 'scripts/eval-fixture.ts'), 'utf8')).match(/\.eval-[a-z-]+\.mjs/g))].sort();
  assert.deepEqual([...(run.scenarioHarnessFiles as string[] | undefined) ?? []].sort(), installed, 'the scenario hash counts every installed harness file');
  assert.deepEqual(Object.keys(installedHarness).sort(), installed, 'the closure walk knows every installed harness name');
  // Consumers. scenarioHash: written once (eval-run), read only by the owner (RunRecord field, sameScenario twice, the
  // completeness check). The verdict: compareRuns is defined in the owner and called only by compareBatches (per scenario
  // and overall), which only the compare command calls; its exit code comes from that verdict.
  assert.deepEqual(await uses(/\bscenarioHash\b/g), { 'scripts/eval-run.ts': 1, 'scripts/evaluation.ts': 4 });
  assert.deepEqual(await uses(/\bcompareRuns\(/g), { 'scripts/eval-batch.ts': 2, 'scripts/evaluation.ts': 1 });
  assert.deepEqual(await uses(/\bcompareBatches\(/g), { 'scripts/eval-batch.ts': 2 });
  // The batch conditions (everything but the payload must be equal): defined in the owner, read only by compareBatches.
  assert.deepEqual(await uses(/\bbatchIncomparability\(/g), { 'scripts/eval-batch.ts': 1, 'scripts/evaluation.ts': 1 });
  // The payload fingerprint: computed in the batch (definition, batch start, the check before and after each run, handed to
  // the run), written into the record by the runner (option and record field), read only by the owner (RunRecord field,
  // one per side, required).
  assert.deepEqual(await uses(/\bpayloadFingerprint\b/g), { 'scripts/eval-batch.ts': 4, 'scripts/eval-run.ts': 4, 'scripts/evaluation.ts': 3 });
});

test('the runner records the same scenario for repeated runs and across a product-only release, and a new skill version', async () => {
  // Each side is one batch: one payload fingerprint for all its runs.
  const run = async (checkout: string, id: string, payloadFingerprint: string) => {
    const { runScenario } = await import(pathToFileURL(join(checkout, 'scripts/eval-run.ts')).href) as typeof import('../scripts/eval-run.ts');
    const { selectScenarios: select } = await import(pathToFileURL(join(checkout, 'scripts/eval-scenarios.ts')).href) as typeof import('../scripts/eval-scenarios.ts');
    const [entry] = select([id]);
    const outcome = await runScenario({ host: 'claude', model: 'fixed-model', scenario: entry!.definition as ScenarioDefinition, executable: process.execPath,
      executableArgs: [join(checkout, 'eval/host-double.mjs'), await script({ host: 'claude', steps: [] })], auth: { mode: 'host-double' }, artifactParent: join(root, 'runs'),
      ...(entry!.skillDirectory ? { skillDirectory: entry!.skillDirectory } : {}), companionSkills: entry!.companionSkills, payloadFingerprint });
    // Compared as real records are: only the double mark and the grade differ from a model run.
    const { double: _double, ...record } = outcome.record;
    return { ...record, grade: { ...record.grade, status: 'pass' as const } };
  };
  const copy = await productRelease();
  // core-language: maa-core alone; account-cost-raw: maa-account with network fixtures; setup-connection-write: a policy path
  // rendered into the run's own workspace; daily-stage-exact-scope: a saved account snapshot in its world data.
  const ids = ['core-language', 'account-cost-raw', 'setup-connection-write', 'daily-stage-exact-scope'];
  const before: RunRecord[] = []; const again: RunRecord[] = []; const after: RunRecord[] = [];
  for (const id of ids) { before.push(await run(repository, id, 'payload-before')); again.push(await run(repository, id, 'payload-again')); after.push(await run(copy, id, 'payload-after')); }
  const problems = ids.flatMap((id, index) => [
    ...(again[index]!.scenarioHash !== before[index]!.scenarioHash ? [`${id}: a repeated run is another scenario`] : []),
    ...(after[index]!.scenarioHash !== before[index]!.scenarioHash ? [`${id}: a product-only release is another scenario`] : []),
    ...(after[index]!.skillVersion === before[index]!.skillVersion ? [`${id}: the skill version misses the release`] : [])]);
  assert.deepEqual(problems, []);
  assert.equal(new Set(before.map((record) => record.skillVersion)).size, ids.length, 'each group installs its own skill set');
  assert.equal(compareRuns(before, again).status, 'pass', 'identical multi-group runs');
  assert.equal(compareRuns(before, after).status, 'pass', 'a product-only release');
});

test('every consumer compares per scenario: multi-group batches, baseline, batch comparison, exit code and rerun batches', async () => {
  // Each batch has one payload fingerprint, named here by the id prefix (before-…, same-…, rerun-…).
  const record = (id: string, scenario: string, extra: Partial<RunRecord> = {}): RunRecord => ({ id, host: 'claude', hostVersion: '2.1.321', model: 'fixed-model',
    scenario, scenarioHash: `hash-${scenario}`, skillVersion: `skills-of-${scenario}`, evidenceHash: `evidence-${id}`, grade: { status: 'pass', score: 8, total: 8, failed: [] },
    payloadFingerprint: `payload-${id.replace(/-.*/, '')}`, ...extra });
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
    // Every batch here runs under the same conditions and names a payload; batch-level differences are tests/eval-payload.test.ts's.
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ kind: 'maa-skills-evaluation-batch', version: 1, host: 'claude', double: records.some((value) => value.double === true),
      fingerprint: { hostVersion: '2.1.321', model: 'fixed-model', auth: 'plan', runner: 'fixed-runner', payload: records[0]?.payloadFingerprint },
      payload: { source: 'commit', commit: '0'.repeat(40), tree: '0'.repeat(40), trees: {}, digest: 'fixed-payload' }, runs, ...(Object.keys(rerunOf).length ? { rerunOf } : {}) }));
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
  // Records of two candidates in one batch (however they got there): every scenario alone passes, the batch does not.
  const mixedBatch = await batch(suite('mixed', { 'account-cost-raw': { skillVersion: 'skills-v2', payloadFingerprint: 'payload-v2' } }));
  const mixed = await compareBatches(beforeBatch, mixedBatch);
  assert.deepEqual(statuses(mixed), [...scenarios].sort().map((scenario) => [scenario, 'pass']));
  assert.equal(mixed.overall.status, 'incomparable');
  assert.equal(exitCode(beforeBatch, mixedBatch), 1);
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

test('a skill change in the middle of a batch stops it: the run it overlapped does not count and the batch never completes on two candidates', async () => {
  const skill = join(root, 'mid-batch', 'maa-core');
  await cp(join(repository, 'skills/maa-core'), skill, { recursive: true });
  const file = join(skill, 'SKILL.md'); const original = await readFile(file, 'utf8');
  // While the first scenario's host run is going, someone edits the skill under test (once).
  const edit = "const fs = require('fs'); const [file, marker] = process.argv.slice(1); if (!fs.existsSync(marker)) { fs.writeFileSync(marker, ''); fs.appendFileSync(file, ' <!-- v2 -->'); }";
  const entries = selectScenarios(['core-language', 'core-append']).map((entry) => ({ ...entry, skillDirectory: skill }));
  const options = { host: 'claude' as const, model: 'fixed-model', entries, auth: 'host-double' as const, executable: process.execPath,
    executableArgs: [double, await script({ host: 'claude', steps: [{ shell: ['node', '-e', edit, file, join(root, 'mid-batch', 'edited')] }] })], batchParent: join(root, 'mid-batch-runs') };
  const first = await runBatch(options);
  assert.equal(first.manifest.status, 'aborted');
  assert.deepEqual(first.manifest.abort, { reason: 'fingerprint-mismatch', stage: 'scenario', scenario: 'core-language' });
  assert.deepEqual(first.manifest.runs.map((run) => [run.scenario, run.reason]), [['core-language', 'fingerprint-mismatch']], 'the second scenario never starts');
  assert.deepEqual(await batchRecords(first.directory), [], 'nothing from the changed batch is compared');
  await assert.rejects(runBatch({ ...options, resume: first.directory }), /fingerprint-mismatch/, 'the changed payload cannot resume it');
  // Back to the batch's own payload, resume runs both scenarios, and every record names that payload.
  await writeFile(file, original);
  const resumed = await runBatch({ ...options, resume: first.directory });
  assert.equal(resumed.manifest.status, 'complete');
  assert.deepEqual(resumed.manifest.runs.map((run) => [run.scenario, run.reason]), [['core-language', 'fingerprint-mismatch'], ['core-language', 'completed'], ['core-append', 'completed']]);
  const records = await batchRecords(first.directory);
  assert.deepEqual(records.map((record) => [record.scenario, record.payloadFingerprint]), [['core-language', resumed.manifest.fingerprint.payload], ['core-append', resumed.manifest.fingerprint.payload]]);
});
