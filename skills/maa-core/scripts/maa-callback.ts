/**
 * The one parser for MaaCore log lines that carry callbacks and task submissions.
 * Fixed MAA facts (see docs/training-sources.md and docs/stage-run-sources.md): every line starts with
 * `[time][level][Px<process>][Tx<thread>]`; `Assistant::append_callback |` is followed by the message name and the
 * callback JSON; `append_task` logs the task type and its JSON parameters, then `| task_id: <id>`.
 * Text that does not match this envelope is never interpreted.
 */
export type CoreLogMethod = 'append_task' | 'append_callback' | 'set_task_params';
export type CoreLogRecord = { time: string; processId: string; threadId: string; method: CoreLogMethod; body: string };
export type CallbackBody = { message: string; payload: Record<string, unknown> };
export type CoreCallback = CoreLogRecord & CallbackBody;

/** AsstMsg values of the fixed callback protocol; older logs may print the number instead of the name. */
export const callbackMessageNames: Readonly<Record<string, string>> = Object.freeze({
  0: 'InternalError', 1: 'InitFailed', 2: 'ConnectionInfo', 3: 'AllTasksCompleted', 4: 'AsyncCallInfo', 5: 'Destroyed',
  10000: 'TaskChainError', 10001: 'TaskChainStart', 10002: 'TaskChainCompleted', 10003: 'TaskChainExtraInfo', 10004: 'TaskChainStopped',
  20000: 'SubTaskError', 20001: 'SubTaskStart', 20002: 'SubTaskCompleted', 20003: 'SubTaskExtraInfo', 20004: 'SubTaskStopped',
  30000: 'ReportRequest',
});

const envelope = /^\[([^\]]+)\].*?\[Px(\d+)\]\[Tx(\d+)\].*?Assistant::(append_task|append_callback|set_task_params)\s+(.+)$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseCoreLogLine(line: string): CoreLogRecord | null {
  const match = envelope.exec(line);
  if (!match) return null;
  return { time: match[1]!, processId: match[2]!, threadId: match[3]!, method: match[4] as CoreLogMethod, body: match[5]! };
}

/** Body of `append_callback`: `| <message> <JSON object>`. */
export function parseCallbackBody(body: string): CallbackBody | null {
  const match = /^\|\s*(\w+)\s+(\{.*\})\s*$/.exec(body);
  if (!match) return null;
  let payload: unknown;
  try { payload = JSON.parse(match[2]!); } catch { return null; }
  if (!isObject(payload)) return null;
  return { message: callbackMessageNames[match[1]!] ?? match[1]!, payload };
}

export function parseCallbackLine(line: string): CoreCallback | null {
  const record = parseCoreLogLine(line);
  if (!record || record.method !== 'append_callback') return null;
  const body = parseCallbackBody(record.body);
  return body ? { ...record, ...body } : null;
}

/** Body of `append_task` that submits a task: `<type> <JSON>`. `valid` is false when the JSON does not parse. */
export function parseTaskSubmission(body: string): { type: string; params?: unknown; valid: boolean } | null {
  const match = /^(\w+)\s+(\{.*\})\s*$/.exec(body);
  if (!match) return null;
  try { return { type: match[1]!, params: JSON.parse(match[2]!), valid: true }; } catch { return { type: match[1]!, valid: false }; }
}

/** Body of `append_task` that reports the id given to the submission on the same thread: `| task_id: <id>`. */
export function parseTaskAssignment(body: string): number | null {
  const match = /^\|\s*task_id:\s*(\d+)\s*$/.exec(body);
  return match ? Number(match[1]) : null;
}

/** Body of `set_task_params`: `<task id> <JSON>`. The JSON is returned as written. */
export function parseTaskParamsChange(body: string): { taskId: number; json: string } | null {
  const match = /^(\d+)\s+(\{.*\})\s*$/.exec(body);
  return match ? { taskId: Number(match[1]), json: match[2]! } : null;
}
