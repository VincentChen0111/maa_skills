# 18 NGA 读取来源核对

核对日期：2026-11-13。只读公开网页和公开仓库；没有登录 NGA，没有使用真实 Cookie，没有运行任何第三方 NGA 客户端。接口见[社区调研接口](../skills/maa-core/references/research.md)，验收记录见 [NGA 验证记录](nga-verification.md)。

规格写的「沿用被移植工具」指维护者私人项目里的 NGA 工具。它不在本仓库，本次也没有作为只读参考提供给实施者，所以 18 是独立实现：只保留规格点名的三样行为（跨进程限速锁、遇风控立即停止、缓存），具体数值和判定规则都是本次的设计默认值，已登记在规格两张来源表。

## 公开资料

| 事实 | 来源 | 许可与用法 | 核实情况 |
| --- | --- | --- | --- |
| 「明日方舟」版块 fid 为 `-34587507`（另有「明日方舟终末地」846） | NGA 公开版块列表 `https://bbs.nga.cn/app_api.php?__lib=home&__act=category&_v=2`，不需要登录 | 站点数据，只记事实 | 2026-11-13 读取一次核实 |
| 不带 Cookie 访问版块列表返回 403 | 2026-11-13 不带 Cookie 请求 `https://bbs.nga.cn/thread.php?fid=-34587507` 一次 | — | 实测 403；因此没有凭据时读取器不发请求 |
| 读帖 `read.php?tid=<帖子号>&page=<页>&__output=8`；检索 `thread.php?key=<关键词>&__output=8`，关键词用 UTF-8 百分号编码，翻页用 `page`；`__output=11` 是 UTF-8 变体 | [UNICKON/StealthReader](https://github.com/UNICKON/StealthReader/tree/98a3da93d1a5dc4bdf12166bd481e0bfc23beefe) 固定提交 `98a3da93d1a5dc4bdf12166bd481e0bfc23beefe` 的 `feed_sources.py` 与 `docs/community-feed-design.md` | 仓库未声明许可：只读取事实，没有复制代码或样例 | 公开资料；本仓库未对真实站点验证 |
| 读帖返回 `data.__T`（主题，含 `subject`）、`data.__R`（楼层，含 `lou`、`pid`、`authorid`、`content`、字符串 `postdate`、数字 `postdatetimestamp`）、`data.__U`（按用户号给出 `username`）、`data.__ROWS`；检索返回 `data.__T`（每行 `tid`、`subject`、`author`、数字 `postdate`、`lastpost`、`replies`、`fid`）和 `__T__ROWS`；每页约 20 楼，检索每页 35 条 | 同上，`tests/fixtures/nga_read.json`、`nga_search.json` 的结构与设计文档 | 同上；本仓库的合成样例只按结构自写 | 同上 |
| 错误信封：`error["0"]` 为「代码:消息」，`data.__MESSAGE` 依次是代码、消息、链接、HTTP 状态，`encode` 为 `gbk`。代码 1「未登录」配 403；代码 5「帖子发布或回复时间超过限制」配 403，表示旧帖不可看，不是登录问题 | 同上，`tests/fixtures/nga_unauth_403.json`、`nga_old_thread_403.json`，按 GBK 解码核对 | 同上 | 同上 |
| 响应声明 GBK，个别字段实际是 UTF-8；字符串里有原始控制字符，严格 JSON 解析会失败；部分帖子的 JSON 在同一位置稳定截断，重试无效 | 同上设计文档 | 同上 | 同上 |
| 检索列表里可能混入没有作者和时间的提示行 | 同上 `feed_sources.py` 的过滤说明 | 同上 | 同上 |
| 登录 Cookie 名为 `ngaPassportUid`、`ngaPassportCid` | [ludoux/ngapost2md](https://github.com/ludoux/ngapost2md/tree/0ca8a4423e7c768ada4b9c604326a6b33a85c3f4) 固定提交 `0ca8a4423e7c768ada4b9c604326a6b33a85c3f4` 的 `assets/config.ini`、`config/config.go`；[JackBoosY/dsh-nga](https://github.com/JackBoosY/dsh-nga/tree/c46d90e71cd5702d3024de5d0db5ffa0fd27b8b6) 固定提交 `c46d90e71cd5702d3024de5d0db5ffa0fd27b8b6` 的 `login.js`；[tyro668/harmony-open-nga](https://github.com/tyro668/harmony-open-nga) README | ngapost2md、dsh-nga 为 MIT，harmony-open-nga 没有正式许可；三者都只读取事实，没有复制代码 | 公开资料；未用真实 Cookie 验证 |
| 主域 `bbs.nga.cn`，备用 `bbs.ngacn.cc`；用户也会贴 `nga.178.com` 的帖子链接 | harmony-open-nga README；ngapost2md README 的示例输入 | 同上 | 公开资料 |
| 节奏参考：ngapost2md 每页请求前等 330 毫秒、并发 2；dsh-nga 巡检间隔随机 1–1.8 秒；两者都提醒避免频繁请求和大量并发 | ngapost2md `nga/nga.go`、README；dsh-nga README | 同上 | 仅作参考；本仓库取更保守的 3 秒且同一时刻只发一个请求 |
| 不像浏览器的请求可能得到 503；偶尔返回约 3 KB、状态 200 的空壳页面 | dsh-nga README | MIT，只读事实 | 公开资料 |

## 由此得出的实现选择

- 用 `__output=8`：两份公开实现实际在用。解码时字节是合法 UTF-8 就按 UTF-8，否则按 GB18030（GBK 的超集）；解析前把字符串里的原始控制字符转义。混用编码的单个字段可能出现乱码，未做逐字段修复（未验证）。
- 检索默认带 `fid=-34587507` 只搜明日方舟版块，可选全站。版块参数是否真的限定检索范围未验证。
- 读帖只取用户给的帖子号和页码，请求总是发到 `https://bbs.nga.cn`；帖子里的链接不会触发请求。
- 认证失败只认 NGA 的「未登录」（代码 1 且消息含「登录」），只有这时记凭据过期。代码 5 和其他拒绝按「不提供」处理。
- 风控判定：公开资料只记录了 503 和空壳页面。本仓库保守地把 429、503、任何重定向、要数据却得到网页、站点消息提到频繁/过快/稍后/验证码都视为风控，立即停止并让整个来源暂停 30 分钟。这是推断，真实信号未验证。
- 截断或无法识别的数据记为「不完整」，不重试，也不改用 HTML 页面另读一遍。
- User-Agent 如实标明是本工具的只读请求，不伪装成浏览器或官方客户端。若 NGA 因此拒绝，会按风控停止，不改用伪装绕过（未验证真实站点是否接受）。
- 凭据：照 09 的设计原样发送用户保存的整条 Cookie 请求头，不拆分、不另存。公开工具只用 `ngaPassportUid`、`ngaPassportCid` 两项，但真实站点是否还需要其他项未验证，所以 09 的输入格式不变；`ngaPassportUid` 本身是账号号码，属于不得打印的账号标识。
- 匿名楼层：用户名以 `#anony_` 开头时记为匿名作者。这一前缀来自对 NGA 的一般了解，没有在上述公开资料里核实（未验证）。

## 未验证（需要维护者在本机用自己的 NGA 凭据核对）

1. 带凭据的检索、读帖实际返回的字段与本仓库合成样例一致；`fid` 限定版块；UTF-8 关键词被正确识别。
2. 如实的 User-Agent 被接受；真实风控信号（状态码、页面、消息）与上面的判定一致。
3. 「未登录」以外的真实拒绝形态（例如 Cookie 失效但返回别的代码）。
4. 匿名前缀 `#anony_`。
5. 3 秒间隔、30 分钟暂停在真实使用中是否足以避开风控。
6. Windows 传输经系统代理和证书存储访问 NGA（本机只对本地 HTTP 替身实测）。
