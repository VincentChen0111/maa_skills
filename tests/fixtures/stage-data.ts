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

/**
 * A saved Skland snapshot as a fixed literal (owner trial item 9): 合成甲 with the given per-skill mastery, a Y module at
 * level 2 and an X module still locked; 合成乙 as in the MAA snapshot. It is what a Skland read saved on 2026-11-16.
 */
export const stageSklandSnapshot = (mastery: Record<string, number> = { 1: 3, 2: 3, 3: 0 }): AccountSnapshot => ({ version: 1, source: 'skland', readAt: '2026-11-16T00:00:00.000Z', operators: [
  { id: 'char_synthetic_a', name: '合成甲', rarity: 6, elite: 2, level: 90, potential: 1, skillLevel: 7, mastery,
    modules: { uniequip_001_synthetic_a: 1, uniequip_002_synthetic_a: 2, uniequip_003_synthetic_a: 0 } },
  { id: 'char_synthetic_b', name: '合成乙', rarity: 5, elite: 1, level: 30, potential: 1, skillLevel: 4, mastery: { 1: 0, 2: 0 }, modules: {} },
], items: {}, lmd: null, base: null, sourceTimes: { operators: null, inventory: null }, coverage: {
  operators: { status: 'complete', issues: [] }, inventory: { status: 'complete', issues: [] }, base: { status: 'complete', issues: [] } } });
/** The pinned uniequip table reduced to what the stage-job check reads: each module's operator and type letter. */
export const stageModules = { uniequip_001_synthetic_a: { charId: 'char_synthetic_a', typeName2: null },
  uniequip_002_synthetic_a: { charId: 'char_synthetic_a', typeName2: 'Y' }, uniequip_003_synthetic_a: { charId: 'char_synthetic_a', typeName2: 'X' } };
/** A job whose only operator needs S2 mastery 3 and the Y module (MAA module 2) at level 2. */
export const masteryJob = (id: number): Job => {
  const job = stageJob(id); job.content.opers = [{ name: '合成甲', skill: 2, requirements: { elite: 2, level: 50, skill_level: 10, module: 2, module_level: 2 } }]; return job;
};
