# setup 现有环境接入验证

2026-11-11，工单 07 候选从 06 squash `788ac13febf35a54e556fa527943c01431b8e215` 实施。当前仍进行中：作者验证不能代替独立审查、真模型或原生远程安装验收。来源及设计限制见 [来源核对](setup-sources.md)和 [规格](spec.md)。

## 实现及测试先行

- 首次只读检查缺失设置、重复读取现场、首次语言与私有目录、仅创建私有骨架及环境记录：先观察缺少 setup 导出函数的失败，再实现；已存在账号文件保持原字节，设置仍由真实 preferences 接口写。
- adb 发现／多候选需选／失效 adb／显式路径地址缩小／失败连接：先缺导出失败，再实现。只替代 adb 进程边界，真实临时文件；调用参数断言只出现 devices、connect、指定设备 get-state。显式候选未缩小范围及 malformed ClientType 接受问题分别先失败后修复。
- 连接写入：先缺导出失败，再扩展原 writer。关闭确认、备份、记录、原字段保留、重复运行无写入；活跃锁、测试期间配置漂移、关停切换当前配置、重开失败与 doctor 恢复有组合测试。恢复相对 adb 路径／空地址先失败，再修复原值白名单。没有复制第二套写入、关停或锁实现。
- CLI：先观察无入口时 exit 0 的失败，再实现 0/1/2 与白名单错误输出；错误输入不创建设置或下载文件。Node 22／25 与非 Windows 的纯输入检查经导出函数验证，实际环境使用 Node 24。缺少 Node 的行为由 skill 的 `node --version` 前置步骤承接，未伪造旧 Node 二进制执行。
- 新 skill 的五个固定行为场景提交为 `ecf06bb`，导出 `eval/maa-setup/scenarios.ts` 的 `setupScenarios`。两个临时原生目录各实际执行五组共享 CLI，离线文件差异与调用评分通过。这是运行器接缝验证，不是模型回答、语言或确认语义通过。

环境限制如实保留：初次在 Windows 沙箱默认 Temp 中 preferences 原子改名报 EPERM；把 TEMP／TMP 指向本 worktree 的 `.tmp/test-temp` 后同测试通过，产品未增加重试或改名绕行。首次 `npm ci --ignore-scripts --cache .tmp/npm-cache` 在沙箱因 registry DNS ENOTFOUND 失败；权限对照后按 lockfile 安装成功，再运行类型检查。未触碰已安装 skill、真实 MAA／adb／模拟器、真实私有目录或用户认证。

完整离线入口首次沙箱运行保留 `.tmp/07-offline-check.log`：既有目录联接 EPERM、临时 GUI 编译及本机 loopback 网络夹具受限而失败。使用相同 TEMP/TMP 和产品，在权限对照下 `.tmp/07-offline-check-elevated.log` 为 305 项：303 通过、2 条件跳过（本文件系统不提供短路径别名、非 Windows 的原生边界拒绝用例在 Windows 跳过）。tracker、隐私、链接／元数据及 7 规则／14 评分样例均通过；`npm run typecheck` 通过。烟测宿主元数据补齐后，15 项 setup 场景／双布局 CLI／公开 smoke 定向测试及类型检查再次通过；无产品代码变化。

最终完整离线复跑 `.tmp/07-offline-final.log` 同为 305 项、303 通过、2 条件跳过，tracker／隐私／元数据和评分规则自检全部通过。工单仍进行中，等待独立审查和根任务外部验收。

逐文件人工核对本包的代码、注释、文档、测试、版本记录和许可证：只含合成名称／地址、公共来源／指纹和相对证据位置，没有真实账号基线、机器路径、凭据或游戏数据。自动隐私检查再次为空；不将启发式扫描视为任意秘密可被识别的保证。

## 模型、安装和审查

改前 core/help/daily/doctor 原字节 archive 保存在本机忽略目录 `.tmp/07-before/payload.tar`；SHA-256 `e7e99905ebba2f99d4eb01b399cac9522fcb662c36660985d396922ad8b8bf6b`。原始 Git payload 为 `788ac13`。现有评测运行器、评分器和场景未改，新 setup 场景固定后由根任务使用同框架分别运行旧载荷与最终载荷。受影响集合为 help、core、daily、doctor；setup 新建基线。当前作者未运行真模型，不能宣称分数不下降。

真实设备、MAA.exe 的实际 ProductVersion 内容、模拟器专属连接预设／截图／游戏任务均未验证。版本列表两个数组为空；MAA v6.21.4 只做局部字段来源核对，不登记为本仓库源码已核或实机已核。Windows 之外只运行开发检查，不是产品支持范围。

完整独立审查、固定远程双宿主原生安装／更新、双平台 CI、真实模型尝试与可比性由根任务追加实际结果。作者不写“审查通过”，也未决定豁免模型门禁。

2026-11-11 根代理依据维护者常规推进授权，对 07 单独作出有条件交付决定：仅隔离认证不可用可延后模型发布验收，完整独立产品复核、离线/类型、双平台 CI、固定双宿主原生安装与实际 CLI 检查／首次设置／安全连接写入验证，以及全部真实模型前后和新 setup 尝试留存后，方能交付实现。实际模型完成后的失败／回归不能改成 unverified 或自动延期；不冒称用户明确免测，也不从其他票继承。setup 的成功基线与语言／现场／偏好／关闭确认／连接／不下载语义、help/core/daily/doctor 分数不降均在 [26](issues/26-v0-1-0-release-validation.md) 硬阻塞发布。

根任务已报告：固定 ecf 框架与旧 payload 788ac13 的 36 次实际调用完成（18 次 Codex 401、18 次 Claude 未登录；0 完成、0 runner failure），证据位于根任务忽略目录 `.tmp/07-model-evidence/frozen-models-39mcHH`。旧尝试不能证明候选通过，最终后态与 setup 新基线仍待实际运行及独立核对。

临时安装 CLI smoke 可执行 `node scripts/setup-smoke.ts <已安装 maa-core 的绝对目录> [codex|claude]`（默认 codex），另需同版 `tests/fixtures/setup-boundary.mjs`。脚本只读安装目录，使用新的临时 home、合成 MAA/adb 文件；实际执行 preferences 首次设置、check、prepare、discover、test、关闭未确认拒绝、确认后 apply、重复 unchanged，核配置、备份、事务宿主与进程边界记录。loader 只替代精确安装 setup／共用候选模块的 adb/版本元数据进程调用和 writer 的 MAA 进程模块，不替换文件系统、Node 版本、配置 writer 或内部函数。显式 adbPaths/addresses 将发现限定到合成路径，未扫描真实模拟器；结果不能冒称真实设备连接通过。

## R1 失败、修复及验证

完整独立 [R1 原文](reviews/2026-11-11-07-setup-r1.md)原样保留，结论要求修改：S1 一致连接漏查锁、S2 普通 writer 连接权限过宽、S3 损坏设置缺具体检查、T1 Windows 短路径夹具错拒，四项均接受。原候选 `847c07e` 的 Windows CI run `42918403791` / job `130186684875` 为 305 项、298 pass、6 fail、1 skip；Ubuntu 通过。此历史失败不会由本机通过覆盖，修后固定新候选双平台 CI 仍待根任务实际验证。

[逐项处置](reviews/2026-11-11-07-setup-r1-fixes.md)记录测试先行及拒绝绕过的设计。原公开探针先复现 4 pass／4 fail，修后 8／8 通过；新增测试覆盖 active／stale／损坏锁及实际重开失败后再次 apply、普通 writer 导出与 CLI 拒绝连接、setup 拒绝异种授权并自己复测、损坏或无法读取设置的逐项诊断和保留。恢复原相对 adb 路径、空地址、开关及关停配置漂移仍通过。T1 统一 fs.promises.realpath／realpathSync.native 的原生身份，明确拒绝异目录同名 adb；五个固定场景及原评测框架不变。

修后完整入口的沙箱运行 `.tmp/07-r1-offline-sandbox.log`：322 项、299 pass、20 fail、3 skip，失败来自既有 junction EPERM、临时 GUI 编译和本机 loopback 夹具限制。相同产品与 TEMP/TMP 的正常权限对照 `.tmp/07-r1-offline-normal-permission.log`：322 项、319 pass、0 fail、3 skip，tracker／privacy／metadata 无问题，评分规则 7／样例 14 通过。三项跳过分别为已有 help 短路径、新增 setup 短路径（本文件系统无 8.3 alias）和 Windows 上的非 Windows 边界用例；短路径未在本机执行通过。`npm run typecheck`、`node scripts/tracker.ts --write` 与差异空白检查通过。

逐文件检查本次四项修复的产品、测试、skill、spec 和审查记录，新增内容仅含合成目录/地址、公共来源与日志引用；自动隐私检查为空。原审查报告复制前后的 SHA-256 均为 `65181bb9ba820db4aadfa763f62eb378919f1e694d56d940afe616892975dadc`。当前仍等待实际主线整合、R2 与根任务外部验证，未勾验收、未解除 08／09、未自行运行模型或追加审查员。
