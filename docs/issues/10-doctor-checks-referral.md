# 10: doctor 完整检查与转介

Type: task
Labels: task
Status: ready-for-agent
Assignee: unassigned
Parent: [maa_skills 规格](../spec.md)
GitHub Issue: [#12](https://github.com/VincentChen0111/maa_skills/issues/12)
Blocked by: [09: 用户手动设置凭据](09-manual-credentials.md)

## 背景与目标

实施进度：已完成。

2026-11-13 交付：八组检查、日志分析和脱敏转介摘要，setup 与 doctor 共用的检查库和 adb 程序判断；[独立审查](../reviews/2026-11-13-10-doctor-checks.md)三轮，没有未解决的 P1、P2，剩下的两条 P3 转 [Issue #52](https://github.com/VincentChen0111/maa_skills/issues/52)。[验证记录](../doctor-checks-verification.md)写明实际运行的检查和未验证项：真实发布查询、真实日志格式与模拟器上的 adb 行为，以及新场景的真模型评测（留给 26）。

遗留锁只是故障的一类。用户描述症状后，需要得到覆盖本项目范围的检查结果，以及清楚的修复或转介路径。

2026-11-13 按维护者当日的决定及其设计默认值修订验收第 3、4 条：环境类失败先查明原因，再由模型决定，来源见规格「默认值及其来源」。

2026-11-13 补充：参考 MAA 官方的日志分析说明和同类公开项目，新增验收第 7–9 条和其后的「参考」一段，写的是检查项的来源、转介摘要的结构和一项只读检查，不新增产品限制。维护者当日同意把这批建议写进工单，说明见[工单索引](INDEX.md)；各条的具体写法是设计默认值，不是维护者原话。标「核实后采用」的事实还没有在固定 MAA 上核对。

## 要交付的行为

扩充 maa-doctor 的检查组，定位 skill 安装与使用问题；对 MAA 内部问题提供官方入口和脱敏摘要。

## 规格依据

用户故事：39、40、41、42、44、45、46、47、60。涉及章节：检查与修法；MAA 版本跟踪。术语使用父规格关联的术语表。

## 验收条件

- [x] 覆盖安装、连接、配置、写入锁、凭据、私有文件、skill 版本/目录联接八类检查入口；各项都给出状态、原因、修法和执行者。
- [x] 继续默认只读诊断、逐项批准修复，允许一次点名多项；调用 setup、偏好和配置的现有通道，不创建第二套写入逻辑。
- [x] 按结构化连接信息、任务链错误和子任务错误判断失败；进程退出码为 0 不视为任务成功，证据不足明确标为未知。环境类失败（连接断开、模拟器或游戏客户端异常、MAA 进程异常、识别环境不对）单独成类：先查明原因并核对当前状态，给出原因、证据和可选的下一步，由模型决定；不按失败次数自动交给用户或换作业，结果仍然未知时只核对、不重放。
- [x] 先查明原因，再判断是否转介：查明属于 MAA 缺陷、模拟器兼容或游戏更新未适配等本项目范围外问题的只转介，给出 MAA 官方文档/FAQ/issue 入口及脱敏日志摘要；识别失败先排除本机环境原因（分辨率、界面被遮挡、连接），排除后再转介。
- [x] 检查 skill 更新和已有 MAA 核实版本记录；未核实版本只提醒，核实列表不存在或为空时如实说明。25 负责自动更新核实记录和端到端新版本提醒。
- [x] 所有检查组维持人读/JSON 输出、0/1/2 退出码和最近检查记录；凭据、账号标识、连接地址及完整配置不进入摘要。
- [x] 检查项和环境类失败的排查顺序，对照 MAA 官方仓库自带的日志分析说明整理（固定标签 v6.21.4 的 `.agents/skills/maa-issue-log-analysis/SKILL.md`，和同目录 `KNOWLEDGE.md` 的常见误判清单）。按它的分类（连接、关卡导航与难度切换、证据完整性、版本差异、配置文件、理智药与临期药等），逐类列出本项目能在用户本机只读核对的检查，和只能转介的情形；每个检查注明对应的官方条目。只取事实和思路，不复制它的文字。这份说明随 MAA 版本变化，登记为 [25](25-maa-version-verification.md) 的依赖条目。
- [x] 转介摘要按固定结构给出：现象概要、关键证据、根因判断和证据链、置信度、还缺什么证据；结构对照官方日志分析说明的输出格式。关键证据写日志的时间段、回调消息名和 `what` 值，可以引用 MAA 已经保存的调试截图，只给相对 MAA 目录的路径（见 [16](16-stage-run-tracking.md) 的同一条）。摘要先脱敏再输出：除第 6 条所列内容外，设备标识和用户目录也不出现。脱敏有单独的测试，用带合成秘密标记的日志样例断言没有泄漏。
- [x] 增加一项只读检查：MAA 的远程控制是否已配置。固定版本的远程控制协议里，MAA 按固定间隔轮询获取任务的端点，远端可以下发 `Toolbox-GachaOnce`、`Toolbox-GachaTenTimes`（抽卡）等任务类型；这条路不经过本项目的写入脚本。检查只报告「已配置」或「未配置」，不输出端点地址和身份标识。已配置时状态为提醒，说明远端可以让 MAA 执行包括抽卡在内的任务，修法类别为用户手动：由用户在 MAA 界面里确认是否保留。这项设置不在写入脚本的字段白名单里，doctor 不为它提供自动修法。固定版本的设置类里有 `RemoteControlGetTaskEndpointUri` 等字段，挂在单个配置的 `Gui.RemoteControl` 下；它们在 `gui.new.json` 里的确切位置，以及端点留空是否等于停用，核实后采用。

参考，只对照思路，不复制代码：转介摘要的脱敏可参考 [yumi233/maa-control-center](https://github.com/yumi233/maa-control-center) 和 [dongwlin/La-pluma-next](https://github.com/dongwlin/La-pluma-next)（均 MIT）。MAA 的事实在固定标签 v6.21.4 上核对：[官方日志分析说明](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.21.4/.agents/skills/maa-issue-log-analysis/SKILL.md)和[常见误判清单](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.21.4/.agents/skills/maa-issue-log-analysis/KNOWLEDGE.md)、[远程控制协议](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.21.4/docs/zh-cn/protocol/remote-control-schema.md)、[远程控制设置类](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.21.4/src/MaaWpfGui/Configuration/Single/Settings/RemoteControl.cs)。MAA 是 AGPL-3.0，只取事实和思路。

## 验证方式

通过各组正常/提醒/错误样例和结构化回调反例检查诊断、退出码、脱敏及修法授权；明确区分可修和转介，验证不存在「退出 0 就成功」的误判；环境类失败样例验证先给出原因再给下一步，查明前不转介。2026-11-13 补充：远程控制已配置和未配置两种合成配置各验证一次，断言输出里没有端点地址和身份标识；转介摘要用合成日志验证结构齐全和脱敏。

## 依赖理由

09 提供凭据检查并经 07、06 带入共享检查库和授权修法流程；无需等待后续版本 Action。

## 实现与交付约定

有代码行为的改动先写外部行为测试，使用真实临时目录，只替代 MAA 进程、adb 和网络；skill 改动按同模型、同场景做前后评测，真模型只在本机运行。每个改动包经一个独立审查员审查，最多三轮，记录意见处置和结论；公开前检查所有移植文件及合成样例的隐私，经分支、PR 和 squash 合并。

构建与评测使用临时 home，不改动维护者现有 MAA、已安装 skill 或私有生产环境。沿用本票所列规格决定；新增或修改限制时在规格两张来源表登记来源。
