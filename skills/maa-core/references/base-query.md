# 基建技能查询接口

`base-query.ts query` 是只读入口：从 11 生成的账号快照和固定游戏表查基建技能。需要 Node 24。用户请求查询干员或某类房间时，maa-account 读本页后调用；排班、收益模拟和写入 MAA 属于后续入口。

Windows PowerShell 用管道传 JSON 时，非 ASCII 字符和 `?` 都写成 `\uXXXX` 转义；管道加在开头的 BOM 由脚本去掉，返回 `input-encoding-lossy` 时什么都没做，改成转义后重发。标准输入传 JSON，用户文本和路径都作为数据：

```json
{"operators":["干员名或 char_ 游戏 ID"],"room":"制造站","format":"markdown","currentLanguage":"zh-CN"}
```

- `operators` 可省略；省略时只列快照实际观察到的已持有干员。同名有多个游戏 ID 时返回歧义，先让用户指定 ID。
- `room` 可省略；支持控制中枢、制造站、贸易站、发电站、会客室、办公室、加工站、训练室、宿舍、回收站，也接受游戏表对应的大写房间类型。两个过滤项同时传时取交集。
- 默认读取设置指定的私有目录内 `account-snapshot.json`。`snapshotFile` 可以指定另一份同格式快照；脚本不更新它。
- 默认运行时读取公开固定提交的 `character_table.json`、`building_data.json`，及 KayChung17 的交叉核对表。来源链接与完整提交见下节。结果列出获取时间、SHA256 和来源。
- `tablesFile` 指向离线 JSON，结构为 `{ "characters": 游戏干员表, "building": 基建表, "crossCheck": 可选交叉表 }`。此模式完全不联网，明确标为「所提供的数据，本次未核验公网出处」，不会信任文件自己声称的来源。它供离线重放与合成演示使用；游戏数据不随 skill 打包。
- `format` 为 `json`（默认）或 `markdown`。JSON 含 `ok`、`result` 和同一结果渲染的 `summary`；Markdown 是该 `summary` 的原文。语言遵循设置；中文及英文模板之外，由调用方按设置翻译。

报告 `active`（已解锁且没有更后面的同槽技能可能替换）、`locked`（后续解锁）、`superseded`（同槽已替换）和 `unknown`（待核）。阈值按精英阶段优先，阶段相同时再比较等级；精英化后的等级重置不会锁回旧阶段技能。更后面的替换技能是否解锁不明时，旧技能同样标待核。缺条件或缺技能定义不补默认值。

`active` 只描述该账号练度下有效的技能条目，不能证明当前进驻或效果已经触发。完整条件文本始终保留；阵营组合、控制中枢全局效果、心情、配方和其他条件未建模。文本百分比不代表最终收益，不求和、不排序。技能表没有观察到的干员仍是未知持有；快照的识别 `complete` 不证明名册完整。

交叉核对只比较名称、房间、精英与等级阈值、条件全文。`differences` 列出仅在游戏表／交叉表出现的条目，`issues` 列出缺失或歧义；这些差异不覆盖主表。交叉表未提供或联网失败时如实标明未核。`warnings` 中缺字段、缺干员和未知持有都要带入回复。

查询失败退出码为 1，成功为 0；错误只输出稳定类别，不打印路径、原始快照、网络响应或调用栈。失败先核对输入和待核项，不把未返回结果当作无技能。

## 固定资料来源

- 游戏镜像：[Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData/tree/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff)，提交 `6f63c14e27b847ef74b53b00fe51fc322b3cd7ff`；`zh_CN/gamedata/excel/character_table.json` 与 `building_data.json`。镜像为游戏数据来源，不代表游戏官方授权本工具。
- 交叉核对：[KayChung17/arknights-base-skill](https://github.com/KayChung17/arknights-base-skill/blob/368ea6d83d14409a3e7354df4359960adba6b36b/skills/ark-base-schedule/assets/operator-skills.json)，提交 `368ea6d83d14409a3e7354df4359960adba6b36b`。未采用其排班算法或衍生加成值。数据仅运行时读取；上游 [MIT 许可](https://github.com/KayChung17/arknights-base-skill/blob/368ea6d83d14409a3e7354df4359960adba6b36b/LICENSE) 的版权行为 `Copyright (c) 2026 KayChung17`。

`queryBaseSkills(snapshot, tables, query)`、`queryPublicBaseSkills(snapshot, query, fetcher?)` 和 `formatBaseSkills(result, language?)` 是同一实现的导出接缝。后者网络参数只替代 fetch 边界，生产默认使用固定 HTTPS 来源。
