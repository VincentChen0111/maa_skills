import { access, appendFile, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readStdinJson, stdinJsonCode } from './stdin-json.ts';
import { readSettings } from './preferences.ts';
import { approvedJobList, verifyApprovedJobFiles, type ApprovedJobPlan } from './stage-job-plan.ts';
import { buildTrainingChanges, inspectTrainingAsset, installTrainingAsset, trainingTaskFields, type TrainingGrant, type TrainingAsset } from './training-config.ts';
import { connectionFields, prepareSetupConnection, type SetupWriteRequest, type ConnectionContext, type AdbBoundary } from './setup-connection.ts';
import { consumptionFields, consumptionRefusals, decideConsumption, type ConsumptionDecision, type ConsumptionGrant, type ConsumptionTarget, type ExpiringMedicineGrant } from './consumption-grant.ts';
import { compareVersionStamp, isVersionStamp, readVersionStamp, type MaaVersionStamp, type VersionDrift } from './maa-version.ts';
import { baseReferencePattern, baseTaskFields, buildBaseChanges, checkGrant, inspectBaseAsset, installBaseAsset, loadBaseAsset, type BaseAsset, type BasePlanGrant } from './base-config.ts';
import { configDiff, configValueKey, projectionRevision, sameConfigValue, wholeConfigFingerprint, type FieldPattern } from './config-projection.ts';
import { editConfigurationText } from './config-edit.ts';

export type Change = { path: (string | number)[]; value: unknown };
export type WriteRequest = {
  maaDirectory: string; privateDirectory: string; host: 'codex' | 'claude';
  /** The projection revision of the read summary (ticket 30, config-projection.ts). */
  expectedRevision: string;
  closedConfirmed?: boolean;
  authorization: { source: 'current-request' | 'approved-report'; reference: string; medicineCount?: number; stoneCount?: number;
    expiringMedicine?: ExpiringMedicineGrant; jobPlan?: ApprovedJobPlan; trainingPlan?: TrainingGrant; basePlan?: BasePlanGrant };
  changes: Change[];
  /**
   * Ticket 30: the fingerprint of the diff the user approved, from `preview`. Required when the source is the current request
   * and no plan is bound; checked whenever it is present, before closing MAA and again on the configuration MAA left.
   */
  diffFingerprint?: string;
};
/** Static reasons ticket 30 adds; neither carries configuration content. */
export const diffRefusals = ['approved-diff-missing', 'approved-diff-mismatch'] as const;
/**
 * Ticket 30: every field the writer may change, by path pattern (`*` a profile, `#` an index). `prepare` refuses a change
 * outside this table whatever route it comes by, so the table is the whitelist; types, ranges and which route may write
 * which field are checked in `prepare`. tests/config-projection.test.ts requires each entry to be in the approval projection.
 */
export const writerFields: readonly FieldPattern[] = [
  ...['NotifyBeforeScheduledStart', 'ScheduledStartNotificationMinutes', 'CustomConfig', 'ForceScheduledStart', 'ShowWindowBeforeForceScheduledStart'].map(field => ['Timers', field]),
  ...['IsEnabled', 'Hour', 'Minute', 'Config'].map(field => ['Timers', 'List', '#', field]),
  ['Configurations', '*', 'TaskQueue'],
  ...[...new Set(['IsEnable', ...Object.keys(consumptionFields), ...trainingTaskFields, ...baseTaskFields])].map(field => ['Configurations', '*', 'TaskQueue', '#', field]),
  ...['TaskList', 'EnableUserAdditional'].map(field => ['Configurations', '*', 'Copilot', field]),
  ...connectionFields.map(field => ['Configurations', '*', 'Gui', 'ConnectSettings', field]),
];
/**
 * What the writer's own decisions read besides the fields it writes: task identity and whether a task runs (on every task
 * a request reaches), which profile each timer runs and when (the timer-target logic and the maintenance window), and the
 * objects a write binds across shutdown. `prepare` refuses a bound object outside `writerDependencies`.
 */
export const taskDecisionFields = ['$type', 'TaskType', 'IsEnable'] as const;
export const timerDecisionFields: readonly FieldPattern[] = [['Current'], ['Configurations'], ['Timers', 'CustomConfig'], ['Timers', 'ForceScheduledStart'],
  ...['IsEnabled', 'Config', 'Hour', 'Minute', 'Id'].map(field => ['Timers', 'List', '#', field])];
export const writerDependencies: readonly FieldPattern[] = [['Current'], ['Timers'], ['Configurations', '*', 'TaskQueue'], ['Configurations', '*', 'TaskQueue', '#'],
  ['Configurations', '*', 'Copilot'], ['Configurations', '*', 'Gui', 'ConnectSettings'], ['Configurations', '*', 'Gui', 'RuntimeSettings']];
const matchesField = (pattern: FieldPattern, path: (string | number)[]) => pattern.length === path.length
  && pattern.every((part, index) => part === '#' ? Number.isInteger(path[index]) : part === '*' ? typeof path[index] === 'string' : part === path[index]);
export type MaaState = { running: boolean; treeExited: boolean; idle: boolean; ready: boolean };
/**
 * The only replaceable boundary: the MAA process and its runtime observations. `version` reads the installed
 * MAA.exe product version (maa-version.ts). A boundary without it falls back to the real MAA.exe reader
 * (`readMaaVersion`, which starts PowerShell on Windows): stage-run's `switch` boundary relies on that, and a test
 * double must supply its own `version` (tests/fixtures/maa-version-guard.ts fails a test file that reaches the real reader).
 */
export interface MaaProcess {
  inspect(): Promise<MaaState>;
  close(): Promise<void>;
  start(): Promise<void>;
  version?(): Promise<string | null>;
}
/**
 * The version stamp written into a pending record or plan, read through the process boundary (or, without `version`,
 * the real MAA.exe reader); no MAA directory or no MAA.exe reads as unknown.
 */
export function versionStampOf(maaDirectory: string | null | undefined, maa: MaaProcess): Promise<MaaVersionStamp> {
  return readVersionStamp(maaDirectory, maa.version ? () => maa.version!() : undefined);
}
type RecordValue = Record<string, unknown>;
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
/** The value at a path in `sameConfigValue`'s form (object key order does not count), Timer's omitted null flag as null. */
function comparableAt(config: RecordValue, path: (string | number)[]): string | undefined {
  const value = structuredClone(at(config, path));
  // Only Timer.IsEnabled has a verified omitted-null constructor/serializer equivalence.
  if (path[0] === 'Timers') {
    const timers = path.length === 1 ? object(value).List : path[1] === 'List' ? (path.length === 2 ? value : path.length === 3 ? [value] : []) : [];
    if (Array.isArray(timers)) for (const item of timers) { const timer = object(item); if (timer.IsEnabled === null) delete timer.IsEnabled; }
  }
  return configValueKey(value);
}
/**
 * `restoreTo` is given only on doctor's restore-config path: the interrupted transaction's backup, whose values the request
 * writes back; or 'recorded-values' when replaying the pending record of such a restore, whose values this writer took from
 * that backup. The changed-field decision then goes to the predicate as `doctor-restore` with each task's backup task, so a
 * class that ends closed may take back its pre-transaction values without its grant. Ordinary writes never pass it.
 */
function prepare(config: RecordValue, request: WriteRequest, connectionMode?: 'setup' | 'recovery', baseAsset?: BaseAsset | null,
  restoreTo?: RecordValue | 'recorded-values') {
  const plans = ['jobPlan', 'trainingPlan', 'basePlan'].filter(key => Object.hasOwn(request.authorization, key));
  if (plans.length > 1) throw new Error('conflicting-authorizations');
  // The consumption predicate owns which grants may accompany a plan: only the expiring-medicine grant may accompany a job or
  // training plan, and none a base plan (it never touches consumption fields).
  const plan = plans[0] === 'jobPlan' ? 'job' as const : plans[0] === 'trainingPlan' ? 'training' as const : plans[0] === 'basePlan' ? 'base' as const : undefined;
  const decide = (decision: ConsumptionDecision) => { if (!decision.allowed) throw new Error(decision.reason!); return decision; };
  const training = request.authorization.trainingPlan ? buildTrainingChanges(config, request.authorization.trainingPlan, request.privateDirectory) : null;
  if (training && (Object.keys(request.authorization).some(key => !['source', 'reference', 'trainingPlan', 'medicineCount', 'stoneCount', 'expiringMedicine'].includes(key))
    || !sameConfigValue(training.changes, request.changes))) throw new Error('training-change-scope-mismatch');
  // Ticket 23: an approved base plan derives its own exact change set; the copy was loaded from the approved report.
  if (request.authorization.basePlan && !baseAsset) throw new Error('base-asset-required');
  const base = request.authorization.basePlan ? buildBaseChanges(config, request.authorization.basePlan, baseAsset!) : null;
  // The derived set may be empty (fields already at target): then the transaction only installs the copy (see writeConfiguration).
  // A consumption grant alongside reaches the predicate, which refuses it for a base plan with its static reason.
  if (base && (Object.keys(request.authorization).some(key => !['source', 'reference', 'basePlan', 'medicineCount', 'stoneCount', 'expiringMedicine'].includes(key))
    || request.authorization.source !== 'approved-report'
    || !sameConfigValue(base.changes, request.changes))) throw new Error('base-change-scope-mismatch');
  const next = structuredClone(config);
  const keys = new Set<string>();
  const consumptionTasks = new Set<string>();
  const enabledTasks: (string | number)[][] = [];
  const dependencies: (string | number)[][] = [];
  if (training) dependencies.push(['Configurations', training.profile, 'TaskQueue'], ['Timers']);
  if (base) dependencies.push(base.taskPath);
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
      if (path[3] === 'TaskList') allowed = sameConfigValue(value, approvedJobList(request.authorization.jobPlan, request.privateDirectory));
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
      if (type === 'Fight' && Object.hasOwn(consumptionFields, String(path[4]))) {
        // Field types and MAA ranges here; whether the grant opens the task's final settings is the predicate's decision below.
        const field = String(path[4]);
        allowed = field.startsWith('Use') ? typeof value === 'boolean'
          : field === 'MedicineExpireDays' ? Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 30
          : Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2147483647;
        consumptionTasks.add(JSON.stringify(path.slice(0, 4)));
      }
    }
    if (training || base) allowed = true;
    // Ticket 30: whatever route a change comes by, its field must be in the whitelist table.
    if (!allowed || !writerFields.some(pattern => matchesField(pattern, path))
      || (!nullableBoolean && old !== null && typeof old !== typeof value)) throw new Error('change-not-allowed');
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
  // Every consumption decision is the predicate's: changed fields, activated tasks, then the quantity budget.
  const same = (left: (string | number)[], right: (string | number)[]) => JSON.stringify(left) === JSON.stringify(right);
  const identity = (path: (string | number)[]) => {
    const type = knownTaskType(object(at(next, path)));
    if (!ordinaryTaskTypes.has(type ?? '') && !(training && type === 'OperProgress' && path[1] === training.profile
      && path[3] === request.authorization.trainingPlan!.binding.progressTask)) throw new Error('unsafe-task-settings');
  };
  const changedTasks = [...consumptionTasks].map(value => JSON.parse(value) as (string | number)[]);
  const changedTargets = changedTasks.map(path => ({ task: at(next, path), before: at(config, path) }));
  const restoring = restoreTo === undefined ? null : changedTasks.map((path, index) => ({ ...changedTargets[index]!, restore: restoreTo === 'recorded-values' ? changedTargets[index]!.task : at(restoreTo, path) }));
  const changed = decide(restoring
    ? decideConsumption(request.authorization, restoring, { consumer: 'doctor-restore', plan })
    : decideConsumption(request.authorization, changedTargets, { consumer: 'writer-whitelist', plan }));
  enabledTasks.forEach(identity);
  const activated = decide(decideConsumption(request.authorization, enabledTasks.map(path => ({ task: at(next, path), activated: true })), { consumer: 'indirect-consumption', plan }));
  // A profile consumes when this request changes an open medicine or stone quantity, or activates a task holding one.
  const quantityOpen = (state: ConsumptionDecision['tasks'][number] | undefined, kinds: string[]) => !!state
    && (kinds.includes('medicine') && state.medicine.on !== false || kinds.includes('stone') && state.stone.on !== false);
  const counted = [...changedTasks.filter((path, index) => quantityOpen(changed.tasks[index],
    request.changes.filter(change => same(change.path.slice(0, 4), path)).map(change => consumptionFields[String(change.path[4])]!))),
  ...enabledTasks.filter((_, index) => quantityOpen(activated.tasks[index], ['medicine', 'stone']))];
  const consumingProfiles = new Set(counted.map(path => String(path[1])));
  if (consumingProfiles.size) {
    dependencies.push(['Timers']);
    if (object(next.Timers).CustomConfig !== true) dependencies.push(['Current']);
  }
  for (const profile of consumingProfiles) {
    dependencies.push(['Configurations', profile, 'TaskQueue']);
    const queue = at(next, ['Configurations', profile, 'TaskQueue']);
    if (!Array.isArray(queue)) throw new Error('configuration-invalid');
    queue.forEach((value, index) => { if (object(value).IsEnable !== false) counted.push(['Configurations', profile, 'TaskQueue', index]); });
  }
  const countedTasks = [...new Map(counted.map(path => [JSON.stringify(path), path])).values()];
  countedTasks.forEach(identity);
  const scheduledRuns = new Map<string, number>(); const recurringProfiles = new Set<string>();
  const timers = object(next.Timers);
  if (!Array.isArray(timers.List)) throw new Error('configuration-invalid');
  for (const value of timers.List) {
    const timer = object(value); if (timer.IsEnabled === false) continue;
    const profile = String(timers.CustomConfig === true ? timer.Config : next.Current);
    if (!consumingProfiles.has(profile)) continue;
    scheduledRuns.set(profile, (scheduledRuns.get(profile) ?? 0) + 1);
    if (timerEnabled(timer) !== null) recurringProfiles.add(profile);
  }
  const budget = countedTasks.map((path): ConsumptionTarget => {
    const task = at(next, path); const enabled = object(task).IsEnable !== false; const profile = String(path[1]);
    return { task, counted: true, runs: enabled ? scheduledRuns.get(profile) ?? 0 : 0, recurring: enabled && recurringProfiles.has(profile) };
  });
  decide(decideConsumption(request.authorization, budget, { consumer: 'quantity-budget', plan }));
  if (dependencies.some(path => !writerDependencies.some(pattern => matchesField(pattern, path)))) throw new Error('dependency-unregistered');
  return { config: next, dependencies, trainingAsset: training?.asset ?? null, changedKeys: request.changes.filter(change => !sameConfigValue(at(config, change.path), at(next, change.path))).map(change => changedKey(change.path)) };
}
/** Whitelisted summary of one changed value: no profile name, task label, address, path or other text. */
function summarize(path: (string | number)[], value: unknown, names: string[]): unknown {
  if (path.length === 3 && path[0] === 'Configurations' && path[2] === 'TaskQueue' && Array.isArray(value)) {
    return value.map(task => task && typeof task === 'object' && !Array.isArray(task) ? knownTaskType(task as RecordValue) ?? 'OtherTask' : 'OtherTask');
  }
  if (path[0] === 'Timers' && path[1] === 'List' && path[3] === 'Config') return typeof value === 'string' ? names.indexOf(value) : null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  return Array.isArray(value) ? { kind: 'list', length: value.length } : { kind: typeof value === 'string' ? 'text' : 'object' };
}
/**
 * Ticket 30: the diff a request makes, as the user approves it: each changed key with whitelisted before and after
 * summaries, and the fingerprint. `configDiff` in config-projection.ts owns the entries and the fingerprint.
 */
export function approvedDiff(before: RecordValue, after: RecordValue, changes: Change[]) {
  const names = Object.keys(object(before.Configurations));
  const diff = configDiff(before, after, changes.map(change => change.path));
  return {
    diffFingerprint: diff.fingerprint,
    changes: diff.entries.map(entry => ({ key: changedKey(entry.path), ...(entry.path[0] === 'Configurations' ? { profile: names.indexOf(String(entry.path[1])) } : {}),
      before: summarize(entry.path, entry.before, names), after: summarize(entry.path, entry.after, names) })),
  };
}
async function readConfigurationText(maaDirectory: string) {
  const bytes = await readFile(join(maaDirectory, 'config', 'gui.new.json'));
  const text = bytes.toString('utf8');
  return { bytes, text, config: object(JSON.parse(text.replace(/^\uFEFF/, ''))) };
}
export async function readConfiguration(maaDirectory: string): Promise<RecordValue> {
  return (await readConfigurationText(maaDirectory)).config;
}
/** Ticket 30: the edited file text; only bytes that decode and re-encode unchanged can be edited in place. */
function editedText(bytes: Buffer, config: RecordValue, changes: Change[]) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('configuration-text-unsupported');
  return editConfigurationText(text, config, changes.map(change => change.path));
}
/**
 * Doctor's read-only check of the fields this writer manages, by the same type and range rules it writes with, except that the
 * medicine switch is judged by MAA's own type (`bool?`). Returns field kinds only (never a profile name or value);
 * `timerProfileMissing` marks an enabled timer whose configuration no longer exists. Unknown task types and fields the writer
 * never manages are not judged. An error here blocks a stage retry (`blockingChecks`).
 * Issue #82, corrected for Issue #89: a null `UseMedicine` is valid. When stone is turned on without allow-save, the pinned
 * GUI holds both switches as null in memory ("this run only") with MedicineCount 999, but it saves with `WhenWritingNull`
 * (ConfigFactory.cs): the file omits both keys and a restart reads them as false. A missing key was always valid here; an
 * explicit null in the file can only come from a write outside MAA. Accepting it tolerates such writes: MAA reads it as a
 * `bool?` null, and the read summary and the consumption predicate treat null (and a missing key) as on, so this opens no
 * spending. Strings, numbers, objects and arrays stay invalid.
 * Stone and expiring medicine (27) are not judged here; the read summary shows them as the consumption predicate classifies them.
 */
export function inspectManagedFields(value: unknown): { invalid: string[]; timerProfileMissing: boolean } {
  const config = object(value); const invalid = new Set<string>(); let timerProfileMissing = false;
  const profiles = object(config.Configurations);
  const integer = (item: unknown, min: number, max: number) => Number.isSafeInteger(item) && Number(item) >= min && Number(item) <= max;
  for (const name of Object.keys(profiles)) {
    const profile = profiles[name];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) { invalid.add('profile'); continue; }
    const queue = (profile as RecordValue).TaskQueue;
    if (queue === undefined) continue;
    if (!Array.isArray(queue)) { invalid.add('task-queue'); continue; }
    for (const item of queue) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { invalid.add('task'); continue; }
      const task = item as RecordValue;
      if (Object.hasOwn(task, 'IsEnable') && typeof task.IsEnable !== 'boolean') invalid.add('task.IsEnable');
      if (knownTaskType(task) !== 'Fight') continue;
      if (Object.hasOwn(task, 'UseMedicine') && task.UseMedicine !== null && typeof task.UseMedicine !== 'boolean') invalid.add('fight.UseMedicine');
      if (Object.hasOwn(task, 'MedicineCount') && !integer(task.MedicineCount, 0, 2147483647)) invalid.add('fight.MedicineCount');
    }
  }
  if (config.Timers !== undefined) {
    if (!config.Timers || typeof config.Timers !== 'object' || Array.isArray(config.Timers)) invalid.add('timers');
    else {
      const timers = config.Timers as RecordValue;
      for (const flag of ['CustomConfig', 'ForceScheduledStart', 'ShowWindowBeforeForceScheduledStart', 'NotifyBeforeScheduledStart']) {
        if (Object.hasOwn(timers, flag) && typeof timers[flag] !== 'boolean') invalid.add(`timers.${flag}`);
      }
      if (Object.hasOwn(timers, 'ScheduledStartNotificationMinutes') && !integer(timers.ScheduledStartNotificationMinutes, 0, 1439)) invalid.add('timers.ScheduledStartNotificationMinutes');
      if (timers.List !== undefined && !Array.isArray(timers.List)) invalid.add('timers.List');
      for (const item of Array.isArray(timers.List) ? timers.List : []) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { invalid.add('timer'); continue; }
        const timer = item as RecordValue; const enabled = timerEnabled(timer);
        if (enabled !== null && typeof enabled !== 'boolean') invalid.add('timer.IsEnabled');
        if (!integer(timer.Hour, 0, 23)) invalid.add('timer.Hour');
        if (!integer(timer.Minute, 0, 59)) invalid.add('timer.Minute');
        if (Object.hasOwn(timer, 'Config') && typeof timer.Config !== 'string') invalid.add('timer.Config');
        else if (enabled !== false && typeof timer.Config === 'string' && !Object.hasOwn(profiles, timer.Config)) timerProfileMissing = true;
      }
    }
  }
  return { invalid: [...invalid], timerProfileMissing };
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
  /** MAA and record versions in the pending record against the current ones; reported only, outside `evidenceRevision`. */
  versions: VersionDrift | null;
};
const operationId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

function transactionFields(value: unknown, required: string[], optional: string[] = []): RecordValue {
  const record = object(value);
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('unsupported-transaction');
  return record;
}

function transactionMetadata(value: unknown, pending = false): RecordValue {
  const record = transactionFields(value, ['id', 'skill', 'host', 'pid', 'startedAt', 'phase', ...(pending ? ['authorization', 'changes'] : [])], pending ? ['versions', 'diffFingerprint'] : []);
  if (!operationId(record.id) || (record.skill !== 'maa-daily' && record.skill !== 'maa-doctor' && record.skill !== 'maa-setup')
    || (record.host !== 'codex' && record.host !== 'claude') || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
    || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt)) || new Date(record.startedAt).toISOString() !== record.startedAt
    || typeof record.phase !== 'string' || !(pending ? ['check'] : ['check', 'close', 'backup', 'write', 'restart', 'readback', 'record', 'release']).includes(record.phase)) throw new Error('transaction-metadata-invalid');
  return record;
}

function transactionPending(value: unknown): RecordValue {
  const record = transactionMetadata(value, true);
  if (Object.hasOwn(record, 'diffFingerprint') && (typeof record.diffFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.diffFingerprint))) throw new Error('transaction-diff-invalid');
  const authorization = transactionFields(record.authorization, ['source', 'reference'], ['medicineCount', 'stoneCount', 'expiringMedicine']);
  if ((authorization.source !== 'current-request' && authorization.source !== 'approved-report')
    || typeof authorization.reference !== 'string' || !authorization.reference.trim()
    || !decideConsumption(authorization as ConsumptionGrant, [], { consumer: 'pending-record' }).allowed) throw new Error('transaction-authorization-invalid');
  if (Object.hasOwn(record, 'versions') && !isVersionStamp(record.versions)) throw new Error('transaction-versions-invalid');
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
    configuration: 'invalid', backup: 'unavailable', process: 'unverified', canReconcile: false, canRestore: false, changes: [], versions: null };
  let current: RecordValue | undefined; let metadata: RecordValue | undefined; let pendingStamp: { versions: unknown } | undefined;
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
      pendingStamp = { versions: record.versions };
      pending = { ...record, maaDirectory: context.maaDirectory, privateDirectory: context.privateDirectory } as WriteRequest;
      // A doctor record is a restore this writer built from an earlier backup: replay it with the same restore allowance.
      const expected = prepare(backup, pending, record.skill === 'maa-setup' || record.skill === 'maa-doctor' ? 'recovery' : undefined, null,
        record.skill === 'maa-doctor' ? 'recorded-values' : undefined).config;
      summary.backup = 'matched-latest';
      if (!current || summary.configuration !== 'valid') throw new Error('current-invalid');
      // Recovery compares whole configurations, never the approval projection: a repair is offered only on an exact match.
      summary.comparison = wholeConfigFingerprint(current) === wholeConfigFingerprint(backup) ? 'unchanged' : wholeConfigFingerprint(current) === wholeConfigFingerprint(expected) ? 'applied' : 'unknown';
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
  // Version differences are reported after the revision is fixed, so an unreadable version cannot invalidate an approval.
  if (pendingStamp) summary.versions = compareVersionStamp(pendingStamp.versions, await versionStampOf(context.maaDirectory, maa));
  return { summary, rawLock, rawCurrent, rawBackup, rawPending, metadata, backup, pending, current };
}

/** Safe evidence only; no account names, paths, raw settings or authorization text. */
export async function inspectConfigRecovery(context: RecoveryContext, maa: MaaProcess): Promise<RecoveryInspection> {
  return (await recoveryEvidence(context, maa)).summary;
}

export type RecoveryRequest = RecoveryContext & { host: 'codex' | 'claude'; action: 'reconcile-lock' | 'restore-config';
  evidenceRevision: string; reference: string; closedConfirmed?: boolean; medicineCount?: number; stoneCount?: number; expiringMedicine?: ExpiringMedicineGrant };

/** Recovery is owned by the same writer as ordinary configuration changes. */
export async function executeConfigRecovery(request: RecoveryRequest, maa: MaaProcess) {
  const rejected = (reason: string) => ({ status: 'rejected', reason });
  if (!['codex', 'claude'].includes(request.host) || !['reconcile-lock', 'restore-config'].includes(request.action)
    || typeof request.reference !== 'string' || !request.reference.trim() || !/^[a-f0-9]{64}$/.test(request.evidenceRevision)) return rejected('approval-required');
  // Only the repair request's own current grant may reopen consumption; the original transaction's grant is never reused.
  // A class that stays closed may take back the backup's values without a grant (the writer passes the backup as restoreTo).
  const grant = Object.fromEntries((['medicineCount', 'stoneCount', 'expiringMedicine'] as const).filter(key => request[key] !== undefined).map(key => [key, request[key]]));
  const granted = decideConsumption({ source: 'current-request', ...grant }, [], { consumer: 'doctor-recovery' });
  if (!granted.allowed) return rejected(granted.reason!);
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
        return { ...await writeConfiguration({ maaDirectory: request.maaDirectory, privateDirectory: request.privateDirectory, host: request.host,
          expectedRevision: projectionRevision(evidence.current!), closedConfirmed: request.closedConfirmed,
          authorization: { source: 'current-request', reference: request.reference, ...grant }, changes }, maa,
        { lock, rawLock: evidence.rawLock!, restoreTo: evidence.backup! }), versions: evidence.summary.versions };
      } finally { await lock.close(); }
    }
    await unlink(join(request.maaDirectory, 'config', '.maa-skills.lock'));
    return { status: 'complete', reason: null, versions: evidence.summary.versions };
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
    revision: projectionRevision(config),
    currentProfile: names.indexOf(String(config.Current)),
    profiles: names.map((name, index) => {
      const profile = object(object(config.Configurations)[name]);
      const copilot = profile.Copilot && typeof profile.Copilot === 'object' && !Array.isArray(profile.Copilot) ? object(profile.Copilot) : null;
      const queue = Array.isArray(profile.TaskQueue) ? profile.TaskQueue.map(object) : [];
      // Medicine, stone and expiring medicine as the consumption predicate classifies them; only for a verified Fight task.
      const states = decideConsumption({ source: 'current-request' }, queue.map(task => ({ task })), { consumer: 'read-summary' }).tasks;
      return { index, jobCount: Array.isArray(copilot?.TaskList) ? copilot.TaskList.length : null, queue: queue.map((task, position) => {
        const type = knownTaskType(task) ?? 'OtherTask'; const consumption = states[position];
        return { type, enabled: safeBoolean(task.IsEnable), ...(type === 'Fight' && consumption ? { consumption } : {}) };
      }) };
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
    else if (process.argv[2] === 'write' || process.argv[2] === 'preview') {
      const body = object(await readStdinJson({ maxBytes: 1024 * 1024 }));
      // Ticket 30: a preview takes the write's request without the fingerprint it is about to produce.
      const keys = ['host', 'expectedRevision', 'closedConfirmed', 'authorization', 'changes', ...(process.argv[2] === 'write' ? ['diffFingerprint'] : [])];
      if (Object.keys(body).some(key => !keys.includes(key))) throw new Error('request-invalid');
      /** A job-plan continuation (ticket 17) is written only by `stage-run.ts switch`, after the re-run gate allowed it. */
      const jobPlan = body.authorization && typeof body.authorization === 'object' ? (body.authorization as RecordValue).jobPlan : undefined;
      if (jobPlan && typeof jobPlan === 'object' && Object.hasOwn(jobPlan, 'continuation')) throw new Error('request-invalid');
      // Ticket 23: an approved base plan is applied only through base-apply.ts, which re-runs every check first.
      if (body.authorization && typeof body.authorization === 'object' && Object.hasOwn(body.authorization, 'basePlan')) throw new Error('base-apply-route-required');
      if (process.argv[2] === 'preview') {
        // Read-only: no MAA process boundary is created for a preview.
        const result = await previewConfigWrite({ ...body, maaDirectory: settings.maaDirectory, privateDirectory: settings.privateDirectory } as WriteRequest);
        console.log(JSON.stringify({ ok: result.status === 'ready', ...result }));
        if (result.status !== 'ready') process.exitCode = 1;
      } else {
        const { createMaaProcess } = await import('./maa-process.ts');
        let boundary: MaaProcess | undefined;
        const get = () => boundary ??= createMaaProcess(settings.maaDirectory!);
        const result = await executeConfigWrite({ ...body, maaDirectory: settings.maaDirectory, privateDirectory: settings.privateDirectory } as WriteRequest,
          { inspect: () => get().inspect(), close: () => get().close(), start: () => get().start(), version: () => get().version!() });
        console.log(JSON.stringify({ ok: result.status === 'complete', ...result }));
        if (result.status !== 'complete') process.exitCode = 1;
      }
    } else throw new Error('action-invalid');
  } catch (error) {
    // Ticket 26: a request refused while reading standard input reached neither MAA nor a file, so it is a plain rejection.
    const refused = stdinJsonCode(error);
    console.log(JSON.stringify(refused ? { ok: false, status: 'rejected', reason: refused } : { ok: false, status: 'check-required' })); process.exitCode = 1;
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

type Recovery = { lock: FileHandle; rawLock: string; restoreTo: RecordValue };
/**
 * The checks `preview` and `write` share, in this order and before any process access, lock or write: the request's
 * shape, the projection revision (`configuration-changed`), profile indexes, a bound plan's own files, every whitelist and
 * consumption decision (`prepare`) and the minimal edit. Returns the resolved request and the diff it makes, or a static
 * reason: the predicate's own reasons pass through, every other failed check is `request-invalid`.
 */
async function checkRequest(input: WriteRequest, recovery?: Recovery, connection?: 'setup') {
  const refuse = (reason: string) => ({ reason });
  try {
    const request = structuredClone(input);
    if (request.closedConfirmed !== undefined && typeof request.closedConfirmed !== 'boolean') return refuse('request-invalid');
    if (request.diffFingerprint !== undefined && (typeof request.diffFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(request.diffFingerprint))) return refuse('request-invalid');
    // Grant values are validated by the consumption predicate in prepare; unknown grant keys never reach a pending record.
    if (!request.authorization || typeof request.authorization !== 'object' || Object.keys(request.authorization)
      .some(key => !['source', 'reference', 'medicineCount', 'stoneCount', 'expiringMedicine', 'jobPlan', 'trainingPlan', 'basePlan'].includes(key))) return refuse('authorization-invalid');
    if (!['codex', 'claude'].includes(request.host) || !['current-request', 'approved-report'].includes(request.authorization.source)
      || typeof request.authorization.reference !== 'string' || !request.authorization.reference.trim()
      || !Array.isArray(request.changes) || !request.changes.length && !request.authorization.basePlan) return refuse('authorization-invalid');
    const { bytes, config: original } = await readConfigurationText(request.maaDirectory);
    if (typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedRevision)) return refuse('revision-required');
    // Ticket 30: the approval binds the projection; a change MAA makes only outside it does not make it stale.
    if (request.expectedRevision !== projectionRevision(original)) return refuse('configuration-changed');
    const names = Object.keys(object(original.Configurations));
    for (const change of request.changes) {
      if (change.path[0] === 'Configurations' && typeof change.path[1] === 'number') {
        const name = names[change.path[1]];
        if (!name) return refuse('profile-invalid');
        change.path[1] = name;
      }
      if (change.path[0] === 'Timers' && change.path[1] === 'List' && change.path[3] === 'Config' && typeof change.value === 'number') {
        const name = names[change.value]; if (!name) return refuse('profile-invalid'); change.value = name;
      }
    }
    if (request.authorization.jobPlan) await verifyApprovedJobFiles(request.authorization.jobPlan, request.privateDirectory);
    let baseAsset: BaseAsset | null = null;
    if (request.authorization.basePlan) {
      if (!baseReferencePattern.test(request.authorization.reference)) return refuse('authorization-invalid');
      baseAsset = await loadBaseAsset(request.privateDirectory, request.authorization.reference, checkGrant(request.authorization.basePlan));
    }
    const prepared = prepare(original, request, recovery ? 'recovery' : connection, baseAsset, recovery?.restoreTo);
    // Ticket 30: the file must take the minimal edit before anything is closed.
    if (request.changes.length) editedText(bytes, prepared.config, request.changes);
    return { request, original, prepared, baseAsset, diff: approvedDiff(original, prepared.config, request.changes) };
  } catch (error) {
    // The predicate's static reasons tell the agent which approval is missing; every other check stays request-invalid.
    const reason = error instanceof Error ? error.message : '';
    return refuse((consumptionRefusals as readonly string[]).includes(reason) ? reason : 'request-invalid');
  }
}

/**
 * Ticket 30: the read-only preview of a write request. It runs the shared checks and returns the diff the write would make
 * (each changed key with whitelisted before and after summaries), the diff's fingerprint and the projection revision it was
 * computed on. It never inspects, closes or starts MAA, takes the lock or writes a file. The user approves this diff; the
 * write then carries its fingerprint.
 */
export async function previewConfigWrite(request: WriteRequest) {
  const checked = await checkRequest(request);
  if ('reason' in checked) return { status: 'rejected' as const, reason: checked.reason, revision: null, diffFingerprint: null, changes: [] };
  return { status: 'ready' as const, reason: null, revision: projectionRevision(checked.original), diffFingerprint: checked.diff.diffFingerprint, changes: checked.diff.changes };
}

async function writeConfiguration(input: WriteRequest, maa: MaaProcess, recovery?: Recovery, connection?: 'setup') {
  const id = randomUUID();
  const rejected = (reason: string) => ({ status: 'rejected', phase: 'check', operation: id, changedKeys: [] as string[], reason });
  const checked = await checkRequest(input, recovery, connection);
  if ('reason' in checked) return rejected(checked.reason);
  const request = checked.request;
  let original = checked.original;
  let trainingAsset: TrainingAsset | null = null;
  let assetBefore: 'absent' | 'matching' | null = null;
  const baseAsset = checked.baseAsset;
  let baseBefore: 'absent' | 'matching' | null = null;
  const checkAsset = async () => {
    if (trainingAsset && await inspectTrainingAsset(trainingAsset) !== assetBefore) throw new Error('training-asset-target-changed');
    if (baseAsset && await inspectBaseAsset(baseAsset, request.privateDirectory) !== baseBefore) throw new Error('base-plan-copy-changed');
  };
  let targets: { path: (string | number)[]; value: string | undefined }[];
  const checkTargets = (config: RecordValue) => {
    if (targets.some(target => comparableAt(config, target.path) !== target.value)) throw new Error('authorized-target-changed');
  };
  try {
    const prepared = checked.prepared;
    trainingAsset = prepared.trainingAsset;
    if (trainingAsset) assetBefore = await inspectTrainingAsset(trainingAsset);
    if (baseAsset) baseBefore = await inspectBaseAsset(baseAsset, request.privateDirectory);
    // Ticket 23: a base transaction without field changes exists only to install a missing copy; anything else is a no-op.
    if (!request.changes.length && baseBefore !== 'absent') return rejected('plan-already-applied');
    targets = request.changes.map(change => {
      const path = change.path[0] === 'Configurations' && change.path[2] === 'TaskQueue' ? change.path.slice(0, Math.min(change.path.length, 4))
        : change.path[0] === 'Timers' && change.path[1] === 'List' ? change.path.slice(0, 3) : change.path;
      return { path, value: comparableAt(original, path) };
    });
    targets.push(...prepared.dependencies.map(path => ({ path, value: comparableAt(original, path) })));
    // Ticket 30: an ordinary current request must carry the diff the user approved; any request that carries one must match.
    // Plans (job, training, base), setup's entry and doctor's restore keep their own "change equals approval" checks.
    // A plan key counts only with a plan in it: a null placeholder does not lift the requirement.
    const planBound = !!(request.authorization.jobPlan || request.authorization.trainingPlan || request.authorization.basePlan);
    if (request.diffFingerprint === undefined) {
      if (request.authorization.source === 'current-request' && !planBound && !recovery && connection !== 'setup') return rejected('approved-diff-missing');
    } else if (request.diffFingerprint !== checked.diff.diffFingerprint) return rejected('approved-diff-mismatch');
    const now = new Date(); const end = new Date(now.getTime() + 120000);
    if (!checkMaintenanceWindow(original, now, end) || !checkMaintenanceWindow(prepared.config, now, end)) return rejected('timer-window');
  } catch (error) {
    // The predicate's static reasons tell the agent which approval is missing; every other check stays request-invalid.
    const reason = error instanceof Error ? error.message : '';
    return rejected((consumptionRefusals as readonly string[]).includes(reason) ? reason : 'request-invalid');
  }
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
  const connectionOnly = request.changes.length > 0 && request.changes.every(change => change.path[0] === 'Configurations' && change.path[2] === 'Gui' && change.path[3] === 'ConnectSettings');
  const metadata = { id, skill: recovery ? 'maa-doctor' : connectionOnly ? 'maa-setup' : 'maa-daily', host: request.host, pid: process.pid, startedAt: new Date().toISOString(), phase: 'check' };
  const phase = async (value: string) => {
    metadata.phase = value;
    await lock.truncate(0); await lock.write(JSON.stringify(metadata), 0, 'utf8'); await lock.sync();
  };
  let lockClosed = false;
  let closeStarted: Date;
  // Ticket 23: the run record keeps which approved plan bytes were applied and the user's decision on unverified items.
  const runRecord = request.authorization.basePlan ? { basePlan: { sha256: request.authorization.basePlan.sha256, decision: request.authorization.basePlan.decision } } : {};
  try {
    await phase('check');
    const state = await maa.inspect();
    if (!state.running && !request.closedConfirmed) throw new Error('closed-confirmation-required');
    if (state.running && !state.idle) throw new Error('maa-not-idle');
    await mkdir(request.privateDirectory, { recursive: true });
    const { authorization, changes } = request;
    await checkAsset();
    const trainingManifest = trainingAsset ? { file: trainingAsset.file, before: assetBefore, sha256: trainingAsset.sha256, immutable: true } : undefined;
    const baseManifest = baseAsset ? { file: baseAsset.relative, before: baseBefore, sha256: baseAsset.sha256, immutable: true } : undefined;
    // The MAA and record versions read now; recovery reports a difference from them and refuses nothing for it.
    const versions = await versionStampOf(request.maaDirectory, maa);
    await appendFile(join(request.privateDirectory, 'daily-pending.jsonl'), JSON.stringify({ ...metadata, authorization, changes, trainingManifest, baseManifest, versions, diffFingerprint: checked.diff.diffFingerprint }) + '\n', { mode: 0o600 });
    original = await readConfiguration(request.maaDirectory);
    checkTargets(original);
    const preview = prepare(original, request, recovery ? 'recovery' : connection, baseAsset, recovery?.restoreTo);
    closeStarted = new Date();
    const deadline = new Date(closeStarted.getTime() + 120000);
    if (!checkMaintenanceWindow(original, closeStarted, deadline) || !checkMaintenanceWindow(preview.config, closeStarted, deadline)) throw new Error('timer-window');
    await phase('close');
    if (state.running) await maa.close();
    if (!(await maa.inspect()).treeExited) throw new Error('process-tree-running');
    await phase('backup');
    const before = await readFile(file);
    const stoppedConfiguration = object(JSON.parse(before.toString('utf8').replace(/^\uFEFF/, '')));
    // Ticket 30: MAA rewrites the file from memory when it exits, so the approved diff is computed again on what it left.
    // A difference is refused before any backup or write; a MAA this transaction closed is started again.
    if (request.diffFingerprint !== undefined) {
      let closedDiff: string | null = null;
      try { closedDiff = approvedDiff(stoppedConfiguration, prepare(stoppedConfiguration, request, recovery ? 'recovery' : connection, baseAsset, recovery?.restoreTo).config, request.changes).diffFingerprint; }
      catch { /* The request no longer applies: no diff can equal the approved one. */ }
      if (closedDiff !== request.diffFingerprint) {
        if (state.running) {
          await phase('restart');
          if (Date.now() > deadline.getTime() - 60000 || !checkMaintenanceWindow(stoppedConfiguration, closeStarted, deadline)) throw new Error('maintenance-budget-exceeded');
          await maa.start();
          if (!(await maa.inspect()).ready) throw new Error('restart-unverified');
        }
        const result = { status: 'rejected', phase: 'backup', operation: id, changedKeys: [] as string[], reason: 'approved-diff-mismatch' };
        await phase('record');
        await appendFile(join(request.privateDirectory, 'daily-runs.jsonl'), JSON.stringify({ ...metadata, ...result, ...runRecord }) + '\n', { mode: 0o600 });
        await phase('release');
        if (object(JSON.parse(await readFile(lockFile, 'utf8'))).id !== id) throw new Error('lock-owner-changed');
        await lock.close(); lockClosed = true;
        await unlink(lockFile);
        return result;
      }
    }
    checkTargets(stoppedConfiguration);
    await checkAsset();
    const prepared = prepare(stoppedConfiguration, request, recovery ? 'recovery' : connection, baseAsset, recovery?.restoreTo);
    const { config, changedKeys } = prepared;
    // Ticket 30: only the changed values' text is replaced (config-edit.ts); computed before the backup so a failure writes nothing.
    const edited = request.changes.length ? editedText(before, config, request.changes) : null;
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
    if (baseAsset) await installBaseAsset(baseAsset, request.privateDirectory);
    // A copy-only base transaction (no field changes) leaves gui.new.json byte for byte as it was.
    const temporary = request.changes.length ? `${file}.${id}.tmp` : null;
    if (temporary) {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(edited!); await handle.sync(); } finally { await handle.close(); }
    }
    if (!(await maa.inspect()).treeExited || object(JSON.parse(await readFile(lockFile, 'utf8'))).id !== id) throw new Error('write-ownership-lost');
    checkBeforeRestart();
    if (temporary) await rename(temporary, file);
    await phase('restart'); checkBeforeRestart(); await maa.start();
    if (!(await maa.inspect()).ready) throw new Error('restart-unverified');
    const reopened = new Date();
    if (reopened > deadline || !checkMaintenanceWindow(original, closeStarted, reopened) || !checkMaintenanceWindow(config, closeStarted, reopened)) throw new Error('maintenance-window-exceeded');
    await phase('readback');
    const readback = await readConfiguration(request.maaDirectory);
    if (request.authorization.jobPlan) await verifyApprovedJobFiles(request.authorization.jobPlan, request.privateDirectory);
    if (trainingAsset && await inspectTrainingAsset(trainingAsset) !== 'matching') throw new Error('training-asset-readback-mismatch');
    if (baseAsset && await inspectBaseAsset(baseAsset, request.privateDirectory) !== 'matching') throw new Error('base-plan-readback-mismatch');
    for (const change of request.changes) {
      if (comparableAt(readback, change.path) !== comparableAt(config, change.path)) throw new Error('readback-mismatch');
    }
    for (const target of targets) {
      if (comparableAt(readback, target.path) !== comparableAt(config, target.path)) throw new Error('readback-target-changed');
    }
    await phase('record');
    const result = { status: 'complete', phase: 'complete', operation: id, changedKeys, reason: null };
    await appendFile(join(request.privateDirectory, 'daily-runs.jsonl'), JSON.stringify({ ...metadata, ...result, ...runRecord }) + '\n', { mode: 0o600 });
    await phase('release');
    if (object(JSON.parse(await readFile(lockFile, 'utf8'))).id !== id) throw new Error('lock-owner-changed');
    await lock.close(); lockClosed = true;
    await unlink(lockFile);
    return result;
  } catch {
    const result = { status: 'unknown', phase: metadata.phase, operation: id, changedKeys: [] as string[], reason: 'reconciliation-required' };
    try { await appendFile(join(request.privateDirectory, 'daily-runs.jsonl'), JSON.stringify({ ...metadata, ...result, ...runRecord }) + '\n', { mode: 0o600 }); }
    catch { /* The retained lock remains evidence when the private record cannot be saved. */ }
    return result;
  } finally {
    if (!lockClosed) await lock.close();
  }
}
