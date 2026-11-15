# check-required 结果验证（工单 26 试用修复，2026-11-16）

维护者原话，2026-11-16：「check required 要给我具体的，和有没有替代」，随后「现在修」。

## 问题

候选 `f51ba18` 上，`skills/maa-core/scripts` 的 10 个脚本里有 18 处 `check-required`，形状各不相同：`stage-jobs.ts`、`maa-config.ts` 的兜底是不带原因的 `{ok:false, status:"check-required"}`；`account-snapshot.ts`、`skland-account.ts`、`base-query.ts`、`preferences.ts` 的兜底是笼统的 `account-check-required`、`base-query-check-required`、`preferences-check-required`；`credentials.ts`、`setup.ts` 是 `unexpected-failure` 加笼统原因；`stage-run.ts` 有原因码，但没有要核对什么，也没有其他办法。agent 只能告诉用户「需要核对」。试用中 TL-S-4 的查询因为一份作业组名重复整个失败，只得到不带原因的 `check-required`。

同一类缺陷在训练链（`training-plan.ts` 的 `training-plan-check-required`）也出现过，按维护者的复发规则：一条规则、一个所有者，加一项枚举全部生产方和使用方的一致性测试。

## 规则与所有者

`skills/maa-core/scripts/check-required.ts` 是唯一的所有者：

- 结果的形状只有一种：`{ok:false, status:"check-required", reason, check, alternatives}`。`reason` 是目录里的稳定原因码，`check` 说要核对什么，`alternatives` 列出其他办法；没有其他办法时为空数组，`check` 以「没有替代办法。」结尾。
- 文本全是静态的，不放路径、地址、账号标识、凭据或系统消息。
- 每个生产方在 `producers` 里登记：自己会遇到的静态代码（或 Node 错误码）对应哪个原因，以及分不出来时用哪个兜底原因。兜底也是具体的，例如 `stage-jobs-prepare-outcome-unknown`（准备结果不确定，不重试）、`maa-config-write-outcome-unknown`（写入开始后的失败，不重放）。
- 标准输入读取阶段的拒绝（`stdin-json.ts`）不是 check-required，各脚本照旧报 `rejected` 或自己的错误码。`stage-run.ts` 原来把它们也报成 `check-required`，现在与 `stage-jobs.ts`、`maa-config.ts` 一样报 `status: "rejected"`。
- 使用方的规则只有一条：maa-core 调用方约定的「核对项」。四个操作类 SKILL.md 从同一行指过去；每个生产方的接口说明写明自己的形状和主要原因码。

生产方（本包转换）：`stage-jobs.ts`、`stage-run.ts`、`maa-config.ts`、`account-snapshot.ts`、`skland-account.ts`、`base-query.ts`、`credentials.ts`（只有 `check`）、`preferences.ts`、`setup.ts`。

合并后再采用（并行的训练修复会话 training-chain-fix 拥有，在它自己的分支上已输出同一形状，本包不改）：`training-plan.ts`、`training-time.ts`、`training-state.ts`、`cultivation-gaps.ts`，以及使用方 `skills/maa-core/references/training.md`。合并时把它们的原因码加进 `check-required.ts` 的目录和 `producers`，改用 `checkRequired`／`checkRequiredFor`，再从测试的「合并后再采用」两张表里删掉。

不是结果的：`setup.ts` 复检记录里的 `connection.reason: "maa-check-required"`（意思是「MAA 检查通过前不测连接」），测试单列。

## 一致性测试

`tests/check-required.test.ts`：

- 目录：原因码是稳定的短横线写法、不重复；每条都有 `check`；空的 `alternatives` 一定写明没有替代；文本里没有路径、地址或占位符；谓词 `isCheckRequired` 只认这一种形状和目录里的原文。
- 生产方：`producers` 的键与测试的脚本表一致；每个原因都至少有一个生产方能报出；`skills/maa-core/scripts` 下每个提到 `check-required` 的文件要么是所有者、要么是登记的生产方（必须引用共享模块、不能自己拼 `status: 'check-required'`、不能再报退役的笼统代码）、要么是合并后再采用的四个文件。`stage-run.ts` 能报出的每个代码（自己抛出的、再打判断的拒绝和保留原因、作业计划检查）和 `stage-jobs.ts` 能遇到的每个静态代码都要在表里。
- 使用方：maa-core 的规则写明三项；四个操作类 SKILL.md 都在同一行提到 check-required 并指向这条规则；每个生产方的接口说明（按 maa-core 脚本表的链接，`maa-config.ts` 是 maa-daily 的配置事务接口）都列为使用方并写明 `reason`、`check`、`alternatives`；任何使用方都不再写退役的笼统代码。
- 真实 CLI：在临时 home 里逐个运行 9 个生产方的失败路径（没有快照、快照坏了、请求字段不对、关卡对不上、离线文件读不了、报告不存在、没有 MAA 目录、配置读不了、走错入口、识别文件读不了、比较的快照坏了、设置文件坏了、私有目录写不进等），每个输出都通过 `isCheckRequired` 且原因码具体。

测试先行：转换前在本包的模块和测试上运行，8 项里 4 项失败（生产方没有用共享模块、使用方没有写明、CLI 输出不是具体原因）；转换后 8/8 通过。原有测试里 7 处断言随输出改变而改写（`account-snapshot`、`base-apply`、`preferences`、`setup`、`stage-run-alternates`、`stage-run-flow`），断言的都是新的具体结果。

## 评测

新增场景 `daily-stage-snapshot-alternative`：没有 MAA 识别快照时，查询返回 `stage-jobs-snapshot-missing`，其他办法之一是改用森空岛快照；用户允许直接用只读的其他办法，模型应当照办并查询成功。评分不看措辞，看查询是否成功、是否没有写任何文件。试用 9、10 两项的前后比较记在下面「评测前后」一节。

## 过度阻挡跟进：按行为枚举（2026-11-16）

过度阻挡审查指出：只按字符串 `check-required` 找生产方会漏掉形状相同、名字不同的笼统失败（例如 `training-time.ts` 的 `training-query-failed`）。本包按行为重新枚举：`skills/maa-core/scripts` 下每个命令行入口（用 `process.argv[1]` 判断自己是不是入口的脚本）要么是登记的生产方、经 `checkRequiredFor` 报告兜底失败，要么是合并后再采用的训练修复脚本；后者的现有笼统代码逐个列在测试里（`training-query-failed`、`training-plan-check-required`、`gaps-input-invalid`），代码变了测试就提醒更新。

新登记 9 个生产方：`base-plan`、`base-report`、`base-apply`、`cultivation-report`、`operator-cost`、`nga`、`bilibili`、`skland-community`、`doctor`。它们带固定代码的拒绝保持原样（与试用 10 的 `base-query` 同一边界）；读不了设置和未分类的失败改为 check-required，退出码不变（社区调研的意外失败、诊断的失败仍是 2）。基建应用的 `apply` 和诊断的 `repair` 未分类失败是「结果不确定、不重试」。基建应用检查结果里的 `base-apply-check-failed` 仍是结果内的拒绝原因，接口说明的拒绝原因表补了它的含义和做法。

测试：一致性测试新增「按行为枚举」一项，并在临时 home 里把设置文件写坏，逐个运行 9 个入口，都报 `settings-unreadable`，退出码与原来相同；诊断的两个原有测试从 `unexpected-failure` 改为 check-required 的 `check-could-not-complete`。使用方新增 6 份接口说明（建议报告、排班、社区调研、成本、基建应用、诊断检查）。

## 评测前后

2026-11-16 在本机运行，覆盖试用 9、10（包 1）和过度阻挡跟进（包 2）。同一份冻结的评测框架（`git archive 13c7312`，两批运行器相同，`compare` 认可可比），Codex CLI 0.167.0-alpha.3.2，模型 `gpt-6.1-sol`，套餐登录，逐个串行。载荷：前 `f51ba18`（发布候选），后 `58b3fdf`（两个包最后一次改 `skills/` 的提交；之后只改了审查记录）。

54 个场景：关卡作业 19 个（含本分支新增的 7 个：包 1 的 `daily-stage-prepare-skland-mastery`、`daily-stage-prepare-user-confirmed`、`daily-stage-mastery-insufficient`、`daily-stage-snapshot-alternative`，包 2 的 `daily-stage-job-content-invalid`、`daily-stage-prerequisite-question`、`daily-stage-job-confirmed`），关卡运行与换备选 10 个，maa-core 3 个，daily 3 个，account 4 个，setup 1 个，doctor 2 个，以及这次改了快照选择或兜底失败的工具各自的场景：成本 2、培养报告 2、社区调研 3、基建技能查询 1、基建报告 1、排班 1、基建应用 2。

结果：前 50/54，后 54/54；`compare` 总体 pass，没有由通过变失败的场景。由失败变通过的 4 个都是本分支新增或改过的场景（`daily-stage-prepare-skland-mastery`、`daily-stage-prepare-user-confirmed`、`daily-stage-snapshot-alternative`、`daily-stage-job-confirmed`），前一侧没有这些功能。`daily-stage-job-content-invalid`、`daily-stage-prerequisite-question` 两边都通过：评分看调用和不写文件，前一侧也满足；具体的原因码和单独挡掉坏作业由单元测试覆盖。OB-3（读已安装 MAA 的版本）没有场景：评测的合成 MAA 目录里没有带版本信息的 MAA.exe。
