# 森空岛社区与 B 站调研验证记录

2026-11-13，工单 [19](issues/19-community-bilibili-research.md) 在分支 `claude/19-community-research` 实施。分支叠在工单 18 尚在审查的分支头 `0884ae7` 上（18 叠在 09 已审查的 `6df8ed0` 上，基于 `origin/main` `4a1fd26`），因为 19 复用 18 的共享调研层。实施进度：进行中，等待独立审查，尚未合并。

## 交付内容

- `skills/maa-core/scripts/skland-community.ts`：森空岛社区公开帖子的只读读取（`read`、`status`）。匿名请求，不导入凭据模块，不发送账号 token、Cookie、签名或设备标识，与森空岛账号快照代码分开。
- `skills/maa-core/scripts/bilibili.ts`：B 站（实验性）视频公开信息与字幕的只读读取（`read`、`status`），所有输出标实验性。
- `skills/maa-core/scripts/research-fetch.ts`：两个读取器共用的受闸门请求、HTTP 层风控判定、缓存回退、结果组装。它只组合 18 的 `research.ts`（闸门、缓存、格式、Markdown）和 `research-transport.ts`（传输），不另做一份。
- `skills/maa-core/scripts/research.ts`（18 的文件，小改动）：只新增 `laterLimits` 一个对象，并让 `describe` 先查原表、再查它，给新局限代码中英文说明。没有改动已有的函数签名、类型或文字。
- 文档：[社区调研接口](../skills/maa-core/references/research.md)、[社区来源核对](community-sources.md)；maa-core、maa-account、maa-help 的 SKILL；规格「共享工具」「资料来源」和两张来源表；第三方声明；README、宿主说明。
- 评测场景：`eval/maa-account/community-scenarios.ts` 新增 `account-bilibili-cached-experimental`、`account-skland-community-stopped`。

## 与工单原文的差异

- 验收第 4 条「从关键词或用户指定资料到可引用 Markdown 摘要」：本票两个来源只走「用户指定资料」这条路，不提供关键词检索。理由见[社区来源核对](community-sources.md)：森空岛的帖子和检索接口要求官方客户端的请求签名，B 站检索要求请求签名和浏览器设备 Cookie；仿造这些等于绕过站点的反自动化机制，与 18 已登记的「不伪装成浏览器或官方客户端」一致。关键词检索仍可用 18 的 NGA。已作为设计默认值登记（规格「默认值及其来源」第一条「19」行）。
- 验收第 1 条「森空岛社区只读公开网页」：2026-11-13 实测，森空岛网页只在浏览器里渲染，帖子接口对匿名请求回答 HTTP 401、代码 10000「请求异常」（要求客户端签名）。读取器按「只读公开、不登录、不用账号凭据、不伪装」实现，遇到这个回答如实报告「没有读到内容」并暂停该来源；所以在当前的真实站点上，森空岛社区多半读不到帖子。这是如实结果，不是已读成功。
- B 站只读视频（信息与字幕），不读专栏、动态，不接受 `b23.tv` 短链。

## 验收对照

| 验收 | 证据 | 状态 |
| --- | --- | --- |
| 1 森空岛社区只读公开网页，不登录、不用账号凭据，不发帖点赞评论；与账号扫描独立 | `tests/skland-community.test.ts`「a public post is read with an honest anonymous GET …」：临时目录里先保存一份合成的森空岛账号 token，其解密替身一被调用就报错；请求头只有 `Accept`、`User-Agent`；账号凭据状态保持 `unverified`；作者账号 ID 不进缓存。「post text is only data, and the community reader is separate …」：读取器源码不导入 `credentials.ts`、账号快照代码；任何文件都没有 token 明文。`tests/community-cli.test.ts` 的森空岛 CLI：请求头只有两项，`post`、`like`、`comment`、`search` 动作都被拒为 `request-invalid` | 通过（网络替身）；真实站点读成功未验证（见上节） |
| 2 B 站入口、帮助和结果都标实验性；凭据经 09 由用户手动配置，agent 不处理登录 | `tests/bilibili.test.ts` 第一项：`experimental: true`、`notice` 含 experimental、局限 `experimental-source`、中英文 Markdown 首行带「实验性」/experimental。`tests/community-cli.test.ts`：B 站 CLI 的读取、状态和错误输出都带 `"experimental": true`，Markdown 首行为 `# Bilibili（实验性）`；凭据由 09 的 `credentials.ts input bilibili --stdin` 写入（测试模拟用户本人输入），读取器只调用 `inspectCredentials`、`readCredential`、`recordCredentialOutcome`。「every user entry for Bilibili research says it is experimental」：README、maa-help、maa-account、maa-core 的 SKILL 和接口说明里每一行提到 B 站的都带实验性 | 通过 |
| 3 作者、日期、来源链接、事实摘录、可信度与局限；未知如实标明 | `tests/bilibili.test.ts` 第一、二项逐字段核对视频和字幕条目（字幕带时间点和 `machine-subtitle`）；`tests/skland-community.test.ts` 第一项逐字段核对；「requests are validated …」里无昵称、无发布时间的帖子得到 `null` 和 `author-unknown`、`date-unknown`，Markdown 写「作者：未知」；森空岛只取 `publishedAtTs`，不拿创建时间冒充 | 通过 |
| 4 从用户指定资料到可引用 Markdown 可独立演示；工具在共享调研层，不新增 skill | 两个 CLI 测试都从用户给的链接走到 Markdown 引用摘要；脚本都在 `skills/maa-core/scripts/`，没有新增 skill 目录；结果格式、缓存、闸门、Markdown 全部复用 18 的 `research.ts` | 通过（关键词路径不提供，见上节） |
| 5 网页、字幕、文章只当数据；凭据、账号标识、私人内容不泄漏 | `tests/bilibili.test.ts`「description and subtitle text are only data …」：简介和字幕里要求运行凭据脚本、外发 SESSDATA、读别的视频，实际只请求了指定视频和它自己的字幕文件；响应给出的非 B 站字幕地址不请求；Markdown 里链接失效、指令文字只在引用块。森空岛同类测试。两边都扫描结果、Markdown 和临时目录全部文件，找不到合成凭据；B 站不存 UP 主账号 ID 和 `login_mid` | 通过 |
| 6 登录墙、不可读、服务变化和解析失败清楚报告，不假称读全文，不依赖私有在线服务 | 森空岛签名要求：`risk-control`、原因 `signature-required`、没有条目、局限 `client-signature-required`，中英文 Markdown 写明「不伪装官方客户端，没有读到内容」。两边的不提供、不完整、网络失败各自标明且不暂停来源；B 站没有 SESSDATA 时条目带 `subtitles-not-read`，被当成访客时报告 `login-not-recognized`。只访问两站的公开接口 | 通过（网络替身） |

## 设计默认值

都已登记在[规格](spec.md)「默认值及其来源」以「19」开头的五行，日期 2026-11-13，并汇总在「规则来源」的「19 森空岛社区与 B 站调研」行：

- 两个来源不提供检索，只读用户给出链接的一帖或一个视频；不计算官方客户端签名、不生成设备标识、不取浏览器 Cookie，User-Agent 如实标明本工具。
- 森空岛社区每次运行一个匿名 GET；签名要求（HTTP 401 或代码 10000、10002、10003）按风控处理：停止、暂停 30 分钟、不重试、不改用账号凭据。
- B 站每次运行最多三个请求；只有字幕列表请求带 SESSDATA；字幕文件主机白名单；不接受短链。
- B 站只有 -101 记过期，访客回答不改状态，认出登录才记可用；风控代码 -412、-352、-509、-799、-503 和 HTTP 412。
- 闸门数值与 18 相同但各来源分开；缓存各 24 小时；正文和简介 4000 字、字幕 8000 字、摘录 600 字；不存作者账号 ID。

只影响实现、不是产品限制的选择：字幕优先选中文、其次自动生成的中文、再其次第一条；字幕按不超过 600 字的段落切分，每段带开头时间点；森空岛来源显示名为「森空岛社区 / Skland community」，B 站为「Bilibili」（Markdown 由共用格式自动加「实验性」）。

## 测试与运行记录

本机 Windows 11、Node 24。测试用真实临时目录、真实 CLI、真实缓存和锁文件、真实凭据存储（只替代 Windows 加密边界）；只替代网络：导出函数测试注入传输替身（复用 18 的 `tests/fixtures/nga-data.ts` 里的 `transportDouble`），CLI 测试用新增的 `tests/fixtures/community-boundary.mjs` 以 `--import` 把 `research-fetch.ts` 引用的传输换成按完整 URL 应答的替身，替身只记录请求头名称和 Cookie 的哈希。合成样例按[社区来源核对](community-sources.md)里的结构自写。没有读取维护者的真实凭据或私有目录。

先失败的证据：

- `tests/bilibili.test.ts` 第一项先写，运行失败：`ERR_MODULE_NOT_FOUND`（`bilibili.ts` 不存在）；实现后通过。
- `tests/skland-community.test.ts` 第一项先写，运行失败：同样找不到 `skland-community.ts`；实现后通过。
- `tests/community-cli.test.ts`「every user entry …」先于文档改动运行，失败（提到 B 站的入口行不足 5 行）；改完 SKILL 和接口说明后通过。
- 变异核对（改完即恢复，恢复后逐字节比对一致）：B 站把访客回答也记过期 → 「only an explicit "not signed in" …」失败；把 `evil.example` 加进字幕主机白名单 → 「description and subtitle text are only data …」失败；森空岛去掉签名代码和 401 判定 → 签名测试与「code 10003 with HTTP 200」两项失败。

单文件运行（每个一次，按维护者 2026-11-13 的机器负载要求，没有重复循环，没有运行完整门禁）：

- `tests/bilibili.test.ts`：12 项通过。
- `tests/skland-community.test.ts`：9 项通过。
- `tests/community-cli.test.ts`：3 项通过。
- `tests/community-scenarios.test.ts`：1 项通过（两个场景 × 两种安装布局，`requests` 为 0，文件无改动，评分通过）。
- 因改了 `research.ts` 而重跑：`tests/research.test.ts` 6 项、`tests/nga.test.ts` 12 项、`tests/nga-cli.test.ts` 3 项、`tests/research-scenarios.test.ts` 1 项，全部通过。
- 因改了 SKILL 而重跑：`tests/account-installation.test.ts` 2 项、`tests/help-installation.test.ts` 6 项、`tests/metadata.test.ts` 1 项，全部通过。
- `npm run typecheck`：通过。`node scripts/tracker.ts`：无错误。`node scripts/privacy.ts .`：无发现（第一次报了两处，`bilibili.ts` 构造 Cookie 请求头的一行和接口说明里的一处写法命中启发式规则，改写后通过）。`inspectMetadata`：无错误。`node scripts/eval-selftest.ts`：通过（7 条规则、14 份样例）。
- 完整离线门禁 `node scripts/check.ts`：按维护者要求本票没有运行，由协调者逐包串行运行。

## 未验证

- 真实站点：森空岛是否有不需要客户端签名的公开读取方式、帖子真实字段；带 SESSDATA 时字幕列表、`login_mid`、字幕文件主机与格式、失效时的真实回答；两站的真实风控信号；如实 User-Agent 长期是否被接受；3 秒和 30 分钟是否够用。清单见[社区来源核对](community-sources.md)「未验证」。核对时只发了几次不带凭据的请求。
- Windows 传输经系统代理和证书存储访问这两个站点：与 18 相同，只对本机替身实测。
- 真模型行为评测：两个新场景只做了离线评分链路自检。maa-account、maa-core、maa-help 的 SKILL 有改动，按开发约定需要同模型、同场景的前后评测；缺工单 28 的运行入口和维护者的评测登录，留给工单 26。
