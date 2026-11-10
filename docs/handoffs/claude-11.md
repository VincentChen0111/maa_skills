# Claude 并行交接：工单 11

你的任务是完成 [11：MAA 识别结果转账号快照](../issues/11-maa-account-snapshot.md)（GitHub #13）。Codex 保留 [05：daily 安全修改配置](../issues/05-daily-safe-config-write.md)（GitHub #7）。本次只接 11，交付后停在可审查的 PR，不顺手实现 12、13 或 21。

## 起点与工作目录

先读根目录 `AGENTS.md`、[贡献约定](../../CONTRIBUTING.md)、[规格](../spec.md)、[术语表](../../CONTEXT.md)和 11 工单。04 的共享偏好实现已在 [PR #32](https://github.com/VincentChen0111/maa_skills/pull/32)交付；它的模型基线仍未验证，独立记录为 26 的发布门禁，不是产品已通过模型验收。

使用提供的独立 worktree 和 `codex/11-maa-account` 分支。启动时核实分支、工作区干净、PR #32 已合并且其 squash 提交是本分支祖先；不满足时先同步 main，再开始实施。其他检出可能是 Codex 的 05 工作区，不切换、重置或清理它们。只在自己的工作目录运行命令。

## 11 的实现范围

读取用户已在 MAA 界面启动识别后产生的 Depot/OperBox 结果，输出带来源、读取时间和完整性说明的账号快照及脱敏 Markdown 摘要。未完成、损坏、部分识别、未知练度和未知库存必须有不同的可观察结果；未知不填成零或已满足。提供真实临时文件上的离线导入 CLI。

主改动范围：

- `skills/maa-account/`：新入口和 account 参考资料。
- `skills/maa-help/scripts/account-snapshot.ts` 及 account 专属辅助模块：唯一共享实现，随 maa-help 安装。
- `tests/account-*.test.ts`、`eval/maa-account/`：先失败后实现，使用合成输入。
- 11 本地工单、对应审查记录、必要的来源与许可说明。

通过 [偏好接口](../../skills/maa-help/references/preferences.md)复用 `readSettings` / `startup` 定位语言与私有目录；其他 skill 使用相邻 `maa-help/scripts/`，不复制偏好实现。只写 account 快照和报告，识别由用户启动。04 的偏好互斥不是 MAA 配置锁。

若借用 dsh-maa-cli 解析器，先固定提交并逐字检查对应代码，记录原路径、许可、版权和借用提交；若暂未找到可信格式，保留未知并报告缺口，不能编造回调协议或真实账号样例。

## 并行协调

Codex 的 05 拥有 daily skill、MAA 配置写入/锁/进程控制和其测试。双方尽量新增各自模块。共享 `preferences.ts`、通用评测器、插件描述和依赖文件保持已有接口；确需修改时做兼容的最小增量，并在 PR 中说明。规格两张来源表与 `CONTEXT.md` 只更新 account 对应条目，保留另一分支的内容。只有无法兼容的接口决定才提请协调，常规 account 实现无需等待 05。

`docs/issues/INDEX.md` 必须由 `node scripts/tracker.ts --write` 生成；合并 main 后重新生成，避免手工拼接两个分支的自动区。任何新增产品限制仍需更新规格两张来源表；协调只解决冲突，不豁免这项要求。

## 验证与交付

依次运行有意义的定向测试、`npm run typecheck`、最终 `node scripts/check.ts`。首次类型检查依赖准备使用 `npm ci --ignore-scripts`。仅在临时 home、合成账号和 MAA 样例上验证；真实 MAA、已安装 skill 和用户私有数据不参与。

新 account skill 建固定宿主/模型/场景基线，流程见[行为评测](../evaluation.md)。凭据仅由维护者提供专用评测环境变量；缺失时如实记 `unverified`，不要复制正常登录或将普通 Claude 对话冒充隔离评测。04 的一次性收口安排不自动适用于 11；基线未完成时交付草稿 PR，并明确剩余阻塞。

每个改动包一名独立审查员、最多三轮，记录真实问题、处置理由和结论。逐文件隐私/许可检查后提交自己的分支，打开 PR 关联 #13，等待双平台 CI。合并走 squash，保留 main 保护，GitHub 镜像与本地工单保持一致。

完成时交回：分支和 PR 链接、修改文件、快照接口与未知值约定、离线演示命令、测试/模型证据、审查记录、尚未解决的阻塞，以及需要 05 配合的共享接口。实现/模型/原生安装的结论分别列明。
