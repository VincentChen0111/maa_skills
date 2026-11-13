# 培养建议报告验证记录

2026-11-13，工单 [20](issues/20-reviewed-cultivation-report.md) 在分支 `claude/20-cultivation-report` 实施。分支叠在工单 18 已审查、尚未合并的分支上（18 的头 `ef902a1`，其下是 09 的 `6df8ed0`，基于 `origin/main` `4a1fd26`），因为 20 被 14（已在 main）和 18 阻塞。实施进度：进行中，等待独立审查，尚未合并。

## 交付内容

- `skills/maa-core/scripts/cultivation-report.ts`：培养报告的 `draft` 与报告协议的 CLI（`read`、`brief`、`review`、`fail`、`skip`、`approve`）。数字全部来自 14 的 `calculateCultivationGaps`：每步花费、第 1 到第 k 步一起计算的累计结果、库存能支持到第几步；NGA 引用经 18 的 `readNgaThread` 只从缓存取；作业站证据经 15 的只读 `collectStageJobs` 和逐成员匹配；其他来源按共用结果格式原样转交。
- `skills/maa-core/scripts/advice-report.ts`：可复用的建议报告协议（工单 22 复用）。按内容 SHA-256 存放的不可变版本、两宿主共用的自包含审查说明、每版本一次审查结论、未完成审查如实记录、明确跳过、改正生成新版本且不复审、逐项批准与范围、`resolveApprovedItem` 供 daily 核对引用。
- `skills/maa-core/references/report-review.md`：两宿主共用的审查说明模板。
- 复用接缝（各只加导出，不改行为）：`research.ts` 导出唯一的 Markdown 惰化函数 `inert`/`inline`/`citationLink`；`cultivation-gaps.ts` 把表读取提成 `loadGapTables`（`queryCultivationGaps` 改用它）；`stage-jobs.ts` 导出 `loadStageTables` 并可传入 fetcher。
- 文档：[建议报告接口](../skills/maa-core/references/advice-report.md)、[培养报告接口](../skills/maa-account/references/cultivation-report.md)；maa-account、maa-core、maa-help 的 SKILL 与宿主说明；规格「账号快照与建议报告」正文和两张来源表；README、宿主说明、评测说明。
- 评测：`eval/maa-account/report-scenarios.ts` 新增 `account-report-skip-review`、`account-report-default-review`、`account-report-approve-one`、`account-report-casual`；`eval/report-observer.ts` 把私有目录里的报告记录转成评分用的 `reports`/`reviews` 证据；`eval/network-fixture.mjs` 增加 `cultivation-report.ts draft` 入口。

## 与工单原文的差异及原因

- 一步只放一个干员。14 的共享计算拒绝同一干员重复出现（要求合并目标），20 又要求复用 14 的真实计算，所以同一干员的几个目标合并成一步。用户想「先 A 精二、再 B 精二、再 A 专三」时，A 的两个目标只能放在同一步。已登记为设计默认值。
- 作业站证据在 `draft` 时重新运行共享的只读作业查询（公开 GET），因为把整份作业结果交给模型转抄既容易出错也无法核对；离线测试用替身网络。评测网络夹具只允许固定的 GitHub raw 地址，所以评测场景不覆盖作业站证据。
- 评测运行器（`scripts/eval-run.ts`、`scripts/eval-fixture.ts`）属于工单 28，本票没有改动。报告观察器 `eval/report-observer.ts` 目前只在离线测试里使用，接入运行器留给 28。
- 开发过程中有三次运行读取了真实的公开 GitHub raw 数据表（固定提交的公开游戏数据，只读）：评测网络夹具还没有覆盖 `cultivation-report.ts draft` 时 `tests/advice-report.test.ts` 的第一次运行（因找不到合成干员而失败），以及两次排查原因的临时脚本。随后扩展了夹具并加了测试，之后的运行都不联网。

## 验收对照

| 验收 | 证据 | 状态 |
| --- | --- | --- |
| 1 读快照和玩法优先级，给出顺序、每步材料/龙门币花费和库存能支持到哪一步；缺偏好时说明假设或询问 | `tests/cultivation-report.test.ts`「a draft keeps the given order …」：步骤顺序、每步花费与 14 的 `costs[].total` 相同，累计结果与 14 对前缀的计算相同，`supportedThrough` 为 1；「without a stated priority …」：缺优先级返回 `priorities:missing` 且不保存，假设标为假设；「unknown stock or progress …」：未知库存保持待核，不算够 | 已核（离线） |
| 2 用 14 的真实计算，结合 NGA 和作业站依据说明原因；资料带作者、日期、来源、可信度，事实与推断分开 | 同上文件「NGA citations come only from posts already read …」：引用与 `readNgaThread` 缓存结果逐字段相同，没有请求；「job-site evidence comes from the shared read-only query …」：要求行与 `collectStageJobs` 的结果相同；「facts and inferences are separated …」：理由、假设、总体推断标为推断，所有外部文字经 `inert` | 已核（离线） |
| 3 作业站用只读入口、复用共享匹配；19 的结果按同一格式补充，缺少不阻塞 | 作业证据只调用 `loadStageTables` 和 `collectStageJobs`；「results from other research sources …」：共用格式条目标为转交，NGA 不能这样传；没有 19 的结果时报告照常生成 | 已核（离线） |
| 4（第 1 轮后补充：改正版本也列出重新读取后变化的结果）交给 daily 的报告默认审查：一名审查员、一轮、只接受真正的错误；记录接受/拒绝理由；改正后不复审并列出改动 | `tests/advice-report.test.ts`「the default review runs once …」：没有审查说明不能记录结论；每条意见必须有决定和理由；同一版本第二次审查被拒；接受了错误的版本不能批准；改正版本必须覆盖接受的意见、不能改正被拒的意见；改正版本直接为已审查、不能再审，报告列出改动和不同的输入。逐条判断意见是 agent 行为，见下面「未验证」 | 协议已核（离线）；agent 行为未验证 |
| 5 两宿主共用自包含审查说明；Claude 用新上下文，Codex 用新 codex exec 进程；无法完成时如实标明 | 同一文件：审查说明由同一模板生成，内含报告正文和 JSON 全文、没有状态或作者结论，SHA-256 与文件一致；「an unfinished review is never shown or approved as reviewed」：未完成标「审查未完成」、不能批准，之后可以重审或跳过。两宿主的发起方式写在接口说明和宿主说明里 | 说明与记录已核（离线）；真实宿主发起未验证 |
| 6 用户当次明确跳过时不审，报告醒目标「未审查」；随口问答不套用报告审查 | 同一文件「an explicit skip …」：报告第一段就是「【未审查】」和用户原话，跳过后不能再审；`tests/report-scenarios.test.ts`：随口问答场景不保存报告，留下待审报告的运行被评为 `report-review` 失败 | 已核（离线）；模型行为未验证 |
| 7 条目逐项批准并写明范围；审查通过不等于执行授权；account 不写 MAA 配置、不执行培养 | 同一文件：只批准点名的 S1，S2 没有批准；批准记录写明范围（daily 只能安排专精训练，其余由用户在游戏里完成，不包括刷关、碎石和用药、加工和兑换）；`resolveApprovedItem` 只认已批准条目；整个流程只写私有目录 `reports/`，MAA 配置没有变化 | 已核（离线） |

## 设计默认值

产品限制都登记在[规格](spec.md)「默认值及其来源」以「20」开头的行，日期 2026-11-13，并汇总在「规则来源」的「20 培养建议报告」行：

- 数字只来自 14；第 1 到第 k 步一起计算得到累计与「支持到第几步」；同一干员只占一步。
- 玩法优先级必须是用户原话或标明的假设，缺少时不保存；agent 写的内容标为推断。
- NGA 只从缓存引用已读的楼层、不发请求；检索结果不能引用；作业站只经共享只读查询；其他来源原样转交并标明。
- 每个版本一次审查结论；改正生成新版本，必须覆盖接受的意见，不复审，列出改动、不同的输入和重新读取后变化的结果。
- 审查未完成不算一轮、不能批准，可以再发起或由用户明确跳过。
- 跳过只认用户当次原话，偏好原话不能代替。
- 只能批准已审查或明确跳过的版本，逐项点名；daily 只能据培养条目安排专精训练。
- 评测网络夹具增加 `cultivation-report.ts draft` 入口（规格「成本与缺口评测网络夹具」两行已补充）。

只影响实现、不是产品限制的选择：报告 Markdown 模板只有中文，其他语言由 agent 转述（与 13、14 相同）；报告存放在私有目录 `reports/<种类>/<内容 SHA-256>/`，审查说明、审查结论、未完成记录和批准各自一个文件，审查结论和批准用独占创建，不覆盖；步骤编号为 S1、S2……。

## 测试与运行记录

本机 Windows 11、Node 24。测试用真实临时目录和真实 CLI；只替代网络（导出函数测试注入 fetcher 和 NGA 传输替身，CLI 测试用评测网络夹具）。没有调用真实模型。按维护者 2026-11-13 关于本机负载的要求，没有运行完整离线入口 `node scripts/check.ts`（由协调者在冻结的头上统一运行），只运行类型检查和下面的单个测试文件，逐个运行。

- 先写失败测试：`tests/cultivation-report.test.ts` 在实现前运行，因模块不存在失败（`ERR_MODULE_NOT_FOUND`）。`tests/eval-network.test.ts` 新增的启用检查先对原夹具运行，`cultivation-report.ts draft` 未启用（期望 `true`、实际 `false`），扩展夹具后通过。
- 协议模块和它的测试是一起写的，所以另做了三处变异核对：把「审查接受了错误」的状态改成「已审查」、去掉「未审查」标记、去掉「改正必须覆盖接受的意见」的检查，`tests/advice-report.test.ts` 各有一项失败；恢复后全部通过。
最后一次运行（代码与提交 `1cc482e` 相同，之后只改了文档和 SKILL 文字）：

- `npm run typecheck`：通过。
- `tests/cultivation-report.test.ts` 8 项、`tests/advice-report.test.ts` 4 项、`tests/report-scenarios.test.ts` 1 项（四个场景，两种安装布局交替）、`tests/eval-network.test.ts` 3 项：全部通过。
- 受复用接缝影响的文件：`tests/cultivation-gaps.test.ts` 23 项、`tests/stage-jobs.test.ts` 6 项、`tests/gap-scenarios.test.ts` 1 项、`tests/cost-scenarios.test.ts` 1 项、`tests/research.test.ts` 7 项、`tests/research-scenarios.test.ts` 1 项：全部通过。
- skill 目录有新增文件：`tests/account-installation.test.ts` 2 项、`tests/help-installation.test.ts` 6 项：全部通过。
- `node scripts/tracker.ts`：无错误。
- 没有运行：完整离线入口（隐私检查、元数据检查和全部测试），由协调者统一运行。另用一个临时脚本检查了本票改动文档里的相对链接，没有断链。

## 第 1 轮审查后的修复

协调者对第 1 轮的三项 P3 全部接受，本轮修复（审查记录由协调者写）：

- P3-1：改正版本原来只比较 agent 的输入，重新读取的快照、NGA 缓存、作业结果和公开表变化后，工具数字变了，报告却写「无」。现在 `revisionOf.changedResults` 列出所有变化的字段（快照读取时间、来源时间和覆盖状态，每步花费、累计和够不够，支持到第几步，每条资料的各字段，共享计算的结果；公开表按仓库、提交、文件和内容 SHA-256 比较，同一张固定表晚些时候重读不算变化）。有变化时报告顶部提示这些变化没有经过审查。仍可批准，没有新增拒绝规则。测试：`tests/advice-report.test.ts`「a correction drafted after the account snapshot changed …」。
- P3-2：评测观察器把审查接受了错误、却没有改正版本的报告记为待改正，审查不算通过；有改正版本指向它时，两版都算已审查。测试：`tests/report-scenarios.test.ts` 的默认审查场景增加了这两种情况。
- P3-3：maa-help 里「用到凭据的读取和调研是后续能力」与已交付的 NGA 读取矛盾，改为：NGA 凭据已用于 account 的只读检索和读帖，森空岛账号和 B 站凭据目前只能设置和检查状态（12、19 不在本分支）。这是 agent 可见文字，没有离线测试，模型评测未验证。
- 先写失败测试：新增和修改的断言在修复前运行，`tests/advice-report.test.ts` 5 项中 2 项失败（新测试，以及原测试对 `changedResults: []` 的断言），`tests/report-scenarios.test.ts` 失败（观察器给出 `reviewed` 而不是 `needs-correction`）。修复后：`npm run typecheck` 通过；`tests/advice-report.test.ts` 5 项、`tests/report-scenarios.test.ts` 1 项、`tests/cultivation-report.test.ts` 8 项通过。审查员的两个离线复现脚本重新运行：改正版本顶部出现未审查变化的提示；待改正的报告在默认审查场景里评为 `report-review` 失败。

## 未验证

- 真实模型评测（交给工单 26）：四个新场景在两个宿主上的基线、改动前后比较；本票改了 maa-account、maa-core、maa-help 的 agent 可见文字，改动前后的同场景比较也没有运行。原因：28 的运行器还没有合并，评测专用登录目录还没有由维护者登录。
- 真实宿主上的独立审查发起：Claude Code 开全新上下文子代理、Codex 起 `codex exec --sandbox read-only --ephemeral --skip-git-repo-check -` 进程，审查员按说明回复 JSON，调度者逐条判断。宿主是否允许在会话里再起 `codex exec`、Claude 评测隔离下能否用子代理，都要在真实宿主上核实；当前运行器的隔离设置不允许子代理，所以 `account-report-default-review` 需要 28 在运行器里放行一名审查员才能完整运行。
- 报告观察器接入运行器（28）：在接入之前，真实运行里报告文件会被当成未授权的文件变化，`reports`/`reviews` 证据也是空的。
- 真实网络：NGA 帖子（只用缓存）、作业站公开查询、固定公开数据表，都只用合成数据测过。
- maa-daily 侧按 `cultivation/<hash>#S1` 引用核对批准（`resolveApprovedItem` 已提供，daily 的专精计划目前仍按原样记录授权原话或条目）：留给后续工单接入。
