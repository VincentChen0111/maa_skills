# 14 加工与材料券来源

核对日期：2026-11-11。主源固定为社区游戏数据镜像 `Kengxxiao/ArknightsGameData@6f63c14e27b847ef74b53b00fe51fc322b3cd7ff`，不是官方执行实现，也不保证当前服务器数据不变。只读公开表与维护者提供的通用原型，未读取真实账号或运行原项目。

| 固定公开文件 | 原响应 SHA-256 | 本次读取 UTC |
| --- | --- | --- |
| [building_data.json](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/building_data.json) | `8b4000197acf12565b154e870266e9a2b6ab7dac2f11fbfcf32feba6063855f7` | 2026-11-10T19:09:01.902Z |
| [item_table.json](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/item_table.json) | `e984beb8e175d047699ab114aa4283d5f67984a80c2df6dd64b3b9e42af1aff3` | 2026-11-10T19:09:02.195Z |
| [stage_table.json](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/stage_table.json) | `499319a48326de0f915c9f4b5e750a9bf946ad73b2bb56797ba8718af468ce84` | 2026-11-10T19:09:02.976Z |

运行时由已单审的 `public-data.ts` 实际获取与计算 hash、字节数和读取时间，不把上表当作当前请求的结果。公开原表仅留本机忽略目录，测试与评测全部合成。主成本与 arkntools 固定核对表沿用 [13 来源记录](operator-cost-sources.md)，核对差异不修正主源。

## 配方与费用

`workshopFormulas` 的 `formulaId/itemId/count/costs/goldCost/requireRooms/requireStages` 描述确定主产物、投入、独立龙门币费用及解锁条件；`apCost` 沿原型以 360000 单位折合一份基础心情，只作配方信息，不证明当前干员心情足够。随机额外产物不作必得收入。

固定表的 39 条 `F_EVOLVE`、2 条 `F_SKILL` 均有 `goldCost`、一次产 1，未出现同产物多配方；这是本版本事实，不能外推到任意类别或未来版本。坏字段、重复候选、循环或安全整数溢出保持待核。共享算法支持合成测试中的批量产出，余量归同一账本。

`manufactFormulas` 是另一结构：8 条双芯片 `F_ASC` 没有 `goldCost`，完整 `costs` 只有职业芯片组及助剂；同集合其他配方会把 `4001/GOLD` 直接列在 `costs`。因此制造按完整投入向量累计 LMD，固定双芯片列表的合计为 0；并非缺 `goldCost` 一律免费。加工的独立 `goldCost` 缺失则非法。

房间条件有类型、等级和数量，未知不能通过。该固定表的加工关卡门槛只出现 `rank=2`，所读主表没有提供数字与星数的可靠对应；保留原码，关卡代码只来自 `stage_table.stages[id].code`。空条件数组表示该配方没有列出该类条件；缺字段/null 不等于空数组。条件与库存满足也不能证明即时心情、容量或排队可执行。

## 材料券规则及未证实事实

反向读取材料的 `voucherRelateList`，只取 `voucherItemType=MATERIAL_ISSUE_VOUCHER`，并核对券记录的同一类型。该关联只带券 ID 和类型，不带数量；每券一份的规则来自以下五个固定 ID 的 `usage`，不能推广到任意新券、芯片自选券或其他道具。

| 券 ID | 分类依据 | 本版本关联数量 |
| --- | --- | --- |
| `advanced_material_issue_voucher` | usage 明说限时 | 21 个 TIER_3 |
| `premium_material_issue_voucher` | usage 明说限时 | 21 个 TIER_4 |
| `advanced_material_voucher_perm` | `_perm` 命名解释，未证明永久有效 | 21 个 TIER_3 |
| `premium_material_voucher_perm` | `_perm` 命名解释，未证明永久有效 | 21 个 TIER_4 |
| `precious_material_voucher_perm` | `_perm` 命名解释，未证明永久有效 | 6 个 TIER_5 |

五者均无 expiry，也都没有 `itemTimeLimit` 记录；缺字段不能区分永久和限时。额外只读同提交 shop/gacha/text/constant 表也未得到明确永久有效枚举或 rank 星数映射，不据此断言所有资料都没有。实现将命名解释标为 `permanent-name-inference`，限时文本为 `timed-explicit`；实际相关券的当前有效性均由用户明确确认，数量未知仍未知。同名券按 ID 分开，不合并批次有效性。

主表支持“券换下级材料再加工”的算术链：例如高级券关联固源岩组，公开配方可用其加工提纯源岩；特级券也可给聚合剂配方提供不同投入。这些是表间关系推导，不是游戏执行结果。实现保留具体选择、批次、条件、费用和路线顺序，材料与券各扣一次；关闭加工时不把下级材料当最终产物。

## 原型、隐私和许可

只读参考文件与内容 SHA-256 沿用 [13 的五份原型指纹](operator-cost-sources.md#原型适配边界)。本次采用库存扣减、配方输入/产出、房间/关卡约束、凭证反向关系的通用思路，独立重写为单个共享模块。舍弃私人路径、账号默认值、缺库存补零、默认全解锁、材料价值策略、未来刷取输入假设、助手加成与原项目持久化。原型和原项目未修改、未运行。

按原始需求保留、输入顺序分配、可行递归加工、重叠券匹配与失败事务回滚为本次实现选择；未穷举全部替代分配，不称经济最优。来源不足的事实保持待核，来源解释与用户确认分开。没有复制第三方算法源代码或游戏表；游戏数据权利不随本仓库 MIT 转移，见[第三方声明](../THIRD_PARTY_NOTICES.md)。
