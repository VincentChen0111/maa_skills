import assert from 'node:assert/strict';
import { buildCultivationReport } from '../../skills/maa-core/scripts/cultivation-report.ts';
import { saveAdviceReport, recordReviewSkip, approveReportItems } from '../../skills/maa-core/scripts/advice-report.ts';
import type { trainingFixture } from './training-data.ts';

/**
 * Ticket 32: a real approved cultivation report on the synthetic training world, saved and approved through the shared
 * report functions: S1 trains 合成干员 S1 to M2, S2 trains 合成助手 S1 to M1. Returns the report hash.
 */
export async function approvedTrainingReport(privateDirectory: string, f: ReturnType<typeof trainingFixture>) {
  const steps = [{ name: '合成干员', target: { mastery: { '1': 2 } }, current: f.request.current, reason: '先专精', evidence: [] },
    { name: '合成助手', target: { mastery: { '1': 1 } }, current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': 0 } }, reason: '其次', evidence: [] }];
  const built = buildCultivationReport(f.tables as never, f.snapshot, { priorities: { source: 'user-stated', text: '合成：按顺序专精' }, assumptions: [], summary: null, evidence: [], steps } as never,
    [], new Date().toISOString());
  assert.ok(built.content, JSON.stringify(built.issues));
  const { hash } = await saveAdviceReport(privateDirectory, built.content!);
  await recordReviewSkip(privateDirectory, 'cultivation', hash, { userWords: 'synthetic: 跳过审查' });
  await approveReportItems(privateDirectory, 'cultivation', hash, { items: ['S1', 'S2'], userWords: 'synthetic: 全部批准' });
  return hash;
}
