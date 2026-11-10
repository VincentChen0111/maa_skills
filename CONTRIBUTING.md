# 贡献

先读 [开发约定](AGENTS.md)、[规格](docs/spec.md)和[术语表](CONTEXT.md)，再从[工单索引](docs/issues/INDEX.md)领取所有阻塞项已完成的票。外部问题请提交 [GitHub Issue](https://github.com/VincentChen0111/maa_skills/issues)，贡献通过 PR。

## 本地验证

Node 24 直接运行 TypeScript。干净检出无需下载依赖即可运行 `node scripts/check.ts`（或 `npm run check`），覆盖脚本测试、tracker、相对文档链接、插件描述和隐私检查。入口给测试创建临时 home；测试数据只来自临时目录和合成样例，不操作真实 MAA、用户私有目录或已安装 skill。入口也运行 `scripts/eval-selftest.ts` 的评分规则自检；真模型运行、证据留存及未验证项见[行为评测](docs/evaluation.md)。

开发类型检查先运行 `npm ci --ignore-scripts`，再运行 `npm run typecheck`。依赖由 lockfile 固定；离线检查入口本身没有第三方运行依赖。定向测试用 `node --test tests/privacy.test.ts` 等，完整验证用离线入口。CI 的依赖准备阶段联网，检查阶段没有网络或模型调用；Linux job 只验证可移植的开发检查工具，不代表支持非 Windows 的 MAA。

新增脚本行为前，在工具 CLI/导出函数或 skill 外部行为接缝写一个失败测试，再实现该行为。用真实临时目录，只替代 MAA 进程、adb、网络。每个改动包由一名新上下文审查员审查完整任务、规格和 diff，原则上最多三轮；达到上限后的修复复核按 [AGENTS.md](AGENTS.md) 由执行代理决定追加，并优先完整审查以减少轮次。记录在 `docs/reviews/日期-工单-主题.md`，包括基点、范围、逐条意见、接受/拒绝理由、轮次授权、最终结论和未验证项。无意见也要记录；不能把未审查写成通过。

改 skill 前后固定模型、宿主和场景比较；新 skill 建基线。pass→fail 单独重跑三次再判断。真模型仅本机运行；不可用的宿主记录为未验证。安装和试跑使用临时 home；[宿主说明](docs/hosts.md)描述原生安装及开发模式。

## 工单和镜像

本地 Markdown 是实施记录，GitHub Issue 是镜像。头字段为 `Type`、`Labels`、`Status`、`Assignee`、`Parent`、`Blocked by`；另用 `GitHub Issue` 互链。`Type` 表示类型，`Labels` 表示内容标签；`Status` 使用五种 triage 状态，GitHub 同名标签镜像该字段：

| Status | 含义 |
| --- | --- |
| needs-triage | 待整理 |
| needs-info | 缺少必要信息 |
| ready-for-agent | 可由 agent 实施；仍须等待阻塞项完成 |
| ready-for-human | 需要人处理 |
| wontfix | 决定不实施 |

正文 `实施进度：未开始。`、`进行中。`、`已完成。` 表示实现进度，不用 `Status: done` 代替。完成验收和独立审查后记已完成，另记 PR 交付状态；GitHub 在 PR 合并时关闭，正文同步验收和审查链接。开始或完成一票时运行 `node scripts/tracker.ts --write` 更新索引自动区；用户故事覆盖表由人维护，检查器不会改写。检查拒绝坏链接、缺失依赖、依赖环、非法状态和陈旧索引，不访问 GitHub。

## 公开与合并

逐文件审阅代码、注释、文档和测试数据，尤其是移植文件；账号基线改成合成数据。自动隐私检查扫描 Git 已跟踪文件及未忽略的新增文件（包括隐藏文件），被跟踪的忽略路径仍扫描；非 Git 导出目录递归检查，跳过 `.git` 和 `node_modules`。路径、常见凭据格式和账号标记是启发式规则，不能替代人工检查，也不保证识别任意编码的秘密。诊断不输出匹配内容。平台配置核实见[安全记录](docs/security-verification.md)。

通过离线入口和类型检查后，提交到实现分支、打开 PR，等待 CI 通过，使用 squash 合并。保持现有 main 保护，不直接推 main，也不添加绕过规则。PR 写明工单、审查记录、验证结果和未验证项。移植来源按[第三方声明](THIRD_PARTY_NOTICES.md)登记，共享工具保留一个实现，其他项目的迁移不在本仓库实施。
