import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MaaProcess } from './maa-config.ts';
import { runChecks } from './doctor.ts';
import { captureLogCursor, readLogSince, type LogCursor, type LogName } from './maa-log-window.ts';
import { approvedJobList, verifyApprovedJobFiles, type ApprovedJobPlan } from './stage-job-plan.ts';
import { applyCoreLines, applyGap, applyGuiLines, applyProcess, applyUserReport, deriveRun, emptyRunState, fileKey,
  type Decision, type DecisionRecord, type RunList, type RunState, type Verification } from './stage-run-state.ts';
import { readSettings } from './preferences.ts';

/**
 * Tracks one prepared copilot batch from the user's start signal to a result. Read-only towards MAA: it reads the
 * configuration summary and MAA's own logs, inspects the process, and never starts, stops, clicks or rewrites anything.
 * The run record in `<private>/stage-runs/<runId>.json` is the seam for ticket 17 (approved alternates):
 * `readStageRun`, `summarizeStageRun`, `stageRunOutcome` and the `StageRunRecord` type.
 */
export type StageRunRecord = {
  version: 1; runId: string; createdAt: string; reference: string; retryOf: string | null;
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
const maxWaitSeconds = 600, maxScreenshots = 20;
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
  const done = (await jsonLines(join(privateDirectory, 'daily-runs.jsonl'))).some(entry => entry.operation === operation && entry.status === 'complete');
  const pending = (await jsonLines(join(privateDirectory, 'daily-pending.jsonl'))).find(entry => entry.id === operation);
  const plan = object(object(pending?.authorization).jobPlan) as unknown as ApprovedJobPlan;
  const change = (Array.isArray(pending?.changes) ? pending.changes : []).map(object).find(item => Array.isArray(item.path) && item.path.length === 4
    && item.path[0] === 'Configurations' && item.path[2] === 'Copilot' && item.path[3] === 'TaskList');
  const profileName = Array.isArray(change?.path) ? change.path[1] : undefined;
  if (!done || !pending || !Array.isArray(plan.entries) || typeof profileName !== 'string') fail('batch-not-prepared');
  return { plan, profileName: profileName as string };
}
type ListItem = { Name?: unknown; FilePath?: unknown; CopilotId?: unknown; IsRaid?: unknown; Index?: unknown; IsNavNameOverride?: unknown; IsChecked?: unknown };
async function listCheck(maaDirectory: string, privateDirectory: string, plan: ApprovedJobPlan, profileName: string) {
  let profile = -1, current: unknown;
  try {
    const config = object(JSON.parse((await readFile(join(maaDirectory, 'config', 'gui.new.json'), 'utf8')).replace(/^﻿/, '')));
    const profiles = object(config.Configurations);
    profile = Object.keys(profiles).indexOf(profileName);
    current = object(object(profiles[profileName]).Copilot).TaskList;
  } catch { return { profile, result: 'unreadable' as const }; }
  const expected = approvedJobList(plan, privateDirectory);
  if (profile < 0 || !Array.isArray(current)) return { profile, result: 'unreadable' as const };
  const items = current.map(item => object(item) as ListItem);
  const same = (a: ListItem, b: ListItem) => a.Name === b.Name && typeof a.FilePath === 'string' && typeof b.FilePath === 'string' && fileKey(a.FilePath) === fileKey(b.FilePath)
    && a.CopilotId === b.CopilotId && a.IsRaid === b.IsRaid && a.Index === b.Index && (a.IsNavNameOverride ?? false) === b.IsNavNameOverride;
  if (items.length !== expected.length || !expected.every((item, index) => same(items[index]!, item))) return { profile, result: 'changed' as const };
  return { profile, result: items.every(item => item.IsChecked === true) ? 'matches' as const : 'subset' as const };
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
/** One writer per run record: a second concurrent observer would count the same log lines twice. */
async function withRun<T>(privateDirectory: string, runId: string, work: (record: StageRunRecord) => Promise<T>): Promise<T> {
  const file = runFile(privateDirectory, runId), lock = `${file.slice(0, -5)}.lock`;
  let handle;
  for (let attempt = 0; attempt < 2 && !handle; attempt++) {
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number(object(JSON.parse(await readFile(lock, 'utf8').catch(() => '{}'))).pid);
      if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) fail('run-busy');
      await unlink(lock).catch(() => undefined);
    }
  }
  if (!handle) return fail('run-busy');
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); await handle.close(); handle = undefined;
    return await work(await readStageRun(privateDirectory, runId));
  } finally { if (handle) await handle.close(); await unlink(lock).catch(() => undefined); }
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

export function summarizeStageRun(record: StageRunRecord, now = new Date()) {
  const derived = deriveRun(record.state, record.batch.list, record.batch.stages, record.verifications, record.decisions);
  return { runId: record.runId, createdAt: record.createdAt, reference: record.reference, retryOf: record.retryOf,
    batch: { operation: record.batch.operation, reportHash: record.batch.reportHash, map: record.batch.map,
      stages: record.batch.stages.map(stage => ({ stageId: stage.stageId, code: stage.code, loops: stage.loops })) },
    ...derived, screenshots: record.screenshots,
    findings: record.state.findings.map(({ reported: _reported, ...finding }) => finding),
    userReports: record.userReports, verifications: record.verifications, decisions: record.decisions, processExitCode: record.processExitCode,
    quietSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(record.lastActivityAt)) / 1000)) };
}
/** For ticket 17: what MAA proved per stage and which decisions the record allows. Switching itself is not done here. */
export function stageRunOutcome(record: StageRunRecord) {
  const summary = summarizeStageRun(record);
  return { runId: record.runId, operation: record.batch.operation, execution: summary.execution, allowedDecisions: summary.allowedDecisions,
    lastDecision: record.decisions.at(-1) ?? null, medicine: summary.medicine,
    stages: record.batch.stages.map((stage, index) => ({ ...stage, result: summary.stages[index]!.result, stageCheck: summary.stages[index]!.stageCheck })) };
}

export async function startStageRun(input: Paths & { operation: string; reference: string; retryOf?: string }) {
  const operation = text(input.operation, 64, 'operation-invalid'), reference = text(input.reference, 500, 'reference-required');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(operation)) fail('operation-invalid');
  const { plan, profileName } = await preparedBatch(input.privateDirectory, operation);
  await verifyApprovedJobFiles(plan, input.privateDirectory);
  const check = await listCheck(input.maaDirectory, input.privateDirectory, plan, profileName);
  if (check.result !== 'matches' && check.result !== 'subset') fail('prepared-list-changed');
  if (input.retryOf !== undefined) {
    const previous = await readStageRun(input.privateDirectory, text(input.retryOf, 36, 'run-id-invalid'));
    let names: string[] = [];
    try { names = (await readdir(join(input.privateDirectory, 'stage-runs'))).filter(name => name.endsWith('.json')); } catch { /* none */ }
    const others = await Promise.all(names.map(name => readStageRun(input.privateDirectory, name.slice(0, -5)).catch(() => null)));
    if (previous.batch.operation !== operation || previous.decisions.at(-1)?.decision !== 'retry-within-approval'
      || others.some(other => other?.retryOf === previous.runId)) fail('retry-not-decided');
  }
  const createdAt = new Date().toISOString();
  const anchors = { asst: await captureLogCursor(input.maaDirectory, 'asst'), gui: await captureLogCursor(input.maaDirectory, 'gui') };
  const expanded = approvedJobList(plan, input.privateDirectory);
  const list: RunList = expanded.map(item => {
    const entry = plan.entries.find(value => value.primary.id === item.CopilotId && value.code === item.Name)!;
    return { index: item.Index, stageId: entry.stageId, code: entry.code, jobId: item.CopilotId, fileKey: fileKey(item.FilePath) };
  });
  const record: StageRunRecord = { version: 1, runId: randomUUID(), createdAt, reference, retryOf: input.retryOf ?? null,
    batch: { operation, reportHash: plan.reportHash, map: plan.map, profile: check.profile, listCheck: check.result,
      stages: plan.entries.map(entry => ({ stageId: entry.stageId, code: entry.code, loops: entry.loops, primary: entry.primary.id, alternates: entry.alternates.map(job => job.id) })), list },
    anchors, cursors: structuredClone(anchors), state: emptyRunState(), userReports: [], screenshots: [], verifications: [], decisions: [],
    lastObservedAt: null, lastActivityAt: createdAt, processExitCode: null };
  await save(input.privateDirectory, record, true);
  return summarizeStageRun(record);
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
      const now = new Date().toISOString();
      let activity = false;
      for (const log of ['gui', 'asst'] as const) {
        const read = await readLogSince(input.maaDirectory, log, record.cursors[log]);
        if (read.gap) applyGap(record.state, log, read.gap, now);
        if (read.rotated) record.state.rotated = true;
        if (read.lines.length) activity = true;
        if (log === 'gui') applyGuiLines(record.state, read.lines); else applyCoreLines(record.state, record.batch.list, read.lines, now);
        record.cursors[log] = read.cursor;
      }
      if (activity) record.lastActivityAt = now;
      try { applyProcess(record.state, (await maa.inspect()).running, now, now); } catch { /* An unreadable process state proves nothing. */ }
      record.lastObservedAt = now;
      const derived = deriveRun(record.state, record.batch.list, record.batch.stages, record.verifications, record.decisions);
      if (record.state.findings.some(finding => !finding.reported) || derived.execution !== 'tracking' || Date.now() >= deadline) break;
      await save(input.privateDirectory, record);
      await new Promise(done => setTimeout(done, Math.min(2000, Math.max(0, deadline - Date.now()))));
    }
    record.screenshots = await screenshots(input.maaDirectory, record.createdAt);
    const newFindings = record.state.findings.filter(finding => !finding.reported).map(({ reported: _reported, ...finding }) => finding);
    for (const finding of record.state.findings) finding.reported = true;
    await save(input.privateDirectory, record);
    return { ...summarizeStageRun(record), newFindings };
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
    return { ...summarizeStageRun(record), verification };
  });
}

export async function decideStageRun(input: { privateDirectory: string; runId: string; decision: Decision; reason: string }) {
  if (!decisions.includes(input.decision)) fail('decision-invalid');
  const reason = text(input.reason, 500, 'reason-required');
  return withRun(input.privateDirectory, input.runId, async record => {
    if (!summarizeStageRun(record).allowedDecisions.includes(input.decision)) fail('decision-not-allowed');
    record.decisions.push({ at: new Date().toISOString(), decision: input.decision, reason });
    await save(input.privateDirectory, record);
    return summarizeStageRun(record);
  });
}

const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  const known = /^[a-z][a-z-]{2,48}$/;
  try {
    const action = process.argv[2];
    if (process.argv.length !== 3 || !['start', 'observe', 'verify', 'decide', 'read'].includes(action!)) fail('action-invalid');
    let raw = ''; for await (const chunk of process.stdin) { raw += String(chunk); if (Buffer.byteLength(raw) > 65536) fail('input-too-large'); }
    const input = object(JSON.parse(raw || '{}'));
    const allowed: Record<string, string[]> = { start: ['operation', 'reference', 'retryOf'], observe: ['runId', 'waitSeconds', 'userReport', 'processExitCode'],
      verify: ['runId'], decide: ['runId', 'decision', 'reason'], read: ['runId'] };
    if (Object.keys(input).some(key => !allowed[action!]!.includes(key))) fail('request-invalid');
    const settings = await readSettings();
    const paths = { maaDirectory: settings.maaDirectory ?? fail('maa-directory-unset'), privateDirectory: settings.privateDirectory };
    let boundary: MaaProcess | undefined;
    const get = async () => boundary ??= (await import('./maa-process.ts')).createMaaProcess(paths.maaDirectory);
    const maa: MaaProcess = { inspect: async () => (await get()).inspect(), close: async () => fail('close-not-allowed'), start: async () => fail('start-not-allowed') };
    let result: unknown;
    if (action === 'start') result = await startStageRun({ ...paths, ...input } as Parameters<typeof startStageRun>[0]);
    else if (action === 'observe') result = await observeStageRun({ ...paths, ...input } as Parameters<typeof observeStageRun>[0], maa);
    else if (action === 'verify') result = await verifyStageRun({ ...paths, runId: input.runId as string }, maa);
    else if (action === 'decide') result = await decideStageRun({ privateDirectory: paths.privateDirectory, ...input } as Parameters<typeof decideStageRun>[0]);
    else result = summarizeStageRun(await readStageRun(paths.privateDirectory, input.runId === undefined ? undefined : text(input.runId, 36, 'run-id-invalid')));
    console.log(JSON.stringify({ ok: true, ...object(result) }));
  } catch (error) {
    const reason = error instanceof Error && known.test(error.message) ? error.message : 'check-required';
    console.log(JSON.stringify({ ok: false, status: 'check-required', reason })); process.exitCode = 1;
  }
}
