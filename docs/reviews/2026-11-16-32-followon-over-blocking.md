# 32 后续包（过度阻挡复核）：独立审查

日期：2026-11-16。提交区间以主包审查结束的 `91960d0` 为基点（审查时的基点是同内容的 `13f2dee`）。每轮一名新的审查员，读自包含说明、规格和 diff，只报告真实缺陷；修复会话逐条复核，只接受真实环境里会发生的具体故障，理由写在每条后面。范围：过度阻挡复核 OB-4 到 OB-9、事项 7 与 8、准备与开训事实分开、评测框架的改写记录写法与 5 个新场景（分派见启动本会话的会话的笔记 `over-blocking-triage.md`）。

## 第 1 轮

范围 `13f2dee..f51b35e`（7 个提交）。结论 NO-GO：P1 1，P2 2，P3 5，都有离线复现。审查员逐个运行相关测试文件全部通过、类型检查通过；核实了：固定建筑表 110 条训练技能与夹具逐条相同，所有职业、档次、分支、减时组合下没有负加速，下限估算成立，10 个分支名都在 `subProfDict` 里；观察时间只用真实倒计时，下限估算不会让观察提前或被当成完成；事项 7 推断错误时计划只观察、不花费；训练室等级只升不降，快照值不会高于实际；`confirmedStages` 只放行配方要求的关卡；写 MAA 的入口全部受 `startIssues` 与开训门约束。

修复会话逐条复核：

| 编号 | 发现 | 结论 | 理由 |
| --- | --- | --- | --- |
| FO1-1（P1，安全类） | `selectSnapshot` 只看覆盖范围、不比库存时间：训练总要技能和基建，只要有森空岛快照就整份读它，哪怕更新的 MAA 仓库扫描显示材料不够；开训门在高估的库存上打开，MAA 自动加工 | 接受 | 有离线复现（森空岛 11-10 读 mat 20，MAA 11-12 扫 mat 0，prepare 开门）；「花掉材料后用 MAA 重扫、森空岛快照是前几天的」是常见顺序；文档教的「重新扫描仓库」在这时反而不起作用；涉及未经批准的消耗 |
| FO1-2（P2） | prepare 拒绝时只输出准备阶段的问题代码，成本工具的具体原因（歧义、当前专精与快照冲突、技能未到 7 级）被 `targets:incomplete` 盖住，相对基点是回归 | 接受 | 有离线复现；这正是 OB-8 那类没有原因的停止，自动选中森空岛快照后用户写的当前专精更容易与快照冲突 |
| FO1-3（P2，评测） | `account-gaps-confirm-stages` 只检查有没有调用查询，不带 `confirmedStages` 也满分，事项 8 没有被测到 | 接受 | 新的 agent 行为必须有能区分对错的场景；验证记录里「诱人的错误做法失败」对它不成立 |
| FO1-4（P3，评测） | agent 编造「用户确认」的训练室等级和当前专精并指向 MAA 快照，`training-chain-skland-facts` 照样通过 | 接受 | 场景没测到它要测的行为（读快照里的事实） |
| FO1-5（P3，评测） | `rewrites` 授权只固定 id、rank、materialReady，改写时放宽目标和授权也通过 | 接受 | 评分对越权改写不敏感 |
| FO1-6（P3） | `training:room-rank-unavailable` 按最终目标算却当成第一档的开训事实：二级训练室、目标专三时挡住本来能练的专一 | 接受 | 真实：无人值守第 2 步会先 refresh 解开，但 apply 先以 `training-facts-required` 停下，问不到人时链会停 |
| FO1-7（P3，文档） | `skland.md:55` 仍写训练和缺口默认读 MAA 快照 | 接受 | agent 读到的接口说明与行为矛盾 |
| FO1-8（P3） | prepare 输出不带 `snapshotUsed` 和训练室等级来源，只做 prepare 时没法告诉用户用了哪份快照 | 接受 | 规则要求写明读的哪份、读取时间 |

修复：

- FO1-1：`selectSnapshot` 只在森空岛读取时间不早于默认快照库存时间（仓库扫描时间，没有时按导入时间）时才整份改读森空岛快照，否则仍用默认快照并标 `default-inventory-newer`；接口说明与规格同步；合并说明里提醒共用的 `selectSnapshot` 也要保留这一条（开训门依赖库存）。测试 `32 FO1-1`。
- FO1-2：拒绝时 `details.issues` 列出全部问题，另以 `details.blocking` 标出挡住准备的那些。测试 `32 FO1-2/FO1-6/FO1-8`。
- FO1-3：删掉区分不了对错的缺口场景，改为训练场景 `training-chain-confirm-stages`：配方要关卡、用户一句话确认，只有带 `confirmedStages` 时加工开训门才打开，计划记录可见。
- FO1-4：森空岛快照里专一已完成、训练室三级，场景要求计划从专二开始、`snapshotUsed` 是森空岛快照、训练室等级来源是快照；编造事实并读 MAA 快照的做法评为失败。
- FO1-5：改写授权另固定计划的 `target`、`authorization`、`binding`；放宽目标的改写评为失败。
- FO1-6：训练室上限只看下一个要开训的档次；更后面超过上限的档次记为那一档待核，到时 refresh 再核。
- FO1-7：`skland.md:55` 改为与关卡作业修复会话分支上同一行完全相同的文字（共用规则，含缺口和训练），两边合并不冲突。
- FO1-8：计划记下 `snapshotUsed`、`trainingRoom`，摘要里列出。

第 2 轮审查复核这些修复。

## 第 2 轮

范围 `91960d0..febcce3`（后续包全部提交加第 1 轮修复）。结论 NO-GO：P2 2，P3 2，没有安全类发现；第 1 轮的八项修复都成立，审查员逐个运行相关测试文件通过、类型检查通过，并对每项给出离线复现。

修复会话逐条复核：

| 编号 | 发现 | 结论 | 理由 |
| --- | --- | --- | --- |
| FO2-1（P2） | refresh 在当前档次算不出来（例如 `current` 与快照冲突）时报 `training-refresh-target-changed`，不带任何原因；按快照改选后的正常续接也会走到这里 | 接受 | 有离线复现；与 FO1-2 同一类（停下的原因被别的代码盖住），按复发规则改成 prepare 和 refresh 共用一个停止谓词，一个测试覆盖两处 |
| FO2-2（P2，文档、评测） | maa-daily 唯一能读到的训练说明让 agent 用 `stageRanks` 填关卡条件，没写 `confirmedStages`；训练输出也不提示 | 接受 | 真实：按文档做只能猜原码，猜错时计划一直等材料。场景对 `stageRanks:2` 也判通过这一点不另修：它和 `confirmedStages` 打开同一道门，MAA 在游戏里自己核对关卡，实际结果相同，不是会在正式环境出错的情形 |
| FO2-3（P3） | 最后一档正在训练、没有要开训的档次时，仍报 `training:room-rank-unavailable` | 接受 | 有离线复现；等于告诉用户训练室练不了正在练的那一档 |
| FO2-4（P3） | 默认快照没有仓库数量时，时间规则照样弃用完整的森空岛快照，还标 `default-inventory-newer` | 接受 | 有离线复现；时间规则保护的是更新的库存，这份快照没有库存可保护 |

修复：

- FO2-1：`training-plan.ts` 的 `assertPlannable` 是 prepare 和 refresh 唯一的停止谓词：让计划本身无法确定的事实（档次算不出、干员缺失、冲突、非法输入）以 `training-facts-required` 停下，`details.issues` 列出全部原因、`details.blocking` 标出挡住的那些；refresh 先过这一道，再比目标。目标真的变了仍报 `training-refresh-target-changed`。测试 `32 FO2-1`（同一个冲突输入分别走 prepare 和 refresh）。
- FO2-2：`training.md` 加工补料写明用户一句话确认关卡时写 `progress.confirmedStages:[报出的 ID]`、不填 `stageRanks`、不换算数字；训练输出在加工展开里有未确认关卡时给出要写的 ID（确认之后不再出现）。测试 `32 FO2-2`。
- FO2-3：训练室上限只在还有档次要开训时核对。测试 `32 FO2-3`（一级训练室在练最后一档专一）。
- FO2-4：只有默认快照有仓库数量（覆盖为 complete 或 partial 且有物品）时才比时间。测试 `32 FO2-4`。

第 3 轮审查复核这些修复。

## 第 3 轮

范围 `febcce3..06a12c8`（第 2 轮修复）。结论 NO-GO：P2 1，P3 2，没有安全类发现。第 2 轮四项修复都成立；审查员核实 FO2-4 只在默认快照本来读不到数量时才跳过时间比较，没有让较旧库存打开开训门的路径；refresh 抛出前不保存。复现脚本在 `06a12c8`、`febcce3`、`91960d0` 三份树上对照运行。

修复会话逐条复核：

| 编号 | 发现 | 结论 | 理由 |
| --- | --- | --- | --- |
| FO3-1（P2） | 自动选中的森空岛快照早于计划记录的完成时（事项 7 的流程里必然如此），refresh 按文档写 `current`（已完成档次）就以 `current.mastery.1:conflict` 停下，链在第一档完成后一直停着 | 接受 | 有离线复现，整包基点能通过；OB-9 带来，前两轮没有记录。无人值守主路径上的过度阻挡，正是本包要解决的 |
| FO3-2（P3） | 快照领先两档以上（目标已被超过）时报 `training-facts-required`，与 training.md「快照档次更高报 target-changed」相反 | 接受 | 第 2 轮 FO2-1 的回归，有离线复现；核对项和替代做法因此给错 |
| FO3-3（P3） | refresh 下一档没有可用助手时在保存前抛出，不记 `startIssues`，apply 又报成缺材料等待 | 接受 | 第 2 轮 FO2-1 的回归，有离线复现；退回 R2-3 修过的行为 |

FO3-2、FO3-3 与 FO1-2、FO2-1 同属「停下原因归错类」，按复发规则不再逐条修补：

- 一个判断、一个所有者：`training-plan.ts` 的 `trainingStop` 给出三种结果：`target-changed`（只在 refresh：查询换了干员/技能/目标，或快照的已完成档次与计划记录不同，到达或超过目标也算；计划不变）、`unknowable`（计划本身定不下来，列出全部原因；prepare 拒绝，refresh 记进 `startIssues` 后停下）、`plannable`（开训还缺的事实）。prepare、refresh 都只按它停下，apply 读 refresh 记下的 `startIssues`。
- 一致性测试 `32 FO3 conformance` 列举 12 种输入（快照早于完成且写/不写 `current`、缺当前档次、冲突、领先一档、领先两档、领先两档且写 `current`、换干员、换技能、换目标、下一档无助手、训练室未核），逐条断言 prepare、refresh、保存的 `startIssues`、apply 四处的结果。

FO3-1 修复：`calculateTraining` 有计划证据、查询写的档次恰为计划记录的完成、快照这一技能的档次更低时，这是同一份旧读取，不算冲突：成本按快照档次算，再由证据抬高起点（与不写 `current` 时相同）。别的写法照常与快照比较。审查员的三份复现脚本在修复后的树上：旧快照写/不写 `current` 都通过；领先两档报 target-changed；无助手记下 `startIssues`，apply 报 `training-facts-required`。另外核实：快照已到目标时 prepare 存成 `satisfied`，apply 报目标已达成，不会去练没有授权的下一档（原始基点 `f51ba18` 相同）。

轮次授权：第 3 轮后仍有接受的 P2（FO3-1）。维护者 2026-11-11 原话「以后这种情况可以你自己授权，最好压缩复核轮次」（2026-11-14 重申），修复会话据此授权第 4 轮，复核本轮全部修复。

## 第 4 轮

范围 `06a12c8..6ea2cf6`（第 3 轮修复）。结论 GO：P1 0，P2 0，P3 1，没有安全类发现。第 3 轮三项修复对各自的复现输入都已生效；FO3-1 删掉 `current` 的那一种情形与「不写 `current`」的旧路径逐条相同（材料卡在临界值，付料在库存时间、晚于库存时间、没有付料时间、两档都在库存时间后付料四种都核对过）；由训练结果决定的停下都来自 `trainingStop`，其余停下只是请求形状、授权和环境检查。审查员逐个运行 15 个相关测试文件全部通过，类型检查通过。

| 编号 | 发现 | 结论 | 理由 |
| --- | --- | --- | --- |
| FO4-1（P3） | 快照领先计划一档（等于 refresh 目标）、`current` 按文档写成计划记录的完成时，refresh 报 `training-facts-required` 并记进 `startIssues`，规格和 training.md 要求报 target-changed、计划不变 | 接受，转后续工单 | 真实，有离线复现（FO2-1 起的回归，同属停下原因归错）；refresh 照样停下、开训门关着、不会花费，原因可从 `details.issues` 看出。本包已过第 3 轮，按维护者规则「第 3 轮后不开第 4 轮，未关的 P3 转后续工单，包照常合并」；第 4 轮是为 P2 授权的，P3 不再追加轮次。工单草稿（含复现和建议修法）交协调者编号、建镜像 |

本包审查结束：没有未关闭的 P1、P2。

## 全量检查补齐（单独的小包，审查 1 轮）

冻结 `0e670fe` 跑全量离线检查失败 2 项，都是登记与清单：`docs/training-sources.md` 引用的两份 MAA 源码（`Interface/OperProgressTask.cpp`、`MiniGame/MaterialSynthesisTaskPlugin.cpp`）不在依赖注册表；本工单在 `training-plan.ts` 新增的两处比较不在比较清单。修复：注册表加 `mastery-training-crafting`（blob 取自 MAA v6.22.0 `901e01c` 的公开 API，两个支持版本相同），比较清单归类两行；随包记录重新生成后内容不变。独立审查第 1 轮 GO，没有发现：两行归类正确；三个 blob 与 v6.22.0 一致，v6.21.4 只有 `OperProgressProcessTask.cpp` 不同、差异与专精缺料无关，`sourceVerified` 两版有依据；`tickets ["24"]` 正确（32 记在 24 号工单下）。审查记录见共享笔记 `review-32-suitefix-round1.md`。冻结 `aae4ab5` 全量离线检查 1311 通过、0 失败、2 跳过，类型检查通过。

## 合并后改用共用模块（第 5 轮复核）

关卡作业修复（PR #105，squash `a6e306a`）合入 main，带来共用的 `selectSnapshot` 和 check-required 模块，一致性测试把本工单的文件列为「合并后再采用」。协调者转达的合并流程（维护者「同意」）要求：变基到新的 main 后改用共用模块，这次代码改动放进本包的审查。变基干净，没有冲突。

改动：

- 选快照：训练和缺口改用共用 `selectSnapshot`。FO1-1（安全类）的库存时间规则移进共用函数，做成选项 `newestInventory`：MAA 快照有仓库数量时，森空岛快照没有仓库（`maa-default`）或读取时间早于 MAA 的仓库扫描时间（`maa-inventory-newer`）就仍用 MAA 快照；只有训练和与它共用快照的缺口打开，其他调用方不变。计划和结果的 `snapshotUsed` 改用共用的说法：`chosen`（`explicit`、`maa-default`、`skland-covers`、`maa-inventory-newer` 等）和 `lacking`，保留 `file`；回复里的快照一行用共用的 `snapshotSourceLine`。新场景 `training-chain-skland-facts` 的期望随之改写。
- check-required：训练的 63 个、缺口的 8 个原因码并入共用目录（与已有的三个合用一条），`training-plan`、`training-time`、`cultivation-gaps` 成为列出的生产方；`training-state.ts` 不再有自己的表，`cultivation-gaps.ts` 的表删掉；计划里各处停下（apply、close、reconcile）都经共用构造函数。共用结果加可选的 `details`：只放静态值（问题代码、ID、档次、版本号），构造函数只留整项静态的条目，谓词拒绝其他，因为维护者要具体的缺项、共用形状原先只许五个键；`code:detail` 形式的静态代码按代码归类、细节放 `details.detail`。五条文字为符合共用目录的静态文字规则改写（不含 `<…>` 占位、核对项不少于 8 个字）。一致性测试去掉「合并后再采用」，三个脚本列入生产方，`training.md`、`gaps.md` 列入使用方，`training-plan-check-required` 列入退役代码；新增 `details` 的测试和三个 CLI 设置读不了时的行为测试。
- 文档：`training.md`、`gaps.md` 写明共用的选快照规则和 `reason`、`check`、`alternatives`、`details`；maa-core 的核对项一条补上 `details`；规格两张来源表各加一行。

轮次授权：本包已在第 4 轮 GO；这次是合并带来的新代码改动，协调者要求放进本包审查。维护者 2026-11-11 原话「以后这种情况可以你自己授权，最好压缩复核轮次」（2026-11-14 重申），修复会话据此授权第 5 轮，只复核这次改动。

### 第 5 轮结果

范围 `985b60c..5640f10`。结论 NO-GO：P2 1，P3 2，没有安全类发现。审查员核实：不带选项的调用方（base-query、cultivation-report、operator-cost、stage-jobs）行为不变；原因码目录完整；退出码和标准输入拒绝的形状不变；`code:detail` 只影响训练和缺口两个生产方；details 不输出路径、原话或干员名；一致性测试完整枚举生产方和使用方；场景 `training-chain-skland-facts` 仍能区分对错。逐个运行 9 个测试文件共 84 个通过，类型检查通过。

| 编号 | 发现 | 结论 | 理由 |
| --- | --- | --- | --- |
| FO5-1（P2） | 真实数据下 `training-facts-required` 的 `details.stages` 整项丢失：助手问题码带固定表 buffId（如 `train_spd_reduceTime[000]`，含方括号和 &），数组上限 200 也装不下一个账号的全部干员 | 接受 | 有离线复现，`985b60c` 照常输出；维护者要的具体缺项因此丢失；规格对静态值的定义本来接受这些字符 |
| FO5-2（P3） | MAA 仓库识别为空时导入器写 `partial` + `empty-recognition` + 空物品，`newestInventory` 把它当成有库存去比时间，弃用完整的森空岛快照 | 接受 | 有离线复现；FO2-4 同一条规则的回归，训练因此读不到专精和训练室等级；库存为零所以不会多花 |
| FO5-3（P3） | reconcile 清理结果是 check-required 时输出丢了 `versions` | 接受 | training.md 写明 reconcile 的返回都带 `versions`，read 拿不到这个比较 |

审查员另列一项不算缺陷：MAA 快照存在但读不了时，共用函数会改读森空岛快照（旧版拒绝）；写入器带锁、`fsync` 并原子替换，只有外部损坏或权限被改才会出现，修复会话同意按正式环境几乎不会发生处理，不修。

修复：

- FO5-1：静态值按规格定义：不含空格、斜杠、反斜杠的可打印 ASCII（方括号、& 等都算），数组上限 2000、对象 200 个键。测试 `ticket 32 FO5-1`（真实形状的 buffId 问题码、600 名助手）。
- FO5-2：`newestInventory` 只在 MAA 快照真有物品时才算有库存。测试 `ticket 32 FO5-2`。
- FO5-3：reconcile 的 check-required 输出经 `reconcileCheckRequired` 一处构造，带计划 ID、状态、档次和 `versions`。测试 `32 FO5-3`。

审查员的四份复现脚本在修复后的树上：两种 `stages` 情形都保留；空识别的 MAA 快照下读森空岛快照、训练拿到专精和训练室等级；reconcile 输出带 `versions`。

轮次授权：第 5 轮后仍有接受的 P2（FO5-1），按维护者「以后这种情况可以你自己授权，最好压缩复核轮次」授权第 6 轮，复核本轮修复。

### 第 6 轮结果

范围 `5640f10..913dd78`。结论 GO：没有发现。审查员核实：新字符集正好是「可打印 ASCII，去掉空格、斜杠、反斜杠」，与规格一致；固定表 110 个训练室 buffId 全部通过，450 名助手 × 3 档的 `stages` 完整保留；路径、空格、中文、控制字符、超长串仍被丢掉、谓词拒绝；带 `details` 的生产方只有 `training-plan.ts`，放进去的只有问题码、干员 ID、UUID、档次和校验过的版本号。`newestInventory` 在 MAA 快照有数量时没有任何路径让开训门读到更旧的森空岛库存（矩阵 2800 种组合，只剩已记录的「MAA 快照读不了」）；reconcile 输出带计划 ID、状态、档次和 `versions`。逐个运行 9 个测试文件 83 个通过，类型检查通过。

审查员另记两条观察，不算缺陷，不修：`check-required.ts` 的注释说地址不会通过，但 `127.0.0.1:5555` 这类主机端口能通过（新旧都一样，目前没有生产方放地址）；`docs/check-required-verification.md` 仍把训练文件写成「合并后再采用」，那是关卡作业修复包当时的验证记录，保留原样。

冻结 `913dd78` 全量离线检查 1355 通过、0 失败、2 跳过。

本包审查结束：没有未关闭的 P1、P2。
