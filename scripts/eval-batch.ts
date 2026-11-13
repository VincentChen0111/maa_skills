import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScenario, type RunAuth, type ScenarioDefinition, type ScenarioName } from './eval-run.ts';
import { authPreflight, executableVariables, readProtectionCheck, resolveLoginDirectory, sentinelNames, type AuthPreflight, type ReadProtectionResult } from './eval-auth.ts';
import { compareRuns, type Comparison, type Host, type RunRecord } from './evaluation.ts';
import { probeVersion } from './eval-host.ts';
import { entryId, scenarioCatalog, scenarioGroups, selectScenarios, type ScenarioEntry } from './eval-scenarios.ts';
import { createFixture } from './eval-fixture.ts';
import { artifactWriter, redactor } from './eval-redact.ts';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Host-level failures: every later scenario would fail the same way, so the batch stops and can be resumed. */
export const abortReasons = ['quota-exhausted', 'auth-failed', 'network-unavailable'] as const;
export type BatchAuth = 'plan' | 'api-key' | 'host-double';
export type BatchRun = { scenario: string; directory: string; id: string; reason: string; grade: string; rerunOf?: string };
export type BatchManifest = {
  kind: 'maa-skills-evaluation-batch'; version: 1; id: string; createdAt: string; host: Host; model: string; auth: BatchAuth; double: boolean;
  fingerprint: { hostVersion: string; model: string; auth: BatchAuth; payload: string; runner: string };
  scenarios: string[]; rerunOf?: Record<string, string>;
  attempts: { at: string; authPreflight?: Omit<AuthPreflight, 'host'>; readProtection?: Omit<ReadProtectionResult, 'host' | 'pass'> }[];
  runs: BatchRun[]; status: 'running' | 'complete' | 'aborted'; abort?: { reason: string; scenario?: string; stage: 'login-lock' | 'auth-preflight' | 'read-protection' | 'scenario' };
};
export type BatchOptions = {
  host: Host; model: string; entries: ScenarioEntry[]; auth?: BatchAuth; executable?: string; executableArgs?: string[]; loginDirectory?: string;
  timeoutMs?: number; batchParent?: string; resume?: string; rerunOf?: Record<string, string>; repeat?: number;
  /** Stops the batch like Ctrl+C does: after the current host run, with the lock released. */
  signal?: AbortSignal;
};

async function tree(directory: string, base = directory): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await tree(path, base));
    else result.push(`${relative(base, path).replaceAll('\\', '/')}:${digest(await readFile(path))}`);
  }
  return result.sort();
}
/** Runner fingerprint sources: every file that decides how a run is launched, observed, recorded or graded (repository-relative). */
export const runnerSources = ['scripts/eval-run.ts', 'scripts/eval-host.ts', 'scripts/eval-auth.ts', 'scripts/eval-fixture.ts', 'scripts/evaluation.ts', 'scripts/eval-daily.ts',
  'scripts/eval-transaction.ts', 'scripts/eval-redact.ts', 'skills/maa-core/scripts/preferences.ts', 'scripts/eval-batch.ts', 'scripts/eval-scenarios.ts', 'eval/observe-node.mjs', 'eval/daily-observer.mjs',
  'eval/maa-process.mjs', 'eval/network-fixture.mjs', 'eval/setup-boundary.mjs'];
export async function runnerFingerprint(): Promise<string> {
  return digest((await Promise.all(runnerSources.map(async (file) => `${file}:${digest(await readFile(join(repositoryRoot, file)))}`))).join('\n'));
}
/** Payload fingerprint: the scenario definitions and every installed skill file. */
export async function payloadFingerprint(entries: ScenarioEntry[]): Promise<string> {
  const directories = [...new Set(entries.flatMap((entry) => [...(entry.skillDirectory ? [entry.skillDirectory] : []), ...Object.values(entry.companionSkills)]))].sort();
  const skills = await Promise.all(directories.map(async (directory) => `${basename(directory)}:${(await tree(directory)).join(',')}`));
  return digest(JSON.stringify({ scenarios: entries.map((entry) => entry.definition), skills }));
}

export async function readManifest(directory: string): Promise<BatchManifest> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BatchManifest;
  if (manifest.kind !== 'maa-skills-evaluation-batch' || manifest.version !== 1) throw new Error('batch-manifest');
  return manifest;
}
/** A run counts toward completion unless a host-level stop or the user's interrupt ended it. */
const counts = (run: BatchRun) => !(abortReasons as readonly string[]).includes(run.reason) && run.reason !== 'interrupted';
/** A scenario counts as done once it has a run that counts. */
export const completedScenarios = (manifest: BatchManifest) => new Set(manifest.runs.filter(counts).map((run) => run.scenario));

/**
 * Runs scenarios for one host and one fixed model, strictly one after another: one process at a time uses the host's login
 * directory (a lock file beside it refuses a second batch, in any process), and there is no parallel option. Plan login runs the auth preflight and the read-protection check first and stops
 * the batch on any failure; a quota, auth or network failure during the batch aborts it, and `resume` runs only the rest.
 */
export async function runBatch(options: BatchOptions): Promise<{ directory: string; manifest: BatchManifest }> {
  const auth = options.auth ?? 'plan';
  const executable = options.executable ?? process.env[executableVariables[options.host]] ?? options.host;
  const executableArgs = options.executableArgs ?? [];
  const loginDirectory = auth === 'plan' ? resolveLoginDirectory(options.host, options.loginDirectory) : undefined;
  const probeFixture = await createFixture();
  let version;
  try { version = probeVersion(executable, executableArgs, probeFixture.workspace, probeFixture.env); } finally { await probeFixture.dispose(); }
  const fingerprint = { hostVersion: version.version, model: options.model, auth, payload: await payloadFingerprint(options.entries), runner: await runnerFingerprint() };
  // The manifest is an artifact like any other: saved only through the one redaction (so it is compared in redacted form too).
  const artifactContext = { ...(loginDirectory ? { loginDirectory } : {}), executable };
  let directory: string; let manifest: BatchManifest;
  if (options.resume) {
    directory = resolve(options.resume);
    manifest = await readManifest(directory);
    // Same CLI, model, payload and runner, or no resume: a changed batch is a different batch.
    if (manifest.host !== options.host || JSON.stringify(manifest.fingerprint) !== redactor(artifactContext)(JSON.stringify(fingerprint)) ||
      JSON.stringify(manifest.scenarios) !== JSON.stringify(options.entries.map(entryId))) throw new Error('fingerprint-mismatch');
    manifest.status = 'running'; delete manifest.abort;
  } else {
    const parent = resolve(options.batchParent ?? '.tmp/evaluations');
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(join(parent, 'batch-'));
    manifest = { kind: 'maa-skills-evaluation-batch', version: 1, id: randomUUID(), createdAt: new Date().toISOString(), host: options.host, model: options.model,
      auth, double: version.double, fingerprint, scenarios: options.entries.map(entryId), ...(options.rerunOf ? { rerunOf: options.rerunOf } : {}), attempts: [], runs: [], status: 'running' };
  }
  const write = artifactWriter(directory, artifactContext);
  const save = () => write('manifest.json', JSON.stringify(manifest, null, 2));
  const abort = async (reason: string, stage: NonNullable<BatchManifest['abort']>['stage'], scenario?: string) => {
    manifest.status = 'aborted'; manifest.abort = { reason, stage, ...(scenario ? { scenario } : {}) }; await save();
    return { directory, manifest };
  };
  const attempt: BatchManifest['attempts'][number] = { at: new Date().toISOString() };
  manifest.attempts.push(attempt);
  await save();
  // One batch per login directory on this machine, across processes: an exclusive lock file beside (never inside) the directory.
  // A missing parent means there is no login to share; the auth preflight then reports it.
  let lock: string | undefined;
  if (loginDirectory) {
    const path = `${loginDirectory}.lock`;
    try { await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: attempt.at }), { flag: 'wx' }); lock = path; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return abort('login-directory-busy', 'login-lock');
      if (code !== 'ENOENT') return abort('login-directory-lock-failed', 'login-lock');
    }
  }
  // Ctrl+C reaches the host child as well: the batch stops once the current host run returns and releases the lock. A second
  // Ctrl+C releases the lock at once and exits.
  const stop = new AbortController();
  const onInterrupt = () => { if (stop.signal.aborted) { if (lock) rmSync(lock, { force: true }); process.exit(130); } stop.abort(); };
  const interrupted = () => stop.signal.aborted || !!options.signal?.aborted;
  process.on('SIGINT', onInterrupt);
  try {
    if (interrupted()) return await abort('interrupted', 'auth-preflight');
    let runAuth: RunAuth = auth === 'host-double' ? { mode: 'host-double' } : { mode: 'api-key' };
    if (auth !== 'host-double') {
      const preflight = await authPreflight({ host: options.host, model: options.model, auth, executable, executableArgs, ...(loginDirectory ? { loginDirectory } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
      const { host: _host, ...recorded } = preflight; attempt.authPreflight = recorded;
      if (preflight.status !== 'pass') return await abort(preflight.category ?? 'other', 'auth-preflight');
      if (auth === 'plan') {
        // The check comes after the auth preflight and before the first scenario with tools; failure stops this host's batch.
        const check = await readProtectionCheck({ host: options.host, model: options.model, executable, executableArgs, loginDirectory: loginDirectory!, artifactDirectory: directory,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
        const { host: _checked, pass, ...result } = check; attempt.readProtection = result;
        if (check.status !== 'pass' || !pass) return await abort(check.category ?? 'read-protection-failed', 'read-protection');
        // No sentinel, from this check or an interrupted earlier one, is left when the first scenario starts.
        if ((await sentinelNames(loginDirectory!)).length) return await abort('sentinel-not-removed', 'read-protection');
        runAuth = { mode: 'plan', readProtection: pass };
      }
    }
    await save();
    const done = completedScenarios(manifest);
    const repeat = options.repeat ?? 1;
    for (const entry of options.entries) {
      const scenario = entryId(entry);
      const finished = manifest.runs.filter((run) => run.scenario === scenario && counts(run)).length;
      if (done.has(scenario) && finished >= repeat) continue;
      for (let index = finished; index < repeat; index++) {
        if (interrupted()) return await abort('interrupted', 'scenario', scenario);
        const outcome = await runScenario({ host: options.host, model: options.model, scenario: entry.definition as ScenarioName | ScenarioDefinition, executable, executableArgs,
          auth: runAuth, artifactParent: directory, ...(entry.skillDirectory ? { skillDirectory: entry.skillDirectory } : {}), companionSkills: entry.companionSkills,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(manifest.rerunOf?.[scenario] ? { rerunOf: manifest.rerunOf[scenario] } : {}) });
        // A run the user interrupted is kept as saved, but the manifest marks it so that resume runs the scenario again.
        const stopped = interrupted();
        manifest.runs.push({ scenario, directory: relative(directory, outcome.artifactDirectory).replaceAll('\\', '/'), id: outcome.record.id,
          reason: stopped ? 'interrupted' : outcome.reason, grade: outcome.record.grade.status, ...(outcome.record.rerunOf ? { rerunOf: outcome.record.rerunOf } : {}) });
        await save();
        if (stopped) return await abort('interrupted', 'scenario', scenario);
        if ((abortReasons as readonly string[]).includes(outcome.reason)) return await abort(outcome.reason, 'scenario', scenario);
      }
    }
    manifest.status = 'complete';
    await save();
    return { directory, manifest };
  } finally {
    process.off('SIGINT', onInterrupt);
    if (lock) await rm(lock, { force: true });
  }
}

/**
 * The records that count toward completion, read from saved files only; nothing here rewrites an earlier record. A host-level
 * stop (quota, auth, network) is kept on disk but never compared; outside a rerun batch each scenario contributes its last
 * finished record, and a rerun batch contributes every finished rerun.
 */
export async function batchRecords(directory: string): Promise<RunRecord[]> {
  const manifest = await readManifest(directory);
  const finished = manifest.runs.filter(counts);
  const counted =finished.filter((run, index) => manifest.rerunOf?.[run.scenario] || !finished.slice(index + 1).some((later) => later.scenario === run.scenario));
  return Promise.all(counted.map(async (run) => JSON.parse(await readFile(join(directory, run.directory, 'run.json'), 'utf8')) as RunRecord));
}
export type BatchComparison = { overall: Comparison; scenarios: { host: Host; scenario: string; status: Comparison['status']; rerun: string[] }[]; rerunScenarios: string[] };
export async function compareBatches(before: string, after: string, reruns: string[] = []): Promise<BatchComparison> {
  const [old, next, repeated] = await Promise.all([batchRecords(before), batchRecords(after), Promise.all(reruns.map(batchRecords)).then((items) => items.flat())]);
  const scenarios = [...new Set([...old, ...next].map((run) => `${run.host}:${run.scenario}`))].sort().map((key) => {
    const [host, scenario] = key.split(/:(.*)/) as [Host, string];
    const pick = (runs: RunRecord[]) => runs.filter((run) => run.host === host && run.scenario === scenario);
    const after = pick(next);
    const result = compareRuns(pick(old), after, repeated.filter((run) => after.some((item) => item.id === run.rerunOf)));
    return { host, scenario, status: result.status, rerun: result.rerun };
  });
  return { overall: compareRuns(old, next, repeated), scenarios, rerunScenarios: scenarios.filter((item) => item.status === 'needs-reruns').map((item) => item.scenario) };
}

/** `eval-run.ts` keeps its positional form; each run is a batch of one with the same preflight and read-protection gate. */
export async function runSingle(options: { host: Host; model: string; scenario: ScenarioName | ScenarioDefinition; executable?: string; skillDirectory?: string; auth?: BatchAuth }) {
  const entry: ScenarioEntry = { group: 'single', definition: options.scenario, ...(options.skillDirectory ? { skillDirectory: resolve(options.skillDirectory) } : {}), companionSkills: {} };
  const { directory, manifest } = await runBatch({ host: options.host, model: options.model, entries: [entry], ...(options.executable ? { executable: options.executable } : {}),
    ...(options.auth ? { auth: options.auth } : {}) });
  const run = manifest.runs.at(-1);
  return { status: run?.grade ?? 'unverified', reason: run?.reason ?? manifest.abort?.reason ?? 'not-run', batch: relative(process.cwd(), directory).replaceAll('\\', '/') };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  if (value === undefined) throw new Error(`missing-value:${name}`);
  return value;
}
const usage = `Usage:
  node scripts/eval-batch.ts list
  node scripts/eval-batch.ts run <claude|codex> <fixed-model-id> <scenario-or-group>... [--auth plan|api-key] [--executable <path>] [--login-dir <path>] [--timeout-ms <ms>] [--rerun-of <batch-dir>]
  node scripts/eval-batch.ts resume <batch-dir> [--executable <path>] [--login-dir <path>] [--timeout-ms <ms>]
  node scripts/eval-batch.ts compare <before-batch-dir> <after-batch-dir> [<rerun-batch-dir>...]
  node scripts/eval-batch.ts preflight`;

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift();
  if (command === 'list') {
    console.log(JSON.stringify({ groups: scenarioGroups(), scenarios: scenarioCatalog().map((entry) => ({ id: entryId(entry), group: entry.group })) }, null, 2));
    return 0;
  }
  if (command === 'preflight') {
    const { runEnvironmentPreflight } = await import('./eval-preflight.ts');
    const result = await runEnvironmentPreflight();
    console.log(JSON.stringify(result, null, 2));
    return result.status === 'pass' ? 0 : 1;
  }
  if (command === 'compare') {
    const [before, after, ...reruns] = args;
    if (!before || !after) { console.error(usage); return 2; }
    const result = await compareBatches(before, after, reruns);
    console.log(JSON.stringify(result, null, 2));
    return ['pass', 'baseline'].includes(result.overall.status) ? 0 : 1;
  }
  if (command === 'run' || command === 'resume') {
    const auth = option(args, '--auth') as BatchAuth | undefined;
    const executable = option(args, '--executable');
    const loginDirectory = option(args, '--login-dir');
    const timeout = option(args, '--timeout-ms');
    const rerunBatch = option(args, '--rerun-of');
    if (auth && !['plan', 'api-key'].includes(auth)) { console.error(usage); return 2; }
    const common = { ...(executable ? { executable } : {}), ...(loginDirectory ? { loginDirectory } : {}), ...(timeout ? { timeoutMs: Number(timeout) } : {}) };
    let result;
    if (command === 'resume') {
      const [batch] = args;
      if (!batch) { console.error(usage); return 2; }
      const saved = await readManifest(batch);
      if (saved.auth === 'host-double') throw new Error('host-double-batch');
      result = await runBatch({ host: saved.host, model: saved.model, auth: saved.auth, entries: selectScenarios(saved.scenarios), resume: batch, ...common,
        ...(saved.rerunOf ? { rerunOf: saved.rerunOf, repeat: 3 } : {}) });
    } else {
      const [host, model, ...names] = args;
      if (!host || !['claude', 'codex'].includes(host) || !model || !names.length) { console.error(usage); return 2; }
      const entries = selectScenarios(names);
      let rerunOf: Record<string, string> | undefined;
      if (rerunBatch) {
        // Each pass→fail scenario is rerun three times on its own, each record pointing at the first failing run.
        const saved = await readManifest(rerunBatch);
        rerunOf = Object.fromEntries(entries.map((entry) => {
          const run = saved.runs.filter((item) => item.scenario === entryId(entry)).at(-1);
          if (!run) throw new Error(`no-run-to-rerun:${entryId(entry)}`);
          return [entryId(entry), run.id];
        }));
      }
      result = await runBatch({ host: host as Host, model, entries, ...(auth ? { auth } : {}), ...common, ...(rerunOf ? { rerunOf, repeat: 3 } : {}) });
    }
    const { manifest } = result;
    console.log(JSON.stringify({ batch: relative(process.cwd(), result.directory).replaceAll('\\', '/'), status: manifest.status, abort: manifest.abort,
      runs: manifest.runs.map(({ scenario, reason, grade }) => ({ scenario, reason, grade })) }, null, 2));
    return manifest.status === 'complete' && manifest.runs.every((run) => run.grade === 'pass') ? 0 : 1;
  }
  console.error(usage);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    // Only the error code is printed: never a path, environment value or host output.
    console.error(`Evaluation batch did not complete: ${error instanceof Error && /^[a-z][a-z0-9:-]*$/.test(error.message) ? error.message : 'unexpected-error'}`);
    process.exitCode = 1;
  }
}
