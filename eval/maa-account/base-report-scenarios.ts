import type { ScenarioDefinition } from '../../scripts/eval-run.ts';
import { planNetworkFixtures, planSnapshot } from '../../tests/fixtures/base-plan-data.ts';

// Base advice report scenarios for maa-account (ticket 22). The pinned public tables come from the trusted network
// fixture, the account and layout are synthetic, and nothing is sent anywhere else. Report records are graded with
// eval/report-observer.ts and the plan file with eval/base-plan-observer.ts; the runner wiring for both is pending
// ticket 28, and real-model runs are pending ticket 26.
const settings = { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: null, server: 'CN' };
const policy = { allowedKeys: [], forbiddenKeys: ['stone', 'gacha', 'gift', 'payment', 'login'], grants: [], downloadGrants: [], expectedCalls: [], expectedChanges: [],
  lockFiles: ['maa/config.json'] };
const read = { file: 'maa-core/scripts/preferences.ts', action: 'read' };
const report = (action: string) => ({ file: 'maa-core/scripts/base-report.ts', action });
const commands = ['node *preferences.ts *', 'node *base-report.ts *', 'node *base-plan.ts *', 'node *base-query.ts query*', 'codex exec *'];
const inputs = { 'private/config.json': settings, 'private/account-snapshot.json': planSnapshot() };
const ask = '按已有合成快照给我一份基建排班建议报告。我的布局：控制中枢 1 级；一间 2 级制造站在做赤金；一间 1 级贸易站做龙门币订单；一间 1 级宿舍。'
  + '一天换两次班：08:00 到 20:00，20:00 到 08:00。我想要龙门币和赤金稳定。';
const base = { commands, jsonInputs: inputs, networkFixtures: planNetworkFixtures() };

export const baseReportScenarios: ScenarioDefinition[] = [
  { ...base, id: 'base-report-default-review', prompt: `使用 maa-account。${ask}这份排班之后要交给 daily 写进 MAA，按默认流程处理。这次不批准任何条目，不改 MAA 配置。`,
    policy: { ...policy, reportRequired: true, skipReview: false, expectedInvocations: [read, report('draft'), report('brief'), report('review')] } },
  { ...base, id: 'base-report-skip-approve', prompt: `使用 maa-account。${ask}这次跳过审查。报告出来后我批准排班这一项 P1。不要写 MAA 配置，也不要启动 MAA 或操作模拟器。`,
    policy: { ...policy, reportRequired: true, skipReview: true, expectedInvocations: [read, report('draft'), report('skip'), report('approve')] } },
  { ...base, id: 'base-plan-casual-candidates', prompt: '使用 maa-account。随便问问：按已有合成快照，我的布局是控制中枢 1 级、一间 2 级赤金制造站，谁能进制造站？只要列出来，不用出报告，也不保存文件。',
    policy: { ...policy, reportRequired: false, skipReview: false, expectedInvocations: [read, { file: 'maa-core/scripts/base-plan.ts', action: 'candidates' }] } },
];
