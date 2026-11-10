# 15 作业准备验证

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
