# 森空岛账号快照接口

共享实现位于相邻 `maa-core/scripts/skland-account.ts`，需要 Node 24。它用用户自己在本地脚本里保存的森空岛 token 只读读取账号数据，不需要开模拟器。标准输入是一个 JSON 对象；路径等数据只经标准输入传递，不拼进 shell 命令。

## 谁做什么

- 凭据只由用户本人在自己的终端输入（见[凭据接口](../../maa-core/references/credentials.md)）。agent 不运行 `credentials.ts input`，不在对话里索取、复述或使用 token，不替用户登录，也不向用户要密码。
- 读取器在进程内用 token 换取访问凭证、给请求签名、过期时两级刷新。只有换取时森空岛明确拒绝 token 才记为已知过期，交用户重新粘贴；两级刷新后仍被拒是签名问题，不记过期。
- 只读：只请求六个接口：用 token 换授权码、换 cred、刷新签名 token、绑定角色、玩家信息和养成数据。不签到、不发帖、不点赞、不付费、不做任何账号写操作；用户要求这些时拒绝，只读部分照常可做。
- 森空岛社区的公开内容调研不使用这个 token，也不调用这个脚本。

## 动作

| 动作 | 输入 | 行为 |
| --- | --- | --- |
| `inspect` | `{}`，可加 `currentLanguage`、`format` | 读取一次并报告，不保存快照 |
| `import` | 同上 | 读取一次，保存到私有目录的 `account-snapshot-skland.json`；有域没读到时不替换已有快照（见下） |
| `compare` | `{}`，可加 `maaFile`、`sklandFile`、`currentLanguage`、`format` | 只读比较 MAA 快照（默认 `account-snapshot.json`）和森空岛快照（默认 `account-snapshot-skland.json`），不联网、不写文件 |

`inspect` 和 `import` 都会联网，并按 09 的规则记下这份凭据的实际读取结果（可用或已知过期）。`format: "markdown"` 直接输出摘要；输出语言优先用设置文件，未设时用 `currentLanguage`，模板只有中文和英文，其他语言由 agent 按设置翻译。

读取成功时退出码 0，JSON 只含 `saved`、`source`、`readAt`、`coverage`、`failedDomains`、计数、`lmd`、`baseRoomCount`、`credential`、`disclosures` 和摘要（有没读到的域时另有 `repair`），不含 token、cred、角色号、昵称或本机路径。不要打开快照文件把内容贴到对话里。

`failedDomains` 列出干员、仓库、基建中这次没读到的域（请求失败为 `unavailable`，回复不合格为 `invalid`，没有返回为 `missing`，原因在 `coverage` 里）。这时 `import` 不替换已有的森空岛快照，`saved` 为 false，摘要说明旧快照保持不变；只有还没有森空岛快照时才保存这份部分快照。`repair` 为 `retry-later`（请求失败）或 `report-issue`（回复不合格）。以 `saved` 为准，不要把没保存的结果说成已更新。

失败时退出码 1，标准错误输出 `{"ok":false,"saved":false,"error":…,"credential":…,"repair":…,"summary":…}`。失败时不会写新快照，已有的森空岛快照原样保留；不能把它说成本次读取的数据。

| `error` | 含义 | `repair` 与说法 |
| --- | --- | --- |
| `credential-unset` | 没有保存 token；没有发任何请求 | `enter-credential`：给出带实际路径的 `node <maa-core>/scripts/credentials.ts input skland --language <标签>`，请用户在自己的终端运行 |
| `credential-expired` | 用 token 换取访问凭证时森空岛明确拒绝，已记为已知过期 | `reenter-credential`：请用户自己取得新 token 后用同一命令重新粘贴 |
| `signature-rejected` | 本次读取里 token 已被接受，两级刷新后请求签名仍被拒；凭据状态不变，不算过期 | `check-system-time`：请用户检查系统时间和时区；时间正确仍失败时请报告问题。不要请用户重新粘贴 token |
| `credential-unreadable` | 保存的记录损坏或不是当前 Windows 用户保存的 | `reenter-credential` |
| `network-failed` | 连不上或超时；凭据状态不变 | `retry-later` |
| `service-error` | 对方拒绝，但没有表明是凭据问题（可能限流或风控）；凭据状态不变，不自动重试 | `retry-later` |
| `response-invalid` | 回复格式和已核对的不一致，包括玩家信息里没有已核对的干员结构；不写快照 | `report-issue`：接口可能变化，请用户报告问题 |
| `binding-missing` | 账号下没有可用的明日方舟角色 | `bind-role-in-skland`：用户在森空岛 App 里绑定 |
| `binding-ambiguous` | 有多个角色且没有默认角色 | `set-default-role-in-skland`：用户在森空岛 App 里设默认角色；不要请用户把角色号发到对话里 |
| `windows-required`、`protection-failed` | 当前环境解不开凭据 | 按摘要说明处理 |
| `account-busy` | 另一个快照写入正在进行，本次没有保存 | 保留锁，稍后再试，不删除锁 |
| `snapshot-missing` | `compare` 缺少一边的快照，`missing` 列出 `maa` 或 `skland` | 先按对应流程建立那份快照 |
| `account-check-required` | 设置不可读、请求不合法或其他失败 | 先核对，不自动重放 |

## 快照内容

格式与 MAA 识别的快照相同（见[导入接口](import.md)的「共享工具直接输入」），`source` 为 `skland`，账号标识不写入：

- `readAt` 是本次读取完成的时间，不是游戏内的数据时间；`sourceTimes` 两项都是 null。森空岛数据比游戏内滞后多久没有测过。
- `operators`：稀有度和潜能在森空岛从 0 计数，快照里都是 1–6；`skillLevel` 是 1–7，`mastery` 按第 1–3 技能记 0–3，`modules` 按模组 ID 记等级（锁定为 0）。没有返回或不合格的值是 null，原因写在 `coverage.operators.issues`。
- `items` 来自养成接口；`lmd` 只取其中的 `4001`，没有就是 null。未列出的物品是未知，不是零。
- `base.rooms` 列出房间类型、`slotId`、等级和驻员；心情是原始值 `moodRaw`（满值 8,640,000）及其记录时间 `moodAt`。
- `coverage.medicine`、`coverage.vouchers`、`coverage.stageClears` 固定为 `unavailable`、`no-source`：理智药等药剂、凭证和各类券、逐关通关状态没有来源，不补零，不推断。

查询工具（成本、缺口、基建、训练）默认读 MAA 快照 `account-snapshot.json`。用户要用森空岛数据时，在请求里传 `snapshotFile` 指向私有目录的 `account-snapshot-skland.json`，并在回复里说明用的是哪个来源和读取时间。两份快照不合并；用户问两边是否一致时用 `compare`，按结果列出差异和两边的时间，不替用户判断哪边对。两份是否属于同一账号无法核对。

## 每次读取后都要告诉用户

1. 截至 2026-11-13，没有找到鹰角网络对第三方调用森空岛接口的公开表态。
2. 森空岛数据比游戏内实际状态滞后多久没有测过；快照的读取时间不等于游戏内的数据时间。

摘要里已带这两点，转述时不要省略。接口与字段的核对记录见仓库的[森空岛接口来源](https://github.com/VincentChen0111/maa_skills/blob/main/docs/skland-account-sources.md)。
