# setup 现有环境接入验证

## 当前交付结论

固定产品 `df726403d9b4094327bbaf10204946ecdc202dcd` 的[完整独立 R2](reviews/2026-11-11-07-setup-r2.md) 已通过：Standards / Spec 均 0 项真实错误，R1 四项修复全部通过复核。独立完整入口 383 项中 380 pass、3 条件 skip，类型、区间 diff 和 11 项独立公开探针通过；精确双平台 CI、固定双宿主原生安装及实际 CLI 对照、全部 122 次模型尝试留存均已独立核对。07 单票有条件实现交付前提已满足，工单记实现验收完成；[PR42](https://github.com/VincentChen0111/maa_skills/pull/42) 待最终文档提交的 CI 和 squash 交付。

122 次模型尝试全部因隔离认证不可用而 unverified，没有成功基线、语义验收或分数不降结论，仍由 [26](issues/26-v0-1-0-release-validation.md) 硬阻塞发布。真实 MAA/模拟器/游戏及实际 ProductVersion 内容未验证。首次原生重开 unknown 的根因仍未唯一确定，未改产品/辅助程序的唯一完整对照通过只证明该固定载荷本次流程可用，不证明旧故障已修或所有运行稳定。以下当前证据与历史记录分列，原 R1 FAIL、旧 CI FAIL 和首次原生失败均保留。


## 最终固定产品证据

固定产品 `df726403d9b4094327bbaf10204946ecdc202dcd` 基于实际 main `fc633d680f82c9edb224ca4bd9065c20797ea885`。根任务已核对[精确提交 CI run 42931175881](https://github.com/VincentChen0111/maa_skills/actions/runs/42931175881) 的 Windows / Ubuntu 两个 job 均通过。Windows 为 383 项：382 pass、0 fail、1 skip，help 和 setup 的真实 8.3 路径用例实际执行通过；本机完整检查 380 pass / 3 skip 的限制仍按下文保留。原候选 Windows CI 的失败不由新候选通过覆盖。

固定候选的四批改后实际模型调用已经结束，原场景、模型、CLI 与框架保持：

| 改后原始证据（根工作树忽略目录） | 框架 | 实际调用 |
| --- | --- | --- |
| `.tmp/07-after-core-help-evidence/frozen-models-h2qrFU` | ecf06bb / 495281064e71025a4553d07d340a241c3f11539ca90d2ce5134512bb24971476 | core 6 + help 6，共 12 |
| `.tmp/07-after-daily-evidence/frozen-models-8XWIWu` | 同上 | daily 14 |
| `.tmp/07-after-setup-doctor-evidence/frozen-models-kfek1M` | 同上 | doctor 10 + 新 setup 基线尝试 10，共 20 |
| `.tmp/07-after-integration-evidence/frozen-models-1k3Mmt` | 991c7e0 / 07becf7a4cd2155771ea05fecd841b9480bccb930fcf5d056568c250e14c39b6 | stage 12 + training 8，共 20 |

改前 56 + 改后 66 = 122 个唯一实际记录，61 Codex 401 / 61 Claude 未登录，全部 unverified，0 模型完成、0 runner failure。独立审查员已逐批核对 raw/evidence/record/manifest 与 Git 字节，重新构造合成 fixture 核场景与 skill 指纹；根 `.tmp/review-07-r2-prep/audit-after-{core-help,daily,setup-doctor,integration}.json` 与 `comparison-all.json` 保留审计。四批改后 manifest 文件数依次 113/114/140/170，对应 Git blob 113/114/116/142。56 对回归的模型/CLI/场景匹配仍全 unverified，另 10 次仅为新 setup 基线尝试，不能声称成功基线或分数不降。四批 fixture 清理与相关进程记录均为 0；独立正常权限 CIM 已核六批关联进程为 0，原沙箱 CIM 访问失败没有被当作进程已清。模型未验证与完整产品 R2 通过分别记录。

首次固定原生验证 `.tmp/native-check-GghOle` 实际失败，15 条命令原样留存：安装/更新完成后，Codex 已安装 writer 的普通提醒写入在 restart 阶段返回 unknown / reconciliation-required。配置值已变，原锁、备份、pending/run、GUI 日志、launch 参数与 cleanup / 相关进程 0 证据全部保留；没有运行到本票 setup 正向 smoke，也不把该批记为原生通过。GUI 事后日志出现 Init True，仍不能证明当次进程观察已及时成功或归属正确。

诊断在新的合成目录复用该失败批的已安装固定产品和同字节合成 GUI：一次继承环境、一次使用同 frozen native-env 的隔离环境公开导出对照均 complete、读回、正常关闭。严格隔离对照记录 13 次真实 PowerShell 进程命令均无错误，455–742 ms，start 约 1.908 秒；三个精确合成路径独立 CIM 残留 0。诊断前另有证据路径 ENOENT 与 Windows --import URL 错误，两次均未进入产品，原日志保留。作者树 `.tmp/07-native-diagnosis/diagnosis.md`、`process-summary.json`、`process-cleanup.json` 保存脱敏结论。原始进程 trace 含非选中实例私人路径，只留本机忽略目录，不公开；未操作该实例。没有修改产品、超时、fixture、native helper 或成功判据。

首次原生失败根因仍未唯一确定，不能把它归因为已证实的环境/负载问题，不能把后来的局部成功当作已修复。在并行模型/检查结束后，根任务用同固定 head 和未改 helper 做了唯一一次完整原生对照，结果见下段；完整独立 R2 已核对这两批原生和诊断证据，确认符合既有单票实现交付前提，未将原失败改写为通过。07 仅完成实现验收；真实 MAA/模拟器/游戏、实际 ProductVersion 内容及模型语义仍未验证。成功 setup 基线与 help/core/daily/doctor/stage/training 分数不降仍由 [26](issues/26-v0-1-0-release-validation.md) 硬阻塞发布。下方历史章节保留其当时状态及原始 FAIL，不用于覆盖当前验证边界。


完整对照 `.tmp/native-check-jeMvrK/native-evidence.json` 实际 exit 0、status pass：26 条命令中仅 Codex 重复安装的 1 条预期拒绝为非零。两宿主完成真实安装/更新、普通提醒事务、读回/备份/锁释放/正常关闭，以及已安装 setup CLI 的首次偏好、关闭未确认拒绝、确认后连接写入、重复 unchanged、各 1 份备份及正确 transactionHost。setup 的 adb/MAA 边界为合成替身，realDevice=false，不代表真实设备连接通过。正常权限相关进程检查为 0。根 payload audit 已实际通过，37 个 Codex + 233 个 Claude 仓库文件共 270 个精确匹配 df72640；655 个宿主生成依赖只单列 hash/lock metadata，未独立核 registry 包原始字节。完整 R2 已逐字节核对两次原生验证的四份冻结源、同固定 Git 的两份 smoke/fixture、26 份实际命令与安装载荷；源完全相同，最终及首轮/诊断关联合成进程独立 CIM 为 0。审计位于根 `.tmp/review-07-r2-prep/audit-native.json` 与 `process-final-native.json`。该完整对照成功不能确定 GghOle 的旧失败原因或称其已修复，两批原文均保留。

## 历史：实际 15/24 主线整合候选，R2 前

07 已从原基点 rebase 到实际 main `fc633d680f82c9edb224ca4bd9065c20797ea885`（24 的 PR43 squash，包含 15/06）。完整 R1 四项修复保持；共享 writer 合并保留三次作业文件校验、训练资产持锁安装/readback/manifest、job/training/medicine 互斥，以及 06 严格 transaction schema 与未知附加资源拒绝。setup 仍在内部重新发现/选择/复测，只生成当前四字段连接差异；恢复宽格式仅用于已核单配置事务，没有新增通用授权或放宽资产恢复。

新增公开导出接缝 `tests/setup-integration.test.ts` 使用真实临时 FS、合成数据和 MAA/adb 进程替身，验证完整 jobPlan/trainingPlan/medicineCount 不能放入 setup 请求或 context，普通 writer 不能借这三种授权写连接；实际先写批准作业和训练资产再接入，除当前连接外原配置、任务、定时及资产保持；实际子进程重开失败后退出的 job/training 事务，setup 返回 unknown，doctor 两种修法均拒绝并保留原锁/配置/记录。此轮是在既有 R1 修复与实际 main 合并后的回归验证，首次运行已经通过，没有伪造新的行为红测；原 R1 红测与失败 CI 记录不变。

| 本轮实际检查 | 结果及证据 |
| --- | --- |
| setup/integration/scenarios/training-integration 定向 | 51 项，50 pass、0 fail、1 skip；`.tmp/07-integration-targeted.log`。skip 为文件系统无 8.3 别名 |
| 完整离线，受限沙箱 | 383 项，360 pass、20 fail、3 skip；`.tmp/07-integration-check-sandbox.log`。既有 junction EPERM、临时 GUI 编译和 loopback 网络限制，原日志保留 |
| 相同产品、TEMP/TMP 的正常权限完整离线对照 | 383 项，380 pass、0 fail、3 skip，tracker/privacy/metadata 为空，7 规则/14 样例通过；`.tmp/07-integration-check-normal.log` |
| 类型检查 | 首次新增测试未缩窄 nullable asset，2 个 TS18047 保留于 `.tmp/07-integration-types.log`；增加公开结果非空断言后 `npm run typecheck` 通过，`.tmp/07-integration-types-final.log`。未放宽产品类型 |

完整入口三项 skip：已有 help 与新增 setup 短路径用例因本文件系统无 8.3 alias；非 Windows 边界拒绝用例在 Windows 跳过。真实临时 Windows GUI 的进程适配器用例正常权限下实际执行通过，但不代表真实 MAA/模拟器/游戏。未改变五个冻结 setup 场景、旧评测框架、原生 smoke CLI 或精确 fixture；`scripts/setup-smoke.ts <installed-core> [codex|claude]` 与 `tests/fixtures/setup-boundary.mjs` 逐字节等于 R1 修复候选 `1bf779c`。

根任务与独立审查员已核对附加改前批次 `.tmp/07-integration-before-evidence/frozen-models-xyj44e`：框架/载荷 `991c7e0b55df92f53ae3170e7215c6c5fb96cc50`，框架 hash `07becf7a4cd2155771ea05fecd841b9480bccb930fcf5d056568c250e14c39b6`；stage 12 + training 8，共 20 次实际调用，10 Codex 401 + 10 Claude 未登录，全部 unverified，0 完成/runner failure/fixture 或进程残留。该载荷不是 main；根任务与审查员实际核对其到 fc633d6 的 skills/scripts/eval/tests/package/lock/.github 字节无差异。独立核 164 manifest 文件及 114 Git blob，raw/hash/grade/场景/skill version/实际参数，证据位于根 `.tmp/review-07-r2-prep/audit-integration-before.json` 与 `process-integration-before.json`。

旧改前 36 次独立批次保持 `.tmp/07-model-evidence/frozen-models-39mcHH`，ecf 框架 hash `495281064e71025a4553d07d340a241c3f11539ca90d2ce5134512bb24971476`、payload 788；18 Codex 401 + 18 Claude 未登录，全部 unverified。审查员核对 137 manifest 文件/109 Git blob/36 raw 与重新构造合成 fixture 的场景及 skill version，独立 CIM 残留 0，`.tmp/review-07-r2-prep/audit-before.json` 与 `process-before.json`。这些是实际前态证据，不能证明改后通过或分数不降。

公开前逐文件核对本轮完整包的代码、注释、文档、许可证、版本记录及合成测试；没有真实账号、用户凭据、私有机器路径或真实 MAA/游戏数据。保留 R1 原始报告字节与所有原始失败，不修改旧日志。最终独立调用 privacy/metadata/tracker 及实际 base 区间 diff-check 均通过；INDEX 只由 tracker 生成。

最终固定候选双平台 CI、远程双宿主原生安装/更新和真实 CLI 接入、两批改后模型及新 setup 基线尝试、完整独立 R2 仍由根任务完成；作者未将它们记为通过。07 保持进行中，不解除 08/09；07 单票条件交付与 26 硬门禁不变，受影响模型范围补齐 stage/training，并同步规格两张来源表与 26。下文均为原候选历史，原 R1 FAIL、Windows CI FAIL 和未验证记录不改写。

## 历史：原基点实现

2026-11-11，工单 07 候选从 06 squash `788ac13febf35a54e556fa527943c01431b8e215` 实施。当前仍进行中：作者验证不能代替独立审查、真模型或原生远程安装验收。来源及设计限制见 [来源核对](setup-sources.md)和 [规格](spec.md)。

## 历史：实现及测试先行

- 首次只读检查缺失设置、重复读取现场、首次语言与私有目录、仅创建私有骨架及环境记录：先观察缺少 setup 导出函数的失败，再实现；已存在账号文件保持原字节，设置仍由真实 preferences 接口写。
- adb 发现／多候选需选／失效 adb／显式路径地址缩小／失败连接：先缺导出失败，再实现。只替代 adb 进程边界，真实临时文件；调用参数断言只出现 devices、connect、指定设备 get-state。显式候选未缩小范围及 malformed ClientType 接受问题分别先失败后修复。
- 连接写入：先缺导出失败，再扩展原 writer。关闭确认、备份、记录、原字段保留、重复运行无写入；活跃锁、测试期间配置漂移、关停切换当前配置、重开失败与 doctor 恢复有组合测试。恢复相对 adb 路径／空地址先失败，再修复原值白名单。没有复制第二套写入、关停或锁实现。
- CLI：先观察无入口时 exit 0 的失败，再实现 0/1/2 与白名单错误输出；错误输入不创建设置或下载文件。Node 22／25 与非 Windows 的纯输入检查经导出函数验证，实际环境使用 Node 24。缺少 Node 的行为由 skill 的 `node --version` 前置步骤承接，未伪造旧 Node 二进制执行。
- 新 skill 的五个固定行为场景提交为 `ecf06bb`，导出 `eval/maa-setup/scenarios.ts` 的 `setupScenarios`。两个临时原生目录各实际执行五组共享 CLI，离线文件差异与调用评分通过。这是运行器接缝验证，不是模型回答、语言或确认语义通过。

环境限制如实保留：初次在 Windows 沙箱默认 Temp 中 preferences 原子改名报 EPERM；把 TEMP／TMP 指向本 worktree 的 `.tmp/test-temp` 后同测试通过，产品未增加重试或改名绕行。首次 `npm ci --ignore-scripts --cache .tmp/npm-cache` 在沙箱因 registry DNS ENOTFOUND 失败；权限对照后按 lockfile 安装成功，再运行类型检查。未触碰已安装 skill、真实 MAA／adb／模拟器、真实私有目录或用户认证。

完整离线入口首次沙箱运行保留 `.tmp/07-offline-check.log`：既有目录联接 EPERM、临时 GUI 编译及本机 loopback 网络夹具受限而失败。使用相同 TEMP/TMP 和产品，在权限对照下 `.tmp/07-offline-check-elevated.log` 为 305 项：303 通过、2 条件跳过（本文件系统不提供短路径别名、非 Windows 的原生边界拒绝用例在 Windows 跳过）。tracker、隐私、链接／元数据及 7 规则／14 评分样例均通过；`npm run typecheck` 通过。烟测宿主元数据补齐后，15 项 setup 场景／双布局 CLI／公开 smoke 定向测试及类型检查再次通过；无产品代码变化。

最终完整离线复跑 `.tmp/07-offline-final.log` 同为 305 项、303 通过、2 条件跳过，tracker／隐私／元数据和评分规则自检全部通过。工单仍进行中，等待独立审查和根任务外部验收。

逐文件人工核对本包的代码、注释、文档、测试、版本记录和许可证：只含合成名称／地址、公共来源／指纹和相对证据位置，没有真实账号基线、机器路径、凭据或游戏数据。自动隐私检查再次为空；不将启发式扫描视为任意秘密可被识别的保证。

## 历史：模型、安装和审查

改前 core/help/daily/doctor 原字节 archive 保存在本机忽略目录 `.tmp/07-before/payload.tar`；SHA-256 `e7e99905ebba2f99d4eb01b399cac9522fcb662c36660985d396922ad8b8bf6b`。原始 Git payload 为 `788ac13`。现有评测运行器、评分器和场景未改，新 setup 场景固定后由根任务使用同框架分别运行旧载荷与最终载荷。受影响集合为 help、core、daily、doctor；setup 新建基线。当前作者未运行真模型，不能宣称分数不下降。

真实设备、MAA.exe 的实际 ProductVersion 内容、模拟器专属连接预设／截图／游戏任务均未验证。版本列表两个数组为空；MAA v6.21.4 只做局部字段来源核对，不登记为本仓库源码已核或实机已核。Windows 之外只运行开发检查，不是产品支持范围。

完整独立审查、固定远程双宿主原生安装／更新、双平台 CI、真实模型尝试与可比性由根任务追加实际结果。作者不写“审查通过”，也未决定豁免模型门禁。

2026-11-11 根代理依据维护者常规推进授权，对 07 单独作出有条件交付决定：仅隔离认证不可用可延后模型发布验收，完整独立产品复核、离线/类型、双平台 CI、固定双宿主原生安装与实际 CLI 检查／首次设置／安全连接写入验证，以及全部真实模型前后和新 setup 尝试留存后，方能交付实现。实际模型完成后的失败／回归不能改成 unverified 或自动延期；不冒称用户明确免测，也不从其他票继承。setup 的成功基线与语言／现场／偏好／关闭确认／连接／不下载语义、help/core/daily/doctor 分数不降均在 [26](issues/26-v0-1-0-release-validation.md) 硬阻塞发布。

根任务已报告：固定 ecf 框架与旧 payload 788ac13 的 36 次实际调用完成（18 次 Codex 401、18 次 Claude 未登录；0 完成、0 runner failure），证据位于根任务忽略目录 `.tmp/07-model-evidence/frozen-models-39mcHH`。旧尝试不能证明候选通过，最终后态与 setup 新基线仍待实际运行及独立核对。

临时安装 CLI smoke 可执行 `node scripts/setup-smoke.ts <已安装 maa-core 的绝对目录> [codex|claude]`（默认 codex），另需同版 `tests/fixtures/setup-boundary.mjs`。脚本只读安装目录，使用新的临时 home、合成 MAA/adb 文件；实际执行 preferences 首次设置、check、prepare、discover、test、关闭未确认拒绝、确认后 apply、重复 unchanged，核配置、备份、事务宿主与进程边界记录。loader 只替代精确安装 setup／共用候选模块的 adb/版本元数据进程调用和 writer 的 MAA 进程模块，不替换文件系统、Node 版本、配置 writer 或内部函数。显式 adbPaths/addresses 将发现限定到合成路径，未扫描真实模拟器；结果不能冒称真实设备连接通过。

## 历史：R1 失败、修复及验证

完整独立 [R1 原文](reviews/2026-11-11-07-setup-r1.md)原样保留，结论要求修改：S1 一致连接漏查锁、S2 普通 writer 连接权限过宽、S3 损坏设置缺具体检查、T1 Windows 短路径夹具错拒，四项均接受。原候选 `847c07e` 的 Windows CI run `42918403791` / job `130186684875` 为 305 项、298 pass、6 fail、1 skip；Ubuntu 通过。此历史失败不会由本机通过覆盖，修后固定新候选双平台 CI 仍待根任务实际验证。

[逐项处置](reviews/2026-11-11-07-setup-r1-fixes.md)记录测试先行及拒绝绕过的设计。原公开探针先复现 4 pass／4 fail，修后 8／8 通过；新增测试覆盖 active／stale／损坏锁及实际重开失败后再次 apply、普通 writer 导出与 CLI 拒绝连接、setup 拒绝异种授权并自己复测、损坏或无法读取设置的逐项诊断和保留。恢复原相对 adb 路径、空地址、开关及关停配置漂移仍通过。T1 统一 fs.promises.realpath／realpathSync.native 的原生身份，明确拒绝异目录同名 adb；五个固定场景及原评测框架不变。

修后完整入口的沙箱运行 `.tmp/07-r1-offline-sandbox.log`：322 项、299 pass、20 fail、3 skip，失败来自既有 junction EPERM、临时 GUI 编译和本机 loopback 夹具限制。相同产品与 TEMP/TMP 的正常权限对照 `.tmp/07-r1-offline-normal-permission.log`：322 项、319 pass、0 fail、3 skip，tracker／privacy／metadata 无问题，评分规则 7／样例 14 通过。三项跳过分别为已有 help 短路径、新增 setup 短路径（本文件系统无 8.3 alias）和 Windows 上的非 Windows 边界用例；短路径未在本机执行通过。`npm run typecheck`、`node scripts/tracker.ts --write` 与差异空白检查通过。

逐文件检查本次四项修复的产品、测试、skill、spec 和审查记录，新增内容仅含合成目录/地址、公共来源与日志引用；自动隐私检查为空。原审查报告复制前后的 SHA-256 均为 `65181bb9ba820db4aadfa763f62eb378919f1e694d56d940afe616892975dadc`。当前仍等待实际主线整合、R2 与根任务外部验证，未勾验收、未解除 08／09、未自行运行模型或追加审查员。
