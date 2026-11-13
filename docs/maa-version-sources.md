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

其余 4 个变化的文件（`integration.md`、`OperProgressProcessTask.cpp`、`OperProgressTaskUserControlModel.cs`、`tasks.json`）只影响 v6.21.4 是否已核，不改 v6.22.0 的结论；`integration.md` 当时只有 27 的待登记位置用到（2026-11-14 起 `copilot-jobs` 也用到，见「合并 10 最终版时登记的条目」）。

[daily 验证](daily-verification.md)里 `Bootstrapper.cs` 的链接少了 `Main/` 这一级目录，在两个版本上都返回 404；固定提交上它实际在 `src/MaaWpfGui/Main/Bootstrapper.cs`。条目用实际路径；05 的历史记录没有改。

## 任务类型集合（工单写「核实后采用」）

在固定源码上列出：`BaseTask.cs` 的 `JsonDerivedType` 声明 18 个 `$type`（StartUpTask、CloseDownTask、FightTask、OperProgressTask、AwardTask、MallTask、InfrastTask、RecruitTask、RoguelikeTask、CopilotTask、SSSCopilotTask、SingleStepTask、DepotTask、OperBoxTask、UserDataUpdateTask、DepotMaintainTask、SwitchThemeTask、CustomTask），`AsstProxy.cs` 的 `TaskType` 枚举 20 个值（StartUp、CloseDown、Fight、OperProgress、Recruit、Infrast、Mall、Award、Roguelike、RecruitCalc、Copilot、Depot、OperBox、Gacha、Reclamation、UserDataUpdate、DepotMaintain、SwitchTheme、MiniGame、Custom）。登记在条目 `task-type-set` 的 `facts` 里，指纹是这两个文件和 `TolerantEnumConverter.cs` 的 blob。

v6.21.4、v6.22.0 和当时的开发分支三处列表完全相同。v6.19.0 不同：多一个 `ReclamationTask` 的 `$type` 声明，枚举多一个 `VideoRec`（另有一行被注释掉的 `VideoRecognition` 声明）。所以「任务类型集合从 v6.19.0 到当前开发分支没有变化」这一说法核对后不成立，没有采用；能确认的是 v6.21.4 到 2026-11-13 的开发分支没有变化。写入器认识的 10 种任务（`maa-config.ts` 的 `knownTaskType`）都在这三个版本的集合里，`tests/maa-version-check.test.ts` 逐项核对写入器认识的每种任务在条目里有对应的 `TaskType` 和 `$type`。

## 待登记的位置

未交付工单的 MAA 依赖记在注册表的 `pending` 里，各自交付时改为正式条目（`tests/maa-version-check.test.ts` 在工单标为已完成而 `pending` 里还有它时失败）：

- 27：`FightTask.cs` 的碎石和临期药字段及 `OnDeserialized` 对 `UseStone` 的重置、`FightTaskUserControlModel.cs` 的换算、MaaCore `FightTask.cpp` 对 `medicine_expire_days`/`stone` 的处理和 9999 上限、`MedicineCounterTaskPlugin.cpp`、`FightTaskUserControl.xaml` 的天数范围、集成文档。
- 之后生成计划的工单（22 的排班、23 的应用）用 `maa-version.ts` 的 `readVersionStamp`/`compareVersionStamp` 写入和比较版本，与配置写入、作业准备、专精排程相同。22、23 交付后的实际情况见[验证记录](maa-version-verification.md)「合并 22、23」；22 的报告写版本、23 应用时报告差异在 2026-11-14 补上，见同一记录「补上基建报告的版本标记」。

16 原来也在这里（回调协议里 `StageDrops` 和 `UseMedicine` 的字段、`zh-cn.xaml` 的文案键和 `gui.log` 写法、`asst.bak.log` 轮换、自动战斗的用药开关），2026-11-14 合并 10 最终版时 16 已交付，改为下一节的条目。22 原来也在这里（排班协议的 `period` 和计划重叠时的选择、干员名表 `resource/battle_data.json`），2026-11-14 合并 22、23 时 22 已交付，改为「合并 22、23 时登记的条目」一节的条目。现在待登记只剩 27。

## 合并 10 最终版时登记的条目（2026-11-14）

10 的最终版带来了已交付的 16、17、29。它们的来源记录在 v6.21.4（`52d0b2a`）上核对，引用了 10 个还没登记的 MAA 文件，16 也还在待登记里。这次登记三处，事实核对方法与上文相同：经 `raw.githubusercontent.com` 只读取文件在 v6.21.4 和 v6.22.0 两个提交上的内容，算 Git blob；v6.21.4 的 blob 与 16 来源记录的表一致，29 记录的几个 SHA-256 也一致。

- `stage-run-evidence`（16）：16 来源记录表里的 21 个文件。
- `copilot-list-stops-on-failure`（17）：17 来源记录引用的 5 个文件，加上「`Copilot@EndOfAction` 之后只接三星两种结果」所在的 `tasks.json`。
- `copilot-jobs`（15）加上 29：29 引用的 `AsstBattleDef.h`、`TileDef.hpp`、`TilePack.h`、`TilePack.cpp`、`overview.json`、`zh-cn.xaml` 和集成文档 `integration.md`（集成文档同时仍在 27 的待登记里）。29 引用的其他文件已在这一条里，两个版本上 blob 相同。

两个版本之间 blob 变了的文件逐段对比了变化位置，三条依赖的部分都没有变，所以三条的 `sourceVerified` 都是 v6.21.4 和 v6.22.0，指纹取 v6.22.0 的 blob。生成的核实记录不变（仍是源码已核 v6.22.0，记录版本 2）。

| 文件 | 变化位置 | 条目依赖的部分 |
| --- | --- | --- |
| `zh-cn.xaml` | 第 417 行后加一行，第 1268–1304、1743、2005、2121、2471 行附近的文案 | 16 引用的第 700、709、973、975、1015、1048、1996 行和 29 引用的第 1018–1021 行都不在变化范围里，键和文字相同，只是行号后移 |
| `AsstProxy.cs` | 见上文；与 16 有关的是商店访问好友失败时另写一行「任务出错: 」加访问好友的文案 | 16 引用的第 1436–1464、1484、1537、1672–1675、2162–2165 行都不在变化范围里。新增的那一行只在商店任务链里写；16 判断 `gui.log` 错误时只看本批次结束前、下一条任务链开始之前的行，商店任务链要另起一条，它在批次中途出现会按被接管处理；万一被算进来也只会把结果记成未知，不会重放 |
| `TaskQueueViewModel.cs` | 见上文 | 16 引用的第 954、1168–1193、1234–1248、1604–1630 行不在变化范围里；17 依赖的「定时到点后经 `LinkStart` 只运行当前配置的任务队列」在 v6.22.0 仍是 `LinkStartWithTasks(ConfigFactory.CurrentConfig.TaskQueue.ToArray())`，任务类型表 `TaskTypeList` 两个版本相同，没有自动战斗 |
| `Bootstrapper.cs` | 见上文 | 16 引用的第 77–81、604–612、625 行（日志路径、`gui.log` 挪走的 4 MiB 门槛、行格式）不在变化范围里 |
| `ConfigFactory.cs` | 见上文 | 16 引用的第 43、52、56、310–312、324–336 行（`config/gui.new.json`、200 毫秒去抖写盘）不在变化范围里 |
| `tasks.json` | 见上文 | 解析两个版本：`Copilot@EndOfAction` 的下一步仍只有 `Copilot@StageDrops-Stars-3` 和 `Copilot@StageDrops-Stars-Adverse`，`Copilot@FightMissionFailed` 仍接到 `Copilot@EndOfAction`，`Copilot@WaitUntilEndOfAction` 仍是 50 次后转 `Copilot@EndOfAction` |
| `TilePack.h`、`TilePack.cpp` | 成员 `has_multi_stages` 改名为 `has_multi_phases`，对应日志文字和一处日志写法 | 29 引用的 `TilePack.h` 第 70–78 行（返回数据顺序里的第一个命中）和 `TilePack.cpp` 第 31–34 行（levelId 取自地图数据）不在变化范围里 |
| `integration.md` | 第 1750 行一处 | 29 引用的第 1272–1289 行（`support_unit_usage`）不在变化范围里 |
| `overview.json` | 地图数据从 4334 条增加到 4358 条 | 两个版本里 levelId 和 stageId 全部小写，29「levelId 按小写建索引、区分大小写比较」的依据不变 |

## 合并 22、23 时登记的条目（2026-11-14）

main 带来了已交付的 22（基建建议与排班生成）和 23（执行已批准的基建排班）。它们的 MAA 事实记在 [22 的验证记录](base-plan-verification.md)和 [23 的验证记录](base-apply-verification.md)的「MAA 事实」表里，都在 v6.21.4（`52d0b2a`）上核对，链接到固定提交。这两页不是 `*-sources.md`，注册表覆盖测试当时不扫描它们（2026-11-14 起扫描 `docs/` 下全部页面，见[验证记录](maa-version-verification.md)「补上基建报告的版本标记」），所以这次逐行对照两张表登记；另用覆盖测试的同一个匹配式扫了 `docs/` 下全部页面，除上文说明过的 `Bootstrapper.cs` 旧链接外，没有既未登记、也不在待登记里的位置。核对方法与上文相同：经 `raw.githubusercontent.com` 只读取 17 个文件在 v6.21.4 和 v6.22.0 两个提交上的内容，算 Git blob；两张表里 16 个文件的 v6.21.4 blob 逐一一致。

- `base-plan-schedule`（22）：22 表里的 8 个文件，排班协议 `base-scheduling-schema.md`、MaaCore 的 `InfrastTask.cpp`、`InfrastProductionTask.cpp`、`InfrastAbstractTask.cpp`、`BattleDataConfig.cpp`、名表 `resource/battle_data.json`、图形界面的 `CustomInfrastConfig.cs` 和 `InfrastTaskUserControlModel.cs`。待登记里 22 的两个位置都在这一条里。skill 是 maa-core（排班工具）和 maa-account（基建报告）。
- `base-plan-apply`（23）：23 表里的 10 个文件，`InfrastTask.cs`、`JsonPredictAttribute.cs`、`JsonPredictSerializationModifier.cs`、`ConfigFactory.cs`、`TolerantEnumConverter.cs`、`InfrastTaskUserControlModel.cs`、`AsstInfrastTask.cs`、`InfrastRoomType.cs`、`AsstInfrastDef.h`、`InfrastTask.cpp`，再加 23 没有引用的 `src/MaaWpfGui/Configuration/Converter/TolerantEnumConverterFactory.cs`。23 读周计划 `WeeklySchedule`（`Dictionary<DayOfWeek, bool>`）时名字和数字的键都认，键在配置里怎么写由这个转换器决定：v6.21.4 上它第 29 行对所有枚举类型生效（`typeToConvert.IsEnum`），`TolerantEnumConverter.cs` 第 80–83 行把字典键写成枚举名字，第 74–77 行和第 85–93 行读键时经 `Enum.TryParse`（不分大小写，名字或数字）解析，只接受定义过的值。所以 23 记为推断的「按 `DayOfWeek` 名字保存」在源码上成立；仍没有拿真实 MAA 写出的配置核对。skill 是 maa-core 和 maa-daily。
- `timer-schedule` 的工单加上 23：23 的未核实项 `maa-timers` 只比较 `IsEnabled` 为 true 的每日定时，依据就是这一条；这一条的文件没有变。

17 个文件里只有 2 个在两个版本之间 blob 变了，逐段对比了变化位置，两条依赖的部分都没有变，所以两条的 `sourceVerified` 都是 v6.21.4 和 v6.22.0，指纹取 v6.22.0 的 blob。其余 15 个文件两个版本的 blob 相同。

| 文件 | 变化位置 | 条目依赖的部分 |
| --- | --- | --- |
| `ConfigFactory.cs` | 第 64 行，见上文 | 23 引用的第 43 行（`config/gui.new.json`）不在变化范围里；第 64 行在 v6.22.0 上仍有 `TolerantEnumConverterFactory`、`DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull` 和 `JsonPredictSerializationModifier.Modify`，去掉的两个转换器只处理自动战斗的 `StageResetMode`，23 不读写它 |
| `resource/battle_data.json` | `chars` 从 1405 条增加到 1439 条（TANK 1 条，TRAP 33 条），`ranges` 有变化 | 解析两个版本：原有的 1405 条一条没删，`name`、`name_en`、`name_jp`、`name_kr`、`name_tw` 和 `profession` 都没变，字段集合相同，职业取值集合相同。22 运行时读用户本机 MAA 目录里的这份文件，按无人机以外的职业取 `chars[*].name`，读法不变，新版本只多了一名干员的名字；`ranges` 不用 |

经 25 的生成器（`node scripts/maa-version-check.ts record --write`）重新生成随包核实记录，内容不变（仍是源码已核 v6.22.0，记录版本 2）。注册表现为 19 条条目、87 个文件。

## 发布与 Action 相关的外部事实

- GitHub 发布接口的 `prerelease` 字段区分 beta；`commits/<标签>` 配合 `Accept: application/vnd.github.sha` 只返回提交号。
- 用仓库的 `GITHUB_TOKEN` 触发的事件不会再创建新的工作流运行（`workflow_dispatch`、`repository_dispatch` 除外）。2026-11-13 只读访问 [GitHub 文档 Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)（HTTP 200）核对了这句。所以自动 PR 上不会自动跑离线检查，要由维护者手动触发或推一次提交。仓库设置里还需要允许 Actions 创建 PR。这两点没有在真实仓库上验证。
