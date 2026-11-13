# doctor 完整检查与转介验证记录

2026-11-13，工单 [10](issues/10-doctor-checks-referral.md) 在分支 `claude/10-doctor-checks` 实施，叠在 09 已审查、尚未合并的头 `6df8ed0`（基于 `origin/main` `4a1fd26`）上，因为 10 被 09 阻塞。实施进度：进行中，等待独立审查，尚未合并。06 的遗留写入核对见 [doctor 配置与遗留锁验证](doctor-verification.md)，MAA 事实见 [doctor 来源](doctor-sources.md)。

## 交付内容

- `skills/maa-core/scripts/checks.ts`：setup 和 doctor 共用的原因、修法和执行者表，八组的划分，执行者为 skill 的修法写明执行它的现有入口（`channel`）。
- `skills/maa-core/scripts/maa-version.ts`：MAA 版本的接缝（07 的读法原样迁入）。`readVerificationRecord` 读随包核实记录，`assessMaaVersion` 给出提醒；setup 和 doctor 都调用它。工单 25 在这里换成生成的核实记录并加上「有已核实的新版本」提醒，两个调用方随之一起变。
- `setup.ts`：安装组提成 `inspectInstallation`，setup 的 `check` 与 doctor 共用；核实记录为空时原因改为 `verification-record-empty`，返回的 `version` 多了 `recordEmpty`。
- `setup-connection.ts` 的 `inspectConnection`：只运行 `adb devices` 的只读连接检查。`maa-config.ts` 的 `inspectManagedFields`：按写入器的规则核对本项目写入的字段类型与范围。
- `doctor-checks.ts`：远程控制、私有文件、skill 版本（可选的 GitHub 发布查询）和目录联接检查。
- `maa-log.ts`：解析 `asst.log` 的结构化回调、划分运行、分类失败、白名单取证据和现场图路径。
- `doctor.ts`：`check` 八组（`--online` 可选）、新增 `analyze`、`repair` 规则不变；最近记录 `doctor-latest.json` 和 `doctor-analysis-latest.json`。
- `skills/maa-core/package.json` 带插件版本，`scripts/metadata.ts` 要求它与根版本一致。
- 文档：maa-doctor 的 SKILL、[检查与恢复接口](../skills/maa-doctor/references/checks.md)、新增[排查与转介对照](../skills/maa-doctor/references/triage.md)；maa-core、maa-help、maa-setup 参考、README、宿主说明、术语表；规格「检查与修法」新增一条，两张来源表各新增条目。
- 评测场景：`eval/maa-doctor/scenarios.ts` 原六个场景的期望记录换成八组结果，新增 `doctor-remote-control`、`doctor-unknown-run`。

## 验收对照

| 验收 | 证据 | 状态 |
| --- | --- | --- |
| 1 八类检查入口，各项给出状态、原因、修法和执行者 | `tests/doctor-checks.test.ts`「doctor covers the eight check groups …」：18 条检查的顺序、八组齐全、每条字段完整、skill 修法都有 `channel`，安装组与 `checkSetup` 逐项相同；各组的正常/提醒/错误样例见同文件各测试 | 离线通过 |
| 2 只读诊断、逐项批准、可一次点名多项、走已有通道 | `tests/doctor.test.ts` 06 的点名批准、互斥、证据漂移等全部保留通过；「every skill-executed repair names an existing channel script and action …」核对每个 skill 修法的入口脚本和动作存在；检查前后配置、锁、私有记录字节不变（各检查测试） | 脚本层离线通过；跨入口的一次点名多项由 skill 逐项执行，模型行为未验证 |
| 3 按结构化回调判断，退出码 0 不算成功，证据不足为未知；环境类单独成类，模型决定，不按次数转交，未知不重放 | `tests/doctor-analysis.test.ts`「callback lines are parsed structurally …」「structured callbacks decide the outcome …」（出错后的完成标记、无结束回调、只含关键字的噪声、退出码 0）、「only the latest run is analysed …」（重试成功的 ConnectFailed 不算失败）、「environment failures report cause, evidence and current state …」（断开、分辨率、内存不足，重复三次仍不转交） | 离线通过 |
| 4 先查明原因再转介；识别失败先排除分辨率、遮挡、连接 | 同文件「recognition failures are referred only after …」（未确认遮挡时 pending，结论不能跳过，确认后 ready；分辨率变化时归环境类不转介）、「an exception inside MAA is referred …」 | 离线通过 |
| 5 skill 更新和 MAA 核实版本记录；未核实只提醒，列表为空如实说明 | `tests/doctor-checks.test.ts`「MAA version records only warn …」「the packaged empty verification record is stated as empty …」「skill version compares …」「the GitHub release lookup …」；`tests/metadata.test.ts` 新测试 | 离线通过；真实发布查询未验证（当日仓库尚无发布，接口返回 404） |
| 6 人读/JSON、0/1/2、最近记录；凭据、账号标识、连接地址、完整配置不进入摘要 | `doctor-checks` 的 CLI 测试与 `doctor.test.ts` 的 CLI 测试（check）；`doctor-analysis` 的 CLI 测试（analyze：输入校验、缺日志、私有目录被占用时退出 2、记录与输出相同）；各测试断言输出和记录里没有配置名、地址、路径 | 离线通过 |
| 7 对照官方日志分析说明整理检查项与转介情形 | [排查与转介对照](../skills/maa-doctor/references/triage.md)逐类列出本机只读检查和只能转介的情形并注明官方小节；[doctor 来源](doctor-sources.md)记固定提交、指纹和供 25 登记的依赖条目 | 文档完成；随 MAA 版本的变化由 25 跟踪 |
| 8 转介摘要固定结构；关键证据写时间段、消息名、`what`；现场图相对路径；脱敏有单独测试 | `doctor-analysis`「recognition failures …」断言五部分结构、证据字段和相对路径；单独的「the referral summary and latest analysis record never carry …」用带 12 个合成秘密标记的日志断言 JSON、人读输出和记录都没有泄漏；「evidence tokens keep MAA task names …」 | 离线通过 |
| 9 远程控制只读检查 | `doctor-checks`「remote control reports only configured or not …」：当前配置、其他配置、空端点、缺失四种合成配置，断言只有已配置/未配置、修法为用户、输出和记录里没有端点和标识；位置和「留空即停用」在固定源码上核对（见来源） | 离线通过；真实 MAA 上未验证 |

## 评测

- 离线：`tests/doctor-scenarios.test.ts` 在 `.agents` 和 `.claude` 两种布局里用实际安装的 CLI 跑完八个场景的预期调用，并用评分规则判分（含远程控制场景的三个合成标记不得出现在输出里）。这是评测链路自检，不是模型完成任务。
- 没有加入带真实 `asst.log` 的转介场景：当前评测夹具只能写 JSON 输入，写不出原始日志行；`doctor-unknown-run` 只覆盖缺日志时的「未知、不重放」。带日志的转介场景要等评测夹具支持原始文件（工单 28 正在重写），未验证。
- 真模型评测：未运行（工单 28 未交付、评测登录目录未就绪）。maa-doctor 与 maa-help 的 skill 文字改动前后对比、doctor 新场景的模型基线都未验证，移交 26。

## 实际运行的命令与结果

本机 Windows 11、Node 24.22.1。临时目录与合成样例，未触碰真实 MAA、已安装 skill 或私有目录。

- `npm ci --ignore-scripts`：成功。`npm run typecheck`：在最终提交上通过。
- 先失败后通过的记录：`tests/doctor-checks.test.ts` 在 maa-core 没有版本字段时 22 项中 1 项失败（skill 版本），补上后 22/22；`tests/metadata.test.ts` 新测试在实现前 2 项中 1 项失败，实现后 2/2。
- 单文件：`tests/doctor-checks.test.ts` 22/22；`tests/doctor-analysis.test.ts` 18/18；`tests/doctor.test.ts` 74/74（06 的全部恢复测试）；`tests/setup.test.ts`、`tests/setup-scenarios.test.ts`、`tests/credentials.test.ts` 合计 57/57（安装组重构后）；`tests/doctor-scenarios.test.ts` 17/17（两种布局各八个场景）；`tests/help-installation.test.ts` 与 `tests/metadata.test.ts` 通过。
- 完整离线入口 `node scripts/check.ts`，在提交 `72ab48a` 上：449 项中 447 通过、1 失败、1 跳过（非 Windows 进程适配分支）。失败的是 `tests/maa-process.test.ts`「Windows launches and normally closes a temporary GUI and completes a CLI configuration transaction」，报 `maa-start-timeout`。入口在测试失败后直接退出，所以另行运行了它的其余步骤：tracker 无错误、隐私检查无发现、元数据检查无错误、评分规则自检 7 条规则 14 份样例通过。
- 该文件单独连续运行三次：每次 16 项中 14 通过、1 失败、1 跳过，失败的都是同一项，都报 `maa-close-timeout`（用时 21.6、18.9、20.7 秒）。从 09 的头 `6df8ed0` 导出的冻结副本上单独运行一次，同一项同样失败（14/1/1）。本票没有改动 `maa-process.ts`、这份测试或它的合成窗口程序；与协调者已知的本机问题一致，不能据此判为偶发，交协调者另行处理。

## 第 1 轮审查后的修复（2026-11-13）

第 1 轮独立审查不通过（P2 一项、P3 两项），协调者复核后全部接受：

- P2：`inspectConnection` 会运行配置里任意存在的 `AdbPath`（例如误选的模拟器主程序或 MAA.exe）。修法：`setup-connection.ts` 新增唯一的判断 `isAdbExecutablePath`（沿用 07 发现时的 `…adb….exe` 文件名规则）和 `resolveAdbExecutable`（实际目标也要通过同一判断），setup 发现和 doctor 的 `check`／`analyze` 都经它；不是 adb 时不运行任何程序，报 `adb-path-unrecognized`，修法交 setup 的连接流程。全仓库执行 adb 的地方只有 `setup-connection.ts` 的 `adb.run`，候选都来自这一判断。
- P3：网络地址不在 `adb devices` 列表里被说成「模拟器可能没开」。修法：按 Android 官方 adb 文档区分 `device-not-connected`（网络地址未连接，不推断模拟器状态，修法为用户确认模拟器、开着就经 setup 的测试流程或在 MAA 里连接）和 `device-not-listed`（只用于 adb 自动发现的本机端口）；`emulator-<N>` 与本机端口 N+1 视为同一设备。`analyze` 的 `currentState` 只回报这个状态，不据此判断模拟器关着；排查对照和 SKILL 写明。
- P3：`--online` 的 10 秒超时和 1 MiB 上限、私有记录 64 MiB 上限补进规格正文和「规则来源」行；文件名判断和未连接状态也登记。

先红后绿：`tests/doctor-analysis.test.ts` 在修复前 19 项中 5 项失败，其中新测试「the current-state connection check never runs a configured program that is not adb」显示 adb 替身被用 MAA.exe 调用；`tests/doctor-checks.test.ts` 在修复前因缺少共用判断的导出而整体失败。修复后：`tests/doctor-checks.test.ts` 26/26（新增：配置成 MAA.exe、HD-Player.exe、adb.exe.bak 时替身从未被调用；setup 发现同样不调用；判断的正反例；网络地址未连接、本机端口按 emulator 序号匹配、emulator 序号未列出），`tests/doctor-analysis.test.ts` 19/19，`tests/setup.test.ts` 29/29，`npm run typecheck` 通过；审查员的离线复现（HD-Player.exe、MAA.exe 两种 AdbPath）现在都返回 `adb-path-unrecognized` 且没有执行任何程序。按维护者 2026-11-13 的负载要求，本轮没有运行完整离线入口，只逐个运行了上面三个文件；`tests/setup-scenarios.test.ts`、`tests/doctor.test.ts`、`tests/doctor-scenarios.test.ts` 本轮未重跑（它们的样例没有配置连接，期望不受影响），留给协调者的完整入口。

## 设计默认值

带限制的默认值都登记在规格「默认值及其来源」以「10 」开头的各行。只记在这里的实现选择：

- 八组检查的划分把「skill 版本」和「目录联接」各算一组，「MAA 自身问题」由 `analyze` 转介，不作为检查行（工单第 1 条写「八类」，规格把 MAA 自身问题写为只转介）。
- 检查行新增 `group`；skill 修法新增 `channel`；新增检查用原因代码加 `message`，06 原有的 `configuration`、`write-lock` 两行保持原文，避免改动 06 的输出。
- `runChecks` 的 context 需要 `home`（设置目录），安装组和凭据检查不再猜测设置位置；测试一律传临时目录。
- `analyze` 的退出码：只有运行已完成为 0；失败、停止、未知和输入被拒为 1（结果里的 `status`/`outcome` 区分），意外失败为 2。
- 停止的运行 `replay` 为 `ask-user`：重新开始要用户自己提出。
- `analyze` 的输入 `conclusion` 由模型在查明当前状态后填写，识别失败的本机检查不能被它跳过；`interfaceUnobscured` 只在用户当次确认后填写。
- 测试先行的记录：各组和分析的行为测试都先于实现写好，但只有 skill 版本与元数据两组单独留下了失败运行；其余是写好整批测试后再实现，没有逐个记录失败运行。

## 未验证

- 真实 MAA、模拟器、设备和真实日志：日志行首时间格式、详情 JSON 是否总在一行、`Save image` 行的实际写法（见[来源](doctor-sources.md)「未验证」）。
- `check --online` 对真实发布的比较：仓库尚无正式发布。
- Linux CI：本机只在 Windows 上运行；平台相关的期望（`platform` 行、退出码）按平台写在测试里，Linux 上的结果以 CI 为准。
- 原生安装（Codex skill-installer、Claude 插件市场）后的实际调用、目录联接场景只在临时目录里用合成联接验证。
- 真模型评测和人工语义核对，见上文「评测」。
