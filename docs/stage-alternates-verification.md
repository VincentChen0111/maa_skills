# 17 批准范围内切换备选验证

工单 [17](issues/17-approved-alternate-jobs.md)。实现分支 `claude/17-approved-alternates`，叠在 16 的分支头 `15c3aeb` 上（16 基于 origin/main `4a1fd26`；16 第三轮之后的修复 `de645a9`、`3df4f85` 还没有独立审查）。本页只记录作者实际运行过的检查和未验证项，不代替独立审查、真实模型评测或实机验收。MAA 事实见[换备选来源](stage-alternates-sources.md)和[运行跟踪来源](stage-run-sources.md)。

## 交付内容

- `skills/maa-core/scripts/stage-job-plan.ts`：作业计划可以带 `continuation`（这一批从哪条运行换来、每关的当前作业和剩下的次数）。`approvedJobStages`、`approvedJobEntries` 和 `approvedJobList` 是把批准计划展开成 MAA 作业列表的唯一一处：只认这一关批准过的主作业和备选，次数不超过批准次数。统一写入器、`start` 的列表核对和运行记录都调用它。
- `skills/maa-core/scripts/stage-run-state.ts`：
  - `stageCandidates`：每关的当前作业、下一份备选、还剩几份。
  - `switchTarget`：要换的关、换下和换上的作业、触发原因、写入的每关作业和次数。
  - `rerunGate` 仍是唯一判断，新增：
    - 换备选的决定要求这一关还有下一份备选、还有剩下的次数，这一批也还没有换过（`alternates-exhausted`、`nothing-left-to-switch`、`no-stage-to-switch`、`switch-requested`）；
    - 新的 `switch` 请求种类：最后一次决定必须是换备选，决定仍然成立，关卡要对得上（`switch-not-decided`、`switch-stage-mismatch`）。
  - 摘要新增 `alternates`、`switch`，`next` 新增 `switch`、`start-alternate`；MAA 报告失败、而且能换备选时 `next` 为 `decide`。
- `skills/maa-core/scripts/stage-run.ts`：
  - `switch` 动作（`switchStageRun`）和换备选记录 `<私有目录>/stage-runs/switches/<键>.json`；
  - `createRun` 按 `approvedJobEntries` 建列表，换好的一批也能跟踪；
  - CLI 只有 `switch` 可以经写入器关闭和重开 MAA。
- `skills/maa-core/scripts/maa-config.ts`：通用 `write` CLI 拒绝带 `continuation` 的作业计划。
- `skills/maa-daily/references/stage-run.md` 新增「换备选」第 15–19 条，第 7、11、12 条和接口段同步；daily、core 的 SKILL.md 路由同步。
- `eval/maa-daily/stage-alternate-scenarios.ts` 四个只读场景、`tests/fixtures/stage-alternate-data.ts`。
- 规格「日常操作」「检查与修法」正文、「规则来源」新增 17 一行、「默认值及其来源」新增 17 一行，并按 #48 改了一行；`CONTEXT.md`「备选作业」；工单 17 正文（见文末）。

## 状态机

### 运行记录（16 的 `stage-runs/<runId>.json`，`execution`）

| 从 | 到 | 条件 |
| --- | --- | --- |
| （无） | `tracking` | `start` 经 `rerunGate` 允许，新的 `runId` |
| `tracking` | `completed` / `failed` | 任务链结束回调（`TaskChainCompleted`；`TaskChainError`、启动失败、运行时长上限加停止） |
| `tracking` | `unknown`（已中断） | MAA 重启：进程退出（`maa-gone`）或回调换了进程（`process-changed`）；被接管；证据不全 |
| `tracking` | `unknown`（`closed-before-start`） | 任务链开始前，模型用 `decide` 选停下 |

- 宿主或脚本进程重启时，`tracking` 记录不会被「接着跑」。它只保存日志读到的位置，下一次 `observe` 从那里只读地接着读；接不上就记证据不全，结果按未知处理。
- 记录结束后不再改回 `tracking`。重试、换好备选后的一批，都是带新 `runId` 的新记录，旧记录保留。

### 换备选记录（候选使用记录，`stage-runs/switches/<键>.json`，`state`）

| 从 | 到 | 条件 |
| --- | --- | --- |
| （无） | `writing` | `rerunGate` 允许 `switch`；按键独占创建，记下写它的进程 |
| `writing` | `prepared` | 统一写入器返回 `complete`，记下新一批的 `operation` |
| `writing` | `unknown` | 写入器返回 `unknown`，或抛出异常 |
| `writing` | `rejected` | 写入器在动手之前拒绝（例如 `closed-confirmation-required`、`configuration-changed`），配置没有变 |
| `writing` | `interrupted` | 记录停在 `writing`，写它的进程已经不在（宿主或脚本重启）；下一次读取时改记 |
| `rejected` | `writing` | 同一个键再请求，输入可以不同；`attempts` 保留每一次 |

- `prepared`、`unknown`、`interrupted` 是这个键的终态。
  - 同键同输入：返回已有记录（`repeated: true`），不再写。
  - 同键不同输入：拒绝（`idempotency-conflict`），新输入的摘要追加到 `conflicts`，原输入摘要在 `input`。
- 键由批次 `operation`、`runId`、关卡、换下的作业、换上的作业算出（SHA-256）。输入摘要覆盖运行、关卡、两份作业、写入的每关作业和次数，以及配置 revision。
- 原来那一批有任何不是 `rejected` 的换备选记录时，`rerunGate` 对它的重试和换备选只给停下（`switch-requested`）：列表已经换了，或者可能换了。
- `prepared` 之后，新一批的运行记录照 16 跟踪。原来那条运行的 `next` 先是 `start-alternate`，新一批有了运行记录后变为 `report`。
- `unknown` 和 `interrupted` 的 `next` 为 `verify`：只核对，交给 maa-doctor 处理写入锁，不再请求。

### 每关的候选（摘要 `alternates` 与换备选记录推出）

- 批准顺序为主作业、备选 1、备选 2……当前作业是这一批列表里这一关用的作业。
- MAA 报告失败或未三星，换下的作业就是用过、失败了（换备选记录 `trigger: job-failure`）；环境类失败核对清楚后由模型决定换，换下的作业是被搁置、不算失败（`trigger: environment`，运行记录里这一关的结果仍是 `unknown`）。
- 两种情况都只往后换，不回头。下一份为 null 时备选用完，只能停下报告。

## 验收对照（作者运行，2026-11-13）

| 验收 | 证据 |
| --- | --- |
| 1 主作业和备选一起批准，默认最多三份、可增减，未批准的不进可执行队列 | 准备由 15 交付：`tests/stage-jobs-regressions.test.ts`「matcher and Markdown default to at most three ready alternatives…」「explicit approval may add fourth and fifth alternatives…」，`tests/stage-jobs.test.ts`「approved batch prepares only primaries…」。本票：`tests/stage-run-alternates.test.ts`「a continuation expands only approved jobs of each stage…」（不是这一关批准的作业、次数超过批准、0 次、未知关卡、重复关卡都拒绝），「the unified writer accepts only the continuation list of approved jobs; the generic write CLI refuses any continuation」 |
| 2 只有明确失败或未三星触发；未知、理智不足、证据不足不算；环境类失败不切换、不记为已用，核对后模型决定 | `stage-run-alternates`「a MAA-reported failure switches…」「not three stars after a 3-star run…」「an environment failure is not a job failure…」（核对前只有停下，核对后三项可选，换下后这一关结果仍为 `unknown`，`trigger: environment`）；`tests/stage-run-rerun-gate.test.ts`「every consumer refuses a re-run for every producer…」（7 种未证实来源，新增 `switch` 这一消费者）；`tests/stage-run.test.ts` 已有的理智不足、明确超时只给停下 |
| 3 逐份消费，成功后进入后续流程，用尽即停，不临时找作业 | 「a MAA-reported failure switches…」：换上备选 2 后新一批 SYN-1 两次、SYN-2 一次全部三星，`completed`；「alternates used up…」：备选用完后只给停下，`decide` 和 `switch` 都拒绝（`alternates-exhausted`），列表不变；`tests/stage-run-demo.test.ts`：没有备选的 SYN-2 未三星只给停下 |
| 4 统一写入、保留次数、不增加药剂；Fight 数量字段不变；用药或用量读不到时不换不重试 | 「a MAA-reported failure switches…」：配置里的 Fight 任务（带理智药、碎石、临期药字段）换前换后 JSON 一致，`EnableUserAdditional` 为 false；`stage-run-rerun-gate`「medicine reported, unreadable or possibly enabled: no alternate switch, no retry, wait for the user (issue #48)」 |
| 5 核实原生续跑机制并记录依赖 | [换备选来源](stage-alternates-sources.md)：固定版本没有可用机制。`switch` 返回 `start: "user"`、`next: "start-alternate"`，参考文档第 17 条请用户点开始。原生可用的那一支在固定版本上不存在，所以没有实现，也没有测试 |
| 6 恢复先核对记录，不重复已执行候选；理由、候选、结果可追溯；不沿用批准时的状态 | 「a repeated switch request returns the existing record…」「a switch left writing by a process that is gone…」；换备选记录保留决定理由、换下和换上的作业、每次写入的结果；`switch` 和 `verify` 都把理智、理智药、源石、关卡进度列为未知（「an environment failure…」断言 `unknown`） |
| 7 不直接操作设备，不用未批准的自动换作业机制 | 脚本不点游戏、不操作设备，MAA 只经统一写入器关闭和重开；通用写入 CLI 拒绝换备选列表；`stage-run` CLI 除 `switch` 外的动作，关闭和启动 MAA 一律拒绝 |
| 8 状态机写进验证记录；重启后进行中的记为已中断，不接着跑；新运行有新标识 | 本页「状态机」；「a switch left writing by a process that is gone reads as interrupted…」：同一请求返回 `interrupted`，没有第二次写入；运行记录的已中断见 16 的「MAA process gone mid-battle」 |
| 9 幂等键：同键同输入返回已有记录，同键不同输入拒绝并留两份摘要 | 「a repeated switch request…」：第二次 `repeated: true`、写入次数不变；带新 revision 的请求以 `idempotency-conflict` 拒绝，`conflicts` 里有新摘要且与 `input` 不同；「a switch the writer refused before writing anything may be requested again」 |
| 10 更新 `CONTEXT.md`「备选作业」 | `CONTEXT.md`：环境类失败不算该关失败、不自动换用、不记为已用，核对后模型可以决定 |

#48 的两条：
- 第 4 条回放样例见上表第 4 行。
- 用量读不到时停下：已写进规格「日常操作」「检查与修法」正文、两张表，以及工单第 4 条；代码在 16 里已经是这样（`medicine-unknown`）。

## 先失败的测试

- `stage-run-alternates`「a continuation expands only approved jobs…」：旧代码忽略 `continuation`，列表仍是主作业 1、1、4。
- 失败后换备选的主流程：旧代码没有 `switchStageRun`，导入失败。
- 「an environment failure…」的 `unknown` 断言，以及「…the generic write CLI refuses any continuation」：两项在加上对应代码前失败。后者在旧代码下 CLI 返回 `rejected` 和 `configuration-changed`，没有在读配置之前拒绝。
- `stage-run-demo`：旧期望 `['switch-alternate', 'stop-and-tell-user']`，加上用尽检查后为 `['stop-and-tell-user']`，期望随本票改动。
- #48 的回放样例写的是 16 已有的行为，写好后直接通过。为确认它确实能挡住问题，临时把「MAA 报告用药」的硬停改掉再运行，测试失败（判断理由从 `medicine-used` 变成 `medicine-toggle`），随后恢复原样。
- 其余新测试（未三星、用尽、幂等、被拒后再请求、中断、四个场景）是在实现之后补的，写好后直接通过。

## 实际运行的命令

都在本工作树里逐个运行，没有运行完整离线入口（维护者 2026-11-13 的机器负载规则，由协调者按包运行）：

- `npm ci --ignore-scripts`：通过。
- `npm run typecheck`：每次改代码后运行，最后一次通过。
- 单个测试文件，最后一轮的结果见文末「最后一轮」。
- `node scripts/tracker.ts`：只报一项错误 `17-approved-alternate-jobs.md: unfinished-dependency 16`。原因是 17 已经是进行中，而它的阻塞项 16 还没完成；`--write` 遇到这项错误会拒绝写入，所以索引里 17 那一行按 `--write` 会生成的内容手工改成「进行中」，之后不再报索引过期。16 记为已完成后，这项错误自然消失。
- 隐私与元数据检查：用 `scripts/privacy.ts` 的 `inspectPrivacy` 和 `scripts/metadata.ts` 的 `inspectMetadata` 单独运行，都没有发现。

## 实现选择（不是产品限制）

限制性的设计默认值都登记在规格「默认值及其来源」的 17 一行。以下只是实现细节：
- 键和输入摘要都用 SHA-256。
- 换备选记录与运行记录同在私有目录，原子改名写入。
- 读不了的换备选记录，对所有批次都按「未知」处理（失败即关）。
- 写它的进程是否还在，用进程号探测。
- 换备选的写入沿用这一批准备时记下的批准来源和原话。

## 行为评测

新增四个只读场景：
- `daily-alternate-medicine-used`：#48 的样例，有备选、MAA 报告用药，要等用户决定；
- `daily-alternate-medicine-unknown`；
- `daily-alternate-exhausted`：备选用完，不找新作业；
- `daily-alternate-prepared`：已换好，请用户点开始，开始前先 `start`。

`tests/stage-alternate-scenarios.test.ts` 在两宿主目录里用已安装的 CLI 离线核对：只调用偏好读取和 `stage-run.ts read`，文件没有变化；评分在有调用证据时通过、没有时失败。

**未验证**：真实模型运行。工单 28 尚未交付，维护者也还没有登录评测专用目录。maa-daily（SKILL.md 和 `references/stage-run.md`）改动前后同模型、同场景的对比，以及四个新场景的基线都没有运行，按规则记为未验证，留给工单 26。

## 与工单的偏差和需要协调者处理的事

- 工单 17 正文有改动，GitHub Issue #19 的镜像需要同步：
  - 背景加一段 #48 说明；
  - 第 4 条改为「用了理智药（本项目不为这类批次批准任何理智药）、或者用了多少读不到时」；
  - 验证方式补上 #48 的回放。
- 改了 16 的一项测试期望：`tests/stage-run-demo.test.ts` 里没有备选的 SYN-2 未三星，现在只给停下。另外在 16 的一致性测试里加了 `switch` 消费者和用药来源。
- 验证方式要求「原生可用」和「用户交接」两条路径都验证。固定版本没有原生机制（见来源核对），所以只实现并测试了用户交接。

## 未验证

- 真实 MAA、模拟器和游戏上的换备选全过程，包括列表模式失败后整条任务链结束的实际回调，以及写入器关闭、重开 MAA 后作业列表的实际显示。
- 两宿主原生安装后的实际 CLI 运行（只在评测夹具的两个原生目录里离线运行）。
- 真实模型评测（见上）。
- 独立审查由协调者另行安排，本页不记审查结论。

## 最后一轮

作者在提交本页前逐个运行，全部通过：
- `npm run typecheck`；
- 本票的新测试：`stage-run-alternates` 9/9、`stage-alternate-scenarios` 1/1；
- 16 的运行跟踪测试：`stage-run-rerun-gate` 12/12、`stage-run` 14/14、`stage-run-flow` 4/4、`stage-run-demo` 1/1、`stage-run-scenarios` 1/1；
- 用到作业计划展开或统一写入器的测试：`stage-jobs` 6/6、`stage-jobs-regressions` 11/11、`maa-config` 59/59、`setup-integration` 5/5、`training-integration` 2/2、`daily-evaluation` 5/5。

没有运行 `tests/maa-process.test.ts`：它覆盖的进程适配器本票没有改。
