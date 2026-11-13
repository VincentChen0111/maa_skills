// Ticket 23: maa-daily applies a base plan the user approved in a base report (ticket 22). Before every write it checks
// the approval, the plan bytes, the three-state freshness and the shared check (the six rules and the 15 gates, run
// again now), and asks the user to decide on whatever is still unverified. The write itself goes only through the
// common MAA configuration writer (ticket 05). It never rewrites the account's report or snapshot, never runs MAA's
// tasks, never clicks the game and never operates a device; later infrastructure runs are started by the user or by
// MAA's own timer. Field names are pinned to MAA v6.21.4; sources are in docs/base-apply-verification.md.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './preferences.ts';
import { resolveApprovedItem } from './advice-report.ts';
import { readPrivateFile, type GateResult, type Freshness, type PlanInputs } from './base-plan.ts';
import { baseApplyRecheck, reportPlanText, type BaseContent } from './base-report.ts';
import { baseReferencePattern, buildBaseChanges, inspectBaseAsset, loadBaseAsset, type BaseAsset, type BaseDecision, type BasePlanGrant } from './base-config.ts';
import { executeConfigWrite, inspectConfigWriteLock, inspectConfiguration, type Change, type MaaProcess } from './maa-config.ts';

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown): ObjectValue => isObject(value) ? value : {};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (error: unknown) => error instanceof Error && /^(base|plan|report|maa|configuration|public-data)-[A-Za-z0-9:,_-]+$/.test(error.message) ? error.message : 'base-apply-check-failed';
const hm = (hour: unknown, minute: unknown) => Number.isInteger(hour) && Number.isInteger(minute) ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : '??:??';

export type Options = { home?: string; fetcher?: typeof fetch };
export type Unverified = { id: string; evidence: string[] };
export type ApplyCheck = {
  status: 'ready' | 'needs-decision' | 'refused'; reasons: string[]; reference: string;
  review: 'reviewed' | 'unreviewed' | null; approvedAt: string | null;
  plan: { file: string; sha256: string; original: 'matching' | 'missing' | 'changed' | 'outside' | 'invalid'; applied: string } | null;
  freshness: Record<keyof PlanInputs | 'check', Freshness> | null;
  check: { applicable: boolean; errors: string[]; warnings: string[]; gates: GateResult[] } | null;
  unverified: Unverified[]; decision: BaseDecision | null;
  configuration: { changes: string[]; taskEnabled: boolean | null; lock: string | null; copy: 'absent' | 'matching' | null; notes: string[] } | null;
};
type Internal = { result: ApplyCheck; grant?: BasePlanGrant; changes?: Change[]; asset?: BaseAsset; maaDirectory?: string; privateDirectory: string };

const checkKeys = ['reference', 'profile', 'task', 'decision'];
const applyKeys = [...checkKeys, 'host', 'expectedRevision', 'closedConfirmed'];
function parseInput(value: unknown, keys: string[]) {
  const input = object(value), decision = input.decision === undefined ? undefined : object(input.decision);
  if (!isObject(value) || Object.keys(input).some(key => !keys.includes(key)) || typeof input.reference !== 'string'
    || !Number.isSafeInteger(input.profile) || Number(input.profile) < 0 || !Number.isSafeInteger(input.task) || Number(input.task) < 0
    || decision && (Object.keys(decision).some(key => !['acceptUnverified', 'userWords'].includes(key)) || !Array.isArray(decision.acceptUnverified)
      || decision.acceptUnverified.some(entry => typeof entry !== 'string' || !entry) || typeof decision.userWords !== 'string' || !decision.userWords.trim() || decision.userWords.length > 2000))
    throw new Error('base-apply-input-invalid');
  return { reference: input.reference, profile: Number(input.profile), task: Number(input.task),
    decision: decision ? { accept: decision.acceptUnverified as string[], userWords: decision.userWords as string } : null, input };
}

/** Facts MAA's GUI uses but the plan check cannot see: timers and the weekly switch of this task. */
function configurationNotes(config: ObjectValue, profile: string, task: ObjectValue, runs: string[] | null): { unverified: Unverified[]; notes: string[] } {
  const timers = object(config.Timers), list = Array.isArray(timers.List) ? timers.List.map(object) : [];
  // A daily timer (IsEnabled true) runs the profile it names in custom-config mode, otherwise the current profile.
  const times = [...new Set(list.filter(timer => timer.IsEnabled === true && (timers.CustomConfig === true ? timer.Config === profile : config.Current === profile))
    .map(timer => hm(timer.Hour, timer.Minute)))].sort();
  const unverified: Unverified[] = [];
  if (runs && JSON.stringify(times) !== JSON.stringify([...runs].sort()))
    unverified.push({ id: 'maa-timers', evidence: [`排班按每天 ${[...runs].sort().join('、')} 运行检查；这个 MAA 配置的每日定时是 ${times.length ? times.join('、') : '没有'}。由你手动或其他方式在这些时间运行时可以不管这一项`] });
  const notes: string[] = [];
  if (task.IsEnable === false) notes.push('infrast-task-disabled');
  if (task.UseWeeklySchedule === true && Object.values(object(task.WeeklySchedule)).some(day => day === false)) notes.push('weekly-schedule-skips-days');
  return { unverified, notes };
}

async function inspect(value: unknown, options: Options, keys: string[]): Promise<Internal> {
  const input = parseInput(value, keys);
  const settings = await readSettings(options.home);
  const result: ApplyCheck = { status: 'refused', reasons: [], reference: input.reference, review: null, approvedAt: null, plan: null, freshness: null, check: null,
    unverified: [], decision: null, configuration: null };
  const internal: Internal = { result, privateDirectory: settings.privateDirectory };
  const refuse = (reason: string) => { result.reasons.push(reason); return internal; };
  if (!baseReferencePattern.test(input.reference)) return refuse('base-reference-invalid');
  // 1. The approval: this exact report version, item P1, approved by the user; the approved scope is still the report's.
  let resolved: Awaited<ReturnType<typeof resolveApprovedItem>>;
  try { resolved = await resolveApprovedItem(settings.privateDirectory, input.reference); } catch (error) { return refuse(code(error)); }
  const content = resolved.state.content as BaseContent, scope = object(resolved.item.scope);
  result.review = resolved.approval.reviewStatus; result.approvedAt = resolved.approval.approvedAt;
  const reportItem = content.items.find(entry => entry.id === resolved.item.id);
  if (!reportItem || JSON.stringify(reportItem.scope) !== JSON.stringify(resolved.item.scope)) return refuse('base-approval-scope-mismatch');
  if (scope.applicable !== true) result.reasons.push('base-plan-not-applicable');
  const sha256 = String(scope.sha256), text = reportPlanText(content);
  // 2. The plan bytes: the report keeps the approved plan; it must hash to the approved SHA-256. The account's plan
  // file, if still there, must be unchanged and inside the private directory.
  if (!/^[a-f0-9]{64}$/.test(sha256) || digest(text) !== sha256 || content.plan.sha256 !== sha256 || content.plan.file !== scope.planFile) result.reasons.push('base-plan-content-mismatch');
  let original: NonNullable<ApplyCheck['plan']>['original'];
  try { original = digest(await readPrivateFile(settings.privateDirectory, scope.planFile)) === sha256 ? 'matching' : 'changed'; }
  catch (error) { const message = code(error); original = message === 'plan-file-missing' ? 'missing' : message === 'plan-path-outside-private' ? 'outside' : 'invalid'; }
  if (original === 'changed') result.reasons.push('base-plan-changed');
  if (original === 'outside') result.reasons.push('plan-path-outside-private');
  if (original === 'invalid') result.reasons.push('plan-path-invalid');
  result.plan = { file: String(scope.planFile), sha256, original, applied: `base-applied/${sha256}.json` };
  // 3. Freshness (22's three states) and the shared check, run again now on the current inputs.
  const { states, recheck } = await baseApplyRecheck(settings.privateDirectory, content, options);
  result.freshness = states;
  if (states.snapshot === 'stale') result.reasons.push('base-snapshot-changed');
  if (states.snapshot === 'unknown') result.reasons.push('base-snapshot-unavailable');
  if (states.tables === 'unknown') result.reasons.push('base-tables-unavailable');
  if (recheck) {
    result.check = { applicable: recheck.applicable, errors: recheck.errors, warnings: recheck.warnings, gates: recheck.gates };
    if (!recheck.applicable) result.reasons.push('base-plan-not-applicable');
    result.unverified = recheck.unverified.map(id => { const gate = /^gate-(\d+)$/.exec(id);
      return { id, evidence: gate ? recheck.gates.find(entry => entry.gate === Number(gate[1]))?.evidence ?? [] : [] }; });
  } else if (!result.reasons.some(reason => /^base-(snapshot|tables)-/.test(reason))) result.reasons.push('base-recheck-unavailable');
  // 4. The MAA configuration: the chosen Infrast task, its visited rooms, the lock and the copy MAA would read.
  if (!settings.maaDirectory) result.reasons.push('maa-directory-unset');
  else if (!result.reasons.includes('base-plan-content-mismatch')) {
    internal.maaDirectory = settings.maaDirectory;
    const configuration: NonNullable<ApplyCheck['configuration']> = { changes: [], taskEnabled: null, lock: await inspectConfigWriteLock(settings.maaDirectory), copy: null, notes: [] };
    result.configuration = configuration;
    if (configuration.lock) result.reasons.push('lock-requires-reconciliation');
    try {
      const config = object(JSON.parse((await readFile(join(settings.maaDirectory, 'config', 'gui.new.json'), 'utf8')).replace(/^﻿/, '')));
      const grant: BasePlanGrant = { sha256, binding: { profile: input.profile, task: input.task }, decision: { unverified: [], userWords: null } };
      const asset = await loadBaseAsset(settings.privateDirectory, input.reference, grant);
      const built = buildBaseChanges(config, grant, asset);
      const task = object((object(object(config.Configurations)[built.profile]).TaskQueue as unknown[])[input.task]);
      configuration.changes = built.changes.map(change => String(change.path.at(-1)));
      configuration.taskEnabled = built.enabled;
      const facts = configurationNotes(config, built.profile, task, recheck?.facts.runs ?? null);
      result.unverified.push(...facts.unverified); configuration.notes = facts.notes;
      configuration.copy = await inspectBaseAsset(asset, settings.privateDirectory);
      Object.assign(internal, { grant, changes: built.changes, asset });
    } catch (error) { result.reasons.push(code(error)); }
  }
  // 5. The user's decision on everything still unverified, given explicitly; nothing unverified counts as passed.
  const ids = result.unverified.map(entry => entry.id);
  if (input.decision && ids.every(id => input.decision!.accept.includes(id))) result.decision = { unverified: ids, userWords: ids.length ? input.decision.userWords : null };
  else if (!ids.length) result.decision = { unverified: [], userWords: null };
  result.status = result.reasons.length ? 'refused' : result.decision ? 'ready' : 'needs-decision';
  if (internal.grant && result.decision) internal.grant.decision = result.decision;
  return internal;
}

/** Read-only: what applying would do now, or why it cannot. */
export async function checkBaseApply(value: unknown, options: Options = {}): Promise<ApplyCheck> {
  return (await inspect(value, options, checkKeys)).result;
}

/**
 * Re-runs every check, then writes through the common writer only: lock, MAA shutdown, backup, timer window, minimal
 * change and read-back. A rejected request writes nothing; an unknown outcome keeps its evidence for maa-doctor and is
 * never retried here.
 */
export async function applyBasePlan(value: unknown, maa: MaaProcess, options: Options = {}) {
  const input = object(value);
  if (!['codex', 'claude'].includes(String(input.host)) || typeof input.expectedRevision !== 'string'
    || input.closedConfirmed !== undefined && typeof input.closedConfirmed !== 'boolean') throw new Error('base-apply-input-invalid');
  const internal = await inspect(value, options, applyKeys), checked = internal.result;
  const summary = { review: checked.review, plan: checked.plan, unverified: checked.unverified, decision: checked.decision && { unverified: checked.decision.unverified },
    notes: checked.configuration?.notes ?? [] };
  if (checked.status !== 'ready' || !internal.grant || !internal.changes || !internal.asset || !internal.maaDirectory)
    return { status: 'rejected', phase: 'check', operation: null, changedKeys: [], backup: null, readback: null, reason: checked.status === 'needs-decision' ? 'base-unverified-decision-required' : checked.reasons[0] ?? 'base-apply-check-failed',
      reasons: checked.reasons, check: checked.check, ...summary };
  if (!internal.changes.length) {
    // Nothing to change: the configuration already points at the approved copy. Still no write while a lock is retained.
    if ((await inspectConfiguration(internal.maaDirectory)).revision !== input.expectedRevision) return { status: 'rejected', phase: 'check', operation: null, changedKeys: [], backup: null, readback: null, reason: 'configuration-changed', ...summary };
    if (await inspectBaseAsset(internal.asset, internal.privateDirectory) !== 'matching') return { status: 'rejected', phase: 'check', operation: null, changedKeys: [], backup: null, readback: null, reason: 'base-plan-copy-missing', ...summary };
    return { status: 'unchanged', phase: 'check', operation: null, changedKeys: [], backup: null, readback: null, reason: 'plan-already-applied', ...summary };
  }
  const result = await executeConfigWrite({ maaDirectory: internal.maaDirectory, privateDirectory: internal.privateDirectory, host: input.host as 'codex' | 'claude',
    expectedRevision: input.expectedRevision, ...(input.closedConfirmed === undefined ? {} : { closedConfirmed: input.closedConfirmed as boolean }),
    authorization: { source: 'approved-report', reference: checked.reference, basePlan: internal.grant }, changes: internal.changes }, maa);
  const complete = result.status === 'complete';
  return { ...result, backup: complete ? `maa-config-backups/${result.operation}.json` : null,
    // Read-back covers exactly the values written and the copy's bytes. Which plan MAA runs is chosen by the GUI from
    // `period` at each run; nothing here observes or claims that switch.
    readback: complete ? { fields: checked.configuration!.changes, copy: 'matching', periodSelection: 'gui-at-each-run-not-observed' } : null, ...summary };
}

const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    const action = process.argv[2];
    if (process.argv.length !== 3 || !['check', 'apply'].includes(action!)) throw new Error('base-apply-action-invalid');
    let raw = ''; for await (const chunk of process.stdin) { raw += String(chunk); if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('base-apply-input-invalid'); }
    const input = JSON.parse(raw) as unknown;
    if (action === 'check') {
      const result = await checkBaseApply(input);
      process.stdout.write(JSON.stringify({ ok: result.status === 'ready', ...result }));
      if (result.status !== 'ready') process.exitCode = 1;
    } else {
      const settings = await readSettings();
      if (!settings.maaDirectory) throw new Error('maa-directory-unset');
      const { createMaaProcess } = await import('./maa-process.ts');
      let boundary: MaaProcess | undefined;
      const get = () => boundary ??= createMaaProcess(settings.maaDirectory!);
      const result = await applyBasePlan(input, { inspect: () => get().inspect(), close: () => get().close(), start: () => get().start() });
      process.stdout.write(JSON.stringify({ ok: result.status === 'complete' || result.status === 'unchanged', ...result }));
      if (result.status !== 'complete' && result.status !== 'unchanged') process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: code(error) })); process.exitCode = 1;
  }
}
