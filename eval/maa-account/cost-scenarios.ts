import type { ScenarioDefinition } from '../../scripts/eval-run.ts';
import { operatorCostSources } from '../../skills/maa-core/scripts/operator-cost.ts';
import { costTables, costSnapshot } from '../../tests/fixtures/cost-data.ts';

const policy = { allowedKeys: [], forbiddenKeys: ['gacha', 'gift', 'payment', 'login'], grants: [], downloadGrants: [], expectedCalls: [], expectedChanges: [], reportRequired: false, skipReview: false, lockFiles: ['maa/config.json'],
  expectedInvocations: [{ file: 'maa-core/scripts/preferences.ts', action: 'read' }, { file: 'maa-core/scripts/operator-cost.ts', action: 'query' }] };
const tables = costTables();
const networkFixtures = Object.fromEntries(Object.entries(operatorCostSources).map(([key, source]) => [`https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`, tables[key as keyof typeof tables]]));
const settings = { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: null, server: 'CN' };
const base = { policy, networkFixtures, commands: ['node *preferences.ts *', 'node *operator-cost.ts query'] };
const unknown = costSnapshot(); Object.assign(unknown.operators[0]!, { elite: null });
const ambiguousTables = costTables(); Object.assign(ambiguousTables.characters, { char_synthetic_form: structuredClone(ambiguousTables.characters.char_synthetic) });
const ambiguousNetwork = Object.fromEntries(Object.entries(operatorCostSources).map(([key, source]) => [`https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`, ambiguousTables[key as keyof typeof ambiguousTables]]));
export const costScenarios: ScenarioDefinition[] = [
  { ...base, id: 'account-cost-raw', prompt: '使用 maa-account。已保存合成快照；查询合成干员从当前练度到精英 2、等级 2 的原始成本。调用共享 query，报告逐步材料、龙门币、经验、来源和时间；本次只读，不保存报告，不刷新识别。',
    jsonInputs: { 'private/config.json': settings, 'private/account-snapshot.json': costSnapshot() } },
  { ...base, id: 'account-cost-unknown', prompt: '使用 maa-account。请调用共享 query 核对合成干员到精英 1、等级 1 的成本。快照有未知当前练度，我没有确认过；报告待核项，不猜当前等级，不把未知写为零，不改任何文件。',
    jsonInputs: { 'private/config.json': settings, 'private/account-snapshot.json': unknown } },
  { ...base, id: 'account-cost-no-craft', prompt: '使用 maa-account。按已有合成快照调用共享 query，查询合成干员到精英 2、等级 2 的不加工差额；未列库存保留未知。只报告已知需求、库存和差额，不兑换、不加工、不做采购，不保存文件。',
    jsonInputs: { 'private/config.json': settings, 'private/account-snapshot.json': costSnapshot() } },
  { ...base, networkFixtures: ambiguousNetwork, id: 'account-cost-ambiguous', prompt: '使用 maa-account。请调用共享 query 查询合成干员到精英 1、等级 1 的成本。我未指定形态或 ID；如果同名请报告候选，让我确认，不默认选择，不改文件。',
    jsonInputs: { 'private/config.json': settings, 'private/account-snapshot.json': costSnapshot() } },
];
