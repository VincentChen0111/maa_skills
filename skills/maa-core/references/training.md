# 训练查询与原生排程

用户交办专精、查询助手或续接已有训练时读取本页。`training-time.ts` 只读；`training-plan.ts` 保存私有记录并调用唯一配置写入器。所有参数经 JSON stdin。按偏好语言转述，JSON 的诊断码不是给用户的游戏规则。

## 查询与事实

运行 `node <core>/scripts/training-time.ts query`，示例输入：

```json
{"name":"合成干员","skill":1,"target":2,"current":{"source":"user-confirmed","skillLevel":7,"mastery":{"1":0}},"facts":{"source":"user-confirmed","trainingRoomLevel":3,"availableAssistants":["char_helper"]},"format":"markdown"}
```

`name` 为精确名称，歧义时增加 `operatorId`；技能序号 1–3，目标档次 1–3。当前练度优先使用共享账号快照，已知冲突拒绝，缺失只接受用户明确确认的 `current`。`facts` 的训练室等级、可用助手 ID、可选的 `branchName` 都是当前用户事实，不能从持有或技能解锁推定可用。没有这些事实仍可 query，结果会列待核。材料由共享成本/缺口工具计算，不加工；缺材料可以保留计划，但开训被阻止。

五小时条件可补 `previousAssistance: {assistantId,traineeId,seconds,remainedTogether}`。只有同受训者、同助手、连续至少 18000 秒且未离开的已确认事实，才估算下一档减时；离开或不足五小时不减时。其他未解析条件、阵营人数、人间烟火、武道即时完成等保留未知。普通职业、双职业、档次及已确认分支加速使用完整技能描述；心情附带消耗保留在条件中，不当成速度。只使用持有且已生效技能；未来解锁不参加推荐。

`stages` 含每档基础秒数、开训助手 `recommendedAssistant`、核实开训后尝试的 `afterStartAssistant` 和估算。`speedBonus` 含表内 5% 基础项；时长公式及叠加是固定表/文字推断，不是实机保证。原生培养任务可能自己选择导师；安排不证明助手已就位，也不证明换人后保留减时。以后续倒计时为准。

默认读取设置中的私有快照并在线读取固定公开表；输出 `sources` 带实际内容 hash。`snapshotFile` 可显式选择快照。离线 `tablesFile` 是完整计算表输入，始终标 `supplied-unverified`，不能当作已经核验的公网来源。`format` 为 `json`（默认）或 `markdown`；中文/英文模板，其余语言由调用者转述。

## 准备与逐阶段执行

1. 明确授权的干员、技能、最终档次。读取 `maa-config.ts read` 的摘要，请用户选定**已有**配置、Infrast、OperProgress 队列位置和一个空闲单次槽。缺项时等待用户在 GUI 补齐，再读摘要；不隐式创建任务。选中的配置会临时仅启用当前训练任务，其他队列项停用；将这一具体影响纳入用户本次安排。
2. `training-plan.ts prepare` 输入 `{query:<上述查询>, authorization: { source:"current-request"或"approved-report",reference:<授权原话或报告条目> }, binding:{profile:0,infrastTask:0,progressTask:1,timer:0}, currentTrainee:null或<当前受训者ID>, manualTraining:false}`。所有序号从 0 起；`currentTrainee:null` 明确当前没有受训者，不代表未知。当前是谁待核时先查询，不准备猜测。返回计划 ID，仅保存待执行记录。
3. `training-plan.ts apply` 输入 `{id,host:"codex"或"claude",closedConfirmed?:true}`。只有已经收到用户关于已关闭 MAA 未被操作的确认才加 `closedConfirmed:true`。脚本复用安全事务；`complete` 仅代表配置及引用文件读回完成。检查阶段 `rejected`/`busy` 未写入，可在原因解除后继续；`unknown` 先核对，不能重试。准备时的配置名、队列和槽身份持续绑定；漂移停下核对，仅允许原生已完成后清空培养目标及关闭单次槽的已知变化。每次只安排一个阶段，原生单次定时按本机时钟触发；不创建外部定时器或点击设备。
4. 原生执行之后，`training-plan.ts reconcile` 输入 `{id,logFile:<已选MAA目录内实际Core日志>,host,closedConfirmed?}`。只接受该实例目录内日志；保留原日志，不把完整日志贴到对话。核对未完成前不重复 apply。`read` 输入 `{id}` 可随时读取安全摘要。
5. 换受训者先预入驻：仅 Training、自定义候选、`ContinueTraining=false`、培养任务停用。实际 Infrast 执行完成只记预入驻执行，不记就位；下次 apply 的独立开训至少晚于该**实际完成时间 6 分钟**。这是未实机验证的故障防护措施。
6. 开训只记录正确目标/技能/档次的倒计时，并要求当前开训阶段 `InfrastTrainingConfirm` 的 Completed 回调在此前；手动已开训只能走观察。培养任务成功、计划清零或全部完成均不足。培养任务完成且有确认但缺倒计时，下一次只安排观察，不再开训。目标已满足与已知等级矛盾记失败，清理本计划依赖的单次槽后等待核对。
7. 核实开训后下一次 apply 尝试换助手；助手执行完始终 `unverified`。原生训练回调在换人前发出，故换人后再安排一次观察，使用新倒计时更新结束点；到预计结束点仍须真实完成回调才进入下一档。晚完成就重新观察；超过一天的观察拆成最多 23 小时内检查，不把原生槽当作带日期的提醒。
8. 完成一档后 materialReady 归 false。`training-plan.ts refresh` 输入 `{id,query:<目标恰为下一档、最新材料和当前已完成等级>}` 重新调用共享成本，再 apply；不能借刷新变更干员/技能或最终目标。原快照与实际完成矛盾时先由 account 更新/用户核实，不能覆盖已知冲突。

## 中断与清理

`reconcile` 在重新进入时停用已过期且仍为本计划的 null/省略单次槽。按 Id、配置、时分及单次性质核对所有权；已变为每日或被用户改动的槽不碰。维护窗口、关停或读回失败会保留 `expired-timer-not-disabled`，明确提醒用户在 GUI 核对停用，不能声称已清理。离线时没有常驻进程保障，错过槽可能在次日触发；需及时再次核对。

计划记录、材料核对和实际事件保存在私有 `training-plans`，含每档历史和去重摘要。记录锁遗留或配置事务未知时，先保留现场交给核对；自动重放和自动删锁均不提供。训练自定义文件以内容 hash 命名，统一事务在持锁且关停后安装，记录原先缺失/一致状态与 manifest，GUI 备份、关停后漂移检查和重开读回都覆盖引用。失败不声称跨文件原子成功；恢复工具若不认识训练 manifest 必须留 unknown。
