# 排查与转介对照

用户描述运行失败、报错或「MAA 没做完」时读本文件。分类和排查顺序对照 MAA 官方仓库在固定版本 v6.21.4 自带的日志分析说明（`.agents/skills/maa-issue-log-analysis/SKILL.md`）和常见误判清单（同目录 `KNOWLEDGE.md`），只取事实和思路；条目名指向这两份文件里的小节。这两份说明随 MAA 版本变化，指纹登记在仓库的 doctor 来源文档里，由版本核对工单跟踪。

## 判断依据

- 只按 `doctor.ts analyze` 读出的结构化回调判断：`ConnectionInfo` 的 `what`、`TaskChainError`、`SubTaskError`、`AllTasksCompleted`、`TaskChainStopped`。日志正文里出现的同名文字、界面提示和 MAA 进程退出码都不算证据；退出码 0 不代表成功。
- 同一次运行里有 TaskChainError 就是失败，后面的 AllTasksCompleted 不覆盖它（固定版本里出错的任务链之后队列会继续，最后仍发完成）。
- 没有结束回调、日志缺失或读不到更早一段时，结果是「未知」。未知只核对当前状态，不重放、不重试原操作。
- `ConnectFailed` 之后同一次运行里又出现 `Connected`、`UuidGot` 或 `Reconnected` 的，只是重试过程，不算这次运行的结果。

## 环境类失败的排查顺序

`analyze` 把下面三类标为环境类（`classification.environment: true`），给出原因（`cause`）、证据（`evidence`）和当前状态（`currentState`）：

1. 连接（`connection`）：`ConnectFailed`、`Disconnect`、`ScreencapFailed`、`TouchModeNotAvailable`。先看 `currentState.connection`（与 `check` 的连接检查同一个函数，只运行 `adb devices`）：设备离线、未授权、不在列表里，还是已恢复在线。`device-not-connected` 只说明配置的地址现在不在 adb 的列表里，任何地址都是这一种状态：网络地址要有人 `adb connect` 之后才会列出（例如 MuMu 的 `127.0.0.1:16384` 在 MAA 连接之前）；本机模拟器端口（5555–5585 的奇数端口，列为 `emulator-<端口减一>`）只在 adb 服务启动时扫描一次，之后只对刚断开的端口重试约 60 秒，所以服务启动后才开的模拟器等多久也不会自己出现。它不能证明模拟器关着；请用户确认模拟器是否开着，关着就由用户打开，开着就经 maa-setup 的测试流程或在 MAA 里连接一次再看。配置的写法本身在列表里时以它为准；只有换了写法（`localhost`／`127.0.0.1`、`emulator-<N>`／端口 N+1）的条目时，取其中最好的状态。`adb-path-unrecognized` 表示配置的 adb 路径不是 adb 程序，doctor 没有运行它，连接未核对。对应官方「Common Pitfalls / 连接类」：连接问题以 `asst.log` 为准，`offline` 多半是模拟器或 adb 状态异常。
2. 识别环境不对（`recognition-environment`）：`UnsupportedResolution`、`ResolutionError`、`ResolutionChanged`。请用户在模拟器设置里核对分辨率，或确认运行中没有改过分辨率。
3. MAA 进程异常（`maa-process`）：`InitFailed`、`InternalError`，以及 TaskChainError 的 `OutOfMemory`、`GpuDeviceRemoved`（固定版本里这两种会清空剩余任务，需要重启 MAA）。看 `currentState.maa`，重启 MAA 由用户做。

查明原因后由模型在 `nextSteps` 里选：在原有批准范围内重试、换下一份已批准的备选，或者停下告诉用户。不按失败次数自动交给用户或换作业；重试和换作业不增加理智药或碎石的数量，启动方式不变。环境类失败不记为作业失败。用户手动玩游戏造成的登录冲突也按环境类处理。

## 逐类：本机能核对的（不改 MAA），和只能转介的

| 官方分类（出处） | 本机核对（不改 MAA） | 只能转介的情形 |
| --- | --- | --- |
| 连接类（KNOWLEDGE「连接类」；SKILL「Workflow」第 6 步、「How To Filter Evidence」第 4 步） | `check` 的 `connection`；`analyze` 的连接回调和 `currentState.connection` | 本机连接检查正常、模拟器和 adb 都在运行，仍反复连接失败或截图失败（模拟器兼容）：转介，附连接说明入口 |
| 分辨率与界面遮挡（回调协议 `ConnectionInfo`；SKILL「Report Map / debug/interface」） | `analyze` 的分辨率回调；请用户确认画面没有被遮挡；可给出 `debug/interface/` 现场图的相对路径让用户自己查看 | 分辨率无误、画面未遮挡后仍识别失败：按下一行转介 |
| 关卡导航与难度切换（KNOWLEDGE「关卡导航 / 难度切换」；SKILL「How To Filter Evidence」第 6 步） | `analyze` 的 SubTaskError（子任务名、`task` 名）和现场图；`localChecks` 三项 | 三项都排除后：MAA 识别缺陷或游戏更新后 MAA 还没适配，转介 |
| 证据完整性（KNOWLEDGE「证据完整性」） | `analyze` 的 `missingEvidence`：缺 `asst.log`、读不到更早一段、详情解析不了、没有现场图 | 不转介不完整的证据；请用户在 MAA 里生成日志压缩包后由用户自己提交 |
| 版本差异（KNOWLEDGE「版本差异」） | `check` 的 `version`（安装版本与核实记录）；摘要带 MAA 版本 | 旧版本问题请用户按 MAA 官方发布说明决定是否升级；仍复现再转介 |
| 配置文件（KNOWLEDGE「配置文件」；SKILL「Report Map / config」） | `check` 的 `configuration`、`configuration-fields`、`remote-control`、写入锁；当前配置不一定是出问题时那一份 | 不转介；本项目管理的字段错了由用户在 MAA 里改，或经所属 skill 的写入器重写 |
| 理智药与临期药（KNOWLEDGE「理智药 / 临期药」） | `configuration-fields` 只核对类型与范围；用药数量和临期判断不在本票 | MAA 的用药识别与日志相反等：转介，附 `asst.log` 证据 |
| MAA 内部异常（回调协议 TaskChainError `details.error`） | `analyze` 归为 `maa-defect` | `OpenCVException`、`UnhandledException`、`UnknownException`：直接转介 |
| PC 客户端与触控模式（KNOWLEDGE「PC / Win32 输入」「Connect.TouchMode」） | `TouchModeNotAvailable` 按连接类处理；触控模式是用户在 MAA 里的设置 | 本项目只支持模拟器上的图形界面版，不为官方 PC 客户端排查；需要时转介 |
| 会客室、线索和其他「先改界面再继续」的流程（KNOWLEDGE「Stateful UI Automation Checks」「Reception Clue Analysis」） | 无；doctor 不判断这类流程是否符合设计 | 有日志证据时转介，由 MAA 判断是否按设计 |
| 多开（KNOWLEDGE「MAA multi-opening」） | 无 | MAA 本身只按单账号设计；说明不支持，不转介 |
| 没有有效证据（SKILL「Scope」「Output Format / 分流规则」） | `analyze` 结果未知 | 不出转介摘要；请用户复现后在 MAA 里生成日志压缩包 |

## 转介摘要

`analyze` 只在原因已查明属于本项目范围外时给出 `referral.state: "ready"`：MAA 内部异常；识别失败且分辨率、连接、界面遮挡三项都已排除；或者环境类、原因不明的失败经调查后由模型在输入里写明结论（`maa-defect`、`emulator-compatibility`、`game-update-not-adapted`）。识别失败的三项本机检查不能被结论跳过；`pending` 时先完成 `remaining` 里的检查。

摘要固定为五部分，对照官方输出格式里的「Issue 概要」「关键证据」「根因判断」「置信度」：

- `overview` 现象概要：结果、类别、任务链名、MAA 版本。
- `keyEvidence` 关键证据：`debug/asst.log` 的时间段、回调消息名、`what`、子任务和 `task` 名、异常类型；MAA 已保存的现场图，只给相对 MAA 目录的路径。
- `rootCause` 根因判断和证据链。
- `confidence` 置信度：高、中、低。
- `missingEvidence` 还缺什么证据：日志压缩包、`gui.log` 时间线、复现步骤等。

官方模板里的诉求评估、修复方案、给修复 AI 的建议和英文翻译是给 MAA 维护者的，不在本项目摘要里。摘要只由白名单字段组成：没有凭据、账号或设备标识、连接地址、完整配置、配置名、用户目录或其他私人路径。转述时也不要补充这些内容。

入口（`referral.entries`）：MAA 常见问题、连接说明（连接相关时）、MAA issue 列表，以及在 MAA「设置 → 问题反馈」生成日志压缩包。提交 issue 或上传压缩包由用户自己完成；agent 不代发。
