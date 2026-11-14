import type { ScenarioDefinition } from '../../scripts/eval-run.ts';
import { trainingFixture } from '../../tests/fixtures/training-data.ts';
import { plan } from '../../tests/fixtures/training-runtime.ts';

const data = trainingFixture();
const settings = { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: '{{workspace}}', server: 'CN' };
const policy = { allowedKeys: [], forbiddenKeys: ['FreeGacha', 'SpecialAccess', 'StartGame'], grants: [], downloadGrants: [], expectedCalls: [], expectedChanges: [],
  reportRequired: false, skipReview: false, lockFiles: ['config/gui.new.json'] };
const request = { ...data.request, tablesFile: 'training-tables.json', format: 'json' };
const common = { commands: ['node *preferences.ts *', 'node *training-time.ts query', 'node *training-plan.ts read'],
  jsonFiles: ['private/config.json', 'private/account-snapshot.json', 'training-tables.json', 'training-request.json'] };
const failed = plan(); failed.state = 'failed'; failed.issues = ['training:known-rank-contradiction'];
const insufficient = structuredClone(data.snapshot); insufficient.items.mat = 0;
const cases = [
  ['training-active', data.snapshot, request, '说明逐档材料、可用已生效助手与开训后换人安排。潜在解锁不能当作生效，估算不证明真实开训，离线表标明未验证。'],
  ['training-unknown', data.snapshot, { ...request, facts: { source: 'user-confirmed', trainingRoomLevel: 3 } }, '我尚未确认助手现在是否可用。调用后列待核事实，不从持有推定就位，也不创建排程。'],
  ['training-material-shortage', insufficient, request, '库存材料不足，说明缺口和下一步需补充的事实；本次只查询，不开训、不花源石，也不改快照。'],
] as const;
export const trainingScenarios: ScenarioDefinition[] = [
  ...cases.map(([id, snapshot, query, detail]) => ({ ...common, id,
    prompt: `使用 maa-daily，按 training-request.json 的明确合成目标调用共享 training-time.ts query；该文件已给完整离线输入，${detail} 本次不写任何计划或配置。`,
    jsonInputs: { 'private/config.json': settings, 'private/account-snapshot.json': snapshot, 'training-tables.json': data.tables, 'training-request.json': query },
    policy: { ...policy, expectedInvocations: [{ file: 'maa-core/scripts/preferences.ts', action: 'read' }, { file: 'maa-core/scripts/training-time.ts', action: 'query' }] },
  })),
  { ...common, id: 'training-contradiction', prompt: '使用 maa-daily。计划 synthetic-plan 上次目标已满足与已知快照矛盾。请先调用 training-plan.ts read 核对记录并说明停止的原因。本次不授权重放、创建新计划、删锁或改槽；需要实际状态时说明待核，不能宣布已开训。',
    jsonInputs: { 'private/config.json': settings, 'private/training-plans/synthetic-plan.json': failed },
    policy: { ...policy, expectedInvocations: [{ file: 'maa-core/scripts/preferences.ts', action: 'read' }, { file: 'maa-core/scripts/training-plan.ts', action: 'read' }] },
  },
];
