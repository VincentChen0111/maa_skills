# 15 作业接口来源核对

2026-11-11。独立实现，未读取或移植私人生产匹配器，未复制 MAA/作业站 AGPL 实现。公开源码只保存在被忽略的临时目录；这里只登记依赖事实和 SHA-256。游戏表不打包。

- MAA 固定 v6.21.4 / `52d0b2acaca116585b02e1e6a9da303460f81a24`。[Copilot 设置](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/Settings/Copilot.cs) 位于单配置，TaskList、EnableUserAdditional、LoopTimes 等是原生持久化字段。[列表模型](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/Items/CopilotItemViewModel.cs) 由 System.Text.Json 保存 Name、FilePath、CopilotId、Index、IsRaid、IsChecked 和 IsNavNameOverride；不能把 Newtonsoft 的 snake_case 属性名套到 gui.new.json。
- [GUI 作业入口](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/CopilotViewModel.cs#L2270) 在列表分支构造 MultiTasks 时没有赋值 LoopTimes；单文件分支才把 Loop 与 LoopTimes 传给任务。[Core 列表处理](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Interface/CopilotTask.cpp#L130) 保留每个有独立 Index 的列表项。因此本工具按已批准次数展开主作业条目；这是实现选择，源码核对不等于实机运行通过。
- [战斗协议](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/docs/zh-cn/protocol/copilot-schema.md) 与 [CopilotModel](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Models/Copilot/CopilotModel.cs) 规定 stage_name、opers、groups、actions、minimum_required；difficulty 是普通 1 / 突袭 2 位标记。缺省难度不作为精确匹配证明。精英化、等级、skill_level、module、module_level 和 potentiality 每成员独立。模组及逐技能专精当前快照无法证明，保留 unknown；不把标量技能等级当全部技能的专精。
- 作业站官方仓库 MaaCopilotServer 固定 `e3f9cbfa25469603992fe48f27563b0ae31fe1fe`。[查询模型](https://github.com/MaaAssistantArknights/MaaCopilotServer/blob/e3f9cbfa25469603992fe48f27563b0ae31fe1fe/src/MaaCopilotServer.Application/CopilotOperation/Queries/QueryCopilotOperations/QueryCopilotOperationsQuery.cs) 的参数为 level_keyword、page、limit、language；camelCase 的 levelKeyword 不是该参数。[控制器](https://github.com/MaaAssistantArknights/MaaCopilotServer/blob/e3f9cbfa25469603992fe48f27563b0ae31fe1fe/src/MaaCopilotServer.Api/Controllers/CopilotOperationController.cs) 给公开 GET query 和 get/{id}。本次实读公开接口确认 status_code/data 包装和详情 content JSON；查询摘要不当完整作业。只依赖读取端点，不提交、评分或登录。
- 游戏主表使用已有固定镜像提交 `Kengxxiao/ArknightsGameData@6f63c14e27b847ef74b53b00fe51fc322b3cd7ff` 的 [stage_table.json](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/stage_table.json)。stageId、levelId、zoneId、code、difficulty、diffGroup 和 unlockCondition 用于消歧与前置。普通 NORMAL 与突袭 FOUR_STAR 可共享 code/levelId，须结合 stageId 和作业难度核对；不把名称相似视为匹配。账号快照未提供通关事实，所以独立的当次证据保持在 request 中。

| 固定源码文件 | SHA-256 |
| --- | --- |
| Copilot.cs | `71f481abe2786387f42c99056a6339baca3c94c89de6e5587549ae7b50897c09` |
| CopilotViewModel.cs | `aac77b40dbf541b3efea453c588563ba031f92bcfdf280cf2aea0dd38dd1a61e` |
| CopilotItemViewModel.cs | `e301444799330940be3f11ca8416f2bc5550d79baeae9ffa26ae305913d8cc48` |
| CopilotTask.cpp | `b426f5a7a3782df04b5c2c106db7ed1fa1116424c69c87a00ac07d3a7a51fe5c` |
| QueryCopilotOperationsQuery.cs | `fcf8d553b6fc03529b30ec9df74f716d5ccf37e688e3bccbf1cd355f65dd6f5d` |

UseCopilotList 是 CopilotViewModel 中的 GUI 运行状态，没有对应 Copilot 持久化字段。因此交接明确要求用户确认自动战斗列表模式和本批次勾选项，再点开始；不声称配置准备代替了这个界面步骤。

[MultiCopilotTaskPlugin](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Miscellaneous/MultiCopilotTaskPlugin.cpp#L55) 在当前地图按导航名找关卡，仅 IsRaid=true 时触发突袭切换；它没有调用普通 Fight 的 StageNavigationTask 难度环境切换。因此每地图再按难度与 diffGroup 分批，非 NONE 组要求明确 stageId，待执行计划保留该组。用户在开始前确认地图与环境；不以共享 levelId 或列表配置冒充环境已选中。

摘要哈希保留读取字节；源码仅用于核对接口事实。公开 API 可变，报告保存每份来源 URL、读取时间、响应 SHA（联网模式）和作业内容 SHA。突袭与普通使用共享 levelId 检索，再以各自精确 stageId 和 difficulty 筛选；避免带 #f# 的关卡 ID 漏掉作业。合成离线输入明确标记，不假称 API 实读；人工语义/实机边界见 [验证记录](stage-jobs-verification.md)。

## R1 发现后的执行内容核对

以下同样固定于上述 MAA 提交，2026-11-11 经 GitHub 连接器重新读取完整文件；只独立实现接口事实，没有移植实现。

- [CopilotConfig](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Config/Miscellaneous/CopilotConfig.cpp#L108) 不解析潜能要求；[BattleFormationTask](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Miscellaneous/BattleFormationTask.cpp#L600) 和 [OperBoxDataConfig](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Config/Miscellaneous/OperBoxDataConfig.cpp#L83) 不复用本工具的分配。[列表模式开启 Form](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/CopilotViewModel.cs#L861)，不能把 UseFormation 当关闭自动编队。由此选择派生执行文件每组仅保留已核成员，固定 opers 与 actions/组名保留，原文和派生分别保存并校验。原文、各替代要求和分配仍可审查。
- [GUI 常规导入](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/CopilotViewModel.cs#L1333) 会按技能、技能等级及模组提高精英要求；Core 对显式 elite 低于所需门槛的已识别干员拒绝解析。直接文件列表不会做该导入修正。因此本工具在核对账号前取 S2→精一、S3→精二、普通技能等级 5–7→精一、8–10→精二、正模组要求→精二的最低门槛；缺省或 -1/0/1 低于门槛时提高，原文值单独显示，不修改账号事实，不降低要求。模组/逐技能专精没有证据仍待核。对未知职业等现有待核条件不扩大准备范围。
- [CopilotHelper](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Helper/CopilotHelper.cs) 使用 Semver 的 AllowLowerV；最低版本另允许 OptionalPatch，并调用 CompareSortOrderTo。[固定项目依赖](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/MaaWpfGui.csproj) 为 Semver 3.0.0。[库的官方排序说明](https://semver-nuget.org/v3.0.x/Semver.SemVersion.html#Semver_SemVersion_CompareSortOrderTo_Semver_SemVersion_) 先比较数字版本，再比较预发布，最后比较构建标识；预发布数字按数值，构建标识按 ASCII 字典序。这里沿用实际 GUI 的排序而非忽略构建标识；未知/非法版本保留 unknown，不照搬调试版本免检查分支。
- 分页覆盖并非作业证明的一部分，但会影响用户审阅候选，故把每关 online/offline、页数和截断状态纳入同一报告指纹，JSON 与 Markdown 同时显示。达到上限仍有下一页明确为未穷尽；即使查询结束，也不声称全站无其他候选。

| R1 新核对文件 | 固定 Git blob |
| --- | --- |
| CopilotConfig.cpp | `13339e8cafeb50e9e0b66198ebb31a46f7364b34` |
| BattleFormationTask.cpp | `d61d7246314a7d9ffe1af3cb396908ae60110360` |
| OperBoxDataConfig.cpp | `98c3da696860664c7ed654facea35e10e721b5e2` |
| CopilotHelper.cs | `26564e008143de86046988ce6ea3595920e269e7` |

报告保留 candidate.hash（原文）与 execution.content/hash（派生）。批准后 pending jobPlan 的 sourceHash/hash 分别绑定两者；原文存 source 子目录，MAA FilePath 指向派生内容。以上是源码支持的行为推导和合成文件实测，不是实际游戏运行结论。R1 原报告与意见处置见 [独立审查](reviews/2026-11-11-15-stage-r1.md)。
