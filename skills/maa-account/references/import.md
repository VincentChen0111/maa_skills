# 识别导入接口

共享实现位于相邻 `maa-core/scripts/account-snapshot.ts`。Node 24 运行；动作 `inspect` 只读，`import` 写入设置指定的私有目录内 `account-snapshot.json`。标准输入为一个 JSON 对象，禁止把路径或内容插值到 shell 命令。JSON 输出只含状态、计数、时间和 Markdown 摘要，不输出路径、账号标识或原始回调；`format: "markdown"` 可直接输出摘要。输出语言优先采用设置文件，未设时使用 `currentLanguage`（默认 `zh-CN`；目前摘要模板有中文及英文，其他语言由 agent 按设置翻译）。

| 输入 | 用途 |
| --- | --- |
| `{}` | 读取配置中的 MAA 目录下 `data/DepotData.json`、`data/OperBoxData.json`；缺文件记 `missing` |
| `{"depotFile":"绝对或当前目录相对路径","operBoxFile":"另一个路径"}` | 读取用户给出的 GUI 本地识别缓存；两个字段至少给一个 |
| `{"callbackFile":"路径"}` | 读取单个结构化回调 JSON 或回调数组，不能与前两个字段混用 |
| `{"callbackFile":"路径","format":"markdown","currentLanguage":"en"}` | 输出英文 Markdown（若设置已有语言，以设置为准） |

缓存文件由用户在 MAA 界面完成识别后产生。默认路径核对自 v6.21.4；其他版本出现缺文件或不同结构时报告未验证并请用户指定结果文件，不扫描私人目录。原始回调仅支持 JSON 文档，不接收整份非结构化日志。GUI `OperBoxData.json` 的 `source` 只接受本地识别 `local` 或旧版本缺失值；第三方账号来源另行实现，不把它伪装为 MAA 本地识别。

`readAt` 是本次实际读取时间；`sourceTimes` 保留文件里的 `syncTime`，缺失为 null，不能把旧缓存的导入说成新扫描。原始回调按输入顺序采用每域最后一次完成、未完成或已识别的错误；较新的未完成/错误会使旧完成结果失效。多个扫描批次或账号的结果须由用户分别提供，工具不合并跨账号缓存。

所有动作退出码 0 表示命令完成，并不表示两类识别都完整；仍须核对 `coverage`。不可读文件、无配置目录、非法请求或保存失败退出 1，错误码为 `account-check-required`；互斥文件已存在时为 `account-busy`。导入失败保留已有快照；成功解析到的缺失、未完成或损坏状态会写入新快照，避免沿用旧数据充当这次识别结果。快照使用临时文件与改名替换，锁不会自动抢占。

## 共享工具直接输入

快照 JSON 就是共享工具输入，无额外转换层；导出类型见脚本 `AccountSnapshot`。

- `version: 1`、`source`、`readAt`、`sourceTimes` 给出格式和时间来源。本导入器写 `source: "maa"`；森空岛读取写 `source: "skland"`，保存为另一个文件 `account-snapshot-skland.json`，见[森空岛接口](skland.md)。两份快照格式相同，查询工具都能读，彼此不合并。
- `operators` 使用 `id/name/rarity/elite/level/potential`；缺少数值为 null，缺少精英化等信息必须判为未知。MAA 识别不提供 `skillLevel/mastery/modules`，这些字段为 null；森空岛快照在有返回时给出 `skillLevel`（1–7）、`mastery`（按技能槽 `"1"`–`"3"` 记 0–3）和 `modules`（按模组 ID 记等级，0 为未解锁），其中单项未知为 null。
- `items` 仅保留实际返回的物品 ID 与非负整数数量，未列出的键是未知。`lmd` 仅来自已返回的 `4001`；未识别时为 null。
- MAA 快照的 `base` 为 null，`coverage.base.status` 为 `unavailable`，这两种识别不提供基建布局；森空岛快照的 `base.rooms` 见森空岛接口。
- `coverage.operators/inventory.status` 是 `complete/partial/pending/missing/invalid`，`issues` 只含固定原因码。未完成、错误或缺失的域不输出猜测事实；空完成结果记 `partial`。`complete` 不是“账号所有物品都已识别”的保证。

原始账号标识、连接信息及额外字段不进入快照。按干员名查找由消费工具在 `operators` 中完成；本导入器的对话摘要不逐个输出原始名字或 ID。
