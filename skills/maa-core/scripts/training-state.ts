import { createHash } from 'node:crypto';
import { parseCallbackBody, parseCoreLogLine, parseTaskAssignment, parseTaskParamsChange, parseTaskSubmission } from './maa-callback.ts';

export type TrainingActionKind = 'preplace' | 'start' | 'assistant' | 'observe';
export type TrainingPlan = {
  version: 1; id: string; authorization: { source: 'current-request' | 'approved-report'; reference: string };
  target: { operatorId: string; name: string; skill: number; skillName: string; role: string; currentRank: number; goal: number };
  rank: number; state: 'pending' | 'preplaced' | 'started' | 'satisfied' | 'complete' | 'failed' | 'unknown'; createdAt: string;
  preplacementRequired: boolean; binding: { profile: number; infrastTask: number; progressTask: number; timer: number };
  configurationBinding?: { profile: string; queue: unknown[]; timer: ReturnType<typeof import('./training-config.ts').trainingTimerIdentity> };
  assistants: Record<string, string>; afterStartAssistants?: Record<string, string>; materialReady: boolean; manualTraining: boolean;
  /** Ticket 32 R2-3: facts the next start still needs (static codes); start stays closed until a refresh clears them. */
  startIssues?: string[];
  /** Ticket 32 R3-2: the other plans' payments (`paymentKey`) the last material gate reserved; a new one makes the gate stale. */
  paymentsSeen?: string[];
  /**
   * Ticket 32 R4-1: per tier, what the last open start gate said the start spends (the route MAA follows: finished materials, or
   * with the user's crafting approval the crafting inputs and fees). The one record of what a payment actually spent.
   */
  spends?: Record<string, Spend>;
  /** Ticket 32 R4-2: the other plans' tiers the last gate took out of the stock. */
  reservedTiers?: TierPayment[];
  /** Ticket 32 FO1-8: the snapshot and training-room level the last gate used. */
  snapshotUsed?: { file: string; source: string | null; readAt: string | null; chosen: string; lacking: string[] } | null;
  trainingRoom?: { level: number; source: 'user-confirmed' | 'snapshot' } | null;
  action?: { kind: TrainingActionKind; dueAt: string; armedAt: string; operation?: string; timerIdentity?: unknown; completedAt?: string;
    native?: { process: string; taskId: number; chain: string; appendedAt: string; paramsHash: string; startedAt?: string } };
  preplacedAt?: string; confirmationAt?: string; startedAt?: string; latestObservationAt?: string; expectedCompleteAt?: string; assistantAttempted?: boolean;
  assistantState: 'unverified'; history: { at: string; kind: string; rank: number }[]; consumed: string[]; issues: string[];
  /** MAA and verification record versions read at preparation; absent in plans prepared before ticket 25. */
  versions?: import('./maa-version.ts').MaaVersionStamp;
  /** Ticket 32: when each rank's materials were paid (user-confirmed in-training rank: the snapshot's read time; plan starts: the start evidence). */
  paidAt?: Record<string, string>;
  /** Ticket 32: the user's own words allowing MAA's OperProgress to craft a tier's missing materials; never part of the writer authorization. */
  crafting?: { reference: string };
  /** Ticket 32: the current tier's material check passed only through crafting. */
  craftingRequired?: boolean;
  /** Ticket 32: the user closed this plan (it no longer holds the training room or schedules anything). */
  closed?: { at: string; reference: string };
  /** Ticket 32 R1-3: the plan's own one-shot that a re-entry could not disable yet because the writer refused before writing. */
  pendingCleanup?: { timerIdentity: unknown; dueAt: string };
};
/** Ticket 32: states in which a plan no longer holds the training room. Failed and unknown plans hold it until the user closes them. */
export const releasedStates: readonly TrainingPlan['state'][] = ['complete', 'satisfied'];
/**
 * Ticket 32: a plan that has reached MAA's configuration at least once and is neither finished nor closed holds the single
 * training room. An arming the writer refused before writing (rejected or busy) changed nothing and does not count.
 */
export function holdsTrainingRoom(plan: TrainingPlan): boolean {
  if (plan.closed) return false;
  // Its own one-shot is still armed on the shared slot (R1-3), even after the plan finished.
  if (plan.pendingCleanup) return true;
  if (releasedStates.includes(plan.state)) return false;
  const armed = plan.history.filter(entry => entry.kind.startsWith('arming-')).length;
  return armed > plan.history.filter(entry => /^configuration-(?:rejected|busy)-before-write$/.test(entry.kind)).length;
}
/**
 * Ticket 32: payment times the plan can vouch for. Recorded times win; plans from before ticket 32 fall back to the
 * first countdown observed for a rank, which is no earlier than its real start (so a cost check stays conservative).
 */
export function paidRanks(plan: TrainingPlan): Record<string, string> {
  const paid: Record<string, string> = {};
  for (const entry of plan.history) if (['countdown-observed', 'external-training-observed'].includes(entry.kind)) paid[String(entry.rank)] ??= entry.at;
  Object.assign(paid, plan.paidAt);
  // Ticket 32 R2-1: the one owner of when this plan's tiers were paid. A tier it completed without a recorded time was paid no
  // later than its completion, so the completion time is the bound: an inventory read before it still holds that tier's
  // materials and the cost calculation counts them (conservative), whichever path advanced it.
  for (const entry of plan.history) if (entry.kind === 'completed') paid[String(entry.rank)] ??= entry.at;
  return paid;
}
/** Ticket 32 R4-1: what a tier's start takes out of the stock: finished materials, or with crafting the inputs and fees. */
export type Spend = { items: Record<string, number>; lmd: number };
export type TierPayment = { operatorId: string; skill: number; rank: number; at: string; spent?: Spend };
export const paymentKey = (payment: TierPayment) => `${payment.operatorId}:${payment.skill}:${payment.rank}:${payment.at}`;
/**
 * Ticket 32 R3-2: the one owner of tier payments across plans. Every plan's payments (through `paidRanks`), except the plan
 * asking; a closed or finished plan's payments still happened. The training estimate reserves those made after its inventory
 * time, and a start never uses a gate that did not see all of them.
 */
export function planPayments(plans: TrainingPlan[], except: string | null): TierPayment[] {
  return plans.filter(plan => plan.id !== except).flatMap(plan => Object.entries(paidRanks(plan))
    .map(([rank, at]) => ({ operatorId: plan.target.operatorId, skill: plan.target.skill, rank: Number(rank), at, ...(plan.spends?.[rank] ? { spent: plan.spends[rank] } : {}) })));
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const validTime = (text: string) => Number.isFinite(Date.parse(text));
const recoverableEvidenceIssues = new Set(['training:start-evidence-incomplete', 'training:awaiting-start-evidence', 'training:execution-unproven-no-replay', 'training:timer-cleanup-pending']);
const hardIssue = (plan: TrainingPlan) => plan.issues.some(issue => !recoverableEvidenceIssues.has(issue));

function matchesNativeParameters(plan: TrainingPlan, chain: string, input: unknown): boolean {
  if (!plan.action) return false;
  const params = object(input);
  if (plan.action.kind === 'start') {
    if (chain !== 'OperProgress' || !Array.isArray(params.plans) || params.plans.length !== 1) return false;
    const target = object(params.plans[0]), ranks = [0, 0, 0]; ranks[plan.target.skill - 1] = plan.rank;
    return Object.keys(params).every(key => key === 'plans' || key === 'enable') && params.enable !== false
      && Object.keys(target).every(key => ['role', 'name', 'skill_mastery', 'elite', 'skill_level'].includes(key))
      && target.role === plan.target.role && target.name === plan.target.name && (target.elite ?? 0) === 0 && (target.skill_level ?? 0) === 0
      && JSON.stringify(target.skill_mastery) === JSON.stringify(ranks);
  }
  const filename = object(plan.configurationBinding?.queue[plan.binding.infrastTask]).Filename;
  return chain === 'Infrast' && typeof filename === 'string' && filename.length > 0 && params.filename === filename
    && params.mode === 10000 && params.plan_index === 0 && params.continue_training === false && params.enable !== false
    && JSON.stringify(params.facility) === '["Training"]';
}

/** Read MAA's actual callback log envelope. Unrelated log text is never interpreted as success. */
export function reconcileTraining(input: TrainingPlan, text: string, observedAt: string): TrainingPlan {
  if (!validTime(observedAt) || text.length > 32 * 1024 * 1024) throw new Error('training-observation-invalid');
  const plan = structuredClone(input);
  const since = plan.action?.dueAt ?? plan.createdAt;
  if (!validTime(since)) throw new Error('training-plan-invalid');
  const appends = new Map<string, { chain: string; at: string; hash: string }>();
  for (const line of text.split(/\r?\n/)) {
    const envelope = parseCoreLogLine(line);
    if (!envelope || !plan.action) continue;
    const at = new Date(envelope.time), process = envelope.processId, thread = `${process}/${envelope.threadId}`;
    if (!Number.isFinite(at.getTime()) || at.getTime() < Date.parse(since)) continue;
    const stamp = at.toISOString(), method = envelope.method, body = envelope.body;
    if (at.getTime() > Date.parse(observedAt)) { plan.state = 'unknown'; plan.issues.push('training:future-log-record'); continue; }
    if (method === 'append_task') {
      const submission = parseTaskSubmission(body), assignment = parseTaskAssignment(body);
      if (submission) {
        appends.delete(thread);
        if (!submission.valid) continue;
        const parameters = submission.params;
        if (matchesNativeParameters(plan, submission.type, parameters)) appends.set(thread, { chain: submission.type, at: stamp, hash: createHash('sha256').update(JSON.stringify(parameters)).digest('hex') });
      } else if (assignment !== null) {
        const candidate = appends.get(thread); appends.delete(thread);
        if (!candidate || at.getTime() < Date.parse(candidate.at)) continue;
        const taskId = assignment; if (!Number.isSafeInteger(taskId) || taskId <= 0) continue;
        const bound = plan.action.native;
        if (bound && (bound.process !== process || bound.taskId !== taskId || bound.appendedAt !== candidate.at || bound.paramsHash !== candidate.hash)) {
          plan.state = 'unknown'; plan.issues.push('training:ambiguous-native-task');
        } else plan.action.native ??= { process, taskId, chain: candidate.chain, appendedAt: candidate.at, paramsHash: candidate.hash };
      }
      continue;
    }
    if (method === 'set_task_params') {
      const change = parseTaskParamsChange(body), bound = plan.action.native;
      if (change && bound?.process === process && bound.taskId === change.taskId && !plan.action.completedAt) {
        plan.state = 'unknown'; plan.issues.push('training:native-task-parameters-changed');
      }
      continue;
    }
    const callback = parseCallbackBody(body); if (!callback) continue;
    const { message, payload } = callback;
    const bound = plan.action.native;
    if (!bound || bound.process !== process || bound.taskId !== payload.taskid || bound.chain !== payload.taskchain) continue;
    const key = createHash('sha256').update(line).digest('hex');
    if (plan.consumed.includes(key)) continue;
    if (message === 'TaskChainStart') {
      if (at.getTime() < Date.parse(bound.appendedAt) || bound.startedAt && bound.startedAt !== stamp) { plan.state = 'unknown'; plan.issues.push('training:evidence-order-invalid'); }
      else bound.startedAt = stamp;
      plan.consumed.push(key); continue;
    }
    if (!bound.startedAt) continue;
    if (at.getTime() < Date.parse(bound.startedAt)) { plan.state = 'unknown'; plan.issues.push('training:evidence-order-invalid'); continue; }
    plan.consumed.push(key);
    const details = object(payload.details);
    if (message === 'SubTaskExtraInfo' && payload.taskchain === 'Infrast' && payload.what === 'CustomInfrastTraineeNotFound'
      && plan.action?.kind === 'preplace' && Array.isArray(details.candidates) && details.candidates.includes(plan.target.name)) {
      plan.state = 'unknown'; plan.issues.push('training:trainee-not-found');
    }
    if (message === 'SubTaskExtraInfo' && payload.taskchain === 'Infrast' && payload.what === 'CustomInfrastAssistantNotFound') {
      plan.history.push({ at: stamp, kind: 'assistant-not-found', rank: plan.rank });
    }
    if (message === 'SubTaskExtraInfo' && payload.what === 'OperProgressDetail' && details.name === plan.target.name) {
      if (details.result_detail === 'AlreadySatisfied') {
        const rank = Array.isArray(details.skill_mastery) ? details.skill_mastery[plan.target.skill - 1] : undefined;
        if (rank === plan.rank && plan.target.currentRank >= plan.rank) plan.state = 'satisfied';
        else { plan.state = 'failed'; plan.issues.push('training:known-rank-contradiction'); }
        plan.history.push({ at: stamp, kind: plan.state, rank: plan.rank });
      } else if (details.result === 'Failed' || details.result === 'Skipped') {
        plan.state = 'unknown'; plan.issues.push('training:execution-needs-reconciliation');
      }
    }
    if (plan.state === 'failed' || plan.state === 'satisfied' || plan.state === 'complete' || hardIssue(plan)) continue;
    if (message === 'TaskChainCompleted' && payload.taskchain === 'OperProgress' && plan.action?.kind === 'start') {
      plan.action.completedAt = stamp;
      if (!plan.startedAt) { plan.state = 'unknown'; plan.issues.push('training:awaiting-start-evidence'); }
    }
    if (message === 'TaskChainCompleted' && payload.taskchain === 'Infrast' && plan.action.kind !== 'start' && !plan.action.completedAt) {
      plan.action.completedAt = stamp;
      if (plan.action.kind === 'preplace') { plan.state = 'preplaced'; plan.preplacedAt = stamp; plan.history.push({ at: stamp, kind: 'preplacement-executed-not-verified', rank: plan.rank }); }
      if (plan.action.kind === 'assistant') { plan.assistantAttempted = true; delete plan.expectedCompleteAt; plan.history.push({ at: stamp, kind: 'assistant-change-executed-not-verified', rank: plan.rank }); }
    }
    // Ticket 32 R1-2: a tier started outside the plan (manual or user-confirmed in training) may already be finished when this
    // plan's own observation first runs; its correct-target completion from that bound run is the evidence, without a countdown.
    const startedOutside = plan.manualTraining && plan.action?.kind === 'observe';
    if (message === 'SubTaskExtraInfo' && payload.what === 'InfrastTrainingCompleted' && details.operator === plan.target.name
      && details.skill === plan.target.skillName && details.level === plan.rank && (plan.startedAt || startedOutside)) {
      const since = plan.startedAt ?? bound.startedAt;
      if (at.getTime() < Math.max(Date.parse(since), Date.parse(plan.latestObservationAt ?? since))) {
        plan.state = 'unknown'; plan.issues.push('training:evidence-order-invalid'); continue;
      }
      plan.history.push({ at: stamp, kind: 'completed', rank: plan.rank }); plan.target.currentRank = plan.rank;
      if (plan.rank >= plan.target.goal) plan.state = 'complete';
      else {
        plan.rank++; plan.state = 'pending'; plan.preplacementRequired = false; plan.materialReady = false; plan.manualTraining = false; delete plan.craftingRequired;
        delete plan.action; delete plan.confirmationAt; delete plan.startedAt; delete plan.latestObservationAt; delete plan.expectedCompleteAt; delete plan.assistantAttempted;
      }
      continue;
    }
    if (message === 'SubTaskCompleted' && payload.taskchain === 'OperProgress' && plan.action?.kind === 'start'
      && payload.subtask === 'ProcessTask' && details.task === 'InfrastTrainingConfirm' && Number.isSafeInteger(payload.taskid)) plan.confirmationAt = stamp;
    if (message === 'SubTaskExtraInfo' && payload.what === 'InfrastTrainingTimeLeft') {
      const correct = details.operator === plan.target.name && details.skill === plan.target.skillName && details.level === plan.rank;
      const remaining = typeof details.time === 'string' ? /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(details.time.trim()) : null;
      if (!correct || !remaining) { plan.state = 'unknown'; plan.issues.push(correct ? 'training:countdown-invalid' : 'training:target-mismatch'); continue; }
      const seconds = Number(remaining[1]) * 3600 + Number(remaining[2]) * 60 + Number(remaining[3]);
      if (!seconds || (!plan.confirmationAt && !plan.manualTraining && !plan.startedAt)) { plan.state = 'unknown'; plan.issues.push('training:start-evidence-incomplete'); continue; }
      if (at.getTime() < Math.max(Date.parse(plan.confirmationAt ?? plan.createdAt), Date.parse(plan.latestObservationAt ?? plan.createdAt))) { plan.state = 'unknown'; plan.issues.push('training:evidence-order-invalid'); continue; }
      plan.state = 'started'; plan.startedAt ??= plan.confirmationAt ?? stamp;
      plan.paidAt = { ...plan.paidAt, [String(plan.rank)]: plan.paidAt?.[String(plan.rank)] ?? plan.startedAt };
      plan.latestObservationAt = stamp;
      plan.issues = plan.issues.filter(issue => !recoverableEvidenceIssues.has(issue));
      if (plan.action && ['start', 'observe'].includes(plan.action.kind)) plan.action.completedAt = stamp;
      plan.expectedCompleteAt = new Date(at.getTime() + seconds * 1000).toISOString();
      plan.history.push({ at: stamp, kind: plan.manualTraining ? 'external-training-observed' : 'countdown-observed', rank: plan.rank });
    }
  }
  plan.issues = [...new Set(plan.issues)];
  return plan;
}

export function nextTrainingAction(plan: TrainingPlan, now: string): { kind: TrainingActionKind; dueAt: string } | null {
  if (!validTime(now)) throw new Error('training-time-invalid');
  if (plan.closed) return null;
  if (plan.action && (!plan.action.completedAt || !plan.action.native?.startedAt)) return null;
  if (['failed', 'complete', 'satisfied'].includes(plan.state) || hardIssue(plan)) return null;
  const earliest = Date.parse(now) + 5 * 60000;
  let kind: TrainingActionKind, due = earliest;
  if (plan.state === 'unknown' || plan.manualTraining && plan.state !== 'started') {
    if (!plan.manualTraining && !plan.confirmationAt) return null;
    kind = 'observe';
  } else if (plan.state === 'started') {
    kind = plan.assistantAttempted ? 'observe' : 'assistant';
    if (kind === 'observe' && plan.expectedCompleteAt) due = Math.min(Date.parse(now) + 23 * 3600000, Math.max(due, Date.parse(plan.expectedCompleteAt)));
  } else if (plan.state === 'preplaced') {
    if (!plan.preplacedAt) return null;
    kind = 'start'; due = Math.max(due, Date.parse(plan.preplacedAt) + 6 * 60000);
  } else kind = plan.preplacementRequired ? 'preplace' : 'start';
  return { kind, dueAt: new Date(Math.ceil(due / 60000) * 60000).toISOString() };
}
