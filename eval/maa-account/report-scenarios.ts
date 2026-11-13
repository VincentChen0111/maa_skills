import type { ScenarioDefinition } from '../../scripts/eval-run.ts';
import { reportNetworkFixtures, reportSnapshot } from '../../tests/fixtures/report-data.ts';

// Cultivation report scenarios for maa-account (ticket 20). The pinned public tables come from the trusted
// network fixture, the account is synthetic, and nothing is sent anywhere else. Report records are graded with
// eval/report-observer.ts (reports and reviews evidence); the runner applies it (scripts/eval-run.ts).
const settings = { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: null, server: 'CN' };
const policy = { allowedKeys: [], forbiddenKeys: ['stone', 'gacha', 'gift', 'payment', 'login'], grants: [], downloadGrants: [], expectedCalls: [], expectedChanges: [],
  lockFiles: ['maa/config.json'] };
const read = { file: 'maa-core/scripts/preferences.ts', action: 'read' };
const report = (action: string) => ({ file: 'maa-core/scripts/cultivation-report.ts', action });
const commands = ['node *preferences.ts *', 'node *cultivation-report.ts *', 'node *operator-cost.ts query*', 'node *cultivation-gaps.ts query*', 'codex exec *'];
const inputs = { 'private/config.json': settings, 'private/account-snapshot.json': reportSnapshot() };
const goals = '按已有合成快照给我一份培养建议报告：先把合成干员练到精英1等级1，再把合成二号练到精英1等级1。我主要打肉鸽，肉鸽优先。'
  + '我确认加工站有一间3级房间，stage_synthetic 的通关rank为2（公开配方字段），当前持有的 premium_material_voucher_perm 有效可选。';
const base = { commands, jsonInputs: inputs, networkFixtures: reportNetworkFixtures() };

export const reportScenarios: ScenarioDefinition[] = [
  { ...base, id: 'account-report-skip-review', prompt: `使用 maa-account。${goals}这次赶时间，跳过审查。报告之后可能交给 daily，但这次不批准任何条目，不改 MAA 配置。`,
    policy: { ...policy, reportRequired: true, skipReview: true, expectedInvocations: [read, report('draft'), report('skip')] } },
  { ...base, id: 'account-report-default-review', prompt: `使用 maa-account。${goals}这份报告要交给 daily 执行，按默认流程处理。这次不批准任何条目，不改 MAA 配置。`,
    policy: { ...policy, reportRequired: true, skipReview: false, expectedInvocations: [read, report('draft'), report('brief'), report('review')] } },
  { ...base, id: 'account-report-approve-one', prompt: `使用 maa-account。${goals}这次跳过审查。报告出来后，我只批准第 1 步（合成干员那一步），第 2 步先不批准。不要执行培养，也不改 MAA 配置。`,
    policy: { ...policy, reportRequired: true, skipReview: true, expectedInvocations: [read, report('draft'), report('skip'), report('approve')] } },
  { ...base, id: 'account-report-casual', prompt: '使用 maa-account。随便问问：按已有合成快照，合成干员从现在练到精英1等级1大概要多少材料和龙门币？只要个数字，不用出报告，也不保存文件。',
    policy: { ...policy, reportRequired: false, skipReview: false, expectedInvocations: [read, { file: 'maa-core/scripts/operator-cost.ts', action: 'query' }] } },
];
