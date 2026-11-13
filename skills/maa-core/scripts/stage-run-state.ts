import { createHash } from 'node:crypto';
import type { CheckResult } from './doctor.ts';
import { parseCallbackBody, parseCoreLogLine, parseTaskAssignment, parseTaskSubmission } from './maa-callback.ts';

/**
 * Pure classification of one tracked copilot batch from MAA's structured callbacks (asst.log) and GUI markers (gui.log).
 * Facts and their fixed MAA v6.21.4 sources are in docs/stage-run-sources.md. Business results stay `not-evaluated`
 * until a callback proves them; an environment failure never becomes a stage failure; anything not proven stays unknown.
 */
export type BusinessResult = 'not-evaluated' | 'success' | 'failed' | 'not-three-star' | 'no-sanity' | 'timeout' | 'unknown';
export type StageCheck = 'match' | 'mismatch' | 'not-fought' | 'unknown';
export type Execution = 'tracking' | 'completed' | 'failed' | 'unknown';
export type EnvironmentCategory = 'connection' | 'emulator' | 'recognition' | 'maa' | 'game-session' | 'manual-play' | 'manual-login';
export type Decision = 'retry-within-approval' | 'switch-alternate' | 'stop-and-tell-user';
export type Evidence = { at: string; message: string; what?: string; subtask?: string; task?: string };
export type FindingKind = 'stage-result' | 'subtask-error' | 'environment' | 'medicine' | 'takeover' | 'evidence-gap' | 'gui-marker' | 'chain-end' | 'start-failure' | 'list-mismatch';
export type Finding = Evidence & { id: string; kind: FindingKind; index?: number; terminal?: BusinessResult; detail?: string };
export type ProgressStatement = { at: string; quote: string; stages: { stageId: string; completedRuns: number }[] };
export type Attempt = { index: number; at: string; file: 'approved' | 'other' | 'unknown'; result: BusinessResult; evidence: Evidence | null; note?: string;
  flags: { battle: boolean; endOfAction: boolean; missionFailed: boolean; threeStar: boolean; waitExceeded: boolean; sanityPopup: boolean; environment: boolean };
  drops: { stageId: string; stageCode: string; stars: number | null }[] };
export type EnvironmentEvent = Evidence & { category: EnvironmentCategory; transient: boolean; recordedAt: string };
export type Marker = { at: string; marker: string };
export type RunList = { index: number; stageId: string; code: string; jobId: number; fileKey: string }[];
export type RunState = {
  chain: { processId: string; taskId: number; at: string; terminal: (Evidence & { message: 'TaskChainCompleted' | 'TaskChainError' | 'TaskChainStopped' }) | null } | null;
  submission: { processId: string; threadId: string; toggle: boolean | null; listMode: boolean | null; taskId: number | null } | null;
  medicineToggle: boolean | null;
  listMode: boolean | null;
  attempts: Attempt[];
  medicine: { events: { at: string; count: number }[]; unreadable: number; confirmPending: boolean };
  environment: EnvironmentEvent[];
  findings: (Finding & { reported: boolean })[];
  gui: { errors: Marker[]; completions: Marker[]; schedule: Marker[]; durationLimits: Marker[]; chainStarts: string[] };
  takeover: { at: string; source: 'native-schedule' | 'other-task-chain'; detail: string } | null;
  gaps: { log: 'asst' | 'gui'; reason: string; at: string }[];
  rotated: boolean;
  startFailure: Evidence | null;
  processGone: Evidence | null;
  /** Set when the model stops a run whose task chain never started; such a record reads no further log lines. */
  closed: { at: string; reason: 'closed-before-start' } | null;
  /** The user's own statements of how far each stage got, used only to settle unknown outcomes. */
  progress: ProgressStatement[];
};
/**
 * `blocking` lists the shared checks whose error blocks a retry or switch (the `stage-retry` purpose of `blockingChecks`);
 * `notBlocking` lists the other errors, which do not block but are told to the user.
 */
export type Verification = { at: string; clear: boolean; process: { running: boolean; idle: boolean } | null; preparedList: 'matches' | 'subset' | 'changed' | 'unreadable';
  checks: CheckResult[]; blocking: string[]; notBlocking: string[]; unknown: string[]; accountSnapshotReadAt: string | null };
export type DecisionRecord = { at: string; decision: Decision; reason: string };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Compares a job path without keeping it: MAA reports the path it loaded, the record keeps only this key. */
export const fileKey = (path: string) => hash(path.replaceAll('/', '\\').toLowerCase());
const time = (text: string) => Date.parse(text);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const word = (value: unknown) => typeof value === 'string' && /^[A-Za-z][\w@.#-]{0,95}$/.test(value) ? value : undefined;

export function emptyRunState(): RunState {
  return { chain: null, submission: null, medicineToggle: null, listMode: null, attempts: [], medicine: { events: [], unreadable: 0, confirmPending: false }, environment: [], findings: [],
    gui: { errors: [], completions: [], schedule: [], durationLimits: [], chainStarts: [] }, takeover: null, gaps: [], rotated: false, startFailure: null, processGone: null,
    closed: null, progress: [] };
}
function addFinding(state: RunState, key: string, finding: Omit<Finding, 'id'>) {
  const id = hash(`${finding.kind}\n${key}`).slice(0, 24);
  if (!state.findings.some(item => item.id === id)) state.findings.push({ ...finding, id, reported: false });
}
function addEnvironment(state: RunState, key: string, event: Omit<EnvironmentEvent, 'recordedAt'>, recordedAt: string) {
  if (state.environment.some(item => item.at === event.at && item.message === event.message && item.what === event.what && item.category === event.category)) return;
  state.environment.push({ ...event, recordedAt });
  const open = openAttempt(state); if (open) open.flags.environment = true;
  addFinding(state, key, { kind: 'environment', at: event.at, message: event.message, what: event.what, task: event.task, detail: event.category });
}
const terminal = (state: RunState) => state.chain?.terminal ?? null;
function openAttempt(state: RunState): Attempt | undefined { return terminal(state) ? undefined : state.attempts.at(-1); }

const guiErrorMarkers = ['任务出错: ', '战斗出错', '未选择作业', '读取文件失败！', '作业启动失败'];
const scheduleMarkers = ['Scheduled start: Timer Index:', 'Scheduled configuration change: Timer Index:', 'Not idle, Stop and CloseDown'];
/** GUI text only bounds the run and adds context; the error check runs before the completion check. */
export function applyGuiLines(state: RunState, lines: string[]) {
  if (state.closed) return;
  for (const line of lines) {
    const match = /^\[([^\]]+)\]\[([A-Z]{3})\](.*)$/.exec(line);
    if (!match) continue;
    const at = match[1]!, rest = match[3]!, arrow = rest.indexOf('> '), text = arrow >= 0 ? rest.slice(arrow + 2) : rest.trim();
    if (text.startsWith('Start Task Chain: ')) state.gui.chainStarts.push(at);
    const error = guiErrorMarkers.find(marker => text.includes(marker));
    if (error) { state.gui.errors.push({ at, marker: error }); addFinding(state, line, { kind: 'gui-marker', at, message: 'gui.log', detail: error }); continue; }
    if (text.includes('完成任务: ')) { state.gui.completions.push({ at, marker: '完成任务: ' }); continue; }
    const schedule = scheduleMarkers.find(marker => text.includes(marker));
    if (schedule) { state.gui.schedule.push({ at, marker: schedule }); continue; }
    if (text.includes('Run duration limit reached:')) state.gui.durationLimits.push({ at, marker: 'Run duration limit reached:' });
  }
}

export function applyGap(state: RunState, log: 'asst' | 'gui', reason: string, at: string) {
  state.gaps.push({ log, reason, at });
  addFinding(state, `${log}\n${reason}\n${at}`, { kind: 'evidence-gap', at, message: `${log}.log`, detail: reason });
}
function takeOver(state: RunState, takeover: NonNullable<RunState['takeover']>) {
  state.takeover = takeover;
  addFinding(state, `${takeover.source}\n${takeover.at}`, { kind: 'takeover', at: takeover.at, message: takeover.source, detail: takeover.detail });
}
function pendingSchedule(state: RunState): Marker | undefined {
  const end = terminal(state);
  return [...state.gui.schedule].sort((a, b) => time(a.at) - time(b.at))
    .find(marker => !end || !(time(marker.at) > time(end.at)));
}

const environmentWhat: Record<string, [EnvironmentCategory, boolean]> = {
  ConnectFailed: ['connection', false], Disconnect: ['connection', false], Reconnecting: ['connection', true], Reconnected: ['connection', true],
  ScreencapFailed: ['emulator', false], TouchModeNotAvailable: ['emulator', false],
  UnsupportedResolution: ['recognition', false], ResolutionError: ['recognition', false], ResolutionChanged: ['recognition', false],
};
const exceptionCategory: Record<string, EnvironmentCategory> = { OpenCVException: 'recognition', GpuDeviceRemoved: 'recognition', OutOfMemory: 'maa', UnhandledException: 'maa', UnknownException: 'maa' };
const setupErrors = new Set(['CopilotFileReadError', 'CopilotStageNotSupported', 'UserAdditionalOperInvalid', 'OperboxDataParseFailed']);
const jobFailure = new Set<BusinessResult>(['failed', 'not-three-star', 'no-sanity', 'timeout']);

function classify(state: RunState, attempt: Attempt, stopCheck: boolean): BusinessResult | null {
  if (attempt.result !== 'not-evaluated') return null;
  if (attempt.flags.environment) return null;
  if (attempt.flags.missionFailed) return 'failed';
  if (stopCheck && attempt.flags.endOfAction && !attempt.flags.threeStar) return 'not-three-star';
  if (stopCheck && attempt.flags.waitExceeded && !attempt.flags.endOfAction) return 'timeout';
  if (attempt.flags.sanityPopup && !attempt.flags.battle && state.medicine.events.every(event => time(event.at) < time(attempt.at))) return 'no-sanity';
  return null;
}
function setResult(state: RunState, attempt: Attempt, result: BusinessResult, evidence: Evidence, key: string) {
  attempt.result = result; attempt.evidence = evidence;
  if (result !== 'success') addFinding(state, key, { kind: 'stage-result', index: attempt.index, terminal: result, ...evidence });
}

/** Applies Core log lines that follow the run's cursor, in order. */
export function applyCoreLines(state: RunState, list: RunList, lines: string[], recordedAt: string) {
  if (state.closed) return;
  for (const line of lines) {
    const entry = parseCoreLogLine(line);
    if (!entry) continue;
    const at = entry.time, now = time(at);
    const schedule = !state.takeover ? pendingSchedule(state) : undefined;
    if (schedule && (!Number.isFinite(now) || !Number.isFinite(time(schedule.at)) || now >= time(schedule.at))) {
      takeOver(state, { at: schedule.at, source: 'native-schedule', detail: schedule.marker });
    }
    if (state.takeover) continue;
    if (entry.method === 'append_task') {
      const submission = parseTaskSubmission(entry.body), assignment = parseTaskAssignment(entry.body);
      if (submission?.type === 'Copilot' && !state.chain) {
        const params = record(submission.params);
        state.submission = { processId: entry.processId, threadId: entry.threadId, taskId: null,
          toggle: submission.valid ? params.use_sanity_potion === true : null, listMode: submission.valid ? Array.isArray(params.copilot_list) : null };
      } else if (assignment !== null && state.submission && state.submission.taskId === null && state.submission.threadId === entry.threadId
        && state.submission.processId === entry.processId) state.submission.taskId = assignment;
      continue;
    }
    if (entry.method !== 'append_callback') continue;
    const callback = parseCallbackBody(entry.body);
    if (!callback) continue;
    const { message, payload } = callback, details = record(payload.details), chainName = payload.taskchain, end = terminal(state);
    const evidence: Evidence = { at, message, what: word(payload.what), subtask: word(payload.subtask), task: word(details.task) };
    const live = !end && !state.processGone;
    if (state.chain && live && entry.processId !== state.chain.processId) {
      state.processGone = { at, message: 'process-changed' };
      addEnvironment(state, line, { at, message: 'process-changed', category: 'maa', transient: false }, recordedAt);
      continue;
    }
    if (message === 'ConnectionInfo') {
      const known = typeof payload.what === 'string' ? environmentWhat[payload.what] : undefined;
      if (known && live) addEnvironment(state, line, { ...evidence, category: known[0], transient: known[1] }, recordedAt);
      continue;
    }
    if (['InternalError', 'InitFailed', 'Destroyed'].includes(message)) {
      if (live) addEnvironment(state, line, { ...evidence, category: 'maa', transient: false }, recordedAt);
      continue;
    }
    if (message === 'TaskChainStart') {
      if (!state.chain && chainName === 'Copilot' && Number.isSafeInteger(payload.taskid)) {
        state.chain = { processId: entry.processId, taskId: payload.taskid as number, at, terminal: null };
        const submission = state.submission, own = submission && submission.processId === entry.processId && submission.taskId === payload.taskid;
        state.medicineToggle = own ? submission.toggle : null;
        state.listMode = own ? submission.listMode : null;
        if (state.listMode === false) addFinding(state, line, { kind: 'list-mismatch', ...evidence, detail: 'not-list-mode' });
      } else if (!end) takeOver(state, { at, source: 'other-task-chain', detail: word(chainName) ?? 'unknown' });
      continue;
    }
    if (chainName !== 'Copilot') continue;
    if (!state.chain) {
      if (message === 'SubTaskError' && typeof payload.what === 'string' && setupErrors.has(payload.what)) {
        state.startFailure ??= evidence;
        addFinding(state, line, { kind: 'start-failure', ...evidence });
      } else if (!state.gaps.some(gap => gap.reason === 'chain-started-before-anchor')) applyGap(state, 'asst', 'chain-started-before-anchor', at);
      continue;
    }
    if (payload.taskid !== state.chain.taskId || entry.processId !== state.chain.processId || end) continue;
    const attempt = openAttempt(state), task = typeof details.task === 'string' ? details.task : '';
    if (message === 'TaskChainCompleted' || message === 'TaskChainError' || message === 'TaskChainStopped') {
      state.chain.terminal = { ...evidence, message };
      const exception = typeof details.error === 'string' ? details.error : undefined;
      if (message === 'TaskChainError' && exception) addEnvironment(state, line, { ...evidence, what: word(exception), category: exceptionCategory[exception] ?? 'maa', transient: false }, recordedAt);
      addFinding(state, line, { kind: 'chain-end', ...evidence, what: exception ? word(exception) : evidence.what });
      continue;
    }
    if (message === 'SubTaskExtraInfo') {
      if (payload.what === 'CopilotListLoadTaskFileSuccess') {
        const index = Number.isSafeInteger(details.id) && (details.id as number) >= 0 ? details.id as number : -1, item = list.find(value => value.index === index);
        const file = typeof details.file_name !== 'string' ? 'unknown' : item && fileKey(details.file_name) === item.fileKey ? 'approved' : 'other';
        state.attempts.push({ index, at, file, result: 'not-evaluated', evidence: null, drops: [],
          flags: { battle: false, endOfAction: false, missionFailed: false, threeStar: false, waitExceeded: false, sanityPopup: false, environment: false } });
        if (file !== 'approved') addFinding(state, line, { kind: 'list-mismatch', index, ...evidence, detail: file });
      } else if (payload.what === 'UseMedicine') {
        const count = details.count;
        if (Number.isSafeInteger(count) && (count as number) >= 0) state.medicine.events.push({ at, count: count as number }); else state.medicine.unreadable++;
        state.medicine.confirmPending = false;
        addFinding(state, line, { kind: 'medicine', ...evidence, detail: Number.isSafeInteger(count) ? String(count) : 'unknown' });
      } else if (payload.what === 'StageDrops' && attempt) {
        const stage = record(details.stage);
        attempt.drops.push({ stageId: typeof stage.stageId === 'string' ? stage.stageId : '', stageCode: typeof stage.stageCode === 'string' ? stage.stageCode : '',
          stars: typeof details.stars === 'number' ? details.stars : null });
        if (details.stars === 3 && attempt.result === 'not-evaluated') { attempt.flags.threeStar = true; setResult(state, attempt, 'success', evidence, line); }
      } else if (payload.what === 'ExceededLimit' && attempt && /^Copilot@WaitUntilEndOfAction(-Bypass)?$/.test(task)) attempt.flags.waitExceeded = true;
      else if ((payload.what === 'CopilotAction' || payload.what === 'StageInfo') && attempt) attempt.flags.battle = true;
      continue;
    }
    if (message === 'SubTaskStart' || message === 'SubTaskCompleted') {
      if (/(?:^|@)OfflineConfirm(?:AfterBattle)?$/.test(task)) { addEnvironment(state, line, { ...evidence, category: 'game-session', transient: false }, recordedAt); continue; }
      if (/(?:^|@)MedicineConfirm$/.test(task)) state.medicine.confirmPending = true;
      if (!attempt) continue;
      if (payload.subtask === 'BattleProcessTask') attempt.flags.battle = true;
      if (/^Copilot@FightMissionFailed(-Bypass)?$/.test(task)) attempt.flags.missionFailed = true;
      if (/^Copilot@EndOfAction(-Bypass)?$/.test(task)) attempt.flags.endOfAction = true;
      if (/(?:^|@)(?:UseMedicine|UseStone|NoStone)$/.test(task)) attempt.flags.sanityPopup = true;
      if (/^Copilot@StageDrops-Stars-(?:3|Adverse)$/.test(task)) {
        attempt.flags.threeStar = true;
        if (attempt.result === 'not-evaluated') setResult(state, attempt, 'success', evidence, line);
      }
      continue;
    }
    if (message === 'SubTaskError') {
      const first = Array.isArray(payload.first) ? payload.first.filter((item): item is string => typeof item === 'string') : [];
      const errorEvidence = { ...evidence, task: evidence.task ?? word(first[0]) };
      const stopCheck = first.some(item => /^Copilot@WaitUntilEndOfAction(-Bypass)?$/.test(item));
      const result = attempt ? classify(state, attempt, stopCheck) : null;
      if (attempt && result) setResult(state, attempt, result, errorEvidence, line);
      else addFinding(state, line, { kind: 'subtask-error', index: attempt?.index, ...errorEvidence });
    }
  }
  const schedule = !state.takeover ? pendingSchedule(state) : undefined;
  if (schedule && !terminal(state)) takeOver(state, { at: schedule.at, source: 'native-schedule', detail: schedule.marker });
}

export function applyProcess(state: RunState, running: boolean, at: string, recordedAt: string) {
  if (running || state.closed || !state.chain || terminal(state) || state.processGone || state.takeover) return;
  state.processGone = { at, message: 'maa-process-exited' };
  addEnvironment(state, `process\n${at}`, { at, message: 'maa-process-exited', category: 'maa', transient: false }, recordedAt);
}
/**
 * A user's report of manual play or a manual login is an environment failure even when it arrives after MAA already
 * ended the attempt: copilot shows a kicked session as a wait timeout or a failed battle, so the last counted attempt's
 * job-type result becomes unknown, with the reason kept on the attempt. A proven 3-star success stays.
 */
export function applyUserReport(state: RunState, kind: 'manual-play' | 'manual-login', at: string) {
  addEnvironment(state, `user\n${kind}\n${at}`, { at, message: 'user-report', category: kind, transient: false }, at);
  const takeoverAt = state.takeover ? time(state.takeover.at) : NaN;
  const last = state.attempts.filter(item => !state.takeover || Number.isFinite(takeoverAt) && time(item.at) < takeoverAt).at(-1);
  if (!last || last.result === 'success') return;
  last.flags.environment = true;
  if (jobFailure.has(last.result)) last.result = 'unknown';
  last.note = `user-report:${kind}`;
}

const diagnosis: Record<EnvironmentCategory, { reason: string; repair: string }> = {
  connection: { reason: 'MAA reported a lost or failed device connection.', repair: 'Check that the emulator is running and adb can connect in MAA, then let the skill re-verify.' },
  emulator: { reason: 'MAA reported a screenshot or touch failure from the emulator.', repair: 'Restart or reconfigure the emulator outside the skill, then let the skill re-verify.' },
  recognition: { reason: 'MAA reported a resolution or recognition-environment problem.', repair: 'Restore a supported resolution and an unobstructed game window; problems inside MAA are referred to its official documentation.' },
  maa: { reason: 'The MAA process or its core stopped without finishing the run.', repair: 'Reopen MAA yourself; problems inside MAA are referred to its official documentation and issues.' },
  'game-session': { reason: 'The game showed its disconnected dialog; another login or the network may have ended the session.', repair: 'Finish any manual session and log in again yourself; the skill never logs in.' },
  'manual-play': { reason: 'The user reported playing manually; sanity, medicine, originium and stage progress may have changed.', repair: 'Tell the skill when manual play is over; it re-reads state before anything continues.' },
  'manual-login': { reason: 'The user reported a manual login that may have ended the MAA session.', repair: 'Tell the skill when the manual session is over; it re-reads state before anything continues.' },
};
export function environmentDiagnosis(category: EnvironmentCategory): CheckResult {
  const item = diagnosis[category];
  return { id: `run-environment-${category}`, status: 'error', reason: item.reason, repair: { id: `run-environment-${category}`, executor: 'user', description: item.repair } };
}

export type StageEntry = { stageId: string; code: string; loops: number };
export type RunView = { runId: string; createdAt: string; retryOf: string | null; state: RunState; list: RunList; stages: StageEntry[];
  verifications: Verification[]; decisions: DecisionRecord[] };

function assessRun(view: RunView) {
  const { state, list, stages, verifications } = view;
  const end = terminal(state), takeoverAt = state.takeover ? time(state.takeover.at) : NaN;
  const counted = state.attempts.filter(item => !state.takeover || Number.isFinite(takeoverAt) && time(item.at) < takeoverAt);
  const endAt = end ? time(end.at) : NaN;
  const windowEnd = Number.isFinite(endAt) ? Math.min(Infinity, ...state.gui.chainStarts.map(time).filter(value => value > endAt)) : Infinity;
  const inWindow = (marker: Marker) => !(time(marker.at) >= windowEnd);
  const guiErrors = state.gui.errors.filter(inWindow), verdict = guiErrors.length ? 'error' : state.gui.completions.some(inWindow) ? 'completed' : 'none';
  const durationLimit = state.gui.durationLimits.some(inWindow);
  const listMismatch = counted.some(item => item.file !== 'approved') || state.listMode === false;
  let execution: Execution, reason: string;
  if (state.closed && !state.chain) [execution, reason] = ['unknown', 'closed-before-start'];
  else if (state.takeover) [execution, reason] = ['unknown', 'taken-over'];
  else if (state.gaps.length) [execution, reason] = ['unknown', 'evidence-incomplete'];
  else if (listMismatch) [execution, reason] = ['unknown', 'list-mismatch'];
  else if (end?.message === 'TaskChainCompleted') [execution, reason] = verdict === 'error' ? ['unknown', 'gui-error-conflict'] : ['completed', 'TaskChainCompleted'];
  else if (end?.message === 'TaskChainError') [execution, reason] = ['failed', 'TaskChainError'];
  else if (end) [execution, reason] = durationLimit ? ['failed', 'run-duration-limit'] : ['unknown', 'TaskChainStopped'];
  else if (state.startFailure) [execution, reason] = ['failed', 'start-failure'];
  else if (state.processGone) [execution, reason] = ['unknown', 'maa-gone'];
  else if (!state.chain && verdict !== 'none') [execution, reason] = ['unknown', 'gui-without-callback'];
  else [execution, reason] = ['tracking', 'in-progress'];
  const ended = execution !== 'tracking', last = counted.at(-1);
  const finalResult = (item: Attempt): BusinessResult => {
    if (item.result === 'not-evaluated' && item === last && end?.message === 'TaskChainStopped' && durationLimit && !item.flags.environment && !state.takeover) return 'timeout';
    return item.result === 'not-evaluated' && ended ? 'unknown' : item.result;
  };
  const stageOf = (index: number) => list.find(item => item.index === index)?.stageId;
  const stageResults = stages.map(stage => {
    const indexes = list.filter(item => item.stageId === stage.stageId).map(item => item.index);
    const attempts = counted.filter(item => indexes.includes(item.index));
    const finals = attempts.map(finalResult);
    const failure = finals.find(result => jobFailure.has(result));
    const result: BusinessResult = failure ?? (finals.length === stage.loops && finals.every(value => value === 'success') ? 'success'
      : ended || finals.includes('unknown') ? 'unknown' : 'not-evaluated');
    const drops = attempts.flatMap(item => item.drops);
    const matches = (drop: { stageId: string; stageCode: string }) => drop.stageId ? drop.stageId === stage.stageId : drop.stageCode === stage.code;
    const stageCheck: StageCheck = drops.some(drop => !matches(drop)) ? 'mismatch' : drops.length ? 'match'
      : !attempts.length && ended && !state.takeover && !state.gaps.length && state.chain ? 'not-fought' : 'unknown';
    return { stageId: stage.stageId, code: stage.code, loops: stage.loops, result, stageCheck,
      attempts: attempts.map(item => ({ index: item.index, result: finalResult(item), evidence: item.evidence, ...(item.note ? { note: item.note } : {}) })) };
  });
  const sum = state.medicine.events.reduce((total, event) => total + event.count, 0);
  const count: number | 'unknown' = state.gaps.length || state.takeover || state.medicine.unreadable || state.medicine.confirmPending ? 'unknown' : sum;
  const medicine = { count, approved: 0 as const, unapproved: count === 'unknown' ? 'unknown' as const : count > 0,
    enabledAtStart: state.medicineToggle === null ? 'unknown' as const : state.medicineToggle, final: ended };
  const blocking = state.environment.filter(item => !item.transient);
  const lastEnvironment = blocking.at(-1)?.recordedAt, verification = verifications.at(-1);
  const verified = !!lastEnvironment && !!verification && verification.at >= lastEnvironment && verification.clear;
  const hardBlock = state.takeover ? 'taken-over' : state.gaps.length ? 'evidence-incomplete' : listMismatch ? 'list-mismatch'
    : medicine.unapproved === true ? 'medicine-used' : medicine.unapproved === 'unknown' ? 'medicine-unknown'
    : state.chain && state.medicineToggle !== false ? 'medicine-toggle' : state.startFailure ? 'start-failure' : reason === 'gui-error-conflict' ? 'gui-error-conflict' : null;
  const stated = new Set(state.progress.flatMap(statement => statement.stages.map(stage => stage.stageId)));
  /** An unknown outcome may have spent sanity or finished the stage once the attempt entered battle or reached settlement. */
  const unresolved = counted.filter(item => finalResult(item) === 'unknown' && (item.flags.battle || item.flags.endOfAction) && !stated.has(stageOf(item.index) ?? ''))
    .map(item => item.index);
  /** Attempts whose battle provably ended (settlement screen, 3 stars, a failed battle, or a result that implies one). */
  const settled = counted.filter(item => item.flags.endOfAction || item.flags.threeStar || item.flags.missionFailed || settledResults.has(finalResult(item)))
    .map(item => stageOf(item.index) ?? '');
  return { execution, reason, ended, stageResults, medicine, verdict, guiErrors, blocking, verified, verification, hardBlock, unresolved, settled,
    chainStarted: !!state.chain, jobFailureSeen: stageResults.some(stage => stage.result === 'failed' || stage.result === 'not-three-star') };
}
const settledResults = new Set<BusinessResult>(['success', 'failed', 'not-three-star']);

/**
 * Batch-wide log evidence, independent of which run record attributed what: every Copilot task chain that started in
 * MAA's Core log since the batch's earliest anchor, Copilot callbacks whose chain start was never seen there, and log
 * gaps over that span. `beforeTracking` is set only while the batch has no record yet: `null` when nothing since the
 * preparation began submitted or loaded one of the batch's approved job files, otherwise the reason. `ticks` is the
 * current GUI list (`IsChecked` per list index).
 */
export type BatchEvidence = { chains: { processId: string; taskId: number; at: string }[]; loose: number; gaps: string[];
  beforeTracking: 'batch-may-have-run' | 'batch-evidence-incomplete' | null; ticks: { index: number; checked: boolean }[] | null };
export type BatchView = { records: RunView[]; evidence: BatchEvidence | null };
export function emptyBatchEvidence(): BatchEvidence { return { chains: [], loose: 0, gaps: [], beforeTracking: null, ticks: null }; }
/** Producer of "a chain may have run" once the batch has records: scans Core log lines from the earliest anchor, in order. */
export function scanBatchLines(evidence: BatchEvidence, lines: string[]) {
  for (const line of lines) {
    const entry = parseCoreLogLine(line);
    if (!entry || entry.method !== 'append_callback') continue;
    const callback = parseCallbackBody(entry.body);
    if (!callback || callback.payload.taskchain !== 'Copilot') continue;
    const taskId = callback.payload.taskid;
    if (callback.message === 'TaskChainStart' && Number.isSafeInteger(taskId)) evidence.chains.push({ processId: entry.processId, taskId: taskId as number, at: entry.time });
    else if (!evidence.chains.some(chain => chain.processId === entry.processId && chain.taskId === taskId)) evidence.loose++;
  }
}
/**
 * Producer before the batch's first record: whether any Core line (current and rotated log) at or after `since` (the
 * preparation's start) submitted or loaded one of the batch's approved job files. The file path depends only on the
 * report and the job, so an earlier batch of the same report, or another batch sharing the job, leaves such lines before
 * this preparation. Preparation needs MAA closed and replaces its job list, so a mention after it can only be this batch
 * or the user's own run. A mention whose time cannot be read counts. `earliest` is the first readable line time, to tell
 * whether the logs reach back to the preparation.
 */
export function scanBeforeTracking(lines: string[], files: ReadonlySet<string>, since: number) {
  let earliest = Infinity, mentioned = false;
  const approved = (value: unknown) => typeof value === 'string' && files.has(fileKey(value));
  for (const line of lines) {
    const at = time(/^\[([^\]]+)\]/.exec(line)?.[1] ?? '');
    if (Number.isFinite(at)) earliest = Math.min(earliest, at);
    const entry = parseCoreLogLine(line);
    if (!entry || at < since) continue;
    if (entry.method === 'append_task') {
      const params = record(parseTaskSubmission(entry.body)?.params);
      if (approved(params.filename) || (Array.isArray(params.copilot_list) && params.copilot_list.some(item => approved(record(item).filename)))) mentioned = true;
    } else if (entry.method === 'append_callback') {
      const callback = parseCallbackBody(entry.body);
      if (callback && approved(record(callback.payload.details).file_name)) mentioned = true;
    }
  }
  return { earliest, mentioned };
}

export type RerunRequest = { kind: 'decide'; runId: string; decision: Decision }
  | { kind: 'progress'; runId: string; stages: { stageId: string; completedRuns: number }[] }
  | { kind: 'start'; retryOf: string | null };
export type GateResult = { allowed: boolean; reason: string };
const allow = (reason: string): GateResult => ({ allowed: true, reason });
const deny = (reason: string): GateResult => ({ allowed: false, reason });
type Assessment = ReturnType<typeof assessRun>;
/** The record's own evidence. A MAA-reported job failure is never retried with the same job, only switched or stopped. */
function judge(assessment: Assessment, decision: Decision): GateResult {
  if (!assessment.ended) return decision === 'stop-and-tell-user' && !assessment.chainStarted ? allow('close-before-start') : deny('tracking');
  if (decision === 'stop-and-tell-user') return allow('stop');
  if (assessment.hardBlock) return deny(assessment.hardBlock);
  const environment = assessment.blocking.length > 0;
  if (environment && !assessment.verified) return deny('not-verified');
  if (assessment.unresolved.length) return deny('outcome-unknown');
  if (decision === 'retry-within-approval') return assessment.jobFailureSeen ? deny('job-failure-reported') : environment ? allow('environment-verified') : deny('no-environment-failure');
  return assessment.jobFailureSeen ? allow('maa-reported-failure') : environment ? allow('environment-verified') : deny('no-reported-failure');
}
const sameChain = (a: { processId: string; taskId: number; at: string }, b: { processId: string; taskId: number; at: string }) =>
  a.processId === b.processId && a.taskId === b.taskId && a.at === b.at;
/**
 * Batch-wide hold: anything in the logs that no record has resolved. `ignoreUnresolvedOf` lets a summary ask whether the
 * user's statement for that record is the only thing missing.
 */
function batchHold(batch: BatchView, ignoreUnresolvedOf?: string): string | null {
  const { evidence } = batch;
  if (!evidence) return 'batch-evidence-unavailable';
  if (evidence.gaps.length || batch.records.some(record => record.state.gaps.length)) return 'evidence-incomplete';
  if (evidence.loose) return 'chain-without-start';
  if (evidence.chains.some(chain => !batch.records.some(record => record.state.chain && sameChain(record.state.chain, chain)))) return 'untracked-chain';
  if (batch.records.some(record => record.state.chain && !evidence.chains.some(chain => sameChain(chain, record.state.chain!)))) return 'evidence-inconsistent';
  for (const record of batch.records) {
    const assessment = assessRun(record);
    if (!assessment.ended) return 'run-unresolved';
    if (!record.state.chain) continue;
    if (assessment.hardBlock) return assessment.hardBlock;
    if (assessment.unresolved.length && record.runId !== ignoreUnresolvedOf) return 'outcome-unknown';
  }
  return null;
}
const latestChainOwner = (batch: BatchView) => {
  const last = batch.evidence?.chains.at(-1);
  return last ? batch.records.find(record => record.state.chain && sameChain(record.state.chain, last)) : undefined;
};
const stageRuns = (batch: BatchView) => {
  const proven = new Map<string, number>(), stated = new Map<string, { at: string; runs: number }>();
  for (const record of batch.records) {
    for (const stageId of assessRun(record).settled) proven.set(stageId, (proven.get(stageId) ?? 0) + 1);
    for (const statement of record.state.progress) for (const stage of statement.stages) {
      if ((stated.get(stage.stageId)?.at ?? '') <= statement.at) stated.set(stage.stageId, { at: statement.at, runs: stage.completedRuns });
    }
  }
  return { proven: (stageId: string) => proven.get(stageId) ?? 0, completed: (stageId: string) => Math.max(proven.get(stageId) ?? 0, stated.get(stageId)?.runs ?? 0) };
};
/**
 * The one owner of "may this batch be fought again". Every consumer asks it: the decisions offered in a summary, `decide`,
 * `progress`, and `start` with or without `retryOf`. It answers from the batch-wide log evidence, not from one record:
 * - retry or alternate: the record's own evidence allows it, nothing in the batch is unresolved (untracked or
 *   unattributed chains, log gaps, records that are still tracking, hard blocks, battles with unknown outcome and no user
 *   statement), and the record owns the batch's latest chain;
 * - a progress statement never undercuts what callbacks prove;
 * - the first start of a batch: nothing since the preparation submitted or loaded the batch's approved job files, and
 *   the logs reach back to the preparation;
 * - start without `retryOf`: no record is tracking and no Copilot chain, callback or gap is in the batch's logs;
 * - start with `retryOf`: the recorded retry decision still passes, no chain started since (one chain per decision), and
 *   the GUI list has no more ticked entries per stage than approved minus completed (user-stated or callback-proven).
 */
export function rerunGate(batch: BatchView, request: RerunRequest): GateResult {
  if (request.kind === 'decide' || request.kind === 'progress') {
    const view = batch.records.find(item => item.runId === request.runId);
    if (!view) return deny('run-not-found');
    const assessment = assessRun(view);
    if (request.kind === 'progress') {
      if (!assessment.ended) return deny('run-tracking');
      const { proven } = stageRuns(batch);
      return request.stages.some(stage => stage.completedRuns < proven(stage.stageId)) ? deny('progress-contradicts-evidence') : allow('progress');
    }
    const verdict = judge(assessment, request.decision);
    if (!verdict.allowed || request.decision === 'stop-and-tell-user') return verdict;
    const hold = batchHold(batch);
    if (hold) return deny(hold);
    return latestChainOwner(batch)?.runId === view.runId ? verdict : deny('not-latest-run');
  }
  if (!batch.evidence) return deny('batch-evidence-unavailable');
  if (!batch.records.length) return request.retryOf !== null ? deny('retry-not-decided') : batch.evidence.beforeTracking ? deny(batch.evidence.beforeTracking) : allow('nothing-before-tracking');
  if (batch.records.some(record => !assessRun(record).ended)) return deny('run-unresolved');
  if (request.retryOf === null) {
    const ran = batch.evidence.chains.length || batch.evidence.loose || batch.evidence.gaps.length
      || batch.records.some(record => record.state.chain || record.state.gaps.length);
    return ran ? deny('run-unresolved') : allow('no-earlier-chain');
  }
  const previous = batch.records.find(record => record.runId === request.retryOf);
  if (!previous || previous.decisions.at(-1)?.decision !== 'retry-within-approval') return deny('retry-not-decided');
  const verdict = rerunGate(batch, { kind: 'decide', runId: previous.runId, decision: 'retry-within-approval' });
  if (!verdict.allowed) return deny(verdict.reason === 'not-latest-run' ? 'chain-already-started' : verdict.reason);
  const ticks = batch.evidence.ticks;
  if (!ticks) return deny('list-unreadable');
  const { completed } = stageRuns(batch);
  for (const stage of previous.stages) {
    const indexes = new Set(previous.list.filter(item => item.stageId === stage.stageId).map(item => item.index));
    const ticked = ticks.filter(item => item.checked && indexes.has(item.index)).length;
    if (ticked > Math.max(0, stage.loops - completed(stage.stageId))) return deny('finished-items-ticked');
  }
  return allow('retry-decided');
}

const decisionOrder: Decision[] = ['retry-within-approval', 'switch-alternate', 'stop-and-tell-user'];
export function deriveRun(view: RunView, batch: BatchView | null) {
  const assessment = assessRun(view), { state } = view;
  const context: BatchView = batch && batch.records.some(item => item.runId === view.runId) ? batch : { records: [view], evidence: batch?.evidence ?? null };
  const allowedDecisions = decisionOrder.filter(decision => rerunGate(context, { kind: 'decide', runId: view.runId, decision }).allowed);
  const latestInput = [assessment.verification?.at, state.progress.at(-1)?.at].filter((value): value is string => !!value).sort().at(-1);
  const otherHold = batchHold(context, view.runId);
  const next = assessment.reason === 'closed-before-start' ? 'report'
    : assessment.blocking.length && !assessment.verified ? 'verify'
    : !assessment.ended ? 'keep-observing'
    : !assessment.hardBlock && assessment.unresolved.length ? 'ask-progress'
    : allowedDecisions.includes('retry-within-approval') && !view.decisions.some(item => !latestInput || item.at >= latestInput) ? 'decide' : 'report';
  return { execution: assessment.execution, executionReason: assessment.reason, stages: assessment.stageResults, medicine: assessment.medicine, allowedDecisions, next,
    unresolvedAttempts: assessment.unresolved, progress: state.progress, rerunHold: otherHold,
    gui: { verdict: assessment.verdict, errors: assessment.guiErrors.map(marker => marker.marker) },
    evidence: { complete: !state.gaps.length && !state.takeover, gaps: state.gaps.map(gap => ({ log: gap.log, reason: gap.reason })), rotated: state.rotated },
    environment: state.environment.map(item => ({ at: item.at, category: item.category, message: item.message, what: item.what, transient: item.transient, diagnosis: environmentDiagnosis(item.category) })),
    takeover: state.takeover };
}
