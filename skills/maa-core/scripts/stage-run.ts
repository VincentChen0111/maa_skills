import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeConfigWrite, type MaaProcess } from './maa-config.ts';
import { runChecks } from './doctor.ts';
import { captureLogCursor, logFiles, readLogSince, type LogCursor, type LogName } from './maa-log-window.ts';
import { approvedJobEntries, approvedJobList, approvedJobStages, verifyApprovedJobFiles, type ApprovedJobPlan } from './stage-job-plan.ts';
import { applyCoreLines, applyGap, applyGuiLines, applyProcess, applyUserReport, deriveRun, emptyBatchEvidence, emptyRunState, fileKey, rerunGate,
  scanBatchLines, scanBeforeTracking, stageCandidates, switchTarget, type BatchView, type Decision, type DecisionRecord, type RunList, type RunState, type RunView,
  type SwitchState, type SwitchView, type Verification } from './stage-run-state.ts';
import { readSettings } from './preferences.ts';

/**
 * Tracks one prepared copilot batch from the user's start signal to a result. Read-only towards MAA: it reads the
 * configuration summary and MAA's own logs, inspects the process, and never starts, stops, clicks or rewrites anything.
 * The one exception is `switch` (ticket 17): after `rerunGate` allows it, it writes the next approved alternate into the
 * job list through the unified writer (`executeConfigWrite`), which closes, writes and reopens MAA; the user still clicks
 * start. The run record in `<private>/stage-runs/<runId>.json` and the switch ledger in `<private>/stage-runs/switches/`
 * are read with `readStageRun`, `summarizeStageRun`, `stageRunOutcome` and the `StageRunRecord` type.
 */
export type StageRunRecord = {
  version: 1; runId: string; createdAt: string; reference: string; retryOf: string | null; maaDirectory?: string;
  batch: { operation: string; reportHash: string; map: string; profile: number; listCheck: 'matches' | 'subset';
    stages: { stageId: string; code: string; loops: number; primary: number; alternates: number[] }[]; list: RunList };
  anchors: Record<LogName, LogCursor>; cursors: Record<LogName, LogCursor>;
  state: RunState; userReports: { at: string; kind: 'manual-play' | 'manual-login'; quote: string }[];
  screenshots: string[]; verifications: Verification[]; decisions: DecisionRecord[];
  lastObservedAt: string | null; lastActivityAt: string; processExitCode: number | null;
};
type Paths = { maaDirectory: string; privateDirectory: string };
const unknownState = ['sanity', 'medicine-inventory', 'originium', 'stage-progress'];
const decisions: Decision[] = ['retry-within-approval', 'switch-alternate', 'stop-and-tell-user'];
const maxWaitSeconds = 90, maxScreenshots = 20;
function fail(code: string): never { throw new Error(code); }
const text = (value: unknown, max: number, code: string) => typeof value === 'string' && value.trim() && value.length <= max ? value : fail(code);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const runFile = (privateDirectory: string, runId: string) => /^[0-9a-f-]{36}$/.test(runId) ? join(privateDirectory, 'stage-runs', `${runId}.json`) : fail('run-id-invalid');

async function jsonLines(file: string): Promise<Record<string, unknown>[]> {
  let content = '';
  try { content = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return content.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [object(JSON.parse(line))]; } catch { return []; } });
}
/** The batch is the `complete` stage preparation recorded by the unified writer (ticket 15). */
async function preparedBatch(privateDirectory: string, operation: string) {
  const done = (await jsonLines(join(privateDirectory, 'daily-runs.jsonl'))).find(entry => entry.operation === operation && entry.status === 'complete');
  const pending = (await jsonLines(join(privateDirectory, 'daily-pending.jsonl'))).find(entry => entry.id === operation);
  const plan = object(object(pending?.authorization).jobPlan) as unknown as ApprovedJobPlan;
  const change = (Array.isArray(pending?.changes) ? pending.changes : []).map(object).find(item => Array.isArray(item.path) && item.path.length === 4
    && item.path[0] === 'Configurations' && item.path[2] === 'Copilot' && item.path[3] === 'TaskList');
  const profileName = Array.isArray(change?.path) ? change.path[1] : undefined;
  if (!done || !pending || !Array.isArray(plan.entries) || typeof profileName !== 'string') fail('batch-not-prepared');
  const authorization = object(pending.authorization);
  return { plan, profileName: profileName as string, preparedAt: typeof done.startedAt === 'string' ? done.startedAt : '',
    approval: { source: authorization.source === 'approved-report' ? 'approved-report' as const : 'current-request' as const, reference: typeof authorization.reference === 'string' ? authorization.reference : '' } };
}
type ListItem = { Name?: unknown; FilePath?: unknown; CopilotId?: unknown; IsRaid?: unknown; Index?: unknown; IsNavNameOverride?: unknown; IsChecked?: unknown };
async function listCheck(maaDirectory: string, privateDirectory: string, plan: ApprovedJobPlan, profileName: string) {
  let profile = -1, current: unknown;
  try {
    const config = object(JSON.parse((await readFile(join(maaDirectory, 'config', 'gui.new.json'), 'utf8')).replace(/^﻿/, '')));
    const profiles = object(config.Configurations);
    profile = Object.keys(profiles).indexOf(profileName);
    current = object(object(profiles[profileName]).Copilot).TaskList;
  } catch { return { profile, result: 'unreadable' as const, ticks: null }; }
  const expected = approvedJobList(plan, privateDirectory);
  if (profile < 0 || !Array.isArray(current)) return { profile, result: 'unreadable' as const, ticks: null };
  const items = current.map(item => object(item) as ListItem);
  const same = (a: ListItem, b: ListItem) => a.Name === b.Name && typeof a.FilePath === 'string' && typeof b.FilePath === 'string' && fileKey(a.FilePath) === fileKey(b.FilePath)
    && a.CopilotId === b.CopilotId && a.IsRaid === b.IsRaid && a.Index === b.Index && (a.IsNavNameOverride ?? false) === b.IsNavNameOverride;
  if (items.length !== expected.length || !expected.every((item, index) => same(items[index]!, item))) return { profile, result: 'changed' as const, ticks: null };
  /** MAA saves an `IsChecked` change to gui.new.json about 200 ms after the click (docs/stage-run-sources.md). */
  const ticks = expected.map((item, index) => ({ index: item.Index, checked: items[index]!.IsChecked === true }));
  return { profile, result: ticks.every(item => item.checked) ? 'matches' as const : 'subset' as const, ticks };
}

async function save(privateDirectory: string, record: StageRunRecord, create = false) {
  const file = runFile(privateDirectory, record.runId);
  await mkdir(join(privateDirectory, 'stage-runs'), { recursive: true });
  const bytes = JSON.stringify(record, null, 2) + '\n';
  if (create) { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } return; }
  const temporary = join(privateDirectory, 'stage-runs', `${record.runId}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
/** Exclusive lock file; a lock left by a process that has exited is taken over. */
async function withLock<T>(lock: string, busy: string, work: () => Promise<T>): Promise<T> {
  await mkdir(join(lock, '..'), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 2 && !handle; attempt++) {
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number(object(JSON.parse(await readFile(lock, 'utf8').catch(() => '{}'))).pid);
      if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) fail(busy);
      await unlink(lock).catch(() => undefined);
    }
  }
  if (!handle) return fail(busy);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); await handle.close(); handle = undefined;
    return await work();
  } finally { if (handle) await handle.close(); await unlink(lock).catch(() => undefined); }
}
/** One gate decision per batch at a time: `start`, `decide` and `progress` hold it while they judge and write. */
const withOperation = <T>(privateDirectory: string, operation: string, work: () => Promise<T>) =>
  withLock(join(privateDirectory, 'stage-runs', `operation-${operation}.lock`), 'run-busy', work);
/** One writer per run record: a second concurrent observer would count the same log lines twice. */
async function withRun<T>(privateDirectory: string, runId: string, work: (record: StageRunRecord) => Promise<T>): Promise<T> {
  const file = runFile(privateDirectory, runId);
  return withLock(`${file.slice(0, -5)}.lock`, 'run-busy', async () => work(await readStageRun(privateDirectory, runId)));
}
const view = (record: StageRunRecord): RunView => ({ runId: record.runId, createdAt: record.createdAt, retryOf: record.retryOf, state: record.state,
  list: record.batch.list, stages: record.batch.stages, verifications: record.verifications, decisions: record.decisions });
async function operationRecords(privateDirectory: string, operation: string): Promise<StageRunRecord[]> {
  let names: string[] = [];
  try { names = (await readdir(join(privateDirectory, 'stage-runs'))).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)); } catch { /* none yet */ }
  return (await Promise.all(names.map(name => readStageRun(privateDirectory, name.slice(0, -5))))).filter(record => record.batch.operation === operation);
}

/**
 * Ticket 17's candidate-use ledger: one file per switch key in `<private>/stage-runs/switches/`. The key names the batch
 * operation, the run, the stage and the candidate pair, so a repeated request finds the record it already made.
 */
export type SwitchRecord = { version: 1; key: string; operation: string; runId: string; stageId: string; from: number; to: number; trigger: 'job-failure' | 'environment';
  input: string; continuation: { stageId: string; job: number; runs: number }[]; reason: string; state: SwitchState; owner: { pid: number; at: string };
  createdAt: string; updatedAt: string; write: { operation: string | null; status: string; reason: string | null } | null;
  attempts: { at: string; input: string; status: string; reason: string | null }[]; conflicts: { at: string; input: string }[] };
const switchDirectory = (privateDirectory: string) => join(privateDirectory, 'stage-runs', 'switches');
const switchFile = (privateDirectory: string, key: string) => /^[a-f0-9]{64}$/.test(key) ? join(switchDirectory(privateDirectory), `${key}.json`) : fail('switch-key-invalid');
export const switchKey = (operation: string, runId: string, stageId: string, from: number, to: number) =>
  createHash('sha256').update(['maa-skills-switch', operation, runId, stageId, String(from), String(to)].join('\n')).digest('hex');
/** A switch left `writing` by a process that is gone was interrupted: its write outcome is unknown and is never resumed. */
function settleSwitch(record: SwitchRecord): boolean {
  if (record.state !== 'writing' || alive(record.owner.pid)) return false;
  record.state = 'interrupted'; record.updatedAt = new Date().toISOString();
  return true;
}
async function readSwitch(privateDirectory: string, key: string): Promise<SwitchRecord | null> {
  let content: string;
  try { content = await readFile(switchFile(privateDirectory, key), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(content) as SwitchRecord;
  if (value.version !== 1 || value.key !== key) fail('switch-record-invalid');
  return value;
}
async function saveSwitch(privateDirectory: string, record: SwitchRecord, create = false) {
  await mkdir(switchDirectory(privateDirectory), { recursive: true });
  const file = switchFile(privateDirectory, record.key), bytes = JSON.stringify(record, null, 2) + '\n';
  if (create) { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } return; }
  const temporary = join(switchDirectory(privateDirectory), `${record.key}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
/** The batch's switches as the gate sees them. An unreadable ledger file blocks every batch: its owner cannot be told. */
async function batchSwitches(privateDirectory: string, operation: string): Promise<SwitchView[]> {
  let names: string[] = [];
  try { names = (await readdir(switchDirectory(privateDirectory))).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); } catch { return []; }
  const views: SwitchView[] = [];
  for (const name of names) {
    const record = await readSwitch(privateDirectory, name.slice(0, -5)).catch(() => null);
    if (!record) { views.push({ key: name.slice(0, -5), runId: '', stageId: '', from: 0, to: 0, trigger: 'job-failure', state: 'unknown', operation: null, started: false }); continue; }
    if (record.operation !== operation) continue;
    settleSwitch(record);
    const target = record.state === 'prepared' ? record.write?.operation ?? null : null;
    views.push({ key: record.key, runId: record.runId, stageId: record.stageId, from: record.from, to: record.to, trigger: record.trigger, state: record.state,
      operation: target, started: !!target && (await operationRecords(privateDirectory, target)).length > 0 });
  }
  return views;
}
async function fileLines(path: string): Promise<string[]> {
  const lines: string[] = [];
  try {
    const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    /** The first line dates the file; only lines naming Copilot can submit or load a job file. */
    for await (const line of reader) if (!lines.length || line.includes('Copilot')) lines.push(line);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return lines;
}
/**
 * The evidence `rerunGate` decides from. Records are read from disk except `current`, which is newer in memory. With
 * records, the Core log is read from the batch's earliest anchor; before the first record, the current and rotated Core
 * logs are searched for the batch's approved job files mentioned since the preparation began. Any read failure leaves
 * the evidence unavailable.
 */
async function batchViewFor(maaDirectory: string, privateDirectory: string, operation: string, current?: StageRunRecord): Promise<BatchView> {
  const records = (await operationRecords(privateDirectory, operation)).filter(record => record.runId !== current?.runId);
  if (current) records.push(current);
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const switches = await batchSwitches(privateDirectory, operation);
  try {
    const evidence = emptyBatchEvidence(), { plan, profileName, preparedAt } = await preparedBatch(privateDirectory, operation);
    const first = records[0];
    if (first) {
      const read = await readLogSince(maaDirectory, 'asst', first.anchors.asst);
      if (read.gap) evidence.gaps.push(read.gap);
      scanBatchLines(evidence, read.lines);
    } else {
      const lines = [...await fileLines(join(maaDirectory, logFiles.asst.rotated)), ...await fileLines(join(maaDirectory, logFiles.asst.current))];
      const files = new Set(approvedJobList(plan, privateDirectory).map(item => fileKey(item.FilePath)));
      const since = Date.parse(preparedAt), { earliest, mentioned } = scanBeforeTracking(lines, files, since);
      evidence.beforeTracking = mentioned ? 'batch-may-have-run' : !Number.isFinite(since) || Number.isFinite(earliest) && earliest > since ? 'batch-evidence-incomplete' : null;
    }
    evidence.ticks = (await listCheck(maaDirectory, privateDirectory, plan, profileName)).ticks;
    return { records: records.map(view), evidence, switches };
  } catch { return { records: records.map(view), evidence: null, switches }; }
}
/** The batch as `rerunGate` sees it, for the run's operation (read-only). */
export async function loadBatchView(paths: Paths, runId: string): Promise<{ batch: BatchView }> {
  const record = await readStageRun(paths.privateDirectory, runId);
  return { batch: await batchViewFor(paths.maaDirectory, paths.privateDirectory, record.batch.operation) };
}
/** Reads the log lines that arrived since the record's cursors; the process state is applied when a boundary is given. */
async function refresh(record: StageRunRecord, maaDirectory: string, maa?: Pick<MaaProcess, 'inspect'>) {
  const now = new Date().toISOString();
  let activity = false;
  for (const log of ['gui', 'asst'] as const) {
    const read = await readLogSince(maaDirectory, log, record.cursors[log]);
    if (read.gap) applyGap(record.state, log, read.gap, now);
    if (read.rotated) record.state.rotated = true;
    if (read.lines.length) activity = true;
    if (log === 'gui') applyGuiLines(record.state, read.lines); else applyCoreLines(record.state, record.batch.list, read.lines, now);
    record.cursors[log] = read.cursor;
  }
  if (activity) record.lastActivityAt = now;
  if (maa) try { applyProcess(record.state, (await maa.inspect()).running, now, now); } catch { /* An unreadable process state proves nothing. */ }
  record.lastObservedAt = now;
}

export async function readStageRun(privateDirectory: string, runId?: string): Promise<StageRunRecord> {
  if (runId === undefined) {
    let names: string[] = [];
    try { names = (await readdir(join(privateDirectory, 'stage-runs'))).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)); } catch { /* none yet */ }
    const records = await Promise.all(names.map(name => readStageRun(privateDirectory, name.slice(0, -5))));
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? fail('run-not-found');
  }
  let content: string;
  try { content = await readFile(runFile(privateDirectory, runId), 'utf8'); } catch { return fail('run-not-found'); }
  const value = JSON.parse(content) as StageRunRecord;
  if (value.version !== 1 || value.runId !== runId) fail('run-record-invalid');
  return value;
}

/** Without `batch` only stopping is offered: every other decision is judged from the batch-wide evidence. */
export function summarizeStageRun(record: StageRunRecord, batch: BatchView | null = null, now = new Date()) {
  const derived = deriveRun(view(record), batch);
  return { runId: record.runId, createdAt: record.createdAt, reference: record.reference, retryOf: record.retryOf,
    batch: { operation: record.batch.operation, reportHash: record.batch.reportHash, map: record.batch.map,
      stages: record.batch.stages.map(stage => ({ stageId: stage.stageId, code: stage.code, loops: stage.loops })) },
    ...derived, screenshots: record.screenshots,
    findings: record.state.findings.map(({ reported: _reported, ...finding }) => finding),
    userReports: record.userReports, verifications: record.verifications, decisions: record.decisions, processExitCode: record.processExitCode,
    quietSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(record.lastActivityAt)) / 1000)) };
}
/** What MAA proved per stage, which decisions the record allows, each stage's current and next approved candidate, and its switch. */
export function stageRunOutcome(record: StageRunRecord, batch: BatchView | null = null) {
  const summary = summarizeStageRun(record, batch);
  return { runId: record.runId, operation: record.batch.operation, execution: summary.execution, allowedDecisions: summary.allowedDecisions,
    lastDecision: record.decisions.at(-1) ?? null, medicine: summary.medicine, switch: summary.switch,
    stages: record.batch.stages.map((stage, index) => ({ ...stage, result: summary.stages[index]!.result, stageCheck: summary.stages[index]!.stageCheck,
      job: summary.alternates[index]!.job, next: summary.alternates[index]!.next })) };
}

export async function startStageRun(input: Paths & { operation: string; reference: string; retryOf?: string }) {
  const operation = text(input.operation, 64, 'operation-invalid'), reference = text(input.reference, 500, 'reference-required');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(operation)) fail('operation-invalid');
  const { plan, profileName } = await preparedBatch(input.privateDirectory, operation);
  await verifyApprovedJobFiles(plan, input.privateDirectory);
  const check = await listCheck(input.maaDirectory, input.privateDirectory, plan, profileName);
  if (check.result !== 'matches' && check.result !== 'subset') fail('prepared-list-changed');
  const retryOf = input.retryOf === undefined ? null : text(input.retryOf, 36, 'run-id-invalid');
  return withOperation(input.privateDirectory, operation, async () => {
    for (const earlier of await operationRecords(input.privateDirectory, operation)) {
      if (deriveRun(view(earlier), null).execution !== 'tracking') continue;
      await withRun(input.privateDirectory, earlier.runId, async current => { await refresh(current, input.maaDirectory); await save(input.privateDirectory, current); });
    }
    /** The new run's start is fixed before the gate reads the logs, so no line falls between what was judged and what is tracked. */
    const anchors = { asst: await captureLogCursor(input.maaDirectory, 'asst'), gui: await captureLogCursor(input.maaDirectory, 'gui') };
    const gate = rerunGate(await batchViewFor(input.maaDirectory, input.privateDirectory, operation), { kind: 'start', retryOf });
    if (!gate.allowed) fail(gate.reason);
    return createRun(input, operation, reference, retryOf, plan, check, anchors);
  });
}
async function createRun(input: Paths, operation: string, reference: string, retryOf: string | null, plan: ApprovedJobPlan,
  check: { profile: number; result: 'matches' | 'subset' }, anchors: Record<LogName, LogCursor>) {
  const createdAt = new Date().toISOString();
  const list: RunList = approvedJobEntries(plan, input.privateDirectory).map(({ stageId, job, item }) =>
    ({ index: item.Index, stageId, code: item.Name, jobId: job, fileKey: fileKey(item.FilePath) }));
  const record: StageRunRecord = { version: 1, runId: randomUUID(), createdAt, reference, retryOf, maaDirectory: input.maaDirectory,
    batch: { operation, reportHash: plan.reportHash, map: plan.map, profile: check.profile, listCheck: check.result,
      stages: approvedJobStages(plan).map(stage => ({ stageId: stage.stageId, code: stage.code, loops: stage.loops, primary: stage.primary, alternates: stage.alternates })), list },
    anchors, cursors: structuredClone(anchors), state: emptyRunState(), userReports: [], screenshots: [], verifications: [], decisions: [],
    lastObservedAt: null, lastActivityAt: createdAt, processExitCode: null };
  await save(input.privateDirectory, record, true);
  return summarizeStageRun(record, await batchViewFor(input.maaDirectory, input.privateDirectory, operation, record));
}

const images = /\.(?:png|jpe?g|bmp)$/i;
/** Paths of images MAA itself saved under debug/ since the run started. They are listed, never opened. */
async function screenshots(maaDirectory: string, since: string): Promise<string[]> {
  const found: { path: string; time: number }[] = [], start = Date.parse(since) - 1000;
  const walk = async (relativeDirectory: string, depth: number) => {
    let entries;
    try { entries = await readdir(join(maaDirectory, relativeDirectory), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const name = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory() && depth < 3) await walk(name, depth + 1);
      else if (entry.isFile() && images.test(entry.name)) {
        const info = await stat(join(maaDirectory, name)).catch(() => null);
        if (info && info.mtimeMs >= start) found.push({ path: name, time: info.mtimeMs });
      }
    }
  };
  await walk('debug', 0);
  return found.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path)).slice(0, maxScreenshots).map(item => item.path);
}

export async function observeStageRun(input: Paths & { runId: string; waitSeconds?: number; userReport?: { kind: 'manual-play' | 'manual-login'; quote: string }; processExitCode?: number },
  maa: Pick<MaaProcess, 'inspect'>) {
  const wait = input.waitSeconds ?? 0;
  if (!Number.isInteger(wait) || wait < 0 || wait > maxWaitSeconds) fail('wait-invalid');
  if (input.userReport !== undefined && (!['manual-play', 'manual-login'].includes(input.userReport?.kind) || typeof input.userReport.quote !== 'string' || input.userReport.quote.length > 200)) fail('user-report-invalid');
  if (input.processExitCode !== undefined && !Number.isSafeInteger(input.processExitCode)) fail('exit-code-invalid');
  return withRun(input.privateDirectory, input.runId, async record => {
    const deadline = Date.now() + wait * 1000;
    if (input.userReport) {
      const at = new Date().toISOString();
      record.userReports.push({ at, kind: input.userReport.kind, quote: input.userReport.quote });
      applyUserReport(record.state, input.userReport.kind, at);
    }
    if (input.processExitCode !== undefined) record.processExitCode = input.processExitCode;
    for (;;) {
      await refresh(record, input.maaDirectory, maa);
      const derived = deriveRun(view(record), null);
      if (record.state.findings.some(finding => !finding.reported) || derived.execution !== 'tracking' || Date.now() >= deadline) break;
      await save(input.privateDirectory, record);
      await new Promise(done => setTimeout(done, Math.min(2000, Math.max(0, deadline - Date.now()))));
    }
    record.screenshots = await screenshots(input.maaDirectory, record.createdAt);
    const newFindings = record.state.findings.filter(finding => !finding.reported).map(({ reported: _reported, ...finding }) => finding);
    for (const finding of record.state.findings) finding.reported = true;
    await save(input.privateDirectory, record);
    return { ...summarizeStageRun(record, await batchViewFor(input.maaDirectory, input.privateDirectory, record.batch.operation, record)), newFindings };
  });
}

/** Re-reads current state only. Approval-time sanity, medicine, originium and stage progress are not reused. */
export async function verifyStageRun(input: Paths & { runId: string }, maa: MaaProcess) {
  return withRun(input.privateDirectory, input.runId, async record => {
    let process: Verification['process'] = null;
    try { const state = await maa.inspect(); process = { running: state.running, idle: state.idle }; } catch { /* unknown */ }
    let preparedList: Verification['preparedList'] = 'unreadable';
    try {
      const { plan, profileName } = await preparedBatch(input.privateDirectory, record.batch.operation);
      await verifyApprovedJobFiles(plan, input.privateDirectory);
      preparedList = (await listCheck(input.maaDirectory, input.privateDirectory, plan, profileName)).result;
    } catch { preparedList = 'changed'; }
    const checks = (await runChecks({ maaDirectory: input.maaDirectory, privateDirectory: input.privateDirectory }, maa)).checks;
    let accountSnapshotReadAt: string | null = null;
    try { const value = object(JSON.parse(await readFile(join(input.privateDirectory, 'account-snapshot.json'), 'utf8'))).readAt; accountSnapshotReadAt = typeof value === 'string' ? value : null; }
    catch { /* no snapshot */ }
    const verification: Verification = { at: new Date().toISOString(), process, preparedList, checks, unknown: unknownState, accountSnapshotReadAt,
      clear: !!process?.running && (preparedList === 'matches' || preparedList === 'subset') && checks.every(check => check.status !== 'error') };
    record.verifications.push(verification);
    await save(input.privateDirectory, record);
    return { ...summarizeStageRun(record, await batchViewFor(input.maaDirectory, input.privateDirectory, record.batch.operation, record)), verification };
  });
}

/**
 * Opens the run for a gate decision: holds the batch's operation lock and the run lock, reads the logs first when the run
 * is still tracking, and judges from the batch-wide evidence. The MAA directory is the one the run was started with.
 */
async function withJudgedRun<T>(input: { privateDirectory: string; maaDirectory?: string; runId: string },
  work: (record: StageRunRecord, batch: BatchView, maaDirectory: string) => Promise<T>): Promise<T> {
  const { operation } = (await readStageRun(input.privateDirectory, input.runId)).batch;
  return withOperation(input.privateDirectory, operation, () => withRun(input.privateDirectory, input.runId, async record => {
    const maaDirectory = input.maaDirectory ?? record.maaDirectory ?? fail('maa-directory-required');
    if (deriveRun(view(record), null).execution === 'tracking') { await refresh(record, maaDirectory); await save(input.privateDirectory, record); }
    return work(record, await batchViewFor(maaDirectory, input.privateDirectory, operation, record), maaDirectory);
  }));
}

/**
 * Records the model's decision after `rerunGate` allows it. Stopping a run that is still tracking is allowed only before
 * its task chain starts; the logs are read first, and the closed record attributes no later lines.
 */
export async function decideStageRun(input: { privateDirectory: string; maaDirectory?: string; runId: string; decision: Decision; reason: string }) {
  if (!decisions.includes(input.decision)) fail('decision-invalid');
  const reason = text(input.reason, 500, 'reason-required');
  return withJudgedRun(input, async (record, batch, maaDirectory) => {
    if (!rerunGate(batch, { kind: 'decide', runId: record.runId, decision: input.decision }).allowed) fail('decision-not-allowed');
    const at = new Date().toISOString();
    if (deriveRun(view(record), null).execution === 'tracking') record.state.closed = { at, reason: 'closed-before-start' };
    record.decisions.push({ at, decision: input.decision, reason });
    await save(input.privateDirectory, record);
    return summarizeStageRun(record, await batchViewFor(maaDirectory, input.privateDirectory, record.batch.operation, record));
  });
}

/**
 * The user's own statement of how many runs of each stage finished in this batch so far, after an unknown outcome. It is
 * the only thing that settles an attempt that may have fought; it never changes what MAA reported, may not be lower than
 * what callbacks prove, and the quote is kept with the record.
 */
export async function recordStageProgress(input: { privateDirectory: string; maaDirectory?: string; runId: string; reference: string; stages: { stageId: string; completedRuns: number }[] }) {
  const quote = text(input.reference, 500, 'reference-required');
  return withJudgedRun(input, async (record, batch, maaDirectory) => {
    const stages = Array.isArray(input.stages) ? input.stages : [];
    const seen = new Set<string>();
    if (!stages.length || stages.some(item => {
      const stage = record.batch.stages.find(value => value.stageId === item?.stageId);
      const valid = !!stage && !seen.has(stage.stageId) && Number.isSafeInteger(item.completedRuns) && item.completedRuns >= 0 && item.completedRuns <= stage.loops;
      if (stage) seen.add(stage.stageId);
      return !valid;
    })) fail('progress-invalid');
    const statement = stages.map(item => ({ stageId: item.stageId, completedRuns: item.completedRuns }));
    const gate = rerunGate(batch, { kind: 'progress', runId: record.runId, stages: statement });
    if (!gate.allowed) fail(gate.reason);
    record.state.progress.push({ at: new Date().toISOString(), quote, stages: statement });
    await save(input.privateDirectory, record);
    return summarizeStageRun(record, await batchViewFor(maaDirectory, input.privateDirectory, record.batch.operation, record));
  });
}

function switchSummary(record: SwitchRecord, repeated: boolean) {
  const next = record.state === 'prepared' ? 'start-alternate' : record.state === 'rejected' ? 'retry-switch' : 'verify';
  return { key: record.key, state: record.state, stageId: record.stageId, from: record.from, to: record.to, trigger: record.trigger, runs: record.continuation,
    operation: record.state === 'prepared' ? record.write?.operation ?? null : null, start: 'user' as const, next, repeated, unknown: unknownState,
    write: record.write && { status: record.write.status, reason: record.write.reason }, conflicts: record.conflicts.length };
}
/**
 * Ticket 17: carries out a recorded `switch-alternate` decision. The stage's next approved candidate replaces its job for
 * the runs it still has, the other stages keep theirs, and the list is written only through the unified writer with the
 * batch's own approval (no new medicine, stone or other setting). MAA v6.21.4 has no native way to go on with another job
 * after a failure (docs/stage-alternates-sources.md), so the user clicks start; `start` with the returned operation first.
 * Idempotent per key: the same key and input return the existing record; a different input is refused and both digests
 * stay in the record. Only a write the writer refused before writing may be requested again.
 */
export async function switchStageRun(input: { privateDirectory: string; maaDirectory?: string; runId: string; stageId: string; expectedRevision: string; host: 'codex' | 'claude';
  closedConfirmed?: boolean }, maa: MaaProcess) {
  const stageId = text(input.stageId, 64, 'stage-invalid');
  if (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) fail('revision-required');
  if (!['codex', 'claude'].includes(input.host) || input.closedConfirmed !== undefined && typeof input.closedConfirmed !== 'boolean') fail('request-invalid');
  return withJudgedRun(input, async (record, batch, maaDirectory) => {
    const current = view(record);
    const candidate = stageCandidates(current).find(item => item.stageId === stageId) ?? fail('stage-invalid');
    if (candidate.job === null || candidate.next === null) fail('alternates-exhausted');
    const key = switchKey(record.batch.operation, record.runId, stageId, candidate.job, candidate.next);
    const target = switchTarget(current, batch), continuation = 'reason' in target ? null : target.continuation;
    const digest = createHash('sha256').update(JSON.stringify({ runId: record.runId, stageId, from: candidate.job, to: candidate.next, continuation,
      expectedRevision: input.expectedRevision })).digest('hex');
    const now = () => new Date().toISOString();
    const existing = await readSwitch(input.privateDirectory, key);
    if (existing && existing.state !== 'rejected') {
      if (settleSwitch(existing)) await saveSwitch(input.privateDirectory, existing);
      if (existing.input === digest) return switchSummary(existing, true);
      existing.conflicts.push({ at: now(), input: digest });
      await saveSwitch(input.privateDirectory, existing);
      fail('idempotency-conflict');
    }
    const gate = rerunGate(batch, { kind: 'switch', runId: record.runId, stageId });
    if (!gate.allowed || 'reason' in target) fail(gate.allowed ? 'no-stage-to-switch' : gate.reason);
    const { plan, approval } = await preparedBatch(input.privateDirectory, record.batch.operation);
    if (!approval.reference.trim()) fail('batch-not-prepared');
    const next: ApprovedJobPlan = { reportHash: plan.reportHash, map: plan.map, entries: plan.entries,
      continuation: { from: { operation: record.batch.operation, runId: record.runId, key }, stages: target.continuation } };
    const list = approvedJobList(next, input.privateDirectory);
    const entry: SwitchRecord = { version: 1, key, operation: record.batch.operation, runId: record.runId, stageId, from: target.from, to: target.to, trigger: target.trigger,
      input: digest, continuation: target.continuation, reason: record.decisions.at(-1)!.reason, state: 'writing', owner: { pid: process.pid, at: now() },
      createdAt: existing?.createdAt ?? now(), updatedAt: now(), write: null, attempts: existing?.attempts ?? [], conflicts: existing?.conflicts ?? [] };
    await saveSwitch(input.privateDirectory, entry, !existing);
    let result: { status: string; operation?: string; reason?: string | null };
    try {
      result = await executeConfigWrite({ maaDirectory, privateDirectory: input.privateDirectory, host: input.host, expectedRevision: input.expectedRevision,
        closedConfirmed: input.closedConfirmed, authorization: { source: approval.source, reference: approval.reference, jobPlan: next },
        changes: [{ path: ['Configurations', record.batch.profile, 'Copilot', 'TaskList'], value: list }, { path: ['Configurations', record.batch.profile, 'Copilot', 'EnableUserAdditional'], value: false }] }, maa);
    } catch { result = { status: 'unknown', reason: 'reconciliation-required' }; }
    entry.state = result.status === 'complete' ? 'prepared' : result.status === 'unknown' ? 'unknown' : 'rejected';
    entry.write = { operation: result.operation ?? null, status: result.status, reason: result.reason ?? null };
    entry.attempts.push({ at: now(), input: digest, status: result.status, reason: result.reason ?? null });
    entry.updatedAt = now();
    await saveSwitch(input.privateDirectory, entry);
    return switchSummary(entry, false);
  });
}

const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  const known = /^[a-z][a-z-]{2,48}$/;
  try {
    const action = process.argv[2];
    if (process.argv.length !== 3 || !['start', 'observe', 'verify', 'decide', 'progress', 'switch', 'read'].includes(action!)) fail('action-invalid');
    let raw = ''; for await (const chunk of process.stdin) { raw += String(chunk); if (Buffer.byteLength(raw) > 65536) fail('input-too-large'); }
    const input = object(JSON.parse(raw || '{}'));
    const allowed: Record<string, string[]> = { start: ['operation', 'reference', 'retryOf'], observe: ['runId', 'waitSeconds', 'userReport', 'processExitCode'],
      verify: ['runId'], decide: ['runId', 'decision', 'reason'], progress: ['runId', 'reference', 'stages'], switch: ['runId', 'stageId', 'expectedRevision', 'host', 'closedConfirmed'],
      read: ['runId'] };
    if (Object.keys(input).some(key => !allowed[action!]!.includes(key))) fail('request-invalid');
    const settings = await readSettings();
    const paths = { maaDirectory: settings.maaDirectory ?? fail('maa-directory-unset'), privateDirectory: settings.privateDirectory };
    let boundary: MaaProcess | undefined;
    const get = async () => boundary ??= (await import('./maa-process.ts')).createMaaProcess(paths.maaDirectory);
    /** Only `switch` may close and reopen MAA, and only inside the unified writer; tracking never does. */
    const writer = action === 'switch';
    const maa: MaaProcess = { inspect: async () => (await get()).inspect(), close: async () => writer ? (await get()).close() : fail('close-not-allowed'),
      start: async () => writer ? (await get()).start() : fail('start-not-allowed') };
    let result: unknown;
    if (action === 'switch') result = await switchStageRun({ ...paths, ...input } as Parameters<typeof switchStageRun>[0], maa);
    else if (action === 'start') result = await startStageRun({ ...paths, ...input } as Parameters<typeof startStageRun>[0]);
    else if (action === 'observe') result = await observeStageRun({ ...paths, ...input } as Parameters<typeof observeStageRun>[0], maa);
    else if (action === 'verify') result = await verifyStageRun({ ...paths, runId: input.runId as string }, maa);
    else if (action === 'decide') result = await decideStageRun({ ...paths, ...input } as Parameters<typeof decideStageRun>[0]);
    else if (action === 'progress') result = await recordStageProgress({ ...paths, ...input } as Parameters<typeof recordStageProgress>[0]);
    else {
      const record = await readStageRun(paths.privateDirectory, input.runId === undefined ? undefined : text(input.runId, 36, 'run-id-invalid'));
      result = summarizeStageRun(record, (await loadBatchView(paths, record.runId)).batch);
    }
    console.log(JSON.stringify({ ok: true, ...object(result) }));
  } catch (error) {
    const reason = error instanceof Error && known.test(error.message) ? error.message : 'check-required';
    console.log(JSON.stringify({ ok: false, status: 'check-required', reason })); process.exitCode = 1;
  }
}
