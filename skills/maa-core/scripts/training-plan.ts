import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './preferences.ts';
import { queryTraining } from './training-time.ts';
import { nextTrainingAction, reconcileTraining, type TrainingPlan } from './training-state.ts';
import { buildTrainingChanges, trainingTimerIdentity, type TrainingGrant } from './training-config.ts';
import { executeConfigWrite, inspectConfiguration, versionStampOf, type MaaProcess } from './maa-config.ts';
import { compareVersionStamp, readMaaVersion, readVersionStamp, type MaaVersionReader } from './maa-version.ts';

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
  return JSON.stringify(expected) === JSON.stringify(actual);
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

export async function readTrainingPlan(id: string, options: Options = {}): Promise<TrainingPlan> {
  const { file } = await location(id, options), plan = JSON.parse(await readFile(file, 'utf8'));
  if (plan.version !== 1 || plan.id !== id || !Array.isArray(plan.history) || !Array.isArray(plan.consumed) || !plan.binding || !plan.target) throw new Error('training-plan-invalid');
  return plan;
}

/** Recomputes the next rank with current inventory. It cannot broaden the authorized target. */
export async function refreshTrainingMaterials(input: unknown, options: Options = {}) {
  const request = object(input);
  return withPlan(request.id, options, async (plan, context) => {
    if (plan.state !== 'pending' && plan.state !== 'preplaced') throw new Error('training-stage-not-pending');
    const { result } = await queryTraining(request.query, options);
    if (result.operator?.id !== plan.target.operatorId || result.skill !== plan.target.skill || result.targetRank !== plan.rank
      || result.currentRank !== plan.target.currentRank) throw new Error('training-refresh-target-changed');
    const material = result.materials.comparison?.noCraft;
    plan.materialReady = Boolean(result.status === 'ok' && material && [...Object.values(material.materials), material.lmd, material.exp].every(row => row.remaining === 0));
    const stage = result.stages.find(row => row.rank === plan.rank), assistant = stage?.assistants.find(row => row.id === stage.recommendedAssistant);
    if (assistant) plan.assistants[String(plan.rank)] = assistant.name;
    const after = stage?.assistants.find(row => row.id === stage.afterStartAssistant);
    if (after) { plan.afterStartAssistants ??= {}; plan.afterStartAssistants[String(plan.rank)] = after.name; }
    plan.history.push({ at: new Date().toISOString(), kind: plan.materialReady ? 'materials-verified' : 'materials-pending', rank: plan.rank });
    await save(context.file, plan); return plan;
  });
}

/** Saves only a private pending record. MAA is not changed until apply. */
export async function prepareTrainingPlan(input: unknown, options: Options = {}): Promise<TrainingPlan> {
  const request = object(input), binding = object(request.binding);
  const authorization = object(request.authorization);
  if (Object.keys(request).some(key => !['query', 'authorization', 'binding', 'currentTrainee', 'manualTraining'].includes(key))
    || !['current-request', 'approved-report'].includes(String(authorization.source)) || typeof authorization.reference !== 'string' || !authorization.reference.trim()
    || request.currentTrainee !== null && typeof request.currentTrainee !== 'string' || request.manualTraining !== undefined && typeof request.manualTraining !== 'boolean') throw new Error('training-authorization-required');
  const { result } = await queryTraining(request.query, options);
  if (result.status !== 'ok' || !result.operator || !result.role || !result.skillName || result.currentRank === null || result.targetRank === null) throw new Error('training-facts-required');
  const material = result.materials.comparison?.noCraft;
  const materialReady = Boolean(material && [...Object.values(material.materials), material.lmd, material.exp].every(row => row.remaining === 0));
  const id = randomUUID(), now = new Date().toISOString();
  const plan: TrainingPlan = { version: 1, id, authorization: { source: authorization.source as 'current-request' | 'approved-report', reference: authorization.reference },
    target: { operatorId: result.operator.id, name: result.operator.name, role: roleNames[result.role]!, skill: result.skill!, skillName: result.skillName, currentRank: result.currentRank, goal: result.targetRank },
    rank: Math.min(3, result.currentRank + 1), state: result.currentRank >= result.targetRank ? 'satisfied' : 'pending', createdAt: now,
    preplacementRequired: request.currentTrainee !== result.operator.id, binding: binding as TrainingPlan['binding'],
    assistants: Object.fromEntries(result.stages.map(stage => [String(stage.rank), stage.assistants.find(row => row.id === stage.recommendedAssistant)!.name])),
    afterStartAssistants: Object.fromEntries(result.stages.map(stage => [String(stage.rank), stage.assistants.find(row => row.id === stage.afterStartAssistant)!.name])),
    materialReady, manualTraining: request.manualTraining === true, assistantState: 'unverified', history: [{ at: now, kind: 'prepared', rank: result.currentRank + 1 }], consumed: [], issues: [] };
  const context = await location(id, options);
  if (!context.settings.maaDirectory) throw new Error('maa-directory-unset');
  const config = JSON.parse(await readFile(join(context.settings.maaDirectory, 'config', 'gui.new.json'), 'utf8'));
  plan.configurationBinding = bindConfiguration(config, plan);
  plan.versions = await readVersionStamp(context.settings.maaDirectory, options.versionReader ?? readMaaVersion);
  if (plan.state !== 'satisfied') buildTrainingChanges(config, grantFor(plan, { kind: 'preplace', dueAt: new Date(Math.ceil((Date.now() + 3600000) / 60000) * 60000).toISOString() }), context.settings.privateDirectory);
  await mkdir(context.directory, { recursive: true });
  const file = await open(context.file, 'wx', 0o600); try { await file.writeFile(JSON.stringify(plan, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  return plan;
}

function grantFor(plan: TrainingPlan, action: { kind: TrainingGrant['kind']; dueAt: string }, expectedTimer?: unknown): TrainingGrant {
  return { planId: plan.id, kind: action.kind, dueAt: action.dueAt, binding: plan.binding,
    target: { name: plan.target.name, role: plan.target.role, skill: plan.target.skill, rank: plan.rank },
    assistant: (action.kind === 'assistant' ? plan.afterStartAssistants?.[String(plan.rank)] : undefined) ?? plan.assistants[String(plan.rank)] ?? plan.assistants[String(plan.target.goal)]!, ...(expectedTimer === undefined ? {} : { expectedTimer }) };
}

/** Uses the common writer, including its lock, backup, maintenance window and readback. No device calls. */
export async function applyTrainingPlan(input: unknown, maa: MaaProcess, options: Options = {}) {
  const request = object(input);
  return withPlan(request.id, options, async (plan, context) => {
    if (!context.settings.maaDirectory) throw new Error('maa-directory-unset');
    const maaDirectory = context.settings.maaDirectory;
    // Every result reports the MAA and record versions against those read at preparation; a difference refuses nothing.
    const drift = async () => compareVersionStamp(plan.versions, await versionStampOf(maaDirectory, maa));
    if (plan.action && !plan.action.completedAt) return { status: 'check-required', reason: 'training-reconcile-before-apply', versions: await drift() };
    const action = nextTrainingAction(plan, new Date().toISOString());
    if (!action || action.kind === 'start' && !plan.materialReady) return { status: 'check-required', reason: 'training-facts-or-materials-required', versions: await drift() };
    const config = JSON.parse(await readFile(join(context.settings.maaDirectory, 'config', 'gui.new.json'), 'utf8'));
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
      expectedRevision: (await inspectConfiguration(context.settings.maaDirectory)).revision, authorization: { ...plan.authorization, trainingPlan: grant }, changes: prepared.changes }, maa);
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
  const request = object(input);
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
    if (action?.timerIdentity && (expired || terminal || plan.action?.completedAt)) {
      const config = JSON.parse(await readFile(join(context.settings.maaDirectory, 'config', 'gui.new.json'), 'utf8'));
      const current = trainingTimerIdentity(config.Timers?.List?.[plan.binding.timer]);
      const expected = trainingTimerIdentity(action.timerIdentity);
      if (JSON.stringify({ ...current, IsEnabled: null }) !== JSON.stringify({ ...expected, IsEnabled: null }) || current.IsEnabled === true) {
        cleanup = { status: 'check-required', reason: 'training-timer-ownership-changed' };
      } else if (current.IsEnabled === false) cleanup = { status: 'complete', reason: 'training-timer-already-disabled' };
      else {
        const grant = grantFor(original, { kind: 'disable', dueAt: action.dueAt }, current);
        const prepared = buildTrainingChanges(config, grant, context.settings.privateDirectory);
        await save(context.file, plan);
        cleanup = await executeConfigWrite({ maaDirectory: context.settings.maaDirectory, privateDirectory: context.settings.privateDirectory,
          host: request.host as 'codex' | 'claude', closedConfirmed: request.closedConfirmed as boolean | undefined,
          expectedRevision: (await inspectConfiguration(context.settings.maaDirectory)).revision,
          authorization: { ...plan.authorization, trainingPlan: grant }, changes: prepared.changes }, maa);
      }
      if (cleanup?.status !== 'complete') { if (!terminal) plan.state = 'unknown'; plan.issues.push('training:expired-timer-not-disabled'); }
    }
    if (expired && !plan.action?.completedAt && plan.rank === original.rank && !terminal) {
      plan.state = 'unknown'; plan.issues.push('training:execution-unproven-no-replay');
    }
    const actualBinding = bindConfiguration(JSON.parse(await readFile(join(context.settings.maaDirectory, 'config', 'gui.new.json'), 'utf8')), original);
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
    action: plan.action ? { kind: plan.action.kind, dueAt: plan.action.dueAt, completedAt: plan.action.completedAt } : null,
    expectedCompleteAt: plan.expectedCompleteAt ?? null, history: plan.history, issues: plan.issues, versions: plan.versions ?? null };
}

const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  try {
    if (process.argv.length !== 3) throw new Error('training-action-invalid');
    let text = ''; for await (const chunk of process.stdin) { text += String(chunk); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('training-input-too-large'); }
    const request = object(JSON.parse(text)); let result: unknown;
    if (process.argv[2] === 'prepare') result = summarizeTrainingPlan(await prepareTrainingPlan(request));
    else if (process.argv[2] === 'read') result = summarizeTrainingPlan(await readTrainingPlan(String(request.id)));
    else if (process.argv[2] === 'refresh') result = summarizeTrainingPlan(await refreshTrainingMaterials(request));
    else if (['apply', 'reconcile'].includes(process.argv[2]!)) {
      const settings = await readSettings(); if (!settings.maaDirectory) throw new Error('maa-directory-unset');
      const { createMaaProcess } = await import('./maa-process.ts');
      if (process.argv[2] === 'apply') {
        result = await applyTrainingPlan(request, createMaaProcess(settings.maaDirectory));
        if (object(result).status !== 'complete') process.exitCode = 1;
      } else {
        const reconciled = await reconcileTrainingPlan(request, createMaaProcess(settings.maaDirectory));
        result = { ...reconciled, plan: summarizeTrainingPlan(reconciled.plan) };
        if (reconciled.cleanup && reconciled.cleanup.status !== 'complete') process.exitCode = 1;
      }
    } else throw new Error('training-action-invalid');
    console.log(JSON.stringify({ ok: process.exitCode !== 1, result }));
  } catch { console.error(JSON.stringify({ ok: false, error: 'training-plan-check-required' })); process.exitCode = 1; }
}
