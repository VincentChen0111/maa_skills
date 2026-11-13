# MAA 版本跟踪的来源

工单 [25](issues/25-maa-version-verification.md)，2026-11-13 核对。依赖条目在 [maa-dependencies.json](maa-dependencies.json)，随包核实记录 [verified-versions.json](../skills/maa-core/references/verified-versions.json) 由它生成，工具是 `scripts/maa-version-check.ts`。MAA 是 AGPL-3.0：本仓库只存文件位置和 Git blob 指纹，不存、不打包 MAA 代码；核对时只用 `raw.githubusercontent.com` 的只读请求把文件内容送进 `git hash-object --stdin` 和 `diff`，没有写进仓库或保留副本。

## 固定版本

| 版本 | 提交（经 GitHub 公开接口 `commits/<标签>` 只读解析） |
| --- | --- |
| v6.19.0 | `d274123cfc41c578bb820d2dd33390e16765ad05` |
| v6.21.4 | `52d0b2acaca116585b02e1e6a9da303460f81a24` |
| v6.22.0 | `901e01c600f4895ac4e7e48a9b471fc9f52af301` |
| 开发分支 dev-v2（2026-11-13 当时） | `201cbb73e7505884f61027b06294ecf049c670c7` |

2026-11-13 只读查询 `releases?per_page=15`：最新正式版是 v6.22.0（2026-11-09 发布），之前有 v6.22.0-beta.1/2/4 三个 beta；beta 的 `prerelease` 标记为 true，标签带 `-beta.N`。

## 指纹怎么算、条目怎么来

- 指纹是文件在该提交上的 Git blob SHA（`git hash-object` 的输出）。整个文件有任何改动都算变化：宁可多开 issue，也不错误认证。
- 用这个方法算出的值与已有来源记录逐一一致：[doctor 来源](doctor-sources.md)的 16 个 blob、[专精来源](training-sources.md)的 `OperProgressProcessTask.cpp`、`InfrastTrainingTask.cpp`、`tasks.json`，[账号来源](account-sources.md)的 `JsonDataKey.cs`、`PathsHelper.cs`。
- 条目只登记已交付工单的来源记录里在固定提交上核对过的事实：05（[daily 验证](daily-verification.md)）、07（[setup 来源](setup-sources.md)）、10（[doctor 来源](doctor-sources.md)）、11（[账号来源](account-sources.md)）、15（[作业来源](stage-jobs-sources.md)）、24（[专精来源](training-sources.md)），以及本票核对的任务类型集合。起点 skill 在 v6.21.4 上的实测经验不算本仓库已核，没有登记。
- 每条的 `sourceVerified` 是这条核对过的版本。来源记录写的是 v6.21.4 的条目，在 v6.22.0 上所有文件的 blob 都没变的，按自动核对的规则同样算 v6.22.0 已核。专精（24）是在 v6.22.0 上核对的，其中 `OperProgressProcessTask.cpp`、`OperProgressTaskUserControlModel.cs`、`tasks.json` 在 v6.21.4 上不同，所以 `mastery-training` 只有 v6.22.0。随包记录取全部条目的交集，因此目前「源码已核」只有 v6.22.0，「实机已核」为空。

## 在 v6.22.0 上重新核对的条目

v6.21.4 到 v6.22.0 之间，登记文件里有 8 个 blob 变了。属于 v6.21.4 条目的 4 个文件，本票在两个版本上逐段对比了变化位置，确认条目依赖的部分没有变，所以条目的指纹换成 v6.22.0 的 blob，`sourceVerified` 为 v6.21.4 和 v6.22.0：

| 文件 | 变化位置 | 条目依赖的部分 |
| --- | --- | --- |
| `src/MaaWpfGui/Configuration/Factory/ConfigFactory.cs` | 第 64 行序列化选项的转换器列表去掉了两个（`FightTaskStageResetModeConverter`、`FightTaskStageResetModeInvalidToIgnoreConverter`），没有新增；本项目不读写 `StageResetMode` | 同一行的 `DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull` 在 v6.22.0 上仍在（`config-save-null-omission`） |
| `src/MaaWpfGui/Main/AsstProxy.cs` | GPU OCR 的后端选择、作战日报、商店访问失败的界面日志、肉鸽放弃探索的日志、剿灭入口提示 | 启动后自动运行的跳过逻辑（v6.21.4 第 745–770 行一段）和 `TaskType` 枚举都在未变的范围内（`startup-auto-run-skip`、`task-type-set`） |
| `src/MaaWpfGui/Main/Bootstrapper.cs` | 新增两个 DLL 名、作战日报初始化 | `--skip-startup-auto-run` 的常量和解析未变（`startup-auto-run-skip`） |
| `src/MaaWpfGui/ViewModels/UI/TaskQueueViewModel.cs` | 删一行 using、关卡提示写法、作战日报窗口、「从此处开始」改为截取队列、任务状态函数改名 | `CheckTimers`、`HandleTimerLogic`、`HandleConfigChange` 和 `HandleScheduledStart` 所在的第 1080–1230 行在未变的范围内（`timer-schedule`） |

其余 4 个变化的文件（`integration.md`、`OperProgressProcessTask.cpp`、`OperProgressTaskUserControlModel.cs`、`tasks.json`）只影响 v6.21.4 是否已核，不改 v6.22.0 的结论；`integration.md` 目前只有 27 的待登记位置用到。

[daily 验证](daily-verification.md)里 `Bootstrapper.cs` 的链接少了 `Main/` 这一级目录，在两个版本上都返回 404；固定提交上它实际在 `src/MaaWpfGui/Main/Bootstrapper.cs`。条目用实际路径；05 的历史记录没有改。

## 任务类型集合（工单写「核实后采用」）

在固定源码上列出：`BaseTask.cs` 的 `JsonDerivedType` 声明 18 个 `$type`（StartUpTask、CloseDownTask、FightTask、OperProgressTask、AwardTask、MallTask、InfrastTask、RecruitTask、RoguelikeTask、CopilotTask、SSSCopilotTask、SingleStepTask、DepotTask、OperBoxTask、UserDataUpdateTask、DepotMaintainTask、SwitchThemeTask、CustomTask），`AsstProxy.cs` 的 `TaskType` 枚举 20 个值（StartUp、CloseDown、Fight、OperProgress、Recruit、Infrast、Mall、Award、Roguelike、RecruitCalc、Copilot、Depot、OperBox、Gacha、Reclamation、UserDataUpdate、DepotMaintain、SwitchTheme、MiniGame、Custom）。登记在条目 `task-type-set` 的 `facts` 里，指纹是这两个文件和 `TolerantEnumConverter.cs` 的 blob。

v6.21.4、v6.22.0 和当时的开发分支三处列表完全相同。v6.19.0 不同：多一个 `ReclamationTask` 的 `$type` 声明，枚举多一个 `VideoRec`（另有一行被注释掉的 `VideoRecognition` 声明）。所以「任务类型集合从 v6.19.0 到当前开发分支没有变化」这一说法核对后不成立，没有采用；能确认的是 v6.21.4 到 2026-11-13 的开发分支没有变化。写入器认识的 10 种任务（`maa-config.ts` 的 `knownTaskType`）都在这三个版本的集合里，`tests/maa-version-check.test.ts` 逐项核对写入器认识的每种任务在条目里有对应的 `TaskType` 和 `$type`。

## 待登记的位置

未交付工单的 MAA 依赖记在注册表的 `pending` 里，各自交付时改为正式条目（`tests/maa-version-check.test.ts` 在工单标为已完成而 `pending` 里还有它时失败）：

- 27：`FightTask.cs` 的碎石和临期药字段及 `OnDeserialized` 对 `UseStone` 的重置、`FightTaskUserControlModel.cs` 的换算、MaaCore `FightTask.cpp` 对 `medicine_expire_days`/`stone` 的处理和 9999 上限、`MedicineCounterTaskPlugin.cpp`、`FightTaskUserControl.xaml` 的天数范围、集成文档。
- 16：回调协议里 `StageDrops` 的关卡字段和 `UseMedicine` 的 `details.count`、中文界面文案 `zh-cn.xaml` 里的任务出错/完成任务等文案键和 `gui.log` 写法、`asst.bak.log` 轮换、自动战斗的用药开关。v6.22.0 的 `AsstProxy.cs` 新增了一处：商店访问好友失败时任务链仍报完成，界面另写一行「任务出错」加访问好友的文案；16 实现 `gui.log` 判断时要核对这一点。
- 22：排班协议的 `period` 和计划重叠时的选择、干员名表 `resource/battle_data.json`。
- 之后生成计划的工单（22 的排班、23 的应用）用 `maa-version.ts` 的 `readVersionStamp`/`compareVersionStamp` 写入和比较版本，与配置写入、作业准备、专精排程相同。

## 发布与 Action 相关的外部事实

- GitHub 发布接口的 `prerelease` 字段区分 beta；`commits/<标签>` 配合 `Accept: application/vnd.github.sha` 只返回提交号。
- 用仓库的 `GITHUB_TOKEN` 触发的事件不会再创建新的工作流运行（`workflow_dispatch`、`repository_dispatch` 除外）。2026-11-13 只读访问 [GitHub 文档 Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)（HTTP 200）核对了这句。所以自动 PR 上不会自动跑离线检查，要由维护者手动触发或推一次提交。仓库设置里还需要允许 Actions 创建 PR。这两点没有在真实仓库上验证。
