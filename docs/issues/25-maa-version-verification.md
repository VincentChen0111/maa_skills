# 25: MAA 版本核对与升级提醒

Type: task
Labels: task
Status: ready-for-agent
Assignee: unassigned
Parent: [maa_skills 规格](../spec.md)
GitHub Issue: [#27](https://github.com/VincentChen0111/maa_skills/issues/27)
Blocked by: [10: doctor 完整检查与转介](10-doctor-checks-referral.md)

## 背景与目标

实施进度：已完成。

2026-11-13 交付：MAA 依赖登记与整文件指纹核对、每日 Action（正式版全部未变开 PR，变化或 beta 变化开 issue）、版本化的核实记录、setup 与 doctor 的升级提醒，以及计划和待执行记录里的版本标记；[独立审查](../reviews/2026-11-13-25-maa-version.md)三轮，没有未解决的意见。[验证记录](../maa-version-verification.md)写明实际运行的检查和未验证项：Action 在 GitHub 上的真实运行、真实 MAA.exe 的版本标记、实机核对（26 登记）和真模型评测（留给 26）。

MAA 的配置和回调行为会变化。只记录一个历史实测版本不足以让用户知道新版本是否仍符合当前依赖。

本票在 v0.1.0 之后实施，不阻塞 [26](26-v0-1-0-release-validation.md)（维护者 2026-11-11 同意，见规格「默认值及其来源」）。v0.1.0 只写明实机已核的 MAA 版本，由 07 和 10 读取并提醒。

2026-11-13 补充：参考同类公开项目，新增验收第 4–6 条和验收条件末尾的「参考」一段：计划和待执行记录带版本、任务类型集合进依赖条目、登记其他工单这次新增的 MAA 依赖位置。不新增产品限制；维护者当日同意把这批建议写进工单，说明见[工单索引](INDEX.md)，具体写法是设计默认值，不是维护者原话。

## 要交付的行为

以依赖条目和源码指纹核对 MAA 新版本，每日 Action 生成核实 PR 或变化 issue，并让 setup/doctor 读取真实验证记录。

## 规格依据

用户故事：45、56、57、58、59、60。涉及章节：MAA 版本跟踪；测试决定。术语使用父规格关联的术语表。

## 验收条件

- [x] 依赖条目记录行为、对应源码位置/指纹、受影响 skill，以及源码已核和实机已核版本；仅存指纹和定位，不打包 MAA 源码。
- [x] 为当前已实现的配置、定时、回调等依赖登记证据，后续行为实现时补条目；不把起点版本的历史经验自动登记为本仓库已核。
- [x] 2026-11-13 新增：登记 [27](27-approved-stone-expiring-medicine.md) 依赖的 MAA 源码位置，27 尚未交付时由 27 实现时补上。条目包括 `FightTask.cs` 的 `UseStone`、`StoneCount`、`UseStoneAllowSave`、`UseExpiringMedicine`、`MedicineExpireDays`、`UseExpireMedicineForActivity` 字段和 `OnDeserialized` 对 `UseStone` 的重置；`FightTaskUserControlModel.cs` 里界面设置到 MaaCore 参数的换算；MaaCore `FightTask.cpp` 对 `medicine_expire_days`、`stone` 的处理和临期药 9999 的确认次数上限；`MedicineCounterTaskPlugin.cpp` 的临期药处理；界面的临期天数范围。
- [x] 2026-11-13 新增：安装的 MAA 版本沿用 07 已有的读法（读 `MAA.exe` 的产品版本号，见 `skills/maa-core/scripts/setup.ts`），本票不另写一种。核实记录带自己的版本号；maa-core 生成的计划和待执行记录（配置写入、作业准备、专精排程，以及之后的基建排班）写入生成时读到的 MAA 版本和核实记录版本。执行或恢复时，两者任一和当前不同，就在结果里报告这一差异；未核实的版本仍然只提醒、不拒绝。
- [x] 2026-11-13 新增：依赖条目包含 MAA 的任务类型集合，因为本项目的任务身份核对依赖 `$type` 和 `TaskType`。「任务类型集合从 v6.19.0 到当前开发分支没有变化」这一说法没有在本仓库核对，核实后采用：实现时在固定源码上列出任务类型并登记指纹，核对之前不把它写成已核事实。
- [x] 2026-11-13 新增：登记 [10](10-doctor-checks-referral.md)、[16](16-stage-run-tracking.md)、[22](22-base-report-and-plan.md) 这次新增依赖的 MAA 位置，对应工单尚未交付时由它们实现时补上：回调协议里的消息名、`what` 值和 `StageDrops` 的关卡字段；中文界面文案里任务出错、完成任务等文案键；远程控制协议的任务类型和设置类字段；官方日志分析说明目录 `.agents/skills/maa-issue-log-analysis/`；基建排班协议的 `period`。
- [x] 每日检查正式版：全部条目未变才开 PR 添加源码已核版本；变化或条目缺失开 issue，列明受影响条目和 skill，不错误认证。
- [x] beta 变化开提前预警 issue，beta 不进入源码已核列表；相同版本/变化重复检查不会持续制造重复通知。
- [x] 把生成的核实记录接入 setup/doctor；正式版源码已核后提醒可升级，未核实版本只提醒不拒绝。
- [x] 发布信息分别列源码已核和实机已核；源码相同不等于实机已核，不伪造设备验证。
- [x] Action 只执行版本与指纹核对，不运行真模型、真实 MAA 或账号操作；公开输出不携带用户配置。

参考，只对照思路，不复制代码：读产品版本号、把规则版本写进每个计划，可参考 [yumi233/maa-control-center](https://github.com/yumi233/maa-control-center)（MIT）。

## 验证方式

固定样例源码树测试未变、变化及条目缺失，网络/GitHub 边界替身覆盖正式版、beta、重复检查与输出内容；演示核实记录更新后 doctor 的不同提醒。

## 依赖理由

10 提供完整诊断输出及版本提示入口；本票覆盖已有依赖，并核对全部最终实现的条目；26 不再承担这项核对。

## 实现与交付约定

有代码行为的改动先写外部行为测试，使用真实临时目录，只替代 MAA 进程、adb 和网络；skill 改动按同模型、同场景做前后评测，真模型只在本机运行。每个改动包经一个独立审查员审查，最多三轮，记录意见处置和结论；公开前检查所有移植文件及合成样例的隐私，经分支、PR 和 squash 合并。

构建与评测使用临时 home，不改动维护者现有 MAA、已安装 skill 或私有生产环境。沿用本票所列规格决定；新增或修改限制时在规格两张来源表登记来源。
