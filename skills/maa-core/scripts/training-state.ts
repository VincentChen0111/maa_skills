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
  snapshotUsed?: { file: string; source: string | null; readAt: string | null; selected: string } | null;
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
/**
 * Ticket 32 (owner, 2026-11-16: 「check required 要给我具体的，和有没有替代」): every reason a training command can stop on,
 * with what to verify and the alternatives. The training CLIs print `{ok:false,status:"check-required",reason,check,alternatives}`
 * from this table only; a code it does not list is reported as `training-unclassified-failure` (no message text, which may hold paths).
 */
export const trainingChecks: Record<string, { check: string; alternatives: string[] }> = {
  'training-reconcile-before-apply': { check: '上一步安排的原生动作还没有用实际日志核对', alternatives: ['用所选 MAA 目录里的实际 Core 日志运行 reconcile，再 apply', '动作已过期又没有执行证据时计划会转为未知，交给 maa-doctor 核对'] },
  'training-plan-closed': { check: '这个计划已被用户关闭，不再安排任何动作', alternatives: ['为新的目标重新 prepare 一个计划'] },
  'training-other-plan-active': { check: '另一个计划占着训练室（list 里 holdsTrainingRoom 为 true）', alternatives: ['等那个计划完成后再 apply', '那个计划已停下时，请用户在游戏里核对后用原话 close 它', '用户也可以在游戏里手动开训'] },
  'training-configuration-binding-changed': { check: '准备之后，所选配置、队列或单次槽被改过', alternatives: ['请用户在 GUI 恢复准备时的队列和槽后再 apply', '用当前配置重新 prepare 一个计划'] },
  'training-plan-stopped': { check: '计划因已知矛盾、未知结果或缺开训证据停下，不能再自动安排', alternatives: ['未知结果交给 maa-doctor 核对，不重放', '用户在游戏里核对后用原话 close 这个计划，再按真实进度重新 prepare', '用户也可以在游戏里手动开训'] },
  'training-timer-ownership-changed': { check: '单次槽已被改动或重新启用，不再属于这个计划，没有去动它', alternatives: ['请用户在 GUI 核对这个槽并按需停用', '核对后再次 reconcile'] },
  'training-timer-cleanup-pending': { check: '上次重新进入时没能停用这个计划自己的单次槽（MAA 忙、没开或写入锁被占，什么都没改），槽还开着', alternatives: ['MAA 开着且空闲时再 reconcile 一次，停用成功后再继续', '请用户在 GUI 停用这个槽后再 reconcile'] },
  'training-timer-still-armed': { check: '这个计划自己的单次槽还开着，关闭计划会留下会触发的定时', alternatives: ['先 reconcile，让过期的自有槽停用', '请用户在 GUI 停用这个槽后再 close'] },
  'training-facts-required': { check: '查询缺少用户事实：按 details.issues（以及 prepare 时 details.stages 里各助手的 issues）补齐训练室等级、可用助手等；refresh/apply 报这个时，计划的 startIssues 就是这一档开训还缺的事实', alternatives: ['补齐用户确认的事实后重新 prepare，或对已有计划带着事实重新 refresh', '把目标先设为下一档，只准备下一档', '用户也可以在游戏里手动开训'] },
  'training-authorization-required': { check: '授权或请求字段不完整：来源、用户原话或报告引用、currentTrainee、加工批准原话', alternatives: ['带上用户原话或已批准的报告条目引用重新 prepare'] },
  'training-approval-scope-mismatch': { check: '已批准的报告条目不是这名干员或这个技能，或批准的档次低于目标', alternatives: ['把目标降到条目批准的档次', '请用户当次明确交办（current-request）', '请 maa-account 出新报告并由用户批准'] },
  'report-reference-invalid': { check: '报告引用格式不对，应为 cultivation/<reportHash>#S<n>', alternatives: ['用 cultivation-report.ts read 的批准记录取引用', '请用户当次明确交办'] },
  'report-not-found': { check: '找不到引用的报告', alternatives: ['用 cultivation-report.ts read 核对报告编号', '请用户当次明确交办'] },
  'report-item-not-approved': { check: '引用的条目没有被批准', alternatives: ['请用户批准这一条目', '请用户当次明确交办'] },
  'report-not-approvable': { check: '报告当前状态不能作为批准依据（待审查、待改正等）', alternatives: ['按报告接口完成审查或改正后再批准', '请用户当次明确交办'] },
  'report-content-mismatch': { check: '报告文件被改过，和批准时不一致', alternatives: ['重新生成并批准报告', '请用户当次明确交办'] },
  'training-in-training-trainee-conflict': { check: '从进行中的档次接手时，训练室里必须就是这名干员，currentTrainee 要写他的 ID', alternatives: ['用这名干员的 ID 作为 currentTrainee 重新 prepare', '这一档其实没在训练时去掉 inTraining'] },
  'training-in-training-refresh-unsupported': { check: 'refresh 不接受 inTraining；进行中的档次只在 prepare 时说明', alternatives: ['去掉 inTraining 后再 refresh'] },
  'training-refresh-target-changed': { check: '查询的干员、技能、目标档次或已完成档次和计划记录不一致（例如快照领先于计划记录）', alternatives: ['把查询目标设为计划的下一档再 refresh', '快照与真实进度矛盾时，先由 maa-account 更新快照或请用户核实'] },
  'training-stage-not-pending': { check: '只有待开训或已预入驻、未关闭的计划可以 refresh', alternatives: ['先 reconcile 推进计划', '计划已停下时按停下的原因处理'] },
  'training-plan-id-invalid': { check: '计划 ID 格式不对', alternatives: ['用 list 找到正确的计划 ID'] },
  'training-plan-not-found': { check: '找不到这个计划记录', alternatives: ['用 list 找到正确的计划 ID'] },
  'training-plan-invalid': { check: '计划记录格式不对', alternatives: ['交给 maa-doctor 检查，不要手改记录'] },
  'training-plan-record-invalid': { check: '私有目录里有读不了的计划记录，无法确认训练室是否被占用', alternatives: ['交给 maa-doctor 检查这份记录，不要手改', '用户核对后再继续'] },
  'training-record-busy-or-unknown': { check: '计划记录被另一个操作锁住，或上次操作中断留下了锁', alternatives: ['等另一个操作结束后再试', '锁一直在时交给 maa-doctor 核对，不自动删锁'] },
  'maa-directory-unset': { check: '设置里没有 MAA 目录', alternatives: ['用 maa-setup 或偏好接口设置 MAA 目录'] },
  'maa-config-unreadable': { check: '读不到所选 MAA 目录里的 config/gui.new.json', alternatives: ['确认 MAA 目录设置正确', '交给 maa-doctor 检查'] },
  'training-configuration-binding-invalid': { check: '所选配置序号或其中的队列、定时列表不存在', alternatives: ['用 maa-config.ts read 的摘要重新选配置、队列和槽后 prepare'] },
  'training-existing-tasks-required': { check: '所选配置里没有可用的 Infrast（只有一个训练室）和 OperProgress 任务，或单次槽不存在', alternatives: ['请用户在 MAA GUI 补齐任务和槽，重新读摘要后 prepare', '用户也可以在游戏里手动开训'] },
  'training-profile-missing': { check: '所选配置不存在', alternatives: ['用 maa-config.ts read 的摘要重新选配置后 prepare'] },
  'training-task-enable-unknown': { check: '队列里有任务的启用状态读不出', alternatives: ['请用户在 GUI 打开并保存一次这个配置后再试', '交给 maa-doctor 检查配置'] },
  'training-timer-not-free': { check: '所选单次槽不空闲（已启用或被占用）', alternatives: ['换一个空闲的单次槽重新 prepare', '上一个计划的槽还没停用时先 reconcile 那个计划'] },
  'training-other-timer-conflict': { check: '另有启用的定时会在同一配置上运行，可能和训练冲突', alternatives: ['请用户停用冲突的定时', '换用没有其他定时的配置'] },
  'training-timer-mode-unverified': { check: '定时设置不是已核实的模式（强制定时启动或自定义配置开关不符）', alternatives: ['请用户在 GUI 关掉强制定时启动后再试'] },
  'training-timer-changed': { check: '单次槽在核对后被改过', alternatives: ['重新 reconcile 核对槽的所有权'] },
  'training-owned-once-timer-required': { check: '要停用的不是这个计划自己的单次槽', alternatives: ['请用户在 GUI 核对这个槽'] },
  'training-due-time-invalid': { check: '算出的到期时间不在允许的窗口内', alternatives: ['稍后再 apply'] },
  'training-clock-transition-unverified': { check: '到期时间跨越了时区或夏令时变化', alternatives: ['变化之后再 apply'] },
  'training-grant-invalid': { check: '训练写入授权的字段无效', alternatives: ['重新 prepare 这个目标'] },
  'training-log-required': { check: 'reconcile 需要 logFile：所选 MAA 目录里的实际 Core 日志', alternatives: ['指向所选 MAA 目录里的 Core 日志后再 reconcile'] },
  'training-log-instance-mismatch': { check: '日志不在所选 MAA 目录里', alternatives: ['改用所选 MAA 目录里的 Core 日志'] },
  'training-log-too-large': { check: '日志超过 32 MB', alternatives: ['请用户在 MAA 里新开日志后，等下一次执行再 reconcile'] },
  'training-observation-invalid': { check: '观察时间无效或日志过大', alternatives: ['用实际 Core 日志重新 reconcile'] },
  'training-time-invalid': { check: '当前时间无效', alternatives: ['检查本机时间后再试'] },
  'training-close-reference-required': { check: '关闭计划要用户本人的原话', alternatives: ['请用户在游戏里核对后亲口说要关闭这个计划'] },
  'training-request-invalid': { check: '请求不是要求的 JSON 对象或字段不对', alternatives: ['按训练接口的输入格式重新调用'] },
  'training-action-invalid': { check: '动作名不对', alternatives: ['使用 prepare、read、refresh、list、close、apply 或 reconcile'] },
  'training-snapshot-unreadable': { check: '读不到账号快照', alternatives: ['用 maa-account 导入或更新快照', '用 snapshotFile 指定快照文件'] },
  'training-tables-unreadable': { check: '读不到 tablesFile 指定的离线表', alternatives: ['去掉 tablesFile，读取固定公开表', '换一个完整的离线表文件（标明未验证）'] },
  'training-tables-unavailable': { check: '读不到固定公开表（网络或来源问题）', alternatives: ['稍后重试', '提供完整的离线 tablesFile（结果标明未验证）'] },
  'base-data-invalid': { check: '基建表的结构和已核实的不一样', alternatives: ['稍后重试固定公开表', '交给维护者核对来源'] },
  'report-content-invalid': { check: '引用的报告内容读不了或格式不对', alternatives: ['重新生成并批准报告', '请用户当次明确交办'] },
  'report-record-invalid': { check: '报告的审查或批准记录读不了或格式不对', alternatives: ['交给 maa-doctor 检查，不要手改记录', '请用户当次明确交办'] },
  'base-snapshot-invalid': { check: '账号快照的干员或基建部分格式不对', alternatives: ['用 maa-account 重新导入或更新快照'] },
  'base-snapshot-required': { check: '没有可用的账号快照', alternatives: ['用 maa-account 导入或更新快照'] },
  'base-input-invalid': { check: '基建技能查询的输入不对（内部调用）', alternatives: ['按训练接口重新查询'] },
  'base-room-invalid': { check: '基建房间名不对（内部调用）', alternatives: ['按训练接口重新查询'] },
  'base-cross-check-invalid': { check: '基建表的交叉核对来源格式不对', alternatives: ['稍后重试固定公开表', '交给维护者核对来源'] },
  'training-configuration-invalid': { check: 'MAA 配置里训练要用的部分格式不对', alternatives: ['请用户在 GUI 打开并保存一次这个配置后再试', '交给 maa-doctor 检查配置'] },
  'training-asset-changed': { check: '私有目录里的训练自定义文件被改过', alternatives: ['交给 maa-doctor 核对，不要手改', '重新 prepare 一个计划'] },
  'training-asset-link': { check: '训练自定义文件或目录是链接，已拒绝', alternatives: ['删除链接后重新 apply（请用户确认）', '交给 maa-doctor 检查'] },
  'settings-unreadable': { check: '设置文件读不了或格式不对', alternatives: ['用 maa-setup 或偏好接口修复设置', '交给 maa-doctor 检查'] },
  'training-unclassified-failure': { check: '出现了没有分类的错误；为避免泄露路径，不输出原始信息', alternatives: ['运行 maa-doctor check 并把结果给用户', '重试一次同样的只读查询'] },
};
/** Ticket 32: only fixed lowercase codes (optionally one `:detail`) reach CLI output; message text that may hold paths never does. */
export const staticCode = (error: unknown) => error instanceof Error && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(error.message) ? error.message : undefined;
/** The one check-required shape every training CLI prints. Unlisted codes become `training-unclassified-failure`. */
export function trainingCheckRequired(code: string, details?: Record<string, unknown>) {
  const reason = Object.hasOwn(trainingChecks, code) ? code : Object.hasOwn(trainingChecks, code.split(':')[0]!) ? code : 'training-unclassified-failure';
  const entry = trainingChecks[reason] ?? trainingChecks[reason.split(':')[0]!]!;
  return { ok: false as const, status: 'check-required' as const, reason, check: entry.check, alternatives: [...entry.alternatives], ...(details ? { details } : {}) };
}
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
