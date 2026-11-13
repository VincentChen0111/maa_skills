import { isDeepStrictEqual } from 'node:util';
import type { Evidence, Grant, EvidenceEvent } from './evaluation.ts';

export type DailyPolicy = { outcome: 'complete' | 'closed-confirmation-required' | 'close-unknown' | 'restart-unknown'; reference: string };
export type DailyEvidence = { mode: string; original: string; observations: unknown[] };
type Value = Record<string, any>;
const object = (value: unknown): Value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object-required');
  return value as Value;
};
const exact = (actual: unknown, expected: unknown) => { if (!isDeepStrictEqual(actual, expected)) throw new Error('evidence-mismatch'); };
const decode = (bytes: unknown): string => {
  if (typeof bytes !== 'string' || Buffer.from(bytes, 'base64').toString('base64') !== bytes) throw new Error('bytes-required');
  return Buffer.from(bytes, 'base64').toString('utf8');
};
const utc = (value: unknown): number => {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) throw new Error('utc-required');
  return Date.parse(value);
};
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

/** A fixed reminder transaction, not a general generated-file authorization language. */
export function assessDailyTransaction(policy: DailyPolicy, evidence: Evidence): { valid: boolean; grants: Grant[]; events: EvidenceEvent[] } {
  try {
    const daily = evidence.daily;
    if (!daily || !['complete', 'closed-confirmation-required', 'close-unknown', 'restart-unknown'].includes(policy.outcome) ||
      typeof policy.reference !== 'string' || !policy.reference) throw new Error('daily-policy');
    const start = utc(evidence.executionWindow?.startedAt); const end = utc(evidence.executionWindow?.endedAt);
    if (end < start) throw new Error('window-order');
    exact(daily.mode, { complete: 'ready', 'closed-confirmation-required': 'closed', 'close-unknown': 'close-failure', 'restart-unknown': 'restart-failure' }[policy.outcome]);
    const observed = daily.observations.map(object);
    for (const item of observed) {
      if (!/^\.(agents|claude)\/skills\/maa-core\/scripts\/maa-config\.ts$/.test(item.file) || !['read', 'write'].includes(item.action) ||
        !Number.isSafeInteger(item.pid) || item.pid <= 0 || utc(item.startedAt) < start || utc(item.endedAt) > end || utc(item.endedAt) < utc(item.startedAt)) throw new Error('invocation-invalid');
    }
    const writes = observed.filter(item => item.action === 'write');
    if (writes.length !== 1) throw new Error('single-write-required');
    const write = writes[0]!;
    const read = observed.slice(0, observed.indexOf(write)).filter(item => item.action === 'read' && item.exitCode === 0).at(-1);
    if (!read) throw new Error('read-required');
    const revision = object(object(JSON.parse(read.output)).configuration).revision;
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('revision-required');
    const host = write.file.startsWith('.agents/') ? 'codex' : 'claude';
    const change = { path: ['Timers', 'NotifyBeforeScheduledStart'], value: true };
    const authorization = { source: 'current-request', reference: policy.reference };
    const input = object(JSON.parse(write.input));
    exact(input, { host, expectedRevision: revision, authorization, changes: [change],
      ...(Object.hasOwn(input, 'closedConfirmed') ? { closedConfirmed: false } : {}) });
    const result = object(JSON.parse(write.output));
    if (!uuid(result.operation)) throw new Error('operation-required');
    const id = result.operation;
    const closed = policy.outcome === 'closed-confirmation-required';
    const complete = policy.outcome === 'complete';
    const closeFailure = policy.outcome === 'close-unknown';
    const phase = complete ? 'complete' : closed ? 'check' : closeFailure ? 'close' : 'restart';
    exact(result, { ok: complete, status: complete ? 'complete' : closed ? 'rejected' : 'unknown', phase, operation: id,
      changedKeys: complete ? ['Timers.NotifyBeforeScheduledStart'] : [], reason: complete ? null : closed ? 'closed-confirmation-required' : 'reconciliation-required' });
    exact(write.exitCode, complete ? 0 : 1);
    const actions = (write.actions as unknown[]).map(object);
    const grants: Grant[] = [];
    const events: EvidenceEvent[] = [];
    const config = object(JSON.parse(decode(daily.original)));
    exact(object(config.Timers).NotifyBeforeScheduledStart, false);
    const changed = { ...config, Timers: { ...config.Timers, NotifyBeforeScheduledStart: true } };
    const mutations = actions.filter(action => action.kind !== 'process');
    const processes = actions.filter(action => action.kind === 'process');
    if (closed) {
      exact(mutations, []);
      exact(processes, [{ kind: 'process', action: 'inspect', state: { running: false, treeExited: true, idle: false, ready: false } }]);
      if (evidence.changes.length) throw new Error('closed-write');
      return { valid: true, grants, events };
    }
    exact(mutations[0], { kind: 'acquire', flags: 'wx' });
    const pending = mutations[1]; const last = mutations[complete ? mutations.length - 2 : mutations.length - 1];
    if (!pending || !last) throw new Error('records-required');
    const pendingRecord = object(JSON.parse(decode(pending.after)));
    const metadata = { id, skill: 'maa-daily', host, pid: write.pid, startedAt: pendingRecord.startedAt, phase: 'check' };
    if (utc(metadata.startedAt) < utc(write.startedAt) || utc(metadata.startedAt) > utc(write.endedAt)) throw new Error('record-time');
    const held = (action: Value, lockPhase: string) => exact(JSON.parse(decode(action.lock)), { ...metadata, phase: lockPhase });
    const append = (action: Value, file: string, record: Value, lockPhase: string) => {
      exact(action.kind, 'append'); exact(action.file, file); exact(action.before, null);
      held(action, lockPhase); exact(decode(action.after), JSON.stringify(record) + '\n');
      grants.push({ file, key: '$file', value: action.after });
    };
    // Ticket 25: the writer records the MAA and verification-record versions it read. The synthetic MAA has no readable
    // product version, so it must be null (never guessed); the installed record's version must be a positive integer.
    // The whole line is still compared byte for byte, so no other field can appear.
    const recordVersion = object(pendingRecord.versions).recordVersion;
    if (!Number.isSafeInteger(recordVersion) || recordVersion < 1) throw new Error('pending-versions');
    append(pending, 'private/daily-pending.jsonl', { ...metadata, authorization, changes: [change], versions: { maaVersion: null, recordVersion } }, 'check');
    const recordedResult = { ...metadata, status: result.status, phase, operation: id, changedKeys: result.changedKeys, reason: result.reason };
    append(last, 'private/daily-runs.jsonl', recordedResult, complete ? 'record' : phase);
    const replaced = mutations.filter(action => action.kind === 'replace');
    if (closeFailure) exact(replaced, []);
    else {
      if (replaced.length !== 1) throw new Error('single-replacement-required');
      const replacement = replaced[0]!; held(replacement, 'write');
      exact(replacement.before, daily.original); exact(replacement.backup, daily.original);
      exact(JSON.parse(decode(replacement.after)), changed);
      grants.push({ file: 'config/gui.new.json', key: 'Timers', value: changed.Timers },
        { file: `private/maa-config-backups/${id}.json`, key: '$file', value: daily.original });
      events.push({ kind: 'write', file: 'config/gui.new.json', key: 'Timers', value: changed.Timers, operation: id, pid: write.pid });
    }
    if (complete) held(mutations.at(-1)!, 'release');
    else grants.push({ file: 'config/.maa-skills.lock', key: '$file', value: Buffer.from(JSON.stringify({ ...metadata, phase })).toString('base64') });
    exact(mutations.map(action => action.kind), complete ? ['acquire', 'append', 'replace', 'append', 'release'] : closeFailure ? ['acquire', 'append', 'append'] : ['acquire', 'append', 'replace', 'append']);
    let running = true;
    for (const action of processes) {
      if (action.action === 'inspect') exact(action.state, { running, treeExited: !running, idle: running, ready: running });
      else if (action.action === 'close') { exact(action.state, closeFailure ? 'failed' : 'closed'); if (!closeFailure) running = false; }
      else if (action.action === 'start') { exact(action.state, complete ? 'ready' : 'failed'); if (complete) running = true; }
      else throw new Error('process-action');
    }
    exact(processes.filter(action => action.action !== 'inspect').map(action => action.action), closeFailure ? ['close'] : ['close', 'start']);
    const acquireIndex = actions.indexOf(mutations[0]!);
    const pendingIndex = actions.indexOf(pending);
    const closeIndex = actions.findIndex(action => action.kind === 'process' && action.action === 'close');
    const recordIndex = actions.indexOf(last);
    const inspection = (from: number, to: number) => actions.slice(from, to).filter(action => action.kind === 'process' && action.action === 'inspect').at(-1);
    // Cross-check the full transaction timeline, not just each kind of operation in isolation.
    exact(inspection(0, acquireIndex)?.state, { running: true, treeExited: false, idle: true, ready: true });
    exact(inspection(acquireIndex + 1, pendingIndex)?.state, { running: true, treeExited: false, idle: true, ready: true });
    if (!(acquireIndex < pendingIndex && pendingIndex < closeIndex && closeIndex < recordIndex)) throw new Error('transaction-order');
    if (replaced.length) {
      const replacementIndex = actions.indexOf(replaced[0]!);
      const startIndex = actions.findIndex(action => action.kind === 'process' && action.action === 'start');
      if (!(closeIndex < replacementIndex && replacementIndex < startIndex && startIndex < recordIndex)) throw new Error('restart-order');
      exact(inspection(closeIndex + 1, replacementIndex)?.state, { running: false, treeExited: true, idle: false, ready: false });
      if (complete) exact(inspection(startIndex + 1, recordIndex)?.state, { running: true, treeExited: false, idle: true, ready: true });
    }
    for (const grant of grants) if (!evidence.changes.some(change => change.file === grant.file && change.key === grant.key && isDeepStrictEqual(change.after, grant.value))) throw new Error('missing-final-file');
    events.unshift({ kind: 'lock-acquired', operation: id, pid: write.pid });
    events.push({ kind: complete ? 'lock-released' : 'lock-retained', operation: id, pid: write.pid });
    return { valid: true, grants, events };
  } catch { return { valid: false, grants: [], events: [] }; }
}
