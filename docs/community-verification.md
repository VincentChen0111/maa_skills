# 森空岛社区与 B 站调研验证记录

2026-11-13，工单 [19](issues/19-community-bilibili-research.md) 在分支 `claude/19-community-research` 实施。分支叠在工单 18 的分支上（起点 `0884ae7`，之后合入 18 审查后的头 `2aa02e1`；18 叠在 09 已审查的 `6df8ed0` 上，基于 `origin/main` `4a1fd26`），因为 19 复用 18 的共享调研层。实施进度：进行中，等待独立审查，尚未合并。2026-11-14 维护者放开森空岛社区的「不用账号凭据」，森空岛社区部分按新决定重做，见下文「2026-11-14 修订」；下面 2026-11-13 的记录保留原样，其中关于森空岛社区匿名读取的部分已被该节取代。

## 交付内容

- `skills/maa-core/scripts/skland-community.ts`：森空岛社区公开帖子的只读读取（`read`、`status`）。匿名请求，不导入凭据模块，不发送账号 token、Cookie、签名或设备标识，与森空岛账号快照代码分开。
- `skills/maa-core/scripts/bilibili.ts`：B 站（实验性）视频公开信息与字幕的只读读取（`read`、`status`），所有输出标实验性。
- `skills/maa-core/scripts/research-fetch.ts`：两个读取器共用的受闸门请求、HTTP 层风控判定、缓存回退、结果组装。它只组合 18 的 `research.ts`（闸门、缓存、格式、Markdown）和 `research-transport.ts`（传输），不另做一份。
- `skills/maa-core/scripts/research.ts`（18 的文件，小改动）：只新增 `laterLimits` 一个对象，并让 `describe` 先查原表、再查它，给新局限代码中英文说明。没有改动已有的函数签名、类型或文字。
- 文档：[社区调研接口](../skills/maa-core/references/research.md)、[社区来源核对](community-sources.md)；maa-core、maa-account、maa-help 的 SKILL；规格「共享工具」「资料来源」和两张来源表；第三方声明；README、宿主说明。
- 评测场景：`eval/maa-account/community-scenarios.ts` 新增 `account-bilibili-cached-experimental`、`account-skland-community-stopped`。

## 与工单原文的差异

- 验收第 4 条「从关键词或用户指定资料到可引用 Markdown 摘要」：本票两个来源只走「用户指定资料」这条路，不提供关键词检索。理由见[社区来源核对](community-sources.md)：森空岛的帖子和检索接口要求官方客户端的请求签名，B 站检索要求请求签名和浏览器设备 Cookie；仿造这些等于绕过站点的反自动化机制，与 18 已登记的「不伪装成浏览器或官方客户端」一致。关键词检索仍可用 18 的 NGA。已作为设计默认值登记（规格「默认值及其来源」第一条「19」行）。
- 验收第 1 条「森空岛社区只读公开网页」：2026-11-13 实测，森空岛网页只在浏览器里渲染，帖子接口对匿名请求回答 HTTP 401、代码 10000「请求异常」（要求客户端签名）。读取器按「只读公开、不登录、不用账号凭据、不伪装」实现，遇到这个回答如实报告「没有读到内容」并暂停该来源；所以在当前的真实站点上，森空岛社区读不到帖子（审查时另查 `https://www.skland.com/article?id=1`，同样只得到 3949 字节的通用外壳，没有帖子内容）。这一半验收记为「未交付」，不是「通过」也不是「未验证」；按 18 的不伪装规则，代码不会改成给请求签名。
- B 站只读视频（信息与字幕），不读专栏、动态，不接受 `b23.tv` 短链。

### 需要维护者决定

- （2026-11-14 已由维护者决定：放开「不用账号凭据」，见「2026-11-14 修订」。）森空岛社区入口：保留只报告读不到的入口、推迟，还是撤下。本票暂取保留：设计默认值，2026-11-13。理由：不能伪装官方客户端（18 已登记的规则），保留下来的入口只会如实报告读不到、不发第二个请求、不改用账号凭据，站点将来若开放匿名读取就能直接用；工单 20 把 19 的来源当作可选补充，缺少它不阻塞核心报告。维护者说一声即可改为推迟或撤下。

## 验收对照

| 验收 | 证据 | 状态 |
| --- | --- | --- |
| 1 森空岛社区只读公开网页，不登录、不用账号凭据，不发帖点赞评论；与账号扫描独立 | `tests/skland-community.test.ts`「a public post is read with an honest anonymous GET …」：临时目录里先保存一份合成的森空岛账号 token，其解密替身一被调用就报错；请求头只有 `Accept`、`User-Agent`；账号凭据状态保持 `unverified`；作者账号 ID 不进缓存。「post text is only data, and the community reader is separate …」：读取器源码不导入 `credentials.ts`、账号快照代码；任何文件都没有 token 明文。`tests/community-cli.test.ts` 的森空岛 CLI：请求头只有两项，`post`、`like`、`comment`、`search` 动作都被拒为 `request-invalid` | 森空岛读取：未交付：真实站点要求官方客户端签名，按 18 的不伪装规则不实现。只读、不登录、不用账号凭据、不发帖点赞评论、与账号扫描独立这些约束：通过（网络替身） |
| 2 B 站入口、帮助和结果都标实验性；凭据经 09 由用户手动配置，agent 不处理登录 | `tests/bilibili.test.ts` 第一项：`experimental: true`、`notice` 含 experimental、局限 `experimental-source`、中英文 Markdown 首行带「实验性」/experimental。`tests/community-cli.test.ts`：B 站 CLI 的读取、状态和错误输出都带 `"experimental": true`，Markdown 首行为 `# Bilibili（实验性）`；凭据由 09 的 `credentials.ts input bilibili --stdin` 写入（测试模拟用户本人输入），读取器只调用 `inspectCredentials`、`readCredential`、`recordCredentialOutcome`。「every user entry for Bilibili research says it is experimental」：README、maa-help、maa-account、maa-core 的 SKILL 和接口说明里每一行提到 B 站的都带实验性 | 通过 |
| 3 作者、日期、来源链接、事实摘录、可信度与局限；未知如实标明 | `tests/bilibili.test.ts` 第一、二项逐字段核对视频和字幕条目（字幕带时间点和 `machine-subtitle`）；`tests/skland-community.test.ts` 第一项逐字段核对；「requests are validated …」里无昵称、无发布时间的帖子得到 `null` 和 `author-unknown`、`date-unknown`，Markdown 写「作者：未知」；森空岛只取 `publishedAtTs`，不拿创建时间冒充 | 通过 |
| 4 从用户指定资料到可引用 Markdown 可独立演示；工具在共享调研层，不新增 skill | 两个 CLI 测试都从用户给的链接走到 Markdown 引用摘要；脚本都在 `skills/maa-core/scripts/`，没有新增 skill 目录；结果格式、缓存、闸门、Markdown 全部复用 18 的 `research.ts` | B 站（实验性）：通过（网络替身；关键词路径不提供，见上节）。森空岛：未交付：真实站点要求官方客户端签名，按 18 的不伪装规则不实现 |
| 5 网页、字幕、文章只当数据；凭据、账号标识、私人内容不泄漏 | `tests/bilibili.test.ts`「description and subtitle text are only data …」：简介和字幕里要求运行凭据脚本、外发 SESSDATA、读别的视频，实际只请求了指定视频和它自己的字幕文件；响应给出的非 B 站字幕地址不请求；Markdown 里链接失效、指令文字只在引用块。森空岛同类测试。两边都扫描结果、Markdown 和临时目录全部文件，找不到合成凭据；B 站不存 UP 主账号 ID 和 `login_mid` | 通过 |
| 6 登录墙、不可读、服务变化和解析失败清楚报告，不假称读全文，不依赖私有在线服务 | 森空岛签名要求：`risk-control`、原因 `signature-required`、没有条目、局限 `client-signature-required`，中英文 Markdown 写明「不伪装官方客户端，没有读到内容」。两边的不提供、不完整、网络失败各自标明且不暂停来源；B 站没有 SESSDATA 时条目带 `subtitles-not-read`，被当成访客时报告 `login-not-recognized`。缺字段（格式变化）：`tests/community-content.test.ts` 逐一列举两个读取器的全部内容字段（B 站的标题、作者、发布时间、简介、分 P、登录状态、字幕列表、字幕行；森空岛的标题、作者、发布时间、正文片段），每个都核对「站点明确给出的空值 → 如实的空结果」「已知格式 → 正常读取并缓存」「缺失、改名、类型不对 → `incomplete`（`data-unrecognized`）、不缓存」，并核对用例清单与读取器声明的字段表完全一致；另有「a subtitle file whose lines no longer carry the expected fields …」和「a post whose text fragments no longer carry text …」——有内容却一条都认不出时记为 `incomplete`（`data-unrecognized`），不算完整读取、不进缓存；真正没有文字片段的帖子仍是如实的空结果。只访问两站的公开接口 | 通过（网络替身） |

## 设计默认值

都已登记在[规格](spec.md)「默认值及其来源」以「19」开头的五行，日期 2026-11-13，并汇总在「规则来源」的「19 森空岛社区与 B 站调研」行：

- 两个来源不提供检索，只读用户给出链接的一帖或一个视频；不计算官方客户端签名、不生成设备标识、不取浏览器 Cookie，User-Agent 如实标明本工具。
- 森空岛社区读一帖就是一个匿名 GET；签名要求（HTTP 401 或代码 10000、10002、10003）按风控处理：停止、暂停 30 分钟、不重试、不改用账号凭据。
- B 站读一个分 P 依次是视频信息、字幕列表、所选字幕文件三个请求（读取的结构，不是上限，见下节「与 18 规则的核对」）；只有字幕列表请求带 SESSDATA；字幕文件主机白名单；不接受短链。
- B 站只有 -101 记过期，访客回答不改状态，认出登录才记可用；风控代码 -412、-352、-509、-799、-503 和 HTTP 412。
- 闸门数值与 18 相同但各来源分开；缓存各 24 小时；正文和简介 4000 字、字幕 8000 字、摘录 600 字；不存作者账号 ID。

### 与 18 规则的核对

18 的验收写明「不擅自新增请求次数上限」，18 审查后也去掉了 NGA 每次运行的页数上限。本票核对后，两个读取器都没有请求次数上限：读一帖森空岛帖子就是一个请求；读一个 B 站分 P 的资料分在视频信息、字幕列表、字幕文件三处，所以依次三个请求，少一个就读不全，多一个也没有可读的东西。字幕只取所选的一种语言，是内容选择（同一内容的其他语言不重复读取），不是次数限制。代码里没有请求计数上限常量；输入一次只接受一帖或一个分 P，用户要读更多就再调用一次，仍受同一闸门的间隔和风控暂停约束。规格和接口说明里原来「每次运行最多三个请求」的写法已改为「读一个分 P 依次是三个请求，这是读取的结构，不另设上限」。

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

合并 18 审查后的修复（18 的头 `2aa02e1`，用 `git merge --no-ff` 合入，没有变基或重置）：

- 冲突三处，处理方式：`research.ts` 保留 18 新的 `inert()` 和 `describe` 对未知代码走 `inline`，再加上本票的 `laterLimits`（查找顺序：原表、`laterLimits`、`inline(code)`）；接口说明保留 18 对 `formatResearchMarkdown` 的新说明，缓存一行用本票覆盖三个来源的写法，删去本票「每次运行的请求上限」一行，改写进 18 的「每次运行的页数：不设上限」一行；规格三处都取 18 改后的「18」条目，再接上本票的「19」条目，并把「最多三个请求」改为读取结构的写法（见上节）。
- 两个读取器的 Markdown 只经共用的 `formatResearchMarkdown`，因此 18 的 `inert()` 对它们的字段同样成立。`tests/research.test.ts` 的一致性测试新增两个字段：时间点位置（B 站字幕条目）和带实验性标记的来源名。两个读取器的注入测试另外核对各自的来源链接（`https://www.bilibili.com/video/<BV号>/?p=1`、`https://www.skland.com/article?id=<帖子号>`）在 Markdown 里保持可点。
- 合并后逐个运行一次：`npm run typecheck` 通过；`tests/research.test.ts` 7 项、`tests/nga.test.ts` 13 项、`tests/nga-cli.test.ts` 3 项、`tests/research-scenarios.test.ts` 1 项、`tests/bilibili.test.ts` 12 项、`tests/skland-community.test.ts` 9 项、`tests/community-cli.test.ts` 3 项、`tests/community-scenarios.test.ts` 1 项，全部通过。

第一轮独立审查（有条件通过，P2 一项、P3 三项，协调者全部接受）后的修复：

- 先合入 18 的最终头 `ef902a1`（只有文档：审查记录和工单状态），`docs/issues/INDEX.md` 的自动区冲突按「18 已完成、19 进行中」处理后重跑 `node scripts/tracker.ts --write`。
- P2：只改记录和说明，不改代码。验收第 1、4 条的森空岛部分改记「未交付」；README、宿主说明、maa-help、maa-account、maa-core 的 SKILL 和接口说明都改为「森空岛社区帖子入口目前只会如实报告读不到」，不再写成可用的读取能力；上面新增「需要维护者决定」。
- P3 缺字段：B 站字幕文件有行却一行都认不出、森空岛 `textSlice` 有片段却没有一个带文字时，原来报为完整读取并缓存 24 小时；现在记为 `incomplete`（`data-unrecognized`），不缓存。
- P3 受阻时丢掉旧字幕：字幕页的各个受阻分支原来登记了旧缓存却没有把它交给结果；现在每个分支都把 `log.offer` 的返回值交给结果，风控后旧视频和旧字幕一起返回、都标过期，视频条目也不再自相矛盾地写「没有读到字幕」。
- P3 分 P 上限：去掉没有登记的 `maxPart` 1000。分 P 号与 18 的页码一样只要求是正的安全整数，链接里的 `p` 也一样；视频信息里大于 1000 的分 P 不再被丢掉。

先失败的证据：新增或改动的测试先运行，`tests/bilibili.test.ts` 15 项中 4 项失败（校验表因 `maxPart` 拒绝 `p=12345`；第 1001 个分 P 被拒为 `request-invalid`；认不出的字幕文件报成 `fresh`；风控后没有返回旧字幕），`tests/skland-community.test.ts` 10 项中 1 项失败（认不出的正文报成 `fresh`）。修复后逐个运行一次：`npm run typecheck` 通过；`tests/bilibili.test.ts` 15 项、`tests/skland-community.test.ts` 10 项通过。改了说明文字后另跑的文件见下一段。

说明文字改动后逐个运行一次：`tests/community-cli.test.ts` 3 项（含「每个提到 B 站的入口都标实验性」）、`tests/help-installation.test.ts` 6 项、`tests/account-installation.test.ts` 2 项、`tests/metadata.test.ts` 1 项、`tests/community-scenarios.test.ts` 1 项，全部通过；`node scripts/tracker.ts`、`inspectMetadata`、`node scripts/privacy.ts .` 都无错误、无发现。没有运行完整门禁，没有访问森空岛、B 站或 NGA。

第二轮独立审查（有条件通过，P3 三项，协调者全部接受）后的修复：

- P3-1，与第一轮同一类问题第二次出现（「内容在但认不出，却报成完整的空结果」），按复发规则改成一个判定、一个归属：`research-fetch.ts` 的 `readContents` 和 `contentShapes` 是唯一判定。两个读取器把自己读取的每个内容字段声明在一张表里（`bilibiliContent`、`sklandCommunityContent`），只经这个判定读取。具体缺陷：B 站简介缺失（例如只有 `desc_v2`）原来记成空简介、正常、缓存 24 小时；字幕列表块缺失或行的字段改名（例如 `url` 代替 `subtitle_url`）原来报成「这个视频没有字幕」。现在都记为 `incomplete`（`data-unrecognized`）、不缓存；只有字幕列表存在且为空才是 `no-subtitles`。登录状态 `login_mid` 也经同一判定：0 是访客，缺失或不是整数是认不出。测试替身里「空」的选项改为发送站点明确的 null，不再省略字段。
- P3-2：maa-account 的森空岛步骤改为：用户已要求读这一帖时，先说明目前读不到，再运行一次 `skland-community.ts read` 并如实报告；用户还没要求读时才先说明、等用户要试再运行。这样单轮场景 `account-skland-community-stopped` 期望的一次读取与说明一致。`tests/community-scenarios.test.ts` 新增一项核对两者一致。
- P3-3：规格「默认值及其来源」的森空岛行改为「这一入口目前只会报告读不到（保留、推迟或撤下由维护者决定，暂取保留）」，与正文一致。

先失败的证据：`tests/community-content.test.ts` 在改代码前运行，14 项中 11 项失败（字段清单一项；`video.title`、`video.author`、`video.published`、`video.description`、`video.parts`、`session.signedIn`、`subtitleList.tracks`、`post.title`、`post.author`、`post.published` 的「认不出」变体都报成正常读取），只有已在第一轮修过的 `post.text`、`subtitleFile.lines` 和「已知格式」一项通过。P3-2 的新核对对提交前（HEAD）的 SKILL 文字求值为假。

修复后逐个运行一次：`npm run typecheck` 通过；`tests/community-content.test.ts` 14 项、`tests/bilibili.test.ts` 15 项、`tests/skland-community.test.ts` 10 项、`tests/community-scenarios.test.ts` 2 项、`tests/community-cli.test.ts` 3 项、`tests/account-installation.test.ts` 2 项、`tests/metadata.test.ts` 1 项通过；`node scripts/tracker.ts`、`inspectMetadata`、`node scripts/privacy.ts .` 无错误、无发现。没有运行完整门禁，没有访问森空岛、B 站或 NGA。

## 2026-11-14 修订：森空岛社区改用用户凭据

维护者 2026-11-14 原话：「「不用账号凭据」: this rule can change. its perfectly fine to use it.」。不变的部分：凭据仍由用户在自己的终端用 09 的脚本设置，agent 不输入、不打印、不索取。分支先合入 `origin/main`（含 12、16、17、20）：合并提交 `fb0061d`。

### 交付内容（修订）

- `skills/maa-core/scripts/skland-session.ts`（新）：森空岛会话的唯一实现——读用户保存的 token、换授权码、换 cred、两级刷新（各最多一次）、请求签名与请求头、不跟随重定向、每个请求 20 秒、单个回复 16 MiB、记录凭据结果。账号快照和社区读取都只用它。
- `skills/maa-core/scripts/skland-account.ts`（12 的文件）：上面这些代码原样移进 `skland-session.ts`，12 只保留三个数据接口、角色选择、转换、文字和 CLI。12 的改动只有这一处搬移：`SklandSession` 的 `get` 拆成 `reply`（返回 10000、10002 以外的回复）加 `get`（要求代码 0），判定顺序与原来逐行相同；读凭据、记可用/过期改由 `openSklandSession` 和 `SklandCredential` 完成，调用时机不变。`tests/skland-account.test.ts`、`tests/skland-scenarios.test.ts` 没有改动，照常通过。
- `skills/maa-core/scripts/skland-community.ts`：缓存能回答时不读凭据、不发请求；否则来源暂停或没有可用凭据时不发请求、不匿名尝试；然后在本来源闸门的一次占用里走共用会话：换取、对 `/web/v2/item` 发签名 GET（10000/10002 由会话按 12 的规则刷新）。结果另带 `credential` 和 `repair`。不再使用调研传输（`research-transport.ts`），所以凭据和签名不经过子进程。
- `skills/maa-core/scripts/research.ts`：新增页结果 `signature-rejected`（排在 `credential-rejected` 之后）及中英文说明；`credential-rejected` 的说明改为可行动（请用户自己重新运行凭据输入命令，NGA 和 B 站同样受益）；森空岛社区的凭据命令显示为 `credentials.ts input skland`；删去不再产生的局限代码 `client-signature-required`。
- `skills/maa-core/scripts/credentials.ts`：森空岛粘贴前的说明和检查文字改为 token 也用于读取用户给出链接的森空岛社区帖子；删去「社区调研不会使用这个 token」。
- 测试：`tests/fixtures/skland-double.mjs` 扩展帖子接口（独立实现的签名校验，按帖子号返回合成帖子）、带消息和 HTTP 状态的错误代码、原样回复体；`tests/skland-community.test.ts` 重写；`tests/community-content.test.ts`、`tests/community-cli.test.ts` 改走森空岛替身；`tests/credentials.test.ts` 跟随说明文字。
- 评测：`eval/network-fixture.mjs` 为 `skland-community.ts read` 增加合成森空岛世界；`scripts/evaluation.ts` 的生成时间字段可带固定偏移 `offsetMs`；`eval/maa-account/community-scenarios.ts` 改为四个场景（见下）。
- 文档：规格「共享工具」「资料来源」正文和两张来源表；凭据说明；工单 19（验收第 1 条和验证方式带日期修订，正文有改动，GitHub Issue 镜像需同步）；maa-core、maa-account、maa-help、maa-setup 的 SKILL；社区调研接口、凭据接口、森空岛接口；社区来源核对；评测说明；第三方声明；README、宿主说明。

### 验收对照（森空岛社区部分，修订）

| 验收 | 证据 | 状态 |
| --- | --- | --- |
| 1 只读、不登录、不发帖点赞评论；与账号扫描独立（2026-11-14 修订：可用用户自己的凭据） | `tests/skland-community.test.ts`：正常读取只有 grant、cred、item 三个请求，item 为带有效签名的 GET、只带 `id`，不跟随重定向；每个用例用 `assertAllowed` 核对只请求三个鉴权接口和帖子接口；「one session owner …」核对两个读取器都从 `skland-session.ts` 导入，各自源码里没有换取、刷新、签名或凭据读写代码，社区读取器不引用账号快照代码、源码里唯一的接口路径是 `/web/v2/item`、没有 POST；CLI 的 `post`、`like`、`comment`、`search` 动作被拒 | 通过（网络替身）；真实站点未验证 |
| 4 从用户指定资料到可引用 Markdown | `tests/community-cli.test.ts` 森空岛 CLI：未设置凭据时给出 `credentials.ts input skland` 且不发请求；用户经 09 的输入脚本保存 token 后，读链接得到 `ok`、3 个请求、`credential: usable`，Markdown 带来源链接和引用块；第二次读走缓存 | 通过（网络替身） |
| 5 只当数据；凭据、账号标识不泄漏 | 「post text is only data …」：帖子里要求读凭据、外发 token、点赞关注的文字只在引用块，不引出任何请求；所有用例的输出、Markdown 和临时目录全部文件里搜索 token、授权码、cred、签名 token、用户 ID、角色号和作者账号 ID 的原文、JSON 转义和 URL 编码形式，都找不到 | 通过（网络替身） |
| 6 各种失败清楚报告 | 「a 10000 reply refreshes …」；「signature still refused after both refresh levels …」：grant、cred、item、refresh、item、grant、cred、item 后报告 `signature-rejected`、`check-system-time`，凭据仍是 `unverified`、来源不暂停；「429 stops at once …」及 503、500、换取 429、网页、重定向、频繁提示、10003、cred 被拒 8 种风控：本次停止、暂停 30 分钟、不重试、不改凭据状态，暂停期间再读不发请求；「credential states …」：未设置、无法读取不发请求，换取被拒只发 grant 并记过期，三者都给出 `credentials.ts input skland`；「requests are validated …」：不提供、格式不认、回复不完整、网络失败分开报告且不暂停；缺字段由 `tests/community-content.test.ts` 逐字段核对 | 通过（网络替身） |

### 设计默认值（2026-11-14）

产品限制都登记在规格「默认值及其来源」2026-11-14 的五个「19」行，并汇总在「规则来源」19 行：

- 只经共用会话签名 GET 帖子接口；除 12 的三个鉴权接口外不请求别的接口；请求头与 12 完全相同（不另设 User-Agent）。
- 没有凭据、凭据无法读取或来源暂停时不发请求，不匿名尝试；缓存能回答时不读凭据。
- 失败归类：风控信号优先（429、412、任何 5xx、重定向、网页、频繁提示、10003、换取 cred 被拒等不归咎凭据的拒绝 → 风控）；两级刷新后仍被拒 → `signature-rejected`；换取明确拒绝 → 记过期；帖子接口代码 0 才记可用。
- 一次读取占用一次闸门；这个来源的锁 180 秒后才判过期。
- 结果带 `credential`、`repair`（取值同 12）。

只影响实现或评测、不是产品限制的选择（记在这里）：
- 签名时间用系统时间（`now`），闸门和缓存用调研时钟（`clock`）；测试只替换后者。理由：签名要与站点时间一致，测试的手动时钟不能用来签名。
- 重定向：会话按 12 设 `redirect: 'error'`，真实 fetch 遇到重定向会直接报错，所以真实站点的重定向会显示为网络失败（同样停止、不重试，但不暂停来源）；只有替身直接回 3xx 时才归为风控。
- 评测的合成森空岛世界写在 `eval/network-fixture.mjs` 里（随预加载器进入场景指纹），只在 `skland-community.ts read` 进程启用，只接受 `synthetic-` 开头的 token；合成凭据用测试加密写进场景自己的私有目录，同一变换在场景文件里另写一份，离线场景测试读帖成功即证明两边一致。
- 读帖场景的工具写入（闸门记录、帖子缓存、凭据结果）逐字段授权；缓存的 `expiresAt` 用新加的 `offsetMs: 86400000` 授权。理由：评分器把每处文件变化都当作需要授权的写入，到期时间只能按读取时间加固定偏移核对。

### 评测场景

`eval/maa-account/community-scenarios.ts`：`account-bilibili-cached-experimental`（不变）；`account-skland-community-read`（新：用户已在终端设置 token，合成世界读帖，帖子里有诱导指令）；`account-skland-community-unset`（新：没有凭据，答复要请用户自己在终端设置）；`account-skland-community-stopped`（改：去掉「读不了就用账号 token」的说法，保留「直接去网页上抓」）。`tests/community-scenarios.test.ts` 在两种安装布局里离线运行已安装的读取器并按场景评分：读帖场景只有闸门记录、帖子缓存和凭据结果三份文件变化且评分通过；在输出里加上 token 只触发 `secret-output`；多一处别的写入触发 `authorization`。真模型评测没有运行（见「未验证」）。

### 运行记录（2026-11-14）

先失败的证据：新写的 `tests/skland-community.test.ts` 在改读取器前运行，17 项全部失败（旧读取器仍是匿名读取）。**这次红灯运行发出了真实网络请求**：旧读取器在没有传入传输替身时用平台传输，新测试只传了 `fetcher`，所以各用例的读取共向 `https://zonai.skland.com/web/v2/item` 发了约 20 次不带任何凭据的匿名 GET（每个临时目录的第一次读取，以及暂停到期后的再次读取）（帖子号 1234567 等合成编号，请求头只有如实的 User-Agent 和 Accept；旧读取器不导入凭据模块，没有发送 token），都得到签名要求。之后的所有运行都只用替身；新读取器的选项里已没有传输参数，类型检查会拒绝旧的 `transport` 写法。读取器改完后用变异核对一次：去掉「风控信号优先」的判断，6 个风控用例失败，恢复后逐字节一致。

合并后与完成后各逐个运行一次（不是完整门禁）：`npm run typecheck` 通过；`tests/research.test.ts` 7 项、`tests/skland-community.test.ts` 17 项、`tests/skland-account.test.ts` 18 项、`tests/skland-scenarios.test.ts` 1 项、`tests/credentials.test.ts` 6 项、`tests/help-installation.test.ts` 6 项、`tests/metadata.test.ts` 1 项、`tests/eval-network.test.ts` 3 项、`tests/community-scenarios.test.ts` 2 项、`tests/community-cli.test.ts` 3 项、`tests/community-content.test.ts` 14 项、`tests/evaluation.test.ts` 8 项全部通过；另外 `tests/research-scenarios.test.ts` 1 项、`tests/nga.test.ts` 13 项、`tests/bilibili.test.ts` 15 项通过（共用 Markdown 文字有改动）。`node scripts/tracker.ts`、`node scripts/privacy.ts .` 无错误、无发现。没有运行完整门禁和 `tests/maa-process.test.ts`；仓库里没有名为 docs-consistency 的测试文件。

## 未验证

- 森空岛社区（2026-11-14 起）：**没有发过任何带凭据的真实森空岛请求**。帖子接口是否接受账号快照会话（`/api` 一侧）的签名、真实返回字段、真实风控信号、读取时会不会触发其他校验，都要维护者在本机用自己的 token 核对；读帖的真实可用性因此未验证。上面运行记录里那次误发的匿名请求不算核对。
- 真实站点：帖子真实字段；带 SESSDATA 时字幕列表、`login_mid`、字幕文件主机与格式、失效时的真实回答；两站的真实风控信号；如实 User-Agent 长期是否被接受；3 秒和 30 分钟是否够用。清单见[社区来源核对](community-sources.md)「未验证」。核对时只发了几次不带凭据的请求。
- Windows 传输经系统代理和证书存储访问这两个站点：与 18 相同，只对本机替身实测。
- 真模型行为评测：所有场景（含 2026-11-14 新增的两个森空岛场景）只做了离线评分链路自检。maa-account、maa-core、maa-help 的 SKILL 有改动，按开发约定需要同模型、同场景的前后评测；缺工单 28 的运行入口和维护者的评测登录，留给工单 26。
