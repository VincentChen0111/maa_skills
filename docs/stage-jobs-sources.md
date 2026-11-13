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

R2 补核同一固定 Core 的零门槛：已识别且支持 S1 的干员以 `skill - 1` 得到精英 0，显式 elite=-1 会被拒绝；skill=0 或缺省则得到 -1，可以保留原值。GUI 的上述修正仅针对正门槛，并不能修复这项 S1 差异。本工具因此只把 S1 的明确 -1 归一化为 0；缺省 elite 不凭空增加，非法精英类型不转数值，技能 0/缺省的 -1 不改，账号未知阶段仍待核。归一化后的精英阶段参与原有等级比较，原文和派生分别绑定。来源仍为上表固定 CopilotConfig / CopilotViewModel；[R2 原报告](reviews/2026-11-11-15-stage-r2.md) 保留缺陷证据及作者接受理由。

## 29 匹配改进核对（2026-11-13）

工单 [29](issues/29-stage-job-matching-improvements.md) 逐项核实后再改。作业站后端和 MAA 是 AGPL-3.0，作业站前端没有许可证：只取事实和思路，没有复制代码。公开源码和数据只放在被忽略的临时目录；线上接口只用匿名只读 GET，测试不依赖线上内容。下面的行号都指所列固定提交。

### 作业站线上后端

- 2026-11-13T00:01Z 匿名读取 `https://prts.maa.plus/version`，返回 title `ZOOT API`、git 分支 `main`、提交 `746b3948babc61db82654247711fa99c86c5426b`（提交时间 2026-09-27）。该端点由 [SystemController.kt 第 43 行](https://github.com/ZOOT-Plus/ZootPlusBackend/blob/746b3948babc61db82654247711fa99c86c5426b/src/main/kotlin/plus/maa/backend/controller/SystemController.kt#L43) 从构建时的 git 信息取值，仓库是 [ZOOT-Plus/ZootPlusBackend](https://github.com/ZOOT-Plus/ZootPlusBackend)（AGPL-3.0）。以下作业站事实都固定在这个提交上。
- 15 记录固定的 MaaCopilotServer `e3f9cbf` 不是线上版本：该仓库已归档，最后一次推送是 2022-12-06。15 依赖的参数名在线上版本上仍然成立：[CopilotQueriesRequest.kt 第 14–29 行](https://github.com/ZOOT-Plus/ZootPlusBackend/blob/746b3948babc61db82654247711fa99c86c5426b/src/main/kotlin/plus/maa/backend/controller/request/copilot/CopilotQueriesRequest.kt#L14-L29) 有 `level_keyword`、`page`、`limit`（最大 50）、`language`、`operator`、`document`、`order_by` 等；[CopilotController.kt](https://github.com/ZOOT-Plus/ZootPlusBackend/blob/746b3948babc61db82654247711fa99c86c5426b/src/main/kotlin/plus/maa/backend/controller/CopilotController.kt) 给公开的 `GET /copilot/query` 和 `GET /copilot/get/{id}`。所以已交付的查询不用改。
- 默认按 `copilot_id` 倒序（[CopilotService.kt 第 345 行](https://github.com/ZOOT-Plus/ZootPlusBackend/blob/746b3948babc61db82654247711fa99c86c5426b/src/main/kotlin/plus/maa/backend/service/CopilotService.kt#L345)，新作业在前）。非聚合查询的 `has_next` 只看本页是否装满（第 352–364 行），恰好装满的最后一页也会报有下一页；这只会让报告多标一次「未穷尽」，方向是保守的，不改。

### 接口语义

- `level_keyword`：[CopilotService.kt 第 312–319 行](https://github.com/ZOOT-Plus/ZootPlusBackend/blob/746b3948babc61db82654247711fa99c86c5426b/src/main/kotlin/plus/maa/backend/service/CopilotService.kt#L312-L319) 先用 [ArkLevelRepository.kt 第 185–199 行](https://github.com/ZOOT-Plus/ZootPlusBackend/blob/746b3948babc61db82654247711fa99c86c5426b/src/main/kotlin/plus/maa/backend/repository/ktorm/ArkLevelRepository.kt#L185-L199) 在关卡表上做 `name`、`level_id`、`stage_id` 三列的 `LIKE %关键字%`，再按命中关卡的 stageId 用 `stage_name IN (...)` 筛作业。没有命中关卡时，把 `document` 参数原样当作 `stage_name LIKE` 的值（[CopilotRepository.kt 第 259 行](https://github.com/ZOOT-Plus/ZootPlusBackend/blob/746b3948babc61db82654247711fa99c86c5426b/src/main/kotlin/plus/maa/backend/repository/ktorm/CopilotRepository.kt#L259)）；本工具不传 `document`，关卡筛选就整个没有了，返回全站作业。线上实读 `level_keyword=1-7`（不是任何关卡名或 ID 的子串）返回 `total` 44658，首条是别的关卡。结论：工单的说法基本成立，更正两处：匹配的是关卡名、levelId、stageId，不含章节 ID；「退回关键字搜索」实际是退回到 `document` 参数，本工具不传它，所以等于不筛关卡。
- `operator`：第 321–331 行按逗号拆分，前缀 `~` 的名字进排除列表，用 `copilot_id NOT IN (SELECT ... FROM copilot_operator WHERE name IN ...)` 排除（[CopilotRepository.kt 第 246–253 行](https://github.com/ZOOT-Plus/ZootPlusBackend/blob/746b3948babc61db82654247711fa99c86c5426b/src/main/kotlin/plus/maa/backend/repository/ktorm/CopilotRepository.kt#L246-L253)）。说法成立。但 `copilot_operator` 只收 `opers` 的名字，不收群组成员（CopilotService.kt 第 155、463 行），按名字在服务端排除会误删「群组里另有可用成员」的作业，所以查询不使用这个参数，仍在本地逐成员核对。
- 评分字段：[CopilotInfo.kt](https://github.com/ZOOT-Plus/ZootPlusBackend/blob/746b3948babc61db82654247711fa99c86c5426b/src/main/kotlin/plus/maa/backend/controller/response/copilot/CopilotInfo.kt) 带 `like`、`dislike`、`rating_level`、`rating_ratio`、`not_enough_rating`。评分时（CopilotService.kt 第 493–503 行）`rating_ratio` 是好评率四舍五入到一位小数，`rating_level` 是它乘 10 的整数；`rating_type` 是请求者本人的评价，匿名读取没有意义。`not_enough_rating` 在第 527 行定义为 `like + dislike <= minValueShowNotEnoughRating`，代码默认值和配置模板都是 50（[Copilot.kt 第 10 行](https://github.com/ZOOT-Plus/ZootPlusBackend/blob/746b3948babc61db82654247711fa99c86c5426b/src/main/kotlin/plus/maa/backend/config/external/Copilot.kt#L10)、application-template.yml 第 73 行）。线上配置不公开：2026-11-13 匿名读取按热度排序的前 300 份作业，带标记的最多 10 票，不带标记的最少 11 票（其中 49、53、55 票都不带标记），全部满足 `rating_ratio = rating_level / 10`。结论：字段含义成立；「不超过 50 票带评分不足标记」在源码默认值上成立，在线上不成立，线上的分界是 10 票。所以本工具直接用作业站自己的 `not_enough_rating`，不写死票数。
- 详情接口 `GET /copilot/get/{id}` 走进程内缓存（CopilotService.kt 第 184–203 行），返回的点赞数可能是缓存时的旧值：同日一份新作业的详情给 0 赞，查询摘要给 1 赞。所以评分取自查询摘要，作业内容仍取自详情（沿用 15）。

| 作业站固定源码文件（746b394） | SHA-256 |
| --- | --- |
| SystemController.kt | `7430e36737496740b01884e16749426151d8a53b0a568f017d5d0e0d0247b9a9` |
| CopilotController.kt | `75ddc0b57cdc7992f4f8b5df5ed4556bd91a88471c6b01476079b026a6280196` |
| CopilotQueriesRequest.kt | `6dbdb9606bbdaa8b8250fc1bcf041fb1d01f9b95554b13cd3acf3248fae2365c` |
| CopilotInfo.kt | `59ae9da15c0dee3f10a79febbf354e140e67658b2573b31d3b28d34eeb657403` |
| CopilotService.kt | `b811d7a07ff1bbed911a581bc7a7d3e7d4eea47f2c20a0c8f6a6fabc989ebb81` |
| CopilotRepository.kt | `1fde6941b503fc80cc40da9d8650b4ea0cae97d242c09719362a67499fd99bd4` |
| ArkLevelRepository.kt | `104dcef4f13414d8e385b47033da03bd565e3407aaa4a7cb90dea27b480b65a8` |
| Copilot.kt（配置） | `a6b631b5302fa42f6a2d2d4e9043864a4f28fdaf73066c6c5685445ba6e586fe` |

作业站前端 [ZOOT-Plus/zoot-plus-frontend](https://github.com/ZOOT-Plus/zoot-plus-frontend)（无许可证，dev `9350e1aac7cf49e7b662d7d078e7030cbb67d7a8`，线上部署的提交没有核对）在评分不足时显示「评分不足」而不显示等级，否则把 0–10 的等级映射成九档文字。只作背景，本工具没有采用。

### MAA v6.21.4（`52d0b2acaca116585b02e1e6a9da303460f81a24`）

- 没写要求的条目：[作业协议第 32–40 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/docs/zh-cn/protocol/copilot-schema.md#L32-L40) 写明 `requirements` 可选，各项默认 -1「不作要求」；[AsstBattleDef.h 第 128–136 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Common/AsstBattleDef.h#L128-L136) 的默认值同为 -1；[BattleFormationTask.cpp 第 728–731 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Miscellaneous/BattleFormationTask.cpp#L728-L731) 在精英和等级要求都不大于 0 时直接通过。所以 MAA 对这类条目只要求持有（及所选技能可用），没有按稀有度给的默认值。同类项目 [MAA-PRTS](https://github.com/OriginiumLab/MAA-PRTS/blob/305d3b6bdef58f06989586d59ac2fed2ba7e0f8f/backend/core/copilot.py#L46-L62)（MIT，`305d3b6`）按星级补「六星精二 60 级、专三」等默认值，它的注释写明这是其用户定的规则，不是从数据推出的；本工具的账号快照也没有技能等级，带技能要求的默认值无法核对。结论：没有可依据的数字，这类条目记为「要求未写明，待核」，不给推定值。
- 借助战：[BattleFormationTask.cpp 第 110–162 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Miscellaneous/BattleFormationTask.cpp#L110-L162) 在编队后恰好缺一个干员组（组内成员未持有或未达要求）且开启助战时，进助战列表按组内成员的职业、名字和技能找人；第 134 行构造的 `RequiredOper` 只填职业、名字和技能，第 1076–1082 行比较的精英、等级、潜能都是默认值 0，所以 MAA 不核对作业写的练度。缺两组以上编队失败（第 152–161 行）。[集成文档第 1272–1289 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/docs/zh-cn/protocol/integration.md#L1272-L1289) 的 `support_unit_usage` 1–3 都会补缺一人，3 还会在不缺人时随机加一名助战。图形界面列表模式（[CopilotViewModel.cs 第 2285–2287 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/CopilotViewModel.cs#L2285-L2287)）传 `UseSupportUnitUsage ? SupportMode : 0`；`UseSupportUnitUsage`（第 832 行）是运行时状态，没有持久化，默认关；持久化的 [Copilot.SupportMode](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/Settings/Copilot.cs#L40) 只有 WhenNeeded=1、Random=3 两档。中文界面上开关叫「借助战」，两档叫「补漏」「随机」（zh-cn.xaml 第 1018–1021 行）。结论：支持，开关只能由用户在界面上勾选。
- 动作的名字：作业协议第 105 行规定 `name` 是「干员名 或 群组名」，部署时必填，技能、撤退时可选，设置单位坐标时必填；第 83–87 行写明设置单位坐标还可以登记装置、设施等非干员单位；技能、撤退可以只填坐标操作装置和同名召唤物。[CopilotConfig.cpp 第 289–293 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Config/Miscellaneous/CopilotConfig.cpp#L289-L293) 接受的设置单位坐标写法是 `SetUnitLocation` 的四种大小写和「设置单位坐标」。Core 把召唤物和装置归为 Drone 职业（AsstBattleDef.h 第 214–216 行）。固定游戏表 [character_table.json](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/character_table.json)（与关卡表同一固定提交，SHA-256 `eb6fff6fb3ce605bd60db2206a644625a3d145b4c46fa126f218cd51df4f1f1d`）共 1437 条，其中 75 条 TOKEN（召唤物）、894 条 TRAP（装置），其余是可部署干员；有 11 个名字同时属于干员和装置（例如 Mon3tr）。结论：扫描时排除声明过的干员、群组名和群组成员，排除只在 TOKEN/TRAP 里出现的名字，排除本作业用设置单位坐标登记的名字；同名同时是干员时按干员处理。
- 关卡难度：[作业协议第 209–213 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/docs/zh-cn/protocol/copilot-schema.md#L209-L213) 的 `difficulty` 可选，0 或缺省表示未设置，1 普通，2 突袭，3 两者；R1 审查后补核了 0/缺省在图形界面里怎么处理，见下文「R1 补核」；[MultiCopilotTaskPlugin.cpp 第 68 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Miscellaneous/MultiCopilotTaskPlugin.cpp#L68) 只在 `is_raid` 时切换突袭。

| MAA 固定源码文件（52d0b2a） | SHA-256 |
| --- | --- |
| copilot-schema.md | `4d8af8442fa4e77f238dedd413870c96e2785f2b795fe66e6a4d67f2d54d9507` |
| integration.md | `84b87980f72940dc3855f5de969707f3ac5a30e406bf66e72565ba8533d62a7a` |
| BattleFormationTask.cpp | `04482f503a53ddb2b7dd7ba39d347dfa328f8f03ed00b48e9ceb8c3177bec567` |
| BattleFormationTask.h | `0da2353337a43b2cc40288b228af8ef7b6410f0bccf004902f492d909e9c3858` |
| AsstBattleDef.h | `f85ac01885b27bba0bb5a94a50da704a0c7cd1553220ec14e3a7daae1467e9d3` |
| CopilotConfig.cpp | `d6daff6701b1323e43935e02abcb9e0388e8fc64b54657cff3431a3175d053ff` |
| MultiCopilotTaskPlugin.cpp | `7e8b69926a73df3c3af91bff43832814694958afdc283e4c6db8641e5ed82e0d` |
| zh-cn.xaml | `1ab0afdb0efc4e92648a5ce733b981891bd9b7306856a651148a39e85248bb7d` |

Copilot.cs、CopilotViewModel.cs 的哈希与上文 15 的记录相同。

### 固定关卡表的后缀

固定 [stage_table.json](https://github.com/Kengxxiao/ArknightsGameData/blob/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff/zh_CN/gamedata/excel/stage_table.json)（SHA-256 `499319a48326de0f915c9f4b5e750a9bf946ad73b2bb56797ba8718af468ce84`，3692 条）逐条扫描：`#` 后缀只有两种。`#f#` 800 条，全是 FOUR_STAR，FOUR_STAR 也全是 `#f#`。`#s` 45 条，全是 SIX_STAR（主线 15–17 章所在的三个区域），SIX_STAR 也全是 `#s`，每条都和一个 NORMAL 关卡共用 levelId 和关卡代号。另有 `hard_`、`easy_`、`tough_` 前缀的独立关卡（各有自己的 stageId 和 levelId，按自己的 stageId 解析），以及 3 组 `_m1`/`_m2` 结尾、共用同一 levelId 和代号的活动任务关卡（同难度的两关，不是普通/突袭孪生关卡；按下文 R1 补核的判断，写另一关的作业记为同图无法证明）。结论：`#s` 存在，但固定 MAA 协议没有对应的难度位，列表模式也只会切换突袭，作业无法证明适用于这个难度。所以 `stages` 返回原始难度 `tableDifficulty`，`#s` 关卡继续标为 unsupported、拒绝匹配；普通关卡不接受写着 `#s` stageId 的作业。检索关键字仍取 levelId 末段，普通和 `#s` 共用，不需要改。

### R1 补核：关卡身份与缺省难度（2026-11-13）

独立审查 R1 指出第 9 章突袭被错判为「没有作业」，并找出 15 留下的两处同类问题。以下同样固定在 MAA v6.21.4 `52d0b2a` 与关卡表 `6f63c14`。

- MAA 怎样从作业找到关卡：[TileDef.hpp 第 38–44 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/3rdparty/include/Arknights-Tile-Pos/TileDef.hpp#L38-L44) 用一个字符串与地图数据的 stageId、code、levelId、name 逐一比较，完全相等才算命中；[TilePack.h 第 70–78 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Config/Miscellaneous/TilePack.h#L70-L78) 返回自己数据顺序里的第一个命中。列表模式下 [CopilotTask.cpp 第 141–148 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Interface/CopilotTask.cpp#L141-L148) 用作业自己的 `stage_name` 查到关卡，没有导航名覆盖时用查到关卡的 code 导航；[MultiCopilotTaskPlugin.cpp 第 44、57、70 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Miscellaneous/MultiCopilotTaskPlugin.cpp#L44-L70) 依次按作业 `stage_name` 载入地图、按该 code 导航、列表项 IsRaid 时切换突袭。本工具写入的列表项不覆盖导航名，所以作业实际去哪一关由它自己的 `stage_name` 决定。levelId 末段（例如 `training_1`）不会命中任何关卡。
- 固定关卡表的相关事实：第 9 章 `main_09-01`～`main_09-17` 与各自的 `#f#` 共用 levelId 和代号，难度组都是 NORMAL；这是表里唯一一类难度组不为 NONE 而共用 levelId 的关卡（17 对）。各章 TOUGH/EASY 关卡有自己的 levelId。`act50side_ex01`（TD-EX-1）的 levelId 是 `level_act50side_ex02`，`act50side_ex02`（TD-EX-2）的是 `level_act50side_ex01`，突袭同样互换；MAA 自带的地图数据文件名也带着同样的对应（`act50side_ex01-…-level_act50side_ex02.json`）。全表有 33 个 stageId 的 levelId 末段恰好是另一个 stageId（act50side、act1multi、act2multi 的 ex 关卡）。
- 结论：15 的规则在两处与 MAA 不一致。一是非 NONE 难度组只接受精确 stageId，第 9 章突袭因此拒绝了写普通 stageId 的作业，而 MAA 会按普通关卡的 code 导航再切换突袭，作业的难度位决定能否用于突袭。二是 NONE 关卡接受 levelId 末段，TD-EX-1 因此接受写着 `act50side_ex02` 的作业，而 MAA 会把它导航到 TD-EX-2。改为一个判断（`resolveJobStage`）：按上面四个字段精确相等解析（levelId 的写法见下一条），只指向所选关卡或它同 levelId、同代号、同难度组、一个普通一个突袭的孪生关卡时算本关；同一 levelId 的其他难度组、模式（例如 `#s`）或同难度的另一关无法证明；别的 levelId 是其他关卡；查不到，或查到的关卡里混有其他关卡（MAA 取哪个取决于它自己的数据顺序）时无法确定。逐份地图核对和每关检索结果分类共用这一个判断。本工具用固定关卡表近似 MAA 的地图数据。
- levelId 的大小写（R2 审查后补核）：[TilePack.cpp 第 31–34 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Config/Miscellaneous/TilePack.cpp#L31-L34) 的 levelId 取自 [resource/Arknights-Tile-Pos/overview.json](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/resource/Arknights-Tile-Pos/overview.json)（SHA-256 `5ff036f93a44f5837cea8b12abb1a723f5c8d8746d4152ba0a5b07b83706d3eb`）。2026-11-13 只读核对：4334 条的 levelId 全部小写（例如 `obt/main/level_main_09-01`），stageId 也全部小写，code 保留原大小写；固定关卡表写作 `Obt/Main/level_main_09-01`。TileDef.hpp 第 43 行区分大小写比较，所以写着关卡表混合大小写 levelId 的作业 MAA 找不到，CopilotTask.cpp 第 142–144 行在开始前失败。因此判断里 levelId 按小写建索引、与作业的 stage_name 区分大小写比较：混合大小写的写法记为无法确定，小写写法按 MAA 的方式解析。
- 其他字段：两边都有的 3164 关里，转小写后 levelId 全部一致；code 有 14 关不同（例如 `act38side_sp01` 表里是 PV-SP-1、地图数据是 PV-P-1），名称有 19 关不同（13 关在表里没有名称，6 关用字或标点不同）。固定关卡表另有 218 个带地图的活动关卡、102 个 CLIMB_TOWER 关卡不在固定版本的地图数据里。用户实际使用的 MAA 地图数据可能随资源更新而不同，本工具不以固定 overview 判断 MAA 是否认识某关；作业几乎都写 stageId（R1 审查抽样 300 份里 296 份）。MAA 找不到关卡时在开始前报不支持并停下，不会跑到别的关。
- 缺省难度：[CopilotModel.cs 第 437–453 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Models/Copilot/CopilotModel.cs#L437-L453) 的 DifficultyFlags 中 None = 0 表示未设置，属性缺省即为 None；[CopilotViewModel.cs 第 1023–1027 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/CopilotViewModel.cs#L1023-L1027)（本地文件）和 [第 1436–1440 行](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/CopilotViewModel.cs#L1436-L1440)（作业站作业，列表模式）把 None 当作 Normal 加入列表，只有带突袭位才加突袭项。结论：0 或缺省按只适用普通处理，突袭仍不用；这取代 15 记录里「缺省难度不作为精确匹配证明」。审查抽样里 300 份线上作业有 122 份没写难度。

| R1 补核文件（52d0b2a） | SHA-256 |
| --- | --- |
| TileDef.hpp | `fdb121de43b4bc6362e62349d0a185f2b72be4cde52f7efa9a046a9bd90080e1` |
| TilePack.h | `74f87c2ab9b7365711334c8ac2b6079dbdca47fa6e3e5756275ec90555c296a9` |
| CopilotTask.cpp | `b426f5a7a3782df04b5c2c106db7ed1fa1116424c69c87a00ac07d3a7a51fe5c`（与 15 记录相同） |
| CopilotModel.cs | `5e6c6a1450d5219073988316d3fb2eb1f47c5fcc60a6930a449a574c30dbe129` |

### 同类项目的思路

[MAA-PRTS](https://github.com/OriginiumLab/MAA-PRTS/blob/305d3b6bdef58f06989586d59ac2fed2ba7e0f8f/backend/core/copilot.py)（MIT，`305d3b6bdef58f06989586d59ac2fed2ba7e0f8f`）只借思路，没有复制代码：好评率门槛随票数升高（第 69–80、489–508 行，5 票 65%、100 票及以上 85%、中间按对数过渡，5 票以下不筛）；缺一人时标「可借」（第 298–310 行）。本工具采用的门槛数字和理由见规格「默认值及其来源」。
