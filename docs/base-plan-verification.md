# 22 基建建议与排班生成：来源核对与验证记录

核对日期：2026-11-13。工单见 [22](issues/22-base-report-and-plan.md)，接口见 [排班生成与检查](../skills/maa-core/references/base-plan.md) 和 [基建报告](../skills/maa-account/references/base-report.md)。本页只记事实来源、实现时定下的判定条件、实际运行过的检查和未验证项；MAA 源码只读到被忽略的临时目录，没有复制或打包 MAA 代码、资源或游戏数据。

## MAA 事实（固定 v6.21.4，提交 `52d0b2acaca116585b02e1e6a9da303460f81a24`）

指纹是该文件在这个提交里的 Git blob SHA。这一节的条目要登记进 [25](issues/25-maa-version-verification.md) 的依赖清单（25 在别的分支，合并时补上）。

| 采用的事实 | 文件与行 | blob |
| --- | --- | --- |
| 排班文件字段：`title`、`description`、`plans[].name/description/description_post/period/duration/Fiammetta/drones/groups/rooms`；房间对象字段 `operators/sort/skip/autofill/product/candidates/use_operator_groups`，训练室另有 `operatorsA/operatorsB` | [base-scheduling-schema.md 第 20–167 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/docs/zh-cn/protocol/base-scheduling-schema.md#L20-L167) | `c536a3854929bdf1768df0691d9a501bbac162cc` |
| `period` 写 `hh:mm`，只比较数字大小，跨天拆成两段（示例 `22:00–23:59` 加 `00:00–06:00`）；没有 `period` 时每次换班后切到下一个计划；core 不处理这个字段 | 同一文件第 31–44 行 | 同上 |
| `duration` 是保留字段，目前没有作用 | 同一文件第 45 行 | 同上 |
| 菲亚梅塔 `enable/target/order`（`pre`/`post`）；无人机 `room` 只取 `trading`/`manufacture`，`index` 取 1–5，`order` 取 `pre`/`post` | 同一文件第 46–59 行 | 同上 |
| 设施键取值十个；缺少某个设施键时该设施用默认算法换班；数组比房间少时从第一个未配置的房间起不换班；空数组表示整个设施保持原样；`skip` 跳过换人和换产物 | 同一文件第 71–79 行、第 99–100 行 | 同上 |
| 产物取值 `Battle Record`、`Pure Gold`、`Dualchip`、`Originium Shard`、`LMD`、`Orundum` | 同一文件第 108–110 行 | 同上 |
| 扩充协议的顶层 `layout`、`operators`、`metadata` 是可选字段，工具导入、编辑、导出时应保留 | 同一文件第 175–246 行 | 同上 |
| 解析入口：`plan_index` 只要求落在 `plans` 范围内，没有计划数上限 | [InfrastTask.cpp 第 298–320 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Interface/InfrastTask.cpp#L298-L320) | `3f4fd2c56214df307f230a627a7f2f0ca3171643` |
| 产物字符串区分大小写；不认识的产物保持 Unknown，照常换人但不校验、不更换产物 | 同一文件第 343–361 行 | 同上 |
| 设施键按字符串精确比较，不认识的键（包括大小写写错的）记一条警告后跳过 | 同一文件第 441–474 行 | 同上 |
| 菲亚梅塔：目标为空时不使用；先把目标放进第一间宿舍，再按「目标、菲亚梅塔」排序进驻；干员名写死为「菲亚梅塔」；`order` 不是 `post` 时在换班前执行 | 同一文件第 478–527 行 | 同上 |
| 无人机：`index` 减一后使用；`room` 不是这两个值时报错 | 同一文件第 528–551 行 | 同上 |
| 自定义模式下识别到的产物和设定不一致时直接更换产物：制造站作战记录（中级）、赤金、源石碎片，贸易站龙门币、合成玉订单；双芯片没有更换实现；更换失败只报错，不阻断换人 | [InfrastProductionTask.cpp 第 48–232 行、第 399–411 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Infrast/InfrastProductionTask.cpp#L48-L232) | `d422a66f8e64bfe779b661d5269583a3693c5b76` |
| 换班按识别出的名字和配置里的名字逐字相等来认人（识别结果先经 `CharsNameOcrReplace` 替换）；查不到职业的名字（拼错、数据未收录）只能在全部列表里兜底 | [InfrastAbstractTask.cpp 第 588–604 行、第 785–800 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Infrast/InfrastAbstractTask.cpp#L588-L604) | `a736eccf0bf32f165f40b58930ffc48b512c179e` |
| MAA 的干员名表来自 `resource/battle_data.json` 的 `chars[*].name`（另有 `name_en/jp/kr/tw`），职业解析为无人机以外的才算干员名 | [BattleDataConfig.cpp 第 14–39 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Config/Miscellaneous/BattleDataConfig.cpp#L14-L39) | `c0a37116b6f7a494864466f0b1f5acd175318ce8` |
| 名表文件本身 | [resource/battle_data.json](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/resource/battle_data.json) | `cbba352cb277242b2e3a0d952c186df75b077220` |
| 图形界面读 `period`：每段必须正好两个时间，用 `TimeOnly.Parse` 解析 | [CustomInfrastConfig.cs 第 72–117 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Models/CustomInfrastConfig.cs#L72-L117) | `bac7c7315b47e2d5f0972ee212bcbbbf7a8b66e9` |
| 有计划带 `period` 时默认按时间轮换；只有部分计划带 `period` 时提示警告；按时间选计划时取文件里第一个「任一时间段包含现在（两端都含）」的计划，找不到就用第 0 个计划并记错误 | [InfrastTaskUserControlModel.cs 第 481 行、第 579–582 行、第 782–794 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UserControl/TaskQueue/InfrastTaskUserControlModel.cs#L782-L794) | `f8aa23bbb86ec3aa7379e327c33589a6bb1820ed` |

由此得出的结论（核实后采用）：

- **时间段重叠时 MAA 选哪一个**：选文件里靠前的那个计划。所以检查把两个计划的时间段重叠（`a 开始 < b 结束` 且 `b 开始 < a 结束`）记为错误 `period-overlap`；首尾相接（一个在 08:00 结束、另一个在 08:00 开始）不算重叠，是覆盖全天的写法。
- `hh:mm` 写不出 24:00，`23:59` 结束的计划在 23:59 到 24:00 这一分钟不被选中，MAA 用第 0 个计划。这是协议本身的写法，检查把 `23:59` 当作一天结束，只在验收门 14 的证据里说明这一分钟。
- **计划数上限**：MAA 没有上限，只要求 `plan_index` 在范围内。所以「计划数上限」这条规则实现为：至少一个计划，并且等于用户的班次数（`plan-count`），不另编一个经验上限。
- **生产线**：规格「共享工具」写的是「MAA 不能切换生产线」。固定版本的源码里，自定义模式写了产物、而游戏里的产物不一致时，MAA 会尝试切换（双芯片除外）。所以这条规则实现为「方案不依赖 MAA 切换生产线」：导出时不写产物字段；检查已有排班文件时，产物必须是 MAA 认识的值、属于该设施，并且和用户布局里的当前产物一致，否则是错误（`product-invalid`、`product-switch`）。规格正文已经改成这个说法，需要维护者知道这一差异。
- **键名大小写**：设施键和字段名都按字符串精确比较，写错大小写的键被当作不认识的键跳过，所以大小写写错是错误（`key-case`）；导出时基础文件里大小写写错的已知键会去掉并在结果里列出。

## 游戏数据（固定 `Kengxxiao/ArknightsGameData@6f63c14e27b847ef74b53b00fe51fc322b3cd7ff`）

| 文件 | 本次读取字节的 SHA-256 | 采用的事实 |
| --- | --- | --- |
| `zh_CN/gamedata/excel/building_data.json` | `8b4000197acf12565b154e870266e9a2b6ab7dac2f11fbfcf32feba6063855f7`（与 [21 的记录](base-sources.md) 相同） | 房间容量 `rooms.<房间>.phases[等级-1].maxStationedNum`、数量上限 `rooms.<房间>.maxCount`：控制中枢 1–5 人（随等级）、最多 1 间；制造站、贸易站 1/2/3 人、各最多 5 间；发电站 1 人、最多 3 间；宿舍每级都是 5 人、最多 4 间，床位总数 20；会客室 2 人；办公室、加工站 1 人；训练室 2 人；回收站 1/2/2 人。心情上限：438 名干员的 `maxManpower` 都是 8640000，`manpowerDisplayFactor` 是 360000，相除得 24。菲亚梅塔（`char_300_phenxi`）的宿舍技能 `dorm_exchangeAp[000]`「满心情时与前一位进驻的干员互换心情」和 `dorm_recExcludeOther[000]`「自身心情每小时恢复 +2，无法获得其他来源的恢复」 |
| `zh_CN/gamedata/excel/char_meta_table.json` | `0895129f25e053315eb9432d32810c9cf9d082f110818921de20ba86b9b92c11` | `spCharGroups`：同一干员的异格形态分组，430 组中 37 组有两个以上形态 |
| `zh_CN/gamedata/excel/character_table.json` | 见 [21 的记录](base-sources.md) | 干员名到游戏 ID，用于异格分组 |

工具运行时从这些固定地址读取，每次都重新从表里算：心情上限、床位和容量取自表；菲亚梅塔的恢复量取自技能原文里的 `+2`。表里得不出时这一项输出「未核实」，不用写死的数。离线提供的表（`tablesFile`）明确标为「所提供的离线表」，不冒充公开镜像。

`building_data.json` 的技能条目还有一个 `efficiency` 数字字段（条件类技能是 0），它是名义值，不代表条件满足后的收益，本工具不用它排名或计算。

## 规则和验收门的判定（实现时定）

六条规则：房间容量（`room-capacity`，布局外的房间 `room-missing`）、计划数（`plan-count`）、同一计划内不重复（`plan-duplicate`，宿舍也算）、键名大小写（`key-case`）、不依赖 MAA 切换生产线（`product-invalid`、`product-switch`）、未持有警告（`operator-unowned`）。另外：名字不在用户本机 MAA 名表里是错误 `name-unknown`，和未持有警告分开；名表读不到时记为未核实 `names:<原因>`；排班文件按显示名写人，固定表里有 9 个显示名对应两个游戏 ID（8 个是预备干员，只有「暮落」带基建技能），这时取快照里持有的那个形态；快照里一个都没有就是未持有警告，两个都有就记未核实 `ownership-ambiguous:<名字>`，技能按未知处理；时间段格式错误 `period-format`、重叠 `period-overlap`、只有部分计划带时间段 `period-mixed`。

15 项验收门，每一项都给出通过、不通过或未核实，并附证据；任何一项不通过或有错误，方案就不可应用；未核实的项单独列出，不算通过：

1. 同一计划内名字不重复（宿舍也算）；一个周期内同一 `spCharGroups` 分组只用一个形态。名字对不上唯一游戏 ID 或异格表不可用时未核实。
2. 容量和房间存在用固定表和用户布局判定；快照里没观察到的名字是警告，这一项记未核实（识别完成不代表名册完整，未观察不等于没有）。
3. 计划数等于用户的班次数；每个布局里有的设施都写了键，间数和布局一致；布局里没有的设施不写人。
4. 每名上班的干员：最长连续上班时长（按时间段排成一圈）× 每小时净消耗 ≤ 心情上限；一个周期的消耗 ≤ 在宿舍的时长 × 每小时恢复。速率是输入（报告里标为推断），没有速率或有计划没有时间段时未核实。菲亚梅塔的目标交给第 5 项。
5. 没有干员每个班次都在岗；菲亚梅塔的目标例外，但它每小时净消耗不能超过菲亚梅塔的每小时恢复（取自技能原文，固定表是 2）。推导：菲亚梅塔每次互换要先恢复到满，她能补给目标的心情每小时不超过她自己的恢复量。
6. 床位总数 = 布局里宿舍的床位之和（固定表）；常驻 = 每个计划都在宿舍且从不上班的人；每个计划里在宿舍的其他人 ≤ 床位总数 − 常驻人数。由 MAA 自动补满的宿舍在证据里注明。
7. 声明的组合：任一成员在上班的计划里，所有成员都在上班，依赖的挂件干员在岗或在宿舍。没有声明组合时未核实（本工具不从技能文字推断组合）；声明为空列表表示「没有组合」，记为通过并标明是推断。
8. 声明的互斥：同一计划里，贸易站和制造站里不能同时出现两名以上互斥成员。声明方式同第 7 项。
9. 制造站、贸易站里每名干员：有作用于该房间产物或不限产物的生效技能就通过；生效技能全部写明只作用于别的产物（固定表原文「作战记录类配方」「贵金属类配方」「源石类配方」「芯片类配方」，贸易站「赤金订单」「贵金属订单」「合成玉订单」）就不通过；技能状态待核时未核实；没有该房间技能的算填充，写进证据。
10. 控制中枢人数等于按等级的容量；同一个技能 ID 不在两名干员身上同时生效。
11. 每个计划最多一个无人机目标，目标在布局里（间号 1 到 min(5, 该设施间数)）；菲亚梅塔有目标、顺序是 `pre`/`post`、目标在这个计划里，并且快照里有菲亚梅塔（按她的宿舍技能找 ID）。协议每个计划只有一个菲亚梅塔对象，由 MAA 在换班这一次运行里使用，所以「只在班次开始时、每个节点最多一次」由结构保证。
12. 每条效率数字的总效率 = 基础 + 技能 + 全局；给了总数而对不上就不通过；每日数值 = 各计划总效率按时长加权平均。没有效率数字时未核实。
13. 生成时导出两次并读回写入的文件，三者逐字节相同；报告的新鲜度检查用报告里记录的导出内容和当前文件比较；不是本工具本次导出的文件未核实。
14. 时间段覆盖全天（MAA 在没被覆盖的时间退回第 0 个计划，所以有空档就不通过）；按容差（设计默认值 1 小时）把第 4 项再算一遍：连续上班加一小时、恢复少一小时仍不超限。没有时间段时 MAA 按顺序轮换，早晚上线不改变选中的计划。
15. 标题、计划名、描述、理由、依据、假设和总体推断里没有「最优」「最佳」「最好」「最强」「最高效」或 optimal/best 一类说法；用户自己的原话不算。

## 数据新鲜度（实现时定）

三态：新鲜、陈旧、未知。每一项都和报告生成时记下的内容比：

- 账号快照：比较干员 ID、名字、精英阶段、等级、干员识别状态和基建布局字段算出的指纹；读取时间和扫描时间不参与，晚些重读到的相同内容仍是新鲜。现在读不到或格式不对是未知。
- 基建技能表：比较每个固定文件的仓库、提交、路径和内容 SHA-256；现在读不到（例如断网）是未知。
- MAA 干员名表：比较 `resource/battle_data.json` 的内容 SHA-256；没设 MAA 目录或文件不在是未知。
- 排班文件：比较文件内容的 SHA-256；文件不在是未知。
- 检查结果：上面任何一项陈旧就是陈旧，否则有未知就是未知，全部新鲜才是新鲜。不新鲜时旧的检查结果不当作证明：`freshness` 用当前数据把检查重新跑一遍并返回新结果（不改报告），第 13 项拿报告里记录的导出内容和当前文件比较。

## 写排班文件

只写私有目录里的路径：路径解析后（包括经过链接）落在私有目录之外就拒绝（`plan-path-outside-private`），只接受 `.json`（`plan-path-invalid`）；先写同目录的临时文件再改名替换；默认文件名带内容哈希（`base-plans/plan-<前 16 位>.json`）。在已有排班文件上修改时（`base`，也必须在私有目录里），MAA 协议里的字段由本工具重写，其他字段（包括扩充协议的 `layout`、`operators`、`metadata`）原样保留，大小写写错的已知键去掉并列出。检查也只读私有目录里的排班文件。

## 参考项目（只对照思路，没有复制代码或数据）

| 项目 | 核对的提交 | 许可 | 用到的思路 |
| --- | --- | --- | --- |
| [KayChung17/arknights-base-skill](https://github.com/KayChung17/arknights-base-skill/tree/368ea6d83d14409a3e7354df4359960adba6b36b) | `368ea6d83d14409a3e7354df4359960adba6b36b` | MIT | 生成、检查、审计分开；检查清单的思路 |
| [dongwlin/La-pluma-next](https://github.com/dongwlin/La-pluma-next/tree/5dc335fcf7504772cc28ec0da748cd6debe9a1ac) | `5dc335fcf7504772cc28ec0da748cd6debe9a1ac` | MIT | 自定义基建 JSON 按协议校验字段 |
| [GuanxiYi1987/ark-base-schedule](https://github.com/GuanxiYi1987/ark-base-schedule/tree/f5d21dec4bb29671352cf9c81fd077676ab3c37e) | `f5d21dec4bb29671352cf9c81fd077676ab3c37e` | MIT（`Copyright (c) 2026 Guanxi`） | 检查清单的思路 |
| [Closure-RIIC/RIIC-knowledge](https://github.com/Closure-RIIC/RIIC-knowledge/tree/99048696e8a8abc249c8fc3d858962383ddb5c77) | `99048696e8a8abc249c8fc3d858962383ddb5c77` | 分区许可：原创内容 CC BY 4.0，PRTS 来源材料 CC BY-NC-SA 4.0 | 检查清单的思路 |

15 项验收门的条目来自工单，具体判定是本仓库独立写的；上面任何项目的代码、数据和排班都没有进入本仓库。KayChung17 的技能数据仍只按 21 的规定用于交叉核对。

## 设计默认值（2026-11-13，不是维护者原话）

- 早晚上线的容差默认 1 小时（理由：`hh:mm` 粒度下能发现正好卡在心情上限上的方案，用户可以调大）。
- 方案由 agent 提出安排；工具只在要求时（`fill`）按快照顺序填补没安排的房间（有该房间生效技能、产物不冲突、这一班没用到、上一班没上班，最后一班还要避开第一班），不比较收益、不排名（理由：21 规定文本百分比不能排名或加总，工具不能证明哪种安排更好）。
- 导出不写产物字段，布局有但没安排的房间写 `skip`，布局没有的设施写空数组（理由：MAA 写了产物会切换生产线，缺设施键会用默认算法换班）。
- 宿舍按名单显式安排，第 4、6 项按名单计算；未进驻的干员不计恢复（保守，未建模）。
- 训练室不在排班安排里（训练位由 24 管），导出时保持原样。
- 方案不可应用时 P1 不能批准（`base-plan-not-applicable`）；未核实的项写进批准范围，交 23 在应用前请用户决定。
- 检查和基础文件只读私有目录里的文件。
- 新鲜度的判定条件见上节。

## 实际运行的检查（本机，2026-11-13）

- `npm ci --ignore-scripts`：通过。
- `npm run typecheck`：通过。
- `node --test tests/base-plan.test.ts`：先在模块不存在时运行，失败（`ERR_MODULE_NOT_FOUND`）；实现后 10/10 通过。之后加了「不同布局和名册」一条：在只避开上一班的旧填补规则上运行失败（记录干员同时排进最后一班和第一班），改成班次排成一圈后 11/11 通过。再加「同名两个游戏 ID」一条：在旧实现上运行失败（没有按快照取持有的形态，ID 为空），改后 12/12 通过。
- `node --test tests/base-report.test.ts`：7/7 通过。
- `node --test tests/base-report-scenarios.test.ts`：2/2 通过（三个评测场景在评测夹具里离线运行已安装的产品脚本并评分）。
- 改了共享代码和 skill 文字后重跑：`tests/advice-report.test.ts` 5/5、`tests/cultivation-report.test.ts` 9/9、`tests/base-query.test.ts` 10/10、`tests/base-installation.test.ts` 2/2、`tests/help-installation.test.ts` 6/6 通过。
- `node scripts/tracker.ts`（含文档相对链接）、`node scripts/privacy.ts` 和插件元数据检查：没有错误。
- 完整离线检查 `node scripts/check.ts` 按维护者 2026-11-13 的机器负载规则由调度者在冻结提交上统一运行，本记录不代替它。

## 未验证

- 三个新评测场景的真模型运行（Claude Code、Codex）：未验证，留给 [26](issues/26-v0-1-0-release-validation.md)；观察器接入运行器随 [28](issues/28-runnable-evaluation-auth-preflight.md)。maa-account 的 skill 改动按规定要做同模型同场景的前后评测，也一起留给 26。
- 真实宿主上对基建报告发起独立审查：未验证。
- 实机：MAA 按 `period` 选计划、重叠时取靠前的计划、23:59 那一分钟的回退、菲亚梅塔互换的实际心情、同名光环是否叠加，都只在源码和游戏表上核对，没有在设备上看过。
- 心情速率、组合、互斥和效率数字由 agent 给出，工具只做一致性检查；这些数值本身的正确性没有核实。
- 读取本机 MAA 版本并写进计划（25 的验收）没有在本票实现，报告只记录所依据的协议版本 v6.21.4。
