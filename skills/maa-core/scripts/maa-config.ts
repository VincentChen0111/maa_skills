import { access, appendFile, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSettings } from './preferences.ts';
import { approvedJobList, verifyApprovedJobFiles, type ApprovedJobPlan } from './stage-job-plan.ts';
import { buildTrainingChanges, inspectTrainingAsset, installTrainingAsset, type TrainingGrant, type TrainingAsset } from './training-config.ts';
import { prepareSetupConnection, type SetupWriteRequest, type ConnectionContext, type AdbBoundary } from './setup-connection.ts';

export type Change = { path: (string | number)[]; value: unknown };
export type WriteRequest = {
  maaDirectory: string; privateDirectory: string; host: 'codex' | 'claude';
  expectedRevision: string;
  closedConfirmed?: boolean;
  authorization: { source: 'current-request' | 'approved-report'; reference: string; medicineCount?: number; jobPlan?: ApprovedJobPlan; trainingPlan?: TrainingGrant };
  changes: Change[];
};
export type MaaState = { running: boolean; treeExited: boolean; idle: boolean; ready: boolean };
/** The only replaceable boundary: the MAA process and its runtime observations. */
export interface MaaProcess {
  inspect(): Promise<MaaState>;
  close(): Promise<void>;
  start(): Promise<void>;
}
type RecordValue = Record<string, unknown>;
function revision(config: RecordValue): string { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('configuration-invalid');
  return value as RecordValue;
}
function at(root: unknown, path: (string | number)[]): unknown {
  let value = root;
  for (const [index, key] of path.entries()) {
    if (index === 3 && path.length === 4 && path[0] === 'Timers' && path[1] === 'List' && Number.isInteger(path[2]) && key === 'IsEnabled') return timerEnabled(object(value));
    if (['__proto__', 'constructor', 'prototype'].includes(String(key)) || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('change-not-allowed');
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
function changedKey(path: (string | number)[]): string {
  return path.map((part, index) => path[0] === 'Configurations' && index === 1 ? '<profile>' : String(part)).join('.');
}
function knownTaskType(task: RecordValue): string | undefined {
  const types = ['StartUp', 'Fight', 'Infrast', 'Recruit', 'Mall', 'Award', 'UserDataUpdate', 'CloseDown', 'Roguelike', 'OperProgress'];
  return typeof task.TaskType === 'string' && types.includes(task.TaskType) && task.$type === `${task.TaskType}Task` ? task.TaskType : undefined;
}
const ordinaryTaskTypes = new Set(['Fight', 'Infrast', 'Recruit', 'Mall', 'Award', 'UserDataUpdate', 'CloseDown']);
function timerEnabled(timer: RecordValue): unknown { return Object.hasOwn(timer, 'IsEnabled') ? timer.IsEnabled : null; }
function comparableAt(config: RecordValue, path: (string | number)[]): string | undefined {
  const value = structuredClone(at(config, path));
  // Only Timer.IsEnabled has a verified omitted-null constructor/serializer equivalence.
  if (path[0] === 'Timers') {
    const timers = path.length === 1 ? object(value).List : path[1] === 'List' ? (path.length === 2 ? value : path.length === 3 ? [value] : []) : [];
    if (Array.isArray(timers)) for (const item of timers) { const timer = object(item); if (timer.IsEnabled === null) delete timer.IsEnabled; }
  }
  return JSON.stringify(value);
}
function prepare(config: RecordValue, request: WriteRequest, connectionMode?: 'setup' | 'recovery') {
  if (['medicineCount', 'jobPlan', 'trainingPlan'].filter(key => Object.hasOwn(request.authorization, key)).length > 1) throw new Error('conflicting-authorizations');
  const training = request.authorization.trainingPlan ? buildTrainingChanges(config, request.authorization.trainingPlan, request.privateDirectory) : null;
  if (training && (Object.keys(request.authorization).some(key => !['source', 'reference', 'trainingPlan'].includes(key))
    || JSON.stringify(training.changes) !== JSON.stringify(request.changes))) throw new Error('training-change-scope-mismatch');
  const next = structuredClone(config);
  const keys = new Set<string>();
  const medicineTasks = new Set<string>();
  const enabledTasks: (string | number)[][] = [];
  const dependencies: (string | number)[][] = [];
  if (training) dependencies.push(['Configurations', training.profile, 'TaskQueue'], ['Timers']);
  for (const change of request.changes) {
    if (!Array.isArray(change.path) || !change.path.length) throw new Error('change-not-allowed');
    const path = change.path;
    const key = JSON.stringify(path);
    if (keys.has(key)) throw new Error('duplicate-change');
    for (const other of request.changes) {
      if (other !== change && other.path.length < path.length && other.path.every((part, index) => part === path[index])) throw new Error('overlapping-change');
    }
    keys.add(key);
    const old = at(config, path);
    let value = change.value;
    let nullableBoolean = false;
    let allowed = path.length === 2 && path[0] === 'Timers' && path[1] === 'NotifyBeforeScheduledStart' && typeof change.value === 'boolean';
    if (path.length === 4 && path[0] === 'Configurations' && path[2] === 'Copilot' && request.authorization.jobPlan) {
      if (path[1] !== config.Current) throw new Error('job-profile-not-current');
      if (path[3] === 'TaskList') allowed = JSON.stringify(value) === JSON.stringify(approvedJobList(request.authorization.jobPlan, request.privateDirectory));
      if (path[3] === 'EnableUserAdditional') allowed = value === false;
      dependencies.push(['Current'], ['Configurations', String(path[1]), 'Copilot']);
    }
    if (path.length === 5 && path[0] === 'Configurations' && typeof path[1] === 'string' && path[2] === 'Gui' && path[3] === 'ConnectSettings') {
      if (!connectionMode || request.changes.some(item => item.path.length !== 5 || item.path[0] !== 'Configurations' || item.path[2] !== 'Gui' || item.path[3] !== 'ConnectSettings')) throw new Error('connection-route-required');
      if (connectionMode === 'setup' && (path[1] !== config.Current || request.authorization.source !== 'current-request')) throw new Error('current-connection-required');
      if (['AutoDetect', 'AlwaysAutoDetect'].includes(String(path[4]))) allowed = typeof value === 'boolean';
      // MAA also stores empty/relative adb paths; recovery must be able to restore those originals.
      if (path[4] === 'AdbPath') allowed = typeof value === 'string' && value.length <= 32767 && !/[\0\r\n]/.test(value);
      if (path[4] === 'Address') allowed = typeof value === 'string' && value.length <= 255 && /^[a-zA-Z0-9_.:[\]-]*$/.test(value);
      if (connectionMode === 'setup') {
        if (['AutoDetect', 'AlwaysAutoDetect'].includes(String(path[4]))) allowed = value === false;
        if (path[4] === 'AdbPath') allowed = typeof value === 'string' && isAbsolute(value) && value.length <= 32767 && !/[\0\r\n]/.test(value);
        if (path[4] === 'Address') allowed = typeof value === 'string' && (/^emulator-\d{1,5}$/.test(value) || /^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(value) && Number(value.split(':')[1]) > 0 && Number(value.split(':')[1]) <= 65535);
      }
      dependencies.push(['Current'], ['Configurations', path[1], 'Gui', 'ConnectSettings'], ['Configurations', path[1], 'Gui', 'RuntimeSettings']);
    }
    if (path.length === 2 && path[0] === 'Timers') {
      if (['CustomConfig', 'ForceScheduledStart', 'ShowWindowBeforeForceScheduledStart', 'NotifyBeforeScheduledStart'].includes(String(path[1]))) allowed = typeof value === 'boolean';
      if (path[1] === 'ScheduledStartNotificationMinutes') allowed = Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 1439;
    }
    if (path.length === 4 && path[0] === 'Timers' && path[1] === 'List' && Number.isInteger(path[2]) && Number(path[2]) >= 0 && Number(path[2]) < 8) {
      if (path[3] === 'IsEnabled') { allowed = typeof value === 'boolean' || value === null; nullableBoolean = true; }
      if (path[3] === 'Hour') allowed = Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 23;
      if (path[3] === 'Minute') allowed = Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 59;
      if (path[3] === 'Config') allowed = typeof value === 'string' && Object.hasOwn(object(config.Configurations), value);
    }
    if (path.length === 3 && path[0] === 'Configurations' && typeof path[1] === 'string' && path[2] === 'TaskQueue') {
      if (Array.isArray(old) && Array.isArray(value) && old.length === value.length && new Set(value).size === old.length
        && value.every(index => Number.isInteger(index) && index >= 0 && index < old.length)) {
        if (old.some(task => !ordinaryTaskTypes.has(knownTaskType(object(task)) ?? ''))) throw new Error('unsafe-task-settings');
        const reordered = value.map(index => old[index]); value = reordered; allowed = true;
        reordered.forEach((task, index) => { if (object(task).IsEnable !== false) enabledTasks.push([...path, index]); });
      }
    }
    if (path.length === 5 && path[0] === 'Configurations' && typeof path[1] === 'string' && path[2] === 'TaskQueue'
      && Number.isInteger(path[3]) && Number(path[3]) >= 0) {
      const task = object(at(config, path.slice(0, 4)));
      const type = knownTaskType(task);
      if (path[4] === 'IsEnable' && typeof change.value === 'boolean') {
        allowed = change.value === false || ordinaryTaskTypes.has(type ?? '');
        if (change.value === true && old !== true) enabledTasks.push(path.slice(0, 4));
      }
      if (type === 'Fight' && ['UseMedicine', 'MedicineCount'].includes(String(path[4]))) {
        const amount = request.authorization.medicineCount;
        allowed = request.authorization.source === 'current-request' && Number.isSafeInteger(amount) && Number(amount) >= 0 && Number(amount) <= 2147483647
          && (path[4] === 'UseMedicine' ? typeof value === 'boolean' : Number.isInteger(value) && Number(value) >= 0 && Number(value) <= Number(amount));
        medicineTasks.add(JSON.stringify(path.slice(0, 4)));
      }
    }
    if (training) allowed = true;
    if (!allowed || (!nullableBoolean && old !== null && typeof old !== typeof value)) throw new Error('change-not-allowed');
    const parent = at(next, path.slice(0, -1)) as Record<string | number, unknown>;
    parent[path.at(-1)!] = value;
  }
  if (request.authorization.jobPlan) {
    const changes = request.changes;
    if (changes.length !== 2 || !changes.some(change => change.path[2] === 'Copilot' && change.path[3] === 'TaskList')
      || !changes.some(change => change.path[2] === 'Copilot' && change.path[3] === 'EnableUserAdditional' && change.value === false)) throw new Error('job-plan-change-mismatch');
  }
  if (request.changes.some(change => change.path[0] === 'Timers' && !['NotifyBeforeScheduledStart', 'ScheduledStartNotificationMinutes', 'ShowWindowBeforeForceScheduledStart'].includes(String(change.path[1])))) {
    const timers = object(next.Timers);
    dependencies.push(['Timers']);
    if (timers.CustomConfig !== true) dependencies.push(['Current']);
    if (!Array.isArray(timers.List)) throw new Error('configuration-invalid');
    for (const item of timers.List) {
      const timer = object(item);
      if (timer.IsEnabled === false) continue;
      const profile = timers.CustomConfig === true ? timer.Config : next.Current;
      if (typeof profile !== 'string') throw new Error('configuration-invalid');
      const queuePath = ['Configurations', profile, 'TaskQueue'];
      dependencies.push(queuePath);
      const queue = at(next, queuePath);
      if (!Array.isArray(queue)) throw new Error('configuration-invalid');
      queue.forEach((task, index) => { if (object(task).IsEnable !== false) enabledTasks.push([...queuePath, index]); });
    }
  }
  const consumingTasks = new Map<string, number>();
  const checkedTasks = [...enabledTasks, ...[...medicineTasks].map(value => JSON.parse(value) as (string | number)[])];
  const consumingProfiles = new Set(checkedTasks.filter(path => { const task = object(at(next, path)); return knownTaskType(task) === 'Fight' && task.UseMedicine !== false; }).map(path => String(path[1])));
  if (consumingProfiles.size) {
    dependencies.push(['Timers']);
    if (object(next.Timers).CustomConfig !== true) dependencies.push(['Current']);
  }
  for (const profile of consumingProfiles) {
    dependencies.push(['Configurations', profile, 'TaskQueue']);
    const queue = at(next, ['Configurations', profile, 'TaskQueue']);
    if (!Array.isArray(queue)) throw new Error('configuration-invalid');
    queue.forEach((value, index) => { if (object(value).IsEnable !== false) checkedTasks.push(['Configurations', profile, 'TaskQueue', index]); });
  }
  for (const path of checkedTasks) {
    const task = object(at(next, path));
    const type = knownTaskType(task);
    if (!ordinaryTaskTypes.has(type ?? '') && !(training && type === 'OperProgress' && path[1] === training.profile
      && path[3] === request.authorization.trainingPlan!.binding.progressTask)) throw new Error('unsafe-task-settings');
    if (type === 'Fight') {
      if (task.UseStone !== false || task.UseExpiringMedicine !== false || task.UseExpireMedicineForActivity !== false) throw new Error('unsafe-task-settings');
      if (task.UseMedicine !== false && (task.UseMedicine !== true || request.authorization.source !== 'current-request' || !Number.isSafeInteger(request.authorization.medicineCount)
        || !Number.isInteger(task.MedicineCount) || Number(task.MedicineCount) <= 0 || Number(task.MedicineCount) > Number(request.authorization.medicineCount))) throw new Error('medicine-authorization-required');
      if (task.UseMedicine === true) consumingTasks.set(JSON.stringify(path), Number(task.MedicineCount));
    }
    if (type === 'Award' && (task.FreeGacha !== false || task.SpecialAccess === true)) throw new Error('unsafe-task-settings');
  }
  const scheduledRuns = new Map<string, number>();
  const timers = object(next.Timers);
  if (!Array.isArray(timers.List)) throw new Error('configuration-invalid');
  for (const value of timers.List) {
    const timer = object(value); if (timer.IsEnabled === false) continue;
    const profile = String(timers.CustomConfig === true ? timer.Config : next.Current);
    if (!consumingProfiles.has(profile)) continue;
    const amount = [...consumingTasks].filter(([key]) => {
      const path = JSON.parse(key) as (string | number)[];
      return path[1] === profile && object(at(next, path)).IsEnable !== false;
    }).reduce((sum, [, count]) => sum + count, 0);
    if (amount > 0 && timerEnabled(timer) !== null) throw new Error('recurring-medicine-not-authorized');
    scheduledRuns.set(profile, (scheduledRuns.get(profile) ?? 0) + 1);
  }
  const requiredMedicine = [...consumingTasks].reduce((sum, [key, count]) => {
    const path = JSON.parse(key) as (string | number)[];
    const repetitions = object(at(next, path)).IsEnable !== false ? scheduledRuns.get(String(path[1])) ?? 0 : 0;
    return sum + count * Math.max(1, repetitions);
  }, 0);
  if (requiredMedicine > (request.authorization.medicineCount ?? 0)) throw new Error('medicine-budget-exceeded');
  return { config: next, dependencies, trainingAsset: training?.asset ?? null, changedKeys: request.changes.filter(change => JSON.stringify(at(config, change.path)) !== JSON.stringify(at(next, change.path))).map(change => changedKey(change.path)) };
}
async function readConfiguration(maaDirectory: string): Promise<RecordValue> {
  return object(JSON.parse((await readFile(join(maaDirectory, 'config', 'gui.new.json'), 'utf8')).replace(/^\uFEFF/, '')));
}
async function existingLock(file: string) {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return 'unknown'; }
  try {
    const pid = object(JSON.parse(text)).pid;
    if (Number.isSafeInteger(pid) && Number(pid) > 0) {
      try { process.kill(Number(pid), 0); return 'busy'; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 'busy'; }
    }
  } catch { /* An incomplete or malformed lock still represents an unknown result. */ }
  return 'unknown';
}

/** Shared read-only lock gate, including callers that have no changed fields to write. */
export async function inspectConfigWriteLock(maaDirectory: string) {
  return existingLock(join(maaDirectory, 'config', '.maa-skills.lock'));
}

export type RecoveryContext = { maaDirectory: string; privateDirectory: string };
export type RecoveryInspection = {
  lock: 'none' | 'active' | 'stale' | 'unknown'; comparison: 'applied' | 'unchanged' | 'unknown';
  evidenceRevision: string; configuration: 'valid' | 'invalid'; backup: 'matched-latest' | 'unavailable';
  process: 'ready' | 'closed' | 'unverified'; canReconcile: boolean; canRestore: boolean;
  changes: { key: string; state: 'applied' | 'unchanged' | 'unknown' }[];
};
const operationId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

function transactionFields(value: unknown, required: string[], optional: string[] = []): RecordValue {
  const record = object(value);
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('unsupported-transaction');
  return record;
}

function transactionMetadata(value: unknown, pending = false): RecordValue {
  const record = transactionFields(value, ['id', 'skill', 'host', 'pid', 'startedAt', 'phase', ...(pending ? ['authorization', 'changes'] : [])]);
  if (!operationId(record.id) || (record.skill !== 'maa-daily' && record.skill !== 'maa-doctor' && record.skill !== 'maa-setup')
    || (record.host !== 'codex' && record.host !== 'claude') || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
    || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt)) || new Date(record.startedAt).toISOString() !== record.startedAt
    || typeof record.phase !== 'string' || !(pending ? ['check'] : ['check', 'close', 'backup', 'write', 'restart', 'readback', 'record', 'release']).includes(record.phase)) throw new Error('transaction-metadata-invalid');
  return record;
}

function transactionPending(value: unknown): RecordValue {
  const record = transactionMetadata(value, true);
  const authorization = transactionFields(record.authorization, ['source', 'reference'], ['medicineCount']);
  if ((authorization.source !== 'current-request' && authorization.source !== 'approved-report')
    || typeof authorization.reference !== 'string' || !authorization.reference.trim()
    || Object.hasOwn(authorization, 'medicineCount') && (!Number.isInteger(authorization.medicineCount) || Number(authorization.medicineCount) < 0 || Number(authorization.medicineCount) > 2147483647)) throw new Error('transaction-authorization-invalid');
  if (!Array.isArray(record.changes) || !record.changes.length || record.changes.length > 1000) throw new Error('pending-changes');
  for (const item of record.changes) {
    const change = transactionFields(item, ['path', 'value']);
    if (!Array.isArray(change.path) || !change.path.length || change.path.some(part => typeof part !== 'string' && (!Number.isSafeInteger(part) || Number(part) < 0))) throw new Error('transaction-change-invalid');
  }
  return record;
}

async function recoveryEvidence(context: RecoveryContext, maa: MaaProcess) {
  const lockFile = join(context.maaDirectory, 'config', '.maa-skills.lock');
  const read = async (file: string) => { try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
  const rawLock = await read(lockFile); const rawCurrent = await read(join(context.maaDirectory, 'config', 'gui.new.json'));
  const summary: RecoveryInspection = { lock: rawLock === null ? 'none' : 'unknown', comparison: 'unknown', evidenceRevision: '',
    configuration: 'invalid', backup: 'unavailable', process: 'unverified', canReconcile: false, canRestore: false, changes: [] };
  let current: RecordValue | undefined; let metadata: RecordValue | undefined;
  let backup: RecordValue | undefined; let pending: WriteRequest | undefined; let rawBackup: string | null = null; let rawPending: string | null = null;
  try { current = object(JSON.parse((rawCurrent ?? '').replace(/^\uFEFF/, ''))); await inspectConfiguration(context.maaDirectory); summary.configuration = 'valid'; } catch { /* A damaged configuration cannot be restored automatically. */ }
  if (rawLock !== null) {
    try {
      metadata = object(JSON.parse(rawLock));
      if (Number.isSafeInteger(metadata.pid) && Number(metadata.pid) > 0) {
        try { process.kill(Number(metadata.pid), 0); summary.lock = 'active'; }
        catch (error) { summary.lock = (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stale' : 'active'; }
      }
    } catch { /* Preserve unrecognizable locks. */ }
  }
  if (summary.lock === 'stale') {
    try {
      const state = await maa.inspect();
      summary.process = state.running && state.ready && state.idle && !state.treeExited ? 'ready'
        : !state.running && state.treeExited ? 'closed' : 'unverified';
      metadata = transactionMetadata(metadata);
      const directory = join(context.privateDirectory, 'maa-config-backups');
      const backups = await Promise.all((await readdir(directory)).filter(file => operationId(file.slice(0, -5)) && file.endsWith('.json'))
        .map(async file => ({ file, modified: (await stat(join(directory, file))).mtimeMs })));
      backups.sort((a, b) => b.modified - a.modified || b.file.localeCompare(a.file));
      if (backups[0]?.file !== metadata.id + '.json') throw new Error('latest-backup-mismatch');
      if (backups[1]?.modified === backups[0].modified) throw new Error('latest-backup-ambiguous');
      rawBackup = await read(join(directory, metadata.id + '.json'));
      backup = object(JSON.parse((rawBackup ?? '').replace(/^\uFEFF/, '')));
      rawPending = await read(join(context.privateDirectory, 'daily-pending.jsonl'));
      const records = (rawPending ?? '').trim().split('\n').filter(Boolean).map(line => object(JSON.parse(line)));
      const matches = records.filter(record => record.id === metadata!.id);
      if (matches.length !== 1 || records.at(-1)?.id !== metadata.id) throw new Error('pending-record-mismatch');
      const record = transactionPending(matches[0]);
      for (const field of ['id', 'skill', 'host', 'pid', 'startedAt']) if (record[field] !== metadata[field]) throw new Error('pending-owner-mismatch');
      pending = { ...record, maaDirectory: context.maaDirectory, privateDirectory: context.privateDirectory } as WriteRequest;
      const expected = prepare(backup, pending, record.skill === 'maa-setup' || record.skill === 'maa-doctor' ? 'recovery' : undefined).config;
      summary.backup = 'matched-latest';
      if (!current || summary.configuration !== 'valid') throw new Error('current-invalid');
      summary.comparison = revision(current) === revision(backup) ? 'unchanged' : revision(current) === revision(expected) ? 'applied' : 'unknown';
      summary.changes = pending.changes.map(change => ({ key: changedKey(change.path),
        state: comparableAt(current!, change.path) === comparableAt(backup!, change.path) ? 'unchanged'
          : comparableAt(current!, change.path) === comparableAt(expected, change.path) ? 'applied' : 'unknown' }));
      summary.canReconcile = summary.comparison !== 'unknown' && (summary.process === 'ready' || summary.process === 'closed' && summary.comparison === 'unchanged');
      summary.canRestore = summary.comparison === 'applied' && summary.process !== 'unverified';
    } catch { /* Evidence remains unknown; no heuristic repair is allowed. */ }
  }
  const stable = rawLock === await read(lockFile) && rawCurrent === await read(join(context.maaDirectory, 'config', 'gui.new.json'));
  if (!stable) { summary.comparison = 'unknown'; summary.canReconcile = false; summary.canRestore = false; }
  summary.evidenceRevision = createHash('sha256').update(JSON.stringify([rawLock, rawCurrent, rawBackup, rawPending, summary])).digest('hex');
  return { summary, rawLock, rawCurrent, rawBackup, rawPending, metadata, backup, pending, current };
}

/** Safe evidence only; no account names, paths, raw settings or authorization text. */
export async function inspectConfigRecovery(context: RecoveryContext, maa: MaaProcess): Promise<RecoveryInspection> {
  return (await recoveryEvidence(context, maa)).summary;
}

export type RecoveryRequest = RecoveryContext & { host: 'codex' | 'claude'; action: 'reconcile-lock' | 'restore-config';
  evidenceRevision: string; reference: string; closedConfirmed?: boolean; medicineCount?: number };

/** Recovery is owned by the same writer as ordinary configuration changes. */
export async function executeConfigRecovery(request: RecoveryRequest, maa: MaaProcess) {
  const rejected = (reason: string) => ({ status: 'rejected', reason });
  if (!['codex', 'claude'].includes(request.host) || !['reconcile-lock', 'restore-config'].includes(request.action)
    || typeof request.reference !== 'string' || !request.reference.trim() || !/^[a-f0-9]{64}$/.test(request.evidenceRevision)) return rejected('approval-required');
  const guardFile = join(request.maaDirectory, 'config', '.maa-skills-recovery.lock');
  const guardId = randomUUID(); let guard;
  try { guard = await open(guardFile, 'wx', 0o600); } catch { return rejected('recovery-busy-or-unknown'); }
  try {
    await guard.writeFile(JSON.stringify({ id: guardId, pid: process.pid })); await guard.sync();
    const evidence = await recoveryEvidence(request, maa);
    if (evidence.summary.evidenceRevision !== request.evidenceRevision) return rejected('evidence-changed');
    if (request.action === 'reconcile-lock' ? !evidence.summary.canReconcile : !evidence.summary.canRestore) return rejected('reconciliation-unproven');
    const directory = join(request.privateDirectory, 'maa-config-reconciliations');
    await mkdir(directory, { recursive: true });
    const archive = await open(join(directory, `${guardId}.json`), 'wx', 0o600);
    try { await archive.writeFile(JSON.stringify({ checkedAt: new Date().toISOString(), action: request.action,
      reference: request.reference, evidence: evidence.summary, lock: evidence.rawLock, current: evidence.rawCurrent,
      backup: evidence.rawBackup, pending: evidence.rawPending })); await archive.sync(); } finally { await archive.close(); }
    // Keep the retained lock until configuration, backup, process and ownership are rechecked.
    if ((await recoveryEvidence(request, maa)).summary.evidenceRevision !== request.evidenceRevision) return rejected('evidence-changed');
    if (request.action === 'restore-config') {
      const changes = evidence.pending!.changes.map(change => {
        // A queue reorder request carries old positions, not the full private task objects.
        const reorder = change.path[0] === 'Configurations' && change.path[2] === 'TaskQueue' && change.path.length === 3;
        return { path: change.path, value: reorder ? (change.value as number[]).map((_, index, order) => order.indexOf(index)) : at(evidence.backup!, change.path) };
      });
      const lock = await open(join(request.maaDirectory, 'config', '.maa-skills.lock'), 'r+');
      try {
        return await writeConfiguration({ maaDirectory: request.maaDirectory, privateDirectory: request.privateDirectory, host: request.host,
          expectedRevision: revision(evidence.current!), closedConfirmed: request.closedConfirmed,
          authorization: { source: 'current-request', reference: request.reference, ...(request.medicineCount === undefined ? {} : { medicineCount: request.medicineCount }) }, changes }, maa,
        { lock, rawLock: evidence.rawLock! });
      } finally { await lock.close(); }
    }
    await unlink(join(request.maaDirectory, 'config', '.maa-skills.lock'));
    return { status: 'complete', reason: null };
  } catch { return { status: 'unknown', reason: 'reconciliation-required' }; }
  finally {
    await guard.close();
    try { if (object(JSON.parse(await readFile(guardFile, 'utf8'))).id === guardId) await unlink(guardFile); } catch { /* Retain a guard whose ownership cannot be proved. */ }
  }
}
/** MAA's native local-time timer is active for true (recurring) and null (one-shot). */
export function checkMaintenanceWindow(config: unknown, start: Date, end: Date): boolean {
  try {
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start || end.getTime() - start.getTime() > 24 * 3600000) return false;
    const timers = object(object(config).Timers).List;
    if (!Array.isArray(timers)) return false;
    for (const value of timers) {
      const timer = object(value);
      if (timer.IsEnabled === false) continue;
      if ((timerEnabled(timer) !== true && timerEnabled(timer) !== null) || !Number.isInteger(timer.Hour) || !Number.isInteger(timer.Minute)
        || Number(timer.Hour) < 0 || Number(timer.Hour) > 23 || Number(timer.Minute) < 0 || Number(timer.Minute) > 59) return false;
      // Visit actual instants rather than constructing a local time, which chooses
      // only the first occurrence of an hour repeated by a daylight-saving rollback.
      for (let instant = Math.floor(start.getTime() / 60000) * 60000; instant <= end.getTime() + 120000; instant += 60000) {
        const local = new Date(instant);
        const untilTrigger = (Number(timer.Hour) * 60 + Number(timer.Minute) - local.getHours() * 60 - local.getMinutes() + 1440) % 1440;
        // MAA's wall-clock configuration switch and the physical two-minute
        // interval before every actual trigger must both remain protected.
        if (instant <= end.getTime() && untilTrigger <= 2) return false;
        if (untilTrigger === 0 && start.getTime() < instant + 60000 && end.getTime() >= instant - 120000) return false;
      }
    }
    return true;
  } catch { return false; }
}
export async function inspectConfiguration(maaDirectory: string) {
  const config = await readConfiguration(maaDirectory);
  const timers = object(config.Timers);
  const names = Object.keys(object(config.Configurations));
  const safeBoolean = (value: unknown) => typeof value === 'boolean' ? value : null;
  const integer = (value: unknown, max: number) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max ? value : null;
  return {
    revision: revision(config),
    currentProfile: names.indexOf(String(config.Current)),
    profiles: names.map((name, index) => {
      const profile = object(object(config.Configurations)[name]);
      const copilot = profile.Copilot && typeof profile.Copilot === 'object' && !Array.isArray(profile.Copilot) ? object(profile.Copilot) : null;
      return { index, jobCount: Array.isArray(copilot?.TaskList) ? copilot.TaskList.length : null, queue: Array.isArray(profile.TaskQueue) ? profile.TaskQueue.map(value => {
        const task = object(value);
        return { type: knownTaskType(task) ?? 'OtherTask', enabled: safeBoolean(task.IsEnable) };
      }) : [] };
    }),
    reminderEnabled: safeBoolean(timers.NotifyBeforeScheduledStart),
    reminderMinutes: integer(timers.ScheduledStartNotificationMinutes, 1439),
    timers: Array.isArray(timers.List) ? timers.List.map((value, index) => {
      const timer = object(value);
      return { index, enabled: safeBoolean(timer.IsEnabled), hour: integer(timer.Hour, 23), minute: integer(timer.Minute, 59), profile: names.indexOf(String(timer.Config)) };
    }) : [],
  };
}

const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    const settings = await readSettings();
    if (!settings.maaDirectory) throw new Error('maa-directory-unset');
    if (process.argv.length !== 3) throw new Error('action-invalid');
    if (process.argv[2] === 'read') console.log(JSON.stringify({ ok: true, configuration: await inspectConfiguration(settings.maaDirectory) }));
    else if (process.argv[2] === 'write') {
      let input = '';
      for await (const chunk of process.stdin) { input += String(chunk); if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('input-too-large'); }
      const body = object(JSON.parse(input));
      if (Object.keys(body).some(key => !['host', 'expectedRevision', 'closedConfirmed', 'authorization', 'changes'].includes(key))) throw new Error('request-invalid');
      const { createMaaProcess } = await import('./maa-process.ts');
      let boundary: MaaProcess | undefined;
      const get = () => boundary ??= createMaaProcess(settings.maaDirectory!);
      const result = await executeConfigWrite({ ...body, maaDirectory: settings.maaDirectory, privateDirectory: settings.privateDirectory } as WriteRequest,
        { inspect: () => get().inspect(), close: () => get().close(), start: () => get().start() });
      console.log(JSON.stringify({ ok: result.status === 'complete', ...result }));
      if (result.status !== 'complete') process.exitCode = 1;
    } else throw new Error('action-invalid');
  } catch {
    console.log(JSON.stringify({ ok: false, status: 'check-required' })); process.exitCode = 1;
  }
}
export async function executeConfigWrite(request: WriteRequest, maa: MaaProcess) { return writeConfiguration(request, maa); }

/** The sole normal connection-write entry: selection and adb retest happen here, not in a caller-supplied grant. */
export async function executeSetupConfigWrite(request: SetupWriteRequest, context: ConnectionContext = {}, adb?: AdbBoundary, maa?: MaaProcess) {
  const prepared = await prepareSetupConnection(request, context, adb);
  if (!prepared.writeRequest) return prepared;
  const write = prepared.writeRequest;
  if (!write.changes.length) {
    if ((await inspectConfiguration(write.maaDirectory)).revision !== write.expectedRevision) return { status: 'rejected', reason: 'configuration-changed' };
    const lock = await inspectConfigWriteLock(write.maaDirectory);
    if (lock) return { status: lock, reason: 'lock-requires-reconciliation' };
    return { status: 'unchanged', reason: 'connection-already-configured' };
  }
  const boundary = maa ?? (await import('./maa-process.ts')).createMaaProcess(write.maaDirectory);
  return writeConfiguration(write, boundary, undefined, 'setup');
}

async function writeConfiguration(request: WriteRequest, maa: MaaProcess, recovery?: { lock: FileHandle; rawLock: string }, connection?: 'setup') {
  const id = randomUUID();
  const rejected = (reason: string) => ({ status: 'rejected', phase: 'check', operation: id, changedKeys: [] as string[], reason });
  let original: RecordValue;
  let trainingAsset: TrainingAsset | null = null;
  let assetBefore: 'absent' | 'matching' | null = null;
  const checkAsset = async () => { if (trainingAsset && await inspectTrainingAsset(trainingAsset) !== assetBefore) throw new Error('training-asset-target-changed'); };
  let targets: { path: (string | number)[]; value: string | undefined }[];
  const checkTargets = (config: RecordValue) => {
    if (targets.some(target => comparableAt(config, target.path) !== target.value)) throw new Error('authorized-target-changed');
  };
  try {
    request = structuredClone(request);
    if (request.closedConfirmed !== undefined && typeof request.closedConfirmed !== 'boolean') return rejected('request-invalid');
    const medicine = request.authorization?.medicineCount;
    if (medicine !== undefined && (!Number.isInteger(medicine) || medicine < 0 || medicine > 2147483647)) return rejected('medicine-quantity-invalid');
    if (!['codex', 'claude'].includes(request.host) || !['current-request', 'approved-report'].includes(request.authorization.source)
      || typeof request.authorization.reference !== 'string' || !request.authorization.reference.trim()
      || !Array.isArray(request.changes) || !request.changes.length) return rejected('authorization-invalid');
    original = await readConfiguration(request.maaDirectory);
    if (typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedRevision)) return rejected('revision-required');
    if (request.expectedRevision !== revision(original)) return rejected('configuration-changed');
    const names = Object.keys(object(original.Configurations));
    for (const change of request.changes) {
      if (change.path[0] === 'Configurations' && typeof change.path[1] === 'number') {
        const name = names[change.path[1]];
        if (!name) return rejected('profile-invalid');
        change.path[1] = name;
      }
      if (change.path[0] === 'Timers' && change.path[1] === 'List' && change.path[3] === 'Config' && typeof change.value === 'number') {
        const name = names[change.value]; if (!name) return rejected('profile-invalid'); change.value = name;
      }
    }
    if (request.authorization.jobPlan) await verifyApprovedJobFiles(request.authorization.jobPlan, request.privateDirectory);
    const prepared = prepare(original, request, recovery ? 'recovery' : connection);
    trainingAsset = prepared.trainingAsset;
    if (trainingAsset) assetBefore = await inspectTrainingAsset(trainingAsset);
    targets = request.changes.map(change => {
      const path = change.path[0] === 'Configurations' && change.path[2] === 'TaskQueue' ? change.path.slice(0, Math.min(change.path.length, 4))
        : change.path[0] === 'Timers' && change.path[1] === 'List' ? change.path.slice(0, 3) : change.path;
      return { path, value: comparableAt(original, path) };
    });
    targets.push(...prepared.dependencies.map(path => ({ path, value: comparableAt(original, path) })));
    const now = new Date(); const end = new Date(now.getTime() + 120000);
    if (!checkMaintenanceWindow(original, now, end) || !checkMaintenanceWindow(prepared.config, now, end)) return rejected('timer-window');
  } catch { return rejected('request-invalid'); }
  const file = join(request.maaDirectory, 'config', 'gui.new.json');
  const lockFile = join(request.maaDirectory, 'config', '.maa-skills.lock');
  const locked = async () => {
    if (recovery) return await readFile(lockFile, 'utf8').catch(() => null) === recovery.rawLock ? null : rejected('evidence-changed');
    const status = await inspectConfigWriteLock(request.maaDirectory);
    return status ? { ...rejected('lock-requires-reconciliation'), status } : null;
  };
  const retained = await locked(); if (retained) return retained;
  let initial: MaaState;
  try { await access(file, constants.R_OK | constants.W_OK); initial = await maa.inspect(); }
  catch { return rejected('process-or-file-check-failed'); }
  if (!initial.running && !request.closedConfirmed) return rejected('closed-confirmation-required');
  if (initial.running && !initial.idle) return rejected('maa-not-idle');
  let lock;
  try { lock = recovery?.lock ?? await open(lockFile, 'wx', 0o600); }
  catch { return (await locked()) ?? rejected('lock-unavailable'); }
  if (recovery) { const changed = await locked(); if (changed) return changed; }
  const connectionOnly = request.changes.every(change => change.path[0] === 'Configurations' && change.path[2] === 'Gui' && change.path[3] === 'ConnectSettings');
  const metadata = { id, skill: recovery ? 'maa-doctor' : connectionOnly ? 'maa-setup' : 'maa-daily', host: request.host, pid: process.pid, startedAt: new Date().toISOString(), phase: 'check' };
  const phase = async (value: string) => {
    metadata.phase = value;
    await lock.truncate(0); await lock.write(JSON.stringify(metadata), 0, 'utf8'); await lock.sync();
  };
  let lockClosed = false;
  let closeStarted: Date;
  try {
    await phase('check');
    const state = await maa.inspect();
    if (!state.running && !request.closedConfirmed) throw new Error('closed-confirmation-required');
    if (state.running && !state.idle) throw new Error('maa-not-idle');
    await mkdir(request.privateDirectory, { recursive: true });
    const { authorization, changes } = request;
    await checkAsset();
    const trainingManifest = trainingAsset ? { file: trainingAsset.file, before: assetBefore, sha256: trainingAsset.sha256, immutable: true } : undefined;
    await appendFile(join(request.privateDirectory, 'daily-pending.jsonl'), JSON.stringify({ ...metadata, authorization, changes, trainingManifest }) + '\n', { mode: 0o600 });
    original = await readConfiguration(request.maaDirectory);
    checkTargets(original);
    const preview = prepare(original, request, recovery ? 'recovery' : connection);
    closeStarted = new Date();
    const deadline = new Date(closeStarted.getTime() + 120000);
    if (!checkMaintenanceWindow(original, closeStarted, deadline) || !checkMaintenanceWindow(preview.config, closeStarted, deadline)) throw new Error('timer-window');
    await phase('close');
    if (state.running) await maa.close();
    if (!(await maa.inspect()).treeExited) throw new Error('process-tree-running');
    await phase('backup');
    const before = await readFile(file);
    const stoppedConfiguration = object(JSON.parse(before.toString('utf8').replace(/^\uFEFF/, '')));
    checkTargets(stoppedConfiguration);
    await checkAsset();
    const prepared = prepare(stoppedConfiguration, request, recovery ? 'recovery' : connection);
    const { config, changedKeys } = prepared;
    const checkBeforeRestart = () => {
      if (Date.now() > deadline.getTime() - 60000 || !checkMaintenanceWindow(config, closeStarted, deadline)) throw new Error('maintenance-budget-exceeded');
    };
    checkBeforeRestart();
    await mkdir(join(request.privateDirectory, 'maa-config-backups'), { recursive: true });
    const backup = await open(join(request.privateDirectory, 'maa-config-backups', `${id}.json`), 'wx', 0o600);
    try { await backup.writeFile(before); await backup.sync(); } finally { await backup.close(); }
    if (request.authorization.jobPlan) await verifyApprovedJobFiles(request.authorization.jobPlan, request.privateDirectory);
    await phase('write');
    checkBeforeRestart();
    if (!(await maa.inspect()).treeExited) throw new Error('process-tree-running');
    await checkAsset();
    if (trainingAsset) await installTrainingAsset(trainingAsset);
    const temporary = `${file}.${id}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(config, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    if (!(await maa.inspect()).treeExited || object(JSON.parse(await readFile(lockFile, 'utf8'))).id !== id) throw new Error('write-ownership-lost');
    checkBeforeRestart();
    await rename(temporary, file);
    await phase('restart'); checkBeforeRestart(); await maa.start();
    if (!(await maa.inspect()).ready) throw new Error('restart-unverified');
    const reopened = new Date();
    if (reopened > deadline || !checkMaintenanceWindow(original, closeStarted, reopened) || !checkMaintenanceWindow(config, closeStarted, reopened)) throw new Error('maintenance-window-exceeded');
    await phase('readback');
    const readback = await readConfiguration(request.maaDirectory);
    if (request.authorization.jobPlan) await verifyApprovedJobFiles(request.authorization.jobPlan, request.privateDirectory);
    if (trainingAsset && await inspectTrainingAsset(trainingAsset) !== 'matching') throw new Error('training-asset-readback-mismatch');
    for (const change of request.changes) {
      if (comparableAt(readback, change.path) !== comparableAt(config, change.path)) throw new Error('readback-mismatch');
    }
    for (const target of targets) {
      if (comparableAt(readback, target.path) !== comparableAt(config, target.path)) throw new Error('readback-target-changed');
    }
    await phase('record');
    const result = { status: 'complete', phase: 'complete', operation: id, changedKeys, reason: null };
    await appendFile(join(request.privateDirectory, 'daily-runs.jsonl'), JSON.stringify({ ...metadata, ...result }) + '\n', { mode: 0o600 });
    await phase('release');
    if (object(JSON.parse(await readFile(lockFile, 'utf8'))).id !== id) throw new Error('lock-owner-changed');
    await lock.close(); lockClosed = true;
    await unlink(lockFile);
    return result;
  } catch {
    const result = { status: 'unknown', phase: metadata.phase, operation: id, changedKeys: [] as string[], reason: 'reconciliation-required' };
    try { await appendFile(join(request.privateDirectory, 'daily-runs.jsonl'), JSON.stringify({ ...metadata, ...result }) + '\n', { mode: 0o600 }); }
    catch { /* The retained lock remains evidence when the private record cannot be saved. */ }
    return result;
  } finally {
    if (!lockClosed) await lock.close();
  }
}
