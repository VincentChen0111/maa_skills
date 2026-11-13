import { applyCoreLines, emptyRunState, fileKey, type RunList } from '../../skills/maa-core/scripts/stage-run-state.ts';
import { switchKey, type StageRunRecord, type SwitchRecord } from '../../skills/maa-core/scripts/stage-run.ts';
import { attempt, chainEnd, copilotStart, medicineConfirm, medicineUsed } from './stage-run-data.ts';
import { syntheticRunRecords } from './stage-run-records.ts';

// Ticket 16's run generator is replaced by its fixed literal records; this is the same record with this scenario's run id.
const syntheticRunRecord = (kind: 'not-three-star', runId: string): StageRunRecord => ({ ...structuredClone(syntheticRunRecords[kind]), runId });

/**
 * Finished synthetic records for ticket 17's read-only behaviour scenarios, built with the same pure classifier. SYN-1 is
 * approved with primary 1 and alternate 2, SYN-2 with primary 4 and no alternate. No real device, account or path is used.
 */
export type AlternateRunKind = 'medicine-used' | 'medicine-unknown' | 'exhausted' | 'switch-prepared';
const at = '2026-11-13T02:10:00.000Z';
const operation = '6f3d8a52-0c1e-4b7a-9d2f-1a2b3c4d5e6f';
export const switchedOperation = '7a4e9b63-1d2f-4c8b-8e3a-2b3c4d5e6f70';

function record(runId: string, jobs: [number, number, number], lines: (files: string[]) => string[]): StageRunRecord {
  const files = jobs.map(id => `jobs/synthetic-${id}.json`);
  const list: RunList = files.map((file, index) => ({ index, stageId: index < 2 ? 'synthetic_01' : 'synthetic_02', code: index < 2 ? 'SYN-1' : 'SYN-2', jobId: jobs[index]!, fileKey: fileKey(file) }));
  const base = syntheticRunRecord('not-three-star', runId), state = emptyRunState();
  applyCoreLines(state, list, lines(files), at);
  for (const finding of state.findings) finding.reported = true;
  return { ...base, batch: { ...base.batch, list }, state, screenshots: [] };
}
export function alternateRunRecord(kind: AlternateRunKind, runId: string): StageRunRecord {
  if (kind === 'switch-prepared') {
    const base = syntheticRunRecord('not-three-star', runId);
    return { ...base, decisions: [{ at: '2026-11-13T02:12:00.000Z', decision: 'switch-alternate', reason: 'MAA 报告 SYN-1 未三星，按批准顺序换备选 2' }] };
  }
  if (kind === 'exhausted') return record(runId, [2, 2, 4], files => [...copilotStart(0, { files }), ...attempt(10, 0, files[0]!, 'not-three-star'), ...chainEnd(60, 'TaskChainError')]);
  const medicine = kind === 'medicine-used' ? [medicineConfirm(11), medicineUsed(12, 2)] : [medicineConfirm(11)];
  return record(runId, [1, 1, 4], files => [...copilotStart(0, { files, medicine: true }), ...attempt(10, 0, files[0]!, 'failed', medicine), ...chainEnd(60, 'TaskChainError')]);
}
/** The ledger entry of a switch that the unified writer completed: SYN-1 from job 1 to alternate 2. */
export function preparedSwitchRecord(runId: string): SwitchRecord {
  const key = switchKey(operation, runId, 'synthetic_01', 1, 2), digest = 'd'.repeat(64);
  return { version: 1, key, operation, runId, stageId: 'synthetic_01', from: 1, to: 2, trigger: 'job-failure', input: digest,
    continuation: [{ stageId: 'synthetic_01', job: 2, runs: 2 }, { stageId: 'synthetic_02', job: 4, runs: 1 }], reason: 'MAA 报告 SYN-1 未三星，按批准顺序换备选 2',
    state: 'prepared', owner: { pid: 1, at: '2026-11-13T02:12:30.000Z' }, createdAt: '2026-11-13T02:12:30.000Z', updatedAt: '2026-11-13T02:13:00.000Z',
    write: { operation: switchedOperation, status: 'complete', reason: null }, attempts: [{ at: '2026-11-13T02:13:00.000Z', input: digest, status: 'complete', reason: null }], conflicts: [] };
}
