import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// support: the user explicitly approved borrowing one support unit for this slot (需借助战); the GUI 「借助战」 switch is set by the user.
export type ApprovedJob = { id: number; hash: string; sourceHash: string; source: { url: string; readAt: string; sha256?: string }; support?: { slot: string; members: string[] } };
export type ApprovedJobPlan = { reportHash: string; map: string; entries: { stageId: string; code: string; difficulty: 'normal' | 'raid'; difficultyGroup: string; loops: number; primary: ApprovedJob; alternates: ApprovedJob[] }[] };
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function approvedJobFile(privateDirectory: string, reportHash: string, id: number): string {
  if (!hash(reportHash) || !Number.isSafeInteger(id) || id < 1) throw new Error('job-plan-invalid');
  return join(privateDirectory, 'stage-jobs', reportHash, `${id}.json`);
}
export function approvedJobSourceFile(privateDirectory: string, reportHash: string, id: number): string {
  approvedJobFile(privateDirectory, reportHash, id);
  return join(privateDirectory, 'stage-jobs', reportHash, 'source', `${id}.json`);
}
export function approvedJobList(plan: ApprovedJobPlan, privateDirectory: string) {
  if (!plan || !hash(plan.reportHash) || typeof plan.map !== 'string' || !plan.map || !Array.isArray(plan.entries) || !plan.entries.length) throw new Error('job-plan-invalid');
  const list: { Name: string; FilePath: string; CopilotId: number; IsRaid: boolean; IsChecked: boolean; IsNavNameOverride: boolean; Index: number }[] = [];
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
    for (let repeat = 0; repeat < entry.loops; repeat++) list.push({ Name: entry.code, FilePath: approvedJobFile(privateDirectory, plan.reportHash, entry.primary.id),
      CopilotId: entry.primary.id, IsRaid: entry.difficulty === 'raid', IsChecked: true, IsNavNameOverride: false, Index: list.length });
  }
  if (list.length > 1000) throw new Error('job-list-too-large');
  return list;
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
