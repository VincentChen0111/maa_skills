# 16 关卡运行跟踪验证

工单 [16](issues/16-stage-run-tracking.md)。作者基点 `4a1fd26`（origin/main），实现分支 `claude/16-stage-run-tracking`。本页只记录作者实际运行过的检查和未验证项，不代替独立审查、真实模型评测或实机验收。MAA 事实与固定源码见 [运行跟踪来源](stage-run-sources.md)。

## 交付内容

- `skills/maa-core/scripts/maa-callback.ts`：MaaCore 日志回调行、`append_task`、`set_task_params` 的唯一解析；`training-state.ts` 改为调用它。
- `skills/maa-core/scripts/maa-log-window.ts`：`asst.log`、`gui.log` 的起点（字节偏移、大小、文件身份 dev+ino、起点前 4096 字节的 SHA-256），按起点读完整行，跟到 `.bak` 的轮换，接不上记缺口。
- `skills/maa-core/scripts/stage-run-state.ts`：只由回调分类的纯函数，以及能否再打的唯一判断 `rerunGate`；`stage-run.ts`：`start`、`observe`、`verify`、`decide`、`progress`、`read` 入口和运行记录 `<私有目录>/stage-runs/<runId>.json`。
- `skills/maa-daily/references/stage-run.md` 和 daily、core 的 SKILL.md 路由；`scripts/stage-run-demo.ts` 演示；`eval/maa-daily/stage-run-scenarios.ts` 六个只读场景。
- 给 17 的接口：`readStageRun`、`loadBatchView`、`summarizeStageRun(record, batch)`、`stageRunOutcome(record, batch)` 和 `StageRunRecord` 类型（`stage-run.ts` 文件头说明）；不传整批证据时只允许停下。`stageRunOutcome` 给每关主作业、已批准备选、业务结果、关卡核对、允许的决定和最后一次决定；切换本身不在本票。

## 验收对照（作者运行，2026-11-13）

| 验收 | 证据 |
| --- | --- |
| 1 关联批次、关卡和运行，跟踪到各终态 | `tests/stage-run.test.ts`「normal: links batch…」「failure, not 3-star and explicit wait timeout…」「no sanity needs the recovery popup…」「silence or a quiet log is not failure…」「disconnect is an environment failure…」「exit code 0 never overrides…」；`tests/stage-run-flow.test.ts`「tracking starts only from a complete prepared batch…」 |
| 2 回调分类、退出码 0 不覆盖失败、环境类与作业失败分开 | 「exit code 0 never overrides…」「disconnect…」「a manual session kicking MAA off…」「a copilot run started without list mode…」 |
| 3 及时报告，沉默不算失败 | 「failure, not 3-star…reported as soon as they appear」（每条发现只报一次）；`stage-run-flow`「a waiting observer returns as soon as MAA reports a failure…」；「silence or a quiet log is not failure…」 |
| 4 环境类失败先核对再由模型决定；不加授权；未知只核对 | `tests/stage-run-rerun-gate.test.ts`（第 2 轮后重写，第 3 轮后 11 项）：「every consumer refuses a re-run for every producer…」把 7 种「任务链可能跑过或结果未证实」的来源（起点前已开始、被接管后又有 Copilot 任务链、关掉跟踪后又有 Copilot 任务链、起点以来日志缺口、找不到任务链开始的 Copilot 回调、到过结算画面后断连、战斗中 MAA 进程消失）逐一对 5 个入口（摘要的 `allowedDecisions`、`decide`、`progress`、不带 `retryOf` 的 `start`、带 `retryOf` 的 `start` 第一次和第二次，另把重试决定直接注入整批视图再问 `rerunGate`）核对，全部拒绝；只有后两种在用户说明进度后放开决定，且仍因勾选未取消而拒绝开始。另 7 项：进入战斗前的环境类失败是唯一不需用户说明的放开，且一个重试决定只对应一条任务链；用户在带 `retryOf` 的 `start` 前自己点了开始，第一次和第二次都拒绝；说明的次数少于回调证明的被拒绝、勾选多于剩余次数被拒绝、取消勾选后放开；没核对的环境类失败即使 MAA 报告了失败也只能停下，核对后只有换备选和停下；还有记录在跟踪时拒绝开始，没有任务链的记录不挡；第一次开始前、准备之后的日志里已有本批作业文件被拒绝，时间读不出的同样拒绝，准备之前的（同一份报告重新准备、普通与突袭共用作业）不挡；事后说明手动登录改记未知。`tests/stage-run.test.ts`「disconnect mid-battle is an environment failure…」；「a rotation mid-run…」「native schedule takeover…」「medicine reported…」只允许停下 |
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

- 第 2 轮修复后（维护者 2026-11-13 新规：作者不跑完整离线入口，由协调者按包串行运行；只跑类型检查和改动涉及的单个测试文件，逐个运行）：`npm run typecheck` 通过；单个文件逐个运行 `stage-run-rerun-gate` 8/8、`stage-run` 14/14、`stage-run-flow` 4/4、`stage-run-demo` 1/1、`stage-run-scenarios` 1/1。修复前一次（新规之前）`maa-callback`、`maa-log-window` 和专精 9 个文件合在一条命令里跑过 45/45，这一轮没有改这些文件。完整离线入口未由作者运行。
- 第 3 轮修复后（同样只跑类型检查和单个文件，逐个运行）：新增的 3 项测试先写，旧代码下「同一份报告重新准备」「普通与突袭共用作业」两项失败（第二批第一次 `start` 以 `batch-may-have-run` 拒绝），「时间读不出」一项本来就通过（旧代码不看时间）；修复后 `npm run typecheck` 通过，`stage-run-rerun-gate` 11/11、`stage-run` 14/14、`stage-run-flow` 4/4、`stage-run-demo` 1/1。完整离线入口未由作者运行。

## PR CI 发现后的修复（2026-11-14，交第五轮审查）

PR 的 Ubuntu CI 上，`tests/stage-run.test.ts`「run record and summaries keep paths only for MAA debug images…」失败：`leaked /tmp/maa-stage-run-…/maa`。

- 原因：运行记录存了 MAA 目录的完整路径（`StageRunRecord.maaDirectory`），只是给 `decide` 和 `progress` 在调用方没传目录时兜底。对外的摘要不含这个路径。
- Windows 上测不出来：测试拿原路径去 JSON 文本里查，而 JSON 把 Windows 路径的反斜杠转义了，检查永远不会命中。
- 修复：
  - 运行记录不再存 MAA 目录。`decide` 和 `progress` 必须由调用方给出 MAA 目录，CLI 本来就从设置传入；缺少时报 `maa-directory-required`。
  - 测试改为同时查原路径和 JSON 转义后的形式，并写明是哪一份文本泄露。
  - 测试里直接调用这两个导出函数的地方，改为显式传入 MAA 目录。
- 先红后绿（Windows）：加强后的测试在修复前失败，报 `record leaked <临时目录>\maa`；修复后 `npm run typecheck` 通过，依次单独运行全部通过：
  - `stage-run` 14/14；
  - `stage-run-rerun-gate` 11/11；
  - `stage-run-flow` 4/4；
  - `stage-run-demo` 1/1；
  - `stage-run-scenarios` 1/1。

## 独立审查第 3 轮后的修复（2026-11-13）

第 3 轮结论不通过（P2 1），协调者复核后接受：第一次 `start` 前的日志检查把任何时候提交或载入本批作业文件的行都算作「这一批可能跑过」，但作业文件路径 `stage-jobs/<报告哈希>/<作业号>.json` 只由报告和作业决定，同一份报告重新准备的下一批、共用同一作业的另一批（普通与突袭）会被上一批留下的行挡住。修复：`scanBeforeTracking` 只算时间不早于本批准备开始（`daily-runs.jsonl` 里 `complete` 记录的 `startedAt`）的行，时间读不出的行照算；「日志够不到准备开始」的检查不变。理由：准备要求 MAA 关闭并替换它的作业列表，准备开始之后出现的这类行只能是这一批或用户自己跑的。代码注释、规格正文、「规则来源」16 行、「默认值及其来源」开始跟踪一行和 `references/stage-run.md` 第 2 条里「批准的作业文件只属于这次批准」的说法一并改正。新测试的日志时间按当前时钟换算（`fromNow`），不依赖测试运行的时刻。

审查员复现（只读，原样运行，输出另存）：`same-report-rerun.ts` 第二批第一次 `start` 被接受；`normal-then-raid.ts` 突袭批次第一次 `start` 被接受。第 2 轮的 `chain-before-anchor.ts` 也重跑了一次：夹具日志的时间固定为 2026-11-13 02:00 UTC，早于实际运行时的准备时间，所以情形 A 的第一次 `start` 现在被接受（记录为证据不全、只能停下），第二次 `start` 以 `run-unresolved` 拒绝；情形 B 带 `retryOf` 的 `start` 仍以 `untracked-chain` 拒绝。实际环境里用户点开始一定晚于准备，这类行会被算上，第一次 `start` 以 `batch-may-have-run` 拒绝，见新测试「a batch whose approved job was already loaded…」和「…the same report re-prepared」第三批。

## 独立审查第 2 轮后的修复（2026-11-13）

第 2 轮结论不通过（P1 1、P2 1、P3 2），同类缺陷（未知时还能再打）第二次出现，按复发规则把判断改为一个负责者、一份整批证据，加上枚举全部来源和入口的一致性测试：

- P1：`rerunGate` 不再只看单条记录，而是看整批：`stage-run.ts` 的 `loadBatchView` 在批次锁内从批次最早一条记录的 Core 日志起点读到现在，`scanBatchLines` 记下每条 Copilot 任务链开始、找不到开始的 Copilot 回调和日志缺口。任一任务链不属于任何记录（`untracked-chain`）、有找不到开始的回调（`chain-without-start`）、有缺口（`evidence-incomplete`）、有记录在跟踪或有只能停下的情形、有未说明的未知结果时，所有入口只给停下；重试和换备选只对最近一条任务链所属的记录开放，所以一个重试决定之后批次里出现任何新的 Copilot 任务链（重试本身的，或用户先点的），这个决定就不能再用（`chain-already-started`/`untracked-chain`）。批次第一次 `start` 前，`scanBeforeTracking` 在当前和轮转的 Core 日志里找提交或载入本批作业文件的行，找到就拒绝（`batch-may-have-run`），日志够不到准备开始时也拒绝（`batch-evidence-incomplete`）；新记录的日志起点在判断前记下，判断和跟踪之间不漏行。`decide`、`progress` 和 `start` 都在批次锁内判断和写入，运行记录保存所用的 MAA 目录。
- P2：`progress` 也经 `rerunGate`：某关说明的次数少于回调已证明打完的次数（到过结算画面、三星、作战失败或已评出结果）就拒绝（`progress-contradicts-evidence`），次数按整批累计。带 `retryOf` 的 `start` 读 `gui.new.json` 每项的 `IsChecked`，每关仍勾选的条目多于批准次数减已打完次数（用户说明与回调证明取较大者）就拒绝（`finished-items-ticked`）。勾选保存和自动取消勾选的源码事实补进[运行跟踪来源](stage-run-sources.md)。
- P3（核对顺序）：有还没核对的环境类失败时先判为只能停下，排在「MAA 报告失败」之前；MAA 报告过失败或未三星的记录不再给重试同一作业。
- P3（评测）：新增 `daily-run-ask-progress` 场景（结算后断连、核对已清楚）；测试断言 `next` 为 `ask-progress`、`allowedDecisions` 只有停下。
- 规则变化登记在规格正文、「规则来源」的 16 行，以及「默认值及其来源」里的三行 16 条目（能否再打、开始跟踪、等待与锁），`references/stage-run.md` 第 2、3、10–13 条和接口段同步。合成夹具里预先存在的日志行改为 30 天前，使「日志能追溯到准备之前」不依赖测试运行的时刻。
- 审查员复现（只读，原样运行，输出另存）：`retry-unknown.ts` 以 `decision-not-allowed` 拒绝；`restart-bypass.ts` 以 `run-unresolved` 拒绝；`late-report.ts` 输出 SYN-1 未知；`chain-before-anchor.ts` 情形 A 第一次 `start` 即以 `batch-may-have-run` 拒绝（脚本未捕获，因此情形 B 没有执行）；情形 B 原样摘出单独运行，带 `retryOf` 的 `start` 以 `untracked-chain` 拒绝；`takeover-then-copilot.ts` 以 `run-unresolved` 拒绝；`progress-count.ts` 说明 0 次以 `progress-contradicts-evidence` 拒绝，说明 1 次后放开决定、带 `retryOf` 的 `start` 以 `finished-items-ticked` 拒绝；`switch-unverified.ts` 核对前只给停下，`decide` 以 `decision-not-allowed` 拒绝。

## 独立审查第 1 轮后的修复（2026-11-13）

第 1 轮结论不通过，协调者接受全部 5 项（P1 1、P2 1、P3 3）。修复：

- P1、P2 属同一类缺陷（未知结果之后还能再打），按同类缺陷规则只建一个判断：`stage-run-state.ts` 的 `rerunGate`。`deriveRun` 提供的决定、`decide`、不带和带 `retryOf` 的 `start` 都只问它。规则：结果未知、且进入过战斗或到过结算画面的那一项，只有用户用 `progress` 说明这一关打完了几次后才放开重试或换备选；证据不全、被接管、列表或作业文件不符、用药相关等情形一直只能停下。同一批次只要有一条记录的任务链开始过，不带 `retryOf` 的 `start` 拒绝（`run-unresolved`）；还有记录在跟踪时，任何 `start` 都拒绝；`start` 先在批次锁内读完仍在跟踪的记录的新日志再判断。任务链没开始过的记录（开始前被接管，或用 `decide` 的 `stop-and-tell-user` 关掉、之后不再读日志）不挡重新开始。新增一致性测试 `tests/stage-run-rerun-gate.test.ts`，改正原来 `tests/stage-run.test.ts` 断连用例里错误的期望（原先核对清楚就允许重试）。审查员的离线复现 `retry-unknown.ts`、`restart-bypass.ts` 原样运行，现在分别以 `decision-not-allowed`、`run-unresolved` 拒绝。
- P3（事后说明）：`applyUserReport` 把最后一项的明确超时、失败、未三星或理智不足改为未知，并注明 `user-report:<种类>`；审查员复现 `late-report.ts` 现在输出未知。
- P3（登记）：截图只列 `debug/` 下三层以内、同一条运行记录只允许一个跟踪进程，补进规格「日常操作」正文和「规则来源」。
- P3（等待时间）：`observe` 的等待上限从 600 秒降到 90 秒，说明里的例子改为 60 秒，并写明宿主命令超时要比等待时间多 30 秒（Claude Code 的 Bash 默认 120 秒）；规格正文和两张表的理由一并改正。

## 实现选择（不是产品限制）

限制性的设计默认值登记在规格「默认值及其来源」的四行 16 条目里。以下只是实现细节：末尾哈希取起点前 4096 字节；文件身份只用 dev 和 ino（本机核对创建时间会被新文件沿用）；起点处半行归起点之前；轮询间隔 2 秒；每条发现只在 `newFindings` 里返回一次；作业文件只保存路径指纹用于比对；记录写入用临时文件加改名。

## 行为评测

新增 `daily-run-not-three-star`、`daily-run-disconnect`、`daily-run-evidence-gap`、`daily-run-unapproved-medicine`、`daily-run-native-takeover`、`daily-run-ask-progress` 六个场景，读取用同一分类器生成的合成运行记录（合并到工单 28 时写成固定字面值 `tests/fixtures/stage-run-records.ts`：场景世界数据不运行产品代码，见 [28 验证记录](evaluation-verification.md)），两宿主目录（`.agents`、`.claude`）都用已安装 CLI 离线核对：只调用偏好读取和 `stage-run.ts read`，文件无变化，评分在有调用证据时通过、没有时失败。场景目录里没有准备记录和 MAA 日志，整批证据读不到，所以每个场景都只给停下（`rerunHold` 为 `batch-evidence-unavailable`）；`daily-run-ask-progress` 的 `next` 为 `ask-progress`，模型应说出哪一项未知、问用户这一关打完了几次，不重试、不替用户调用 `progress`。

**未验证**：真实模型运行。工单 28 尚未交付，维护者还没有登录评测专用目录；maa-daily 改动前后同模型同场景的对比、六个新场景的基线都没有运行，按规则记为未验证并留给工单 26。

## 未验证

- 真实 MAA、模拟器和游戏上的回调顺序；失败、未三星、理智不足、明确超时的判断条件来自固定源码推导，合成样例按推导构造。
- 官方 PC 客户端下的掉线和回调。
- 两宿主原生安装后的实际 CLI 运行（本次只在评测夹具的两个原生目录里离线运行）。
- 真实模型评测（见上）。
- 独立审查由协调者另行安排，本页不记审查结论。
