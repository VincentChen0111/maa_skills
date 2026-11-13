# 19 森空岛社区与 B 站读取来源核对

核对日期：2026-11-13。只读公开网页、公开脚本和公开资料，另外不带任何凭据发了几次只读请求（逐条写在下表）；没有登录森空岛或 B 站，没有使用真实 token、Cookie 或 SESSDATA，没有运行第三方客户端。接口见[社区调研接口](../skills/maa-core/references/research.md)，验收记录见[社区调研验证记录](community-verification.md)。

## 森空岛社区

| 事实 | 来源 | 许可与用法 | 核实情况 |
| --- | --- | --- | --- |
| `https://www.skland.com/` 返回约 4 KB 的应用外壳：只有标题和脚本，帖子内容由浏览器运行脚本后再取，网页本身没有可读的帖子正文 | 2026-11-13 不带凭据请求一次 | — | 实测 |
| 网页脚本的接口主机是 `https://zonai.skland.com`；帖子详情是 `GET /web/v2/item`，参数为 `id`；帖子链接形如 `https://www.skland.com/article?id=<帖子号>`；帖子检索是 `GET /web/v2/search/item`（参数没有确定） | 2026-11-13 `www.skland.com` 加载的公开脚本（`bbs.hycdn.cn/skland-fe-static/skland-bbs/` 下） | 站点自有代码，未声明许可：只读取路径、参数名、字段名这类事实，没有复制代码 | 读脚本核实；接口真实返回见下两行 |
| 网页给每个接口请求加 `platform`、`vName`、`timestamp`、可选的设备标识 `dId` 和签名 `sign` 请求头；签名用的令牌来自 `/web/v1/auth/refresh`。收到代码 10000 时刷新令牌重发；HTTP 401 配代码 10000、10002、10003 被当作预期的鉴权回答 | 同上 | 同上 | 读脚本核实 |
| 帖子详情的数据是 `data.item`（`id`、`title`、正文片段 `textSlice`（每段 `{ id, c }`）、`publishedAtTs`、`createdAtTs`、`format`、`imageList`、`videoList` 等）和 `data.user`（`id`、`nickname`、`avatar`） | 同上，从脚本里使用这些字段的代码读出 | 同上 | **未验证**：没有看到真实返回 |
| 不带签名、如实标明本工具的匿名请求 `GET https://zonai.skland.com/web/v2/item?id=1` 得到 HTTP 401 和 `{"code":10000,"message":"请求异常"}` | 2026-11-13 请求一次 | — | 实测 |
| 匿名请求 `GET /web/v2/search/item?keyword=<关键词>&gameId=1` 得到 HTTP 400 和代码 10001「参数错误」 | 2026-11-13 请求一次 | — | 实测；没有继续试参数 |

## B 站

| 事实 | 来源 | 许可与用法 | 核实情况 |
| --- | --- | --- | --- |
| 视频信息 `GET https://api.bilibili.com/x/web-interface/view`，参数 `bvid` 或 `aid`；信封为 `code`、`message`、`ttl`、`data`；`data` 有 `bvid`、`aid`、`title`、`desc`、`pubdate`（秒）、`ctime`、`owner`（`mid`、`name`）、`cid`、`pages`（`cid`、`page`、`part`）、`duration`；错误码 -400、-403、-404、62002、62004、62012 | [bilibili-API-collect 镜像：视频信息](https://bilibili-api-collect.pages.dev/docs/video/info) | 原仓库 [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) 已于 2026-01-30 归档并删去文档，未声明许可；镜像是第三方副本。只读事实 | 2026-11-13 不带凭据请求两次：官方账号的公开视频 `aid=64688769` 返回代码 0 和上述字段（`subtitle.list` 为空）；`bvid=BV1GJ411x7h7` 返回 -404「啥都木有」 |
| 字幕列表在播放器信息里：`GET https://api.bilibili.com/x/player/wbi/v2`（或 `x/player/v2`），参数 `bvid`/`aid` 和 `cid`；`data.subtitle.subtitles[]` 有 `lan`、`lan_doc`、`subtitle_url`；`data.need_login_subtitle` 表示要不要登录；未登录时字幕列表为空 | [镜像：播放器信息](https://bilibili-api-collect.pages.dev/docs/video/player)；[yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/e8de28e23c1ecb4a12b2c3dec188c07e998c412c/yt_dlp/extractor/bilibili.py) 固定提交 `e8de28e23c1ecb4a12b2c3dec188c07e998c412c` 用 `x/player/wbi/v2` 取字幕，带 `aid`/`bvid` 和 `cid`，不做 Wbi 签名 | yt-dlp 为 Unlicense，只读事实，没有复制代码 | 2026-11-13 不带凭据请求一次（同一视频）：代码 0，`login_mid` 为 0，`need_login_subtitle` 为 true，没有 `subtitle` 块。带 SESSDATA 的返回**未验证** |
| 字幕文件是 JSON，`body[]` 每行有 `from`、`to`、`content` | yt-dlp 同一提交的字幕转换 | 同上 | **未验证**真实文件 |
| 检索 `x/web-interface/wbi/search/type` 等要求 Wbi 签名、Cookie 里的 `buvid3`、`.bilibili.com` 下的 Referer，2022-08-24 起 Cookie 不足返回 -412 | [镜像：搜索](https://bilibili-api-collect.pages.dev/docs/search/search_request) | 只读事实 | 公开资料；没有尝试 |
| 全局错误码：-101 账号未登录，-352 风控校验失败，-412 请求被拦截，-509 超出限制，-799 请求过于频繁，-503 过载保护，-500 服务器错误，-404 啥都木有 | [镜像：错误码](https://bilibili-api-collect.pages.dev/docs/misc/errcode) | 只读事实 | 公开资料；-404 与实测一致 |
| 字幕文件放在 `aisubtitle.hdslb.com`（自动生成字幕）和 `i0.hdslb.com` 等文件主机，地址常是 `//` 开头的无协议形式 | 对 B 站的一般了解 | — | **未验证**：上面的资料没有写主机名 |

## 由此得出的实现选择

- 两个来源都不提供检索，只读用户给出链接的一帖或一个视频。森空岛的帖子和检索接口要求官方客户端签名，B 站检索要求签名和浏览器设备 Cookie；本工具不计算官方客户端签名、不生成设备标识、不取浏览器 Cookie，这和 18「不伪装成浏览器或官方客户端」一致。用户要找资料时，可以自己在浏览器里搜，再把链接给 agent。
- 森空岛社区（2026-11-13 的做法）：只发匿名 `GET https://zonai.skland.com/web/v2/item?id=<帖子号>`，请求头只有 User-Agent 和 Accept；按上面的实测一律得到签名要求，所以读不到。
- 森空岛社区（2026-11-14 修订，维护者放开「不用账号凭据」）：用用户自己设置的森空岛 token，经与账号快照共用的会话（token 换授权码、换 cred、签名、两级刷新，事实来源见[森空岛接口来源](skland-account-sources.md)）对同一个帖子接口发签名 GET。签名用的是账号快照会话的 cred 和签名 token（来自 `/api/v1/user/auth/generate_cred_by_code` 和 `/api/v1/auth/refresh`），不是上表网页端的 `/web/v1/auth/refresh`；帖子接口是否接受这种签名、`/web/v2/item` 的真实返回字段，都**未验证**（本次没有发任何真实的森空岛请求）。没有凭据时不发请求，也不匿名尝试。
- 森空岛正文按 `textSlice` 的顺序拼接，原帖的段落和排版可能不同，结果带 `text-order-approximate`。时间只取 `publishedAtTs`；没有就写未知，不用 `createdAtTs` 冒充发布时间。作者只取昵称，不存账号 ID。
- B 站：视频信息不带凭据；字幕列表请求带用户保存的 SESSDATA，用 yt-dlp 采用的 `x/player/wbi/v2` 且不签名；字幕文件只从字幕列表给出的 `aisubtitle.hdslb.com`、`i0`/`i1`/`i2.hdslb.com` 的 https 地址读取，不带凭据。字幕优先选中文，其次自动生成的中文，再其次第一条。
- 凭据结果：只有 -101 记过期；带 SESSDATA 却被当成访客（`login_mid` 为 0）时只报告 `login-not-recognized`，不改状态；`login_mid` 大于 0 才记可用。`login_mid` 是账号标识，只在内存里比较是否大于 0，不保存、不输出。
- 风控判定：两站共有 412、429、503、任何重定向、要数据却得到网页；B 站另加代码 -412、-352、-509、-799、-503 和提到频繁、风控、拦截、稍后、验证的消息；森空岛另加提到频繁、稍后、验证、风控的消息；2026-11-14 起森空岛社区的 10000、10002 由共用会话按 12 的两级刷新处理（之后仍被拒报告 `signature-rejected`），10003、任何 5xx 和换取 cred 被拒按风控处理。这是推断，真实信号未验证。
- 不接受 `b23.tv` 短链：要跟随跳转才能知道目标，读取器不跟随重定向。

## 未验证（需要维护者在本机核对）

1. 森空岛帖子接口是否接受账号快照会话的签名（2026-11-14 起的读取方式）；帖子详情的真实返回字段是否与脚本里的字段名一致；`textSlice` 拼接是否接近原帖。
2. 带 SESSDATA 时 `x/player/wbi/v2`（不签名）是否返回字幕列表，`login_mid` 是否大于 0；字幕文件主机和 `body` 格式；SESSDATA 失效时 B 站回答 -101 还是访客形态。
3. 如实的 User-Agent 在两站长期使用时是否被接受；真实风控信号是否与上面的判定一致；3 秒间隔和 30 分钟暂停是否够用。
4. Windows 传输经系统代理和证书存储访问这两个站点（本机只对本地替身实测，与 18 相同）。
