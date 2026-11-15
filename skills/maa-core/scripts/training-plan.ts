import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, stdinJsonCode } from './stdin-json.ts';
import { readSettings } from './preferences.ts';
import { queryTraining, materialGate } from './training-time.ts';
import { nextTrainingAction, reconcileTraining, paidRanks, holdsTrainingRoom, trainingCheckRequired, staticCode, type TrainingPlan } from './training-state.ts';
import { resolveApprovedItem } from './advice-report.ts';
import { buildTrainingChanges, trainingTimerIdentity, type TrainingGrant } from './training-config.ts';
import { executeConfigWrite, inspectConfiguration, versionStampOf, type MaaProcess } from './maa-config.ts';
import { compareVersionStamp, readMaaVersion, readVersionStamp, type MaaVersionReader } from './maa-version.ts';
import type { ExpiringMedicineGrant } from './consumption-grant.ts';
import { sameConfigValue } from './config-projection.ts';

/** A refusal with static diagnostic details (issue codes and IDs only, never paths or user text) that the CLI prints beside the code. */
export class TrainingCheckError extends Error {
  readonly details: Record<string, unknown>;
  constructor(code: string, details: Record<string, unknown>) { super(code); this.details = details; }
}
/** `versionReader` reads MAA.exe at preparation (a system boundary); apply and reconcile read it through the MAA process boundary. */
type Options = { home?: string; fetcher?: typeof fetch; versionReader?: MaaVersionReader };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('training-request-invalid');
  return value as Record<string, unknown>;
};
const roleNames: Record<string, string> = { PIONEER: 'Pioneer', WARRIOR: 'Warrior', TANK: 'Tank', SNIPER: 'Sniper', CASTER: 'Caster', SUPPORT: 'Support', MEDIC: 'Medic', SPECIAL: 'Special' };
const identifier = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id);
function bindConfiguration(config: Record<string, unknown>, plan: TrainingPlan): NonNullable<TrainingPlan['configurationBinding']> {
  const profiles = object(config.Configurations), profile = Object.keys(profiles)[plan.binding.profile];
  if (!profile) throw new Error('training-configuration-binding-invalid');
  const queue = object(profiles[profile]).TaskQueue, timers = object(config.Timers).List;
  if (!Array.isArray(queue) || !Array.isArray(timers)) throw new Error('training-configuration-binding-invalid');
  return { profile, queue: structuredClone(queue), timer: trainingTimerIdentity(timers[plan.binding.timer]) };
}
function matchesBinding(plan: TrainingPlan, actual: NonNullable<TrainingPlan['configurationBinding']>, nativeCompletion = false) {
  if (!plan.configurationBinding) return true;
  const expected = structuredClone(plan.configurationBinding);
  if (nativeCompletion) {
    if (actual.timer.IsEnabled === false && expected.timer.IsEnabled === null) expected.timer.IsEnabled = false;
    const nativePlan = object(actual.queue[plan.binding.progressTask]).Plans;
    if (plan.action?.kind === 'start' && (plan.confirmationAt || plan.action.completedAt) && Array.isArray(nativePlan) && nativePlan.length === 0)
      object(expected.queue[plan.binding.progressTask]).Plans = [];
  }
  return sameConfigValue(expected, actual);
}
async function location(id: unknown, options: Options) {
  if (!identifier(id)) throw new Error('training-plan-id-invalid');
  const settings = await readSettings(options.home), directory = join(settings.privateDirectory, 'training-plans');
  return { settings, directory, file: join(directory, `${id}.json`) };
}
async function save(file: string, plan: TrainingPlan) {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(plan, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}
async function withPlan<T>(id: unknown, options: Options, action: (plan: TrainingPlan, context: Awaited<ReturnType<typeof location>>) => Promise<T>): Promise<T> {
  const context = await location(id, options), lockFile = `${context.file}.lock`;
  const lock = await open(lockFile, 'wx', 0o600).catch(() => { throw new Error('training-record-busy-or-unknown'); });
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return await action(await readTrainingPlan(String(id), options), context); }
  finally { await lock.close(); await unlink(lockFile); }
}

/** Ticket 32: MAA's GUI configuration, read with a static failure code (never the path). */
async function readMaaConfig(maaDirectory: string) {
  try { return JSON.parse(await readFile(join(maaDirectory, 'config', 'gui.new.json'), 'utf8')); } catch { throw new Error('maa-config-unreadable'); }
}

export async function readTrainingPlan(id: string, options: Options = {}): Promise<TrainingPlan> {
  const { file } = await location(id, options);
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { throw new Error(error.code === 'ENOENT' ? 'training-plan-not-found' : 'training-plan-invalid'); });
  let plan: TrainingPlan; try { plan = JSON.parse(text); } catch { throw new Error('training-plan-invalid'); }
  if (plan.version !== 1 || plan.id !== id || !Array.isArray(plan.history) || !Array.isArray(plan.consumed) || !plan.binding || !plan.target) throw new Error('training-plan-invalid');
  return plan;
}

/** Recomputes the next rank with current inventory. It cannot broaden the authorized target. */
export async function refreshTrainingMaterials(input: unknown, options: Options = {}) {
  const request = object(input);
  return withPlan(request.id, options, async (plan, context) => {
    if (plan.closed || plan.state !== 'pending' && plan.state !== 'preplaced') throw new Error('training-stage-not-pending');
    if (object(request.query).inTraining !== undefined) throw new Error('training-in-training-refresh-unsupported');
    // Ticket 32: the plan's own completion and payment evidence reconciles a snapshot read before them (unattended re-entry).
    const { result } = await queryTraining(request.query, { ...options, evidence: { completedRank: plan.target.currentRank, paidAt: paidRanks(plan) } });
    if (result.operator?.id !== plan.target.operatorId || result.skill !== plan.target.skill || result.targetRank !== plan.rank
      || result.currentRank !== plan.target.currentRank) throw new Error('training-refresh-target-changed');
    const gate = result.status === 'ok' ? materialGate(result.startMaterials, Boolean(plan.crafting)) : 'short';
    plan.materialReady = gate !== 'short';
    if (gate === 'crafting') plan.craftingRequired = true; else delete plan.craftingRequired;
    const stage = result.stages.find(row => row.rank === plan.rank), assistant = stage?.assistants.find(row => row.id === stage.recommendedAssistant);
    if (assistant) plan.assistants[String(plan.rank)] = assistant.name;
    const after = stage?.assistants.find(row => row.id === stage.afterStartAssistant);
    if (after) { plan.afterStartAssistants ??= {}; plan.afterStartAssistants[String(plan.rank)] = after.name; }
    plan.history.push({ at: new Date().toISOString(), kind: gate === 'ready' ? 'materials-verified' : gate === 'crafting' ? 'materials-verified-with-crafting' : 'materials-pending', rank: plan.rank });
    await save(context.file, plan); return plan;
  });
}

/** Saves only a private pending record. MAA is not changed until apply. */
export async function prepareTrainingPlan(input: unknown, options: Options = {}): Promise<TrainingPlan> {
  const request = object(input), binding = object(request.binding);
  const authorization = object(request.authorization), crafting = request.crafting === undefined ? undefined : object(request.crafting);
  if (Object.keys(request).some(key => !['query', 'authorization', 'binding', 'currentTrainee', 'manualTraining', 'crafting'].includes(key))
    || !['current-request', 'approved-report'].includes(String(authorization.source)) || typeof authorization.reference !== 'string' || !authorization.reference.trim()
    || Object.keys(authorization).some(key => !['source', 'reference'].includes(key))
    || crafting && (Object.keys(crafting).some(key => key !== 'reference') || typeof crafting.reference !== 'string' || !crafting.reference.trim())
    || request.currentTrainee !== null && typeof request.currentTrainee !== 'string' || request.manualTraining !== undefined && typeof request.manualTraining !== 'boolean') throw new Error('training-authorization-required');
  const { result } = await queryTraining(request.query, options);
  if (result.status !== 'ok' || !result.operator || !result.role || !result.skillName || result.currentRank === null || result.targetRank === null)
    throw new TrainingCheckError('training-facts-required', { issues: result.issues,
      stages: result.stages.filter(stage => !stage.recommendedAssistant || stage.baseSeconds === null)
        .map(stage => ({ rank: stage.rank, assistants: stage.assistants.map(row => ({ id: row.id, issues: row.issues })) })) });
  const settings = await readSettings(options.home);
  // Ticket 32: an approved report item is resolved, not trusted as text; the plan may only narrow what it approved.
  if (authorization.source === 'approved-report') await verifyApprovedTraining(settings.privateDirectory, authorization.reference, result);
  const inTraining = result.inTrainingRank;
  // The trainee of an in-training tier is in the training room now; "no trainee" contradicts it.
  if (inTraining !== null && request.currentTrainee !== result.operator.id) throw new Error('training-in-training-trainee-conflict');
  // The gate checks only the first tier this plan will start; every later tier is checked again by refresh.
  const gate = inTraining === null ? materialGate(result.startMaterials, Boolean(crafting)) : 'short';
  const id = randomUUID(), now = new Date().toISOString(), firstRank = result.currentRank + 1;
  const plan: TrainingPlan = { version: 1, id, authorization: { source: authorization.source as 'current-request' | 'approved-report', reference: authorization.reference },
    target: { operatorId: result.operator.id, name: result.operator.name, role: roleNames[result.role]!, skill: result.skill!, skillName: result.skillName, currentRank: result.currentRank, goal: result.targetRank },
    rank: Math.min(3, firstRank), state: result.currentRank >= result.targetRank ? 'satisfied' : 'pending', createdAt: now,
    preplacementRequired: request.currentTrainee !== result.operator.id, binding: binding as TrainingPlan['binding'],
    assistants: Object.fromEntries(result.stages.map(stage => [String(stage.rank), stage.assistants.find(row => row.id === stage.recommendedAssistant)!.name])),
    afterStartAssistants: Object.fromEntries(result.stages.map(stage => [String(stage.rank), stage.assistants.find(row => row.id === stage.afterStartAssistant)!.name])),
    materialReady: gate !== 'short', manualTraining: request.manualTraining === true || inTraining !== null, assistantState: 'unverified',
    history: [{ at: now, kind: 'prepared', rank: firstRank }, ...(inTraining !== null ? [{ at: now, kind: 'in-training-user-confirmed', rank: inTraining }] : [])], consumed: [], issues: [],
    ...(inTraining !== null ? { paidAt: { [String(inTraining)]: result.inventoryAt! } } : {}),
    ...(crafting ? { crafting: { reference: crafting.reference as string } } : {}), ...(gate === 'crafting' ? { craftingRequired: true } : {}) };
  const context = await location(id, options);
  if (!context.settings.maaDirectory) throw new Error('maa-directory-unset');
  const config = await readMaaConfig(context.settings.maaDirectory);
  plan.configurationBinding = bindConfiguration(config, plan);
  plan.versions = await readVersionStamp(context.settings.maaDirectory, options.versionReader ?? readMaaVersion);
  if (plan.state !== 'satisfied') buildTrainingChanges(config, grantFor(plan, { kind: 'preplace', dueAt: new Date(Math.ceil((Date.now() + 3600000) / 60000) * 60000).toISOString() }), context.settings.privateDirectory);
  await mkdir(context.directory, { recursive: true });
  const file = await open(context.file, 'wx', 0o600); try { await file.writeFile(JSON.stringify(plan, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  return plan;
}

/**
 * Ticket 32: the approved cultivation item must still be approved and unchanged, name this operator, and let maa-daily
 * arrange mastery training of this skill to at least the plan's goal. Report errors keep their static codes.
 */
async function verifyApprovedTraining(privateDirectory: string, reference: string, result: Awaited<ReturnType<typeof queryTraining>>['result']) {
  const { state, item } = await resolveApprovedItem(privateDirectory, reference);
  const scope = object(item.scope), reportItem = state.content.items.find(entry => entry.id === item.id);
  const arranged = Array.isArray(scope.dailyMayArrange) ? scope.dailyMayArrange : [];
  if (state.kind !== 'cultivation' || !reportItem || JSON.stringify(reportItem.scope) !== JSON.stringify(item.scope)
    || !scope.operator || typeof scope.operator !== 'object' || (scope.operator as Record<string, unknown>).id !== result.operator!.id
    || !arranged.some(entry => entry && typeof entry === 'object' && (entry as Record<string, unknown>).action === 'mastery-training'
      && (entry as Record<string, unknown>).skill === result.skill && Number((entry as Record<string, unknown>).toLevel) >= result.targetRank!))
    throw new Error('training-approval-scope-mismatch');
}

/** Ticket 32: every saved plan, read through the same validation; an unreadable record is reported, never skipped. */
async function allPlans(options: Options): Promise<TrainingPlan[]> {
  const settings = await readSettings(options.home), directory = join(settings.privateDirectory, 'training-plans');
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
  const plans: TrainingPlan[] = [];
  for (const name of names.filter(entry => /^[a-zA-Z0-9-]{1,80}\.json$/.test(entry)).sort()) {
    try { plans.push(await readTrainingPlan(name.slice(0, -5), options)); } catch { throw new Error('training-plan-record-invalid'); }
  }
  return plans;
}

/** Ticket 32: safe summaries of every plan, so an unattended re-entry finds the plan that holds the training room. */
export async function listTrainingPlans(options: Options = {}) {
  return (await allPlans(options)).map(plan => ({ ...summarizeTrainingPlan(plan), holdsTrainingRoom: holdsTrainingRoom(plan), closed: Boolean(plan.closed) }))
    .sort((a, b) => Number(b.holdsTrainingRoom) - Number(a.holdsTrainingRoom) || a.history[0]!.at.localeCompare(b.history[0]!.at));
}

/**
 * Ticket 32: the user closes a plan (with their own words) after checking the game, which frees the training room for
 * the next plan. Nothing is replayed or deleted; a plan whose own one-shot timer is still armed cannot be closed.
 */
export async function closeTrainingPlan(input: unknown, options: Options = {}) {
  const request = object(input);
  if (Object.keys(request).some(key => !['id', 'reference'].includes(key)) || typeof request.reference !== 'string' || !request.reference.trim()) throw new Error('training-close-reference-required');
  return withPlan(request.id, options, async (plan, context) => {
    if (plan.closed) return { status: 'complete' as const, plan: summarizeTrainingPlan(plan) };
    // Ticket 32 R1-4: every one-shot this plan armed (in flight, finished, or awaiting cleanup) must be disabled first.
    const timers = [plan.action?.timerIdentity, plan.pendingCleanup?.timerIdentity].filter(value => value !== undefined);
    if (timers.length) {
      if (!context.settings.maaDirectory) throw new Error('maa-directory-unset');
      const current = trainingTimerIdentity((await readMaaConfig(context.settings.maaDirectory)).Timers?.List?.[plan.binding.timer]);
      if (current.IsEnabled !== false && timers.some(timer => sameConfigValue({ ...current, IsEnabled: null }, { ...trainingTimerIdentity(timer), IsEnabled: null })))
        return { status: 'check-required' as const, reason: 'training-timer-still-armed' };
    }
    const at = new Date().toISOString();
    plan.closed = { at, reference: request.reference as string };
    plan.history.push({ at, kind: 'closed-by-user', rank: plan.rank });
    await save(context.file, plan);
    return { status: 'complete' as const, plan: summarizeTrainingPlan(plan) };
  });
}

function grantFor(plan: TrainingPlan, action: { kind: TrainingGrant['kind']; dueAt: string }, expectedTimer?: unknown): TrainingGrant {
  return { planId: plan.id, kind: action.kind, dueAt: action.dueAt, binding: plan.binding,
    target: { name: plan.target.name, role: plan.target.role, skill: plan.target.skill, rank: plan.rank },
    assistant: (action.kind === 'assistant' ? plan.afterStartAssistants?.[String(plan.rank)] : undefined) ?? plan.assistants[String(plan.rank)] ?? plan.assistants[String(plan.target.goal)]!, ...(expectedTimer === undefined ? {} : { expectedTimer }) };
}

/**
 * The writer authorization for a training write. A current expiring-medicine approval (ticket 27) may accompany it: the
 * apply or reconcile request then carries the user's words for this request, and the writer's consumption predicate
 * checks the grant; without one the plan's own authorization is used unchanged.
 */
function trainingAuthorization(plan: TrainingPlan, request: Record<string, unknown>, grant: TrainingGrant) {
  if (request.expiringMedicine === undefined) return { ...plan.authorization, trainingPlan: grant };
  return { source: 'current-request' as const, reference: request.reference as string, trainingPlan: grant, expiringMedicine: request.expiringMedicine as ExpiringMedicineGrant };
}
function trainingRequest(input: unknown) {
  const request = object(input);
  if (request.expiringMedicine !== undefined && (typeof request.reference !== 'string' || !request.reference.trim())) throw new Error('training-authorization-required');
  return request;
}

/** Uses the common writer, including its lock, backup, maintenance window and readback. No device calls. */
export async function applyTrainingPlan(input: unknown, maa: MaaProcess, options: Options = {}) {
  const request = trainingRequest(input);
  return withPlan(request.id, options, async (plan, context) => {
    if (!context.settings.maaDirectory) throw new Error('maa-directory-unset');
    const maaDirectory = context.settings.maaDirectory;
    // Every result reports the MAA and record versions against those read at preparation; a difference refuses nothing.
    const drift = async () => compareVersionStamp(plan.versions, await versionStampOf(maaDirectory, maa));
    if (plan.action && !plan.action.completedAt) return { status: 'check-required', reason: 'training-reconcile-before-apply', versions: await drift() };
    if (plan.closed) return { status: 'check-required', reason: 'training-plan-closed', versions: await drift() };
    // Ticket 32 R1-3: the plan's own earlier one-shot is still armed; it must be disabled before the slot is reused.
    if (plan.pendingCleanup) return { status: 'check-required', reason: 'training-timer-cleanup-pending', versions: await drift() };
    const action = nextTrainingAction(plan, new Date().toISOString());
    // Ticket 32: a finished plan is done, not an error; a plan with nothing safe to schedule says why it stopped.
    if (!action) return ['complete', 'satisfied'].includes(plan.state) ? { status: 'done', reason: 'training-goal-reached', versions: await drift() }
      : { status: 'check-required', reason: plan.action && !plan.action.native?.startedAt ? 'training-reconcile-before-apply' : 'training-plan-stopped', versions: await drift() };
    // Ticket 32: one training room, one plan. Another plan that armed MAA and is not finished or closed keeps it.
    if ((await allPlans(options)).some(other => other.id !== plan.id && holdsTrainingRoom(other))) return { status: 'check-required', reason: 'training-other-plan-active', versions: await drift() };
    // Ticket 32 (owner: 「龙门币缺口或者其他材料缺口是可以在进行中逐步补齐的，不能因此判断计划」): a shortage keeps the plan
    // waiting for this start; it is not an error. The next re-entry refreshes materials and starts once they are covered.
    if (action.kind === 'start' && !plan.materialReady) return { status: 'waiting', reason: 'training-materials-pending', rank: plan.rank, craftingAllowed: Boolean(plan.crafting), versions: await drift() };
    const config = await readMaaConfig(context.settings.maaDirectory);
    if (!matchesBinding(plan, bindConfiguration(config, plan))) return { status: 'check-required', reason: 'training-configuration-binding-changed', versions: await drift() };
    const grant = grantFor(plan, action), prepared = buildTrainingChanges(config, grant, context.settings.privateDirectory);
    const intended = structuredClone(config);
    for (const change of prepared.changes) {
      let parent: Record<string | number, unknown> = intended;
      for (const key of change.path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
      parent[change.path.at(-1)!] = structuredClone(change.value);
    }
    const timer = config.Timers.List[plan.binding.timer], due = new Date(action.dueAt);
    const previousAction = plan.action;
    plan.action = { ...action, armedAt: new Date().toISOString(), timerIdentity: trainingTimerIdentity({ ...timer, IsEnabled: null, Config: prepared.profile, Hour: due.getHours(), Minute: due.getMinutes() }) };
    plan.history.push({ at: plan.action.armedAt, kind: `arming-${action.kind}`, rank: plan.rank });
    await save(context.file, plan);
    const result = await executeConfigWrite({ maaDirectory: context.settings.maaDirectory, privateDirectory: context.settings.privateDirectory,
      host: request.host as 'codex' | 'claude', closedConfirmed: request.closedConfirmed as boolean | undefined,
      expectedRevision: (await inspectConfiguration(context.settings.maaDirectory)).revision, authorization: { ...trainingAuthorization(plan, request, grant) }, changes: prepared.changes }, maa);
    plan.action.operation = result.operation;
    if (result.status === 'complete') {
      if (action.kind === 'start') plan.materialReady = false;
      plan.configurationBinding = bindConfiguration(intended, plan);
    } else if (result.status === 'rejected' || result.status === 'busy') {
      plan.action = previousAction; plan.history.push({ at: new Date().toISOString(), kind: `configuration-${result.status}-before-write`, rank: plan.rank });
    }
    else { plan.state = 'unknown'; plan.issues.push(`training:configuration-${result.status}`); }
    await save(context.file, plan);
    return { ...result, versions: await drift() };
  });
}

/** Re-entry is explicit: no daemon promises to clean a timer while this tool is offline. */
export async function reconcileTrainingPlan(input: unknown, maa: MaaProcess, options: Options = {}) {
  const request = trainingRequest(input);
  if (typeof request.logFile !== 'string') throw new Error('training-log-required');
  return withPlan(request.id, options, async (original, context) => {
    if (!context.settings.maaDirectory) throw new Error('maa-directory-unset');
    const observedAt = new Date().toISOString(), action = original.action;
    const logFile = await realpath(request.logFile as string), fromMaa = relative(await realpath(context.settings.maaDirectory), logFile);
    if (!fromMaa || fromMaa === '..' || fromMaa.startsWith(`..${sep}`) || isAbsolute(fromMaa)) throw new Error('training-log-instance-mismatch');
    const handle = await open(logFile, 'r'); let text: string;
    try { if ((await handle.stat()).size > 32 * 1024 * 1024) throw new Error('training-log-too-large'); text = await handle.readFile('utf8'); } finally { await handle.close(); }
    const plan = reconcileTraining(original, text, observedAt);
    let cleanup: { status: string; reason?: string | null } | undefined;
    const expired = action && Date.parse(action.dueAt) + 60000 < Date.parse(observedAt);
    const terminal = ['failed', 'complete', 'satisfied'].includes(plan.state);
    // The plan's own one-shot to disable: the current action's once it expired, finished or the plan ended, or one an
    // earlier re-entry could not disable yet (ticket 32 R1-3: the writer refused before writing; nothing was changed).
    const owned = action?.timerIdentity && (expired || terminal || plan.action?.completedAt) ? { timerIdentity: action.timerIdentity, dueAt: action.dueAt } : original.pendingCleanup;
    if (owned) {
      const config = await readMaaConfig(context.settings.maaDirectory);
      const current = trainingTimerIdentity(config.Timers?.List?.[plan.binding.timer]);
      const expected = trainingTimerIdentity(owned.timerIdentity);
      if (!sameConfigValue({ ...current, IsEnabled: null }, { ...expected, IsEnabled: null }) || current.IsEnabled === true) {
        cleanup = { status: 'check-required', reason: 'training-timer-ownership-changed' };
      } else if (current.IsEnabled === false) cleanup = { status: 'complete', reason: 'training-timer-already-disabled' };
      else {
        const grant = grantFor(original, { kind: 'disable', dueAt: owned.dueAt }, current);
        const prepared = buildTrainingChanges(config, grant, context.settings.privateDirectory);
        await save(context.file, plan);
        cleanup = await executeConfigWrite({ maaDirectory: context.settings.maaDirectory, privateDirectory: context.settings.privateDirectory,
          host: request.host as 'codex' | 'claude', closedConfirmed: request.closedConfirmed as boolean | undefined,
          expectedRevision: (await inspectConfiguration(context.settings.maaDirectory)).revision,
          authorization: { ...trainingAuthorization(plan, request, grant) }, changes: prepared.changes }, maa);
      }
      if (cleanup?.status === 'complete') { delete plan.pendingCleanup; plan.issues = plan.issues.filter(issue => issue !== 'training:timer-cleanup-pending'); }
      else if (cleanup?.status === 'rejected' || cleanup?.status === 'busy') { plan.pendingCleanup = owned; plan.issues.push('training:timer-cleanup-pending'); }
      else { if (!terminal) plan.state = 'unknown'; plan.issues.push('training:expired-timer-not-disabled'); }
    }
    if (expired && !plan.action?.completedAt && plan.rank === original.rank && !terminal) {
      plan.state = 'unknown'; plan.issues.push('training:execution-unproven-no-replay');
    }
    const actualBinding = bindConfiguration(await readMaaConfig(context.settings.maaDirectory), original);
    const observedOriginal = { ...original, confirmationAt: plan.confirmationAt ?? original.confirmationAt,
      action: plan.rank === original.rank ? plan.action : { ...original.action!, completedAt: observedAt } };
    if (matchesBinding(observedOriginal, actualBinding, true)) plan.configurationBinding = actualBinding;
    else { if (!terminal) plan.state = 'unknown'; plan.issues.push('training:configuration-binding-changed'); }
    plan.issues = [...new Set(plan.issues)]; await save(context.file, plan);
    return { plan, cleanup, versions: compareVersionStamp(original.versions, await versionStampOf(context.settings.maaDirectory, maa)) };
  });
}

export function summarizeTrainingPlan(plan: TrainingPlan) {
  return { id: plan.id, target: plan.target, rank: plan.rank, state: plan.state, materialReady: plan.materialReady, assistantState: plan.assistantState,
    manualTraining: plan.manualTraining, craftingAllowed: Boolean(plan.crafting), craftingRequired: plan.craftingRequired === true, closed: Boolean(plan.closed), cleanupPending: Boolean(plan.pendingCleanup),
    action: plan.action ? { kind: plan.action.kind, dueAt: plan.action.dueAt, completedAt: plan.action.completedAt } : null,
    expectedCompleteAt: plan.expectedCompleteAt ?? null, history: plan.history, issues: plan.issues, versions: plan.versions ?? null };
}

const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  try {
    if (process.argv.length !== 3) throw new Error('training-action-invalid');
    const request = object(await readStdinJson({ maxBytes: 1024 * 1024 })); let result: unknown, printed: unknown;
    if (process.argv[2] === 'prepare') result = summarizeTrainingPlan(await prepareTrainingPlan(request));
    else if (process.argv[2] === 'read') result = summarizeTrainingPlan(await readTrainingPlan(String(request.id)));
    else if (process.argv[2] === 'refresh') result = summarizeTrainingPlan(await refreshTrainingMaterials(request));
    else if (process.argv[2] === 'list') {
      if (Object.keys(request).length) throw new Error('training-request-invalid');
      result = await listTrainingPlans();
    } else if (process.argv[2] === 'close') {
      const closed = await closeTrainingPlan(request);
      if (closed.status === 'check-required') { printed = trainingCheckRequired(closed.reason); process.exitCode = 1; } else result = closed;
    }
    else if (['apply', 'reconcile'].includes(process.argv[2]!)) {
      const settings = await readSettings(); if (!settings.maaDirectory) throw new Error('maa-directory-unset');
      const { createMaaProcess } = await import('./maa-process.ts');
      if (process.argv[2] === 'apply') {
        const applied = object(await applyTrainingPlan(request, createMaaProcess(settings.maaDirectory)));
        if (applied.status === 'check-required') { printed = trainingCheckRequired(String(applied.reason), { versions: applied.versions }); process.exitCode = 1; }
        else { result = applied; if (!['complete', 'waiting', 'done'].includes(String(applied.status))) process.exitCode = 1; }
      } else {
        const reconciled = await reconcileTrainingPlan(request, createMaaProcess(settings.maaDirectory));
        result = { ...reconciled, plan: summarizeTrainingPlan(reconciled.plan) };
        if (reconciled.cleanup?.status === 'check-required') printed = trainingCheckRequired(String(reconciled.cleanup.reason), object(result));
        if (reconciled.cleanup && reconciled.cleanup.status !== 'complete') process.exitCode = 1;
      }
    } else throw new Error('training-action-invalid');
    console.log(JSON.stringify(printed ?? { ok: process.exitCode !== 1, result }));
  } catch (error) {
    // Ticket 32: standard-input rejections keep their own code; everything else names its reason, what to check and the alternatives.
    const stdin = stdinJsonCode(error);
    console.error(JSON.stringify(stdin ? { ok: false, error: stdin }
      : trainingCheckRequired(staticCode(error) ?? 'training-unclassified-failure', error instanceof TrainingCheckError ? error.details : undefined)));
    process.exitCode = 1;
  }
}
