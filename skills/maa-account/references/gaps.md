# 加工与材料凭证缺口接口

Node 24 调用相邻 `../maa-core/scripts/cultivation-gaps.ts query`，通过标准输入传 JSON。Windows PowerShell 用管道传 JSON 时，非 ASCII 字符和 `?` 都写成 `\uXXXX` 转义；管道加在开头的 BOM 由脚本去掉，返回 `input-encoding-lossy` 时什么都没做，改成转义后重发。`query --no-craft` 选择不加工方案；JSON 的 `mode: "no-craft"` 等价。默认选择 `craft`。两种方案总是独立计算后一起返回，比较时不能把两者的分配加在一起。缺共享脚本时按入口同版本安装指引处理。

只读已有 `account-snapshot.json`、设置和固定公开表；可用 `snapshotFile` 明确指定快照。此接口不刷新识别、不写报告、不加工、不兑换、不做设备或采购操作。旧 `operator-cost.ts query` 的单目标 `raw` 和纯库存 `no-craft` 接口保持原有含义；涉及材料券或共同库存时使用本接口。

1. `targets` 按用户给定顺序列出明确目标。每项使用[成本接口](cost.md)的 `name`、可选 `operatorId`、`target` 和可选 `current`，不放 `mode`。同名歧义、缺练度或成本时先核对；任一目标总成本未知时不分配共享库存。相同干员重复出现需合并目标，避免重复收取晋升或前置成本，不自行选择较高目标。
2. 快照未提供的库存可在 `inventory: {source: "user-confirmed", items: {物品ID: 数量}, lmd: 数量}` 补齐。只传用户确认的事实；明确 0 与未知不同，已知冲突返回待核。`items` 不放 `4001`，龙门币用 `lmd`。不要根据识别完成或未列物品推断全库存为零。
3. 配方条件在 `progress` 中补充，须 `source: "user-confirmed"`。`rooms` 是房间类型到等级数组，例如 `WORKSHOP: [3]` 表示一间三级加工站；按配方的等级和房间数核对。`stageRanks` 使用公开 `requireStages.stageId/rank` 原字段，值 0–2；工具返回关卡 ID 与公开关卡代码以便核对。所读来源只证明配方门槛为 2，不证明星数对应；不要把用户给出的星数自行换算为原码，也不要让普通用户猜数字。用户只说「这些关卡都通关了」时，不填 `stageRanks`，把工具报出的关卡 ID 原样写进 `confirmedStages`（见下文）。缺事实时说明具体配方/关卡条件待核；仅有带真实依据的明确补充时录入。能查询到配方不等于当前已解锁。
4. 仅对实际相关的券核对有效性：`progress.voucherValidity` 按券 ID 给 `true`（用户确认当前有效）或 `false`（用户确认当前不可用）。五类支持券的有效性均须确认，未确认或数量未知不算已核覆盖。`*_perm` 只标 `permanent-name-inference`，不能由名字或缺 expiry 推定有效；两类限时券为 `timed-explicit`。同名但不同 ID 的券不可混算。零库存无需再追问有效性。
5. 返回 `needs-input` 时 `raw/comparison` 为 null，不宣称已满足。`partial` 表示比较中仍有未知；只陈述已核覆盖及具体待核项。`ok` 只是选定方案的输入与算术已知，仍可能有正缺口，也不证明游戏此刻可执行。保留当前心情、生产排队、模组任务/信赖等未核实状态。

## 分配与解释

先按目标顺序给全部原始材料和龙门币需求保留已知库存，再使用余量加工。配方沿用公开 `F_EVOLVE/F_SKILL` 及制造站双芯片 `F_ASC`，只计确定主产物；不计随机副产物。加工费用计入 `goldCost`，制造费用从其完整 `costs` 列表合计，不能把坏表或缺独立加工费用当零。

随后对原始剩余材料作直接券覆盖，处理重叠候选并守恒；每张已确认有效的支持券只领取一份，范围来自物品表反向 `voucherRelateList`。开启加工时，剩余券还可在已确认条件下换取下级投入并继续递归加工。每条尝试包含材料、券和龙门币，失败整条回滚。原始需求已保留的材料/券不能再被另一目标或加工消耗，批量余量可以被后续需求复用。

这是确定性的可行路线选择，未穷举替代路线，不承诺经济最优、最小总缺口或最佳券价值。`policy` 明示该边界；不能把“本方案仍缺”说成“任何方案都不够”。不同资源的原始保留优先于加工，多个目标按输入顺序获得各类覆盖。

`comparison.craft/noCraft` 的材料行保留 `required/available/existing/crafted/voucher/remaining`。`voucher` 列只记直接覆盖；券变成加工投入的最终产物记在 `crafted`，过程在 `route` 和 `voucherAllocations` 展示，不能把两列重复相加。`remaining: null` 是待核；已知原始需求减已有/已知加工/已知券得到的数值，只能称“已核覆盖后差额”。`targets` 列出各目标分配，`steps` 列配方及费用，`ledger` 对所有相关材料/券满足期初＋加工产出＋券产出＝目标分配＋投入/券消耗＋期末。

`route` 是建议先后顺序；按它展示券选择、配方、投入、产出及费用。龙门币总量为原始培养费用加建议加工费用，经验沿用 13 的全部经验卡数量已知才折算规则。原始逐级成本、核对差异、快照时间、每份主表与核对源的提交/hash/实际读取时间保留在 `costs`。arkntools 只核对原始成本，不覆盖主源，也不声称其核对了加工配方。

## 合成输入

```json
{"targets":[{"name":"合成干员","target":{"elite":1,"level":1}}],"progress":{"source":"user-confirmed","rooms":{"WORKSHOP":[3]},"stageRanks":{"stage_synthetic":2},"voucherValidity":{"premium_material_voucher_perm":true}},"format":"markdown"}
```

配方的房间条件：用户确认的 `progress.rooms` 优先；没确认的房间用快照基建（完整读取时）里同类房间的等级，例如制造站 → `MANUFACTURE`，结果 `inputSources.rooms` 写明每个房间等级来自 `user-confirmed` 还是 `snapshot`；加工站（`WORKSHOP`）快照里没有，仍要用户确认。关卡条件报成 `stage:<ID>:unknown`（`stageCodes` 给关卡代号）时，用户一句话确认「这些都通关了」，就把报出的这些 ID 原样写进 `progress.confirmedStages:[...]`；只接受某个配方确实要求的关卡 ID，其余以 `progress:confirmedStages:invalid` 拒绝。没给 `snapshotFile` 时按需要的内容选快照（干员、技能专精、仓库、基建）：默认快照缺而森空岛快照覆盖得更多、且森空岛读取时间不早于默认快照的仓库扫描时间时整份读森空岛快照，不合并；森空岛更旧时仍用默认快照（`default-inventory-newer`）。结果的 `snapshotUsed` 写明读的哪份、来源和读取时间。

`format` 为 `json`（默认）或 `markdown`，同一计算结果渲染；模板中文，按保存的回复语言转述。退出 0 仍需检查 `status`。非法命令/JSON、快照不可读或主源失败退出 1：标准输入本身不合格时输出 `{ok:false,error:<代码>}`；其余输出 `{ok:false,status:"check-required",reason:<稳定代码>,check:<要核对什么>,alternatives:[<替代做法>]}`，按 `check` 核对并把替代做法告诉用户，不输出路径或原始系统信息。数值、来源和待核项齐全后结束查询，不自动保存或执行建议。

共享导出：`calculateCultivationGaps(tables, snapshot, input)`、`queryCultivationGaps(input, {home?, fetcher?})`、`formatCultivationGapsMarkdown(result)`。`fetcher` 只注入网络边界；测试用真实临时文件及合成数据。配方来源由 `craftingSources` 固定，成本来源沿用 `operatorCostSources`；不随 skill 打包游戏表。来源细节在仓库 `docs/crafting-sources.md`。

## 展开到基础材料（工单 32）

维护者 2026-11-16：缺口要说到基础材料，龙门币和其他缺口都是推进中逐步补齐的，不能据此判断计划。`comparison.craft.decomposition` 把开启加工方案里还缺的成品（含覆盖路线因条件未确认而没算进去的部分）按现有库存逐级拆到基础材料：

- `short` 是还要获取的基础材料（刷关或其他途径），`fromStock` 是加工能用上的现有库存，`steps` 是建议的加工，`craftingLmd` 是补齐缺口还要的加工费，`lmdGap` 是龙门币总缺口（直接需求加全部加工费减库存，库存未知时为 null）。龙门币不够不会让展开停下，单列为缺口。
- 配方条件没确认时照样展开，`assumptions` 列出所依据的假设（`stage:<关卡ID>:unknown`、`room:WORKSHOP:unknown`、`inventory:<物品>:assumed-zero`）。回复时把这些标成假设，或者用一个问题一次问清（关卡用返回的公开关卡代码，例如「这些关卡你都通关了吗：…；加工站几级？」），不要逐个追问，也不要因此不给展开。用户确认后再把事实放进 `progress` 重新计算。已确认未解锁的配方（`pending`）按成品获取。
- `vouchers` 是不依赖数量的材料券建议：每种券能兑换的缺口按缺得多的排序。回复时先问用户各券数量和是否有效；用户不回答，就按这个顺序给建议（例如「有这种券的话，优先换 X」），不编造数量，也不把券算进已核覆盖。
- 回复里说清还缺什么（成品、基础材料、龙门币），并说明可以在推进中逐步补齐；不要说计划不可行、不能计算或要调整顺序，除非用户问的就是顺序。展开只是建议，不加工、不兑换。
