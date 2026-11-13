# 23 执行已批准的基建排班：来源核对与验证记录

核对日期：2026-11-13；第一轮独立审查后的修复 2026-11-14（见文末「第一轮修复」）。工单见 [23](issues/23-apply-approved-base-plan.md)，接口见 [基建排班应用](../skills/maa-daily/references/base-apply.md)，排班生成与检查沿用 [22 的验证记录](base-plan-verification.md)。本页只记事实来源、实现时定下的做法、实际运行过的检查和未验证项；MAA 源码只读到被忽略的临时目录，下载内容的 Git blob SHA 和下表一致，没有复制或打包 MAA 代码。

## MAA 事实（固定 v6.21.4，提交 `52d0b2acaca116585b02e1e6a9da303460f81a24`）

指纹是该文件在这个提交里的 Git blob SHA。这一节的条目要登记进 [25](issues/25-maa-version-verification.md) 的依赖清单；2026-11-14 合并时已由 25 登记为条目 `base-plan-apply`（`timer-schedule` 的工单加上 23），见 [25 的验证记录](maa-version-verification.md)「合并 22、23」。

| 采用的事实 | 文件与行 | blob |
| --- | --- | --- |
| 图形界面配置里基建任务的字段：`Mode`（`InfrastMode`，默认 `Normal`）、`ContinueTraining`、`UseWeeklySchedule`/`WeeklySchedule`、`CustomFileType`（默认用户自定义）、`Filename`（自定义文件路径）、`PlanSelect`（默认 -1）、`RoomList` | [InfrastTask.cs 第 39、84、120–141 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/MaaTask/InfrastTask.cs#L39-L144) | `e967ea0c782a85bc3cb234eea6d2421e0b99783e` |
| 读配置时 `Mode` 为自定义且 `Filename` 存在就解析排班文件；解析失败把 `PlanSelect` 设为 0；`PlanSelect` 小于 -1 改成 -1，超出计划数改成 0 | 同一文件第 146–194 行 | 同上 |
| `RoomList` 每项是 `Room` 加 `IsEnabled`；`IsEnabled` 只在为 false 时写出（默认 true） | 同一文件第 196 行；[JsonPredictAttribute.cs 第 14–54 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Utilities/JsonPredictAttribute.cs#L14-L54) | 同上；`a84555aad5488f31654630fa2173589ed130a989` |
| 条件序列化的实现：按条件属性的值和比较值是否相等决定写不写 | [JsonPredictSerializationModifier.cs 第 62–131 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Converter/JsonPredictSerializationModifier.cs#L62-L131) | `83d5c145a522077af161480ff474d5954f7fae4f` |
| 配置文件是 `config/gui.new.json`；只省略 null，非 null 的默认值照写；枚举经容错转换器 | [ConfigFactory.cs 第 43 行、第 64 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Factory/ConfigFactory.cs#L43-L64) | `7f9a85ca85a2faadfa051655c30c8620bf26f3d9` |
| 枚举写成名字（`Custom`），读时名字和数字都接受 | [TolerantEnumConverter.cs 第 38–71 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Converter/TolerantEnumConverter.cs#L38-L71) | `eda9eb0a80b3407bb5be7ac3020f118b22561194` |
| `InfrastMode`：`Normal`=0、`Custom`=10000、`Rotation`=20000 | [InfrastTaskUserControlModel.cs 第 806–822 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UserControl/TaskQueue/InfrastTaskUserControlModel.cs#L806-L822) | `f8aa23bbb86ec3aa7379e327c33589a6bb1820ed` |
| 用户自定义文件的取值是 `user_defined`；选了内置预设时界面把 `Filename` 改成预设文件、文件框只读；用户选自己的文件时界面把类型改回 `user_defined` | 同一文件第 366 行、第 407–422 行、第 456–467 行 | 同上 |
| 设置 `Filename` 时，文件里有计划带时间段就把 `PlanSelect` 设为 -1，否则 0；`PlanSelect` 的含义：-1 按时间轮换，0 到 n 按序号轮换 | 同一文件第 474–511 行 | 同上 |
| `PlanSelect` 不是 -1 时，每次运行后序号加一（按序号轮换） | 同一文件第 651–669 行 | 同上 |
| 运行时序列化：周计划里今天不运行就跳过整个任务；非常规模式按 `RoomList` 原顺序、只取勾选的房间作为设施列表；`Filename` 原样传；`PlanSelect` 为 -1 时按当前时间取第一个时间段包含现在的计划，找不到用第 0 个并记错误 | 同一文件第 733–800 行 | 同上 |
| 传给 MaaCore 的参数：`facility`、`mode`（数字）；只有自定义模式才传 `filename` 和 `plan_index` | [AsstInfrastTask.cs 第 119–153 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Models/AsstTasks/AsstInfrastTask.cs#L119-L153) | `c5a76fae277d4ac609ec187f53230d273db622ee` |
| 房间名：`Mfg`、`Trade`、`Control`、`Power`、`Reception`、`Office`、`Recycle`、`Dorm`、`Processing`、`Training`、`AssistantChange` | [InfrastRoomType.cs 第 16–72 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Constants/Enums/InfrastRoomType.cs#L16-L72) | `322440fdf25e3462fc743f7b0a8a70e26c8dc089` |
| MaaCore 只执行设施列表里的设施：非常规模式按列表顺序逐个执行，不在列表里的设施不执行；列表里有不认识的名字时整个任务不接受 | [AsstInfrastDef.h 第 42–100 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Common/AsstInfrastDef.h#L42-L100)；[InfrastTask.cpp 第 108–206 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Interface/InfrastTask.cpp#L108-L206) | `ac89f511e3cc46222c456cfaf3ede9ff5b39e00a`；`3f4fd2c56214df307f230a627a7f2f0ca3171643` |
| 自定义模式读 `filename`、`plan_index`（缺省 0）解析排班文件 | InfrastTask.cpp 第 273–292 行 | `3f4fd2c56214df307f230a627a7f2f0ca3171643` |
| 排班文件的设施键和房间的对应：`control`→Control、`manufacture`→Mfg、`trading`→Trade、`power`→Power、`meeting`→Reception、`hire`→Office、`processing`→Processing、`dormitory`→Dorm、`training`→Training、`recycle`→Recycle | InfrastTask.cpp 第 441–474 行（键）；AsstInfrastDef.h 第 45–80 行（房间名到执行步骤） | 同上 |

由此得出的结论（核实后采用）：

- 写进 MAA 的自定义基建设置是所选基建任务的四个字段：`Mode` 改成 `Custom`（配置里原来存成数字时写 10000，类型不变）、`Filename` 改成排班副本的绝对路径、`PlanSelect` 改成 -1、`CustomFileType` 改成 `user_defined`（字段存在时；否则界面可能显示内置预设）。排班的每个计划都带 `period`（22 的规定），所以用 -1：由图形界面在每次运行时按当时时间选计划。`period` 只由图形界面处理，MaaCore 收到的是选好的 `plan_index`；读回只核对写进去的值，不声称 MAA 已经按时间段切换。
- 是否执行某个设施由 `RoomList` 里勾选的房间决定，排班文件管不了。排班给某个设施安排了人而这个房间没勾选，MAA 不会去换这个设施，22 的时间线和心情结论就不成立，所以拒绝；房间列表也决定其他自动操作，不替用户勾选。
- `product` 不写（22 的导出也不写），生产线不变；检查里已有的产物必须等于布局的当前产物，沿用 22。

## 实现时定下的做法（设计默认值，2026-11-13，不是维护者原话）

规格「默认值及其来源」里 23 开头的几行是同一批内容，这里写理由和细节。

- **排班副本**：应用的字节来自报告里保存的排班（报告按内容哈希保存，不能改），先确认它的 SHA-256 等于批准的 SHA-256，再复制成私有目录里的 `base-applied/<SHA-256>.json`，MAA 的 `Filename` 指向它。副本由唯一写入器在确认 MAA 已退出后安装（先写临时文件再改名，用 22 的 `writePlanFile`），关停前、写入前和读回时都核对字节；副本所在的目录经过链接落到私有目录外就拒绝。理由：account 可以用同一路径重新生成排班文件，直接指向它会让 MAA 读到没批准过的内容；字节逐字相同，排班文件里本工具不认识的字段也就原样保留。
- **account 的排班文件**：还在且内容变了（`base-plan-changed`）要重新出报告并批准；路径落在私有目录外（`plan-path-outside-private`）拒绝；文件不在了不阻止应用（应用的是报告证明过的字节）。
- **数据新鲜度**：沿用 22 的三态和判定条件（`planFreshness`、`snapshotFingerprint`，没有第二套指纹）。快照陈旧（`base-snapshot-changed`）要重新出报告并批准；快照读不到、固定表读不到时不写入；技能表或 MAA 名表陈旧时，按当前数据重跑全部检查，由结果决定。检查每次应用都重跑（`baseApplyRecheck`），不看报告里的结论。
- **未核实的项**：检查的 `unverified` 加上 `maa-timers`（这个配置里 `IsEnabled` 为 true 的每日定时，按 `CustomConfig` 选配置，和排班的 `runs` 比较）。用户的决定必须覆盖当时全部项；记下当时的清单和原话，随授权写进 `daily-pending.jsonl`，结果行（`daily-runs.jsonl`）里也有。
- **周计划（2026-11-14 改）**：所选基建任务 `UseWeeklySchedule` 为 true、`WeeklySchedule` 里有几天是 false 时，列为未核实项 `maa-weekly-schedule`，证据写出是哪几天（`DayOfWeek` 名字或数字都认）。按上表「运行时序列化」一行，那天整个基建任务跳过，前一天最后一班一直上到下次运行（两班制时约 36 小时），第 4 项的心情结论按每天运行计算，不一定成立。原来只记成提示 `weekly-schedule-skips-days`，用户不表态也会写入。
- **只改不同的值**；四个字段都已经是目标值、副本也和批准的一致时返回 `unchanged`，不碰 MAA。
- **副本的出路（2026-11-14）**：副本被改过（常见是用户在 MAA 里手调过）时，`check` 的 `configuration.copy` 为 `changed`，拒绝原因 `base-plan-copy-changed`；不覆盖、不删除、不移动，重新批准同一份排班也还是同一个路径，所以由用户选：继续用改过的就不再应用，想换回批准的就自己移走或删除那个文件。副本不在而四个字段已经指向它时，`check` 给出 `ready`（`configuration.copy` 为 `absent`、`changes` 为空），`apply` 走只装副本的事务：统一写入器照常加锁、关停 MAA、备份、在 MAA 关闭时装回副本、读回，但不写 `gui.new.json`；结果里 `changedKeys` 为空、`copyInstalled` 为 true。写入器只在副本不在时接受不带字段改动的基建事务，否则拒绝 `plan-already-applied`。原来这时 `check` 说可以、`apply` 却总是拒绝 `base-plan-copy-missing`，MAA 一直指向不存在的文件；那个原因已经不再出现。
- **只给提示、不阻止**：基建任务没勾选（`infrast-task-disabled`）。
- **入口**：`maa-config.ts write` 拒绝带 `basePlan` 的请求；写入器在事务里再解析一次批准、核对字节，伪造的授权会被拒绝。doctor 的自动核对只认 05 的普通待执行记录，基建这类带附加文件的事务结果未知时只报告证据，和 24、15 一样。

## 对共享代码的改动

- `skills/maa-core/scripts/maa-config.ts`（只增加）：授权里多一个 `basePlan`；`prepare` 用 `buildBaseChanges` 推导出唯一允许的改动并要求和请求逐项相同，把所选任务对象加进绑定目标；`writeConfiguration` 在检查阶段解析批准和字节，像训练资产一样在关停后安装副本、写入前和读回时核对，待执行记录多 `baseManifest`，结果行多 `basePlan`（SHA-256 和用户的决定）；命令行的 `write` 拒绝带 `basePlan` 的请求。其他授权的行为不变。
- `skills/maa-core/scripts/base-report.ts`：把读取当前输入和重跑检查拆成两个内部函数，`baseReportFreshness` 改用它们，另导出 `baseApplyRecheck` 和 `reportPlanText`。重跑检查时第 15 项现在审查和出报告时相同的文字（方案文字、假设、总结、假设的目标），原来新鲜度重跑时传的是空列表，可能把出报告时不通过的第 15 项算成通过。
- 新增 `skills/maa-core/scripts/base-config.ts`（改动推导、副本）和 `skills/maa-core/scripts/base-apply.ts`（`check`、`apply` 命令）。
- 2026-11-14 `maa-config.ts` 又改了四处，只对带 `basePlan` 的请求生效：改动列表可以为空（推导出的也为空、副本不在时）；这时不写 `gui.new.json`；副本已在时拒绝空事务（`plan-already-applied`）；空改动列表不再被当成「只改连接」（原来 `every` 对空列表为真，会记成 maa-setup）。
- 2026-11-14 `eval/network-fixture.mjs`：评测网络夹具另外替代 22 的 `base-plan.ts generate`、`check`、`candidates` 和 `base-report.ts draft`、`freshness`（不给 `tablesFile` 时读固定公开表的入口），保留 13、14、20 的入口。原来 22 的 `tests/base-report-scenarios.test.ts` 在评测夹具里起草报告时读的是公开 GitHub 上的固定表。规格「成本与缺口评测网络夹具」两行和 [评测说明](evaluation.md) 已补充。
- 2026-11-14 工单 25 补上版本差异（[25 的验证记录](maa-version-verification.md)「补上基建报告的版本标记」）：22 的报告保存时写下 MAA 版本和核实记录版本（`versions`），`check` 和 `apply` 的结果多一个 `versions`，比较批准的报告里记下的版本和现在读到的，状态与作业准备、专精相同（same、changed、unknown、unrecorded），引用找不到报告时为 null；它不是拒绝原因。`check` 经 MAA.exe 元数据读取（可替换的 `versionReader`），`apply` 经 MAA 进程边界的 `version()` 读取，命令行的 `apply` 现在把 `version()` 传给进程边界，和作业准备、配置写入的命令行一致。`maa-config.ts` 的 `versionStampOf` 接受没设的 MAA 目录（版本记为 null）。测试：A「check and apply report the version difference」。

## 验收条件与证据

测试文件：A = `tests/base-apply.test.ts`，E = `tests/base-apply-scenarios.test.ts`；引号里是测试名的开头。

| 验收条件 | 证据 |
| --- | --- |
| 1 识别批准的排班和条目，核对一致；未批准和后来修改的内容不执行 | A「nothing unapproved runs」（未批准、未批准的新版本、批准后被改的报告、非基建引用）；A「an invalid plan, a failing gate」末段（排班文件批准后被改）；A「the writer binds a base grant」（批准记录的范围和报告不一致：check 和写入器都拒绝）；A「the writer proves the approved hash again」（报告版本里排班字节、范围哈希或允许的动作有一处对不上） |
| 2 应用前运行共享校验，报告错误和未持有警告，不写无效排班 | A「an invalid plan, a failing gate」（`check.errors` 有名表错误，什么都没写）；同一测试里快照少了排班用到的干员时，检查结果的 `warnings` 有 `operator-unowned`（沿用 22） |
| 3 只走 05 的通道；锁、关停、备份、定时窗口、最小改动、读回；不改生产线 | A「report → approval → check → safe write → read-back」（只变四个字段，其余配置逐项相同，备份等于原字节，锁释放，没有 `product`）；A「the base grant is only reachable through base-apply」；A「the writer binds a base grant」（完整推导改动加错哈希、另带药品授权、来源为当次请求、未知授权字段都拒绝；对照组用正确哈希能完成）；A「the applied copy has a way back」（只装副本的事务也走锁、关停、备份、读回，配置文件逐字节不变） |
| 4 daily 只维护配置、待执行和运行记录；不改写报告和快照；未审查标记不变 | A「report → approval」（报告目录和快照字节不变，报告状态仍是 `unreviewed`，检查结果 `review: unreviewed`） |
| 5 失败或结果未知保留证据转核对、不重放；成功说明改了什么和备份 | A「an interrupted write or unknown outcome」（重开失败和关停失败；锁、备份、记录保留，再次应用被拒绝且不碰 MAA）；A「a copy that changes while the writer has MAA closed」（关停后、备份前副本被写：停在 backup 阶段、结果未知、不覆盖；重开后读回前副本被改：结果未知、不声称成功）；A「report → approval」（`changedKeys`、`backup`） |
| 6 不点游戏、不操作设备 | 只经 `MaaProcess` 的 inspect/close/start（A「report → approval」断言调用只有这三种）；skill 文字见 [基建排班应用](../skills/maa-daily/references/base-apply.md) |
| 7 应用时重新计算 15 项验收门；不通过不写；未核实交用户决定并记进运行记录 | A「report → approval」（15 项都有结论）；A「an invalid plan, a failing gate」（第 4 项不通过）；A「the apply-time gate 15 audits the report's own texts again」（方案标题、假设、总结、假设的目标里的「最优」类说法各自使第 15 项不通过）；A「unverified items need the user's explicit decision」；A「a weekly schedule that skips days」（`maa-weekly-schedule` 要用户决定，决定记进运行记录） |
| 8 新鲜度沿用 22 的三态；批准后快照或排班文件变了要重新批准 | A「an invalid plan, a failing gate」（快照陈旧、排班文件被改、名表和固定表陈旧时重跑）；A「inputs that cannot be read now stop the apply」（快照或固定表读不到为未知、报告输入这一版检查不了时拒绝，不用旧结论） |
| 9 路径只指向私有目录里批准哈希的文件；越界拒绝；原子替换；保留不认识的字段 | A「plan paths are confined」（排班目录和副本目录经链接到私有目录外、副本被换）；A「the applied copy has a way back」（副本被改过时按名拒绝、不覆盖；用户移走后只装回批准的副本）；A「report → approval」（副本等于批准字节，保留 `x-unknown-field` 和 `metadata`）；E「daily-base-apply-path-outside」「daily-base-apply-copy-edited」 |
| 10 读回核对写入的自定义设置（字段名核实后采用）；不声称按时间段切换 | 本页「MAA 事实」；A「report → approval」（`readback.periodSelection` 为 `gui-at-each-run-not-observed`） |
| 验证方式：端到端演示和各失败情形，无关配置保持 | A 全部十六个测试，使用真实临时目录和假的 MAA 进程 |
| 评测：新功能的场景 | `eval/maa-daily/base-apply-scenarios.ts` 十个场景（未批准、报告被改、排班无效、结果未知、批准后快照变了、验收门不通过、未核实项用户接受、路径越界；2026-11-14 加副本被改过、周计划有几天不运行）；E 在评测夹具里离线运行已安装的产品脚本并评分。没有改 `scripts/eval-run.ts`、`scripts/evaluation.ts`、`scripts/eval-fixture.ts`、`scripts/eval-daily.ts` |

## 实际运行的检查（本机，2026-11-13）

- `npm run typecheck`：通过。
- `node --test tests/base-apply.test.ts`：9/9 通过。
- `node --test tests/base-apply-scenarios.test.ts`：1/1 通过（八个场景）。
- 改动共享代码后的回归，逐个文件依次运行：`tests/maa-config.test.ts` 59/59、`tests/base-report.test.ts` 7/7、`tests/training-config.test.ts` 3/3、`tests/doctor.test.ts` 74/74、`tests/setup.test.ts` 29/29、`tests/stage-jobs.test.ts` 6/6、`tests/training-integration.test.ts` 2/2 通过。
- 只跑离线入口里的静态部分（tracker 和文档链接、隐私、元数据）：没有错误。
- 完整离线入口 `node scripts/check.ts` 没有在本机运行（协调者在冻结的提交上统一运行）。

## 第一轮修复（2026-11-14）

第一轮独立审查的三项意见（调度者全部接受）和一项相关修复：副本没有出路（P3-1）、周计划只记提示（P3-2）、守卫没有测试（P3-3）；另外 22 的基建报告场景测试实际读了真实网络，`maa-help` 还把基建排班说成后续能力。做法写在上面「实现时定下的做法」和「对共享代码的改动」里 2026-11-14 的条目。

先写失败测试（红）再改（绿），都在本机依次单个文件运行：

- `tests/base-apply.test.ts` 先加 6 个测试。改代码前运行 15 个里 13 个通过、2 个失败：副本被改过时 `configuration.copy` 是 `null` 而不是 `changed`；周计划有几天不运行时状态是 `ready` 而不是 `needs-decision`。其余新测试覆盖的是已有守卫，改代码前就通过，它们是否真能拦住错误由下面的变异检查证明。改完 15/15；之后又加 1 个测试（报告版本的哈希有一处对不上）和两处断言（批准不一致时不读排班、未知授权字段），16/16。
- `tests/base-report-scenarios.test.ts` 的产品调用加上 `tests/fixtures/offline-fetch.mjs`（真实 fetch 一律报错）后，在原来的评测网络夹具下 2 个测试都失败，起草报告返回 `public-data-network-failed`，说明原来读的是真实网络；夹具补上 22 的入口后 2/2 通过，并核对报告记的来源是公开镜像、文件是三张固定表。
- `tests/eval-network.test.ts` 加了 22 的入口启用检查（`base-plan.ts` 的 generate、check、candidates 和 `base-report.ts` 的 draft、freshness 启用；`query`、`read`、`approve` 和 `base-apply.ts check` 不启用）：3/3 通过。
- `tests/base-apply-scenarios.test.ts`：十个场景 1/1 通过。
- 回归：`npm run typecheck` 通过；`tests/maa-config.test.ts` 59/59、`tests/base-report.test.ts` 7/7、`tests/base-plan.test.ts` 15/15、`tests/doctor.test.ts` 74/74、`tests/help-installation.test.ts` 6/6、`tests/metadata.test.ts` 1/1 通过。离线入口的静态部分（tracker 和文档链接、隐私、元数据）没有错误；第一次运行时隐私检查的凭据启发式命中测试里一个叫 `authorization` 的参数名，改名后通过。没有运行 `tests/maa-process.test.ts` 和完整离线入口。

变异检查：从提交 `8e4060b` 用 `git archive` 导出到系统临时目录（之后的提交只改了测试里一个参数名和文档），每次只改一处（或下表写明的几处一起），只运行对应的一个测试文件，跑完还原，全部结束后删除导出目录。34 个变异里 33 个被测试拦住，1 个是等价变异。A = `tests/base-apply.test.ts`，S = `tests/base-report-scenarios.test.ts`，N = `tests/eval-network.test.ts`。

| 编号 | 变异（文件） | 拦住它的测试 |
| --- | --- | --- |
| A1 | 快照读不到时不拒绝（base-apply） | A「inputs that cannot be read now stop the apply」 |
| A2 | 固定表读不到时不拒绝（base-apply） | 同上 |
| A3 | 重新检查跑不了时不拒绝（base-apply） | 同上 |
| A4 | A1、A2、A3 一起删（第一轮审查员的组合） | 同上 |
| B1 | check 不比较批准记录的范围和报告（base-apply） | A「the writer binds a base grant」 |
| B2 | 写入器取副本时不比较批准记录的范围（base-config） | 同上 |
| C1 | 不比较范围的 SHA-256 和授权（base-config） | A「the writer proves the approved hash again」 |
| C2 | 不比较允许动作里的 SHA-256 和授权（base-config） | 同上 |
| C3 | 不比较排班字节的哈希和授权（base-config） | 同上 |
| C4 | C1、C2、C3 一起删 | A「the writer binds a base grant」「the writer proves the approved hash again」 |
| D1 | 「只能带一种授权」的列表去掉 `basePlan`（maa-config） | 没有拦住：等价变异。带 `basePlan` 的授权在同一个检查阶段还要过基建自己的字段名单（maa-config.ts `prepare` 里 `['source', 'reference', 'basePlan']`），另带药品、作业授权都被它拒绝，另带训练授权先被训练的字段名单拒绝，结果同样是检查阶段拒绝、什么都没碰 |
| D2 | 不检查基建授权的字段名单（maa-config） | A「the writer binds a base grant」（未知授权字段） |
| D3 | D1、D2 一起删 | 同上（另带药品授权） |
| E1 | 来源为当次请求的基建授权也接受（maa-config） | 同上 |
| F1 | 不变分支不比较配置修订号（base-apply） | A「the applied copy has a way back」 |
| F2 | 副本一致时不报 `unchanged`（base-apply） | A「report → approval」「the applied copy has a way back」 |
| F3 | 副本不在时照旧拒绝 `base-plan-copy-missing`（base-apply） | A「the applied copy has a way back」 |
| G1 | 事务中途不再核对副本（maa-config 的 check-asset） | A「a copy that changes while the writer has MAA closed」 |
| G2 | 读回时不核对副本（maa-config） | 同上 |
| H1 | 第 15 项重新检查只审方案文字（base-report） | A「the apply-time gate 15 audits the report's own texts again」 |
| H2 | 第 15 项重新检查不审任何文字（base-report） | 同上 |
| H3 | 不审方案文字（base-report） | 同上 |
| H4 | 不审假设（base-report） | 同上 |
| H5 | 不审总结（base-report） | 同上 |
| H6 | 不审假设的目标（base-report） | 同上 |
| I1 | 周计划有几天不运行时不列未核实（base-apply） | A「a weekly schedule that skips days」 |
| J1 | 副本被改过时不按名拒绝（base-apply） | A「plan paths are confined」「the applied copy has a way back」 |
| L1 | 副本已在时也接受空的基建事务（maa-config） | A「the writer binds a base grant」 |
| L2 | 只装副本的事务也重写 `gui.new.json`（maa-config） | A「the applied copy has a way back」（第一次运行时没拦住：测试里的配置恰好已是写入器的排版；测试改成先按另一种排版保存配置，再跑一遍被拦住） |
| L3 | 空改动列表记成「只改连接」（maa-config） | 同上 |
| K1 | 评测网络夹具不替代 22 的入口（network-fixture） | S 两个测试 |
| K2 | 同 K1 | N「trusted network fixtures replace only the named product CLI boundary」 |
| K3 | 夹具不替代 `base-plan.ts candidates` | S「base report scenarios run the installed product CLIs offline」 |
| K4 | 夹具不替代 `base-report.ts freshness` | N 同上 |

## 未验证

- 真模型行为评测：maa-daily 的 SKILL.md 和新接口说明改了，按规定要用同一模型、同一场景做前后比较；评测运行器（工单 28）和专用登录目录还不能用，前后两次和八个新场景都没有运行，交工单 26。
- 没有在真实 MAA 上写入和重开；四个字段写进去后图形界面能否正确读出、`PlanSelect` 为 -1 时实际选中哪个计划，只按上面的源码核对过。
- `maa-timers` 只比较每日定时（`IsEnabled` 为 true）；单次定时、强制定时、用户手动运行都不判断。
- 结果未知时 maa-doctor 不能自动核对或恢复基建事务（只认 05 的普通记录），只能报告证据，由用户核对；只装副本的事务（改动列表为空）同样如此。
- 2026-11-14 改了 agent 读的文字：`skills/maa-daily/SKILL.md`、`skills/maa-daily/references/base-apply.md`、`skills/maa-help/SKILL.md`，新增两个 daily 场景。真模型前后评测和新场景都没有运行（原因同第一条），交工单 26。
- `WeeklySchedule` 在真实配置里按 `DayOfWeek` 名字保存是按 v6.21.4 源码里的字典类型推断的（System.Text.Json 对枚举字典键的默认写法），没有拿真实 MAA 写出的配置核对；数字键也认。
- `maa-help` 里「准备指定关卡作业或专精排程」一行仍写「后续能力」；15、24 已完成，这一行不属于 22、23，本次没有改。
- 2026-11-14 工单 25 给 `skills/maa-daily/references/base-apply.md` 加了第 8 步（报告 `versions`）；真模型前后评测没有运行（原因同第一条），交工单 26。
- 本票不处理 22 遗留的两项（23:59 那一分钟的改法文字、报告里的运行次数），见 GitHub Issue #56。
