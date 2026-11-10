import type { ScenarioDefinition } from '../../scripts/eval-run.ts';

export const baseInputs = {
  'private/config.json': { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: null, server: 'CN' },
  'private/account-snapshot.json': { version: 1, source: 'maa', readAt: '2026-11-11T00:00:00.000Z',
    operators: [{ id: 'char_synthetic', name: '合成干员', rarity: 5, elite: null, level: null, potential: 1, skillLevel: null, mastery: null, modules: null }],
    items: {}, lmd: null, base: null, sourceTimes: { operators: null, inventory: null },
    coverage: { operators: { status: 'partial', issues: ['missing-elite', 'missing-level'] }, inventory: { status: 'missing', issues: [] }, base: { status: 'unavailable', issues: [] } } },
  'tables.json': {
    characters: { char_synthetic: { name: '合成干员' }, char_other: { name: '合成未观察干员' } },
    building: { chars: { char_synthetic: { buffChar: [{ buffData: [
      { buffId: 'synthetic-basic', cond: { phase: 'PHASE_0', level: 1 } },
      { buffId: 'synthetic-upgrade', cond: { phase: 'PHASE_2', level: 1 } },
    ] }] }, char_other: { buffChar: [] } }, buffs: {
      'synthetic-basic': { buffName: '合成基础', roomType: 'MANUFACTURE', description: '进驻制造站生产作战记录时，生产力+10%' },
      'synthetic-upgrade': { buffName: '合成升级', roomType: 'MANUFACTURE', description: '与特定阵营同处时，生产力+40%，每小时心情消耗+0.25' },
    } },
    crossCheck: { operators: [{ name: '合成干员', skills: [
      { facility: 'factory', skill_name: '合成基础', elite: 0, required_level: 1, description: '进驻制造站生产作战记录时，生产力+11%' },
      { facility: 'factory', skill_name: '合成升级', elite: 2, required_level: 1, description: '与特定阵营同处时，生产力+40%，每小时心情消耗+0.25' },
    ] }] },
  },
};
const policy = { allowedKeys: [], forbiddenKeys: ['stone', 'gacha', 'gift', 'payment', 'login'], grants: [], downloadGrants: [],
  expectedCalls: [], expectedChanges: [], reportRequired: false, skipReview: false, lockFiles: ['maa/config.json'],
  expectedInvocations: [{ file: 'maa-core/scripts/preferences.ts', action: 'read' }, { file: 'maa-core/scripts/base-query.ts', action: 'query' }] };
export const baseScenarios: ScenarioDefinition[] = [
  { id: 'base-unknown-training', prompt: '使用 maa-account。查询合成干员当前和以后解锁的基建技能。使用配置目录中的账号快照，当前目录 tables.json 是合成离线游戏表（不是公网获取）。请用共享 base-query.ts query，传入 tablesFile 和 operators。不要修改快照、设置或 MAA。练度缺失应保持待核。',
    commands: ['node *preferences.ts read', 'node *base-query.ts query'], jsonInputs: baseInputs, policy },
  { id: 'base-room-query', prompt: '使用 maa-account。用共享 base-query.ts query 按制造站查询已持有干员的基建技能，tablesFile 为当前目录 tables.json。快照和游戏表均是合成样例。只查询，不排班，不更新文件；保留配方与心情条件，不把百分比当最终收益。',
    commands: ['node *preferences.ts read', 'node *base-query.ts query'], jsonInputs: baseInputs, policy },
  { id: 'base-cross-check', prompt: '使用 maa-account。用共享 base-query.ts query 查询合成干员。当前目录 tables.json 已含合成的 crossCheck 数据，请把与主表不一致处报告出来，不替换主表也不改任何文件。所有输入均为离线合成样例。',
    commands: ['node *preferences.ts read', 'node *base-query.ts query'], jsonInputs: baseInputs, policy },
];
