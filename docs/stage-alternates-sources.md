# 17 换备选来源核对

2026-11-13。工单 [17](issues/17-approved-alternate-jobs.md) 第 5 条要求在固定 MAA 版本上核实「失败后接着换作业」的原生机制。只读核对 MAA 固定标签 v6.21.4（提交 `52d0b2acaca116585b02e1e6a9da303460f81a24`，与[运行跟踪来源](stage-run-sources.md)、[作业接口核对](stage-jobs-sources.md)同一提交）的公开源码。源码只用于核对接口事实，读取时不落盘；没有复制 MAA（AGPL-3.0）的实现。以下是源码层面的推导，没有在真实 MAA、模拟器或游戏上运行过。

## 结论：固定版本没有可用的原生续跑机制

换上备选后由 agent 经统一写入通道准备好新的作业列表，请用户点开始（规格「日常操作」的「做不到时」一支）。依据：

1. **列表模式里一项失败，后面的条目都不再运行。**
   - [CopilotTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Interface/CopilotTask.cpp)：
     - 第 178–186 行把每一项的子任务模板复制成列表的项数，每项的数据交给 `MultiCopilotTaskPlugin`；
     - 第 242–243 行在每项末尾启用带三星检查的 `Copilot@WaitUntilEndOfAction`；
     - 第 55–56 行这个停止任务没有设成忽略错误。
   - [AbstractTask.h](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/AbstractTask.h) 第 102 行，忽略错误默认为 false。
   - [PackageTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/PackageTask.cpp) 第 29–30 行：子任务失败、又不忽略错误时立即返回，后面的子任务不再运行。
   - 所以一项作战失败或没拿到三星（`Copilot@EndOfAction` 之后只接三星两种结果，见[运行跟踪来源](stage-run-sources.md)）时，整条任务链以 `TaskChainError` 结束，列表里后面的条目都不打。
2. **自动战斗没有「失败后继续」「跳过」或「重试」的设置。**
   - CopilotTask.cpp 第 71–96、230 行列出全部参数：`use_sanity_potion`、`formation`、`formation_index`、`add_trust`、`ignore_requirements`、`user_additional`、`support_unit_usage`、`support_unit_name`、`operbox_data_path`、`filename`、`copilot_list`、`loop_times`。
   - `loop_times` 只在单文件模式里重复同一份作业（第 245 行起），列表模式不用它。
   - 第 27 行列表插件的重试次数为 0。
   - [CopilotViewModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/CopilotViewModel.cs) 里，与循环有关的只有单文件模式的 `Loop` 和 `LoopTimes`，没有失败后跳过或继续的属性。
   - 自动取消勾选只发生在三星时（见[运行跟踪来源](stage-run-sources.md)「作业列表的勾选」），失败的条目仍然勾着。
3. **原生定时不启动自动战斗。**
   - [TaskQueueViewModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/TaskQueueViewModel.cs) 的定时到点后走 `HandleScheduledStart` → `LinkStart` → `LinkStartWithTasks(ConfigFactory.CurrentConfig.TaskQueue)`，只运行当前配置的任务队列（定时处理见[运行跟踪来源](stage-run-sources.md)「原生定时接管」第 1168–1193 行）。
   - 任务队列可选的类型表 `TaskTypeList` 里没有自动战斗。
   - CopilotViewModel.cs 里也没有定时或自动开始的入口，`Start` 只由界面按钮触发。

## 不采用的做法

- **把备选也勾进列表、排在主作业后面。** 主作业失败时任务链已经结束，备选打不到；主作业成功时备选又会多打一次，超出批准的次数。
- **用 `loop_times` 或原生定时代替用户点开始。** 前者只用于单文件模式；后者不启动自动战斗。规格「其他说明」不借鉴未经批准的自动换作业。

## 依赖

- 换备选依赖上面三点。将来 MAA 版本若提供失败后继续的机制，要重新核对后才能改为由 MAA 自己启动，在此之前一律由用户点开始。
- 写入的作业列表格式（`Name`、`FilePath`、`CopilotId`、`IsRaid`、`IsChecked`、`IsNavNameOverride`、`Index`）沿用[作业接口核对](stage-jobs-sources.md)；开始时只提交勾选的条目，见[运行跟踪来源](stage-run-sources.md)。

## 未验证

- 以上都没有在真实 MAA 上运行核对，包括列表模式失败后整条任务链结束的实际回调顺序。
- CopilotViewModel.cs 和 TaskQueueViewModel.cs 的「没有某个设置」是按文件内容检索得出的；行号以 16 已核对的部分为准。
