---
name: maa-setup
description: 接入已有的 Windows 图形界面版 MAA 和国服模拟器，现场检查 Node 24、语言和私有目录，发现并测试 adb 连接，经统一写入器保存连接设置。缺少程序时给官方安装入口；当前不下载程序。
---

# maa-setup

开始前确认相邻 `../maa-core/scripts/` 中的 `preferences.ts`、`setup.ts`、`setup-connection.ts`、`maa-config.ts`、`maa-process.ts` 存在。缺少 core 时停止：Codex 使用自带 skill-installer，从 `VincentChen0111/maa_skills` 同一版本安装 `skills/maa-core` 与 `skills/maa-setup`；Claude Code 使用原生市场 `/plugin marketplace add VincentChen0111/maa_skills`、`/plugin install maa-skills@maa-skills` 安装完整插件，已有安装用原生更新入口更新。

1. 先确认当前宿主是 Windows，运行 `node --version` 确认主版本是 24。缺少或版本不符时按 [接入接口](references/setup.md) 给官方入口，等用户装好再继续；旧 Node 可能连 TypeScript 检查器都不能运行。可运行后，调用 `node <本目录>/../maa-core/scripts/preferences.ts read`，标准输入传 `{"currentLanguage":"<用户当前语言的 BCP 47 标签>"}`。按返回语言回复；未设语言时用用户当前语言。读取设置失败也继续下一步只读 check，用用户当前语言报告诊断。
2. 读 [接入接口](references/setup.md)，运行 `setup.ts check --json`，每次都重新读取现场。依次说明 Windows GUI MAA、国服、Node、设置文件、私有目录和版本的检查结果，已经正常的步骤跳过。MAA 目录未设置时询问用户已有目录；可以先用 `check` 的 `maaDirectory` 检查，再经 [偏好接口](../maa-core/references/preferences.md) 保存。配置缺失或损坏时让用户在 MAA GUI 初始化／检查，保留原文件。
3. 设置损坏或不可读时按 check 返回的原因、修法和执行者处理，保留原文件，等待用户修复；不能当成首次接入询问或覆盖，也不猜私有目录。只有首次需要时询问偏好语言和私有目录（默认用户目录下 `.maa-skills`）；用户本次已给的答案直接使用。已有设置沿用，不重复提问。语言问过但暂未选时，经偏好脚本记录 `languageAsked: true`。结构化设置只交给 `preferences.ts set`，不直接写设置文件；私有目录选择仓库、skill 和 MAA 安装目录之外。随后调用 `setup.ts prepare --json` 创建私有目录骨架并记录现场结果。它只创建目录及 `setup-environment.json`，保留已有文件。
4. 使用 `setup.ts discover --json` 发现现有 adb 和本机模拟器地址。候选按序号、来源和状态说明，不输出真实路径、地址、完整配置或账号信息。零候选时让用户在模拟器／MAA 界面检查 adb 路径和本机连接地址；多个候选时明确让用户选择。来源不足以区分时请用户在本机界面选定后提供路径／地址，以标准输入限定候选；不按排列顺序猜测。单一候选或用户选定后，绑定返回的 `discoveryRevision` 和候选 `id` 调用 `test`。只测试 adb 传输，不点击、截图、登录或操作游戏，也不启动模拟器。
5. 连接测试通过，且本次需要保存连接设置时，调用 `apply`。该动作在共享脚本内重新发现、复测，再交统一写入器；只调整当前配置的 adb 路径、地址及关闭自动发现的两个开关，不改变连接预设／触控／登录。MAA 已关闭且无锁时，安装请求仍不代表关闭确认：明确告诉用户 MAA 已关闭，获得“没有在操作，可以写入”的单独确认后才传 `closedConfirmed: true`。若首次调用返回 `closed-confirmation-required`，等确认再调用；绝不为了让调用通过自行填 true。遗留锁交 maa-doctor 核对，未知结果不重放。
6. `complete` 或 `unchanged` 后重新运行 `prepare` 记录现状，说明 adb 测试只证明传输可用，MAA 识别／游戏任务尚未实机验证。未知版本或版本记录缺失只提醒，仍可接入；读取随包的验证记录，不把起点 skill 的历史经验当成本仓库实机已核。安装缺项列出官方入口与后续步骤，报告本次实际完成和待处理项。

用户发起安装即授权这些接入步骤；程序下载属于后续下载流程，每次仍需先说明文件名、官方来源和大小并获同意。本入口当前不下载、不安装缺失程序。只写设置（经偏好脚本）、私有目录骨架与环境记录、连接配置（经统一写入器）；账号快照和建议报告交 maa-account。抽卡、礼包、付费、登录、碎石以外的源石用途和设备操作始终不执行；本入口也不接受理智药、碎石或临期药的授权，这些只由 maa-daily 在用户当次批准后写入。
