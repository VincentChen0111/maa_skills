/**
 * Reads MAA Core's structured callback lines from `debug/asst.log` and classifies one run.
 * Facts are from fixed MAA v6.21.4 (docs/doctor-sources.md): every callback is logged as
 * `[time][LVL][Px..][Tx..] Assistant::append_callback | <message> <json>`; a chain ends with
 * TaskChainCompleted, TaskChainError or TaskChainStopped; AllTasksCompleted is still sent after a
 * failed chain, so a completion marker never overrides an error. Only structured callbacks decide;
 * free text and process exit codes are never evidence of success.
 */
export type Callback = { at: string | null; message: string; detail: Record<string, unknown> | null; line: number };

const callbackPattern = /^\[([^\]]{1,40})\]\[[A-Z]{3}\]\[Px\d+\]\[Tx\d+\]\s+Assistant::append_callback \|\s+([A-Za-z]+)\s+(\{.*\})\s*$/;
const timePattern = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/;
export const callbackMessages = new Set(['InternalError', 'InitFailed', 'ConnectionInfo', 'AllTasksCompleted', 'AsyncCallInfo', 'Destroyed',
  'TaskChainError', 'TaskChainStart', 'TaskChainCompleted', 'TaskChainExtraInfo', 'TaskChainStopped',
  'SubTaskError', 'SubTaskStart', 'SubTaskCompleted', 'SubTaskExtraInfo', 'SubTaskStopped', 'ReportRequest']);

export function parseCallbacks(text: string): Callback[] {
  const result: Callback[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const match = callbackPattern.exec(raw);
    if (!match || !callbackMessages.has(match[2]!)) return;
    let detail: Record<string, unknown> | null = null;
    try { const value: unknown = JSON.parse(match[3]!); if (value && typeof value === 'object' && !Array.isArray(value)) detail = value as Record<string, unknown>; }
    catch { /* A callback whose details cannot be parsed still counts by its message name. */ }
    result.push({ at: timePattern.test(match[1]!) ? match[1]! : null, message: match[2]!, detail, line: index });
  });
  return result;
}

const terminal = (item: Callback) => item.message === 'AllTasksCompleted' || item.message === 'TaskChainStopped';
/** Splits callbacks into runs, newest first. A run ends at AllTasksCompleted or TaskChainStopped (one or more). */
export function runsNewestFirst(callbacks: Callback[]): Callback[][] {
  const runs: Callback[][] = [];
  let end = callbacks.length;
  while (end > 0) {
    let index = end;
    while (index > 0 && terminal(callbacks[index - 1]!)) index--;
    while (index > 0 && !terminal(callbacks[index - 1]!)) index--;
    runs.push(callbacks.slice(index, end));
    end = index;
  }
  return runs;
}

const what = (item: Callback) => typeof item.detail?.what === 'string' ? item.detail.what : null;
const exception = (item: Callback) => {
  const details = item.detail?.details;
  const error = details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>).error : undefined;
  return typeof error === 'string' ? error : null;
};
const connectionFailures = new Set(['ConnectFailed', 'Disconnect', 'ScreencapFailed', 'TouchModeNotAvailable']);
const resolutionFailures = new Set(['UnsupportedResolution', 'ResolutionError', 'ResolutionChanged']);
const processExceptions = new Set(['OutOfMemory', 'GpuDeviceRemoved']);
const defectExceptions = new Set(['OpenCVException', 'UnhandledException', 'UnknownException']);
const connected = new Set(['Connected', 'UuidGot', 'Reconnected']);

/** Whether a callback is a failure of this run; a ConnectFailed later followed by a connection is only a retried attempt. */
function failure(run: Callback[], index: number): boolean {
  const item = run[index]!;
  if (item.message === 'InitFailed' || item.message === 'InternalError' || item.message === 'TaskChainError') return true;
  if (item.message !== 'ConnectionInfo') return false;
  const value = what(item);
  if (value === 'ConnectFailed') return !run.slice(index + 1).some(later => later.message === 'ConnectionInfo' && connected.has(what(later) ?? ''));
  return connectionFailures.has(value ?? '') || resolutionFailures.has(value ?? '');
}

export type Category = 'maa-process' | 'connection' | 'recognition-environment' | 'maa-defect' | 'recognition' | 'task-chain';
export type RunClassification = {
  outcome: 'completed' | 'failed' | 'stopped' | 'unknown';
  category: Category | null; environment: boolean; cause: string | null;
  failures: Callback[]; subtaskErrors: Callback[];
};

export function classifyRun(run: Callback[]): RunClassification {
  const failures = run.filter((_, index) => failure(run, index));
  const subtaskErrors = run.filter(item => item.message === 'SubTaskError');
  const failedChains = failures.filter(item => item.message === 'TaskChainError');
  const pick = (test: (item: Callback) => boolean) => failures.find(test);
  let category: Category | null = null; let cause: string | null = null;
  const processFailure = pick(item => item.message === 'InitFailed' || item.message === 'InternalError' || processExceptions.has(exception(item) ?? ''));
  const connection = pick(item => item.message === 'ConnectionInfo' && connectionFailures.has(what(item) ?? ''));
  const resolution = pick(item => item.message === 'ConnectionInfo' && resolutionFailures.has(what(item) ?? ''));
  const defect = pick(item => defectExceptions.has(exception(item) ?? ''));
  if (processFailure) { category = 'maa-process'; cause = processFailure.message === 'TaskChainError' ? `TaskChainError.${exception(processFailure)}` : processFailure.message; }
  else if (connection) { category = 'connection'; cause = `ConnectionInfo.${what(connection)}`; }
  else if (resolution) { category = 'recognition-environment'; cause = `ConnectionInfo.${what(resolution)}`; }
  else if (defect) { category = 'maa-defect'; cause = `TaskChainError.${exception(defect)}`; }
  else if (failedChains.length) {
    const chainIds = new Set(failedChains.map(item => item.detail?.taskid));
    const recognition = subtaskErrors.find(item => chainIds.has(item.detail?.taskid));
    category = recognition ? 'recognition' : 'task-chain';
    cause = recognition ? 'SubTaskError' : 'TaskChainError';
  }
  const outcome = failures.length ? 'failed' : run.some(item => item.message === 'AllTasksCompleted') ? 'completed'
    : run.some(item => item.message === 'TaskChainStopped') ? 'stopped' : 'unknown';
  return { outcome, category, environment: category === 'maa-process' || category === 'connection' || category === 'recognition-environment', cause, failures, subtaskErrors };
}

/** Desensitisation: only whitelisted, pattern-checked tokens leave this module. */
const word = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const taskName = /^[A-Za-z][A-Za-z0-9@_.-]{0,79}$/;
const secretLike = [/[A-Fa-f0-9]{16,}/, /\d{1,3}(?:\.\d{1,3}){3}/, /:\d{2,5}\b/, /emulator-\d+/i, /@[A-Za-z0-9-]+\./, /[\\/]/];
/** A long run that mixes letters and digits looks like a token or identifier rather than a MAA task name. */
const randomLike = (value: string) => (value.match(/[A-Za-z0-9+=_-]{24,}/g) ?? []).some(part => /\d/.test(part) && /[A-Za-z]/.test(part));
export function safeToken(value: unknown, pattern: RegExp = word): string | null {
  return typeof value === 'string' && pattern.test(value) && !secretLike.some(item => item.test(value)) && !randomLike(value) ? value : null;
}
export type EvidenceItem = { at: string | null; message: string; what?: string; taskchain?: string; subtask?: string; task?: string; error?: string };
export function evidenceOf(item: Callback): EvidenceItem {
  const details = item.detail?.details && typeof item.detail.details === 'object' && !Array.isArray(item.detail.details) ? item.detail.details as Record<string, unknown> : {};
  const fields: [keyof EvidenceItem, string | null][] = [
    ['what', item.message === 'ConnectionInfo' ? safeToken(item.detail?.what) : null],
    ['taskchain', safeToken(item.detail?.taskchain)],
    ['subtask', item.message.startsWith('SubTask') ? safeToken(item.detail?.subtask) : null],
    ['task', item.message.startsWith('SubTask') ? safeToken(details.task, taskName) : null],
    ['error', item.message === 'TaskChainError' && [...processExceptions, ...defectExceptions].includes(String(details.error)) ? String(details.error) : null],
  ];
  return { at: item.at, message: item.message, ...Object.fromEntries(fields.filter(([, value]) => value !== null)) };
}

/** Screenshot names MAA logged as saved in this run, as paths relative to the MAA directory. */
export function savedScreenshots(lines: string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    if (!/\bSave\b/.test(line)) continue;
    for (const match of line.matchAll(/(?:^|[\\/"' ])debug[\\/](interface|drops)[\\/]([^\\/"'\r\n]+?\.(?:png|jpg))(?=["'\s]|$)/g)) {
      if (/^[A-Za-z0-9_.@-]{1,120}$/.test(match[2]!) && !match[2]!.startsWith('.')) found.add(`debug/${match[1]}/${match[2]}`);
    }
  }
  return [...found];
}
