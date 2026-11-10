import { access, appendFile, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSettings } from './preferences.ts';

export type Change = { path: (string | number)[]; value: unknown };
export type WriteRequest = {
  maaDirectory: string; privateDirectory: string; host: 'codex' | 'claude';
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
        && old.every(task => value instanceof Array && value.includes(object(task).TaskType))) {
        const order = value; value = order.map(type => old.find(task => object(task).TaskType === type)); allowed = true;
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
        allowed = request.authorization.source === 'current-request' && Number.isSafeInteger(amount) && Number(amount) >= 0
          && (path[4] === 'UseMedicine' ? change.value === (Number(amount) > 0) : change.value === amount);
        medicineTasks.add(JSON.stringify(path.slice(0, 4)));
      }
    }
    if (!allowed || (!nullableBoolean && old !== null && typeof old !== typeof value)) throw new Error('change-not-allowed');
    const parent = at(next, path.slice(0, -1)) as Record<string | number, unknown>;
    parent[path.at(-1)!] = value;
  }
  if (request.changes.some(change => change.path[0] === 'Timers' && !['NotifyBeforeScheduledStart', 'ScheduledStartNotificationMinutes', 'ShowWindowBeforeForceScheduledStart'].includes(String(change.path[1])))) {
    const timers = object(next.Timers);
    if (!Array.isArray(timers.List)) throw new Error('configuration-invalid');
    for (const item of timers.List) {
      const timer = object(item);
      if (timer.IsEnabled === false) continue;
      const profile = timers.CustomConfig === true ? timer.Config : next.Current;
      if (typeof profile !== 'string') throw new Error('configuration-invalid');
      const queuePath = ['Configurations', profile, 'TaskQueue'];
      const queue = at(next, queuePath);
      if (!Array.isArray(queue)) throw new Error('configuration-invalid');
      queue.forEach((task, index) => { if (object(task).IsEnable !== false) enabledTasks.push([...queuePath, index]); });
    }
  }
  for (const path of [...enabledTasks, ...[...medicineTasks].map(value => JSON.parse(value) as (string | number)[])]) {
    const task = object(at(next, path));
    if (!['Fight', 'Infrast', 'Recruit', 'Mall', 'Award', 'UserDataUpdate', 'CloseDown'].includes(String(task.TaskType))) throw new Error('unsafe-task-settings');
    if (task.TaskType === 'Fight') {
      if (task.UseStone !== false || task.UseExpiringMedicine !== false || task.UseExpireMedicineForActivity !== false) throw new Error('unsafe-task-settings');
      if (task.UseMedicine !== false && (request.authorization.source !== 'current-request' || !Number.isSafeInteger(request.authorization.medicineCount)
        || request.authorization.medicineCount !== task.MedicineCount)) throw new Error('medicine-authorization-required');
    }
    if (task.TaskType === 'Award' && (task.FreeGacha !== false || task.SpecialAccess === true)) throw new Error('unsafe-task-settings');
  }
  return { config: next, changedKeys: request.changes.filter(change => JSON.stringify(at(config, change.path)) !== JSON.stringify(at(next, change.path))).map(change => changedKey(change.path)) };
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
      for (let offset = -1; offset <= 2; offset++) {
        const trigger = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, Number(timer.Hour), Number(timer.Minute)).getTime();
        if (start.getTime() < trigger + 60000 && end.getTime() >= trigger - 120000) return false;
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
      if (Object.keys(body).some(key => !['host', 'closedConfirmed', 'authorization', 'changes'].includes(key))) throw new Error('request-invalid');
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
  try {
    request = structuredClone(request);
    if (request.closedConfirmed !== undefined && typeof request.closedConfirmed !== 'boolean') return rejected('request-invalid');
    if (!['codex', 'claude'].includes(request.host) || !['current-request', 'approved-report'].includes(request.authorization.source)
      || typeof request.authorization.reference !== 'string' || !request.authorization.reference.trim()
      || !Array.isArray(request.changes) || !request.changes.length) return rejected('authorization-invalid');
    original = await readConfiguration(request.maaDirectory);
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
    const preview = prepare(original, request);
    closeStarted = new Date();
    const deadline = new Date(closeStarted.getTime() + 120000);
    if (!checkMaintenanceWindow(original, closeStarted, deadline) || !checkMaintenanceWindow(preview.config, closeStarted, deadline)) throw new Error('timer-window');
    await phase('close');
    if (state.running) await maa.close();
    if (!(await maa.inspect()).treeExited) throw new Error('process-tree-running');
    await phase('backup');
    const before = await readFile(file);
    const prepared = prepare(object(JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''))), request);
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
