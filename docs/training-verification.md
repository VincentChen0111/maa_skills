# 24 训练工具验证记录

## 当前交付结论

最终产品 `991c7e0b55df92f53ae3170e7215c6c5fb96cc50` 的 [完整独立 R3](reviews/2026-11-11-24-training-r3.md) 已通过，Standards / Spec 均 0；R1 四项与 R2 普通助手 P2 全部解决。独立完整离线 334 项中 332 通过、2 条件跳过，类型、区间 diff 与额外正向普通助手 calculate→prepare→apply 探针通过。[精确候选双平台 CI](https://github.com/VincentChen0111/maa_skills/actions/runs/42928351175) 均 success。R1/R2 FAIL 及所有旧证据保留，下文未完成措辞均属于所标历史候选。

固定远程 991 的双宿主原生安装与实际 CLI 合成预入驻验证通过，目录 `.tmp/native-check-tMXbRu`：38 条命令中仅重复安装和两宿主重复 apply 的 3 条预期拒绝为非零。31 个 Codex / 216 个 Claude 仓库文件共 247 个逐字节匹配 Git；655 个生成依赖另核 hash/lock metadata，未核 registry 包原始字节。四份验证源在运行前冻结，实际导入冻结 smoke。query（原 fixture 2400 秒）、只读 prepare/read、批准 apply、单次槽与资产/配置/pending 读回、备份、锁释放、重复拒绝和正常关闭通过，相关临时进程残留 0。普通助手 3429 秒的正向应用来自独立公开探针，不冒称原生 smoke 覆盖该变体。

最终两批改后真实模型尝试 `.tmp/24-r3-model-evidence/frozen-models-VC1u4t`（28）与 `.tmp/24-r3-integration-model-evidence/frozen-models-I3793M`（22）全部 unverified，25 Codex 401 / 25 Claude 未登录，0 完成事件或 runner failure。与原两批改前 42 份保持冻结框架、CLI、模型和场景指纹；42 对比较仍 unverified，8 次训练场景仅是新基线尝试。R3 独立核对最终前后 92 份原始记录、manifest/Git 字节、评分和清理，根相关进程记录为 0。

旧 fd1 改后 50 份和中断 Rbw9G1 的 1 份原始记录保留；历史累计 142 份完整批次实际记录（71 Codex 401 / 71 Claude 未登录）加 1 份中断 Codex 401，143 个唯一 ID 已独立核对。原中断 batch 全零及空 run 目录不改写，不补造完整批次。成功训练基线、daily/core/doctor/stage 真实语义和分数不降仍由 [26](issues/26-v0-1-0-release-validation.md) 硬阻塞发布；真实 MAA/游戏、六分钟实效、速度/减时叠加和换人身份均未验证。

24 单票有条件实现交付的产品与证据前提已满足；[PR43](https://github.com/VincentChen0111/maa_skills/pull/43) 待最终文档提交 CI 后 squash。本次只登记验收，不改产品，最终文档 head 另核 CI。原生单次槽无日期 TTL、离线没有常驻清理，维护失败仍可能留到次日，这些边界保持。

## R2 修复候选，待完整 R3

[完整独立 R2](reviews/2026-11-11-24-training-r2.md) 对 `fd1aa07f1b52f3d02e6fae6af9e5f284f6280a24` 的结论为 FAIL：Standards 0 / Spec 1 P2，普通可用助手因没有训练室技能而被遗漏。根代理接受并完成本轮测试先行修复：以完整已持有候选为起点，在每个候选内筛训练技能；资料完整且没有额外训练加成的助手计基础 5%，3600 秒为 3429 秒。缺条目或有效结构中的残缺/未知资料仍待核，非法表结构仍沿用共享查询的输入拒绝，不扩大为自动容错。原生/CLI 参数和冻结场景未变，R1 状态/归属/形态与 06/15 writer 边界未改。

新增 `training-assistants.test.ts` 六组公开计算/真实 prepare 接缝测试：普通、明确空技能、锁定及已生效技能；十种缺失或未知事实；八种非法表结构；其他房间解锁未知；可用性/持有/受训者排除；其他房间技能不混算。最初红测 `.tmp/24-r2-assistants-red.log` 为 1 pass / 4 fail，最终与既有时长测试共 11/11 通过。补充结构探针曾把“必须返回 unknown 对象”误作期望而 4 pass / 1 fail，根明确维持既有 `base-data-invalid` 拒绝语义后改为拒绝断言；没有因此改 21 查询行为或添加局部容错。原日志 `.tmp/24-r2-assistants-structure-red.log` 保留。

修后最终完整离线入口 `.tmp/24-r2-check-final.log` exit 0：334 total / 332 pass / 0 fail / 2 条件 skip；tracker/privacy/metadata 无错误，7 rules / 14 samples 通过。`npm run typecheck` 与 main `3ff4555` 到候选 diff-check 通过。此前受限入口 333 total / 311 pass / 20 fail / 2 skip 为 junction、GUI 和 loopback 限制，`.tmp/24-r2-check-sandbox.log` 原样保留；之后只新增非法结构拒绝负例，不靠产品修改消除权限失败。类型检查发现新增测试给推断 number 字段直接赋 null，改用合成局部 Object.assign 后通过，产品类型未放宽。

本轮逐文件核对训练计算、base-query 的纯字典判断导出、新测试、接口/规格双表、来源/验证/工单与完整 R2 报告；均为合成账号、公共固定来源及实际证据摘要，无真实账号或私人环境数据。R1/R2 原文完整保留。原四训练场景和 training-data 对冻结 6a0ba41 无差异，scripts/eval/fixtures 及 writer/state/plan/config 对 fd1 无差异。root 将对修后固定候选重跑原生与两批改后模型，由同一独立 R2 审查员完成 R3；尚未写修后通过，不勾工单完成。

## fd1 的 R2 外部验证（历史）

R2 独立离线 328 total / 326 pass / 2 skip、类型、区间 diff-check 均通过；[固定 fd1 双平台 CI](https://github.com/VincentChen0111/maa_skills/actions/runs/42925737520) Windows / Ubuntu success。其唯一 P2 不属于认证延期，故旧检查成功不能代表产品复核通过。

固定原生 `.tmp/native-check-WYp7ty` 的 38 份实际命令经 R2 独立审计，预期重复安装和两宿主重复 apply 拒绝共三条非零，其余成功。245 个仓库文件匹配 fd1（Codex 31 / Claude 214），655 个生成依赖 hash 复核，未核 registry 包字节；四份运行前冻结验证源一致。两宿主安装 CLI 的 query、只读 prepare/read、批准预入驻 apply、资产及配置读回、重复拒绝、正常关闭通过；相关进程残留 0 是根实际记录，非审查员独立枚举。未执行真实 MAA/游戏训练。

R2 独立审计四个完整批次共 92 个唯一真实模型记录，全部 unverified（46 Codex 401 / 46 Claude 未登录），0 完成/runner failure：旧 daily/core before skcOqN 20，fd1 after qjycSg 28（含 training 新基线尝试 8），整合 doctor/stage before GhliUO 22、fd1 after BfJ7Tr 22。两套冻结框架、42 对场景/CLI/模型身份及载荷均核对一致；没有成功基线或分数不降结论。中断 Rbw9G1 的 1 份 Codex 401 另核，原 2237 字节全零 batch 与空运行目录情况不改写，不称完整批次。所有路径/指纹/核对界限见 R2。以上旧成功及未验证证据保留，不能替代修后候选验收。

## fd1 整合与作者记录（历史）

已将原 `6a0ba41` 实现和 `151c76c` 的全部 R1 修复重放到实际 main `3ff455595c4a3dc68817151a5e82f26dfb420c7a`（含 06 与 15）。保留 06 严格事务 schema、恢复锁与未知附加资产拒绝；15 的三次双资产核对及作业配置范围不变。训练资产仍只在统一 writer 持锁且关停后安装，重开后同时校验引用和内容。CLI、原生 smoke 输入和训练 fixture 未改，R1 的状态/归属/形态实现逐文件与 151c 比较相同。

本次新增 `training-integration.test.ts` 先红后绿：机械合并时合法 jobPlan 夹带 medicineCount 仍被接受，原始红测 `.tmp/24-integration-red.log` 为 1 pass / 1 fail；明确三种窄授权互斥后为 2 pass。另一个公开接缝用真实子进程产生重启失败的训练事务，进程退出后 doctor 仍判 stale / unknown，点名 restore 和 reconcile 都拒绝，配置与原锁逐字节保留。测试只替代 MAA 进程，不 mock 文件系统、时间或内部函数；互斥选择同步规格两张来源表。

最终完整 `node scripts/check.ts` 正常权限退出 0：328 tests / 326 pass / 0 fail / 2 skip，tracker/privacy/metadata 空错误，7 rules / 14 samples 通过；类型检查通过。跳过项为本机没有 Windows 8.3 别名、当前 Windows 不适用非 Windows 适配器。受限环境的首次完整入口为 172 pass / 155 fail / 1 skip，包含临时文件 rename EPERM、junction、GUI 与 loopback 限制，原日志 `.tmp/24-integrated-check-sandbox.log` 保留；正常权限第一次产品测试已为 326 pass / 2 skip，但新增类型注解触发隐私启发式误报，所以该入口仍是 exit 1。仅改为等价 Pick 类型后，最终入口 `.tmp/24-integrated-check-final.log` 才 exit 0，没有改产品掩盖环境或检查失败。`npm run typecheck`、隐私、metadata、tracker 和实际 main 到候选的 diff-check 均通过。

公开前保留原作者/R1 的全包逐文件检查，本次再检查共享 writer、skill 合并、规格两表、工单/来源/验证和新增合成集成测试；没有真实账号、私人路径或原始设备日志进入新增内容。INDEX 仅由 tracker 重新生成。15 当前状态同步为 PR41 实际 squash 和最终文档 CI，不改写 R1–R3 历史失败。

根任务已报告新增整合回归改前批次 `.tmp/24-integration-before-evidence/frozen-models-GhliUO`：固定框架/载荷 3ff4555、框架 hash `3fee12fdc597846e813a230624aef7fcee5b67132fbef817205c89329910deed`，doctor 10 + stage 12 共 22 次实际尝试全部 unverified（11 Codex 401 / 11 Claude 未登录），0 完成/runner failure/残留；本整合工作者未重跑模型。旧 daily/core 20 次仍保留；另一个中断批次 Rbw9G1 只核验 1 份 Codex 401，原始损坏 batch 和空运行目录情况另记，不能称为完整 23 次批次。最终候选完整 R2、双平台 CI、固定原生正向 apply 与改后模型/新基线仍由根任务完成，本票保持进行中。

## 原作者与 R1 历史

基点 `ddd0ca80a3367b589866efde73aa1c0205732c3a`，作者验证日期 2026-11-11。候选独立审查、真模型与固定远程载荷原生安装尚待根代理执行；本记录不把这些项记为通过。

## 作者证据

脚本行为先在公开函数或真实 CLI 接缝出现失败，再实施：计算模块/CLI 缺失、五小时条件、开训后助手建议、确认后待观察、矛盾/未来/倒序证据、材料刷新、过期槽、实例日志绑定、受训者未找到和安装 smoke 分别保留过红测。测试使用真实临时 FS，替代的边界只有 MAA；公开查询的离线表标为未验证。没有替代时钟、文件系统或内部函数来伪造完成。

| 验收 | 作者验证位置 |
| --- | --- |
| 明确目标、技能、档次和材料；成本复用 | `training-time.test.ts`、`training-plan.test.ts` 的准备/逐档刷新/变更目标拒绝 |
| CLI、Markdown、语言、持有与有效技能、条件和后续助手 | `training-time.test.ts` 的普通/未解锁/档次/分支/五小时/心情与换人估算 |
| 真实开训、慢刷新、延迟完成、手动训练不重放 | `training-state.test.ts` 的确认+倒计时、观察续接、完成升级；任务成功单独不足 |
| 目标已满足矛盾、目标确实满足、两次执行间隔六分钟 | `training-state.test.ts`；实际预入驻完成时间锚定，不按最初定时时间推断 |
| 未找到受训者、实际助手未知、换人前倒计时不能作换人后证据 | `training-state.test.ts` 的原生负回调和变更后重新观察 |
| 统一事务、关停与重启资产漂移、不可变文件和 GUI 引用读回 | `training-config.test.ts`；已有配置通用窗口/确认/锁/安全测试继续运行 |
| 已过期自有单次槽清理、改变/每日槽不动、重复 apply 拒绝 | `training-plan.test.ts`；离线未运行时无自动清理承诺 |
| 候选安装接缝、四场景实际 CLI 和输入不变 | `training-smoke.test.ts`、`training-evaluation.test.ts` |

完整离线入口首次 218 个测试（217 通过、1 个平台跳过、0 失败）；隐私检查发现两处普通授权变量/接口紧凑排版误报，改为单独声明/标准空格后检查通过。最终自查补关闭确认后可继续、跨阶段绑定及预入驻到开训的公开接缝测试，最终完整入口 **220 个测试，219 通过、1 个平台跳过、0 失败**；类型、tracker、隐私、元数据和七规则十四记录全部通过。Windows 沙箱下的原子 rename 曾得到 EPERM；同一合成临时测试在允许正常文件替换的测试运行中通过，未修改产品来掩盖失败。

人工逐文件检查新增四个产品脚本、共享写入器 diff、技能/接口、四类合成测试和夹具、评测场景、安装 smoke、来源/规格/工单记录。没有个人名册、真实路径、账号标识、凭据或原始 MAA 日志；源文件中的设备 uuid 不输出，仅对日志行计算去重 hash。公开源链接固定，未复制游戏表或 AGPL 代码。

## 模型场景与安装

旧 daily/core 载荷在改 skill 前按基点冻结到本地忽略目录；归档 SHA-256 为 `f78f80fc4fac234a6c6aa5500229e1ab59bb56aa10a75c0833775cd74d6f5c31`。评测运行器未修改。以同一最终运行器复测旧 daily 七场景和候选七场景；新增 [training-scenarios.ts](../eval/maa-daily/training-scenarios.ts) 四场景建立候选基线：已生效助手、可用事实未知、材料不足、目标满足矛盾。场景只读，要求真实成功的 CLI invocation；语义仍由真模型记录核对，不能用离线完成标志替代模型完成。新训练写事务由公开 API/真实 FS 测试覆盖，当前模型场景不声称覆盖多文件事务执行。

根代理完成固定远程载荷原生安装后，从仓库运行：

```text
node scripts/training-smoke.ts <临时安装后的maa-core目录>
```

它新建合成 home、快照、MAA 样例，运行安装位置的 query、prepare、read 三个 CLI，核对 2400 秒估算和 pending 记录后清理。没有 apply、设备操作、模型调用或真实 MAA 启动。两宿主布局分别运行该命令；工具测试不替代远程原生安装证据。

## 未验证与风险

六分钟故障防护、游戏速度叠加/减时实效、真实设备流程与助手身份未实机验证；官方回调缺少变更后助手身份。原生单次槽没有日期/TTL，离线时可能次日重触发；重新进入会尝试清理，维护失败必须报告未清理。动态阵营/特殊即时完成技能保持待核，不从 MAA 评分猜数值。

现有任务/空闲槽缺失等待 GUI 补齐。未知配置锁、记录锁、未识别训练 manifest 保留证据，06 恢复不能宣称附加资产恢复。06/15/24 主线整合后还需完整复验同一写入器的恢复与互斥授权。独立审查记录由根代理提供，未收到结论前工单保持进行中。

## R1 集中修复与交付门禁

[独立 R1 原文及处置](reviews/2026-11-11-24-training-r1.md) 保留对 `6a0ba41` 的四项 FAIL（1 P1、3 P2）。根代理全部接受；作者测试先行修复手动档次标志、完成观察时序、patchChars 身份，以及完整原生任务归属。来源补核 Assistant append_task/任务 ID、Logger Px/Tx 和两种序列化参数；旧的孤立完成消息与无归属 completedAt 不再赋予执行资格。四个冻结模型场景及训练数据输入保持不变，新日志夹具单列。CLI 请求格式不变，reconcile 需要更完整的本动作 Core 日志。

修复后完整离线入口 227 tests：226 pass、1 平台 skip、0 fail；类型、tracker、隐私、元数据和七规则十四样例通过。追加公开接缝覆盖手动 M1 实际完成→材料刷新→M2 配置，及无关 Infrast 完成→清理原槽→材料刷新拒绝→apply 拒绝。原候选的区间 diff-check EOF 失败如实保留；删除多余空行后按固定基点到修复提交检查，不能把干净工作树检查冒作区间证明。候选仍待最终整合 R2，不提前勾完成。

2026-11-11 根代理依据维护者授权自行判断推进事项，对 24 单独作出有条件决定，不继承 06/15，也不称维护者明确免测：只有隔离认证不可用可延期模型发布验收；须 R1 四项修复、最终整合完整独立复核、离线/类型、双平台 CI、固定双宿主原生正向排程与资产/配置读回、完整实际模型前后和新增尝试留存后才交付实现。根报告原始旧载荷 20 次模型尝试全 unverified（10 次 Codex 401、10 次 Claude 未登录），作者未重跑模型，也不把它记为成功或分数不降。

四训练场景成功基线、受影响 daily/core 和后续整合新增回归、明确目标/材料/助手/实际开训完成/单次槽/防重放的真实语义及分数不降仍由 [26](issues/26-v0-1-0-release-validation.md) 硬阻塞发布。实际完成的模型失败/回归不得改 unverified 或自动延期；pass→fail 按规则单独重跑三次。真实设备、六分钟实效、公式及助手身份另保持未验证。
