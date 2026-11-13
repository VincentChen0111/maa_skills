import { isDeepStrictEqual } from 'node:util';
import type { Evidence, EvidenceEvent, Grant } from './evaluation.ts';

type Path = (string | number)[];
/**
 * One complete transaction of the shared configuration writer (skill marker, authorization and changes are fixed by the
 * trusted scenario). The writer's own files are the evidence: exactly one backup equal to the configuration before, one
 * pending record and one result record appended for the same operation, and a configuration that is the backup with
 * exactly the recorded changes applied. `{{workspace}}` paths are rendered by the runner before grading.
 */
export type WriterTransactionPolicy = {
  skill: 'maa-setup' | 'maa-daily' | 'maa-doctor'; source: 'current-request' | 'approved-report'; reference: string; changedKeys: string[];
  changes?: { path: Path; value: unknown }[];
  /** For approved stage jobs: the approved map and, per entry, stage, loops, primary and alternate job ids. */
  jobPlan?: { map: string; entries: { stageId: string; loops: number; primary: number; alternates: number[] }[] };
  /** Changes the agent writes field by field (in an order it chooses): the recorded changes and changed keys must equal these as sets. */
  changeSet?: { path: Path; value: unknown }[];
  /** Consumption grants the user gives in the current request (medicine, stone, expiring medicine); the pending record carries exactly these. */
  consumption?: { medicineCount?: number; stoneCount?: number; expiringMedicine?: { days: number; forActivity: boolean } };
};
type Value = Record<string, any>;
const object = (value: unknown): Value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object-required');
  return value as Value;
};
const exact = (actual: unknown, expected: unknown) => { if (!isDeepStrictEqual(actual, expected)) throw new Error('evidence-mismatch'); };
const decode = (bytes: unknown) => {
  if (typeof bytes !== 'string' || Buffer.from(bytes, 'base64').toString('base64') !== bytes) throw new Error('bytes-required');
  return Buffer.from(bytes, 'base64').toString('utf8');
};
const utc = (value: unknown) => {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) throw new Error('utc-required');
  return Date.parse(value);
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function applied(base: Value, changes: { path: Path; value: unknown }[]): Value {
  const result = structuredClone(base);
  for (const { path, value } of changes) {
    if (!Array.isArray(path) || !path.length) throw new Error('change-path');
    let target: any = result;
    for (const key of path.slice(0, -1)) { if (target === null || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('change-path'); target = target[key]; }
    if (target === null || typeof target !== 'object' || !Object.hasOwn(target, path.at(-1)!)) throw new Error('change-path');
    target[path.at(-1)!] = structuredClone(value);
  }
  return result;
}

export function assessWriterTransaction(policy: WriterTransactionPolicy, evidence: Evidence): { valid: boolean; grants: Grant[]; events: EvidenceEvent[] } {
  try {
    const start = utc(evidence.executionWindow?.startedAt); const end = utc(evidence.executionWindow?.endedAt);
    if (end < start) throw new Error('window-order');
    const file = (name: string) => {
      const found = evidence.changes.filter((change) => change.file === name);
      if (found.length !== 1 || found[0]!.key !== '$file') throw new Error(`file-change:${name}`);
      return found[0]!;
    };
    const config = file('config/gui.new.json');
    const before = object(JSON.parse(decode(config.before)));
    const after = object(JSON.parse(decode(config.after)));
    const backups = evidence.changes.filter((change) => /^private\/maa-config-backups\//.test(change.file));
    if (backups.length !== 1) throw new Error('single-backup-required');
    const backup = backups[0]!;
    const id = backup.file.match(/^private\/maa-config-backups\/([^/]+)\.json$/)?.[1];
    if (!id || !uuid.test(id) || backup.key !== '$file' || backup.before !== undefined || backup.after !== config.before) throw new Error('backup-mismatch');
    const appended = (name: string) => {
      const change = file(name);
      const old = change.before === undefined ? '' : decode(change.before); const next = decode(change.after);
      if (!next.startsWith(old) || !next.endsWith('\n') || next.slice(old.length).split('\n').length !== 2) throw new Error(`single-append:${name}`);
      return { change, record: object(JSON.parse(next.slice(old.length))) };
    };
    const pending = appended('private/daily-pending.jsonl');
    const record = pending.record;
    if (Object.keys(record).some((key) => !['id', 'skill', 'host', 'pid', 'startedAt', 'phase', 'authorization', 'changes', 'trainingManifest'].includes(key))) throw new Error('pending-fields');
    exact(record.id, id); exact(record.skill, policy.skill); exact(record.phase, 'check');
    if (!['codex', 'claude'].includes(record.host) || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('pending-owner');
    const startedAt = utc(record.startedAt);
    if (startedAt < start || startedAt > end) throw new Error('record-time');
    const authorization = object(record.authorization);
    exact(authorization.source, policy.source); exact(authorization.reference, policy.reference);
    const consumption = policy.consumption ?? {};
    if (Object.keys(authorization).some((key) => !['source', 'reference', ...(policy.jobPlan ? ['jobPlan'] : []), ...Object.keys(consumption)].includes(key))) throw new Error('authorization-fields');
    for (const [key, value] of Object.entries(consumption)) exact(authorization[key], value);
    if (policy.jobPlan) {
      const plan = object(authorization.jobPlan);
      exact(plan.map, policy.jobPlan.map);
      exact((plan.entries as Value[]).map((entry) => ({ stageId: entry.stageId, loops: entry.loops, primary: object(entry.primary).id,
        alternates: (entry.alternates as Value[]).map((item) => object(item).id) })), policy.jobPlan.entries);
    }
    if (!Array.isArray(record.changes) || !record.changes.length) throw new Error('changes-required');
    if (policy.changes) exact(record.changes, policy.changes);
    const unordered = (items: unknown) => (items as unknown[]).map((item) => JSON.stringify(item)).sort();
    if (policy.changeSet) exact(unordered(record.changes), unordered(policy.changeSet));
    exact(after, applied(before, record.changes));
    const runs = appended('private/daily-runs.jsonl');
    if (policy.changeSet) exact(unordered(runs.record.changedKeys), unordered(policy.changedKeys));
    exact(runs.record, { id, skill: policy.skill, host: record.host, pid: record.pid, startedAt: record.startedAt, phase: 'complete', status: 'complete',
      operation: id, changedKeys: policy.changeSet ? runs.record.changedKeys : policy.changedKeys, reason: null });
    if (evidence.changes.some((change) => change.file === 'config/.maa-skills.lock')) throw new Error('lock-left');
    const operation = { operation: id, pid: record.pid as number };
    const grants: Grant[] = [config, backup, pending.change, runs.change].map((change) => ({ file: change.file, key: '$file', value: change.after }));
    const events: EvidenceEvent[] = [{ kind: 'lock-acquired', ...operation }, { kind: 'write', file: 'config/gui.new.json', key: '$file', value: config.after, ...operation },
      { kind: 'lock-released', ...operation }];
    return { valid: true, grants, events };
  } catch { return { valid: false, grants: [], events: [] }; }
}
