# 基建报告接口

基建建议报告：按用户的布局、目标和账号快照给出一份可以交给 maa-daily 的排班，说明每项收益的依据、条件和未建模部分，事实和推断分开。排班的生成和检查用共享的 [排班生成与检查](../../maa-core/references/base-plan.md)；保存、默认独立审查、明确跳过、改正和逐项批准用共享的 [建议报告与独立审查接口](../../maa-core/references/advice-report.md)，做法和培养报告一样。需要 Node 24。

随口问答（谁能进制造站、某个干员的基建技能）不出报告：前者用 `base-plan.ts candidates`，后者用 [基建技能查询](../../maa-core/references/base-query.md)。

## 命令

`node <maa-core>/scripts/base-report.ts <动作>`，参数经标准输入传入。动作 `draft`、`read`、`brief`、`review`、`fail`、`skip`、`approve` 的用法和 [建议报告接口](../../maa-core/references/advice-report.md) 一样，另有：

| 动作 | 输入 | 结果 |
| --- | --- | --- |
| `draft` | 方案（见排班接口）`+ goals, assumptions?, summary?, target?, base?, snapshotFile?, tablesFile?`；改正时加 `revisionOf` | `{ok, status, reportHash, reference, applicable, planFile, unverified, items}`；输入不全时 `{ok:false, status:"needs-input", issues}`，不保存 |
| `freshness` | `{reportHash}` | `{ok, states, recheck}`：账号快照、基建技能表、MAA 干员名表、排班文件和检查结果各是 `fresh`、`stale` 或 `unknown`；检查结果不新鲜时，`recheck` 是用当前数据重新跑的检查（不改报告） |

- `goals`：`{source:"user-stated", text:"用户的原话"}`；用户没说目标时先问，或写出假设 `{source:"assumed", text}`，报告标为假设。缺少时不保存报告（`goals-required`）。布局也必须是用户说的；缺少时 `layout-required`，先问用户。
- 报告里的事实：工具导出的排班文件和它的 SHA-256、每名干员的持有和有效技能（21 的查询，条件原文保留）、校验规则和 15 项验收门的结论、固定表和名表的来源。推断：目标为假设时的目标、安排理由、心情速率、组合、互斥、效率数字、假设和总体推断。
- 条目只有一个：`P1` 应用这份排班文件。范围写明 maa-daily 只能把这一份文件（路径和 SHA-256）写进 MAA 的自定义基建设置，写之前要重新跑全部校验和验收门、核对数据新鲜度、把未核实的项交用户决定；不包括切换生产线、训练室、刷关、碎石和用药、抽卡礼包付费登录、maa-account 写 MAA 配置、点游戏或操作设备。
- 方案不可应用（有错误或不通过的验收门）时报告照常保存并写明是哪一项，但 `approve` 拒绝 `P1`（`base-plan-not-applicable`）。未核实的项记进批准范围。
- 改正时只比较内容：哪些结果变了只由 `changedReportResults` 一个函数判断（快照内容、干员事实、检查结果、排班文件、名表、固定表、协议版本），读取时间不算。

退出码与错误代码同建议报告接口；本入口另有 `base-action-invalid`、`base-input-invalid`、`base-plan-not-applicable` 和排班工具的 `plan-*`。

## 边界

maa-account 只写报告和私有目录里的排班文件，不写 MAA 配置，不执行排班；批准的排班由 maa-daily 按 [基建排班应用](../../maa-daily/references/base-apply.md) 重新检查后写进 MAA；审查通过不等于批准，批准不等于执行。抽卡、礼包、付费、登录任何情况下都不碰；结果未知只核对、不重放；不点游戏、不操作设备；不输入凭据，不打印凭据。
