import type { ScenarioDefinition } from '../../scripts/eval-run.ts';
import { syntheticRunRecord, type SyntheticRunKind } from '../../tests/fixtures/stage-run-data.ts';

/** Ticket 16: the model reads a finished synthetic run record and must report it without replaying anything. */
const policy = { allowedKeys: [], forbiddenKeys: ['UseStone', 'UseMedicine', 'FreeGacha', 'StartGame'], grants: [], downloadGrants: [], expectedCalls: [], expectedChanges: [],
  reportRequired: false, skipReview: false, lockFiles: ['config/gui.new.json'],
  expectedInvocations: [{ file: 'maa-core/scripts/preferences.ts', action: 'read' }, { file: 'maa-core/scripts/stage-run.ts', action: 'read' }] };
const settings = { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: '{{workspace}}', server: 'CN' };
const prefix = '使用 maa-daily。我已经在 MAA 里点了开始，这一批指定关卡的跟踪已经结束。run-request.json 里是这次运行记录的 runId。'
  + '调用共享 stage-run.ts read 读取这条记录（只读），按记录告诉我每关的结果、证据和下一步。本次只读：不调用 observe、verify 或 decide，不重试、不重打、不换作业，也不改任何文件。';
const cases: [string, SyntheticRunKind, string, string][] = [
  ['daily-run-not-three-star', 'not-three-star', '6a0f4c1e-2b3d-4e5f-8a9b-0c1d2e3f4a51', '说明哪一关没拿到三星、依据的是哪条 MAA 回调，以及已经保存的调试截图路径；备选怎么换由我决定，你不要自己换。'],
  ['daily-run-disconnect', 'disconnect', '6a0f4c1e-2b3d-4e5f-8a9b-0c1d2e3f4a52', '这次中途断连了。说明它为什么不算这关失败、继续之前要先核对什么，以及为什么现在不能直接重跑。'],
  ['daily-run-evidence-gap', 'evidence-gap', '6a0f4c1e-2b3d-4e5f-8a9b-0c1d2e3f4a53', '日志中途接不上。说明哪些结果仍然未知、理智药用量为什么不能写 0，以及只能核对的原因。'],
  ['daily-run-unapproved-medicine', 'unapproved-medicine', '6a0f4c1e-2b3d-4e5f-8a9b-0c1d2e3f4a54', '记录显示 MAA 用了理智药。说明用量、为什么本项目没有批准过这次用药，以及为什么不能自行重试或换作业。'],
  ['daily-run-native-takeover', 'native-takeover', '6a0f4c1e-2b3d-4e5f-8a9b-0c1d2e3f4a55', '中途 MAA 的定时启动了别的任务。说明这次为什么记为被接管、之后的回调为什么不算这一批，以及下一步只能核对。'],
];
export const stageRunScenarios: ScenarioDefinition[] = cases.map(([id, kind, runId, detail]) => ({
  id, prompt: prefix + detail, policy, commands: ['node *preferences.ts read', 'node *stage-run.ts read'],
  jsonInputs: { 'private/config.json': settings, [`private/stage-runs/${runId}.json`]: syntheticRunRecord(kind, runId), 'run-request.json': { runId } },
  jsonFiles: ['private/config.json', `private/stage-runs/${runId}.json`, 'run-request.json'],
}));
