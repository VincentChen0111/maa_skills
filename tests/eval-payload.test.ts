import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchRecords, compareBatches, runBatch, runnerFingerprint } from '../scripts/eval-batch.ts';
import { materializePayload, payloadDigest, payloadRecordName } from '../scripts/eval-payload.ts';
import { entryId, scenarioCatalog, selectScenarios } from '../scripts/eval-scenarios.ts';
import type { RunRecord } from '../scripts/evaluation.ts';

// A payload is the product (skills/ and .claude-plugin/) of another commit, run under this checkout's framework. Every test
// runs against a synthetic home, settings file and private directory, and a throwaway Git repository; no model is called.
const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const double = join(repository, 'eval/host-double.mjs');
const root = await mkdtemp(join(tmpdir(), 'maa-payload-test-'));
const home = join(root, 'home'); const settings = join(root, 'settings'); const privateDirectory = join(root, 'private');
await mkdir(home); await mkdir(settings);
await writeFile(join(settings, 'config.json'), JSON.stringify({ privateDirectory }));
Object.assign(process.env, { USERPROFILE: home, HOME: home, MAA_SKILLS_HOME: settings });
delete process.env.MAA_EVAL_CLAUDE_LOGIN_DIR; delete process.env.MAA_EVAL_CODEX_LOGIN_DIR;
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
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', '-c', 'user.name=payload-test', '-c', 'user.email=payload-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [join(cwd, 'scripts/eval-batch.ts'), ...args], { cwd, encoding: 'utf8', windowsHide: true });

// A copy of the framework in its own Git repository with two commits. The older one is an "old payload": it lacks maa-setup and
// base-plan.ts, pins another commit for one public data source, and marks maa-core's SKILL.md and its own copies of the three
// shared modules the graders and the runner fingerprint read (those stay the checkout's). The newer one is this checkout.
const marker = `PayloadMarker${Math.random().toString(36).slice(2, 8)}`;
const crossCommit = 'a07b4255b43a7171e519b26a13ddb12668a2cf0a';
const copy = join(root, 'framework');
for (const item of ['scripts', 'eval', 'skills', 'tests/fixtures', '.claude-plugin']) await cp(join(repository, item), join(copy, item), { recursive: true });
await cp(join(repository, 'package.json'), join(copy, 'package.json'));
git(copy, 'init', '--quiet');
const cost = join(copy, 'skills/maa-core/scripts/operator-cost.ts'); const costText = await readFile(cost, 'utf8');
const plan = join(copy, 'skills/maa-core/scripts/base-plan.ts'); const planText = await readFile(plan, 'utf8');
const coreSkill = join(copy, 'skills/maa-core/SKILL.md'); const coreSkillText = await readFile(coreSkill, 'utf8');
assert.ok(costText.includes(crossCommit), 'operator-cost.ts pins the cross data commit');
await writeFile(cost, costText.replaceAll(crossCommit, '2'.repeat(40)));
await rm(plan); await rm(join(copy, 'skills/maa-setup'), { recursive: true });
await writeFile(coreSkill, `${coreSkillText}\n${marker}\n`);
const sharedModules = await Promise.all(['preferences.ts', 'consumption-grant.ts', 'config-projection.ts'].map(async (name) => {
  const path = join(copy, 'skills/maa-core/scripts', name); return { path, text: await readFile(path, 'utf8') };
}));
for (const { path, text } of sharedModules) await writeFile(path, `${text}\n// ${marker}\n`);
git(copy, 'add', '-A'); git(copy, 'commit', '--quiet', '-m', 'old payload');
const oldCommit = git(copy, 'rev-parse', 'HEAD');
await writeFile(cost, costText); await writeFile(plan, planText); await writeFile(coreSkill, coreSkillText);
for (const { path, text } of sharedModules) await writeFile(path, text);
await cp(join(repository, 'skills/maa-setup'), join(copy, 'skills/maa-setup'), { recursive: true });
git(copy, 'add', '-A'); git(copy, 'commit', '--quiet', '-m', 'new payload');
const newCommit = git(copy, 'rev-parse', 'HEAD');

// The payload directory carries its own marker, so a leak is found in any spelling; the skill marker is meant to be read.
const directoryMarker = `PayloadDir${Math.random().toString(36).slice(2, 8)}`;
const oldPayload = join(root, directoryMarker, 'old');
const newPayload = join(root, 'new');

test('payload materializes only the payload paths of a commit, read-only, into a new empty directory outside the repository, with commit, tree and digest', async () => {
  const status = git(copy, 'status', '--porcelain');
  const made = cli(copy, 'payload', '--commit', oldCommit, '--out', oldPayload);
  assert.equal(made.status, 0, made.stderr);
  const printed = JSON.parse(made.stdout);
  assert.deepEqual({ source: printed.source, commit: printed.commit, tree: printed.tree, skills: printed.trees.skills, plugin: printed.trees['.claude-plugin'] },
    { source: 'commit', commit: oldCommit, tree: git(copy, 'rev-parse', `${oldCommit}^{tree}`), skills: git(copy, 'rev-parse', `${oldCommit}:skills`),
      plugin: git(copy, 'rev-parse', `${oldCommit}:.claude-plugin`) });
  assert.match(printed.digest, /^[0-9a-f]{64}$/);
  assert.ok(!made.stdout.includes(directoryMarker), 'the output never names the directory');
  // Only skills/ and .claude-plugin/, each file exactly the committed blob, plus the record.
  assert.deepEqual((await readdir(oldPayload)).sort(), ['.claude-plugin', payloadRecordName, 'skills'].sort());
  const written = (await files(oldPayload)).map((path) => relative(oldPayload, path).replaceAll('\\', '/')).filter((path) => path !== payloadRecordName).sort();
  assert.deepEqual(written, git(copy, 'ls-tree', '-r', '--name-only', oldCommit, '--', 'skills', '.claude-plugin').split('\n').sort());
  assert.ok(!written.includes('skills/maa-core/scripts/base-plan.ts') && !written.some((path) => path.startsWith('skills/maa-setup/')));
  const blob = spawnSync('git', ['-C', copy, 'cat-file', 'blob', `${oldCommit}:skills/maa-core/SKILL.md`], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).stdout;
  assert.deepEqual(await readFile(join(oldPayload, 'skills/maa-core/SKILL.md')), blob);
  assert.deepEqual(JSON.parse(await readFile(join(oldPayload, payloadRecordName), 'utf8')), { kind: 'maa-skills-payload', version: 1, ...printed });
  assert.equal(await payloadDigest(oldPayload), printed.digest);
  assert.equal(git(copy, 'status', '--porcelain'), status, 'the repository is only read');
  assert.equal(git(copy, 'rev-parse', 'HEAD'), newCommit);
  // The exported function makes the same payload from the same commit.
  const again = await materializePayload({ repository: copy, commit: oldCommit, out: join(root, 'old-again') });
  assert.deepEqual(again, printed);

  // A directory that is not new and empty, or that overlaps the repository, the private, settings, daily host or login
  // directories, is refused before anything is written.
  const refused = async (out: string, code: string, env: NodeJS.ProcessEnv = {}, commit = oldCommit) => {
    const existed = existsSync(out);
    const result = spawnSync(process.execPath, [join(copy, 'scripts/eval-batch.ts'), 'payload', '--commit', commit, '--out', out],
      { cwd: copy, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
    assert.equal(result.status, 1, `${code}: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(`Evaluation batch did not complete: ${code}\\s*$`), code);
    if (!existed) assert.ok(!existsSync(out), `${code}: nothing created`);
  };
  await refused(oldPayload, 'payload-directory-not-empty');
  await refused(join(copy, 'payload'), 'payload-directory-refused:inside-repository');
  await refused(join(privateDirectory, 'payload'), 'payload-directory-refused:overlaps-private-directory');
  await refused(join(settings, 'payload'), 'payload-directory-refused:overlaps-settings-directory');
  await refused(join(home, '.codex', 'payload'), 'payload-directory-refused:daily-host-directory');
  await refused(join(home, '.maa-skills-eval', 'codex-home', 'payload'), 'payload-directory-refused:overlaps-login-directory');
  await refused(join(root, 'claude-login', 'payload'), 'payload-directory-refused:overlaps-login-directory', { MAA_EVAL_CLAUDE_LOGIN_DIR: join(root, 'claude-login') });
  await refused(join(root, 'unknown'), 'payload-commit-unknown', {}, 'no-such-revision');
  const unknown = spawnSync(process.execPath, [join(copy, 'scripts/eval-batch.ts'), 'payload', '--commit', '--output=x', '--out', join(root, 'option')], { cwd: copy, encoding: 'utf8', windowsHide: true });
  assert.equal(unknown.status, 1); assert.ok(!existsSync(join(root, 'option')) && !existsSync(join(copy, 'x')), 'a revision is never read as an option');
  assert.equal(git(copy, 'status', '--porcelain'), status);

  const fresh = cli(copy, 'payload', '--commit', 'HEAD', '--out', newPayload);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).commit, newCommit);
});

test('list --payload names, with a static code, every scenario the payload cannot serve', async () => {
  const list = (...args: string[]) => { const result = cli(repository, 'list', ...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const checkout = list();
  assert.ok(checkout.scenarios.every((item: { refused?: unknown }) => !item.refused), 'the checkout serves every scenario');
  const old = list('--payload', oldPayload);
  assert.deepEqual(old.scenarios.map((item: { id: string }) => item.id), checkout.scenarios.map((item: { id: string }) => item.id), 'the scenarios are the checkout\'s');
  assert.deepEqual({ source: old.payload.source, commit: old.payload.commit }, { source: 'commit', commit: oldCommit });
  const refusal = (id: string) => old.scenarios.find((item: { id: string }) => item.id === id)?.refused;
  for (const entry of scenarioCatalog()) {
    const id = entryId(entry);
    const definition = entry.definition as { commands?: string[]; policy?: { expectedCalls?: string[] }; networkFixtures?: Record<string, unknown> };
    const installs = [entry.skillDirectory, ...Object.values(entry.companionSkills)].filter(Boolean).map((path) => path!.split(/[\\/]/).at(-1));
    const expected = installs.includes('maa-setup') ? { code: 'payload-skill-missing', detail: 'maa-setup' }
      : [...definition.commands ?? [], ...definition.policy?.expectedCalls ?? []].some((command) => command.includes('base-plan.ts')) ? { code: 'payload-script-missing', detail: 'base-plan.ts' }
      : Object.keys(definition.networkFixtures ?? {}).some((url) => url.includes(crossCommit)) ? { code: 'payload-data-commit-missing', detail: crossCommit } : undefined;
    assert.deepEqual(refusal(id), expected, id);
  }
  assert.ok(refusal('setup-inspect-existing') && refusal('base-report-default-review') && refusal('account-cost-raw') && !refusal('core-language'));
  assert.ok(list('--payload', newPayload).scenarios.every((item: { refused?: unknown }) => !item.refused), 'the newer payload serves every scenario');
});

test('a batch on a payload installs the payload\'s skills, refuses what it cannot serve before any host call, and never counts it', async () => {
  const count = join(root, 'host-calls.txt');
  const counterScript = join(root, 'counter.mjs');
  await writeFile(counterScript, "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[2], 'call\\n');\n");
  const noHost = { host: 'claude' as const, model: 'fixed-model', auth: 'host-double' as const, executable: process.execPath, executableArgs: [counterScript, count], batchParent: join(root, 'batches') };
  // Nothing servable, an edited payload, a payload overlapping the login directory, or entries from elsewhere: refused at once.
  await assert.rejects(runBatch({ ...noHost, payload: oldPayload, entries: selectScenarios(['setup-inspect-existing'], oldPayload) }), /^Error: no-servable-scenario$/);
  await assert.rejects(runBatch({ ...noHost, payload: oldPayload, entries: selectScenarios(['core-language']) }), /^Error: payload-entry-outside$/);
  await assert.rejects(runBatch({ ...noHost, auth: 'plan', loginDirectory: join(oldPayload, 'login'), payload: oldPayload, entries: selectScenarios(['core-language'], oldPayload) }),
    /^Error: payload-directory-refused:overlaps-login-directory$/);
  const edited = join(root, 'edited');
  await cp(oldPayload, edited, { recursive: true });
  await appendFile(join(edited, 'skills/maa-core/SKILL.md'), 'edited after it was made\n');
  await assert.rejects(runBatch({ ...noHost, payload: edited, entries: selectScenarios(['core-language'], edited) }), /^Error: payload-digest-mismatch$/);
  await rm(join(edited, payloadRecordName));
  await assert.rejects(runBatch({ ...noHost, payload: edited, entries: selectScenarios(['core-language'], edited) }), /^Error: payload-record-missing$/);
  assert.ok(!existsSync(count), 'no host was started');

  const journal = join(root, 'payload-runs.jsonl');
  const ids = ['setup-inspect-existing', 'core-language', 'base-report-default-review'];
  const options = { host: 'claude' as const, model: 'fixed-model', auth: 'host-double' as const, executable: process.execPath, batchParent: join(root, 'batches'), payload: oldPayload,
    executableArgs: [double, await script({ host: 'claude', journal, noise: [oldPayload], steps: [{ fileRead: '.claude/skills/subject/SKILL.md' }] })] };
  const { directory, manifest } = await runBatch({ ...options, entries: selectScenarios(ids, oldPayload) });
  assert.equal(manifest.status, 'complete');
  assert.deepEqual(manifest.scenarios, ['core-language']);
  assert.deepEqual(manifest.refused, [{ scenario: 'setup-inspect-existing', code: 'payload-skill-missing', detail: 'maa-setup' },
    { scenario: 'base-report-default-review', code: 'payload-script-missing', detail: 'base-plan.ts' }]);
  assert.deepEqual(manifest.runs.map((run) => run.scenario), ['core-language']);
  // The payload's own preferences.ts, consumption-grant.ts and config-projection.ts differ; the runner fingerprint is still the checkout's.
  assert.equal(manifest.fingerprint.runner, await runnerFingerprint(), 'the runner fingerprint never reads the payload');
  assert.equal((await readFile(journal, 'utf8')).trim().split('\n').length, 1, 'the host ran once, for the one servable scenario');
  assert.deepEqual((await batchRecords(directory)).map((record) => record.scenario), ['core-language'], 'a refused scenario is neither pass nor fail');
  const made = JSON.parse(await readFile(join(oldPayload, payloadRecordName), 'utf8'));
  assert.deepEqual(manifest.payload, { source: 'commit', commit: made.commit, tree: made.tree, trees: made.trees, digest: made.digest });
  // The host read the payload's skill, not the checkout's; the payload directory reaches no artifact.
  const run = join(directory, manifest.runs[0]!.directory);
  assert.ok((await readFile(join(run, 'host.jsonl'), 'utf8')).includes(marker), 'the installed skill is the payload\'s');
  for (const file of await files(directory)) {
    const text = await readFile(file, 'utf8');
    assert.ok(!text.toLowerCase().includes(directoryMarker.toLowerCase()), `${relative(directory, file)} names the payload directory`);
  }
  assert.ok((await readFile(join(run, 'run.json'), 'utf8')).length && (await readFile(join(run, 'stderr.txt'), 'utf8')).includes('<payload>'), 'the payload path reached the run and was replaced');
  // Resume needs the same payload.
  await assert.rejects(runBatch({ ...options, payload: newPayload, entries: selectScenarios(['core-language'], newPayload), resume: directory }), /fingerprint-mismatch/);
  assert.equal((await runBatch({ ...options, entries: selectScenarios(['core-language'], oldPayload), resume: directory })).manifest.status, 'complete');
});

test('compare lets only the payload differ, names each other difference with a static reason, and compares a scenario subset with per-scenario pass to fail', async () => {
  const fingerprint = { hostVersion: '2.1.321', model: 'fixed-model', auth: 'plan', runner: 'runner-1' };
  const record = (id: string, scenario: string, status: 'pass' | 'fail', extra: Partial<RunRecord> = {}): RunRecord => ({ id, host: 'codex', hostVersion: '2.1.321', model: 'fixed-model',
    scenario, scenarioHash: `hash-${scenario}`, skillVersion: `skill-${id[0]}`, evidenceHash: `evidence-${id}`, grade: { status, score: status === 'pass' ? 8 : 7, total: 8, failed: [] },
    payloadFingerprint: `fingerprint-${id[0]}`, reason: 'completed', ...extra });
  const batch = async (records: RunRecord[], change: Record<string, unknown> = {}) => {
    const directory = await mkdtemp(join(root, 'compare-'));
    const runs = [];
    for (const item of records) {
      await mkdir(join(directory, item.id)); await writeFile(join(directory, item.id, 'run.json'), JSON.stringify(item));
      runs.push({ scenario: item.scenario, directory: item.id, id: item.id, reason: 'completed', grade: item.grade.status, ...(item.rerunOf ? { rerunOf: item.rerunOf } : {}) });
    }
    const rerunOf = Object.fromEntries(records.filter((item) => item.rerunOf).map((item) => [item.scenario, item.rerunOf!]));
    const letter = records[0]!.id[0];
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ kind: 'maa-skills-evaluation-batch', version: 1, id: `batch-${letter}`, host: 'codex', model: 'fixed-model',
      auth: 'plan', double: false, fingerprint: { ...fingerprint, payload: `fingerprint-${letter}` }, payload: { source: 'commit', commit: letter!.repeat(40), digest: `digest-${letter}` },
      scenarios: [...new Set(records.map((item) => item.scenario))], refused: [], ...(Object.keys(rerunOf).length ? { rerunOf } : {}), attempts: [], runs, status: 'complete', ...change }));
    return directory;
  };
  const before = await batch([record('b1', 'core-language', 'pass'), record('b2', 'core-append', 'pass')],
    { refused: [{ scenario: 'base-report-default-review', code: 'payload-script-missing', detail: 'base-plan.ts' }] });
  const after = await batch([record('a1', 'core-language', 'pass'), record('a2', 'core-append', 'fail'), record('a3', 'base-report-default-review', 'pass')]);
  // Without a subset the scenario sets differ; with one, the payload is the only difference and each scenario is judged.
  const whole = await compareBatches(before, after);
  assert.equal(whole.overall.status, 'incomparable'); assert.ok(whole.overall.reasons.includes('scenario-sets-differ'), JSON.stringify(whole.overall.reasons));
  const subset = await compareBatches(before, after, [], { scenarios: ['core-language', 'core-append'] });
  assert.deepEqual(subset.overall, { status: 'needs-reruns', rerun: ['a2'], reasons: [] });
  assert.deepEqual(subset.scenarios.map((item) => [item.scenario, item.before, item.after, item.status]), [['core-append', 'pass', 'fail', 'needs-reruns'], ['core-language', 'pass', 'pass', 'pass']]);
  assert.deepEqual(subset.passToFail, ['core-append']);
  assert.deepEqual([subset.payload.before, subset.payload.after].map((item) => item && 'commit' in item ? item.commit : undefined), ['b'.repeat(40), 'a'.repeat(40)], 'each side names its payload');
  // Group names expand through the catalog; a scenario one side refused or never ran is named.
  assert.deepEqual((await compareBatches(before, after, [], { scenarios: ['core-language', 'base-report-default-review'] })).overall.reasons, ['scenario-refused:before:base-report-default-review']);
  const group = await compareBatches(before, after, [], { scenarios: ['maa-core'] });
  assert.equal(group.overall.status, 'incomparable'); assert.ok(group.overall.reasons.includes('scenario-not-run:before:core-boundary'), JSON.stringify(group.overall.reasons));
  // Reruns of the pass→fail scenario, on the same payload, settle it under 28's rules.
  const reruns = await batch([1, 2, 3].map((index) => record(`r${index}`, 'core-append', 'pass', { skillVersion: 'skill-a', payloadFingerprint: 'fingerprint-r', rerunOf: 'a2' })),
    { payload: { source: 'commit', commit: 'a'.repeat(40), digest: 'digest-a' } });
  assert.equal((await compareBatches(before, after, [reruns], { scenarios: ['core-language', 'core-append'] })).overall.status, 'unstable');
  const otherPayloadReruns = await batch([1, 2, 3].map((index) => record(`s${index}`, 'core-append', 'pass', { skillVersion: 'skill-a', payloadFingerprint: 'fingerprint-s', rerunOf: 'a2' })));
  assert.deepEqual((await compareBatches(before, after, [otherPayloadReruns], { scenarios: ['core-language', 'core-append'] })).overall.reasons, ['rerun-payload-differs']);
  // Everything else must be equal: each difference is incomparable with its own static reason.
  const pair = [record('c1', 'core-language', 'pass'), record('c2', 'core-append', 'pass')];
  for (const [change, reason] of [
    [{ host: 'claude' }, 'host-differs'], [{ fingerprint: { ...fingerprint, hostVersion: '2.1.322', payload: 'fingerprint-c' } }, 'cli-version-differs'],
    [{ fingerprint: { ...fingerprint, model: 'other-model', payload: 'fingerprint-c' } }, 'model-differs'], [{ fingerprint: { ...fingerprint, auth: 'api-key', payload: 'fingerprint-c' } }, 'auth-differs'],
    [{ fingerprint: { ...fingerprint, runner: 'runner-2', payload: 'fingerprint-c' } }, 'runner-differs'], [{ payload: undefined }, 'payload-unrecorded:after'],
  ] as const) {
    const result = await compareBatches(before, await batch(pair, change), [], { scenarios: ['core-language', 'core-append'] });
    assert.deepEqual([result.overall.status, result.overall.reasons], ['incomparable', [reason]], reason);
  }
  // A scenario whose identity changed is incomparable with its own reason; the CLI takes the subset and exits non-zero.
  const changed = await batch([record('d1', 'core-language', 'pass', { scenarioHash: 'hash-new' }), record('d2', 'core-append', 'pass')]);
  const identity = await compareBatches(before, changed, [], { scenarios: ['core-language', 'core-append'] });
  assert.deepEqual(identity.overall.reasons, ['scenario-identity-differs:core-language']);
  assert.deepEqual(identity.scenarios.find((item) => item.scenario === 'core-language')!.reasons, ['scenario-identity-differs:core-language']);
  const command = cli(repository, 'compare', before, after, '--scenarios', 'core-language,core-append');
  assert.equal(command.status, 1);
  assert.deepEqual(JSON.parse(command.stdout).passToFail, ['core-append']);
  const same = await batch([record('e1', 'core-language', 'pass'), record('e2', 'core-append', 'pass')]);
  assert.equal(cli(repository, 'compare', before, same, '--scenarios', 'core-language,core-append').status, 0);
});
