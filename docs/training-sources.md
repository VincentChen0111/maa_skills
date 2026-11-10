# 24 专精来源核对

2026-11-11，只读核对公开固定源，独立实现训练工具；未读真实账号、已安装私人 skill 或真实 MAA，未实机验证。游戏表不随产品分发。研究底稿保留于本地忽略目录，以下是可审查的产品事实。

## 游戏表与估算

批准的镜像为 `Kengxxiao/ArknightsGameData@6f63c14e27b847ef74b53b00fe51fc322b3cd7ff`。镜像由 Kengxxiao 整理，游戏数据属于原权利人，不是官方算法规范。

| 固定文件 | 实际响应 SHA-256 | 已核事实 |
| --- | --- | --- |
| [character_table.json](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/character_table.json) | `eb6fff6fb3ce605bd60db2206a644625a3d145b4c46fa126f218cd51df4f1f1d` | `skills[].levelUpCostCond[].lvlUpTime` 是逐档秒数，所核档次 28800/57600/86400；成本/解锁条件复用 13/14 |
| [building_data.json](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/building_data.json) | `8b4000197acf12565b154e870266e9a2b6ab7dac2f11fbfcf32feba6063855f7` | `trainingData.basicSpeedBuff=0.05`，各训练室阶段 `specSkillLvlLimit=1/2/3`；buffChar 解锁沿用 21，完整 TRAINING 描述区分职业、档次、分支、心情及五小时条件 |
| [skill_table.json](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/skill_table.json) | `edc7cda2bae05f623c03d42adbf053a7017a645a4a668063b9ee5a7e99cb6160` | 通过 character skillId 查询 `levels[0].name`，与原生倒计时的技能名称核对 |

实际读取时间分别为 2026-11-10T21:34:40.355Z、21:34:40.737Z、21:34:41.360Z；这是读取时间，不是数据更新时间。运行时公共读取器记录本次响应指纹。其余共享成本来源见[成本记录](operator-cost-sources.md)与[加工记录](crafting-sources.md)。

估算 `ceil(基础秒数 × 已确认减时因子 / (1 + 0.05 + 适用技能速度))` 为表与文字的**推断**，没有游戏结算实测。同槽替换/有效技能由 base-query 决定；不能叠加未解锁技能。支持完整职业/双职业/档次/分支描述及单独心情附带消耗，未知语法和动态阵营人数、人间烟火、武道即时完成保持待核。`trainingBonusMax=3` 的实际结算封顶含义未核，未据此发明规则。五小时同一组合持续协助仅在明确事实支持时估算下一档 50% 减时，换人后是否保留效果未证实；返回开训与开训后助手候选，以后续倒计时取代预测。

## MAA 原生字段与回调

全部 MAA 链接固定到官方 v6.22.0 提交 `901e01c600f4895ac4e7e48a9b471fc9f52af301`。仅借助接口事实，未复制其 AGPL 实现。

| 源文件 | 事实与边界 |
| --- | --- |
| [OperProgressProcessTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaCore/Task/OperProgress/OperProgressProcessTask.cpp)（blob `df8252f1437c7efd2a5a3c987a44a786aca408af`） | `OperProgressDetail` 带 role/name/result/result_detail/skill_mastery。Completed、AlreadySatisfied、PrerequisiteTraining 都可为 Success；Completed 只启动训练。原生随后自己选导师 |
| [InfrastTrainingTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaCore/Task/Infrast/InfrastTrainingTask.cpp)（blob `cae967c966027d78e0002166a7e61aaee2329cee`） | `InfrastTrainingTimeLeft` details 为 operator/skill/level/time；Completed 同身份无 time。时间仅做粗 OCR 检查，工具自行严格解析。助手变更前发状态，无变更后助手身份回调；TaskChainCompleted 不能证明就位 |
| [ProcessTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaCore/Task/ProcessTask.cpp)、[AbstractTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaCore/Task/AbstractTask.cpp)、[Assistant.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaCore/Assistant.cpp) | Core `Assistant::append_callback` 日志封装 taskchain/taskid/subtask/details。ProcessTask 的 SubTaskCompleted 在动作/子任务后；Start 在动作前。设备 uuid 不输出，只保留单行 SHA-256 去重 |
| [tasks.json](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/resource/tasks/tasks.json)（blob `5241e447c00cd49f19378b4d426eb843f2650894`） | `InfrastTrainingConfirm` 点击后仍可能 Locked；MasteryPage 的协助者识别不等于训练中。故当前动作确认 Completed 加正确目标倒计时才作为开训组合证据 |
| [OperProgressTask.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaWpfGui/Configuration/Single/MaaTask/OperProgressTask.cs)、[AsstOperProgressTask.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaWpfGui/Models/AsstTasks/AsstOperProgressTask.cs) | GUI `$type=OperProgressTask`/TaskType=OperProgress，Plans Role/Name/Elite/SkillLevel/SkillMastery[3]/ShowRole。只写下一档，Elite/SkillLevel=0，其他技能=0；核心省略零值 |
| [OperProgressTaskUserControlModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaWpfGui/ViewModels/UserControl/TaskQueue/OperProgressTaskUserControlModel.cs) | GUI 按成功回调清空目标，不能把 Plans 清空当真实开训 |
| [基建协议](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/docs/zh-cn/protocol/base-scheduling-schema.md)、[InfrastTask.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaWpfGui/Configuration/Single/MaaTask/InfrastTask.cs) | GUI Mode=Custom/10000、Filename、PlanSelect、RoomList/IsEnabled、ContinueTraining、UseWeeklySchedule。custom plans[].rooms.training[] 的 operatorsA/B 为助手/受训候选；显式只开 Training 且 ContinueTraining=false，空房间或 skip 不能替代禁续训 |
| [Timer.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaWpfGui/Configuration/Global/Timer.cs)、[TimerSettings.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaWpfGui/Configuration/Global/TimerSettings.cs) | Id/Config/Hour/Minute 和 IsEnabled false=关闭、true=每日、null/省略=单次。没有日期或 TTL；本地时钟、提前配置切换、离线或忙时漏执行可能留到次日。调度见 [TaskQueueViewModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaWpfGui/ViewModels/UI/TaskQueueViewModel.cs#L1079) |
| [infrast.json](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/resource/infrast.json)、[InfrastScore.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaCore/Task/Infrast/InfrastScore.cpp) | 导师评分是选择策略。尤其 reductime 的 .7 不是 70% 速度，最低心情 16 也不是从这里推出的游戏规则；工具不用评分做时长 |

## 本次实施选择和未验证项

只复用用户选定的现有两任务、现有配置和一个空闲槽；缺项等待 GUI 补齐。这是执行范围选择，不声称 MAA 不支持新任务。每阶段覆盖所选队列启停，仅一个训练任务启用；多任务并行、跨时区/DST 边界不猜。观察点至多 23 小时，原生仍无日期语义。

六分钟锚定预入驻 TaskChainCompleted 的实际时间，分开两次原生执行；预入驻不证明真正就位。该做法及目标满足矛盾处理来自工单/规格记载的维护者故障要求，根因和做法均未实机验证。

重新进入时核对实际日志与槽身份，再停用自己过期且未被改变的单次槽。离线无常驻清理，窗口/关停/读回失败明确保留未清理状态，不能保证次日不会触发。材料每档重新核对，不因原计划估算足够就承诺后续消耗。

训练自定义资产为内容地址不可变文件；唯一写入器把原先缺失/一致状态、摘要和 GUI 引用纳入 pending manifest，持锁关停后安装，GUI 备份及重启读回校验。已有一致文件不覆盖，漂移/部分失败保留 unknown；不是多文件原子提交声明。整合 06/15 时保留作业的三次双资产检查，并明确 trainingPlan、jobPlan、medicineCount 不混用；这是本票窄批准范围的实施选择。06 不认识训练 manifest 时只能保留未知，不宣称自动恢复附加资产。实际助手身份、减时效果、真实设备动作、两宿主模型行为和候选原生安装分别以验证记录为准，不能由合成测试推定。

## R1 后的身份与因果证据补核

训练目标沿用成本的 `operatorCatalog` 合并 character 与 patches.patchChars；同名须给 operatorId。[固定 char_patch_table](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/char_patch_table.json) 中 `char_1001_amiya2` 为 WARRIOR，`char_1037_amiya3` 为 MEDIC，各有两技能；2026-11-11 通过连接器再次实际读取核实，Git blob `a0fc7daa64a375b8431201c7f08abe4695f9f5e7` 由独立 R1 核对记录提供。不能在成本已消歧后退回不含形态的目录。

同日补核上述固定官方 Assistant.cpp 的 append_task：先记录类型及实际 JSON 参数，随后记录 task_id；工作线程的 TaskChainStart 和后续回调带相同 taskid/taskchain。[Logger.hpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaCore/Utils/Logger.hpp#L495) 为每行记录 Px/Tx 进程和线程标识。参数记录与返回 ID 按同线程配对，回调按同进程、ID、任务链和开始时间关联；多个匹配候选或 set_task_params 变更留未知。现有日志不含这条证据链时，不能从孤立完成行恢复执行资格。这是使用已核日志的保守实现选择，不是虚构新回调。

[AsstInfrastTask.Serialize](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/901e01c600f4895ac4e7e48a9b471fc9f52af301/src/MaaWpfGui/Models/AsstTasks/AsstInfrastTask.cs) 的 facility/mode/filename/plan_index/continue_training 对应当前训练资产和禁续训范围；AsstOperProgressTask.Serialize 的 plans/role/name/skill_mastery 对应唯一目标与下一档，非零精英或普通技能目标不得混入。本次核对复用原有 CLI 输入，不读取 GUI 私人配置到对话，也不声称源码日志已证明设备行为。

完成时间必须不早于本档 startedAt 和最新训练观察；倒序、旧片段及回拨保留未知。manualTraining 随当前档完成清除，但 external-training-observed 历史不清除。这是工单真实证据与逐档推进要求的修复，不改变授权目标。
