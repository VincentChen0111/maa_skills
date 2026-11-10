# account 验证记录

工单 11 的实现交付在 [PR #33](https://github.com/VincentChen0111/maa_skills/pull/33)；原产品独立审查两轮通过。旧 maa-help 载荷的两个真实宿主临时原生安装与同版更新入口已验证；2026-11-11 合入 maa-core 架构后的新载荷须重新验证，见下节。正向导入评测接缝已补齐，真实模型尚未通过。本次交付将模型基线与语义验收移交 26，仍阻止发布；实现完成不代表模型或实机完成。本机仅使用临时 home、合成识别资料和复制到临时目录的 skill；没有读取真实账号、操作设备或修改已安装 skill。

- 工具层接缝：`parseMaaSnapshot`、`inspectMaaSnapshot`、`importMaaSnapshot`、`formatAccountSummary` 与 CLI。完成回调、较新未完成结果、缺失练度、损坏 JSON、非法数量、重复干员、空识别、模板错误、缓存原扫描时间及两种 GUI 缓存分别有行为测试。
- 写入接缝：真实临时目录验证配置指定私有目录、JSON 原子替换、占用锁不抢占、只读目标保存失败旧内容保留；设置、输入 MAA 缓存保持原样；合成额外凭据和账号字段不进入快照及输出。
- 安装载荷：当前两个临时宿主目录布局内，account 通过相邻 maa-core 的唯一脚本完成 read、inspect、import，许可包含本仓库与上游的版权行和 MIT 全文。旧载荷的真实 installer 验证见下节；没有把目录复制测试当作原生安装证据。
- 2026-11-11：补充评测接缝后完整 `node scripts/check.ts` 45/45 通过，七类评分规则自检、tracker、metadata、privacy 通过；`npm run typecheck` 通过。Windows 真实 rename/只读目标测试需在临时夹具中运行沙箱外命令；不以沙箱权限失败认定产品失败。提交 `b9507a4444148ce28fe0c9f94d3c28a5a441f7bc` 的 Windows 与 Ubuntu 公开 CI 均通过；后续文档提交仍需对应 CI。
- TDD：新增每个脚本行为前先执行失败的 CLI/导出函数测试，再实现；companion 安装最初缺少 sibling 导致失败，扩展后同场景通过。静态文案不靠逐字匹配测试。

## maa-core 集成验收

合并 main `37167326638c55d4cdd33a48a51b8391c29c4e9e` 后，账号脚本与许可移到唯一共享目录 maa-core；account 的安装、参考、测试、演示与四场景调用路径同步。maa-help 保持纯文字，account 自身携带缺少 core 时的两宿主安装指引。迁移先将安装测试改为新路径，确认缺少脚本及 LICENSE 的失败，再迁实现；18 项定向 CLI/导出函数及安装检查通过。Windows 沙箱内 rename/junction 限制由临时夹具的沙箱外运行核实，未修改真实环境。

完整离线检查 `node scripts/check.ts` 50/50、七类评分规则自检、tracker、metadata、privacy 和 `npm run typecheck` 通过。新集成包的固定提交原生安装和独立审查正在进行；旧载荷通过不能当作新载荷通过。

账号四场景固定 Codex `0.167.0-alpha.3.2` / `gpt-6`、Claude Code `2.1.322` / `claude-sonnet-4-6`，迁移前后各八次真实尝试全部为 `unverified`（Codex 401、Claude 未登录）。16 份证据核对执行窗口和 evidenceHash；未复制认证。迁移前 skill/companion 指纹为 `e63e0d8db8d7fe79bd8db872aeb5c6a35de04f026589f8db53cbbd7532fcb7bb`，迁移后为 `54ac8a5dd724ec98d69b57e750f445f1b024a5ce60cde74c58ccd5c32ab5d634`。场景授权和字段断言不变，仅期望调用路径从 help 改为 core，因此场景指纹发生变化；两个版本分别检查仍无通过基线，不声称分数未下降。help 的交付入口说明也已更新为 account 可用，并按三个固定 help 场景补做前后尝试。模型基线与人工语义核对继续由 26 阻止发布，真实设备仍未测试。

## 旧载荷的真实原生安装与更新

2026-11-11，公开实现提交 `1ac6df0f1812f00bbee4709dd37924fab0aaa4c5`：

- Codex 官方 `install-skill-from-github.py` 由 Python `-B -s -X utf8` 调用，`--path skills/maa-help skills/maa-account --ref` 固定上述完整提交，`--dest` 指向全新临时 home。首次安装退出 0；已有目标再次安装退出 1；只删除经 realpath 核对位于本次临时根下的两个 skill 目录后，重装退出 0。
- Claude Code `2.1.322` 在独立临时 `CLAUDE_CONFIG_DIR` 执行市场 add、plugin install、marketplace update 均退出 0。安装记录的 `gitCommitSha` 为上述提交。`plugin update` 退出 0 并报告 `0.1.0-dev.0` 已最新：验证的是更新入口，不是跨版本升级。
- 两个真实安装产物中的 help/account 共 9 个文件逐一与该提交候选核对（只规范化 CRLF），包含共享脚本与原版权/MIT 全文。分别从安装产物执行 `preferences.ts set/read`、`account-snapshot.ts inspect/import`；合成样例产生 1 名干员、2 种库存、龙门币 1200，未知技能与基建仍为 null，输出不含原始干员 ID。inspect 不写快照，import 在各自临时私有目录只产生账号快照，源样例不变。
- 本地忽略目录保存安装命令结果、Claude 安装清单及 `native-evidence.json`；环境使用白名单，未复制调用者认证、未修改真实宿主 home 或已安装 skill。真实游戏识别和跨版本升级未运行，仍不记实机通过。

## 模型门禁

`eval/maa-account/scenarios.ts` 四个场景覆盖只读盘点、由用户启动识别、拒绝越界操作和明确授权导入。`account-import` 要求实际执行 preferences read、account inspect/import，并观察新快照的存在及全部已知字段；仅 readAt 用运行器实际执行区间内的规范 UTC 时间断言，其余字段仍精确授权。离线测试在两个原生目录布局实际执行 CLI、观察真实临时文件；无脚本调用的直接落盘、越界时间、缺失/额外字段、删除及额外路径均失败。这只验证接缝和场景可用，不代替模型基线。

固定 CLI 和模型尝试：Codex `0.167.0-alpha.3.2` / `gpt-6`，Claude Code `2.1.322` / `claude-sonnet-4-6`。许可修复前后原三个场景各运行六次，均为 `unverified`。补齐正向导入及新评分语义后，冻结四个场景各在两个宿主执行一次，共八次；仍全部 `unverified`：Codex 缺少隔离认证（401），Claude 未登录；没有调用者认证文件复制。八份记录均核对了真实执行窗口留存及 evidenceHash，`compareRuns([], runs)` 为 `unverified`。旧记录原样保留；新增 `$exists` 和生成时间规则改变了评分、观察与运行器指纹，不能与旧语义比较分数。

旧 maa-help 载荷的 skill 与 companion 整体指纹为 `541ae4bcaabdb04801b3e82f2394a276c5f9b2145934c2bb12f1ed81cc29d208`。本地忽略目录保留 run/evidence/host/stderr/invocation/scenario 证据，无通过的基线。2026-11-11 对 11 单独作出交付决定：合并后解除下游的实现依赖，将这四场景的真实基线及人工语义核对移交 [26](issues/26-v0-1-0-release-validation.md) 的硬发布门禁。此决定依据维护者的持续并行实施要求与常规判断授权，由执行代理明确记录；不是将 04 的例外自动推广，也不是模型通过证据。

独立审查及意见处置见 [产品审查记录](reviews/2026-11-11-11-account.md)及[正向导入评测支持审查](reviews/2026-11-11-11-generated-time.md)；后者第一轮通过，无确认问题。

## 隐私与来源

逐文件检查新增脚本、skill、说明、样例和测试。样例干员和数量均合成，额外敏感标记使用明确合成占位，不发布原始模型 transcript。固定上游和 MAA 指纹见 [来源核对](account-sources.md)，dsh-maa-cli 的原版权和 MIT 全文见[第三方声明](../THIRD_PARTY_NOTICES.md)。
