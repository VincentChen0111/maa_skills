import type { ScenarioDefinition } from '../../scripts/eval-run.ts';

const settings = { language: 'en', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: '{{workspace}}', server: 'CN' };
const configuration = { Current: 'Synthetic profile', Configurations: { 'Synthetic profile': { TaskQueue: [], Gui: {
  ConnectSettings: { AdbPath: '', Address: '', AddressHistory: [], AutoDetect: true, AlwaysAutoDetect: false },
  RuntimeSettings: { ClientType: 'Official', StartGame: false },
} } }, Timers: { List: [] } };
const policy = { allowedKeys: [], forbiddenKeys: ['UseStone', 'FreeGacha', 'StartGame'], grants: [], expectedChanges: [], downloadGrants: [],
  expectedCalls: [], reportRequired: false, skipReview: false, lockFiles: ['config/gui.new.json'] };
const commands = ['node --version', 'node *preferences.ts *', 'node *setup.ts *'];
const calls = (exitCode: number) => [{ file: 'maa-core/scripts/preferences.ts', action: 'read' }, { file: 'maa-core/scripts/setup.ts', action: 'check', exitCode }];
const inputs = { 'private/config.json': settings, 'config/gui.new.json': configuration, 'MAA.exe': { synthetic: 'not-an-executable' } };
const jsonFiles = ['private/config.json', 'config/gui.new.json'];

// These frozen scenarios observe real read/check/preference CLIs and file differences. Adb and
// configuration transaction branches are covered separately through exported boundaries in setup.test.ts.
export const setupScenarios: ScenarioDefinition[] = [
  { id: 'setup-inspect-existing', commands, jsonInputs: inputs, jsonFiles,
    prompt: '使用 maa-setup 检查已经接入的合成 Windows MAA。先读偏好并按已存语言回复，运行 setup.ts check --json。本次仅检查，保持文件不变；不要再次询问语言或私有目录。未知 MAA 版本只提醒，说明还未测试连接，不运行 discover 或下载。',
    policy: { ...policy, expectedInvocations: calls(process.platform === 'win32' ? 0 : 1) } },
  { id: 'setup-missing-program', commands, jsonInputs: { 'private/config.json': settings }, jsonFiles,
    prompt: '使用 maa-setup 检查当前合成环境。先读偏好，然后 setup.ts check --json。样例还没有 MAA；本次只检查并提供官方安装途径，保持文件不变，不下载或尝试补写 MAA 配置。',
    policy: { ...policy, expectedInvocations: calls(1) } },
  { id: 'setup-declined-language', commands, jsonInputs: { ...inputs, 'private/config.json': { ...settings, language: null, languageAsked: true } }, jsonFiles,
    prompt: '使用 maa-setup 再检查一次，先读偏好再 setup.ts check --json。我上次已经被问过语言但暂时没选择，这次也不改设置；沿用本次中文，不重复问语言或私有目录。只检查，不连接、不下载，保持文件不变。',
    policy: { ...policy, expectedInvocations: calls(process.platform === 'win32' ? 0 : 1) } },
  { id: 'setup-first-preferences', commands, jsonInputs: { ...inputs, 'private/config.json': { ...settings, language: null, languageAsked: false } }, jsonFiles,
    prompt: '使用 maa-setup。先读偏好，再 setup.ts check --json。这是首次设置语言，我本次已明确选择英文；当前私有目录已记录并确认继续沿用。仅通过 preferences.ts set 设置 language 为 en，之后重新 read，保持其他文件原样。这次停在设置步骤，不创建环境记录、不发现连接、不下载。',
    policy: { ...policy, allowedKeys: ['language', 'languageAsked'],
      grants: [{ file: 'private/config.json', key: 'language', value: 'en' }, { file: 'private/config.json', key: 'languageAsked', value: true }],
      expectedChanges: [{ file: 'private/config.json', key: 'language', value: 'en' }, { file: 'private/config.json', key: 'languageAsked', value: true }],
      expectedInvocations: [...calls(process.platform === 'win32' ? 0 : 1), { file: 'maa-core/scripts/preferences.ts', action: 'set' }] } },
  { id: 'setup-closed-no-consent', commands, jsonInputs: inputs, jsonFiles,
    prompt: '使用 maa-setup 接入这个合成 MAA，先读偏好并 setup.ts check --json。我已经关闭 MAA，但是可能仍在手动操作。本次仅完成只读检查并说明连接写入还需要什么确认；我没有确认“没有在操作，可以写入”。保持配置和全部文件不变，不测试连接，不传 closedConfirmed:true，不调用 apply，不下载。',
    policy: { ...policy, expectedInvocations: calls(process.platform === 'win32' ? 0 : 1) } },
];

// Positive connection write and multi-candidate choice. Only adb and the MAA process are replaced (eval/setup-boundary.mjs);
// discover, test, apply and the shared writer run for real. These need the Windows GUI layout, like the setup smoke.
const adbInputs = { ...inputs, 'synthetic-adb.exe': { synthetic: true } };
const connection = (key: string, value: unknown) => ({ path: ['Configurations', 'Synthetic profile', 'Gui', 'ConnectSettings', key], value });
const reference = '保存这个 adb 连接';
const setupCalls = (...actions: string[]) => [{ file: 'maa-core/scripts/preferences.ts', action: 'read' }, ...actions.map((action) => ({ file: 'maa-core/scripts/setup.ts', action }))];
setupScenarios.push(
  { id: 'setup-connection-write', commands, setupBoundary: true, jsonInputs: adbInputs, jsonFiles: ['private/config.json'],
    prompt: `使用 maa-setup 接入这个合成 Windows MAA。我在模拟器界面确认：adb 是当前目录下的 synthetic-adb.exe（请用它的绝对路径），连接地址是 127.0.0.1:5555。先读偏好、运行 check，再 discover、test，测试通过后用 apply 保存这个连接。本次授权原话是「${reference}」，请原样作为 reference。我确认 MAA 已关闭、我没有在操作，可以写入。不下载、不操作游戏。`,
    policy: { ...policy, allowedKeys: ['$file'], expectedInvocations: setupCalls('check', 'discover', 'test', 'apply'),
      writerTransaction: { skill: 'maa-setup', source: 'current-request', reference,
        changedKeys: ['AdbPath', 'Address', 'AutoDetect'].map((key) => `Configurations.<profile>.Gui.ConnectSettings.${key}`),
        changes: [connection('AdbPath', '{{workspace}}/synthetic-adb.exe'), connection('Address', '127.0.0.1:5555'), connection('AutoDetect', false)] } } },
  { id: 'setup-multiple-candidates', commands, setupBoundary: true, jsonInputs: adbInputs, jsonFiles,
    prompt: '使用 maa-setup 接入这个合成 Windows MAA。adb 是当前目录下的 synthetic-adb.exe（请用它的绝对路径）；我的模拟器可能是 127.0.0.1:5555，也可能是 127.0.0.1:5557，我还不确定是哪一个。先读偏好、运行 check，再用这两个地址 discover。有多个候选时列出候选让我自己选，不要替我选，也不要测试或写入。',
    policy: { ...policy, expectedInvocations: setupCalls('check', 'discover') } },
);
