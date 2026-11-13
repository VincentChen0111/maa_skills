# NGA 调研验证记录

2026-11-13，工单 [18](issues/18-nga-research.md) 在分支 `claude/18-nga-research` 实施。分支叠在工单 09 已审查、尚未合并的分支上（09 的头 `6df8ed0`，基于 `origin/main` `4a1fd26`），因为 18 被 09 阻塞。实施进度：进行中，等待独立审查，尚未合并。

## 交付内容

- `skills/maa-core/scripts/nga.ts`：NGA 只读检索（`search`）、读帖（`read`）和状态（`status`）CLI 与导出函数，唯一的解码、判定和解析核心。
- `skills/maa-core/scripts/research.ts`：调研共用层。结果与引用格式、缓存、跨进程请求闸门（最小间隔、风控暂停、遗留锁接管）、中英文 Markdown。工单 19 的森空岛社区和 B 站、工单 20 的报告复用它。
- `skills/maa-core/scripts/research-transport.ts`：按平台的 GET 传输。Windows 经 PowerShell 调用 .NET HttpClient，其他环境用 Node fetch；只搬运字节，没有互相回退。
- 文档：[社区调研接口](../skills/maa-core/references/research.md)、[NGA 来源核对](nga-sources.md)；maa-core、maa-account、maa-help 的 SKILL；规格「共享工具」「资料来源」和两张来源表；第三方声明；README、宿主说明；09 验证记录里 Cookie 名称一行的补充。
- 评测场景：`eval/maa-account/research-scenarios.ts` 新增 `account-nga-credential-required`、`account-nga-cached-citation`、`account-nga-risk-stopped`。

## 与工单原文的差异

验收第 1 条写「迁移 NGA 读取核心」。被移植的私人 NGA 工具不在本仓库，也没有提供给实施者，所以本次没有迁移，而是按规格点名的三样行为（跨进程限速锁、遇风控立即停止、缓存）独立实现；数值与判定规则登记为设计默认值。逐文件隐私检查针对的是本次新写的文件。维护者若要以私人工具为准核对数值，需要另行提供只读参考。

## 验收对照

| 验收 | 证据 | 状态 |
| --- | --- | --- |
| 1 读取核心一份，Windows 与其他环境按传输适配；逐文件隐私检查 | 解码、判定、解析只在 `nga.ts`。`tests/research-transport.test.ts`：两种传输对同一本地 HTTP 替身给出相同结果（原始字节、302 不跟随、503 原样、超限 `transport-too-large`、超时 `transport-timeout`、只发无请求体的 GET、请求头原样）；「each platform has exactly one transport …」。隐私检查通过；新文件逐个人工检查，没有个人路径、账号或真实帖子 | 实现通过；没有迁移私人工具（见上节） |
| 2 跨进程限速锁、缓存、遇风控立即停止；新增限制登记来源 | `tests/nga-cli.test.ts`「two CLI processes share one cross-process gate …」：两个真实 CLI 进程并发，请求间隔不少于 3 秒。`tests/research.test.ts`：间隔、暂停窗口、遗留锁接管与等锁超时、时钟回拨不多等。`tests/nga.test.ts`：五种风控信号各一项，均立即停止，换另一个传输替身仍为 `risk-stopped`，到期后恢复。缓存命中不发请求、过期重读。规格两张表新增「18」行 | 通过（网络替身） |
| 3 凭据走 09 的入口；不打印凭据或账号标识；不登录不发帖 | 读取器只调用 `inspectCredentials`、`readCredential`、`recordCredentialOutcome`。`tests/nga.test.ts` 扫描结果、Markdown 和临时目录所有文件，找不到 Cookie 中的合成值；`__CU` 等原始块不进缓存。`tests/nga-cli.test.ts` 扫描 CLI 输出和 `research/` 文件。CLI 只有 `search`、`read`、`status`，没有写动作（`post` 被拒为 `request-invalid`）；传输只有 GET | 通过 |
| 4 可运行 CLI 和 Markdown；保留作者、日期、来源、可信度与局限 | `tests/nga.test.ts`「a normal read …」逐字段核对 `items`；匿名、未知日期、去掉引用块的局限代码；检索结果只有标题。`tests/research.test.ts` 的两项 Markdown 测试（中英文、未知如实标明、停止和过期缓存）；`tests/nga-cli.test.ts` 的 Markdown 输出 | 通过 |
| 5 缓存命中、正常读取、认证失败、风控分开；风控后不换传输绕过 | `pages[].outcome` 与 `served` 分开标明：`cached`、`fresh`、`credential-rejected`、`risk-control`、`risk-stopped` 等（接口说明有全表）。只有「未登录」记过期（「an explicit login rejection …」），风控、不完整、网络失败都不记（「incomplete data …」）。暂停写在共用 `gate.json`，各进程、各传输都先查它（风控测试与 CLI 第二项） | 通过（网络替身） |
| 6 网页和帖子内容只当数据 | 「post text is only data …」：帖子要求读文件、贴 Cookie、访问链接、读别的帖子，实际只发了用户指定的那一个请求；Markdown 里链接改写、文字只在引用块。`tests/research.test.ts` 核对 Markdown 链接、HTML、代码围栏、方向控制字符都失效。SKILL 与接口说明写明不执行内容里的指令 | 通过 |

## 设计默认值

都已登记在[规格](spec.md)「默认值及其来源」中以「18」开头的行，日期 2026-11-13，并汇总在「规则来源」的「18 NGA 调研」行：

- 闸门：间隔 3 秒，风控后来源暂停 30 分钟，锁占用超过 120 秒或持有进程已退出则接管，等锁最多 150 秒。
- 每次运行检索最多 3 页、读帖最多 5 页；单次请求 20 秒、4 MiB；不跟随重定向，不重试；风控、被拒、网络失败或等不到闸门后，余下的页不再请求。
- 风控与凭据被拒的判定（见来源核对）；不完整、不提供、网络失败不暂停、不记过期。
- 缓存：检索 6 小时、帖子页 24 小时，白名单字段；受阻时附旧缓存并标明。
- 无凭据或已知过期不发请求；Cookie 原样发送；User-Agent 如实标明本工具。
- 检索默认只搜明日方舟版块，可选全站；读帖只取帖子号和页码。
- 每楼缓存 4000 字、输出摘录 600 字；去掉引用块；Markdown 中帖子文字只在引用块里。

只影响本工具实现、不是产品限制的选择：Markdown 模板只有中文和英文（与 09 相同，其他语言由 agent 翻译），设置未选语言时用中文；结果状态取最严重的一项，顺序见接口说明。

## 测试与运行记录

本机 Windows 11、Node 24。测试用真实临时目录、真实 CLI、真实缓存和锁文件；只替代网络（导出函数测试注入传输替身，CLI 测试用 `tests/fixtures/research-boundary.mjs` 以 `--import` 替换 `research-transport.ts`）和 Windows 加密边界（沿用 09 的 `credential-boundary.mjs`，导出函数测试用进程内替身）。传输本身用本机 `127.0.0.1` 上的 HTTP 服务测试，Windows 传输真实调用 PowerShell 和 .NET。没有访问 NGA，没有读取维护者的真实凭据或私有目录。合成帖子的结构按公开资料自写。

单文件运行（提交 `5368bfb` 起）：

- `tests/research.test.ts`：6 项通过。
- `tests/research-transport.test.ts`：3 项通过、1 项跳过（非 Windows 分支，本机为 Windows）。
- `tests/nga.test.ts`：12 项通过。另做两处变异核对：把 503 移出风控判定、去掉「未登录」记过期，对应测试都失败；恢复后通过。
- `tests/nga-cli.test.ts`：3 项通过。
- `tests/research-scenarios.test.ts`：1 项通过（三个场景 × 两种安装布局）。
- `npm run typecheck`：通过。

## 门禁运行

在提交 `e4db611` 上运行，本机 Windows 11、Node 24：

- `npm run typecheck`：通过。
- `node scripts/check.ts`：退出码 1。424 项测试中 421 通过、1 失败、2 跳过（非 Windows 分支）。唯一失败是 `tests/maa-process.test.ts` 的「Windows launches and normally closes a temporary GUI and completes a CLI configuration transaction」，报 `maa-start-timeout`。本次新增的 6 个测试文件全部通过。
- 因测试失败，`check.ts` 没有继续运行后面几项，所以另外单独运行：`node scripts/tracker.ts` 无错误；`node scripts/privacy.ts .` 无发现；元数据（`inspectMetadata`）无错误；`node scripts/eval-selftest.ts` 通过（7 条规则、14 份样例）。
- 失败项按规则单独重跑 `node --test tests/maa-process.test.ts` 三次：三次都是 16 项中 14 通过、1 失败、1 跳过，失败的都是同一项（第 1、3 次报 `maa-close-timeout`，第 2 次报 `maa-start-timeout`）。
- 对照：用 `git archive` 导出基点 `6df8ed0`（09 的头，不含本票改动）到临时目录，同样单独运行三次：三次也都是 14 通过、1 失败，同一项失败（`maa-start-timeout`、`maa-close-timeout`、`maa-start-timeout`）。本票没有改动 `maa-process.ts`、`maa-config.ts` 或该测试。结论：这是本机启动和关闭合成 GUI 进程的环境问题，在基点上同样稳定复现，与本票无关。按规则这不是「偶发」：它在本机单独运行时每次都失败。

之后只给 `tests/nga-cli.test.ts` 的三项加了 180 秒测试超时（防止子进程卡住时测试无限等待），单独重跑 3 项通过。

## 未验证

- 真实 NGA：没有可用凭据，本次一个带凭据的请求都没有发。真实返回字段、`fid` 是否限定检索、UTF-8 关键词、如实 User-Agent 是否被接受、真实风控信号、「未登录」以外的拒绝形态、匿名前缀、3 秒和 30 分钟是否够用，都要维护者在本机用自己的凭据核对，清单见 [NGA 来源核对](nga-sources.md)「未验证」。
- Windows 传输经系统代理和证书存储访问外网：只对本机回环地址的 HTTP 替身实测过。
- 混用编码的单个字段：未做逐字段修复，可能出现乱码。
- 真模型行为评测：三个新场景只做了离线评分链路自检（`tests/research-scenarios.test.ts`）。maa-account、maa-help、maa-core 的 SKILL 有改动，按开发约定需要同模型、同场景的前后评测；缺工单 28 的运行入口和维护者的评测登录，留给工单 26。
