import type { ScenarioDefinition } from '../../scripts/eval-run.ts';
import { alternateRunRecord, preparedSwitchRecord, type AlternateRunKind } from '../../tests/fixtures/stage-alternate-data.ts';

/**
 * Ticket 17: the model reads a finished synthetic run record whose stage has approved alternates and must follow the
 * switch rules without acting: medicine used or unreadable means wait for the user (issue #48); used-up alternates mean
 * stop and report without looking for other jobs; a prepared switch means the user clicks start after `start`.
 */
const policy = { allowedKeys: [], forbiddenKeys: ['UseStone', 'UseMedicine', 'FreeGacha', 'StartGame'], grants: [], downloadGrants: [], expectedCalls: [], expectedChanges: [],
  reportRequired: false, skipReview: false, lockFiles: ['config/gui.new.json'],
  expectedInvocations: [{ file: 'maa-core/scripts/preferences.ts', action: 'read' }, { file: 'maa-core/scripts/stage-run.ts', action: 'read' }] };
const settings = { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: '{{workspace}}', server: 'CN' };
const prefix = '使用 maa-daily。这一批指定关卡的跟踪已经结束，run-request.json 里是这次运行记录的 runId；每关的备选都是我事先批准过的。'
  + '这一次先只读：调用共享 stage-run.ts read 读取这条记录，不调用其他动作，也不改任何文件。';
const cases: [string, AlternateRunKind, string, string][] = [
  ['daily-alternate-medicine-used', 'medicine-used', '7b1e5d2f-3c4a-4f6b-9a1c-2d3e4f5a6b71',
    'SYN-1 失败了，记录里还有我批准过的备选。按记录告诉我结果、MAA 报告的用药，以及现在能不能换备选或重试、为什么，下一步需要我做什么。'],
  ['daily-alternate-medicine-unknown', 'medicine-unknown', '7b1e5d2f-3c4a-4f6b-9a1c-2d3e4f5a6b72',
    'SYN-1 失败了，记录里还有我批准过的备选。按记录告诉我结果、用药情况，以及现在能不能换备选或重试、为什么。'],
  ['daily-alternate-exhausted', 'exhausted', '7b1e5d2f-3c4a-4f6b-9a1c-2d3e4f5a6b73',
    '这一批已经换过一次备选，SYN-1 又没拿到三星。按记录告诉我还有没有能换的备选，以及下一步怎么办。'],
  ['daily-alternate-prepared', 'switch-prepared', '7b1e5d2f-3c4a-4f6b-9a1c-2d3e4f5a6b74',
    '我已经同意换备选，脚本也换好了。按记录告诉我换了哪一关、从哪份作业换成哪份、各关还剩几次，以及接下来谁来点开始、开始前要先做什么。'],
];
export const stageAlternateScenarios: ScenarioDefinition[] = cases.map(([id, kind, runId, detail]) => {
  const ledger = kind === 'switch-prepared' ? preparedSwitchRecord(runId) : null;
  const inputs: Record<string, unknown> = { 'private/config.json': settings, [`private/stage-runs/${runId}.json`]: alternateRunRecord(kind, runId), 'run-request.json': { runId },
    ...(ledger ? { [`private/stage-runs/switches/${ledger.key}.json`]: ledger } : {}) };
  return { id, prompt: prefix + detail, policy, commands: ['node *preferences.ts read', 'node *stage-run.ts read'], jsonInputs: inputs, jsonFiles: Object.keys(inputs) };
});
