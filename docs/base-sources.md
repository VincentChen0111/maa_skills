# 21 基建查询来源核对

核对日期：2026-11-11。只读固定公开 JSON 与维护者自有原型；没有读取真实账号、运行原型、修改生产目录或打包游戏数据。接口见[基建查询](../skills/maa-core/references/base-query.md)，离线演示见[合成演示](base-demo.md)。

## 固定公开来源

| 来源 | 固定版本与路径 | 本次读取字节的 SHA256 |
| --- | --- | --- |
| [Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData/tree/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff) | `6f63c14e27b847ef74b53b00fe51fc322b3cd7ff`；`zh_CN/gamedata/excel/character_table.json` | `eb6fff6fb3ce605bd60db2206a644625a3d145b4c46fa126f218cd51df4f1f1d` |
| 同一游戏镜像 | 同一提交；`zh_CN/gamedata/excel/building_data.json` | `8b4000197acf12565b154e870266e9a2b6ab7dac2f11fbfcf32feba6063855f7` |
| [KayChung17/arknights-base-skill](https://github.com/KayChung17/arknights-base-skill/blob/368ea6d83d14409a3e7354df4359960adba6b36b/skills/ark-base-schedule/assets/operator-skills.json) | `368ea6d83d14409a3e7354df4359960adba6b36b`；`skills/ark-base-schedule/assets/operator-skills.json` | `a3e488367c29441afdad7b5c40f7836ce875b7509e6c543d65513355162febd3` |

游戏镜像提交时间为 2026-11-09，交叉表为 2026-11-04；两者不是同一时点。镜像数据权利仍属于原权利人，根目录没有另给游戏数据再分发许可；本仓库只保留来源指纹，运行时读取。KayChung17 仓库采用 MIT，版权与许可见[第三方声明](../THIRD_PARTY_NOTICES.md)。未复制其代码、算法或数据文件。

读取字段：干员表 `name`；基建表 `chars[*].buffChar[*].buffData[*]`、`buffId`、`cond.phase/level` 与 `buffs[*].buffName/roomType/description`。同槽后续解锁条目替换前面条目，阶段相同时比较等级，较高阶段满足较低阶段条件。这是由固定表和原型修正推导的查询规则，本次没有实机核实游戏结算。

固定表包含 438 名有基建技能的干员、778 个定义、944 条干员技能记录，房间含回收站。用全员合成名册验证解析与交叉核对，不据此断言任何真实账号持有或练度。交叉表也是 438 名，得到 8 条单边差异（4 对）：

- `char_4220_kormr`「虎狼丸的报恩」：游戏表要求精0、30级，交叉表写精0、1级。
- `char_4218_aigis`「机械工学」：交叉表充能措辞多了「每小时」。
- `char_2015_dusk` 两个技能名：交叉表多了反斜杠转义，条件正文一致。

差异只报告，不自动改任一方。比较保留原文差异，不做模糊相似度或收益模拟；缺失与歧义列入待核。联网失败不伪称两表一致。

## 原型与隐私剥离

维护者授权参考自有原型，重写为唯一共享查询入口；未导入原项目历史：

| 只读参考 | SHA256 | 保留与剥离 |
| --- | --- | --- |
| 原始 `base-skills.mjs` | `339bc48ca6c851b08ab04e1d6db6b28ba5e80b3e2271379373225983d3e61a43` | 保留表到干员／房间查询思路；剥离个人路径、名册、缓存、存储、生产配置和百分比排名 |
| 后续 `base-skills.ts` | `e31ba29bc9099830d3a5c042f36c697b452a1e2f3edcad219a765352a8d74fe5` | 借鉴同槽替换及阶段／等级阈值；剥离个人授权、生产选择、排班草稿、原项目 schema 与依赖 |

维护者自有代码适用仓库 MIT。公开测试与演示中的名称、技能、条件、资源都是合成数据；真实公开表仅在忽略的临时目录核对结构，未提交。构建与评测只用临时 home、合成名册与 MAA 样例。
