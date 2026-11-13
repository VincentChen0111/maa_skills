import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// support: the user explicitly approved borrowing one support unit for this slot (需借助战); the GUI 「借助战」 switch is set by the user.
export type ApprovedJob = { id: number; hash: string; sourceHash: string; source: { url: string; readAt: string; sha256?: string }; support?: { slot: string; members: string[] } };
/**
 * Ticket 17: after MAA reported a stage failed (or the model switched after a verified environment failure), the same
 * approval continues with each stage's current job and the runs still left. Only `stage-run.ts switch` writes one; it
 * never names a job outside the stage's approved primary and alternates, nor more runs than the stage was approved for.
 */
export type JobContinuation = { from: { operation: string; runId: string; key: string }; stages: { stageId: string; job: number; runs: number }[] };
export type ApprovedJobPlan = { reportHash: string; map: string; entries: { stageId: string; code: string; difficulty: 'normal' | 'raid'; difficultyGroup: string; loops: number; primary: ApprovedJob; alternates: ApprovedJob[] }[];
  continuation?: JobContinuation };
export type ApprovedJobItem = { Name: string; FilePath: string; CopilotId: number; IsRaid: boolean; IsChecked: boolean; IsNavNameOverride: boolean; Index: number };
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function approvedJobFile(privateDirectory: string, reportHash: string, id: number): string {
  if (!hash(reportHash) || !Number.isSafeInteger(id) || id < 1) throw new Error('job-plan-invalid');
  return join(privateDirectory, 'stage-jobs', reportHash, `${id}.json`);
}
export function approvedJobSourceFile(privateDirectory: string, reportHash: string, id: number): string {
  approvedJobFile(privateDirectory, reportHash, id);
  return join(privateDirectory, 'stage-jobs', reportHash, 'source', `${id}.json`);
}
/** Each stage of the executable list with its runs and current job: the approval's primaries, or the continuation's jobs. */
export function approvedJobStages(plan: ApprovedJobPlan) {
  if (!plan || !hash(plan.reportHash) || typeof plan.map !== 'string' || !plan.map || !Array.isArray(plan.entries) || !plan.entries.length) throw new Error('job-plan-invalid');
  const stages = new Set<string>();
  for (const entry of plan.entries) {
    if (typeof entry.stageId !== 'string' || !entry.stageId || stages.has(entry.stageId) || typeof entry.code !== 'string' || !entry.code
      || !['normal', 'raid'].includes(entry.difficulty) || !Number.isSafeInteger(entry.loops) || entry.loops < 1 || entry.loops > 1000 || !Array.isArray(entry.alternates)) throw new Error('job-plan-invalid');
    if (typeof entry.difficultyGroup !== 'string' || !entry.difficultyGroup || entry.difficulty !== plan.entries[0]!.difficulty || entry.difficultyGroup !== plan.entries[0]!.difficultyGroup) throw new Error('job-mixed-difficulty-batch');
    stages.add(entry.stageId);
    const ids = new Set<number>();
    for (const job of [entry.primary, ...entry.alternates]) {
      if (!job || !hash(job.hash) || !hash(job.sourceHash) || !Number.isSafeInteger(job.id) || job.id < 1 || ids.has(job.id)
        || job.source?.url !== `https://prts.maa.plus/copilot/get/${job.id}` || !Number.isFinite(Date.parse(job.source.readAt))
        || job.support !== undefined && (typeof job.support?.slot !== 'string' || !job.support.slot || !Array.isArray(job.support.members) || !job.support.members.length
          || job.support.members.some(name => typeof name !== 'string' || !name))) throw new Error('job-plan-invalid');
      ids.add(job.id);
    }
  }
  const describe = (entry: ApprovedJobPlan['entries'][number], job: number, loops: number) => ({ stageId: entry.stageId, code: entry.code, raid: entry.difficulty === 'raid',
    loops, job, primary: entry.primary.id, alternates: entry.alternates.map(item => item.id) });
  const continuation = plan.continuation;
  if (continuation === undefined) return plan.entries.map(entry => describe(entry, entry.primary.id, entry.loops));
  const from = continuation?.from;
  if (!from || typeof from.operation !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(from.operation) || typeof from.runId !== 'string' || !/^[0-9a-f-]{36}$/.test(from.runId)
    || !hash(from.key) || !Array.isArray(continuation.stages) || !continuation.stages.length) throw new Error('job-plan-invalid');
  const named = new Set<string>();
  for (const stage of continuation.stages) {
    const entry = plan.entries.find(item => item.stageId === stage?.stageId);
    if (!entry || named.has(entry.stageId) || ![entry.primary, ...entry.alternates].some(job => job.id === stage.job)
      || !Number.isSafeInteger(stage.runs) || stage.runs < 1 || stage.runs > entry.loops) throw new Error('job-plan-invalid');
    named.add(entry.stageId);
  }
  return plan.entries.flatMap(entry => {
    const stage = continuation.stages.find(item => item.stageId === entry.stageId);
    return stage ? [describe(entry, stage.job, stage.runs)] : [];
  });
}
/** The one expansion of an approved plan into MAA list entries: one checked entry per run, in plan order. */
export function approvedJobEntries(plan: ApprovedJobPlan, privateDirectory: string) {
  const entries: { stageId: string; job: number; item: ApprovedJobItem }[] = [];
  for (const stage of approvedJobStages(plan)) {
    for (let repeat = 0; repeat < stage.loops; repeat++) entries.push({ stageId: stage.stageId, job: stage.job, item: { Name: stage.code,
      FilePath: approvedJobFile(privateDirectory, plan.reportHash, stage.job), CopilotId: stage.job, IsRaid: stage.raid, IsChecked: true, IsNavNameOverride: false, Index: entries.length } });
  }
  if (entries.length > 1000) throw new Error('job-list-too-large');
  return entries;
}
export function approvedJobList(plan: ApprovedJobPlan, privateDirectory: string): ApprovedJobItem[] {
  return approvedJobEntries(plan, privateDirectory).map(entry => entry.item);
}
export async function verifyApprovedJobFiles(plan: ApprovedJobPlan, privateDirectory: string): Promise<void> {
  approvedJobList(plan, privateDirectory);
  for (const entry of plan.entries) for (const job of [entry.primary, ...entry.alternates]) {
    for (const [file, expected] of [[approvedJobFile(privateDirectory, plan.reportHash, job.id), job.hash], [approvedJobSourceFile(privateDirectory, plan.reportHash, job.id), job.sourceHash]]) {
      const content = JSON.parse(await readFile(file!, 'utf8'));
      if (createHash('sha256').update(JSON.stringify(content)).digest('hex') !== expected) throw new Error('job-file-changed');
    }
  }
}
