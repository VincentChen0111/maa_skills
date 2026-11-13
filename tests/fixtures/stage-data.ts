import type { AccountSnapshot } from '../../skills/maa-core/scripts/account-snapshot.ts';
import type { StageRequest, Job } from '../../skills/maa-core/scripts/stage-jobs.ts';

/**
 * A saved account snapshot as a fixed literal: scenario world data never runs product code (a parsing change must not change
 * the scenario). It is what an import of two recognised operators (合成甲 with the given elite, 合成乙) saved on 2026-11-11.
 */
export const stageSnapshot = (elite: number | null = 2): AccountSnapshot => ({ version: 1, source: 'maa', readAt: '2026-11-11T00:00:00.000Z', operators: [
  { id: 'char_synthetic_a', name: '合成甲', rarity: null, elite, level: 50, potential: 1, skillLevel: null, mastery: null, modules: null },
  { id: 'char_synthetic_b', name: '合成乙', rarity: null, elite: 1, level: 30, potential: 1, skillLevel: null, mastery: null, modules: null },
], items: {}, lmd: null, base: null, sourceTimes: { operators: null, inventory: null }, coverage: {
  operators: { status: 'partial', issues: ['missing-rarity', ...(elite === null ? ['missing-elite'] : []), 'missing-rarity'] },
  inventory: { status: 'missing', issues: [] }, base: { status: 'unavailable', issues: ['not-provided-by-recognition'] } } });
export const stageTables = { stages: {
  synthetic_01: { stageId: 'synthetic_01', code: 'SYN-1', levelId: 'Obt/Synthetic/level_synthetic_01', zoneId: 'synthetic_map', difficulty: 'NORMAL', unlockCondition: [{ stageId: 'synthetic_00', completeState: 'PASS' }] },
  'synthetic_01#f#': { stageId: 'synthetic_01#f#', code: 'SYN-1', levelId: 'Obt/Synthetic/level_synthetic_01', zoneId: 'synthetic_map', difficulty: 'FOUR_STAR', unlockCondition: [{ stageId: 'synthetic_01', completeState: 'COMPLETE' }] },
} };
export const stageRequest: StageRequest = { stages: [{ stageId: 'synthetic_01', code: 'SYN-1', difficulty: 'normal', loops: 3 }], completions: { synthetic_00: 'PASS' }, completionEvidence: '合成用户本次确认前置通过', maaVersion: 'v6.21.4' };
export const stageJob = (id: number, difficulty = 1): Job => ({ id, content: { stage_name: 'synthetic_01', difficulty, minimum_required: 'v6.0.0',
  opers: [{ name: '合成甲', requirements: { elite: 2, level: 40 } }], groups: [], actions: [{ type: 'SpeedUp' }], doc: { title: '合成作业', details: '' } },
  source: { url: `https://prts.maa.plus/copilot/get/${id}`, readAt: '2026-11-11T00:00:00.000Z' } });
