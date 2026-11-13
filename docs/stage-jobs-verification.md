# 15 作业准备验证

## 当前交付结论

最终产品候选 `d2877b561188ea99b1472e824168335059dfd22d` 的 [完整独立 R4](reviews/2026-11-11-15-stage-r4.md) 已通过，Standards / Spec 均 0 项。独立完整离线入口 297 项中 295 通过、2 项条件跳过，类型及额外组合探针通过；[固定候选双平台 CI](https://github.com/VincentChen0111/maa_skills/actions/runs/42919809758) 全绿。R1/R2/R3 的 FAIL 和各轮实际证据原样保留为历史。

固定远程 d287 的两宿主原生安装及实际 CLI 合成准备通过：`.tmp/native-check-mK3upJ` 中 34 条命令，只有预期重复安装拒绝 exit 1；Codex 26 / Claude 192 个仓库文件共 218 个逐字节匹配 Git。655 个生成依赖另记 hash 和 lock metadata，未独立核验 registry 包字节。运行前冻结四份验证源码并实际导入冻结 smoke。五份 ready 默认建议三份备选，明确批准四份备选后只把主作业按三次循环装入列表；原文与派生执行资产、S1 零门槛、待执行记录、全局 LoopTimes 保留、备份、锁释放及正常关闭全部通过，相关临时进程残留 0。

最终改后 32 次真实模型尝试在 `.tmp/15-r4-model-evidence/frozen-models-4852eK`，与改前 MZjbhO 保持框架 `1f2a3e89`、模型、CLI 和 32 对场景指纹相同；各批均 16 次 Codex 401、16 次 Claude 未登录，全部 unverified。连同 9c、8e 两个历史改后批次，共保存 128 份实际尝试（64 Codex 401 / 64 Claude 未登录），0 完成事件和 runner failure。R4 独立审计最终前后 64 份及载荷，旧批次分别经 R2/R3 审计。认证不可用不能证明基线、语义或分数不降，仍由 [26](issues/26-v0-1-0-release-validation.md) 硬阻塞发布。

15 单票有条件交付决定的产品和证据前提已满足；[PR41](https://github.com/VincentChen0111/maa_skills/pull/41) 已 squash 合入 main `3ff455595c4a3dc68817151a5e82f26dfb420c7a`。最终文档 head `5beb40f378a250b9a68af4cb8ad411586ce82dbf` 不改产品，[该 head 的 CI](https://github.com/VincentChen0111/maa_skills/actions/runs/42921934089) Windows / Ubuntu 均通过。未运行真实 MaaCore parser、MAA、模拟器、游戏或全站作业抽样；合成 GUI 和源码推导不写成实机成功。下文“待验证 / 工单进行中”等措辞均为所标旧候选的历史状态。

## 固定 8e 旧候选的根验收（历史）

产品候选 `8e0b94740d8782e8ce8f18beff4279d986ed569a` 基于 06 的实际 main `788ac13febf35a54e556fa527943c01431b8e215`。以下是该候选已实际运行、并经 R3 独立审计的外部验证；[完整 R3](reviews/2026-11-11-15-stage-r3.md) 已结束，唯一 P3 为默认备选数量遗漏，结论 FAIL，工单仍进行中。这些历史成功不能代替修后新候选验证；下文 R1/R2 的失败与待验措辞也保留为历史。

- [固定 8e 双平台 CI](https://github.com/VincentChen0111/maa_skills/actions/runs/42917317154)：Windows job `130182980871` 与 Ubuntu job `130182981445` 均 success，离线入口和类型检查通过。
- 固定远程载荷的两个宿主原生安装与实际 CLI 合成准备通过，原始目录 `.tmp/native-check-Ueyqc6`。34 条命令中仅已有安装目录拒绝为预期 exit 1。Codex 26 个、Claude 191 个仓库文件逐字节匹配 8e；655 个生成依赖文件另记 hash 与 lock metadata，未独立核验 registry 包字节。运行前固定了本地验证脚本、环境构造、配置和 smoke 的副本及 hash，实际导入冻结的 smoke。
- 两宿主实际 query→批准 prepare→读回→正常关闭：低潜成员 A 被排除，已核 B 的执行组只有 B；B 的 S1 原文 `elite=-1` 独立保留，执行内容与有效要求为 0。原文/执行双资产及待执行记录 hash 各自匹配，三条主作业、备选仅保存、全局 LoopTimes 不变、关闭额外干员、备份、锁释放均通过；相关临时进程残留 0。这是安装后 CLI 与合成 GUI 证据，不是实际 MAA Core 加载或游戏运行；原生解析行为仍依据固定官方源码推导。
- 修后 32 次真实本机模型调用位于 `.tmp/15-r3-model-evidence/frozen-models-hT5l2y`，16 次 Codex 401、16 次 Claude 未登录，0 完成事件、0 runner failure，全部 unverified。冻结框架仍为 `1f2a3e89a1aa9ff5b98d61c47083bce95416bada`，框架 hash `fe0cabb53bea0f06c67cb99185e4a37041aa6fe5a2c6749fd5ca53e0d76c9e22`；与 MZjbhO 改前的 14 daily、12 stage、6 core 对逐一核对 CLI、模型与场景 hash 相同，结论仍是未验证。临时夹具及相关进程残留 0。
- 改前、9c 改后、8e 改后累计 96 份实际尝试均原样保留。没有把认证不可用称为模型通过，也没有把同框架比较称为分数不降；成功基线、语义和分数不降仍由 26 硬阻塞发布。

## 作者验证与历史记录

作者基点 `ddd0ca80a3367b589866efde73aa1c0205732c3a`；工单 [15](issues/15-stage-job-preparation.md)。本页记录作者验证，不代替独立审查、真实模型或实机验收。

测试先行接缝为共享 CLI / 导出函数，真实临时文件系统，只替代 MAA 进程和网络。逐轮 red/green 留在忽略的 .tmp：精确地图/难度与前置、未知精英化与逐替代成员、同干员多位置冲突、公开 GET/完整详情/分页、候选不授权、批准指纹及循环次数、外部文本待核、白名单 jobCount、技能解锁与逐技能专精、关卡消歧，以及端到端 CLI 演示。系统临时目录的受限 rename 曾使旧配置测试和本票同样返回 unknown；切换到工作树内临时目录后通过，未修改写入器掩盖环境失败。

`node scripts/stage-demo.ts [已安装 maa-core 的绝对目录]` 运行实际 installed core CLI：合成范围→候选保存→明确批准→配置事务→摘要读回；只替代 MAA 进程。断言三次主作业形成三条、备选仅记批准记录、全局 LoopTimes 保留、额外干员关闭、其他字段原样、只受限重开不启动游戏。临时 home、账号、配置和作业都在自建临时目录，结束清理；最终 stdout 可留作本机安装证据。仓库内运行通过不冒充两宿主原生安装。

模型场景在 `1f2a3e89a1aa9ff5b98d61c47083bce95416bada` 冻结：六个 stage 场景加既有 daily/core 场景；stage 场景实际共享 CLI 在两种临时安装布局共十二次只读调用通过。固定框架测试调用/文件授权，模型对难度、未知练度、替代要求、前置、外部描述和循环交接的解释仍须人工语义核对。根代理已留存改前 32 次真实本机尝试：固定框架 1f2a3e89、改前载荷 ddd0ca80，16 次 Codex 返回隔离认证 401、16 次 Claude 未登录；没有完成事件或 runner failure，全部 unverified。9c 旧候选的改后尝试见后文历史证据，修后固定候选仍待重跑，不声称分数不下降。05 既有真实模型发布门禁原样保留。

R1 前作者候选完整离线入口 206 项：204 通过、2 项跳过（本文件系统不提供 Windows 短路径别名；非 Windows 适配器测试不适用于当前平台）。类型、privacy、metadata、tracker 与评分规则自检通过。另按 red→green 核对共享 levelId 的主线环境误匹配，按地图/难度/diffGroup 分批，拒绝混合环境准备，批准记录保留 difficultyGroup。场景与 fixture 文件相对冻结框架保持不变。

公开前逐文件检查新增源码、注释、文档、场景、测试与工具，全部账号输入为合成数据，没有私有项目路径/授权或真实账号基线；公开源码只保存在忽略临时目录。独立审查、原生安装和模型证据由根代理最终候选记录补齐。真实 MAA、模拟器与游戏尚未运行；循环展开只有固定官方源码与合成配置证据，不声称实机已核。

## R1 集中修复

[独立 R1 原报告与逐项处置](reviews/2026-11-11-15-stage-r1.md) 保留 FAIL。作者接受全部四项：分配落实到独立执行内容、合法预发布版本比较、技能等要求的精英门槛规范化、每关 Markdown 检索覆盖。原文与执行内容分存并分别绑定哈希，查询覆盖也进入报告指纹；批准重新验证完整展示内容与当前事实。

先新增 `tests/stage-jobs-regressions.test.ts` 并观察五个公开函数反例失败，原始证据 `.tmp/stage-r1-red.txt`；随后发现展示的执行内容被改而旧报告哈希仍可用，单独红测留在 `.tmp/stage-r1-binding-red.txt`。修复后七个定向回归通过，包含唯一干员重分配与同名不同要求、S3 的 -1/0/1 规范化及低等级/未知精英拒绝、beta/rc 与构建排序、每关分页覆盖、原文和执行资产各自在写前/重开后漂移时 unknown、保留锁/待执行记录且无 complete。`.tmp/stage-r1-green.txt` 保留实际输出。既有 stage CLI/安装布局/循环读回测试继续通过；类型和隐私检查通过。

六个 stage 模型场景、fixture、评测框架文件相对 `1f2a3e89` 保持不变。R1 修复不重写既有 32 次改前认证失败证据，也不增加模型例外。根代理执行最终固定候选的远程原生安装与改后本机模型尝试。此处作者阶段不把这些未完成验证记为通过。

修复已重放到 06 实际合并点 `788ac13febf35a54e556fa527943c01431b8e215`。仅工单记录出现内容冲突，保留其未验收状态；tracker 由脚本重建。逐段核对统一写入器 diff，保留 06 的严格事务 schema、独立恢复锁和恢复证据流程；15 只增加作业窄路径、jobCount 及三个资产核对点。doctor 对未核 jobPlan 继续 unknown，不自动解除锁或还原资产。

整合后完整 `node scripts/check.ts` 退出 0：293 项、291 通过、0 失败、2 跳过（同上平台条件），tracker/privacy/metadata 无错误、评分自检 7 rules / 14 samples 通过；原始输出 `.tmp/stage-r1-integrated-check.txt`。类型检查与 `git diff --check` 通过；逐文件再次检查 19 个交付文件，合成账号和公开源码引用无个人数据。R2 完整独立复核、最终原生安装、改后真实模型和远程 CI 仍由根代理完成，工单保持进行中。

## 有条件交付决定与发布门禁

2026-11-11 根代理依据维护者授权自行决定推进问题及继续按依赖实施，对 15 单独决定：仅隔离认证不可用可延期模型发布验收。前提是 R1 四项修复和 06 整合的完整独立复核、离线/类型、双平台 CI、固定双宿主原生准备/读回全部通过，且保存完整实际前后及新增场景尝试。此决定不从 06 自动继承，不是维护者明确免测；实际完成的行为失败或回归不能改成 unverified 或自动延期。

改前框架 `1f2a3e89` / 载荷 `ddd0ca80` 的 32 次真实尝试全部 unverified；9c 旧候选另有同框架改后 32 次，详见后文，修后候选须重新固定并运行。成功的 stage/daily/core 模型基线、已验证执行分配与原作业分开、精确难度/前置、批准及循环交接语义、同模型前后分数不降均在 [26 发布验收](issues/26-v0-1-0-release-validation.md) 硬阻塞发布。完整独立复核等前提未完成前不勾选工单完成，也不把合成 CLI 或 GUI smoke 当模型/实际游戏通过。

## R2 历史证据与零门槛修复

[完整独立 R2](reviews/2026-11-11-15-stage-r2.md) 固定候选 `9c60fd32fe8c4b1695dbe0a8d747a2aeff7471d5`，结论 Standards 0 / Spec 1 P2，FAIL。S1 的显式 elite=-1 仍会被 Core 拒绝，根接受该意见；R1 四项与 06 整合的其余复核结果保留，但不能覆盖这个缺陷。

根执行且 R2 独立审核的 9c 历史证据如下；这些记录不改写，也不作为修后新候选通过的证明：

- [双平台 CI run 42914947796](https://github.com/VincentChen0111/maa_skills/actions/runs/42914947796) 的 Windows/Ubuntu、离线检查和类型检查通过。
- `.tmp/native-check-QuEOop` 保存 34 条原生命令，只有预期重复安装拒绝为 exit 1；Codex 26 + Claude 190 = 216 个仓库文件逐字节匹配 9c，655 个生成依赖文件另记哈希和 lock 元数据，未冒充对 registry 内容独立核验。合成 GUI 烟测实调 query→prepare→readback→normal-close：低潜 A blocked / B ready、派生单 B 与源 A+B 分存、双哈希、三次主条目、备选仅保留、全局 LoopTimes 不变、锁释放均通过；相关进程为 0。没有真实 MAA 游戏运行。
- `.tmp/15-model-evidence/frozen-models-MZjbhO` 和 `.tmp/15-after-model-evidence/frozen-models-fo3la6` 分别保存 before/9c-after 各 32 次真实尝试，各 16 Codex 401、16 Claude 未登录，全部 unverified、0 完成。框架哈希均 `fe0cabb53bea0f06c67cb99185e4a37041aa6fe5a2c6749fd5ca53e0d76c9e22`；14 daily / 12 stage / 6 core 对的 CLI/model/scenario 相同，仍不能证明语义或分数不降。没有将已完成行为失败改成 unverified。

R2 修复先新增两项公开接口反例，`.tmp/stage-r2-red.txt` 实测 7 pass / 2 fail：matcher 的有效值仍为 -1，prepare 实际文件仍含 -1。修复只对已知 S1/显式 -1 补零门槛归一化；技能 0/缺省的 -1 和缺省 elite 保持，非整数、null、文本、未知账号精英、未证实技能等级/模组仍待核。测试覆盖这些组合及精零 39/40 级边界，实际读取交给 Core 的 JSON，核源 -1 /执行 0、有效要求、批准变更拒绝和双资产/记录哈希，不复制原生解析器假称加载实跑。

修后定向 17 项通过，`.tmp/stage-r2-green.txt`；最终完整离线入口 `.tmp/stage-r2-final-check.txt` 为 295 total / 293 pass / 0 fail / 2 skip（仍为短路径和非 Windows adapter 平台条件），tracker/privacy/metadata 无错误、评分自检 7 rules / 14 samples 通过。类型检查通过。六个固定模型场景和 fixture 未改，05/06/26 既有门禁不变。根将重跑固定新候选原生与改后模型，再进行默认三轮内的完整 R3；本页不提前记 R3 或新候选远程验证通过。

## R3 默认备选修复与追加 R4 授权

[完整 R3 原文与作者处置](reviews/2026-11-11-15-stage-r3.md) 保留 FAIL。根接受唯一 P3：默认备选误列全部 ready，未执行既有“最多三份、批准时可增减”的规格。作者先写公开 matcher/Markdown 和 prepare 回归，`.tmp/stage-r3-red.txt` 为 9 pass / 2 fail，实际默认返回五份而非三份。修复只收窄默认建议数组；完整候选证据保留，明确批准可选择第四/第五份或更多已核备选、减少至一份/零份或另选主作业，prepare 不新增备选硬上限或参数限制。定向 19 项通过，`.tmp/stage-r3-green.txt`；用户指定的备选顺序、双资产与记录哈希、三次主条目、全局 LoopTimes 和由用户开始边界保持。

2026-11-11 根代理依据维护者最新“以后这种情况可以你自己授权，最好压缩复核轮次”，明确自行授权追加一次 15 R4。理由：R3 首次发现既有默认备选数遗漏，R1/R2 修复和其余完整边界均已独立核验；集中完成本次修复，由原 R3 独立审查员一次完整复核最终包及新增差异，减少重复，仍独立于作者。无需再次询问维护者；不是免除真实产品错误或扩大模型豁免，不提前记 R4 通过。

六个模型场景、fixture 和固定框架不变。8e 的 CI/原生/32 次 after 证据及累计 96 次真实尝试按本页顶部完整保留；修后候选由根代理重新固定并执行相应原生、模型及 CI，不冒用旧头成功。PR41 保持草稿，15 仍进行中，16 依赖不解除。

本次最终完整离线入口 `.tmp/stage-r3-final-check.txt` 退出 0：297 total / 295 pass / 0 fail / 2 skip（仍为短路径别名和非 Windows adapter 平台条件），tracker/privacy/metadata 无错误，评分自检 7 rules / 14 samples 通过。类型检查及差异空白检查通过，文档后续更新另核 tracker/privacy/metadata；逐文件检查新回归和完整 R3 记录均为合成/公开数据。prepare 回归同时拒绝未知、不满足、重复或与主作业重复的备选，明确删减后未选资产不落盘。上述作者结果不替代 R4 独立结论或新候选的远程原生/模型/CI。

## 29 匹配改进作者验证（2026-11-13）

基点 `4a1fd26`（PR 49 合并后的 main），分支 `claude/29-stage-job-matching`；工单 [29](issues/29-stage-job-matching-improvements.md)。本节是作者记录，不代替独立审查、真实模型评测或实机运行。来源、固定提交和逐项结论见[作业接口核对](stage-jobs-sources.md)「29 匹配改进核对」。

### 逐项结论

| 项 | 核实结论 | 交付 |
| --- | --- | --- |
| 线上后端 | 线上是 ZootPlusBackend `746b394`（`/version` 实读）；MaaCopilotServer `e3f9cbf` 已归档，不是线上版本；15 用到的参数和端点在线上仍成立 | 只更新核对记录，查询不用改 |
| 没写要求的旧作业 | MAA 对缺省 requirements 不作要求，没有按稀有度的默认值；MAA-PRTS 的默认表是其用户定的规则 | 缺省、null、空对象记为「要求未写明，待核」；不给推定值 |
| 借助战 | 成立：MAA 恰好缺一组时借助战补位，只按名字和技能挑人；列表模式的开关是界面运行状态 | 候选标为 support（需借助战），单列、批准时 `supportJobs` 点名，记录借的位置；不写 SupportMode |
| 评分 | 字段含义成立；「≤50 票评分不足」只在源码默认值上成立，线上分界是 10 票；详情接口有缓存 | 评分取自查询摘要，按作业站自己的标记和随票数上升的好评率门槛分三档排序 |
| 关卡后缀 | 有：`#s`（SIX_STAR，45 条），协议没有对应难度位 | `stages` 返回 `tableDifficulty`；`#s` 继续 unsupported，补测试 |
| 动作里的干员名 | 名字可以是干员名或群组名；设置单位坐标可登记装置；召唤物、装置在游戏表里是 TOKEN/TRAP | 未声明的干员和无法识别的名字记为待核并列出；在线查询另读固定干员表 |
| 接口语义 | `level_keyword` 匹配关卡名、levelId、stageId（不含章节 ID），没命中时不筛关卡；`~` 排除成立 | 每关记录返回的作业 ID，报告区分没有作业、其他关卡、疑似退回、覆盖不足 |

核实后没有实施的部分：`operator` 参数（含 `~` 排除）不用于查询，因为服务端只索引 `opers` 的名字、不含群组成员，按名字排除会误删群组里另有可用成员的作业；按稀有度的默认练度不采用（见上表）；`has_next` 在恰好装满的最后一页也为真，只会让报告多标一次未穷尽，不改；`limit` 上限是 50，但每关 3 页×20 条是 15 的规格上限，本票不改；作业站前端的评分文字分档只作背景，没有采用。

### 测试先行与实际运行

新增 `tests/stage-jobs-matching.test.ts`，每项都先在共享 CLI 或导出函数接缝写失败测试，用合成作业和合成账号快照，网络只用边界替身。逐项观察到的红灯：没写要求的条目返回 ready（`.tmp/29/red1.txt`）；评分排序下主作业仍是接口第一份（`red2.txt`）；检索结果字段不存在（`red3.txt`）；未声明干员的作业仍是 ready（`red4.txt`）；缺一人的作业是 unknown 而不是 support（`red5.txt`）；准备时点名的需借助战作业被拒（`red6.txt`）；`stages` 没有原始难度（`red7.txt`）。这些文件在被忽略的 `.tmp/29`，不随提交。

新文件 11 项测试：

- `operator entries without written requirements stay 待核 instead of passing on ownership alone`、`CLI query reports unstated requirements as 待核 in Markdown`；
- `ratings only reorder ready candidates: …`、`online collection reads rating counts from the query summary, not the cached detail view`；
- `search results distinguish no jobs, unrelated fallback results and insufficient coverage`；
- `operators referenced by actions but not declared in opers or groups keep the job 待核`、`online table loading reads the pinned character table for queries and degrades to unclassified names when it is unavailable`；
- `a job missing exactly one operator the account does not own is listed separately as 需借助战`、`a 需借助战 job is prepared only when the approval names it; the plan records the borrowed slot`；
- `reports in the earlier match structure no longer verify, so their approvals do not carry over`；
- `the six-star #s stage spelling is listed but not matched: …`。

15 的既有测试保留，只做了两处结构适配，断言没有放宽：`tests/stage-jobs-regressions.test.ts` 的「derived groups preserve …」把只作分配用途的「仅甲」组成员从无要求改为 `{ elite: 0 }`，因为本票有意让无要求条目待核，这个用例要测的唯一分配和派生内容不变；「approval binds displayed execution and search coverage …」里手工改写的检索覆盖补上新的 `ids: []` 字段，仍断言改动后被拒。准备入口把「报告无法重新核对」统一按批准不匹配拒绝，旧结构报告因此不能沿用批准；报告指纹、批准绑定和派生执行内容的校验逻辑没有改。

`tests/stage-scenarios.test.ts` 在两种安装布局实际调用共享 CLI，覆盖原有六个和新增四个场景（`daily-stage-requirements-unstated`、`daily-stage-support-named`、`daily-stage-rating-order`、`daily-stage-undeclared-action`），并核对新增场景的状态、单列和排序。

实际运行（本机 Windows，Node 24）：`npm run typecheck` 通过；单文件 `tests/stage-jobs-matching.test.ts` 11/11、`stage-jobs.test.ts` 6/6、`stage-jobs-regressions.test.ts` 11/11、`stage-scenarios.test.ts` 1/1、`stage-demo.test.ts` 1/1、`maa-config.test.ts` 59/59、`doctor.test.ts` 74/74、`doctor-scenarios.test.ts` 6/6 通过。完整离线入口 `node scripts/check.ts` 在文档提交前（`.tmp/29/check-1.txt`）退出 0：394 项，393 通过、0 失败、1 跳过（非 Windows 适配器在本平台不适用），tracker、privacy、metadata 无错误，评分自检 7 rules / 14 samples 通过。最终提交上第一次完整运行（`check-final.txt`）有 1 项失败：`tests/maa-process.test.ts`「Windows launches and normally closes a temporary GUI …」在第一次关闭合成 GUI 时报 `maa-close-timeout`。该文件单独重跑三次：通过、通过、失败（同一步骤，同一错误，用时 36.9 秒）；从基点 `4a1fd26` 导出的副本单独运行三次全部通过。失败的步骤只调用 `maa-process.ts` 关闭合成窗口，本分支没有改这个文件和这个测试，本机同时有其他构建在跑；按已知的关闭超时问题记录，未进一步定位。随后在同一提交上第二次完整运行（`check-final-2.txt`）退出 0：394 项，393 通过、0 失败、1 跳过，tracker、privacy、metadata 无错误，评分自检通过。

### 报告结构变化（供 16、17 合并时对照）

- 候选状态多了 `support`（需借助战）；只有 `ready`，或在 `supportJobs` 点名的 `support`，能进入批准。
- 每份候选新增 `rating`、`actionNames`、`support`；每关新增 `supportCandidates`、`searchResult`；`search[]` 每项新增 `ids`；`tables` 新增 `characters`（只含用到的条目）和 `charactersSource`；`stages` 动作返回 `tableDifficulty`。
- 主作业和备选的建议顺序按评分分档，同档保持接口顺序；`candidates` 仍按接口顺序完整保留。
- 批准的 `selections[]` 可带 `supportJobs`；待执行记录的 `ApprovedJob` 可带 `support: { slot, members }`。
- 报告指纹随这些字段变化，旧报告上的批准不沿用。

### 未验证

- 六个原有 stage 场景和四个新增场景的同模型前后评测没有运行：28 正在并行实现，评测专用登录目录还没有登录，按规则不调用真实模型。记为未验证，由 [26](issues/26-v0-1-0-release-validation.md) 发布验收补上；26 正文目前只列出原有六个场景。
- 没有运行真实 MAA、模拟器或游戏：借助战补位、「借助战」开关和「补漏」档位只有固定源码和合成配置证据；MAA 能否在好友助战里找到对应干员取决于实际助战列表。
- 在线查询读取固定干员表只用边界替身测试；作者 2026-11-13 匿名下载该文件（15.6 MB）用于核对，CLI 在线路径没有实跑。
- 线上评分分界（10 票）来自一次 300 份作业的抽样，作业站配置以后可能改变；本工具直接使用作业站的标记，不依赖这个数字。

### R1 审查修复（2026-11-13）

协调者转来独立 R1 的结论：有条件通过，P1 0、P2 1、P3 4；协调者逐条复核后全部接受，另接受审查员在同一段匹配代码里找到的三处 15 既有缺陷（同属关卡身份一类）。审查记录由协调者保存，本节只记修复和证据。本轮基点是上一轮的最后提交 `f493cdc`。

| 意见 | 修复 | 证据 |
| --- | --- | --- |
| P2：同一关卡关键字下返回的作业不在别名里时被说成「本次检索条件下这一关没有作业」，第 9 章突袭因此报没有作业 | 新增唯一的关卡身份判断 `resolveJobStage`，逐份地图核对和每关检索结果分类共用；只有确属其他地图的结果才可以说没有作业，同图无法证明和关卡名无法确定另列 | `tests/stage-identity.test.ts`「a chapter-9 raid job named by the normal stageId …」「search results on the same map or with unresolvable names …」 |
| 15 既有 (c)：第 9 章突袭作业全部判为地图不符 | 同上：同 levelId、同代号、同难度组的普通/突袭孪生关卡算本关，由作业的难度位决定能否用于突袭 | 同上，及一致性测试逐个列出 17 对 |
| 15 既有 (b)：act50side_ex01/ex02 的 levelId 互换，levelId 末段别名让写着 TD-EX-2 的作业通过 TD-EX-1 的核对 | 不再接受 levelId 末段；MAA 列表模式按作业自己的 stage_name 查关卡并按它的代号导航（固定源码），所以这份作业会跑到 TD-EX-2，现判为其他关卡 | 「stage identity conformance on pinned table cases …」「the per-job map check uses the same predicate …」 |
| 15 既有 (a)：难度 0 或缺省一律判为不符 | 按 MAA 图形界面的处理，0 或缺省只算普通；突袭仍不用，理由写成 `difficulty-unstated-normal-only` | 「difficulty 0 or missing means normal only …」 |
| P3：规格正文没有评分门槛数字，不足 5 票不设门槛没有登记 | 正文写明 5 票 65%、按对数过渡到 100 票 85%、更多票不再提高、不足 5 票不设门槛；默认值表同一行补上不足 5 票的理由 | `docs/spec.md` 29 段与「默认值及其来源」 |
| P3：缺场景 | 新增 `daily-stage-six-star-unsupported`，安装后两种布局实调 `stages` 和 `query` | `tests/stage-scenarios.test.ts` |
| P3：工单 26 只列 15 的六个场景 | 26 登记 29 的模型验收延期和新增五个场景 | 工单 26 正文 |
| P3：作业接口核对说难度只有 1/2/3 | 改为 0 或缺省未设置、1 普通、2 突袭、3 两者，并补 R1 补核一节 | `docs/stage-jobs-sources.md` |

一致性测试用 `tests/fixtures/stage-identity-cases.ts`：从固定关卡表摘出的 46 条记录，只含 ID、代号、区域、难度、难度组和解锁条件，不含名称或描述。覆盖全部 17 对第 9 章孪生关卡、act50side 的互换、只写 levelId 末段的 NONE 关卡（`training_1`）、普通的 NONE 普通/突袭关卡、`#s`、以及 TOUGH/EASY 共用代号的情形。同一测试还核对两处使用方给出的结论相同。

测试先行：先写 `tests/stage-identity.test.ts`。由于新判断尚未导出，整文件先因导入失败报红；另把不依赖新导出的三项复制到被忽略的 `.tmp/29/r1-red-raid.test.ts` 对旧代码运行，`.tmp/29/r1-red2.txt` 记录 3 项全部失败：第 9 章突袭的两份作业是 blocked；写着 `act50side_ex02` 的作业在 TD-EX-1 下是 ready（错关会被准备）；没写难度的作业在普通关是 blocked。实现后这些用例通过。

与 15 相比还有两处行为变化，都是同一判断的直接结果：只写 levelId 末段、而末段不是任何 stageId 的作业（例如 `training_1`）现在判为无法确定，MAA 同样查不到它；写完整 levelId、而这个 levelId 被两个同难度的关卡共用时（固定表有 71 个，例如活动任务关卡的 `_m1`/`_m2`），现在判为同图无法证明，不再接受。

本轮只改了上一轮自己的 29 测试，15 的测试没有改：检索结果多了 `sameMap`、`unresolved` 两个计数；「名称相近的其他关卡」用例给合成关卡表补了一条 `synthetic_010`，因为查不到的名字不再算作其他关卡；`#s` 用例的理由从 `map-mismatch` 改为 `stage-same-map-unproven`。

报告结构在上文所列之外又多了：候选的 `stageMatch`；每关 `searchResult` 的 `sameMap`、`unresolved` 计数，以及 `same-map-unproven`、`unresolved` 两种结果；`tables.stages` 除所选关卡外还保留作业关卡名解析到的条目（所选关卡在前，其余按 ID 排序），准备时据此重新解析出同样的结论。

本轮实际运行（本机 Windows，Node 24）：
- `npm run typecheck` 通过。
- 单文件：`stage-identity` 5/5、`stage-jobs-matching` 11/11、`stage-jobs` 6/6、`stage-jobs-regressions` 11/11、`stage-scenarios` 1/1、`stage-demo` 1/1、`maa-config` 59/59、`doctor` 74/74。
- 在 `d9ca582` 上两次完整运行 `node scripts/check.ts`（`.tmp/29/r1-check.txt`、`r1-check-2.txt`），结果相同：399 项，397 通过、1 失败、1 跳过。失败项都是 `tests/maa-process.test.ts`「Windows launches and normally closes a temporary GUI …」在第一次关闭合成 GUI 时报 `maa-close-timeout`。该入口在测试失败后不再跑后续检查，所以另外直接调用同样的导出函数：tracker、privacy、metadata 无错误，`scripts/eval-selftest.ts` 7 rules / 14 samples 通过。
- `maa-process.test.ts` 单独跑三次：第一次 2 项失败（同一关闭用例，另有 native observer 用例报 `maa-process-command-failed`），第二次 1 项失败（同一关闭用例），第三次 15/15 通过。本分支没有改 `maa-process.ts` 和这个测试文件；当时本机有 33 个 node/PowerShell 进程在跑（其他构建并行）。协调者转述：审查员在完整运行里见过一次这个关闭超时，单独跑三次都是 15/15。

未验证（本轮新增）：检索结果分类没有可离线运行的评测场景。评测的网络替身只服务固定提交的 GitHub JSON，而且只对 operator-cost 和 cultivation-gaps 两个脚本生效；要为作业站接口加替身，得改共享评测框架，而工单 28 正在改这部分。所以这类结果目前只有导出函数和 CLI 接缝的测试，模型怎样转述它们没有评测，已登记到工单 26。
