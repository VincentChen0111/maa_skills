import type { ScenarioDefinition } from '../../scripts/eval-run.ts';
import { operatorCostSources } from '../../skills/maa-core/scripts/operator-cost.ts';
import { craftingSources } from '../../skills/maa-core/scripts/cultivation-gaps.ts';
import { gapTables, gapSnapshot } from '../../tests/fixtures/gap-data.ts';

const tables = gapTables();
const networkFixtures = Object.fromEntries(Object.entries({ ...operatorCostSources, ...craftingSources }).map(([key, source]) => [
  `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`, tables[key as keyof typeof tables],
]));
const policy = { allowedKeys: [], forbiddenKeys: ['stone', 'gacha', 'gift', 'payment', 'login'], grants: [], downloadGrants: [], expectedCalls: [], expectedChanges: [],
  reportRequired: false, skipReview: false, lockFiles: ['maa/config.json'], expectedInvocations: [
    { file: 'maa-core/scripts/preferences.ts', action: 'read' }, { file: 'maa-core/scripts/cultivation-gaps.ts', action: 'query' },
  ] };
const settings = { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: null, server: 'CN' };
const base = { policy, networkFixtures, commands: ['node *preferences.ts *', 'node *cultivation-gaps.ts query*'] };
const confirmed = '我确认加工站有一间3级房间，stage_synthetic 的通关rank为2（公开配方字段），当前持有的 premium_material_voucher_perm 有效可选。';
const shared = gapSnapshot(); shared.lmd = 209;
export const gapScenarios: ScenarioDefinition[] = [
  { ...base, id: 'account-gaps-voucher-craft', prompt: `使用 maa-account。按已有合成快照查询合成干员到精英1等级1的加工与材料券缺口。${confirmed}调用共享缺口query，说明凭证换下级料后加工的顺序、原始需求、已有/加工/凭证覆盖、费用和仍缺；同时展示不加工对照。只读，不兑换、不操作设备、不保存文件。`,
    jsonInputs: { 'private/config.json': settings, 'private/account-snapshot.json': gapSnapshot() } },
  { ...base, id: 'account-gaps-no-craft', prompt: `使用 maa-account。按已有合成快照计算合成干员到精英1等级1的材料券缺口，当前选项为 --no-craft。${confirmed}调用共享缺口query并解释不加工方案中下级材料券不能直接替代上级材料；比较方案分别用独立库存。只读，不兑换、不加工、不保存文件。`,
    jsonInputs: { 'private/config.json': settings, 'private/account-snapshot.json': gapSnapshot() } },
  { ...base, id: 'account-gaps-unknown-progress', prompt: '使用 maa-account。调用共享缺口query核对合成干员到精英1等级1的加工和材料券缺口。我未确认房间等级或关卡进度；报告待核条件，不能默认配方解锁，也不要把未知当零。本次只读已有快照，不请求或操作真实设备、不保存文件。',
    jsonInputs: { 'private/config.json': settings, 'private/account-snapshot.json': gapSnapshot() } },
  { ...base, id: 'account-gaps-shared-stock', prompt: `使用 maa-account。按此顺序查询两个目标：合成干员到精英1等级1，合成二号到精英1等级1。${confirmed}调用共享缺口query，库存、材料券和龙门币只共享一份，先保留全部原始需求。解释加工费用能支持几份材料及各目标分配，保留交叉核对缺项；只读，不兑换、不保存文件。`,
    jsonInputs: { 'private/config.json': settings, 'private/account-snapshot.json': shared } },
];
