# daily 验证记录

工单 05 的实现验收已完成，经 [PR #35](https://github.com/VincentChen0111/maa_skills/pull/35) 待 squash 交付。完整产品 R5 对 `818778ed2e74c859be8119ecab591e24a797951a` 通过，Standards／Spec 均 0 项真实错误；独立完整检查 197 通过、1 跳过，组合探针 7/7，类型检查通过。该候选双平台 CI 通过（run 42903229148）。原生安装实际源为产品相同的 `57002b5`，审查员核对 19＋166 个仓库文件及生成依赖证据。详见 [R5 报告](reviews/2026-11-11-05-daily-r5.md)。真实模型、实机与跨版本升级仍未验证，下方保留历史记录。

2026-11-11 当前交付安排：维护者已批准 R5。根代理依据其自行判断推进问题的授权及复核通过后继续实施的要求，单独决定在独立产品复核、离线/类型、双平台 CI 与固定载荷双宿主原生安装通过后交付 05 实现；七个 daily 场景的真实基线、语义及分数不降仍为 [26 发布硬门禁](issues/26-v0-1-0-release-validation.md)。这是本票的延期决定，未把模型未完成改记为通过；下文保留各阶段历史条件和原始证据结论。

## 起点和来源

维护者原有 maa-daily 的通用关停、备份、最小修改、重开及白名单读回流程是起点。重新实现事务工具，未移入个人路径、账号数据、默认队列或私人授权，未修改原安装。原起点的私人保留项与较长定时缓冲不作为通用规则。

MAA 固定在官方 v6.21.4，提交 `52d0b2acaca116585b02e1e6a9da303460f81a24`；以下仅核对字段和行为，不复制或打包 MAA 代码。MAA 为 AGPL，原代码只下载到被忽略的临时目录：

- [Timer.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Global/Timer.cs) 与 [TimerSettings.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Global/TimerSettings.cs)：定时字段、八槽由 GUI 使用，null 表示单次。
- [TaskQueueViewModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/TaskQueueViewModel.cs#L1080)：本机本地时间；定时前两分钟配置切换，午夜跨日；触发后 null 置为 false。
- [FightTask.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/MaaTask/FightTask.cs) 与 [AwardTask.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/MaaTask/AwardTask.cs)：药剂、源石、免费抽卡与特殊礼包字段，按类型白名单独立实现。
- [BaseTask.cs 第 24–41 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/MaaTask/BaseTask.cs#L24) 用 JsonDerivedType 声明运行模型的 `$type`；[TolerantEnumConverter.cs 第 85–92 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Converter/TolerantEnumConverter.cs#L85) 接受合法枚举标签，未将不一致 TaskType 改成运行模型。摘要与写入据两字段的已核对应关系识别，未知激活、药剂及整队重排拒绝；这是独立实现的保守范围。
- [ConfigFactory.cs 第 64 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Factory/ConfigFactory.cs#L64) 保存时省略 null；[Timer.cs 第 22–29 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Global/Timer.cs#L22) 的 JsonConstructor 接收 nullable isEnabled，省略参数为 null 并覆盖属性初值。仅这个字段在维护窗口、药剂次数、关停目标绑定与重开读回中按省略/null 等价；revision 和备份保留原始数据，其他缺失字段仍拒绝或保留 unknown。
- [Bootstrapper.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Bootstrapper.cs#L525) 与 [AsstProxy.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Main/AsstProxy.cs#L757)：原生参数跳过自动连接目标启动与 LinkStart，避免维护后自动开任务；不修改保存设置。

这不是完整 MAA 版本的「源码已核」认证；依赖清单和自动指纹跟踪仍由 25 交付。其它版本可检查，但未核字段和进程状态不能猜测为安全。

## 测试与未验证项

在 CLI/导出函数接缝先看到失败，再实现：配置最小改动、并发锁、遗留锁、药剂数量、队列重排、定时全窗口/午夜、失败阶段与记录、公开输出脱敏。进程边界用真实临时 Node 进程和由合成 C# 源码编译的临时 Windows GUI；不启动真实 MAA 或设备。

2026-11-11 修复第三轮已知问题后，完整离线入口 70 项：69 通过、1 项非 Windows 专用测试跳过；类型、隐私、元数据与工单检查通过。含从真实临时设置，经 CLI 到原生 PowerShell 关停/启动合成 Windows GUI 的全链验证，以及版本/目标及依赖绑定、重开后依赖读回、重复任务排序、药剂整数范围和跨配置总量/触发次数、夏令时回拨前两分钟和重复触发时刻的校验。两宿主真实 installer 证据仍待填写，产品独立审查最终未通过，见下节。

模型尝试固定 Codex 0.167.0-alpha.3.2 / gpt-6、Claude Code 2.1.322 / claude-sonnet-4-6。初次六项均因隔离认证缺失为 unverified；当时并行编辑共享载荷，整体指纹不一致，比较器正确判为 incomparable，该批不用于基线比较。后续评测先冻结待测 skill 和 companion 副本，避免运行中源文件变化。原始证据只保存在被忽略的本机临时目录。

冻结后的六项指纹均为 `9613f4b398cbbe69e4d5bfc31d6a78ff31a88c01eb8e0f4610739b3ac3970626`，每项仍为 unverified，比较器结果为 unverified。没有通过分数，不能据此声称改动后模型行为无回归。两个原生目录各保留本仓库 MIT 全文。

第一轮审查修复后，另冻结载荷并按相同三场景、模型、宿主和评分器运行六次；载荷指纹一致为 `b84318e4bfce1d3d20a4336ec64f6da9f68f70b040c527943be6ae28b409d9aa`。前后 scenarioHash 一致，六项仍全部因隔离认证缺失为 unverified，前后比较也是 unverified。未产生 pass→fail，不能将认证失败写成模型回归通过。

第二轮修复后同样冻结重跑六次，载荷指纹 `3f6dee1a2876b3284769f487f647c2366c5359cbe66c051f85dec606d42b72d9`，前后场景指纹一致，仍全部 unverified；本批发生于第三轮审查修复前，不冒充最终载荷证据。

第三轮已知问题修复后、core 迁移前，六次固定场景仍全部 unverified，载荷指纹一致为 `19cb1f3f48366a1ccb49399d8e14357b5fd708a2410c2955782270343165ae94`。原始批次分别保留，不覆盖先前证据。

产品包已完成三轮独立审查，最终仍未通过，见 [审查与处置](reviews/2026-11-11-05-daily.md)。第三轮的两项已知错误已按失败测试修复，但未经追加独立审查；达到三轮上限后保持草稿，不自行将作者测试改记为审查通过，05 下游不解锁。

两宿主新 skill 模型基线未通过前，05 不记完成。原三个只读/拒绝场景之外，正向提醒、关闭确认、关停失败及重启失败的评测接缝现已补齐，验证范围见下节；真实模型仍未验证。真实 MAA 与设备未运行。

## 原生安装与 core 集成

在迁移前的公开固定提交 `23bebaeab946f4d9b48ab0b50c98dba022c972d3`，官方 Codex installer 的首次安装、已有目录拒绝及临时目录内重装通过；Claude Code 2.1.322 的市场安装、市场更新和同版本插件更新入口通过，安装记录 SHA 与固定提交一致。两宿主 help/daily 各 11 个文件逐字节 hash 相同，MIT 全文齐全；实际安装载荷执行 read→expectedRevision→write，验证原值保留、备份、锁释放、合成 GUI ready 与正常关停。23 个主命令中 22 个退出 0，唯一退出 1 是预期的已有目录拒绝。使用 Node 24.22.1、Python 3.12.14，全在新的临时 home 内，不代表跨版本升级、模型基线或产品审查通过。

随后主分支 PR #34 将共享脚本改放 maa-core，并修订 help 为纯文字。05 合并该主分支，保留新的偏好锁、建议报告单轮审查、专精规则及发布依赖；配置和进程脚本原样迁至 maa-core，daily 和场景按同版本相邻 core 调用。新路径测试先失败再迁移。旧安装和模型证据只证明迁移前提交；迁移后的安装及评测需重新核对，不能沿用旧结果。集成包审查范围与产品未通过状态见 [core 集成记录](reviews/2026-11-11-05-core-integration.md)。

core 集成后完整离线入口 75 项：74 通过、1 项平台条件跳过；类型、隐私、元数据、tracker 通过。固定原三场景与两宿主再运行六次，载荷指纹一致为 `d22306045b35396424bbfcb232cae5244dfb803f85afeaada074fa2912f3e0c5`，仍全部 unverified。预期调用路径已变为 core，场景指纹也随之改变，不将跨迁移结果宣称为同场景回归通过。

迁移后的公开固定提交 `b7ebc18ee837438a4eb9e2174db3eee3cc70a321` 已重新通过官方原生安装验收：Codex 安装 core/help/daily、预期已有目标拒绝及限定临时目录重装；Claude 市场安装/更新和同版插件更新，安装记录 SHA 精确一致。两宿主各 13 个载荷文件与该提交逐字节一致，三个目录 MIT 齐全，help 无 scripts；从实际 daily 相邻 core 入口完成 read→revision→write，备份、原值保留、锁释放、合成 GUI ready 与正常关停全部通过。原始命令和 hash 保存在本机忽略目录，不发布私有环境路径；本结果仍不替代模型、实机或原产品审查门禁。
## 提醒事务评测支持

独立评测支持包在产品候选 `b7ebc18ee837438a4eb9e2174db3eee3cc70a321` 上补齐四个事务场景；产品及 skill 文件保持原样。仅替代 MAA 进程边界，实际 core CLI 产生真实锁、配置、备份和 JSONL，观察器核对 UUID/PID、实际时间窗口、精确内容与完整事务顺序。双宿主临时布局中的八条事务调用通过；伪造通用事件、无实际调用、记录/备份被删改或追加、额外文件及 unknown 后重复写入都不能通过。[接口与信任范围](daily-evaluation.md)说明该接缝不代表原生进程或真实模型通过。

2026-11-11，评测支持第一轮发现跨序列时序缺口；反例先复现评分误通过，修复后拒绝迟重启、缺就绪和缺状态检查。最终完整离线入口 84 项：83 通过、1 项平台条件跳过；类型、privacy、metadata、tracker 与规则自检通过。第二轮独立审查通过，审查员另验 22/22 及十四份模型证据，详见[审查记录](reviews/2026-11-11-05-evaluation.md)。此结论不覆盖产品包三轮未通过结论。

冻结实际 daily 与 maa-core 后，七场景 × 两宿主共十四次真实调用均为 `unverified`：Codex `0.167.0-alpha.3.2` / `gpt-6` 返回隔离认证 401，Claude Code `2.1.322` / `claude-sonnet-4-6` 未登录；没有复制调用者认证。载荷指纹一致为 `24f61c51a259f4ca23fa3375542df007e9fb343d8f3cb146ddf829caf6d12f45`。十四份执行窗口、evidenceHash、宿主版本与新增场景模式均核对，比较器为 `unverified`。新观察/评分语义改变场景指纹，旧批次原样保留，不作同语义回归通过声明。原始记录只留在本机忽略目录。

## 最终组合验证

`da971896d476310289ac6017b9345595446cf637` 合入已完成的 11、共享 core 和已审评测支持。完整离线入口 96 项中 95 通过、1 项平台跳过，类型、隐私、tracker 与 metadata 通过；同一提交的 Windows/Ubuntu CI 均通过。集成包独立 R1 通过，范围不含原产品审查的追加复核。

最终组合从公开固定提交再执行官方两宿主原生安装、预期重复拒绝、限定临时重装和 Claude 同版更新；两个宿主 core/help/daily 各 14 文件的字节 hash 与源提交一致。core 保留根 MIT 及账号解析来源的 nhyo 版权行；合成配置事务、备份、锁释放、ready 与正常关停通过。首次验收脚本错误假定所有目录许可证均与根文件完全相同，因合法新增版权行失败；改为核对各目录自己的固定源许可证并检查 nhyo 行后重跑通过，保留失败记录，没有删除产品版权。

最终组合冻结后的七场景 × 两宿主十四次模型调用仍全部 `unverified`，载荷指纹 `4070bb7792233d03926ca64bbc216659cebac349f43bb1c462c0f846e54b1da0`；执行窗口、证据 hash 与隔离认证失败均核对。没有模型通过分数，未使用用户认证。原生测试准备一次只读 CIM 设施后验证产品 5 秒预算；新 CI 通过不证明旧超时根因或冷启动性能。真实 MAA/设备仍未运行。

## R4 作者修复验证

维护者批准的额外第四轮复核确认任务运行类型和 nullable 定时字段两项问题，结论仍未通过。本次在基点 `7c7fa2b92fbc76401a941789e267efdd0bb2fa5c` 的独立工作树按公开导出函数/CLI 接缝修复；以下是作者测试，不是第五轮独立审查，不解除 05 下游依赖。

任务类型的六个写入反例原先全部返回 complete，包括登录伪装、未知/缺失 `$type`、伪装 Fight 的药剂修改、停用异常条目重排和定时消费绕过；修复后在进程访问、锁和写入之前拒绝。摘要的四种未知/不一致情况显示 OtherTask。定时测试先复现直接设单次、改槽时间和整个 Timers 依赖读回失败，并覆盖原始缺省与关闭时省略、窗口及药剂次数；修复后等价变化通过。true/false、时分、目标配置和其他 null 字段丢失的十二个漂移用例仍保留 unknown 和锁，原始 revision 与备份保护未放宽。

配置测试 59/59；最终完整离线入口一次运行，128 项中 127 通过、1 项平台跳过，含原生合成 GUI 和 CLI 事务。类型检查、tracker、隐私、metadata、评分规则自检及 diff 检查通过；逐文件人工检查仅含合成账号标记与官方固定来源，没有真实 MAA/用户私有环境操作。

改前、改后分别冻结 daily/core，按同一七场景、模型和宿主各调用十四次：Codex `0.167.0-alpha.3.2` / `gpt-6`，Claude Code `2.1.322` / `claude-sonnet-4-6`。前后场景/框架指纹相同，二十八次均为认证相关的 `host-failed` / `unverified`，比较器同样 unverified，不能判定分数不下降。载荷指纹由 `f4f9d2571bbaa8054217c5082d08d952527aaab58d9ed3b5f0612150640db6c3` 变为 `bb087fcbe8b9ad6f7d2d957fd064b9c8d0c39eb0807eafe38c12f273f517c9ac`。原始 red/green、冻结载荷、宿主调用及比较证据保留在该工作树的忽略目录 `.tmp`，不复制用户认证。

## 修复与最新 main 的组合

公开固定候选 `43f6a2ad2d6746e0fe57e3f4c291816e847f68f2` 合入已完成 21 的 main；两项修复的产品、配置测试及 daily 配置说明与作者候选逐字节一致。重新运行离线入口，145 项中 144 通过、1 项平台跳过，类型、tracker、隐私、metadata 与评分自检通过。

该固定提交重新通过官方 Codex 安装、已有目录拒绝、临时重装及 Claude 市场安装/更新、同版本插件更新。两个宿主 core/help/daily 各 17 个载荷文件字节一致，许可证完整且保留 nhyo 行，help 无 scripts；安装后的真实 CLI 完成合成 GUI 事务、备份、读回、锁释放及正常关停。本结果不验证真实 MAA、跨版本升级或模型行为，也不替代 R4 后的独立复核。

同一 SHA 的 Windows/Ubuntu CI 均通过。组合冻结载荷指纹 `c65b0da1ffad0face74f1540689588713907351cb6ca6854b2760f96da7487a3` 的十四次固定模型调用仍全为 unverified；框架指纹 `92d070722d86776318a237ec1953435fea830822bf48876936a4daf793a50023` 保持不变，执行窗口、证据 hash、宿主版本和认证缺失逐项核对。旧批次已另存，本批不覆盖先前证据，也不声称分数不下降。

## 成本主线整合后的组合

`6a62525a31f4693385191607e0f98a0ffab509e7` 合入已交付 13 的 main `370ed688`，同时保留 daily 合成进程与成本网络评测支持；配置、进程及 daily 产品与前一候选无差异。完整检查 166 项中 165 通过、1 平台跳过，类型及两平台 CI 通过；[冲突整合独立 R1](reviews/2026-11-11-05-cost-integration.md) 通过，范围不覆盖未获授权的 05 产品 R5。

该固定 SHA 的双宿主官方安装重新完成，各 18 文件与 Git blob 逐字节一致；覆盖拒绝、临时同版重装/更新、实际安装的合成 GUI 事务、备份、记录及锁释放通过，并经独立核验。未验证跨版本升级、真实 MAA 或设备。

新框架指纹 `09ae0c10508d5472f448cb2c5aab234694cde500133ebfb750b23de45d752c98` 下冻结 daily/core 的十四次及 account/core 的二十二次调用已全部结束，固定 Codex CLI `0.167.0-alpha.3.2` / `gpt-6`、Claude `2.1.322` / `claude-sonnet-4-6`，均因隔离认证缺失为 unverified。两组载荷分别为 `a71828843c93619d9afbbd131624747de214bcfb957f15c0d0d082aa4fe6e0f0`、`1cbbef39e00e53325ce975a3453b05becfb40a0edd523e82fdba9763fc0a492c`，冻结内容与候选一致，仅有行尾差异。记录、原始输出 hash 与执行窗口均独立核对；旧批原样保留，新框架不冒称旧指纹可比或分数不下降。

## 加工缺口主线整合后的组合

`8d277ede5947c6a12dd7aec92e87fa371f0c4f47` 合入已交付 14 的 main `ac03ba8a`；05 配置、进程及 daily 产品保持不变，INDEX 由 tracker 生成。本机完整离线入口 196 项中 195 通过、1 平台跳过，类型与静态检查通过。Ubuntu CI 通过；Windows CI 的 busy 状态重检测试失败，194 通过、1 失败、1 跳过，原始日志已保留并单独诊断，尚不能记两平台通过。范围和最终结论见[加工整合审查](reviews/2026-11-11-05-crafting-integration.md)。

同一固定 SHA 的双宿主官方原生安装通过。Codex core/help/daily 的 19 文件与 Claude 的 164 个仓库来源文件均逐字节匹配；宿主另行生成的依赖目录与源码文件分开审计。24 条原生命令只有预期的重复目标拒绝退出 1；合成 GUI 事务、备份、记录、锁释放及正常关停通过。该证据不代表真实 MAA、跨版本升级或产品 R5 已通过。

新冻结载荷的 14 次 daily 与 30 次 account 模型尝试全部为 unverified。Codex 22 次观察到传输错误和无完成事件，未观察到 401；Claude 22 次明确未登录。前次共有记录中 daily 14 对和 account 14 对的宿主、模型、场景指纹一致，8 对成本场景指纹改变，另有 8 个新增 gap 记录。所有记录均无可用通过分数；原始证据和旧批次分别保留，不宣称基线或分数不降已验证。

## 未来状态记录的作者修复

后续隔离诊断确认一个可复现机制：当前会话的状态日志略晚于读取方当前时间时，旧实现跳过该行后仍沿用先前的空闲状态。原 Windows CI 没有保留足够现场证据，不能断言这是该次失败的唯一根因。公开接缝先复现未来忙碌记录仍允许关闭，再修复为时间未确认时不保留 ready/idle；完整过程见[诊断记录](diagnostics/2026-11-11-05-future-process-state.md)。

根分支固定候选 `57002b59fb38b342ee7cb29b6b07347594add66f` 的 `node scripts/check.ts` 为 198 项中 197 通过、1 平台跳过；`npm run typecheck`、隐私、tracker、元数据与评分自检通过。同一候选的 [Windows CI](https://github.com/VincentChen0111/maa_skills/actions/runs/42896618239/job/130111285698) 和 [Ubuntu CI](https://github.com/VincentChen0111/maa_skills/actions/runs/42896618239/job/130111284620) 均通过；原 8d 候选的失败记录原样保留。

该 SHA 重新完成两宿主官方隔离安装及同版重装/更新，24 条命令只有预期的重复目标拒绝退出 1。Codex 19 个技能文件、Claude 166 个仓库来源文件与 Git blob 逐字节一致；655 个宿主生成依赖文件另列 hash 并核固定 lock 元数据，不冒称来自 Git。许可证、实际安装的合成 GUI 事务、备份、锁释放与正常关闭通过，无本次遗留进程。

冻结修复后的 daily/core 再运行 14 次真实模型调用。前后固定 CLI、模型、框架及 14 对场景指纹均相同；框架仍为 `bd8c6fb7a4a675541d98d730c7f3d6fe21c83567d212960c0f46066e39077620`，新载荷为 `e61d176a7032ae4af376aa5446c274ef9017b9b279400c74f3c73f34d71229c2`，16 文件与固定源码仅有行尾差异。Codex 七次均传输失败且无完成事件、未观察 401，Claude 七次均明确未登录；全部 unverified，前后比较也是 unverified，无可判定的分数不降结论。

本批 runner 在最后一次调用已持久化完整证据后，因 finally 清理临时目录遇到 EBUSY 而退出 1，原汇总仅 13 条，不能写成 runner 全程成功。保留该汇总和错误，核对第十四次原始记录、证据 hash、实际窗口及调用目录后另存恢复的 14 条汇总，没有模型重试。恢复汇总 SHA-256 为 `fbab7efcc716fae286321d2c2de324dffd6ecebb6f6c5a83ed8e2877548d958a`；清理单独完成，临时夹具和本次宿主进程均已退出。所有模型 grade 保持真实结果。

这是作者修复及执行证据；8d 的狭义整合审查不覆盖本次进程修改。产品 R4 未通过、追加产品复核未授权的状态不变，仍不合并 05 或解锁其下游。真实 MAA/设备、跨版本升级和真实模型行为仍未验证。

## 27 批准后的碎石与临期药

2026-11-14，工单 27 的作者验证，未经独立审查。分支 `claude/27-stone-expiring-medicine`，叠在 28 的 `d2b0edf` 上。

### 实现

一次授权能放开什么，只由 `skills/maa-core/scripts/consumption-grant.ts` 导出的 `decideConsumption` 决定：输入是请求的授权和目标任务的最终设置（被改动的任务另带改动前的设置，标明是否被启用、是否计入数量、单次定时次数和是否挂在每日重复的定时上），输出是允许或拒绝、静态原因码，以及每个目标的理智药、碎石、临期药状态分类。调用点各带一个登记的消费者名：

| 消费者 | 位置 | 做什么 |
| --- | --- | --- |
| `writer-whitelist` | `maa-config.ts` 的 `prepare` | 校验授权取值与组合；对改动了消耗字段的 Fight 任务，核对被改动的那几类 |
| `indirect-consumption` | 同上 | 启用任务、重排或改定时会运行到的任务：核对全部开着的消耗，Award 的免费抽卡和特殊礼包在任何授权下都拒绝；带专精计划时给出两个专用原因码 |
| `quantity-budget` | 同上 | 理智药和碎石的总量：每个任务的数量乘以所属配置的单次定时次数（明确分配至少计一次），跨配置求和；有限数量不能挂在每日重复的定时上 |
| `pending-record` | `maa-config.ts` 的 `transactionPending` | 待执行记录的授权字段严格校验 |
| `doctor-recovery` | `maa-config.ts` 的 `executeConfigRecovery` | 修复请求自己带的授权；恢复会重新打开消耗时由写入器按这份授权核对，原事务授权不复用 |
| `read-summary` | `maa-config.ts` 的 `inspectConfiguration` | 类型已核的 Fight 任务的消耗状态 |
| `eval-grader` | `scripts/evaluation.ts` 的禁止设置规则 | MAA 配置差异按场景声明的 `consumptionGrant` 判定 |

`tests/consumption-grant.test.ts` 按 grep 找出 `skills/`、`scripts/`、`eval/` 里每一处调用，要求每处在同一行写明消费者名，名单与登记表、样例表三者一致；每个消费者经自己的接缝（写入 CLI 导出函数、doctor 修复、恢复核对、读取摘要、评分函数）各跑一个放行和一个拒绝样例，并与谓词直接给出的结论对照。新增调用而不登记，或登记而没有样例，测试都会失败。

### 先红后绿

先提交谓词和一致性测试（`5159fdf`），写入器等消费者尚未接入。把这个提交用 `git archive` 导出到临时目录后运行 `node --test tests/consumption-grant.test.ts`：16 项中 14 项失败、2 项通过（两项通过的是评分规则的放行样例和待执行记录的拒绝样例：旧评分规则本来就不看 MAA 配置里的碎石，旧待执行记录本来就拒绝未知授权字段）。失败项包括登记表为空、写入器把批准的碎石拒绝为 `request-invalid`、摘要没有消耗状态、评分规则放过了没有授权的碎石。接入后的提交 `aca8f6e` 上同一测试 16 项全部通过。

### 固定 MAA 源码核实

固定提交 `52d0b2acaca116585b02e1e6a9da303460f81a24`（v6.21.4）。标「25」的行是本票依赖的 MAA 源码位置，交给工单 25 登记到它的依赖清单（25 在另一分支，本分支不改它的文件）。

| 采用的事实 | 文件与行 | blob | 登记 |
| --- | --- | --- | --- |
| `UseMedicine`、`UseStone` 是 `bool?`，`MedicineCount`、`StoneCount` 是 `int` | [FightTask.cs 第 35–50 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/MaaTask/FightTask.cs#L35-L50) | `c0a047df055c553410ef417ccf16a614f73337e0` | 25 |
| `UseExpiringMedicine`（bool）、`MedicineExpireDays`（int，默认 2）、`UseExpireMedicineForActivity`（bool） | 同一文件第 100–104 行 | 同上 | 25 |
| `UseStoneAllowSave`（bool，「允许保存碎石状态」） | 同一文件第 134 行 | 同上 | 25 |
| 读入配置后的 `OnDeserialized`：`UseStoneAllowSave` 为 false 时把 `UseStone` 置为 false | 同一文件第 154–159 行 | 同上 | 25 |
| 界面设置到 MaaCore 参数的换算：`medicine` 在 `UseMedicine` 不为 false 时取 `MedicineCount`，否则为 0；`stone` 同理取 `StoneCount`；`medicine_expire_days` 取「`UseExpiringMedicine` 时的 `MedicineExpireDays`」与「当前活动两天内结束且 `UseExpireMedicineForActivity` 时到鹰历周末的天数」两者的较大值 | [FightTaskUserControlModel.cs 第 1337–1361 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UserControl/TaskQueue/FightTaskUserControlModel.cs#L1337-L1361) | `426020545ea9de392c0bf3f0f80a3ca0f149f54b` | 25 |
| 界面打开碎石：保存开关没开时改存 null（不保存）；打开时把理智药数量设为 999，理智药没开就一起打开；关闭理智药时一起关闭碎石 | 同一文件第 379–437 行 | 同上 | 25 |
| 打开「允许使用源石保存状态」时弹出警告，图标用危险色，默认按钮是取消 | 同一文件第 1060–1083 行 | 同上 | 25 |
| 参数的 JSON 名是 `medicine`、`medicine_expire_days`、`stone` | [AsstFightTask.cs 第 37–50 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Models/AsstTasks/AsstFightTask.cs#L37-L50) | `883cc83738acd64bd8fd7c2b97e2c6b4380b0f00` | 25 |
| MaaCore 读入 `medicine`、`medicine_expire_days`（负数拒绝；旧参数 `expiring_medicine` 换算为 2 天）和 `stone` | [FightTask.cpp 第 70–89 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Interface/FightTask.cpp#L70-L89) | `7dfbdf4cfbfd9073407068b6b42d8a5f9da8b65e` | 25 |
| 次数上限：`MedicineConfirm` 为理智药数量，`ExpiringMedicineConfirm` 在天数大于 0 时为 9999，`StoneConfirm` 为碎石数量 | 同一文件第 171–177 行 | 同上 | 25 |
| 理智药插件只在识别到理智药页面（`UseMedicine`）时运行；理智药数量用完且临期天数为 0 时不用药直接返回；数量用完而临期天数大于 0 时去掉超过天数的药，只用临期的 | [MedicineCounterTaskPlugin.cpp 第 18–99 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Fight/MedicineCounterTaskPlugin.cpp#L18-L99) | `40bb203cd98acc4b53f31443ca4685e45eec5ff2` | 25 |
| 用药之后上报 `what` 为 `UseMedicine` 的消息，`details.count` 是这次用掉的瓶数（剩余数量一条的候选读取来源，尚未采用） | 同一文件第 177–200 行 | 同上 | 25 |
| 界面的临期天数范围 1–30；碎石数量 0–999；碎石开着时理智药开关和数量控件不可用 | [FightTaskUserControl.xaml 第 40–92 行、第 505–507 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Views/UserControl/TaskQueue/FightTaskUserControl.xaml#L505-L507) | `a42b1ce8012bff323fcd6b3c2dac47d6020678ea` | 25 |
| 点开始行动之后按页面识别：`UseMedicine`（理智药页面）、`UseStone`（源石页面）、`NoStone` 等 | [tasks.json 第 1310–1329 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/resource/tasks/tasks.json#L1310-L1329) | `9d4989f6994b1e3c66afb826835501fa5d499877` | 25 |
| `UseMedicine` 之后只接开始行动、离线确认和关闭恢复页面；整个任务链里没有把理智药页面切到源石页面的任务 | 同一文件第 1496–1502 行 | 同上 | 25 |
| `UseStone` 之后是 `StoneConfirm`，次数用完转到关闭恢复页面 | 同一文件第 1579–1604 行 | 同上 | 25 |
| `NoStone`、`CloseStonePage`、`CloseStonePageExceeded`：关闭恢复页面，最多两次，第三次结束作战 | 同一文件第 1605–1621 行 | 同上 | 25 |

核实第 10 条（MaaCore 在理智药数量用完之前是否会碎石）的结论：不会。MaaCore 不在理智药和源石之间选择，它按游戏当时显示的页面走：显示理智药页面时只走理智药插件，数量用完（且没有临期药天数）就不用药，关闭页面，重试两次后结束这次作战，不会转去源石页面；只有游戏显示源石页面时才执行 `StoneConfirm`，次数上限是碎石数量。游戏在背包里还有理智药时先显示理智药页面，这一点不在 MAA 源码里，是根据 MAA 界面打开碎石时把理智药数量设为 999 并锁住理智药控件推断的，未在实机核对。据此采用的规则（规格「默认值及其来源」2026-11-14）：写入器不要求碎石授权同时带理智药授权，两者各自是独立的上限；skill 在批准前告诉用户，背包里还有理智药时只批准碎石通常不会碎石。

### 设计默认值

产品限制都登记在规格两张来源表（2026-11-14）。只影响实现或评测、不构成产品限制的选择记在这里：

- 读取摘要的消耗状态格式：`medicine`（`on`、`count`）、`stone`（`on`、`count`、`allowSave`）、`expiring`（`on`、`days`、`activity`）；开关不是布尔值时 `on` 为 null，按开启处理（MAA 自己也把 null 当开启）。理由：用户要看到谓词实际怎样判断，才能知情批准。
- 写入器把已有的 `medicine-quantity-invalid` 换成谓词的 `consumption-grant-invalid`，授权取值校验只在谓词里做一次。理由：一个归属。
- 评测的写入器事务核对新增 `changeSet`（改动和变更键按集合比较）和 `consumption`（待执行记录必须恰好带这些消耗授权）。理由：碎石和临期药的字段由模型逐个写，顺序由模型决定；其他场景沿用按顺序的 `changes`。
- 评测运行器的指纹清单（`scripts/eval-batch.ts` 的 `runnerSources`）加入谓词文件，因为评分规则现在导入它；它是产品文件，计入 skill 版本，不进入场景指纹。

### 实际运行

（见本节末尾「运行结果」。）

### 未验证

- 真模型行为评测：改写诱饵的四个场景（`daily-forbidden`、`account-boundary`、`core-boundary`、`help-boundary`）和新增的五个场景（`daily-stone-approved`、`daily-expiring-approved`、`daily-consumable-unapproved`、`daily-consumable-existing`、`daily-quantity-rerun`）都没有运行，两个宿主的新基线和其余场景分数不降都留给工单 26。评分器文件改了，所有场景的指纹都会变，旧指纹的记录保留为历史。
- 真实 MAA 上的碎石和临期药没有执行；写入后 MAA 重开读入、实际碎石和用临期药的行为只按固定源码核对。
- 「游戏在背包里还有理智药时先显示理智药页面」是推断，未在实机核对。
- 日常队列运行用掉了多少理智药和碎石，目前没有工具读取，skill 按未知处理；`UseMedicine` 消息的 `details.count` 只登记为候选来源。
