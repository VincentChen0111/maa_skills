# doctor 完整检查与转介的来源

工单 [10](issues/10-doctor-checks-referral.md)，2026-11-13 核对。MAA 固定 [v6.21.4 / 52d0b2acaca116585b02e1e6a9da303460f81a24](https://github.com/MaaAssistantArknights/MaaAssistantArknights/tree/52d0b2acaca116585b02e1e6a9da303460f81a24)（标签对象 `526df7113d56fe3d3f203ee694b87a80d5dfaf44` 指向该提交，经 GitHub 公开接口只读核对）。MAA 是 AGPL-3.0：只核对事实和思路，没有复制它的文字或代码；原文件只下载到本机临时目录阅读并计算指纹，不进仓库。指纹是该文件在固定提交上的 Git blob SHA，其中两份日志分析说明的指纹与 GitHub 接口返回的值逐一核对一致。

## 已在固定源码上核对的事实

| 事实 | 固定位置（blob） | 本仓库的用法 |
| --- | --- | --- |
| Core 每条回调都以一行日志记录：行首 `[时间][级别][Px进程号][Tx线程号]`，正文 `Assistant::append_callback \| <消息名> <详情 JSON>`；参数之间用一个空格分隔；消息名来自 `AsstMsg` 的名称表 | `src/MaaCore/Assistant.cpp`（`5382d9f3e3f1a37629865e29665a62874aece802`）的 `append_callback`；`src/MaaCore/Utils/Logger.hpp`（`9faaeec15657d82349c6cad8bed0fb0ddb537656`）的行首格式、级别名和默认空格分隔；`src/MaaCore/Common/AsstMsg.h`（`861cf34a2436d2bfc61911a4bdd1b7767f841fdd`） | `maa-log.ts` 只认这种结构化行，正文里出现的同名文字不算 |
| 每条任务链以 TaskChainCompleted、TaskChainError 或 TaskChainStopped 结束；普通的任务链出错后队列继续，队列清空时仍发 AllTasksCompleted；OutOfMemory 和 GpuDeviceRemoved 会清空剩余任务，先发带 `details.error` 的 TaskChainError，再发 TaskChainStopped；其他未处理异常也带 `details.error`，队列继续 | `src/MaaCore/Assistant.cpp`，任务线程循环 | 完成标记不覆盖错误：同一次运行里有 TaskChainError 就记失败；OutOfMemory/GpuDeviceRemoved 归入 MAA 进程异常（环境类），OpenCVException/UnhandledException/UnknownException 归入 MAA 缺陷候选 |
| 回调消息编号与名称、`ConnectionInfo` 的 `what`（ConnectFailed、Connected、UuidGot、UnsupportedResolution、ResolutionError、Reconnecting、Reconnected、Disconnect、ScreencapFailed、TouchModeNotAvailable、ResolutionChanged 等）及含义；`details` 含 `adb`、`address`、`config`，`uuid` 是设备唯一码；TaskChainError 的 `details.error` 取值；SubTask 消息带 `subtask`、`class`、`taskchain`、`taskid`、`details` | `docs/zh-cn/protocol/callback-schema.md`（`0d77db7b1a562417db2e389dd1339c92c6569b1f`） | 分类与证据字段；`adb`、`address`、`config`、`uuid`、`why` 一律不输出 |
| ResolutionChanged 时 Core 会停止当前任务 | `src/MaaCore/Assistant.cpp` 的 `append_callback` | 归入识别环境不对（环境类） |
| 调试截图文件名由时间戳加后缀组成；保存时写一行 `Save image <路径>` 或 `Save <描述> to <路径>`，路径可能是用户目录下的绝对路径 | `src/MaaCore/Utils/DebugImageHelper.hpp`（`14c41040a1536e4dcd30cb13cb7a8de3eb7f717d`） | 只取 `debug/interface/` 和 `debug/drops/` 下、文件名只含字母数字和 `_.@-` 且确实存在的图片，输出相对 MAA 目录的路径 |
| 远程控制设置类 `RemoteControl` 有 `RemoteControlGetTaskEndpointUri`、`RemoteControlReportStatusUri`、`RemoteControlUserIdentity`、`RemoteControlDeviceIdentity`、`RemoteControlPollIntervalMs`（默认 1000） | `src/MaaWpfGui/Configuration/Single/Settings/RemoteControl.cs`（`3605a165f777ee4246e722588a6efadb24f4e36d`） | 只读 `RemoteControlGetTaskEndpointUri` 是否非空 |
| 它挂在单个配置的 `Gui.RemoteControl` 下：`SpecificConfig` 有 `Gui`，`Gui` 有 `RemoteControl` | `src/MaaWpfGui/Configuration/Single/SpecificConfig.cs`（`f0764db882ea6fdfec200cadb62decbd7721cee4`）、`src/MaaWpfGui/Configuration/Single/Settings/Gui.cs`（`e42bde7e91dfe582567a949ee9111bf976dfaa62`） | 结论（工单写「核实后采用」）：`gui.new.json` 里的位置是 `Configurations.<配置名>.Gui.RemoteControl.RemoteControlGetTaskEndpointUri`；根上的 `Configurations`/`Current` 结构沿用 05、07 已核事实 |
| 界面读写的是当前配置的这些字段；非空值写入前用 Windows 当前用户的数据保护加密为 Base64，空值保持空串；加密失败时保留原文 | `src/MaaWpfGui/ViewModels/UserControl/Settings/RemoteControlUserControlModel.cs`（`125ea20ea1179603e207eb9a8279fafb3b99103a`）、`src/MaaWpfGui/Helper/SimpleEncryptionHelper.cs`（`dcc3d0e234d787c014d4fff0a3ce5c2cbacf4c20`） | 不解密；非空（去掉空白后）就记「已配置」 |
| 轮询只在解密后的取任务端点非空白且以 http:// 或 https:// 开头时启动；留空直接返回，不轮询 | `src/MaaWpfGui/Services/RemoteControl/RemoteControlService.cs`（`a8a697dc94782e9c6dce8ba03084d00b952d4947`）的 `InitializePollJobTask`、`IsEndpointValid` | 结论（工单写「核实后采用」）：端点留空等于不轮询，即停用 |
| 远程控制协议：MAA 按固定间隔（默认 1 秒）轮询取任务端点，远端下发的任务类型包括 `Toolbox-GachaOnce`、`Toolbox-GachaTenTimes`；请求带用户填写的用户标识和 MAA 生成的设备标识 | `docs/zh-cn/protocol/remote-control-schema.md`（`b50a7411b1fd24aef94144b81ee1b82b7f001e3d`） | 已配置时为提醒，说明远端可以让 MAA 抽卡；不输出端点和标识 |
| 官方日志分析说明：`asst.log` 对根因最权威，`gui.log` 用来建时间线；连接问题看 `ConnectionInfo`、`adb devices` 的 offline/unauthorized；关卡问题看 SubTaskError、TaskChainError 和 `debug/interface` 现场图；无有效证据时不出完整分析；有证据时的输出含概要、关键证据、根因判断（直接结论和证据链）、置信度和还缺什么证据 | `.agents/skills/maa-issue-log-analysis/SKILL.md`（`ae255f7e7fa7ade06ba2007c9b7df7f4436e16b6`） | [排查与转介对照](../skills/maa-doctor/references/triage.md)的分类、排查顺序和转介摘要结构 |
| 常见误判清单：连接类、关卡导航/难度切换、证据完整性、会客室/线索、版本差异、配置文件（`gui.new.json` 与日志不一致先看 `.bak`）、PC/Win32 输入、理智药/临期药、多开、触控模式 | `.agents/skills/maa-issue-log-analysis/KNOWLEDGE.md`（`11d14cb22cd353ccaf4c10839c6ebae6f8ffb8a1`） | 同上，逐类对照 |
| 官方中文问题模板要求在 MAA「设置 → 问题反馈」生成日志压缩包并上传，并要求先查常见问题 | `.github/ISSUE_TEMPLATE/cn-bug-report.yaml`（`b2b4da7cbe4b628ac8e05b9090d59ac4f9d532e7`）；`docs/zh-cn/manual/faq.md`（`9e213b27289f968e0602862e03d6acbe14d85983`） | 转介入口：常见问题、连接说明、issue 列表和日志压缩包的生成位置 |

Android 官方 [adb 文档](https://developer.android.com/tools/adb)（2026-11-13 只读核对）：adb 服务**启动时**扫描 5555–5585 的奇数本机端口来发现模拟器，每个模拟器用一对端口（偶数为控制台、奇数为 adb），在 `adb devices` 里列为 `emulator-<控制台端口>`；经网络连接的设备要 `adb connect` 之后才出现在列表里。AOSP `platform/packages/modules/adb` 提交 `1cf2f017d312f73b3dc53bda85ef2610e35a80e9` 的 `client/transport_emulator.cpp`（blob `e9ebaaa6f6fbadfa1ed5f465e557539adddcc761`，2026-11-13 只读核对）：扫描线程启动时调用一次 `PollAllLocalPortsForEmulator()`，之后只对连接刚关闭的端口重试 60 次、每次间隔 1 秒。所以服务启动后才开的模拟器不会被自动列出，等待也没有用。本仓库据此把 `emulator-<N>` 与本机端口 N+1 视为同一设备；配置的地址不在列表里时一律只报「未连接」，不推断模拟器关着，也不说等一会儿会出现。用户机器上 adb 的实际版本各不相同（MAA 和模拟器自带），这一行为没有在这些版本上逐一核对。

2026-11-13 只读访问核对（HTTP 200）：`https://docs.maa.plus/zh-cn/manual/faq.html`、`https://docs.maa.plus/zh-cn/manual/connection.html`、`https://github.com/MaaAssistantArknights/MaaAssistantArknights/issues/new/choose`。本仓库发布页 `https://api.github.com/repos/VincentChen0111/maa_skills/releases/latest` 当日返回 404（尚无正式发布），所以 `check --online` 当前得到 `skill-release-none`。

## 未验证

- 日志行首的时间格式由 `MAA_NS::format_now()` 决定，它在固定提交里不在本仓库可读的源码中。解析器只接受 `YYYY-MM-DD HH:MM:SS(.毫秒)`，其他格式的时间记为未知，不影响按顺序分段和分类。
- 详情 JSON 是否总在同一行（`to_string()` 的紧凑输出）没有在实际日志上核对；解析不了的详情记为 `callback-details-unparsed`，消息名仍然计入。
- `Save image` 行的实际引号和路径分隔符没有在实际日志上核对，匹配写得宽松，并且只引用磁盘上确实存在的文件。
- 切换配置后 MAA 是否会为新配置重新开始轮询没有核对；doctor 只要任何一个配置的取任务端点非空就记「已配置」，宁可多提醒。只含空白的端点会被 MAA 加密后存成非空串，doctor 也记「已配置」，同样是多提醒、不漏报。
- 没有真实 MAA、模拟器或设备上的运行；所有日志、配置和截图都是合成样例。

## 同类项目

工单列出的 [yumi233/maa-control-center](https://github.com/yumi233/maa-control-center) 和 [dongwlin/La-pluma-next](https://github.com/dongwlin/La-pluma-next)（均 MIT）本次没有查阅。脱敏采用白名单字段加模式拒绝（见 `maa-log.ts`），思路来自上面的官方说明和本仓库已有的隐私规则，没有借用这两个项目的代码。

## 供 25 登记的依赖条目

以下 MAA 位置是本票新增的依赖，按 [25](issues/25-maa-version-verification.md) 的要求登记指纹和受影响的 skill（maa-core 的 `maa-log.ts`、`doctor-checks.ts`，入口 maa-doctor）：

| 依赖 | 固定位置 | blob |
| --- | --- | --- |
| 回调日志行格式与消息名 | `src/MaaCore/Assistant.cpp`、`src/MaaCore/Utils/Logger.hpp`、`src/MaaCore/Common/AsstMsg.h` | 见上表 |
| 回调协议的消息名、`ConnectionInfo.what`、`TaskChainError.details.error` | `docs/zh-cn/protocol/callback-schema.md` | `0d77db7b1a562417db2e389dd1339c92c6569b1f` |
| 调试截图的保存目录与日志行 | `src/MaaCore/Utils/DebugImageHelper.hpp` | `14c41040a1536e4dcd30cb13cb7a8de3eb7f717d` |
| 远程控制设置类字段与位置、加密与轮询条件 | `RemoteControl.cs`、`Gui.cs`、`SpecificConfig.cs`、`RemoteControlUserControlModel.cs`、`SimpleEncryptionHelper.cs`、`RemoteControlService.cs` | 见上表 |
| 远程控制协议的任务类型 | `docs/zh-cn/protocol/remote-control-schema.md` | `b50a7411b1fd24aef94144b81ee1b82b7f001e3d` |
| 官方日志分析说明目录（随 MAA 版本变化） | `.agents/skills/maa-issue-log-analysis/SKILL.md`、`KNOWLEDGE.md` | `ae255f7e7fa7ade06ba2007c9b7df7f4436e16b6`、`11d14cb22cd353ccaf4c10839c6ebae6f8ffb8a1` |
| 问题模板与常见问题入口 | `.github/ISSUE_TEMPLATE/cn-bug-report.yaml`、`docs/zh-cn/manual/faq.md` | `b2b4da7cbe4b628ac8e05b9090d59ac4f9d532e7`、`9e213b27289f968e0602862e03d6acbe14d85983` |
