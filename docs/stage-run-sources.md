# 16 关卡运行跟踪来源核对

2026-11-13。只读核对 MAA 固定标签 v6.21.4（标签对象 `526df7113d56fe3d3f203ee694b87a80d5dfaf44`，提交 `52d0b2acaca116585b02e1e6a9da303460f81a24`，与 [作业接口核对](stage-jobs-sources.md) 同一提交）的公开源码和文档。源码只用于核对接口事实，读取时不落盘；没有复制 MAA（AGPL-3.0）的实现。下面的结论都是源码层面的推导，没有在真实 MAA、模拟器或游戏上运行过。参考项目只对照思路，没有复制代码：[A1m233/maa-daily-skill](https://github.com/A1m233/maa-daily-skill)（界定本次运行的日志行、执行状态与业务结果分开）、[yumi233/maa-control-center](https://github.com/yumi233/maa-control-center)（`gui.log` 的判断顺序）、[LIYuhao-u/maa-arknights-auto](https://github.com/LIYuhao-u/maa-arknights-auto)（只靠回调核对关卡），三者均为 MIT。

| 固定文件 | Git blob |
| --- | --- |
| [callback-schema.md](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/docs/zh-cn/protocol/callback-schema.md) | `0d77db7b1a562417db2e389dd1339c92c6569b1f` |
| [zh-cn.xaml](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Res/Localizations/zh-cn.xaml) | `0d526f8b32a32b735ce39dd9717202df35534097` |
| [maa-issue-log-analysis/SKILL.md](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/.agents/skills/maa-issue-log-analysis/SKILL.md) | `ae255f7e7fa7ade06ba2007c9b7df7f4436e16b6` |
| [Assistant.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Assistant.cpp) | `5382d9f3e3f1a37629865e29665a62874aece802` |
| [AsstMsg.h](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Common/AsstMsg.h) | `861cf34a2436d2bfc61911a4bdd1b7767f841fdd` |
| [Logger.hpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Utils/Logger.hpp) | `9faaeec15657d82349c6cad8bed0fb0ddb537656` |
| [CopilotTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Interface/CopilotTask.cpp) | `e648ba6fb7dbcbd36ad8c2b9a74797fce117d497` |
| [MultiCopilotTaskPlugin.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Miscellaneous/MultiCopilotTaskPlugin.cpp) | `6478872806ab3c020c204eb874148f88ca320a1e` |
| [BattleProcessTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Miscellaneous/BattleProcessTask.cpp) | `50acf086f7a832a073141c3790bd2e806e19defa` |
| [StageDropsTaskPlugin.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Fight/StageDropsTaskPlugin.cpp) | `e98cea229cc1d36d0a4fd669d832a9d33d0282bf` |
| [MedicineCounterTaskPlugin.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Fight/MedicineCounterTaskPlugin.cpp) | `40bb203cd98acc4b53f31443ca4685e45eec5ff2` |
| [ProcessTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/ProcessTask.cpp) | `7560b2f3a4b34f936d0e02bebc218b864ca0f793` |
| [AbstractTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/AbstractTask.cpp) | `b5e0a22d3f3ad6c02e14393fb3e0b1491f6c26c9` |
| [tasks.json](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/resource/tasks/tasks.json) | `9d4989f6994b1e3c66afb826835501fa5d499877` |
| [AsstProxy.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Main/AsstProxy.cs) | `d81d25ef2611c23f2cbcf05b891dbf2b943990a7` |
| [Bootstrapper.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Main/Bootstrapper.cs) | `22c986344a70a0d42a0d53e5dd614bf6de1515e8` |
| [TaskQueueViewModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/TaskQueueViewModel.cs) | `1de00775603e0c41b75379583578a8f01e4ddb88` |
| [CopilotViewModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/CopilotViewModel.cs) | `066ca1bbab9a4690950319ed710a04a018095b75` |
| [NotificationService.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Services/Notification/NotificationService.cs) | `e883347e2b445dfe82041a39e46d47ca7249a2ac` |
| [CopilotItemViewModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/Items/CopilotItemViewModel.cs) | `222c05ae2d9520c058acc27c1f1beab5fe50b38b` |
| [ConfigFactory.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Factory/ConfigFactory.cs) | `7f9a85ca85a2faadfa051655c30c8620bf26f3d9` |

## 回调行和日志文件

- 每个回调都写进 Core 日志：`Assistant.cpp` 第 1014 行 `Log.info("Assistant::append_callback |", msg, more_detail.to_string())`，第 994–996 行给每个回调补上设备唯一码 `uuid`。`AsstMsg.h` 第 36–62 行把消息打印成名字（`TaskChainError` 等）。`Logger.hpp` 第 495 行给每行加 `[时间][级别][Px进程][Tx线程]`。专精核对此前在 v6.22.0 上核对的同一格式（见[专精来源核对](training-sources.md)）在 v6.21.4 上一致。解析只保留一份，在 `skills/maa-core/scripts/maa-callback.ts`。运行记录不保存 `uuid` 和 `ConnectionInfo.details` 里的 adb 路径、地址和配置。
- `Assistant.cpp` 第 596 行发 `TaskChainStart`；第 697–702 行任务链结束时发 `TaskChainStopped`、`TaskChainCompleted` 或 `TaskChainError`；第 682–694 行未处理异常时 `TaskChainError` 带 `details.error`；第 720–723 行队列空了就发 `AllTasksCompleted`，前面出错也照样发。
- 日志轮换：`Logger.hpp` 第 1188–1189、1198 行，`debug/asst.log` 超过 64 MiB 时第 779–800 行把它改名为 `debug/asst.bak.log` 再写新文件。`Bootstrapper.cs` 第 77–81 行给出 `gui.log`、`gui.bak.log`、`asst.bak.log` 的路径，第 604–612 行 GUI 启动时 `gui.log` 超过 4 MiB 才挪到 `gui.bak.log`，第 625 行 `gui.log` 每行为 `[yyyy-MM-dd HH:mm:ss.fff][级别]类名 <线程> 内容`。
- 本机核对（Windows、Node 24）：改名保留文件的 dev/ino，新建文件得到新的 ino；新文件的创建时间会沿用旧文件（文件系统隧道效应），所以文件身份只用 dev 和 ino，不用创建时间。`tests/maa-log-window.test.ts` 用真实临时文件验证。

## 回调协议（callback-schema.md）

- 第 26–52 行消息编号；第 115–136 行 `ConnectionInfo` 的 `ConnectFailed`、`Reconnecting`、`Reconnected`、`Disconnect`、`ScreencapFailed`、`TouchModeNotAvailable`、`UnsupportedResolution`、`ResolutionError`，第 143–146 行 `ResolutionChanged`。第 259–283 行任务链消息，异常种类为 `OpenCVException`、`OutOfMemory`、`GpuDeviceRemoved`、`UnhandledException`、`UnknownException`。第 293–368 行子任务消息；`ExceededLimit` 见第 366 行。
- 第 450–466 行 `StageDrops`：`details.stage.stageCode`、`details.stage.stageId`、`details.stars`。

## 自动战斗的回调（源码推导，未实机验证）

- 列表模式每一项开始时 `MultiCopilotTaskPlugin.cpp` 第 49–53 行发 `SubTaskExtraInfo`，`what` 为 `CopilotListLoadTaskFileSuccess`，`details` 带 `stage_name`、`file_name` 和 `id`；`CopilotViewModel.cs` 第 2279–2282 行把列表项的 `Index` 作为 `id` 传入。跟踪按 `id` 对应到已批准列表，用 `file_name` 的指纹核对是不是批准的作业文件，不保存路径。
- 三星检查：`CopilotTask.cpp` 第 232–243 行列表模式在每项最后加 `Copilot@WaitUntilEndOfAction`（注释「带三星检查」）。`tasks.json` 里 `Copilot@EndOfAction` 的下一步只有 `Copilot@StageDrops-Stars-3` 和 `Copilot@StageDrops-Stars-Adverse`（文档「如果没有三星就终止」），`Copilot@FightMissionFailed` 接到 `Copilot@EndOfAction`，`Copilot@WaitUntilEndOfAction` 执行 50 次后转 `Copilot@EndOfAction`。`ProcessTask.cpp` 第 376–385 行命中一个任务时发 `SubTaskStart`，`details.task` 为任务名；第 188–192 行识别不到下一步就发 `SubTaskError`，第 533–537 行带 `first`（起始任务）和 `pre_task`；第 362–371、439–448 行次数用尽时发 `ExceededLimit`。由此：三星任务命中记成功；同一项先命中 `Copilot@FightMissionFailed` 后出错记失败；命中 `Copilot@EndOfAction`、没有命中三星、以 `Copilot@WaitUntilEndOfAction` 为起点的出错记未三星；等待次数用尽且没有结算画面的出错记明确超时。`zh-cn.xaml` 第 1048 行的列表模式说明「遇到理智不足、战斗失败、未能三星结算时将自动中止」与此一致。
- 理智不足：固定版本的自动战斗没有专门报告理智不足的回调。只有理智药开关打开时，`CopilotTask.cpp` 第 36–40 行的 `BattleStartPre@UseMedicine` 才会运行；它命中（理智恢复弹窗出现）而没有 `UseMedicine` 用药回调、随后在开战前出错时，记理智不足。开关关着时理智不足只表现为开战前出错，这时记结果未知，不记失败。
- 掉落回调：`StageDropsTaskPlugin.cpp` 第 21–37 行只在 `Fight@EndOfAction` 和 `Fight@EndOfActionAnnihilation` 时运行，`CopilotTask.cpp` 也没有注册它。所以固定版本的自动战斗不发 `StageDrops`，关卡核对对打过的关通常给「未知」；工具仍按回调比较，将来版本发了掉落回调就能给出吻合或不符。没有打的关只在证据完整且任务链结束时给「没有打」。
- 理智药：`MedicineCounterTaskPlugin.cpp` 第 177–201 行在 `MedicineConfirm` 成功后发 `SubTaskExtraInfo`，`what` 为 `UseMedicine`，`details.count` 是这一次确认用掉的瓶数（第 190 行），这一条核实后采用。运行记录把各次 `count` 相加；看到 `MedicineConfirm` 却没有随后的 `UseMedicine`、`count` 不是非负整数、日志接不上或被接管时，用药记为未知。`CopilotTask.cpp` 第 71、200 行的 `use_sanity_potion` 开关从 `append_task` 日志的参数里读出，记为「开始时理智药开关」。

## gui.log 的写法

- 界面日志写进 `gui.log`：`TaskQueueViewModel.cs` 第 1604–1630 行、`CopilotViewModel.cs` 第 189–225 行（默认 `logToFile`）、`NotificationService.cs` 第 55–74 行。
- 已核对的中文文案：`zh-cn.xaml` 第 700 行「完成任务: 」、第 709 行「任务出错: 」、第 973 行「未选择作业」、第 975 行「读取文件失败！」、第 1996 行「战斗出错」。
- 自动战斗启动失败（核实后采用）：`CopilotViewModel.cs` 第 2149 行写 `Copilot.StartFailed`，即 `zh-cn.xaml` 第 1015 行「作业启动失败」。自动战斗出错（核实后采用）：`AsstProxy.cs` 第 1436–1464 行对 `Copilot` 任务链写「任务出错: 」加任务链名，并以「战斗出错」作为自动战斗日志内容。
- 任务失败后仍写完成任务（核实后采用）：`Assistant.cpp` 第 720–723 行出错后队列空了照样发 `AllTasksCompleted`，`AsstProxy.cs` 第 1672–1675 行自动战斗收到它就写「完成任务: 」。所以读 `gui.log` 先查错误标记，再查完成标记，两者都有按错误处理。
- `AsstProxy.cs` 第 1484、1537 行另写英文的 `Start Task Chain: {TaskChain}, Task ID: {TaskId}` 和 `Completed Task Chain: ...`，用来划定本次运行的时间段。
- 运行时长上限（明确超时）：`TaskQueueViewModel.cs` 第 954 行写 `Run duration limit reached: {LimitMinutes} min, stopping`，随后按手动停止处理；任务链以 `TaskChainStopped` 结束且这一段里有这条记录时记明确超时，没有这条记录的停止记结果未知。

## 作业列表的勾选（核实后采用，2026-11-13 第 2 轮审查后补）

- 列表模式开始时 `CopilotViewModel.cs` 第 2279–2282 行只把勾选的条目（`IsChecked`）提交给 MAA，所以下次点开始会打的就是仍勾选的条目。
- 自动取消勾选只有一处：`AsstProxy.cs` 第 2162–2165 行在 `StageDrops-Stars-3` 或 `StageDrops-Stars-Adverse` 时调用 `CopilotTaskSuccess`，`CopilotViewModel.cs` 第 2036–2057 行把当前这一项取消勾选并保存。没有三星的结算、作战失败、断连都不会取消勾选。
- 勾选随即保存：`CopilotItemViewModel.cs` 第 95–100 行 `IsChecked` 的 setter 调 `SaveCopilotTask`，`CopilotViewModel.cs` 第 2028–2030 行把列表写回当前配置的 `Copilot.TaskList`；`ConfigFactory.cs` 第 43 行的配置文件是 `config/gui.new.json`，第 52、56、310–312、324–336 行在属性变化后去抖 200 毫秒再写盘。所以带 `retryOf` 的 `start` 读 `gui.new.json` 里每项的 `IsChecked`，就是用户在界面上的勾选；刚点完的 200 毫秒内可能还没写盘，`start` 按读到的判断，勾得多就拒绝，不会放宽。

## 原生定时接管（核实后采用）

`TaskQueueViewModel.cs` 第 1168–1193 行：定时到点时写 `Scheduled configuration change: Timer Index: {N}` 或 `Scheduled start: Timer Index: {N}`；强制定时启动且不空闲时第 1234 行写 `Not idle, Stop and CloseDown`，停止当前任务后追加 `CloseDown` 再开始新一轮（第 1235–1248 行），回调里表现为本批次的 `TaskChainStopped` 和随后其他任务链的 `TaskChainStart`。跟踪期间出现这三条记录之一，或本批次没有结束就出现别的任务链开始，记为被接管：之后的回调不算本批次，结果和用药都按未知处理，只核对。

## 未验证

- 以上全部是固定源码的推导；真实 MAA、模拟器和游戏上的回调顺序没有实机核对。
- `MaaUtils` 子模块里 `format_now()` 的时间格式没有核对；跟踪用字节起点界定本次运行，时间只用来排序两份日志，读不出时间的定时标记按被接管处理。
- 列表模式失败、未三星、理智不足和明确超时的具体回调序列（上面的推导）没有实机样例；合成样例按推导构造。
- 官方 PC 客户端下的掉线弹窗和回调没有核对。
