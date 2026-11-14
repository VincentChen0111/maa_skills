import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScenario, type RunAuth, type ScenarioDefinition, type ScenarioName } from './eval-run.ts';
import { authPreflight, executableVariables, readProtectionCheck, resolveLoginDirectory, sentinelNames, type AuthPreflight, type ReadProtectionResult } from './eval-auth.ts';
import { batchIncomparability, compareRuns, type Comparison, type Grade, type Host, type RunRecord } from './evaluation.ts';
import { probeVersion } from './eval-host.ts';
import { entryId, payloadRefusals, scenarioCatalog, scenarioGroups, scenarioIds, scenarioRequirements, selectScenarios, type ScenarioEntry, type ScenarioRefusal } from './eval-scenarios.ts';
import { createFixture } from './eval-fixture.ts';
import { artifactWriter, redactor } from './eval-redact.ts';
import { materializePayload, openPayload, type PayloadSource } from './eval-payload.ts';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Host-level failures: every later scenario would fail the same way, so the batch stops and can be resumed. */
export const abortReasons = ['quota-exhausted', 'auth-failed', 'network-unavailable'] as const;
export type BatchAuth = 'plan' | 'api-key' | 'host-double';
export type BatchRun = { scenario: string; directory: string; id: string; reason: string; grade: string; rerunOf?: string };
export type BatchManifest = {
  kind: 'maa-skills-evaluation-batch'; version: 1; id: string; createdAt: string; host: Host; model: string; auth: BatchAuth; double: boolean;
  fingerprint: { hostVersion: string; model: string; auth: BatchAuth; payload: string; runner: string };
  /** Where the installed skills came from: a payload directory's commit, tree and content digest, or the checkout's digest. */
  payload?: PayloadSource;
  /** `scenarios` are the scenarios the batch runs; `refused` the ones its payload cannot serve, refused before any host call. */
  scenarios: string[]; refused?: ({ scenario: string } & ScenarioRefusal)[]; rerunOf?: Record<string, string>;
  attempts: { at: string; authPreflight?: Omit<AuthPreflight, 'host'>; readProtection?: Omit<ReadProtectionResult, 'host' | 'pass'> }[];
  runs: BatchRun[]; status: 'running' | 'complete' | 'aborted'; abort?: { reason: string; scenario?: string; stage: 'login-lock' | 'auth-preflight' | 'read-protection' | 'scenario' };
};
export type BatchOptions = {
  host: Host; model: string; entries: ScenarioEntry[]; auth?: BatchAuth; executable?: string; executableArgs?: string[]; loginDirectory?: string;
  timeoutMs?: number; batchParent?: string; resume?: string; rerunOf?: Record<string, string>; repeat?: number;
  /** A payload directory (`materializePayload`); the entries must install from it (`selectScenarios(names, payload)`). */
  payload?: string;
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
  'scripts/eval-transaction.ts', 'scripts/eval-redact.ts', 'skills/maa-core/scripts/preferences.ts', 'skills/maa-core/scripts/consumption-grant.ts', 'scripts/eval-batch.ts', 'scripts/eval-scenarios.ts', 'scripts/eval-payload.ts', 'eval/observe-node.mjs', 'eval/daily-observer.mjs',
  'eval/maa-process.mjs', 'eval/network-fixture.mjs', 'eval/setup-boundary.mjs', 'eval/report-observer.ts', 'eval/base-plan-observer.ts'];
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
/**
 * A run counts toward completion unless a host-level stop or the user's interrupt ended it, or the payload changed while it
 * ran (`fingerprint-mismatch`: which candidate it installed is unknown).
 */
const counts = (run: BatchRun) => !(abortReasons as readonly string[]).includes(run.reason) && run.reason !== 'interrupted' && run.reason !== 'fingerprint-mismatch';
/** A scenario counts as done once it has a run that counts. */
export const completedScenarios = (manifest: BatchManifest) => new Set(manifest.runs.filter(counts).map((run) => run.scenario));

/**
 * Runs scenarios for one host and one fixed model, strictly one after another: one process at a time uses the host's login
 * directory (a lock file beside it refuses a second batch, in any process), and there is no parallel option. Plan login runs the auth preflight and the read-protection check first and stops
 * the batch on any failure; a quota, auth or network failure during the batch aborts it, and `resume` runs only the rest.
 * A payload that changes during the batch stops it (`fingerprint-mismatch`); the batch is never marked complete on two candidates.
 * Before any host call: the payload (the checkout's own, or `options.payload` checked like the checkout) is opened, and each
 * scenario it cannot serve is refused with a static code (`refused` in the manifest); such a scenario never runs and never
 * counts as passed or failed. With nothing left to run the batch is not started (`no-servable-scenario`).
 */
export async function runBatch(options: BatchOptions): Promise<{ directory: string; manifest: BatchManifest }> {
  const auth = options.auth ?? 'plan';
  const executable = options.executable ?? process.env[executableVariables[options.host]] ?? options.host;
  const executableArgs = options.executableArgs ?? [];
  const loginDirectory = auth === 'plan' ? resolveLoginDirectory(options.host, options.loginDirectory) : undefined;
  const payload = await openPayload(options.payload, { loginDirectories: [loginDirectory] });
  const payloadDirectory = options.payload === undefined ? undefined : payload.root;
  if (payloadDirectory) {
    const skills = join(payloadDirectory, 'skills');
    const outside = (path: string) => { const from = relative(skills, resolve(path)); return !from || from.startsWith('..') || isAbsolute(from); };
    if (options.entries.some((entry) => scenarioRequirements(entry).directories.some(outside))) throw new Error('payload-entry-outside');
  }
  const refusals = await payloadRefusals(options.entries);
  const entries = options.entries.filter((entry) => !refusals.has(entryId(entry)));
  const refused = options.entries.filter((entry) => refusals.has(entryId(entry))).map((entry) => ({ scenario: entryId(entry), ...refusals.get(entryId(entry))! }));
  if (!entries.length) throw new Error('no-servable-scenario');
  const probeFixture = await createFixture();
  let version;
  try { version = probeVersion(executable, executableArgs, probeFixture.workspace, probeFixture.env); } finally { await probeFixture.dispose(); }
  const fingerprint = { hostVersion: version.version, model: options.model, auth, payload: await payloadFingerprint(entries), runner: await runnerFingerprint() };
  // The manifest is an artifact like any other: saved only through the one redaction (so it is compared in redacted form too).
  const artifactContext = { ...(loginDirectory ? { loginDirectory } : {}), executable, ...(payloadDirectory ? { payload: payloadDirectory } : {}) };
  const payloadOption = payloadDirectory ? { payloadDirectory } : {};
  let directory: string; let manifest: BatchManifest;
  if (options.resume) {
    directory = resolve(options.resume);
    manifest = await readManifest(directory);
    // Same CLI, model, payload and runner, or no resume: a changed batch is a different batch.
    if (manifest.host !== options.host || JSON.stringify(manifest.fingerprint) !== redactor(artifactContext)(JSON.stringify(fingerprint)) ||
      JSON.stringify(manifest.payload) !== JSON.stringify(payload.source) || JSON.stringify(manifest.scenarios) !== JSON.stringify(entries.map(entryId))) throw new Error('fingerprint-mismatch');
    manifest.status = 'running'; delete manifest.abort;
  } else {
    const parent = resolve(options.batchParent ?? '.tmp/evaluations');
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(join(parent, 'batch-'));
    manifest = { kind: 'maa-skills-evaluation-batch', version: 1, id: randomUUID(), createdAt: new Date().toISOString(), host: options.host, model: options.model,
      auth, double: version.double, fingerprint, payload: payload.source, scenarios: entries.map(entryId), refused, ...(options.rerunOf ? { rerunOf: options.rerunOf } : {}),
      attempts: [], runs: [], status: 'running' };
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
      const preflight = await authPreflight({ host: options.host, model: options.model, auth, executable, executableArgs, ...(loginDirectory ? { loginDirectory } : {}), ...payloadOption,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
      const { host: _host, ...recorded } = preflight; attempt.authPreflight = recorded;
      if (preflight.status !== 'pass') return await abort(preflight.category ?? 'other', 'auth-preflight');
      if (auth === 'plan') {
        // The check comes after the auth preflight and before the first scenario with tools; failure stops this host's batch.
        const check = await readProtectionCheck({ host: options.host, model: options.model, executable, executableArgs, loginDirectory: loginDirectory!, artifactDirectory: directory, ...payloadOption,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
        const { host: _checked, pass, ...result } = check; attempt.readProtection = result;
        if (check.status !== 'pass' || !pass) return await abort(check.category ?? 'read-protection-failed', 'read-protection');
        // No sentinel, from this check or an interrupted earlier one, is left when the first scenario starts.
        if ((await sentinelNames(loginDirectory!)).length) return await abort('sentinel-not-removed', 'read-protection');
        runAuth = { mode: 'plan', readProtection: pass };
      }
    }
    await save();
    // A batch is one candidate: the payload (scenario definitions and every installed skill file) is checked again before each
    // scenario starts, after each run and before the batch is marked complete; any change stops the batch (fail closed).
    const samePayload = async () => await payloadFingerprint(entries) === fingerprint.payload;
    const done = completedScenarios(manifest);
    const repeat = options.repeat ?? 1;
    for (const entry of entries) {
      const scenario = entryId(entry);
      const finished = manifest.runs.filter((run) => run.scenario === scenario && counts(run)).length;
      if (done.has(scenario) && finished >= repeat) continue;
      for (let index = finished; index < repeat; index++) {
        if (interrupted()) return await abort('interrupted', 'scenario', scenario);
        if (!await samePayload()) return await abort('fingerprint-mismatch', 'scenario', scenario);
        const outcome = await runScenario({ host: options.host, model: options.model, scenario: entry.definition as ScenarioName | ScenarioDefinition, executable, executableArgs,
          auth: runAuth, artifactParent: directory, ...(entry.skillDirectory ? { skillDirectory: entry.skillDirectory } : {}), companionSkills: entry.companionSkills,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(manifest.rerunOf?.[scenario] ? { rerunOf: manifest.rerunOf[scenario] } : {}),
          payloadFingerprint: fingerprint.payload, ...payloadOption });
        // A run the user interrupted, or one the payload changed under, is kept as saved, but the manifest marks it so that
        // it does not count and resume runs the scenario again.
        const stopped = interrupted();
        const changed = !await samePayload();
        manifest.runs.push({ scenario, directory: relative(directory, outcome.artifactDirectory).replaceAll('\\', '/'), id: outcome.record.id,
          reason: changed ? 'fingerprint-mismatch' : stopped ? 'interrupted' : outcome.reason, grade: outcome.record.grade.status, ...(outcome.record.rerunOf ? { rerunOf: outcome.record.rerunOf } : {}) });
        await save();
        if (changed) return await abort('fingerprint-mismatch', 'scenario', scenario);
        if (stopped) return await abort('interrupted', 'scenario', scenario);
        if ((abortReasons as readonly string[]).includes(outcome.reason)) return await abort(outcome.reason, 'scenario', scenario);
      }
    }
    if (!await samePayload()) return await abort('fingerprint-mismatch', 'scenario');
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
export type BatchComparison = {
  overall: Comparison;
  /** Each scenario with its own verdict, the grade before and after, and the reasons when it is incomparable. */
  scenarios: { host: Host; scenario: string; status: Comparison['status']; rerun: string[]; before?: Grade['status']; after?: Grade['status']; reasons: string[] }[];
  rerunScenarios: string[];
  /** Scenarios that passed before and failed after (each needs three reruns before it is judged). */
  passToFail: string[];
  /** The payload each side names (source commit and digest). */
  payload: { before?: PayloadSource; after?: PayloadSource };
};
/**
 * Compares two batches whose only allowed difference is the payload (`batchIncomparability`: same host, CLI, model, auth and
 * runner; scenario identity per record in `compareRuns`). `scenarios` restricts both sides (and the reruns) to a subset (ids,
 * group names or `all`), so several comparisons can share one after batch; each subset scenario must have been run on both
 * sides, and one a side refused or never ran makes the pair incomparable with its reason.
 */
export async function compareBatches(before: string, after: string, reruns: string[] = [], options: { scenarios?: string[] } = {}): Promise<BatchComparison> {
  const [oldManifest, nextManifest, ...rerunManifests] = await Promise.all([before, after, ...reruns].map(readManifest));
  const subset = options.scenarios ? new Set(scenarioIds(options.scenarios)) : undefined;
  const keep = (runs: RunRecord[]) => subset ? runs.filter((run) => subset.has(run.scenario)) : runs;
  const [old, next, repeated] = (await Promise.all([batchRecords(before), batchRecords(after), Promise.all(reruns.map(batchRecords)).then((items) => items.flat())])).map(keep) as [RunRecord[], RunRecord[], RunRecord[]];
  const reasons = batchIncomparability(oldManifest!, nextManifest!, rerunManifests);
  if (!reasons.length && subset) {
    for (const id of subset) for (const [side, manifest, records] of [['before', oldManifest!, old], ['after', nextManifest!, next]] as const) {
      if (!records.some((run) => run.scenario === id)) reasons.push(`${manifest.refused?.some((item) => item.scenario === id) ? 'scenario-refused' : 'scenario-not-run'}:${side}:${id}`);
    }
  }
  const scenarios = [...new Set([...old, ...next].map((run) => `${run.host}:${run.scenario}`))].sort().map((key) => {
    const [host, scenario] = key.split(/:(.*)/) as [Host, string];
    const pick = (runs: RunRecord[]) => runs.filter((run) => run.host === host && run.scenario === scenario);
    const [first, last] = [pick(old), pick(next)];
    const result = compareRuns(first, last, repeated.filter((run) => last.some((item) => item.id === run.rerunOf)));
    return { host, scenario, status: result.status, rerun: result.rerun, ...(first[0] ? { before: first[0].grade.status } : {}), ...(last[0] ? { after: last[0].grade.status } : {}),
      reasons: result.reasons };
  });
  return { overall: reasons.length ? { status: 'incomparable', rerun: [], reasons } : compareRuns(old, next, repeated), scenarios,
    rerunScenarios: scenarios.filter((item) => item.status === 'needs-reruns').map((item) => item.scenario),
    passToFail: scenarios.filter((item) => item.before === 'pass' && item.after === 'fail').map((item) => item.scenario),
    payload: { ...(oldManifest!.payload ? { before: oldManifest!.payload } : {}), ...(nextManifest!.payload ? { after: nextManifest!.payload } : {}) } };
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
  node scripts/eval-batch.ts list [--payload <payload-dir>]
  node scripts/eval-batch.ts payload --commit <rev> --out <new-empty-dir>
  node scripts/eval-batch.ts run <claude|codex> <fixed-model-id> <scenario-or-group>... [--payload <payload-dir>] [--auth plan|api-key] [--executable <path>] [--login-dir <path>] [--timeout-ms <ms>] [--rerun-of <batch-dir>]
  node scripts/eval-batch.ts resume <batch-dir> [--payload <payload-dir>] [--executable <path>] [--login-dir <path>] [--timeout-ms <ms>]
  node scripts/eval-batch.ts compare <before-batch-dir> <after-batch-dir> [<rerun-batch-dir>...] [--scenarios <id-or-group>,...]
  node scripts/eval-batch.ts preflight`;

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift();
  if (command === 'list') {
    const directory = option(args, '--payload');
    const payload = await openPayload(directory);
    const catalog = scenarioCatalog(directory === undefined ? undefined : payload.root);
    const refusals = await payloadRefusals(catalog);
    console.log(JSON.stringify({ groups: scenarioGroups(), payload: payload.source,
      scenarios: catalog.map((entry) => ({ id: entryId(entry), group: entry.group, ...(refusals.has(entryId(entry)) ? { refused: refusals.get(entryId(entry)) } : {}) })) }, null, 2));
    return 0;
  }
  if (command === 'payload') {
    const commit = option(args, '--commit');
    const out = option(args, '--out');
    if (!commit || !out || args.length) { console.error(usage); return 2; }
    console.log(JSON.stringify(await materializePayload({ commit, out }), null, 2));
    return 0;
  }
  if (command === 'preflight') {
    const { runEnvironmentPreflight } = await import('./eval-preflight.ts');
    const result = await runEnvironmentPreflight();
    console.log(JSON.stringify(result, null, 2));
    return result.status === 'pass' ? 0 : 1;
  }
  if (command === 'compare') {
    const subset = option(args, '--scenarios');
    const [before, after, ...reruns] = args;
    if (!before || !after) { console.error(usage); return 2; }
    const result = await compareBatches(before, after, reruns, subset === undefined ? {} : { scenarios: subset.split(',').map((name) => name.trim()).filter(Boolean) });
    console.log(JSON.stringify(result, null, 2));
    return ['pass', 'baseline'].includes(result.overall.status) ? 0 : 1;
  }
  if (command === 'run' || command === 'resume') {
    const auth = option(args, '--auth') as BatchAuth | undefined;
    const executable = option(args, '--executable');
    const loginDirectory = option(args, '--login-dir');
    const timeout = option(args, '--timeout-ms');
    const rerunBatch = option(args, '--rerun-of');
    const payloadOption = option(args, '--payload');
    const payload = payloadOption === undefined ? undefined : resolve(payloadOption);
    if (auth && !['plan', 'api-key'].includes(auth)) { console.error(usage); return 2; }
    const common = { ...(executable ? { executable } : {}), ...(loginDirectory ? { loginDirectory } : {}), ...(timeout ? { timeoutMs: Number(timeout) } : {}), ...(payload ? { payload } : {}) };
    let result;
    if (command === 'resume') {
      const [batch] = args;
      if (!batch) { console.error(usage); return 2; }
      const saved = await readManifest(batch);
      if (saved.auth === 'host-double') throw new Error('host-double-batch');
      result = await runBatch({ host: saved.host, model: saved.model, auth: saved.auth, entries: selectScenarios(saved.scenarios, payload), resume: batch, ...common,
        ...(saved.rerunOf ? { rerunOf: saved.rerunOf, repeat: 3 } : {}) });
    } else {
      const [host, model, ...names] = args;
      if (!host || !['claude', 'codex'].includes(host) || !model || !names.length) { console.error(usage); return 2; }
      const entries = selectScenarios(names, payload);
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
    console.log(JSON.stringify({ batch: relative(process.cwd(), result.directory).replaceAll('\\', '/'), status: manifest.status, abort: manifest.abort, payload: manifest.payload,
      refused: manifest.refused ?? [], runs: manifest.runs.map(({ scenario, reason, grade }) => ({ scenario, reason, grade })) }, null, 2));
    // A refused scenario is neither passed nor failed, but the batch did not run everything it was asked to.
    return manifest.status === 'complete' && manifest.runs.every((run) => run.grade === 'pass') && !manifest.refused?.length ? 0 : 1;
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
