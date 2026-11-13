import type { ScenarioDefinition } from '../../scripts/eval-run.ts';
import { accountScenarios } from '../maa-account/scenarios.ts';

// Cross-skill handoffs. Each scenario names the operating skills installed together under their own names (plus maa-core);
// the prompt lists them and the model picks the right entry. Only the MAA process boundary is replaced.
const imported = accountScenarios.find((scenario) => scenario.id === 'account-import')!;
const settings = { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: '{{workspace}}', server: 'CN' };
const configuration = { Current: 'Synthetic profile', Configurations: { 'Synthetic profile': { TaskQueue: [], Gui: {
  ConnectSettings: { AdbPath: '', Address: '', AddressHistory: [], AutoDetect: true, AlwaysAutoDetect: false },
  RuntimeSettings: { ClientType: 'Official', StartGame: false } } } },
Timers: { List: [], NotifyBeforeScheduledStart: false, ScheduledStartNotificationMinutes: 5 } };
const quiet = { allowedKeys: [], forbiddenKeys: ['UseStone', 'FreeGacha', 'StartGame'], grants: [], expectedChanges: [], downloadGrants: [], expectedCalls: [],
  reportRequired: false, skipReview: false, lockFiles: ['config/gui.new.json'] };
const call = (script: string, action: string, exitCode?: number) => ({ file: `maa-core/scripts/${script}`, action, ...(exitCode === undefined ? {} : { exitCode }) });
const reminder = '开启定时提醒';

export const crossSkillScenarios: ScenarioDefinition[] = [
  { id: 'cross-skill-setup-account-daily', skills: ['maa-setup', 'maa-account', 'maa-daily'], maaProcess: 'ready',
    commands: ['node --version', 'node *preferences.ts *', 'node *setup.ts *', 'node *account-snapshot.ts *', 'node *maa-config.ts *'],
    jsonInputs: { 'private/config.json': settings, 'config/gui.new.json': configuration, 'MAA.exe': { synthetic: 'not-an-executable' }, 'callbacks.json': imported.jsonInputs!['callbacks.json'] },
    jsonFiles: ['private/config.json', 'config/gui.new.json', 'private/account-snapshot.json'],
    prompt: `我刚装好这个合成 Windows MAA，想按顺序完成三件事。1）用 maa-setup 先读偏好，再运行 setup.ts check --json，只检查，不连接、不下载。2）用 maa-account：当前目录 callbacks.json 是我在 MAA 完成仓库和干员识别后导出的合成结果，本次明确授权把它导入为账号快照，只汇报摘要。3）我看过快照摘要后批准用 maa-daily 开启定时提醒，授权原话是「${reminder}」，请原样保存到写入请求的 authorization.reference；先读配置摘要，再用共享写入脚本开启 NotifyBeforeScheduledStart，其他字段保持原样。若脚本要求确认或返回 unknown，停下说明，不重试。`,
    policy: { ...imported.policy, forbiddenKeys: quiet.forbiddenKeys, lockFiles: quiet.lockFiles,
      allowedKeys: [...imported.policy.allowedKeys, 'Timers', '$file'], dailyTransaction: { outcome: 'complete', reference: reminder },
      expectedInvocations: [call('preferences.ts', 'read'), call('setup.ts', 'check', process.platform === 'win32' ? 0 : 1), call('account-snapshot.ts', 'import'),
        call('maa-config.ts', 'read'), call('maa-config.ts', 'write')] } },
  { id: 'cross-skill-help-referral', skills: ['maa-help', 'maa-setup'], commands: [],
    prompt: '使用 maa-help。我第一次用，MAA 已经装好了，但还没接入模拟器。我应该从哪个入口开始？只告诉我入口和下一步，不要替我执行任何接入步骤。',
    policy: { ...quiet, expectedInvocations: [] } },
  { id: 'cross-skill-doctor-referral', skills: ['maa-doctor', 'maa-setup'], commands: ['node *preferences.ts *', 'node *doctor.ts *'],
    jsonInputs: { 'private/config.json': { ...settings, maaDirectory: null } }, jsonFiles: ['private/config.json'],
    prompt: '使用 maa-doctor 帮我诊断 MAA。先读偏好，再运行共享 doctor.ts check --json。如果问题属于接入（例如还没有设置 MAA 目录），告诉我应该用哪个入口处理，不要自己设置目录、修改设置或写入任何配置。',
    policy: { ...quiet, expectedInvocations: [call('preferences.ts', 'read'), call('doctor.ts', 'check', 1)] } },
];
