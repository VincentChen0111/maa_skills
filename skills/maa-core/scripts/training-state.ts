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
  action?: { kind: TrainingActionKind; dueAt: string; armedAt: string; operation?: string; timerIdentity?: unknown; completedAt?: string;
    native?: { process: string; taskId: number; chain: string; appendedAt: string; paramsHash: string; startedAt?: string } };
  preplacedAt?: string; confirmationAt?: string; startedAt?: string; latestObservationAt?: string; expectedCompleteAt?: string; assistantAttempted?: boolean;
  assistantState: 'unverified'; history: { at: string; kind: string; rank: number }[]; consumed: string[]; issues: string[];
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const validTime = (text: string) => Number.isFinite(Date.parse(text));
const recoverableEvidenceIssues = new Set(['training:start-evidence-incomplete', 'training:awaiting-start-evidence', 'training:execution-unproven-no-replay']);
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
    if (message === 'SubTaskExtraInfo' && payload.what === 'InfrastTrainingCompleted' && details.operator === plan.target.name
      && details.skill === plan.target.skillName && details.level === plan.rank && plan.startedAt) {
      if (at.getTime() < Math.max(Date.parse(plan.startedAt), Date.parse(plan.latestObservationAt ?? plan.startedAt))) {
        plan.state = 'unknown'; plan.issues.push('training:evidence-order-invalid'); continue;
      }
      plan.history.push({ at: stamp, kind: 'completed', rank: plan.rank }); plan.target.currentRank = plan.rank;
      if (plan.rank >= plan.target.goal) plan.state = 'complete';
      else {
        plan.rank++; plan.state = 'pending'; plan.preplacementRequired = false; plan.materialReady = false; plan.manualTraining = false;
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
