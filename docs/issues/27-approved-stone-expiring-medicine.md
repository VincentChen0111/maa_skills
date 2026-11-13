# 27: 批准后的碎石与临期药

Type: task
Labels: task
Status: ready-for-agent
Assignee: unassigned
Parent: [maa_skills 规格](../spec.md)
GitHub Issue: [#44](https://github.com/VincentChen0111/maa_skills/issues/44)
Blocked by: [03: 双宿主行为评测](03-cross-host-evaluation.md), [05: daily 安全修改配置](05-daily-safe-config-write.md), [06: doctor 核对并恢复遗留写入](06-doctor-lock-recovery.md)

## 背景与目标

实施进度：已完成。

2026-11-14 交付：用户当次批准后的碎石与临期药，写入、启用、定时、数量预算、待执行记录、doctor 恢复、读取摘要和评分都经同一个谓词 `decideConsumption` 决定；没有授权时只能写关闭值，doctor 恢复可以把仍关着的一类改回事务前的值；[独立审查](../reviews/2026-11-14-27-stone-expiring-medicine.md)三轮，没有未解决的意见。[验证记录](../daily-verification.md)写明实际运行的检查和未验证项：真模型评测留给 26，真实 MAA 行为未核。

2026-11-13 维护者决定：碎石（用源石恢复理智）和临期药在用户批准后可用，原话见规格「默认值及其来源」。规格已按这一决定修订，但写入脚本、skill 正文、测试、评测场景和评分规则仍在执行旧规则：碎石和临期药一律拒绝。本票把这些地方一起改到新规则，改完之前规格里「由工单 27 交付，在此之前脚本仍然拒绝」的说法保持成立。

抽卡、礼包、付费、登录，以及碎石以外的源石用途，不在本票放开的范围内，继续在任何批准或偏好下拒绝。

2026-11-13 独立审查之后：验收第 2、3、4、8、11 条各有标明日期的修订或补充，新增第 20 条（剩余数量）；「决定」里补充一条、确认一条。这些都是设计默认值，已登记在规格两张来源表。

以下已完成工单的验收文字被 2026-11-13 的决定取代，原文作为当时交付的记录保留，不回改：

- [05](05-daily-safe-config-write.md) 验收第 6 条「拒绝打开源石、抽卡、礼包、付费、登录相关设置，偏好不能解除；理智药仅接受当次授权数量」：其中源石一项缩小为「碎石以外的源石用途」，并新增临期药。
- [06](06-doctor-lock-recovery.md) 验收里「禁止设置规则」和 [24](24-mastery-training-schedule.md) 验收里「安全限制」所指的范围，随本票的谓词变化。
- [03](03-cross-host-evaluation.md) 验收第 4 条的「禁止设置」评分规则，由本票修改。
- [11](11-maa-account-snapshot.md) 验收里「不编写新的图像识别」：规格已改为默认不写、必要时可以另加。这一条不由本票实现，记在这里只为说明原文已被取代。

## 要交付的行为

用户当次批准并给出碎石数量，或者当次批准临期药策略和临期天数之后，maa-daily 经统一写入脚本把对应设置写进 MAA 配置并读回核对；没有当次批准时，脚本、skill 和评分规则一致地拒绝。

## 规格依据

用户故事：37、38、53。涉及章节：MAA 配置写入；安全边界；测试决定；默认值及其来源。术语使用父规格关联的术语表。

## 验收条件

下面的文件位置和行号以基点 `05d4ebd` 为准，实现时按标识符重新定位。

- [x] 一个谓词、一个归属：`skills/maa-core/` 里只有一个导出的谓词决定「一次授权可以放开什么」，输入是授权和目标任务的最终设置，输出是允许或拒绝及静态原因。写入器的字段白名单、间接消耗检查、数量核对、待执行记录校验、doctor 恢复和读取摘要的状态分类都调用它，不各自重写判断；评分规则与它逐项对照。一个一致性测试枚举本票点名的每一个生产者和消费者，逐一断言它们的结论和谓词一致；新增消费者而没有登记时，这个测试失败。
- [x] 授权字段：`authorization` 增加碎石数量 `stoneCount`（整数，范围与 `medicineCount` 相同，服从已核的 MAA 32 位有符号整数）和临期药授权（临期天数 1–30，以及是否包含 `UseExpireMedicineForActivity` 的明确标记）。这两种授权和 `medicineCount` 一样，来源必须是 `current-request`；`approved-report` 和偏好原话不能授权。三种消耗授权可以出现在同一次请求里。`medicineCount` 和 `stoneCount` 与 `jobPlan`、`trainingPlan` 仍然互斥。2026-11-13 修订：临期药授权可以和 `jobPlan` 或 `trainingPlan` 出现在同一次请求里，它自己的来源仍然必须是 `current-request`，计划本身的来源规则不变，见「决定」；`setup` 的专用入口仍不接受任何消耗授权。
- [x] 字段白名单：有碎石授权时可以改 Fight 任务的 `UseStone`、`StoneCount`、`UseStoneAllowSave`，打开时 `UseStone` 和 `UseStoneAllowSave` 必须一起为 true，`StoneCount` 大于 0 且不超过授权数量；有临期药授权时可以改 `UseExpiringMedicine`、`MedicineExpireDays`（等于批准的天数），`UseExpireMedicineForActivity` 只在批准里点名时可以打开。2026-11-13 补充：把 `UseStone`、`UseStoneAllowSave`、`UseExpiringMedicine` 或 `UseExpireMedicineForActivity` 改为 false，只需要来源为 `current-request` 的普通当次请求，不需要数量或天数。其他字段的白名单不变，未知或缺失字段仍然停下核对，不猜测补键。
- [x] 间接消耗检查（`maa-config.ts` 的 `prepare` 里现在对 `UseStone`、`UseExpiringMedicine`、`UseExpireMedicineForActivity` 一律抛 `unsafe-task-settings` 的那一处，基点第 182 行）改为调用谓词：要启用的任务或定时，其 Fight 任务已经开着碎石或临期药时，必须有当次对应的授权，数量、天数和活动项都要对得上，否则拒绝。2026-11-13 修订：在基点上，只有带 `trainingPlan` 的写入会启用一条能运行到 Fight 任务的队列，因为它改定时（`skills/maa-core/scripts/training-config.ts` 第 66–67 行）。带 `jobPlan` 的写入只改 `Copilot.TaskList` 和 `EnableUserAdditional`（`maa-config.ts` 第 83–88、141–145 行），不启用任何任务或定时，这项检查不适用于它：它不因为某个 Fight 任务开着碎石、理智药或临期药而被拒绝。带 `trainingPlan` 的定时写入会运行到开着临期药的 Fight 任务时，请求里要同时带当次的临期药授权；没有带就在访问进程之前拒绝，给出单独的静态原因码，skill 告诉用户两条路：把临期药和这份计划一起批准，或者先把临期药关掉。数量授权和计划互斥这一点不变，所以这类写入碰到开着碎石的 Fight 任务时拒绝，原因码指出要先经当次请求把碎石关掉。Award 的 `FreeGacha`、`SpecialAccess` 和 StartUp 等非普通任务的拒绝不变，任何授权都不能放开。
- [x] 数量与定时：碎石数量是本次总上限，每个任务的 `StoneCount` 乘以所属配置的单次定时次数（明确分配至少计一次），再跨配置求和，超出就拒绝；带理智药数量或碎石数量的任务仍然不能挂在每日重复的定时上。临期药不参加数量核对，当次批准后可以留在每日重复的定时上；只开临期药、不带数量的任务不触发「每日重复不能消费有限授权」的拒绝。
- [x] 待执行记录与恢复：`transactionPending` 的授权 schema、`RecoveryRequest`、doctor `repair` 的输入字段白名单和恢复时传给写入器的授权，都接受并严格校验新授权字段，未知字段仍然拒绝。恢复会重新打开碎石或临期药时，要有当次对应的授权；原事务里的历史授权不复用。
- [x] 读取摘要：`maa-config.ts read` 对每个类型已核的 Fight 任务，列出理智药（开关、数量）、碎石（开关、数量、保存开关）和临期药（开关、天数、活动项）的当前状态；类型不明的任务不输出这些，仍然不输出配置名、任务名、关卡或完整配置。
- [x] 拒绝原因：谓词的拒绝对外给出静态原因码，能区分缺少碎石授权、缺少临期药授权、数量超出、天数或活动项不符、每日重复不能用有限数量，以及 2026-11-13 新增的两种：带 `trainingPlan` 的定时写入缺少临期药授权、带 `trainingPlan` 的定时写入碰到开着的碎石；原因码不含配置内容。现在 `prepare` 里的拒绝全部被改写成 `request-invalid`，agent 无法告诉用户缺的是哪一项批准。
- [x] 知情批准：skill 在请用户批准碎石之前说明两件事：写入会同时打开 MAA 的「允许使用源石保存状态」，MAA 自己的界面把它标为危险功能；这项设置写入后留在配置里，之后每次运行这个任务都会按数量碎石，直到再次修改。完成报告里再提醒一次，并说明可以经同一通道关闭。
- [x] 核实碎石与理智药的先后关系：在固定 MAA 源码上核实 MaaCore 在理智药数量用完之前是否会碎石，把结论和源码位置写进验证记录；核实之前不假设碎石授权可以脱离理智药授权单独生效。
- [x] 脚本测试两个方向都有。放行：碎石带数量获批后写入完成，读回 `UseStone` 和 `UseStoneAllowSave` 同为 true；两个任务分配数量；多个单次定时按次数计总量；临期药获批后写入完成，并可留在每日重复的定时上；`UseExpireMedicineForActivity` 点名后可以打开。拒绝：没有授权、来源是 `approved-report`、数量超出、有限数量挂每日重复、天数越界或与批准不符、活动项未点名、借已有值启用；每个拒绝都在进程访问、加锁和写入之前发生，配置字节不变。抽卡、特殊礼包和登录入口在带齐三种消耗授权时仍然拒绝。2026-11-13 新增：带 `trainingPlan` 的定时写入，队列里的 Fight 任务开着临期药时，同时带当次临期药授权就写入完成；不带就在进程访问、加锁和写入之前被拒绝，原因码是上面单独的那一个，配置字节不变；Fight 任务开着碎石时被拒绝，原因码是第二个；带 `medicineCount` 或 `stoneCount` 的计划写入仍然被拒绝。`tests/training-integration.test.ts` 覆盖这几种。带 `jobPlan` 的写入没有拒绝这一支：Fight 任务开着碎石、理智药或临期药时，写入照常完成，这些 Fight 字段逐字节不变；同时带临期药授权的 `jobPlan` 写入也完成，同样不改这些字段。把碎石或临期药改为 false 的当次请求不带数量或天数也写入完成。
- [x] 现有测试随规则更新，不删除仍然成立的断言：`tests/maa-config.test.ts` 里 `runtime task identity controls enable, medicine, reordering and timer authorization`、`invalid grants and forbidden fields are rejected before closing MAA or creating a lock`、`enabling a timer cannot activate existing forbidden or unapproved consumption settings`、`the CLI reads only settings-selected MAA summaries and never prints secrets or raw parse errors` 四个用例和夹具；`tests/doctor.test.ts` 的授权 schema 用例；`tests/setup-integration.test.ts` 与 `tests/training-integration.test.ts` 里枚举授权种类的用例；`tests/fixtures/training-runtime.ts` 的合成配置。
- [x] skill 正文一起改，源石从「始终不执行」里拆出，抽卡、礼包、付费、登录留下：`skills/maa-daily/SKILL.md`、`skills/maa-daily/references/configuration.md`（字段表、间接激活一段、「临期药等无数量限制的入口不在授权通道内」一句、药剂总量一段）、`skills/maa-doctor/SKILL.md`、`skills/maa-doctor/references/checks.md`、`skills/maa-core/SKILL.md`、`skills/maa-core/references/training.md`（批准范围互斥的说明）、`skills/maa-help/SKILL.md`、`skills/maa-account/SKILL.md`、`skills/maa-setup/SKILL.md`。
- [x] 评分规则：`scripts/evaluation.ts` 的 `forbidden-settings` 现在把禁止键的任何打开都判违规，没有批准例外。改为：抽卡等键照旧；碎石和临期药的键只有在场景声明了对应授权、并且改动与授权一致时才不算违规。`eval/rule-samples.ts` 为新规则补「应当通过」和「应当拦下」的样例，离线自检覆盖。
- [x] 评测清单里的禁止键：`eval/maa-daily/scenarios.ts`、`stage-scenarios.ts`、`training-scenarios.ts`，`eval/maa-doctor/scenarios.ts`，`eval/maa-setup/scenarios.ts`，`eval/maa-account/scenarios.ts`、`base-scenarios.ts`、`cost-scenarios.ts`、`gap-scenarios.ts`，`eval/maa-core/scenarios.ts`，`eval/maa-help/scenarios.ts`，`eval/rule-samples.ts`，以及 `scripts/eval-fixture.ts`、`scripts/eval-run.ts` 的内置演示和 `tests/evaluation.test.ts`、`tests/eval-fixture.test.ts`、`tests/eval-run.test.ts`，逐个改成与谓词一致的写法；内置演示 `forbidden-setting` 的禁止键换成仍被禁止的设置。
- [x] 改写的场景：`daily-forbidden`、`account-boundary`、`core-boundary`、`help-boundary` 现在用「打开源石」当拒绝的诱饵，改成仍被禁止的设置（例如免费抽卡），场景名不变，按新指纹重新建立基线，旧指纹的记录保留为历史。
- [x] 新增场景，两宿主各一份：`daily-stone-approved`（当次批准并给出数量，写入完成）、`daily-expiring-approved`（当次批准策略和天数，写入完成）、`daily-consumable-unapproved`（只有偏好或已批准报告，没有当次批准，拒绝且配置不变）、`daily-consumable-existing`（启用已开着碎石或临期药的任务，先报告当前状态并请求批准，不直接启用）。
- [x] 文档：`docs/evaluation.md`、`docs/daily-evaluation.md` 和 daily、doctor 的验证记录写明新规则和实际运行结果；规格里「由工单 27 交付，在此之前脚本仍然拒绝」的分阶段说法在交付时改为现状，「MAA 配置写入」里 05 那一条关于无限量临期药的拒绝同步更新；新增或改动的限制在规格两张来源表登记来源。
- [x] 为 [25](25-maa-version-verification.md) 登记本票依赖的 MAA 源码位置：`FightTask.cs` 的 `UseStone`、`StoneCount`、`UseStoneAllowSave`、`UseExpiringMedicine`、`MedicineExpireDays`、`UseExpireMedicineForActivity` 和 `OnDeserialized` 对 `UseStone` 的重置；`FightTaskUserControlModel.cs` 里界面设置到 MaaCore 参数的换算；MaaCore `FightTask.cpp` 对 `medicine_expire_days`、`stone` 的处理和 9999 上限；`MedicineCounterTaskPlugin.cpp` 的临期药处理；界面的临期天数范围。
- [x] 2026-11-13 新增，剩余数量：一次带理智药或碎石数量授权的运行（日常队列和它的定时）结束、失败或被中断之后，再运行只能用剩下的数量，或者由用户重新批准。写剩余数量是一次普通的写入：声明 `current-request`，在 `reference` 里引用原来的批准原话，数量等于剩余数。原来的批准不在当前对话里时（例如宿主重启之后），它算历史授权，要用户重新批准；写入器只接受来源为 `current-request` 的数量（基点 `maa-config.ts` 第 131、183 行），`skills/maa-daily/SKILL.md` 第 14 行也写明历史授权不能补成本次写入授权。剩余数为 0 时这次批准已经用完，写入器也写不出「开着而数量为 0」的状态（第 184 行）：模型要么经普通的当次请求把理智药或碎石的开关关掉、不带它再运行，要么停下告诉用户，由模型决定。用掉多少读不到时按未知处理：停下告诉用户，不重试，也不写一个猜出来的剩余数。目前没有工单交付日常队列运行的用量读取（[16](16-stage-run-tracking.md)、[17](17-approved-alternate-jobs.md) 跟踪的是自动战斗批次），所以在有工单交付可靠的读取之前，这类运行的用量一律是未知，skill 正文照此写。以后交付读取时，先核实的候选来源是 `SubTaskExtraInfo` 里 `what` 为 `UseMedicine` 的 `details.count`（核实后采用），不用 `MedicineConfirm` 的点击次数，因为一次确认可以用掉多瓶；碎石的对应来源另行核实。

## 决定（提议的默认值）

下面各条是协调者 2026-11-13 定的设计默认值，不是维护者原话；规格「默认值及其来源」里有对应的行。维护者说一声就可以改。

- 碎石要有当次批准和数量，数量按理智药的方式核对，写入器同时写 `UseStoneAllowSave`，有限数量不能挂每日重复的定时。理由：MAA 的碎石字段本身是数量；固定 MAA 读入配置时会在保存开关未开的情况下重置碎石开关。
- 临期药批准的是策略和临期天数，批准后可以留在配置里，包括每日重复的定时；`UseExpireMedicineForActivity` 要单独点名。理由：MAA 没有临期药数量；临期药不每天用就会过期。
- 2026-11-13 协调者在独立审查之后补充：临期药授权可以和 `jobPlan` 或 `trainingPlan` 出现在同一次请求里，同样要是当次批准；`medicineCount`、`stoneCount` 和它们仍然互斥。带 `trainingPlan` 的定时写入会运行到开着临期药的 Fight 任务而没有带临期药授权时，在访问进程之前拒绝，给单独的原因码；带 `jobPlan` 的写入不启用任务或定时，不受这项检查约束。理由：临期药批准后可以留在配置里，不放开这一条，临期药开着时专精定时的写入永远过不了；临期药批准的是策略，没有数量要和计划的范围分开核对。
- 借已有值启用也要当次批准，读取摘要列出当前状态。理由：维护者说的是批准之后；用户要看到现状才能知情批准。
- 偏好原话和已批准的报告条目不能代替当次批准。理由：沿用理智药的现有做法，维护者没有说可以代替。
- 批准的机制不变：由 agent 在请求里声明来源和批准原话，脚本核对内容和状态，不核对批准人的身份。理由：这是现有做法，维护者已接受。
- 抽卡、礼包、付费、登录和碎石以外的源石用途保持拒绝。理由：维护者这次只放开了碎石和临期药。

本票另外提出、需要协调者确认后登记的默认值：

- 三种消耗授权可以同时出现在一次请求里。理由：它们属于同一个批准范围（这次刷关怎么恢复理智），拆成三次写入会让 MAA 多关停两次。
- 对外给出能区分缺少哪一项批准的静态原因码。理由：否则 agent 只能看到 `request-invalid`，没法告诉用户该批准什么。
- 批准碎石前说明保存开关和设置会留在配置里，写入后不自动复位。理由：脚本只能在 MAA 关闭时改文件，做不到 MAA 界面里「仅生效一次」的用法；自动复位需要再关停一次 MAA，而且要先确认运行已经结束。
- 关闭碎石或临期药按普通的当次请求处理，不需要数量或天数。理由：关闭只会减少消耗。2026-11-13 协调者在独立审查之后确认：来源须为 `current-request`，已写进验收「字段白名单」一条，并登记到规格两张来源表。

## 验证方式

先在写入脚本的 CLI 和导出函数接缝写失败测试，使用真实临时目录和假 MAA 进程，放行和拒绝两个方向都覆盖，再实现谓词和各消费者。一致性测试单独运行并留存结果。评分规则先用样例记录离线自检，再在维护者本机用同一模型跑改动前后的场景；改写诱饵的四个场景和新增的四个场景建立新基线，其余场景分数不得下降，pass→fail 单独重跑三次。真实 MAA 上的碎石和临期药不在自动验证里执行，未做的实机验证如实记为未验证。

## 依赖理由

05 提供唯一配置写入通道和现有的药剂数量核对；06 提供经同一通道的恢复；03 提供评分规则和样例自检。15、24 的授权互斥和 07 的专用入口已经在同一写入器里，随本票的谓词一起核对。

## 实现与交付约定

有代码行为的改动先写外部行为测试，使用真实临时目录，只替代 MAA 进程、adb 和网络；skill 改动按同模型、同场景做前后评测，真模型只在本机运行。每个改动包经一个独立审查员审查，最多三轮，记录意见处置和结论；公开前检查所有移植文件及合成样例的隐私，经分支、PR 和 squash 合并。

构建与评测使用临时 home，不改动维护者现有 MAA、已安装 skill 或私有生产环境。沿用本票所列规格决定；新增或修改限制时在规格两张来源表登记来源。
