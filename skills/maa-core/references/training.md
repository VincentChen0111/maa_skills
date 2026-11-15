# 训练查询与原生排程

用户交办专精、查询助手或续接已有训练时读取本页。`training-time.ts` 只读；`training-plan.ts` 保存私有记录并调用唯一配置写入器。所有参数经 JSON stdin。Windows PowerShell 用管道传 JSON 时，非 ASCII 字符和 `?` 都写成 `\uXXXX` 转义；管道加在开头的 BOM 由脚本去掉，返回 `input-encoding-lossy` 时什么都没做，改成转义后重发。按偏好语言转述，JSON 的诊断码不是给用户的游戏规则。

## 查询与事实

运行 `node <core>/scripts/training-time.ts query`，示例输入：

```json
{"name":"合成干员","skill":1,"target":2,"current":{"source":"user-confirmed","skillLevel":7,"mastery":{"1":0}},"facts":{"source":"user-confirmed","trainingRoomLevel":3,"availableAssistants":["char_helper"]},"format":"markdown"}
```

`name` 为精确名称，歧义时增加 `operatorId`；技能序号 1–3，目标档次 1–3。当前练度优先使用共享账号快照，已知冲突拒绝，缺失只接受用户明确确认的 `current`。`facts` 的训练室等级、可用助手 ID、可选的 `branchName` 都是当前用户事实，不能从持有或技能解锁推定可用。没有这些事实仍可 query，结果会列待核。材料由共享成本/缺口工具计算：`materials` 是到最终档次的总量，`startMaterials` 是下一个要开训的那一档；开训门只看 `startMaterials`，以后每一档开训前再核一次。缺材料不影响准备计划，也不影响推进到下一档或下一位干员，只让这一档等材料到齐再开训。缺料时回复要说清还缺什么：成品缺口、`comparison.craft.decomposition` 里还要获取的基础材料和龙门币缺口（含义同 maa-account 缺口接口的「展开到基础材料」），并说明可以在推进中逐步补齐；材料券先问数量，不回答也按 `decomposition.vouchers` 给不依赖数量的建议。可选的 `inTraining` 和 `progress` 见下文「续接进行中的档次」和「加工补料」。

五小时条件可补 `previousAssistance: {assistantId,traineeId,seconds,remainedTogether}`。只有同受训者、同助手、连续至少 18000 秒且未离开的已确认事实，才估算下一档减时；离开或不足五小时不减时。没有这条事实，或者是更后面的档次（取决于还没发生的协助），按不减时估算，助手照常可用、照常可以准备计划，助手的 `issues` 里列 `assistant:five-hour-reduction-pending:<技能 ID>` 表示减时待核；实际减没减以开训后的真实倒计时为准，不要因为这条条件说「无法生成计划」。其他未解析条件、阵营人数、人间烟火、武道即时完成等保留未知。普通职业、双职业、档次及已确认分支加速使用完整技能描述；心情附带消耗保留在条件中，不当成速度。只使用持有且已生效的训练技能加成；资料完整但没有额外训练技能的可用助手仍计基础项。缺失角色/建筑或残缺、房间未知的技能资料保持待核，不能当作零加成；已知其他房间的技能不混入训练计算。

`stages` 含每档基础秒数、开训助手 `recommendedAssistant`、核实开训后尝试的 `afterStartAssistant` 和估算。`speedBonus` 含表内 5% 基础项；时长公式及叠加是固定表/文字推断，不是实机保证。原生培养任务可能自己选择导师；安排不证明助手已就位，也不证明换人后保留减时。以后续倒计时为准。

默认读取设置中的私有快照并在线读取固定公开表；输出 `sources` 带实际内容 hash。`snapshotFile` 可显式选择快照。离线 `tablesFile` 是完整计算表输入，始终标 `supplied-unverified`，不能当作已经核验的公网来源。`format` 为 `json`（默认）或 `markdown`；中文/英文模板，其余语言由调用者转述。

## 续接进行中的档次

下一档已经在训练室里练着（用户自己开的、旧流程开的、MAA 界面开的），就在查询里加 `inTraining: {source:"user-confirmed", rank:<已完成档次+1>}`。只在用户确认这一档正在训练时加；它表示这一档的材料已经扣掉，而且所用快照的库存是这一档开训之后的。库存时间按快照来源算：森空岛快照是读取时间，MAA 识别快照是仓库扫描时间（`sourceTimes.inventory`，不是导入时间）；没有库存时间时以 `training:in-training-inventory-time-unknown` 待核。库存比这一档开训还早时，先经 maa-account 更新快照，或者不加 `inTraining`（这一档会被再算一次，偏保守）。加了以后成本从这一档之后算起，不再重复计入；结果的 `inTrainingRank` 是这一档。准备计划时 `currentTrainee` 必须是这名干员的 ID（训练室里就是他），否则以 `training-in-training-trainee-conflict` 拒绝。计划自动只观察这一档：不开训、不重复付料，拿到这一档真实完成的回调后才进入下一档。

## 加工补料

MAA 的培养任务（OperProgress；已核对 MAA v6.21.4 与 v6.22.0 源码，这部分相同）开专精时如果缺材料，会自己跳到加工站合成，没有开关；合成后仍缺就不开训，回报 `ResourceInsufficient`（配方未解锁是 `FormulaLocked`）。所以：

- 没有用户对加工的批准时，开训门只认库存里的成品材料；缺料就不开训（开了 MAA 会自己合成）。
- 用户用自己的话批准了加工（例如「缺的材料让 MAA 自动合成」），`prepare` 加 `crafting: {reference:<用户原话>}`；查询加 `progress`，写法同共享缺口工具，至少要有用户确认的加工站等级 `progress: {source:"user-confirmed", rooms:{WORKSHOP:[<等级>]}}`（配方有关卡条件时加 `stageRanks`）。开训门这时也接受加工能补齐的缺口：按现有库存逐级合成，先保留这一档本身要的原料，龙门币含加工费；用到材料凭证的路线一律不算（MAA 不兑换凭证）。计划摘要的 `craftingRequired` 为 true 表示这一档要靠加工才够。
- 批准前告诉用户这会做什么：消耗下级材料、龙门币和加工站干员的心情；MAA 可能换掉加工站里的干员且不换回；合成数量上限、心情不足时的表现源码有限制、未实机核实。已批准的培养报告条目不含加工（范围里写着不含加工和兑换凭证），要用户自己的话；用户为无人值守续接给的原话里明确包括加工时，可以作为每个计划的 `crafting` 原话。
- MAA 回报合成或开训失败时计划记为未知，交给 maa-doctor 核对，不重试。

## 准备与逐阶段执行

1. 明确授权的干员、技能、最终档次。读取 `maa-config.ts read` 的摘要，请用户选定**已有**配置、Infrast、OperProgress 队列位置和一个空闲单次槽。缺项时等待用户在 GUI 补齐，再读摘要；不隐式创建任务。选中的配置会临时仅启用当前训练任务，其他队列项停用；将这一具体影响纳入用户本次安排。
2. `training-plan.ts prepare` 输入 `{query:<上述查询>, authorization: { source:"current-request"或"approved-report",reference:<授权原话或报告条目> }, binding:{profile:0,infrastTask:0,progressTask:1,timer:0}, currentTrainee:null或<当前受训者ID>, manualTraining:false, crafting?:{reference:<用户批准加工的原话>}}`。所有序号从 0 起；`currentTrainee:null` 明确当前没有受训者，不代表未知。当前是谁待核时先查询，不准备猜测。返回计划 ID，仅保存待执行记录。`approved-report` 的 `reference` 写批准记录给出的 `cultivation/<reportHash>#S<n>`：脚本核对这一条目仍然批准、内容没被改、是同一名干员，并且范围里有这个技能的专精训练、批准到的档次不低于目标；不符以 `training-approval-scope-mismatch` 或报告的静态代码拒绝。停下时输出 `{ok:false,status:"check-required",reason:<代码>,check:<要核对什么>,alternatives:[<替代做法>]}`，`training-facts-required` 另在 `details` 里带 `issues` 和缺助手的 `stages`。按 `check` 核对，把 `alternatives` 一起告诉用户，不要读实现猜原因；标准输入本身不合格时仍是 `{ok:false,error:<代码>}`。
3. `training-plan.ts apply` 输入 `{id,host:"codex"或"claude",closedConfirmed?:true}`。结果 `waiting`（`training-materials-pending`）表示这一档材料还没到齐，计划照常等待，什么都没写，不是错误；`done` 表示目标已达成；`check-required` 按上一步的形状给出原因、核对项和替代做法。只有已经收到用户关于已关闭 MAA 未被操作的确认才加 `closedConfirmed:true`。写入以 `training-expiring-grant-required` 拒绝、用户当次批准临期药随这份计划一起时，再加 `expiringMedicine`（同 maa-daily 配置事务接口的临期药授权）和 `reference`（用户这次批准的原话）；这时写入请求的来源记为当次请求，计划自己的授权仍在计划记录里。`reconcile` 清理单次槽时遇到同一原因码，也按这个方式附带。脚本复用安全事务；`complete` 仅代表配置及引用文件读回完成。检查阶段 `rejected`/`busy` 未写入，可在原因解除后继续；`unknown` 先核对，不能重试。准备时的配置名、队列和槽身份持续绑定；漂移停下核对，仅允许原生已完成后清空培养目标及关闭单次槽的已知变化。每次只安排一个阶段，原生单次定时按本机时钟触发；不创建外部定时器或点击设备。
4. 原生执行之后，`training-plan.ts reconcile` 输入 `{id,logFile:<已选MAA目录内实际Core日志>,host,closedConfirmed?}`。只接受该实例目录内日志；保留原日志，不把完整日志贴到对话。日志须包含本动作实际 `append_task` 参数与同线程返回的 task_id，再以同进程/任务 ID/任务链的 TaskChainStart 关联回调；仅截一条完成消息不足。Infrast 需匹配本计划不可变训练文件、Training-only、禁续训和计划序号，OperProgress 需匹配唯一目标及下一档。缺失、多个候选或中途参数变化先核对；不能借材料刷新重放。`read` 输入 `{id}` 可随时读取安全摘要。

计划在 `prepare` 时写下读到的 MAA 版本和核实记录版本（摘要的 `versions`，读不出为 null）。`apply` 的结果和 `reconcile` 的返回都带 `versions`：`state` 为 same、changed（`changed` 列出变了的项）、unknown 或 unrecorded（旧计划没有记录）。changed 时告诉用户准备之后 MAA 或核实记录换了版本；这只是提醒，不阻止执行，未核实的版本同样只提醒。
5. 换受训者先预入驻：仅 Training、自定义候选、`ContinueTraining=false`、培养任务停用。实际 Infrast 执行完成只记预入驻执行，不记就位；下次 apply 的独立开训至少晚于该**实际完成时间 6 分钟**。这是未实机验证的故障防护措施。
6. 开训只记录正确目标/技能/档次的倒计时，并要求当前开训阶段 `InfrastTrainingConfirm` 的 Completed 回调在此前；手动已开训只能走观察。培养任务成功、计划清零或全部完成均不足。培养任务完成且有确认但缺倒计时，下一次只安排观察，不再开训。目标已满足与已知等级矛盾记失败，清理本计划依赖的单次槽后等待核对。
7. 核实开训后下一次 apply 尝试换助手；助手执行完始终 `unverified`。原生训练回调在换人前发出，故换人后再安排一次观察，使用新倒计时更新结束点；到预计结束点仍须同目标真实完成回调且时间不早于本档开训/最新训练观察，才能进入下一档。手动开训保护仅限当前档，实际完成后保留历史并解除该档标志，后续已批准档次仍可启动。晚完成就重新观察；超过一天的观察拆成最多 23 小时内检查，不把原生槽当作带日期的提醒。
8. 完成一档后 materialReady 归 false。`training-plan.ts refresh` 输入 `{id,query:<目标恰为下一档、最新材料和当前已完成等级>}` 重新调用共享成本，再 apply；不能借刷新变更干员/技能或最终目标，查询里也不能带 `inTraining`（`training-in-training-refresh-unsupported`）。准备时给了 `progress` 就照样带上。快照比计划记录的真实完成还旧时（快照还停在上一档），脚本按计划自己记下的完成与付料时间核对：付料早于快照库存时间（见上文「续接进行中的档次」）的档次不再计入；计划自己付过料、但库存时间更早或不明的档次那份库存里还有，照常计入，不管 `current` 写的是哪一档。快照比计划记录的完成更新、却与之矛盾（例如快照的档次更高）时以 `training-refresh-target-changed` 停下，先由 account 更新/用户核实，不能覆盖已知冲突。

## 无人值守续接（跨档、跨干员）

用户不在场、由定时重新调用（例如 Codex 的心跳自动化）时，每次重新进入按下面做；每一步仍只用计划里保存的授权和唯一配置写入器，问不到人的事一律停下等用户。

1. `training-plan.ts list` 输入 `{}`，列出所有计划的安全摘要。训练室只有一个：已经写过一次 MAA 配置、还没完成或满足、也没被用户关闭的计划占着它（`holdsTrainingRoom`）；自己的单次槽还等着停用（`cleanupPending`）的计划即使已完成也占着。别的计划 apply 时以 `training-other-plan-active` 拒绝。
2. 有占着训练室的计划：动作已安排、还没核对就 `reconcile`（实际 Core 日志）；结果 `unknown` 或 `failed` 就停下，unknown 交给 maa-doctor 核对，不重放、不准备也不安排别的计划。`pending` 且刚完成一档就用最新快照 `refresh`（查询目标恰为下一档），再 `apply`；`apply` 返回 `waiting` 时说明还缺的成品、基础材料和龙门币，说明下次重新进入会再核，计划照常等待，不说计划被挡住；刷关仍要用户当次交办。`cleanupPending` 为 true 时上次没能停用自己的单次槽（MAA 忙、没开或锁被占，什么都没改）：先 `reconcile` 重试，停用成功前 `apply` 返回 `training-timer-cleanup-pending`。`preplaced`/`started` 就 `apply` 安排下一步（开训至少在预入驻实际完成 6 分钟之后、开训后换助手、到点观察）。
3. 没有计划占着训练室、上一个计划已完成或满足：按用户批准的顺序取下一项。已批准的培养报告条目从 `cultivation-report.ts read` 的批准记录取第一个专精目标还没达到的条目，`authorization` 写 `approved-report` 和它的引用；用户自己说的顺序（自动化里保存的原话）写 `current-request` 和原话。`currentTrainee` 写上一个计划的干员 ID（练完后还在训练室里），所以先预入驻、实际完成至少 6 分钟后再开训。准备成功就 `apply`。
4. `apply` 返回 `closed-confirmation-required` 时 MAA 没开着，原生定时也不会触发；没有人能确认就不要加 `closedConfirmed`，说明 MAA 需要开着后停下。`rejected`/`busy` 按原因停下，下次再进入时再试；`unknown` 交给 maa-doctor。
5. 停下的计划（failed、unknown，或用户不要了的）一直占着训练室，直到用户在游戏里核对后亲口要求关闭：`training-plan.ts close` 输入 `{id, reference:<用户原话>}`。agent 不能自己决定关闭；计划自己的单次槽还开着时以 `training-timer-still-armed` 拒绝，先 reconcile 或请用户在 GUI 停用。关闭不重放、不删记录，计划不再安排任何动作。
6. 碎石、理智药、临期药仍要各自的当次批准；抽卡、礼包、付费、登录始终不做；加工只在计划带着用户批准加工的原话时才算进开训门。

## 中断与清理

`reconcile` 在重新进入时停用已过期且仍为本计划的 null/省略单次槽。按 Id、配置、时分及单次性质核对所有权；已变为每日或被用户改动的槽不碰。维护窗口、关停或读回失败会保留 `expired-timer-not-disabled`，明确提醒用户在 GUI 核对停用，不能声称已清理。离线时没有常驻进程保障，错过槽可能在次日触发；需及时再次核对。

计划记录、材料核对和实际事件保存在私有 `training-plans`，含每档历史和去重摘要。记录锁遗留或配置事务未知时，先保留现场交给核对；自动重放和自动删锁均不提供。训练自定义文件以内容 hash 命名，统一事务在持锁且关停后安装，记录原先缺失/一致状态与 manifest，GUI 备份、关停后漂移检查和重开读回都覆盖引用。失败不声称跨文件原子成功；恢复工具若不认识训练 manifest 必须留 unknown。

训练、关卡作业和理智药、碎石数量是不同的批准范围；分别调用对应入口，不能在同一配置事务混合 `trainingPlan`、`jobPlan`、`medicineCount` 或 `stoneCount`。临期药的当次批准 `expiringMedicine` 可以随计划一起提交：专精定时会运行到开着临期药的 Fight 任务时，没有它就以 `training-expiring-grant-required` 拒绝，请用户一起批准临期药或先关掉；运行到开着碎石的 Fight 任务时以 `training-stone-enabled` 拒绝，先经当次请求关掉碎石。
