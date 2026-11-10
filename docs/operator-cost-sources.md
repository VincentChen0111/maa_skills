# 13 成本来源与算法核对

核对日期：2026-11-11。只读固定公开数据与维护者明确提供的原型文件；不读取私人账号或缓存，不运行原生产项目。本仓库只保存指纹、接口事实和合成测试，不保存游戏表。数据获取由共享 `public-data.ts` 完成，详见[公共读取记录](public-data.md)。

## 固定公开资料

主源为 [Kengxxiao/ArknightsGameData 固定目录](https://github.com/Kengxxiao/ArknightsGameData/tree/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel)，完整提交 `6f63c14e27b847ef74b53b00fe51fc322b3cd7ff`。它是游戏数据的社区镜像，适合作为该版本的成本事实来源，不能保证当前游戏已更新部分仍一致。

| 文件（均在 zh_CN/gamedata/excel） | 核对事实 | 原响应 SHA-256 |
| --- | --- | --- |
| character_table.json | 目录含 char_ 干员以及 token_/trap_ 记录，isNotObtainable 单独不能排除召唤物；phases 的升级上限和 evolveCost；allSkillLvlup 的 lvlUpCost/unlockCond；skills 的 levelUpCostCond，按原数组位置逐级取数 | `eb6fff6fb3ce605bd60db2206a644625a3d145b4c46fa126f218cd51df4f1f1d` |
| char_patch_table.json | patchChars 提供形态记录；同名形态不能默认共用当前练度 | `f1c48737f63fa1ad1c189a3dd865920b54f062700280984aaf73f737791dc14a` |
| gamedata_const.json | characterExpMap 与 characterUpgradeCostMap 按精英阶段及当前等级减一索引；evolveGoldCost 按稀有度减一及精英阶段索引，负哨兵不是免费 | `f665c62e5da9804792a65cb54c03532e8af66fcc4e1b4059f91fc21b338f3534` |
| uniequip_table.json | charEquip 与 equipDict 对应干员；itemCost 按 1/2/3 级取数，4001 为龙门币；unlockEvolvePhase/unlockLevel 是练度前置；任务和信赖不由快照验证 | `ea9c66d111aa80662c7f89585f76fd2e4799bbe7c3a6ea8c0af78c0fd9311869` |
| item_table.json | items 的材料名称；expItems 的 gainExp，仅用于已知经验卡库存的算术合计 | `e984beb8e175d047699ab114aa4283d5f67984a80c2df6dd64b3b9e42af1aff3` |

核对源为 [arkntools 固定数据目录](https://github.com/arkntools/arknights-toolbox-data/tree/a07b4255b43a7171e519b26a13ddb12668a2cf0a/assets/data)，完整提交 `a07b4255b43a7171e519b26a13ddb12668a2cf0a`。该社区整理数据只作差异检查，不作为主源缺项的替代值。

| 文件 | 核对范围 | 原响应 SHA-256 |
| --- | --- | --- |
| cultivate.json | evolve、skills.normal、skills.elite、uniequip 的逐级成本；干员键去掉 char_，技能名方括号数字对应下划线数字 | `fe1ea00f86a5947af30599bf0878e9f93769ccd656da3db7c1446dafb69ea186` |
| level.json | characterExp、characterUpgradeCost 的相同阶段和等级索引 | `c37f97c7ecf98ad2c25d536af71eaea61b33ffb34b482bd0108b4c28a8e4ed89` |

实际读取时间为 UTC `2026-11-10T17:47:10.634Z` 至 `2026-11-10T17:47:12.440Z`，对应本地 11 日；不是上游更新时间。运行时每次返回实际来源 URL、提交、文件、字节数、SHA-256 和读取时间，不把上述核对指纹硬编码成假读取结果。一次公开表结构探针采用虚构当前练度，成功产出 3 个专精和 3 个模组步骤；核对源省略模组龙门币产生 3 个差异，主源金额保持不变。此探针只核对 schema，不是账号基线或真实培养验证。

R1 修复时再次只读核对同一固定表：Mon3tr 的 `char_4179_monstr`、`token_10002_kalts_mon3tr`、`trap_624_xb2mtr` 均有 `isNotObtainable: false`，后两项 profession 为 TOKEN/TRAP。培养候选因此限定为可获取的 char_ 干员，保留真实 char_ 形态的同名消歧。虚构精零 1 级到 2 级的结构探针按名称只选出干员，得到经验 100、龙门币 30。专精前置来自对应 rank 的 unlockCond；当前与目标相等也不能跳过，当前已拥有的普通技能/专精/模组另用当前练度核对，已有专精还要求当前普通技能 7 级，不以未来目标练度代替。

## 原型适配边界

维护者提供的原型只作为通用算法参考，新实现通过导出函数/CLI 接缝重新编写，使用 Node 内置能力；原文件未修改。没有复制私人绝对路径、账号基线、个人策略、凭证决策、训练助手、理智估值或加工方案。原型没有作为第三方源代码导入；这里记录文件内容 SHA-256，而非宣称未知的公开提交号。

| 原型相对文件 | 读取内容 SHA-256 | 采纳/舍弃 |
| --- | --- | --- |
| cultivation/tools/cost-calc.mjs | `9490463ef767ba966019f0be6d471712a2249e82e72fcfa825c50040ed032894` | 逐级差分与材料/LMD 合计；舍弃缺省练度与缺库存补零 |
| cultivation/tools/build-cost-data.mjs | `58227ed709f06e0fded101c8e3c823ca1d597e75d94146e9736cef25a2c843bb` | 表字段关系；缺失条目保持原索引，不过滤后错位 |
| cultivation/tools/fetch-cost-sources.mjs | `51dbb3a526537e744a25fdf5402a5f96fe6bae0b52aa8b5f5d5f0f89438db493` | 固定来源思路；下载由已单审的公共读取模块承担 |
| src/planning/cost.ts | `9b17a8e9588e5909783d7fedf0e1dbd327f1ecc3698bd0b05281f70f0875ce55` | 精英阶段满级后晋升并重置等级 1，再达到明确目标 |
| src/planning/cost-data.ts | `7c88f44b631d0955e3ddb5c526777f8b6f57e004794f6f2eb7adff37ee75632a` | 公共名称、形态与模组映射；不复用私人存储耦合 |

不加工只减已知物品/LMD 与完整已知的经验库存；未知差额为 null。模组的额外条件仍未验证，结果不是自动执行或采购建议。一图流与企鹅物流在该查询中没有必要，未读取也未打包其数据。接口见[成本查询](../skills/maa-account/references/cost.md)，验证见[13 验证记录](operator-cost-verification.md)。
