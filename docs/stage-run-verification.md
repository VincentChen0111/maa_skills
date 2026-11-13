# 16 关卡运行跟踪验证

工单 [16](issues/16-stage-run-tracking.md)。作者基点 `4a1fd26`（origin/main），实现分支 `claude/16-stage-run-tracking`。本页只记录作者实际运行过的检查和未验证项，不代替独立审查、真实模型评测或实机验收。MAA 事实与固定源码见 [运行跟踪来源](stage-run-sources.md)。

## 交付内容

- `skills/maa-core/scripts/maa-callback.ts`：MaaCore 日志回调行、`append_task`、`set_task_params` 的唯一解析；`training-state.ts` 改为调用它。
- `skills/maa-core/scripts/maa-log-window.ts`：`asst.log`、`gui.log` 的起点（字节偏移、大小、文件身份 dev+ino、起点前 4096 字节的 SHA-256），按起点读完整行，跟到 `.bak` 的轮换，接不上记缺口。
- `skills/maa-core/scripts/stage-run-state.ts`：只由回调分类的纯函数，以及能否再打的唯一判断 `rerunGate`；`stage-run.ts`：`start`、`observe`、`verify`、`decide`、`progress`、`read` 入口和运行记录 `<私有目录>/stage-runs/<runId>.json`。
- `skills/maa-daily/references/stage-run.md` 和 daily、core 的 SKILL.md 路由；`scripts/stage-run-demo.ts` 演示；`eval/maa-daily/stage-run-scenarios.ts` 五个只读场景。
- 给 17 的接口：`readStageRun`、`summarizeStageRun`、`stageRunOutcome` 和 `StageRunRecord` 类型（`stage-run.ts` 文件头说明）。`stageRunOutcome` 给每关主作业、已批准备选、业务结果、关卡核对、允许的决定和最后一次决定；切换本身不在本票。

## 验收对照（作者运行，2026-11-13）

| 验收 | 证据 |
| --- | --- |
| 1 关联批次、关卡和运行，跟踪到各终态 | `tests/stage-run.test.ts`「normal: links batch…」「failure, not 3-star and explicit wait timeout…」「no sanity needs the recovery popup…」「silence or a quiet log is not failure…」「disconnect is an environment failure…」「exit code 0 never overrides…」；`tests/stage-run-flow.test.ts`「tracking starts only from a complete prepared batch…」 |
| 2 回调分类、退出码 0 不覆盖失败、环境类与作业失败分开 | 「exit code 0 never overrides…」「disconnect…」「a manual session kicking MAA off…」「a copilot run started without list mode…」 |
| 3 及时报告，沉默不算失败 | 「failure, not 3-star…reported as soon as they appear」（每条发现只报一次）；`stage-run-flow`「a waiting observer returns as soon as MAA reports a failure…」；「silence or a quiet log is not failure…」 |
| 4 环境类失败先核对再由模型决定；不加授权；未知只核对 | `tests/stage-run-rerun-gate.test.ts`「every re-run entry point refuses while an outcome is unknown…」逐一核对四个入口（提供的决定、`decide`、不带和带 `retryOf` 的 `start`）在到过结算画面后断连、战斗中 MAA 进程消失、战斗中被接管、日志缺口四种未知情形下都拒绝，只有进入战斗前的环境类失败放开；「an unknown battle outcome reopens retry only after the user states the stage progress」；`tests/stage-run.test.ts`「disconnect mid-battle is an environment failure…」；「a rotation mid-run…」「native schedule takeover…」「medicine reported…」只允许停下 |
| 5 手动玩、手动登录顶号 | 「a manual session kicking MAA off, or the user saying they are playing…」；`stage-run-rerun-gate`「a late report of manual play or a manual login…」：事后说明把已判的明确超时改为未知并注明；`verify` 把理智、理智药、源石、关卡进度标为未知 |
| 6 共享诊断；输出不含凭据、账号标识或完整配置 | 环境类失败带 doctor 的 `CheckResult` 结构，`verify` 调用共享 `runChecks`；「run record and summaries keep paths only for MAA debug images…」检查设备号、adb 地址、连接配置名、作业文件路径、私有目录、MAA 目录和 MAA 配置名都不出现；`stage-run-flow`「CLI validates actions…」 |
| 7 临时环境演示，不点游戏不操作设备 | `tests/stage-run-demo.test.ts`：已安装 CLI 从 query、prepare、用户开始信号到每关结果；进程替身在跟踪阶段没有任何 close/start |
| 8 回调行解析只有一份；专精测试不改断言 | `tests/maa-callback.test.ts` 4 项；专精 9 个测试文件（training-state、training-attribution、training-plan、training-integration、training-assistants、training-config、training-time、training-smoke、training-evaluation）断言未改，全部通过 |
| 9 日志起点、轮换、缺口 | `tests/maa-log-window.test.ts` 4 项（含 Windows 上改名后 ino 跟随旧文件）；「a rotation mid-run is followed…」 |
| 10 执行状态与业务结果两层，记 MAA 消息名和 `what` | 摘要的 `execution` 与 `stages[].result` 分开；发现带 `message`、`what`、`subtask`、`task`（测试断言 `SubTaskError` / `ProcessTask`） |
| 11 `gui.log` 先查错误再查完成 | 「failure…」中错误和完成标记同时出现判为错误；「completion callbacks with a GUI error marker…」回调完成而 `gui.log` 有错误、或只有 `gui.log` 时记未知 |
| 12 原生定时接管 | 「a native schedule takeover ends attribution…」：之后的回调（含 6 瓶用药）不算本批次，结果和用药未知；别的任务链开始同样记接管 |
| 13 只用回调核对关卡 | 「stage check uses only drop callbacks…」给吻合/不符；「failure…」中没打的关给「没有打」；固定版本自动战斗不发掉落回调，打过的关通常为「未知」（见来源） |
| 14 只给调试截图路径 | 「run record and summaries…」：只列运行开始后修改的 `debug/interface/failure.png`，旧图不列，图片不读 |
| 15 运行记录写明 MAA 报告的用药 | 「medicine reported by MAA is summed…」：2+1=3、未批准、只能停下；确认后无用药回调或 `count` 不是整数时为「未知」；证据完整且无用药为 0（「normal…」），日志缺口时为「未知」 |

验证方式要求回放的合成样例全部在上面的测试里：正常、失败、未三星、无理智（弹窗证据；另有无弹窗的开战前出错记未知）、明确超时（等待次数用尽；运行时长上限加停止）、断连、手动会话顶下线、退出 0 但失败、日志中途轮换（接上与接不上）、错误与完成标记同时出现、原生定时接管、掉落回调关卡不符、用药报告数量与读不到。

## 实际运行的命令

- `npm ci --ignore-scripts`：通过。`npm run typecheck`：通过（多次）。
- 单个测试文件：`maa-callback` 4/4、`maa-log-window` 4/4、`stage-run` 14/14、`stage-run-flow` 4/4、`stage-run-demo` 1/1、`stage-run-scenarios` 1/1；专精 9 个文件全部通过。
- 完整离线入口 `node scripts/check.ts`：411 项中 410 通过、0 失败、1 项跳过（非 Windows 的原生进程适配器，按设计跳过）；tracker、隐私、链接检查无错误，评分规则自检 `{"ok":true,"rules":7,"samples":14}`。
- 第 1 轮修复后：`npm run typecheck` 通过；单个文件 `stage-run-rerun-gate` 4/4、`stage-run` 14/14、`stage-run-flow` 4/4、`stage-run-demo` 1/1、`stage-run-scenarios` 1/1、`maa-callback` 4/4、`maa-log-window` 4/4。完整离线入口 415 项：413 通过、1 跳过（同上）、1 失败，失败的是 `tests/maa-process.test.ts`「Windows launches and normally closes a temporary GUI…」（`maa-close-timeout`），本包没有改 `maa-process.ts`；该文件单独连跑三次为通过、失败（同一项）、通过，协调者说明它在基点 `4a1fd26` 上也会失败，另行调查。因测试失败，入口没有继续跑后面的检查，另外单独运行：隐私 `{"ok":true,"findings":[]}`、链接检查无错误、tracker 无错误、评分规则自检 `{"ok":true,"rules":7,"samples":14}`。

## 独立审查第 1 轮后的修复（2026-11-13）

第 1 轮结论不通过，协调者接受全部 5 项（P1 1、P2 1、P3 3）。修复：

- P1、P2 属同一类缺陷（未知结果之后还能再打），按同类缺陷规则只建一个判断：`stage-run-state.ts` 的 `rerunGate`。`deriveRun` 提供的决定、`decide`、不带和带 `retryOf` 的 `start` 都只问它。规则：结果未知、且进入过战斗或到过结算画面的那一项，只有用户用 `progress` 说明这一关打完了几次后才放开重试或换备选；证据不全、被接管、列表或作业文件不符、用药相关等情形一直只能停下。同一批次只要有一条记录的任务链开始过，不带 `retryOf` 的 `start` 拒绝（`run-unresolved`）；还有记录在跟踪时，任何 `start` 都拒绝；`start` 先在批次锁内读完仍在跟踪的记录的新日志再判断。任务链没开始过的记录（开始前被接管，或用 `decide` 的 `stop-and-tell-user` 关掉、之后不再读日志）不挡重新开始。新增一致性测试 `tests/stage-run-rerun-gate.test.ts`，改正原来 `tests/stage-run.test.ts` 断连用例里错误的期望（原先核对清楚就允许重试）。审查员的离线复现 `retry-unknown.ts`、`restart-bypass.ts` 原样运行，现在分别以 `decision-not-allowed`、`run-unresolved` 拒绝。
- P3（事后说明）：`applyUserReport` 把最后一项的明确超时、失败、未三星或理智不足改为未知，并注明 `user-report:<种类>`；审查员复现 `late-report.ts` 现在输出未知。
- P3（登记）：截图只列 `debug/` 下三层以内、同一条运行记录只允许一个跟踪进程，补进规格「日常操作」正文和「规则来源」。
- P3（等待时间）：`observe` 的等待上限从 600 秒降到 90 秒，说明里的例子改为 60 秒，并写明宿主命令超时要比等待时间多 30 秒（Claude Code 的 Bash 默认 120 秒）；规格正文和两张表的理由一并改正。

## 实现选择（不是产品限制）

限制性的设计默认值登记在规格「默认值及其来源」的四行 16 条目里。以下只是实现细节：末尾哈希取起点前 4096 字节；文件身份只用 dev 和 ino（本机核对创建时间会被新文件沿用）；起点处半行归起点之前；轮询间隔 2 秒；每条发现只在 `newFindings` 里返回一次；作业文件只保存路径指纹用于比对；记录写入用临时文件加改名。

## 行为评测

新增 `daily-run-not-three-star`、`daily-run-disconnect`、`daily-run-evidence-gap`、`daily-run-unapproved-medicine`、`daily-run-native-takeover` 五个场景，读取用同一分类器生成的合成运行记录，两宿主目录（`.agents`、`.claude`）都用已安装 CLI 离线核对：只调用偏好读取和 `stage-run.ts read`，文件无变化，评分在有调用证据时通过、没有时失败。

**未验证**：真实模型运行。工单 28 尚未交付，维护者还没有登录评测专用目录；maa-daily 改动前后同模型同场景的对比、五个新场景的基线都没有运行，按规则记为未验证并留给工单 26。

## 未验证

- 真实 MAA、模拟器和游戏上的回调顺序；失败、未三星、理智不足、明确超时的判断条件来自固定源码推导，合成样例按推导构造。
- 官方 PC 客户端下的掉线和回调。
- 两宿主原生安装后的实际 CLI 运行（本次只在评测夹具的两个原生目录里离线运行）。
- 真实模型评测（见上）。
- 独立审查由协调者另行安排，本页不记审查结论。
