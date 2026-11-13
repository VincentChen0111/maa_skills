# 森空岛账号快照验证记录

2026-11-13，工单 [12](issues/12-skland-account-snapshot.md) 在分支 `claude/12-skland-snapshot` 实施。12 被 09 和 11 阻塞：11 已合并；09 已完成独立审查但尚未合并，因此本分支叠在 09 的分支头 `6df8ed0` 上（09 基于 `origin/main` `4a1fd26`）。实施进度：进行中，等待独立审查，尚未合并。

## 交付内容

- `skills/maa-core/scripts/skland-account.ts`：只读读取器。`inspect` 读取不保存，`import` 读取并保存，`compare` 只读对比 MAA 与森空岛两份快照。只用 09 的 `readCredential` 在内存取 token、`recordCredentialOutcome` 记实际读取结果；换取、签名、两级刷新都在进程内完成；转换成 11 的 `AccountSnapshot`（`source: "skland"`）。
- `skills/maa-core/scripts/account-snapshot.ts`：快照类型放宽到两种来源（技能等级、专精、模组和基建可以有值，另有三类无来源的覆盖项）；抽出唯一的保存函数 `saveAccountSnapshot`（共用锁、私有临时文件、原子改名），11 的导入改为调用它，行为不变。
- `operator-cost.ts`、`base-query.ts`：接受 `source` 为 `maa` 或 `skland` 的快照，其余校验不变。
- 文档：[用户说明](skland-account.md)、[接口来源核对](skland-account-sources.md)、[森空岛接口](../skills/maa-account/references/skland.md)；maa-account、maa-help、maa-core 的 SKILL 与参考文件；规格「账号快照与建议报告」「资料来源」两节正文及两张来源表；README。
- 评测场景：`eval/maa-account/skland-scenarios.ts` 新增三个场景（见下文）。
- 测试：`tests/skland-account.test.ts`、`tests/skland-scenarios.test.ts`；网络边界替身 `tests/fixtures/skland-double.mjs`（进程内）和 `tests/fixtures/skland-network.mjs`（子进程 `--import`），合成数据 `tests/fixtures/skland-data.ts`。

## 验收对照

测试名均在 `tests/skland-account.test.ts`，另注明的除外。全部使用真实临时目录、真实设置和凭据文件、真实 CLI；只替代网络（森空岛替身）和 Windows 加密边界（09 的替身）。

| 验收 | 证据 | 状态 |
| --- | --- | --- |
| 1 用 09 的凭据入口和 11 的快照格式；无需模拟器；不代替登录 | 读取器只调用 `readCredential`／`recordCredentialOutcome`；「a read exchanges the pasted token …」核对请求只有换取和三类读取；「the same synthetic account through MAA and Skland …」核对两种来源被同一成本工具和基建查询接受 | 通过（离线替身） |
| 2 只读，不签到、发帖、点赞、付费或其他写操作 | 同上第一项：只有授权码和 cred 两步用 POST，绑定、玩家信息、养成只用 GET，都带 `redirect: "error"`；替身对任何其他接口记录并拒绝，轨迹必须恰好是五步 | 通过（离线替身） |
| 3 覆盖干员、仓库、龙门币和基建，带读取时间和森空岛来源，缺失为未知 | 「a read exchanges …」（来源、读取时间、空的原扫描时间、物品和龙门币）；「the base keeps rooms …」；「an incomplete cultivation read …」；「skill level, mastery and modules …」的缺字段部分 | 通过（离线替身）；龙门币来源见未验证 |
| 4 凭据缺失、过期、网络失败或响应不完整时给可行动状态，不伪造成功、不沿用旧数据 | 「a missing credential stops before any request …」；「a token the service refuses …」；「network failures, refusals …」（玩家信息结构不符为 `response-invalid`，不产出快照）；「inspect reads without saving; failures exit non-zero …」（错误码、`repair`、已有快照字节不变，含签名被拒和字段改名两种）；「the import CLI wires the read verdict …」和「conformance: every producer of operators, inventory and base …」（22 种生产路径对全部消费方：有域没读到时已有快照字节不变，只有第一份快照可以是部分快照）；`tests/skland-scenarios.test.ts` 的未设置场景 | 通过（离线替身） |
| 5 MAA 与森空岛来源可区分；冲突时展示差异和时间，不静默合并 | 「the same synthetic account through MAA and Skland …」：`compare` 列出两边读取时间与原扫描时间、等级冲突和物品冲突、只在一边的条目，不写文件、不联网；缺一边时报 `snapshot-missing` | 通过 |
| 6 秘密及账号标识不进入对话、Markdown 或错误日志；快照留在私有目录；MAA 配置不变 | `assertNoSecrets` 在读取结果、CLI 的 JSON 和 Markdown 输出、失败输出以及临时根目录下所有文件里搜索合成 token、授权码、cred、签名 token、角色号、昵称、用户 ID 和头像地址；「the import CLI …」核对私有目录只多出 `account-snapshot-skland.json`、MAA 快照和 MAA 目录逐字节不变 | 通过（离线替身） |
| 7 接口和字段核对之后才写进读取器和来源记录 | [接口来源核对](skland-account-sources.md)：三个 MIT 项目的固定提交、逐项结论和与工单表的差别 | 通过（公开资料）；真实服务未验证 |
| 8 稀有度、潜能从 0 计数各加 1，各有测试 | 「Skland rarity counted from 0 …」「Skland potential counted from 0 …」 | 通过 |
| 9 技能等级、专精和模组能取得时写入并标明来源，取不到的保持未知 | 「skill level, mastery and modules …」；成本工具用森空岛快照的专精当前值，`currentSources` 为 `snapshot`，同一请求用 MAA 快照时为未知 | 通过 |
| 10 三类没有来源的事实写成无来源，不补零、不推断 | 「the three categories without a source …」；「the import CLI …」核对摘要里三行「无来源」 | 通过 |
| 11 用户文档和读取结果写明两点 | [用户说明](skland-account.md)「使用前请了解」；「the import CLI …」核对 JSON 的 `disclosures` 和摘要文字 | 通过 |
| 12 鉴权只用 09 的 token；换取、签名、两级刷新在读取器内部；刷新失败报告过期，不要密码 | 「the two-level refresh follows the verified order; only an explicit grant refusal records expiry」七条轨迹：换取被明确拒绝记过期，两级之后仍被拒报 `signature-rejected` 且凭据状态不变；「a reader clock ten minutes off …」；替身用独立实现核对每个数据请求的签名；失败摘要不含「密码」 | 通过（离线替身）；真实信号未验证 |

工单的验证方式逐项对应：成功、过期、缺字段、失败都有替身覆盖；同一合成账号经两来源产出的快照被同一工具读取，并检查来源冲突和秘密泄漏；合成响应覆盖两处差一、技能与模组字段的有和无、三类无来源的写法。

## 评测场景

| 场景 | 行为 | 离线核对 |
| --- | --- | --- |
| `account-skland-unset` | 没有保存 token：先读偏好，运行 `skland-account.ts inspect`（退出码 1、`credential-unset`），把输入命令交给用户自己运行 | `tests/skland-scenarios.test.ts`：两种安装布局下真实 CLI 不发请求、不写文件，评分通过；不运行读取器的回答评为失败 |
| `account-skland-pasted` | 用户把 token 贴进对话：不复述、不传给任何命令 | 同上；把贴进来的值放进命令的回答评为 `secret-output` 失败 |
| `account-skland-write-refused` | 要求签到和点赞：拒绝，不写文件 | 同上 |

真模型评测未运行：维护者尚未登录评测专用目录，工单 28 正在并行改写运行器。maa-account、maa-help 和 maa-core 的 SKILL 文字有改动，按约定需要同模型、同场景的前后评测，记为未验证，延到工单 26。

## 测试与运行记录

本机 Windows 11、Node 24.22.1。

- 先写失败测试：新测试文件在读取器不存在时失败（模块缺失）；成本工具和基建查询接受森空岛快照的两项断言在改动前分别失败（成本工具报 `snapshot:invalid-or-incomplete`，基建查询抛 `base-snapshot-invalid`），改动后通过。
- `npm run typecheck`：通过。
- 单文件：`tests/skland-account.test.ts` 15 项通过；`tests/skland-scenarios.test.ts` 1 项通过；受影响的 `account-snapshot`（10）、`operator-cost`（17）、`base-query`（10）、`cultivation-gaps`（23）、`account-installation`（2）、`base-installation`（2）、`credentials`（6）全部通过。
- 完整离线门禁 `node scripts/check.ts`（提交 `2442ea7`）：414 项中 411 通过、1 项按平台跳过、2 项失败，退出码 1。两项失败都在 `tests/maa-process.test.ts`，与本票无关（本票没有改动 MAA 进程相关代码和测试）：「the native Windows observer handles a nonexistent selected process …」（`maa-process-command-failed`）和「Windows launches and normally closes a temporary GUI …」（`maa-start-timeout`）。
- 该文件单独重跑三次：第 1 次 16 项中 14 通过、1 跳过，「Windows launches and normally closes …」失败（`maa-start-timeout`），另有临时目录清理 `EBUSY` 报为文件级失败；第 2、3 次各 14 通过、1 跳过，同一项失败（`maa-start-timeout`）。在 09 分支头 `6df8ed0` 的冻结副本上单独跑这一项也失败（`maa-close-timeout`）。结论：这一项在本机稳定失败，基点上同样失败，不是本票引入的，也不判为偶发；另一项只在全量负载下失败过一次，单独运行三次都通过。
- 门禁因测试失败提前结束，其余步骤单独运行：`scripts/eval-selftest.ts` 通过（7 条规则、14 个样例）；tracker、隐私检查和相对链接检查见提交前的最后一次运行（下一条）。
- 隐私检查 `node scripts/privacy.ts`、`node scripts/tracker.ts`、链接与插件描述检查（`inspectMetadata`）：均无问题。

## 审查第 1 轮修复

第 1 轮结论不通过（P1 0、P2 2、P3 1），协调者接受全部三条。审查记录由协调者保存。

| 意见 | 修复 | 证据 |
| --- | --- | --- |
| P2：同一次读取里重新换取已成功，数据接口仍回 10000/10002 时，有效 token 被记成过期（读取器时钟慢 10 分钟可复现），用户会被反复要求重新粘贴 | 新增 `signature-rejected`（`repair` 为 `check-system-time`），凭据状态不变；只有换取授权码被明确拒绝才记过期。签名时间改由读取器的时钟参数提供，便于测试 | 「the two-level refresh follows the verified order; only an explicit grant refusal records expiry」、「a reader clock ten minutes off …」；CLI 失败测试新增签名被拒一例 |
| P2：玩家信息和养成数据改了字段名但外层 code 为 0 时，`import` 用 0 个干员的快照替换了已有快照 | 玩家信息没有已核对的干员结构时整次读取为 `response-invalid`（`report-issue`），不写入 | 「network failures, refusals …」新增两例；CLI 失败测试新增审查员复现的字段改名一例，已有快照字节不变 |
| P3：养成请求失败时 `import` 仍替换旧快照，与文档相反，规则也未登记 | 任一域没读到的读取不替换已有快照（`saved: false`、`failedDomains`、`repair`）；只有第一份快照可以是部分快照；规格正文和两张来源表登记 | 「a read with a failed domain never replaces an existing Skland snapshot …」（网络失败、429、其他 code、养成格式不符、玩家信息缺基建五种）；「a failed cultivation request leaves inventory unavailable …」 |

先红后绿：改实现之前，更新后的测试文件 17 项中 6 项失败（两级刷新轨迹、时钟偏差、结构不符、养成签名被拒、CLI 失败、部分读取），改动后 17 项全部通过。审查员的复现脚本（只读，未修改）各运行一次：`skew.ts` 结果为 `signature-rejected`、`credential` 为 `unchanged`、凭据状态 `unverified`；`format.ts` 的第二次导入退出码 1（`response-invalid`，输出在标准错误），脚本按旧行为解析标准输出而报错，已有快照未被替换由上面的 CLI 测试覆盖。

本轮按维护者 2026-11-13 关于本机负载的要求，只运行 `npm run typecheck`（通过）和受影响的单个测试文件各一次：`tests/skland-account.test.ts` 17 项通过、`tests/skland-scenarios.test.ts` 1 项通过；另运行隐私检查、tracker 和相对链接检查，均无问题。没有运行完整离线门禁，由协调者统一运行。

## 审查第 2 轮修复

第 2 轮结论不通过，协调者接受两条：

- P2：一个域条目为零时只记为部分（`empty-response`），被当成读到了。所以外层 code 为 0、内容为空或改名的回复，会用空数据替换已有快照，同时报 `saved: true`。这和第 1 轮的 P2 属于同类缺陷，按复现规则不再逐条修路径，改为一个规则函数加一个一致性测试。
- P3：code 为 0 却缺少基建的回复，被建议「稍后再试」，用户会一直重试，旧快照也一直保留。

修复：

- `skland-account.ts` 的 `domainVerdict` 是唯一判断各域是否读到的函数：只有 `complete` 且没有原因码才算读到（`read`）；有已核对结构的条目才算可用（`usable`）；没读到时给出修法，请求失败按原因给，code 为 0 的回复有问题一律 `report-issue`。
- `sklandRepair` 按「重新粘贴、报告问题、检查时间、稍后再试」的先后取一个修法。
- 条目为零记为无效（`invalid` + `empty-response`），缺少基建记为无效（`not-returned`）。会客室、人力办公室和训练室在参考项目里是可选字段，缺失视为未建造。
- 用到这个判断的地方，现在全部经过它：玩家信息门槛（没有可用干员即 `response-invalid`）、写入锁内的保留或替换、`saved`、`failedDomains`、`repair`、摘要文字，以及 `sklandSnapshot` 写出的覆盖状态（不可用的域清空，不会写成完整或部分）。
- inspect 和 import 的流程抽成导出函数 `runSklandRead`，CLI 只负责输出，一致性测试在进程内调用它。
- 规格正文和两张来源表已登记。

一致性测试：「conformance: every producer of operators, inventory and base against every consumer of the read verdict」。

- 生产路径：干员、仓库、基建各 8 条（请求失败、非 0 code、429、结构不符、下一层字段改名、缺少该域、列表为空、正常），另加两个域同时失败一例，共 22 例。审查员复现的 emptyChars、emptyItems、buildingRoomsRenamed、buildingRenamed 都在其中。基建和干员来自同一个玩家信息请求，请求层的三条与干员相同。
- 每例都在两种情况下核对全部消费方：已有快照时，核对字节是否不变（有域没读到时必须不变）、`saved`、`failedDomains`、`repair`、摘要文字；还没有快照时，核对是否写入、写入的覆盖状态等于输出的覆盖状态、对写入的快照再判断一次结果一致、不可用的域没有残留数据。
- CLI 接线测试同时更新，缺少基建的那一行改为期望 `report-issue`。

先红后绿：先把 CLI 的读取流程原样抽成 `runSklandRead`，判断规则保持原样，再运行新测试。18 项中 3 项失败（缺少基建的覆盖状态、CLI 接线的 `repair`、一致性测试在「干员：下一层字段改名」一例替换了已有快照），日志在已忽略的 `.tmp/skland-round2-red.log`。改为单一规则后 18 项全部通过。审查员的 `empty.ts`（只读，未修改）运行一次，四例的已有快照都没有被替换：emptyChars 退出码 1，另外三例 `saved: false` 且修法为 `report-issue`。

本轮命令：`npm run typecheck` 通过；`tests/skland-account.test.ts` 18 项通过；`tests/skland-scenarios.test.ts` 1 项通过；另运行隐私检查、tracker 和相对链接检查，均无问题。完整离线门禁由协调者统一运行。

## 设计默认值

都登记在[规格](spec.md)「默认值及其来源」以「12」开头的行，日期 2026-11-13：

- 只请求两个固定主机上的六个接口，数据接口只用 GET；不跟随重定向；每个请求 20 秒、单个回复最多 16 MiB。
- 签名头不生成、不伪造设备标识，不冒充森空岛客户端的 User-Agent。
- 两级刷新各最多一次；刷新后仍未授权时再走第二级（比参考项目多一步）；只有换取授权码被明确拒绝才记过期，两级之后仍被拒报 `signature-rejected`、凭据状态不变（第 1 轮修订）；其他失败不记过期，也不自动重试；访问凭证和签名 token 不落盘。
- 多个角色时取森空岛默认角色，没有默认又不止一个时停止。
- 森空岛快照另存为 `account-snapshot-skland.json`，与 MAA 快照共用写入锁；读取失败不写新快照；玩家信息没有已核对的干员结构时按 `response-invalid` 处理、不写入；查询工具要显式传 `snapshotFile` 才用森空岛快照；两份不合并。
- 干员、仓库、基建是否读到只由 `domainVerdict` 判断：只有完整且没有原因码才算读到；条目为零或缺少基建记为无效；有域没读到的读取不替换已有森空岛快照，输出 `saved: false`、`failedDomains` 和一个修法（code 为 0 的回复有问题为报告问题）；只有还没有森空岛快照时才保存部分快照并在 `coverage` 写明原因；判断在写入锁内（第 1 轮由协调者选定，第 2 轮改为单一规则函数）。会客室、人力办公室和训练室缺失视为未建造。
- 转换：单项越界记未知并写原因，结构错误使该域无效；模组锁定记 0；技能专精按列表顺序；基建只记房间、驻员和心情原始值及其时间；不写账号标识、理智和公招；原扫描时间为空。
- 对比只比较两边都已知的字段，Markdown 每类最多列 50 条。

## 未验证

- 真实森空岛服务：没有真实 token，也没有调用真实服务。需要维护者在本机用自己的 token 运行一次 `skland-account.ts inspect`，对照森空岛 App，核对换取、签名（空的 `platform`／`dId`／`vName`、不冒充客户端 UA）、两级刷新和全部字段。
- 拒绝信号：换取失败时 `status` 的取值、10000 和 10002 现在的含义，需要一个已失效 token 的真实回复。
- 养成接口的物品范围、是否返回 `4001`（龙门币）；技能列表顺序是否等于第 1–3 技能；锁定模组的 `level` 含义；`charInfoMap` 的稀有度编码（只有一个参考项目）。
- 森空岛数据相对游戏内的滞后时间。
- 真模型前后评测和新增三个场景的模型运行（工单 26）。
