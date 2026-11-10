import { access, appendFile, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSettings } from './preferences.ts';

export type Change = { path: (string | number)[]; value: unknown };
export type WriteRequest = {
  maaDirectory: string; privateDirectory: string; host: 'codex' | 'claude';
  expectedRevision: string;
  closedConfirmed?: boolean;
  authorization: { source: 'current-request' | 'approved-report'; reference: string; medicineCount?: number };
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
  for (const key of path) {
    if (['__proto__', 'constructor', 'prototype'].includes(String(key)) || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('change-not-allowed');
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
function changedKey(path: (string | number)[]): string {
  return path.map((part, index) => path[0] === 'Configurations' && index === 1 ? '<profile>' : String(part)).join('.');
}
function prepare(config: RecordValue, request: WriteRequest) {
  const next = structuredClone(config);
  const keys = new Set<string>();
  const medicineTasks = new Set<string>();
  const enabledTasks: (string | number)[][] = [];
  const dependencies: (string | number)[][] = [];
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
        const order = value; value = order.map(index => old[index]); allowed = true;
      }
    }
    if (path.length === 5 && path[0] === 'Configurations' && typeof path[1] === 'string' && path[2] === 'TaskQueue'
      && Number.isInteger(path[3]) && Number(path[3]) >= 0) {
      const task = object(at(config, path.slice(0, 4)));
      if (path[4] === 'IsEnable' && typeof change.value === 'boolean') {
        allowed = change.value === false || ['Fight', 'Infrast', 'Recruit', 'Mall', 'Award', 'UserDataUpdate', 'CloseDown'].includes(String(task.TaskType));
        if (change.value === true && old !== true) enabledTasks.push(path.slice(0, 4));
      }
      if (task.TaskType === 'Fight' && ['UseMedicine', 'MedicineCount'].includes(String(path[4]))) {
        const amount = request.authorization.medicineCount;
        allowed = request.authorization.source === 'current-request' && Number.isSafeInteger(amount) && Number(amount) >= 0 && Number(amount) <= 2147483647
          && (path[4] === 'UseMedicine' ? typeof value === 'boolean' : Number.isInteger(value) && Number(value) >= 0 && Number(value) <= Number(amount));
        medicineTasks.add(JSON.stringify(path.slice(0, 4)));
      }
    }
    if (!allowed || (!nullableBoolean && old !== null && typeof old !== typeof value)) throw new Error('change-not-allowed');
    const parent = at(next, path.slice(0, -1)) as Record<string | number, unknown>;
    parent[path.at(-1)!] = value;
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
  const consumingProfiles = new Set(checkedTasks.filter(path => { const task = object(at(next, path)); return task.TaskType === 'Fight' && task.UseMedicine !== false; }).map(path => String(path[1])));
  if (consumingProfiles.size) {
    dependencies.push(['Timers']);
    if (object(next.Timers).CustomConfig !== true) dependencies.push(['Current']);
  }
  for (const profile of consumingProfiles) {
    dependencies.push(['Configurations', profile, 'TaskQueue']);
    const queue = at(next, ['Configurations', profile, 'TaskQueue']);
    if (!Array.isArray(queue)) throw new Error('configuration-invalid');
    queue.forEach((value, index) => { const task = object(value); if (task.TaskType === 'Fight' && task.IsEnable !== false) checkedTasks.push(['Configurations', profile, 'TaskQueue', index]); });
  }
  for (const path of checkedTasks) {
    const task = object(at(next, path));
    if (!['Fight', 'Infrast', 'Recruit', 'Mall', 'Award', 'UserDataUpdate', 'CloseDown'].includes(String(task.TaskType))) throw new Error('unsafe-task-settings');
    if (task.TaskType === 'Fight') {
      if (task.UseStone !== false || task.UseExpiringMedicine !== false || task.UseExpireMedicineForActivity !== false) throw new Error('unsafe-task-settings');
      if (task.UseMedicine !== false && (task.UseMedicine !== true || request.authorization.source !== 'current-request' || !Number.isSafeInteger(request.authorization.medicineCount)
        || !Number.isInteger(task.MedicineCount) || Number(task.MedicineCount) <= 0 || Number(task.MedicineCount) > Number(request.authorization.medicineCount))) throw new Error('medicine-authorization-required');
      if (task.UseMedicine === true) consumingTasks.set(JSON.stringify(path), Number(task.MedicineCount));
    }
    if (task.TaskType === 'Award' && (task.FreeGacha !== false || task.SpecialAccess === true)) throw new Error('unsafe-task-settings');
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
    if (amount > 0 && timer.IsEnabled !== null) throw new Error('recurring-medicine-not-authorized');
    scheduledRuns.set(profile, (scheduledRuns.get(profile) ?? 0) + 1);
  }
  const requiredMedicine = [...consumingTasks].reduce((sum, [key, count]) => {
    const path = JSON.parse(key) as (string | number)[];
    const repetitions = object(at(next, path)).IsEnable !== false ? scheduledRuns.get(String(path[1])) ?? 0 : 0;
    return sum + count * Math.max(1, repetitions);
  }, 0);
  if (requiredMedicine > (request.authorization.medicineCount ?? 0)) throw new Error('medicine-budget-exceeded');
  return { config: next, dependencies, changedKeys: request.changes.filter(change => JSON.stringify(at(config, change.path)) !== JSON.stringify(at(next, change.path))).map(change => changedKey(change.path)) };
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
/** MAA's native local-time timer is active for true (recurring) and null (one-shot). */
export function checkMaintenanceWindow(config: unknown, start: Date, end: Date): boolean {
  try {
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start || end.getTime() - start.getTime() > 24 * 3600000) return false;
    const timers = object(object(config).Timers).List;
    if (!Array.isArray(timers)) return false;
    for (const value of timers) {
      const timer = object(value);
      if (timer.IsEnabled === false) continue;
      if ((timer.IsEnabled !== true && timer.IsEnabled !== null) || !Number.isInteger(timer.Hour) || !Number.isInteger(timer.Minute)
        || Number(timer.Hour) < 0 || Number(timer.Hour) > 23 || Number(timer.Minute) < 0 || Number(timer.Minute) > 59) return false;
      // Visit actual instants rather than constructing a local time, which chooses
      // only the first occurrence of an hour repeated by a daylight-saving rollback.
      for (let instant = Math.floor(start.getTime() / 60000) * 60000; instant <= end.getTime(); instant += 60000) {
        const local = new Date(instant);
        const untilTrigger = (Number(timer.Hour) * 60 + Number(timer.Minute) - local.getHours() * 60 - local.getMinutes() + 1440) % 1440;
        if (untilTrigger <= 2) return false;
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
      return { index, queue: Array.isArray(profile.TaskQueue) ? profile.TaskQueue.map(value => {
        const task = object(value);
        return { type: ['StartUp', 'Fight', 'Infrast', 'Recruit', 'Mall', 'Award', 'UserDataUpdate', 'CloseDown', 'Roguelike'].includes(String(task.TaskType)) ? task.TaskType : 'OtherTask', enabled: safeBoolean(task.IsEnable) };
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
export async function executeConfigWrite(request: WriteRequest, maa: MaaProcess) {
  const id = randomUUID();
  const rejected = (reason: string) => ({ status: 'rejected', phase: 'check', operation: id, changedKeys: [] as string[], reason });
  let original: RecordValue;
  let targets: { path: (string | number)[]; value: string | undefined }[];
  const checkTargets = (config: RecordValue) => {
    if (targets.some(target => JSON.stringify(at(config, target.path)) !== target.value)) throw new Error('authorized-target-changed');
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
    const prepared = prepare(original, request);
    targets = request.changes.map(change => {
      const path = change.path[0] === 'Configurations' && change.path[2] === 'TaskQueue' ? change.path.slice(0, Math.min(change.path.length, 4))
        : change.path[0] === 'Timers' && change.path[1] === 'List' ? change.path.slice(0, 3) : change.path;
      return { path, value: JSON.stringify(at(original, path)) };
    });
    targets.push(...prepared.dependencies.map(path => ({ path, value: JSON.stringify(at(original, path)) })));
    const now = new Date(); const end = new Date(now.getTime() + 120000);
    if (!checkMaintenanceWindow(original, now, end) || !checkMaintenanceWindow(prepared.config, now, end)) return rejected('timer-window');
  } catch { return rejected('request-invalid'); }
  const file = join(request.maaDirectory, 'config', 'gui.new.json');
  const lockFile = join(request.maaDirectory, 'config', '.maa-skills.lock');
  const locked = async () => {
    const status = await existingLock(lockFile);
    return status ? { ...rejected('lock-requires-reconciliation'), status } : null;
  };
  const retained = await locked(); if (retained) return retained;
  let initial: MaaState;
  try { await access(file, constants.R_OK | constants.W_OK); initial = await maa.inspect(); }
  catch { return rejected('process-or-file-check-failed'); }
  if (!initial.running && !request.closedConfirmed) return rejected('closed-confirmation-required');
  if (initial.running && !initial.idle) return rejected('maa-not-idle');
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch { return (await locked()) ?? rejected('lock-unavailable'); }
  const metadata = { id, skill: 'maa-daily', host: request.host, pid: process.pid, startedAt: new Date().toISOString(), phase: 'check' };
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
    await appendFile(join(request.privateDirectory, 'daily-pending.jsonl'), JSON.stringify({ ...metadata, authorization, changes }) + '\n', { mode: 0o600 });
    original = await readConfiguration(request.maaDirectory);
    checkTargets(original);
    const preview = prepare(original, request);
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
    const prepared = prepare(stoppedConfiguration, request);
    const { config, changedKeys } = prepared;
    const checkBeforeRestart = () => {
      if (Date.now() > deadline.getTime() - 60000 || !checkMaintenanceWindow(config, closeStarted, deadline)) throw new Error('maintenance-budget-exceeded');
    };
    checkBeforeRestart();
    await mkdir(join(request.privateDirectory, 'maa-config-backups'), { recursive: true });
    const backup = await open(join(request.privateDirectory, 'maa-config-backups', `${id}.json`), 'wx', 0o600);
    try { await backup.writeFile(before); await backup.sync(); } finally { await backup.close(); }
    await phase('write');
    checkBeforeRestart();
    if (!(await maa.inspect()).treeExited) throw new Error('process-tree-running');
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
    for (const change of request.changes) {
      if (JSON.stringify(at(readback, change.path)) !== JSON.stringify(at(config, change.path))) throw new Error('readback-mismatch');
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
