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
| 2 跨进程限速锁、缓存、遇风控立即停止；新增限制登记来源 | `tests/nga-cli.test.ts`「two CLI processes share one cross-process gate …」：两个真实 CLI 进程并发，请求间隔不少于 3 秒。`tests/research.test.ts`：间隔、暂停窗口、遗留锁接管与等锁超时、时钟回拨不多等。`tests/nga.test.ts`：五种风控信号各一项，均立即停止，换另一个传输替身仍为 `risk-stopped`，到期后恢复。缓存命中不发请求、过期重读。没有擅自新增请求次数上限：「there is no per-run page cap …」读 8 页、第 1500 和 2000 页、检索 5 页全部发出，每次间隔不少于 3 秒。规格两张表新增「18」行 | 通过（网络替身） |
| 3 凭据走 09 的入口；不打印凭据或账号标识；不登录不发帖 | 读取器只调用 `inspectCredentials`、`readCredential`、`recordCredentialOutcome`。`tests/nga.test.ts` 扫描结果、Markdown 和临时目录所有文件，找不到 Cookie 中的合成值；`__CU` 等原始块不进缓存。`tests/nga-cli.test.ts` 扫描 CLI 输出和 `research/` 文件。CLI 只有 `search`、`read`、`status`，没有写动作（`post` 被拒为 `request-invalid`）；传输只有 GET | 通过 |
| 4 可运行 CLI 和 Markdown；保留作者、日期、来源、可信度与局限 | `tests/nga.test.ts`「a normal read …」逐字段核对 `items`；匿名、未知日期、去掉引用块的局限代码；检索结果只有标题。`tests/research.test.ts` 的两项 Markdown 测试（中英文、未知如实标明、停止和过期缓存）；`tests/nga-cli.test.ts` 的 Markdown 输出 | 通过 |
| 5 缓存命中、正常读取、认证失败、风控分开；风控后不换传输绕过 | `pages[].outcome` 与 `served` 分开标明：`cached`、`fresh`、`credential-rejected`、`risk-control`、`risk-stopped` 等（接口说明有全表）。只有「未登录」记过期（「an explicit login rejection …」），风控、不完整、网络失败都不记（「incomplete data …」）。暂停写在共用 `gate.json`，各进程、各传输都先查它（风控测试与 CLI 第二项） | 通过（网络替身） |
| 6 网页和帖子内容只当数据 | 「post text is only data …」：帖子要求读文件、贴 Cookie、访问链接、读别的帖子，实际只发了用户指定的那一个请求；Markdown 里链接改写、文字只在引用块。`tests/research.test.ts` 核对 Markdown 链接、HTML、代码围栏、方向控制字符都失效；一致性测试「conformance: no link or autolink can form …」逐一列举 18 种链接/自动链接触发形式 × 9 类前置字符 × 15 个进入 Markdown 的字段 × 中英文，结果里没有可用的触发，工具自己的来源链接仍可点。SKILL 与接口说明写明不执行内容里的指令 | 通过 |

## 设计默认值

都已登记在[规格](spec.md)「默认值及其来源」中以「18」开头的行，日期 2026-11-13，并汇总在「规则来源」的「18 NGA 调研」行：

- 闸门：间隔 3 秒，风控后来源暂停 30 分钟，锁占用超过 120 秒或持有进程已退出则接管，等锁最多 150 秒。
- 单次请求 20 秒、4 MiB；不跟随重定向，不重试；风控、被拒、网络失败或等不到闸门后，余下的页不再请求。每次运行不设页数上限（审查第 1 轮后去掉了原先的检索 3 页、读帖 5 页和页码 1000 上限），帖子号和页码只校验为正整数。
- 输入：检索关键词最多 50 个字符；CLI 标准输入最多 64 KiB。
- 风控与凭据被拒的判定（见来源核对）；不完整、不提供、网络失败不暂停、不记过期。
- 缓存：检索 6 小时、帖子页 24 小时，白名单字段；受阻时附旧缓存并标明。
- 无凭据或已知过期不发请求；Cookie 原样发送；User-Agent 如实标明本工具。
- 检索默认只搜明日方舟版块，可选全站；读帖只取帖子号和页码。
- 每楼缓存 4000 字、输出摘录 600 字；去掉引用块；Markdown 中帖子文字只在引用块里；除模板文字和工具构造的普通 https 来源链接外，所有值都转义并改写任意协议的链接、每个 www. 和每个 @，不会自动成链。

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
- 没有页数上限后，一次请求很多页时要按 3 秒间隔依次等待；对真实站点的影响同样要维护者核对。

## 审查第 1 轮修复

第 1 轮独立审查结论为有条件通过：P2 1 项、P3 2 项，没有安全类意见；协调者重新评估后三项全部接受。验收第 1 条（没有迁移私人工具）由协调者按设计默认值记录，等维护者确认，本轮不改。

1. P2：每次运行的页数上限（检索 3 页、读帖 5 页）违反验收第 2 条「不擅自新增请求次数上限」。比如请求读第 1–8 页会整体被拒为 `request-invalid`，什么都读不到。修复：去掉这两项上限，请求数只由 3 秒间隔、遇风控立即停止和 30 分钟暂停约束；接口说明、规格正文和两张来源表同步改写。
2. P3：关键词 50 个字符、页码 1000 上限、CLI 标准输入 64 KiB 写在代码里，却没有登记在规格。另外页码 1000 上限会挡住超过 1000 页的长帖。修复：去掉页码上限，同时去掉帖子号的 int32 上限和 10 位数字限制，帖子号和页码只校验为正整数；关键词和标准输入两项保留，写进规格正文和两张来源表，作为设计默认值并写明理由。
3. P3：Markdown 只改写 `http(s)://`，裸 `www.` 域名和邮箱地址仍会被 GFM 自动变成链接，比如标题 `www.title-link.example` 会在引用块外的 `##` 标题里成为链接。修复：`inert()` 另外改写任意协议的 `://`（写成 `[:]//`）、`www.`（写成 `www[.]`）和邮箱的 `@`（写成 `[@]`）。标题、作者名、来源名、页标签和摘录都经过它；函数注释、接口说明和规格措辞同步。

导出接口变化：`ngaLimits` 去掉了 `maxSearchPages`、`maxThreadPages`、`maxThreadPage`，新增 `inputBytes`（65536）。`NgaSearchRequest`、`NgaReadRequest`、`ResearchResult` 等其他导出类型和函数签名不变。

先写失败测试，再实现：

- `tests/nga.test.ts` 新增「there is no per-run page cap: every requested page is read, each request spaced by the interval」：读第 1–8 页，再读第 1500、2000 页，再检索 5 页，共 15 次请求，每两次间隔不少于 3 秒。原有的校验测试改为：0 页、小数页、字符串页仍被拒，多页不再被拒。修复前这一项因 `request-invalid` 失败（12 项通过、1 项失败），修复后 13 项全部通过。
- `tests/research.test.ts` 新增「Markdown leaves no autolink in fetched text …」：来源名、页标签、标题、作者名和摘录里放入 `www.`、大写 `WWW.`、邮箱、`mailto:`、`ftp://`、`xmpp:`，并核对工具自己构造的来源链接仍然可用。修复前第一行 `# NGA www.label.example` 就断言失败（6 项通过、1 项失败），修复后 7 项全部通过。

修复后的运行（按维护者 2026-11-13 的负载要求，只逐个运行涉及的单个测试文件，没有运行完整离线门禁，也没有重复或压力运行）：`npm run typecheck` 通过；`tests/research.test.ts` 7 项通过；`tests/nga.test.ts` 13 项通过；`tests/nga-cli.test.ts` 3 项通过；`tests/research-scenarios.test.ts` 1 项通过。没有访问 NGA。

## 审查第 2 轮修复

第 2 轮独立审查确认第 1 轮的三项都已修好，结论为有条件通过，只有 1 项 P3，协调者重新评估后接受。

问题：`inert()` 用 `/\b(www)\./gi` 改写 `www.`。JS 把 `_` 当作单词字符，所以 `_www.evil.example/x`、`see_www.evil.example` 没有被改写；`_` 转义成 `\_` 以后，GFM 仍然把它变成自动链接（cmark-gfm 的 www 识别和 micromark 都允许 `_` 作为前一个字符）。审查员的离线探针显示，引用块外的 `##` 标题里出现了 `\_www.evil.example/x`。

这是第二轮出现自动链接缺陷，按复发规则不再逐个修补路径：`inert()` 保持为唯一负责的函数，并加一项逐项列举的一致性测试。

- 修复（`skills/maa-core/scripts/research.ts`）：
  - `inert()` 去掉 `\b`：每个 `www.`、每个任意协议的 `://` 都改写，每个 `@` 都改写为 `[@]`（不再只认邮箱形状），另外转义 `&`，防止 `&#119;ww.` 这类字符引用。
  - 排查时发现，Markdown 里原先还有几个值没经过 `inert()`：时间（生成时间、读取时间、发布时间、停止到）、未知的可信度/局限代码，以及不是普通 https 地址的 `url`。现在除模板文字和工具构造的普通 https 来源链接外，所有值都经过它。
- 一致性测试（`tests/research.test.ts`「conformance: no link or autolink can form from any fetched text field, whatever precedes it; the source link stays clickable」）：
  - 18 种触发形式：`www.`、大写 `WWW.`、`http://`、`https://`、`ftp://`、其他协议、邮箱、`mailto:`、`xmpp:`、尖括号网址、尖括号邮箱、链接、图片、引用式链接、HTML、字符引用三种。
  - 9 类前置字符：开头、空格、`_`、`*`、`~`、`(`、中文、字母、数字。
  - 15 个字段：来源名、页标签、页读取时间、停止到、生成时间、整体可信度、整体局限、标题、作者名、楼层、发布时间、条目读取时间、条目可信度、条目局限、摘录。
  - 中英文都渲染。每种组合检查结果里没有可用的触发：`www.`、`://`、未转义的 `[`、`]`、`<`、`&`，以及不在 `\[@\]` 中的 `@`。同时检查工具自己的来源链接那一行保持原样、可点，以及不是普通 https 的 `url` 也会被改写。
- 先失败后通过：
  - 用 `git archive` 导出修复前的提交 `ce54fd0`，换上新的测试文件后单独运行：共 3312 个组合失败，其他 6 项通过。
  - 按字段统计：原本已经经过 `inert()` 的来源名、页标签、标题、作者名、楼层、摘录各 66 个，就是 `_`、字母、数字后面的 `www.`/`WWW.`，加上三种字符引用；原本原样输出的时间和代码字段各 324 个，即全部触发形式。
  - 修复后 7 项全部通过。审查员的离线探针（16 个输入）全部渲染成不可用的形式，例如 `\_www\[.\]evil.example/x`。

修复后的运行（同样只逐个运行涉及的单个测试文件，没有访问 NGA，没有留下进程）：`npm run typecheck` 通过；`tests/research.test.ts` 7 项通过；`tests/nga.test.ts` 13 项通过；`tests/nga-cli.test.ts` 3 项通过；`tests/research-scenarios.test.ts` 1 项通过；隐私检查无发现。

导出接口没有变化。
