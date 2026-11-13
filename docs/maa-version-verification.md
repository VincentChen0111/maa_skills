# MAA 版本核对与升级提醒验证记录

2026-11-13，工单 [25](issues/25-maa-version-verification.md) 在分支 `claude/25-maa-version` 实施，叠在 10 已审查的头 `be48323` 上（10 叠在 09 上，基于 `origin/main` `4a1fd26`）。实施进度：进行中，等待独立审查，尚未合并。来源与核对细节见 [MAA 版本跟踪的来源](maa-version-sources.md)。

## 交付内容

- `docs/maa-dependencies.json`：15 条依赖条目（05、07、10、11、15、24 已交付的 MAA 依赖和任务类型集合），每条有行为、位置、整文件 Git blob 指纹、受影响 skill、工单、来源记录和两类已核版本；16、22、27 的位置记为待登记。
- `scripts/maa-version-check.ts`：`verify --source`（本地源码树离线核对）、`record [--write]`（从注册表生成随包核实记录）、`notes`（发布信息两行）、`reverify --source --version --entry`（人工核对后更新条目指纹和版本）、`daily --online [--publish]`（Action 入口）。只用 Node 自带模块。
- `.github/workflows/maa-version-check.yml`：每天 03:17 UTC 和手动触发，只运行 `daily --online --publish`。
- `skills/maa-core/references/verified-versions.json`：改为生成的记录（schema 2，带 `recordVersion`）：源码已核 v6.22.0，实机已核为空。
- `maa-version.ts`：读带版本号的记录、`maa-upgrade-available` 提醒、版本比较（`doctor-checks.ts` 的 `compareVersions` 改为复用它）、计划用的版本标记 `readVersionStamp` 和差异比较 `compareVersionStamp`。`checks.ts` 新增原因 `maa-upgrade-available` 和用户修法 `upgrade-maa-yourself`。
- 计划和待执行记录带版本：配置写入器的 `daily-pending.jsonl`、`stage-jobs.ts query` 保存的报告、`training-plan.ts prepare` 的计划；doctor 的恢复核对和修法结果、作业 `prepare`、专精 `apply`/`reconcile` 的结果报告差异。`MaaProcess` 边界新增可选的 `version()`，生产实现读 MAA.exe 的产品版本。
- 文档：规格「MAA 版本跟踪」新增一段、两张来源表新增条目、「测试决定」一句；术语表；README；maa-doctor、maa-setup、maa-core 的 SKILL 和参考文件；daily 的配置与作业参考；setup 和 doctor 来源记录各补一句现状。
- 评测场景：`eval/maa-doctor/scenarios.ts` 的版本行改为按随包记录计算（安装版本读不出时为 `maa-version-unknown`），恢复证据加 `versions: null`，新增 `doctor-maa-upgrade-request`（用户要求直接下载升级 MAA：只运行 check，不下载、不写入其他文件）。

## 验收对照

| 验收 | 证据 | 状态 |
| --- | --- | --- |
| 1 条目记录行为、位置/指纹、受影响 skill、两类已核版本；只存指纹 | 注册表 schema 由 `validateRegistry` 校验；`tests/maa-version-check.test.ts`「the repository registry covers …」逐条核对 skill、来源记录和工单存在 | 离线通过 |
| 2 为已实现的依赖登记证据，不自动登记起点经验 | 同一测试扫描全部 `docs/*-sources.md` 和 skill 参考里在固定提交上引用的 MAA 文件，每个都必须已登记或待登记；条目的 blob 与已有来源记录逐一一致（见来源） | 离线通过；条目范围的完整性还靠审查 |
| 3 登记 27 的位置（未交付则由 27 补上） | 注册表 `pending` 的 27 一项；同一测试在 27 标为已完成而仍在待登记时失败 | 离线通过；正式条目由 27 交付时登记 |
| 4 沿用 07 的读法；记录带版本号；计划和待执行记录写版本，执行或恢复时报告差异，未核实只提醒 | `tests/maa-version.test.ts` 的记录与版本标记测试；`tests/maa-config.test.ts`「the pending record carries …」；`tests/doctor.test.ts`「recovery reports a changed MAA or record version …」（changed/same/unrecorded/格式错误四种）和「a restoration writes the current version stamp …」；`tests/stage-jobs.test.ts`「preparation reports …」「a saved stage report records …」；`tests/training-plan.test.ts`「a plan records the MAA and record versions …」 | 离线通过；基建排班由 22/23 实现时沿用 |
| 5 任务类型集合进依赖条目，核实后采用 | 条目 `task-type-set` 的 `facts`；「the task type set entry lists every type the configuration writer identifies …」；v6.19.0 起不变的说法核对后不成立，见来源 | 离线通过；列表在 4 个提交上读取核对 |
| 6 登记 10、16、22 的位置 | 10 的位置在 5 条条目里；16、22 在 `pending` | 离线通过 |
| 7 正式版全部未变才开 PR，变化或缺失开 issue，不错误认证 | 「a fixed sample source tree …」（未变、变化、缺失三种和 CLI 退出码）；「an unchanged stable release opens one PR …」；「a refused PR fails the run every day until it can be opened from the existing branch; a partly written branch is completed」（仓库不允许 Actions 开 PR 时每天失败，打开设置后的下一次运行从已有分支开出 PR；分支上缺写的文件只补那一个）；「a stable release with a changed or missing entry opens an issue …」 | 离线通过（网络与 GitHub 用替身） |
| 8 beta 变化提前预警，不进列表；重复检查不重复通知 | 「a beta with changes opens one early-warning issue …」；PR、issue、beta 三种的重复检查，以及后续版本带相同变化、已有 PR 缺标签（补标签，不开第二个）两种情况 | 离线通过 |
| 9 核实记录接入 setup/doctor；源码已核后提醒可升级，未核实只提醒 | `tests/maa-version.test.ts`「a newer source-verified stable release …」「setup reads the record …」；`tests/doctor-checks.test.ts`「an empty verification record is stated as empty, and a newer source-verified release is the same reminder as in setup」 | 离线通过 |
| 10 发布信息分列两类；不伪造设备验证；Action 只做核对、不带用户配置 | `releaseNotes` 测试；记录的实机已核为空；「the daily workflow only runs the version check …」核对工作流只有一个运行步骤、只用 `GITHUB_TOKEN`；「the daily CLI uses the network only with --online …」；通知正文只含版本、提交、条目和指纹，测试断言令牌不出现在输出里 | 离线通过；真实 Action 未验证 |

## 评测

- 离线：`tests/doctor-scenarios.test.ts` 在 `.agents` 和 `.claude` 两种布局里跑完 9 个 doctor 场景（含新增的 `doctor-maa-upgrade-request`）的预期调用并用评分规则判分，19/19 通过。这只是评测链路自检。
- 真模型评测：未运行（工单 28 未交付、评测登录目录未就绪）。maa-doctor、maa-setup、maa-core 的 SKILL 与参考文字改动前后对比，以及新场景的模型基线，都未验证，移交 26。场景文件改了已有场景的期望记录（版本行和恢复证据），这些场景的指纹随之改变，改动前后的比较要以同一份场景重新跑基线。

## 实际运行的命令与结果

本机 Windows 11、Node 24。临时目录与合成样例，未触碰真实 MAA、已安装 skill 或私有目录；没有运行完整离线入口（按协调者 2026-11-13 的要求，由协调者串行运行）。

- `npm ci --ignore-scripts` 成功；`npm run typecheck` 在每步之后和最终代码上通过。
- 先失败后通过：`tests/maa-version.test.ts` 先因缺少导出失败，实现后 5/5；`tests/maa-config.test.ts` 新测试先 0/1，后 1/1；`tests/doctor.test.ts` 两个新测试先 0/6（含子测试），后 6/6；`tests/stage-jobs.test.ts` 新增的三处先 3 项失败，后 8/8；`tests/training-plan.test.ts` 新测试先 0/1，后通过。`tests/maa-version-check.test.ts` 的行为测试是一次写好后再写实现的，第一次运行已在实现之后（11 项中 9 项通过，注册表/记录一致性和工作流两项按预期失败），之后补了遗留分支和检出提交两处断言并同时实现，没有单独的失败记录。
- 单文件（第 1 轮审查前的代码上各运行一次；`maa-version-check` 在修复后为 12/12）：`maa-version` 5/5、`maa-version-check` 11/11、`doctor-checks` 27/27、`doctor` 80/80、`maa-config` 60/60、`stage-jobs` 8/8、`stage-jobs-regressions` 11/11、`stage-scenarios` 1/1、`training-plan` 8/8、`training-assistants` 6/6、`training-evaluation` 1/1、`training-integration` 2/2、`training-smoke` 1/1、`doctor-scenarios` 19/19、`setup` 29/29、`setup-scenarios` 22/22。
- `node scripts/tracker.ts --write`、`node scripts/tracker.ts`、`node scripts/privacy.ts`、`node scripts/metadata.ts`：无错误、无发现。隐私检查第一次报了两处 `credential`（请求头里拼令牌的写法和测试里的合成令牌），改用 `Headers.set` 和尖括号占位后通过。
- 独立审查第 1 轮（有条件通过，P2 1 项、P3 3 项，协调者全部接受）之后：
  - P2「已有 PR 分支就算已通知」：先在 `tests/maa-version-check.test.ts` 加「a refused PR fails the run every day …」并把第一个 PR 测试里的遗留分支情况改成「已有 PR 缺标签」，运行 12 项中 2 项失败（第二天没有失败、没有给已有 PR 补标签），与审查员的离线复现一致；改为按分支查 PR（`pulls?head=<所有者>:<分支>&state=all`）、只有已有 PR 才算已通知并补标签、没有 PR 就核对两个文件的 blob 只补不同的再开 PR、开不成整次失败之后，12/12。
  - P3：规格里 10 的版本提醒顺序补上 25 加入的一项，25 升级提醒一行写明排序；工作流的 15 分钟运行时长登记进规格正文和默认值表；来源里 `ConfigFactory.cs` 的变化改为「去掉两个转换器、没有新增」（结论不变）。
  - 本轮按协调者要求只跑类型检查和改到的单个测试文件，没有访问网络或 GitHub。
- 独立审查第 2 轮（有条件通过，P3 1 项，协调者接受；第 1 轮的问题确认已修好）之后：
  - P3「PR 被拒时 beta 预警 issue 也发不出」：先在「a refused PR fails the run every day …」里让同一次运行同时有未变的正式版（PR）和有变化的 beta（issue），断言 PR 被拒的第一天、第二天 beta 预警 issue 都已发出（只发一次）且运行仍失败；运行 12 项中 1 项失败（第一天 beta issue 数为 0），与审查员的离线复现一致。改为每条通知各自发布、失败的记下来、全部处理完再整次失败之后，12/12。
  - 同样只跑了类型检查和这一个测试文件，没有访问网络或 GitHub。
- 三轮审查之后的修复（未经独立审查）：协调者在头 `67a3549` 上跑完整离线入口，`tests/daily-evaluation.test.ts` 5 项中 3 项失败，单独重跑结果相同（确定性失败）。本票之前没有运行这个文件。
  - 根因：daily 交易评分器 `scripts/eval-daily.ts` 逐字节比较写入器追加的待执行记录，期望内容只有元数据、授权和改动；本票按验收第 4 条让写入器多写了 `versions`。产品写的是对的：在评测夹具里用诊断脚本读到的实际记录键为 `id,skill,host,pid,startedAt,phase,authorization,changes,versions`，`versions` 为 `{"maaVersion":null,"recordVersion":2}`（夹具里没有 MAA.exe，所以版本为 null）。错在评分器没有跟上这个新字段。
  - 修复：评分器的期望记录加上 `versions: { maaVersion: null, recordVersion }`。`recordVersion` 取自记录本身，但必须是正整数；整行仍逐字节比较，所以其他字段、键的顺序、猜出来的版本都通不过。原有的交易安全断言（锁、阶段、授权原话、改动、备份、进程顺序）一条没改。
  - 同时在「an authorized reminder transaction …」里加了四种篡改：猜一个版本、去掉版本标记、记录版本为 0、版本标记里多一个字段，评分都必须是 fail。
  - 失败与通过：修复前单独运行 `tests/daily-evaluation.test.ts` 为 5 项中 3 项失败（与协调者的日志一致）；修复后 5/5。
  - 之后逐个运行：`npm run typecheck` 通过；`daily-evaluation` 5/5、`maa-config` 60/60、`doctor` 80/80、`maa-version` 5/5、`maa-version-check` 12/12；另外读待执行记录或恢复记录的测试 `setup-integration` 5/5、`setup` 29/29、`training-config` 3/3、`training-integration` 2/2、`stage-jobs` 8/8、`stage-jobs-regressions` 11/11、`stage-demo` 1/1、`setup-scenarios` 22/22、`doctor-scenarios` 19/19；`node scripts/eval-selftest.ts`（7 条规则、14 份样例）、隐私检查和元数据检查通过。没有跑完整离线入口。
  - 影响：评分器源码计入场景指纹，daily 场景的指纹随之改变，改动前后的模型比较要用同一份评分器重新跑基线（模型评测本来就未验证）。工单 28 在并行改评测运行器，没有改 `eval-run.ts`、`evaluation.ts`、`eval-fixture.ts`，但 28 合入时 `eval-daily.ts` 可能需要合并。
- 只读网络（事实核对，不是工具的在线模式）：GitHub 公开接口解析 4 个提交号、查一次发布列表、列两个目录；`raw.githubusercontent.com` 读 67 个文件在两个提交上的内容并就地计算 blob，读 4 个文件做 diff；读 v6.19.0 和开发分支的任务类型；GitHub 文档一页。没有保存 MAA 文件。

## 设计默认值

带限制的默认值都登记在规格「默认值及其来源」以「25 」开头的各行。只记在这里的实现选择：

- 条目范围：一条条目对应一组一起被依赖的行为；同一个文件可以出现在几条条目里（例如 `AsstProxy.cs` 在任务类型和启动跳过两条里），变化时每条都会列出。
- 注册表放在 `docs/`，不随 skill 分发；随包只分发生成的核实记录。
- 作业报告的 `versions` 放在报告 hash 之外：报告由 `matchStageJobs` 重算 hash 核对，版本标记不是匹配输入；改动它只会影响差异报告。
- 专精 `apply` 在执行前就返回 `check-required` 的结果也带 `versions`，三种结果形状一致。
- `MaaProcess.version()` 是可选方法：测试替身不提供时版本记为 null，生产实现总是提供。只有 MAA.exe 存在时才调用。
- 通知正文用中文（与仓库文档一致），标签名 `maa-version-check`，PR 分支 `maa-version-check/v<版本>`，变化键取 SHA-256 前 16 位。
- `verify`、`reverify` 只接受本地源码目录，不联网；联网只在 `daily --online`。命令行的 `--registry`、`--record` 用于指定其他文件，默认是仓库里的两份。

## 未验证

- 工具的在线模式没有在真实网络上运行过；GitHub 发布接口、`commits/<标签>` 的提交号返回、raw 文件读取只用替身测过（事实核对时用同样的地址只读访问过）。
- Action 本身没有在 GitHub 上运行：定时触发、`GITHUB_TOKEN` 的写权限、仓库是否允许 Actions 创建 PR、新建标签、按标签列出 issue 和 PR、`contents` 接口在新分支上提交两个文件，都未验证。用 `GITHUB_TOKEN` 开的 PR 不会自动触发离线检查（GitHub 文档已核），需要维护者手动触发。
- 真实 MAA.exe 的产品版本读取沿用 07 的实现，计划和待执行记录里的版本标记只在合成目录里测过（替身返回版本号）。
- 实机已核为空：没有任何真实 MAA、模拟器和游戏上的核对。
- Linux CI：只在 Windows 上运行；工作流用 ubuntu，平台相关的期望以 CI 为准。
- 真模型评测，见上文「评测」。

## 需要维护者处理

- 在仓库设置里允许 GitHub Actions 创建 PR（Settings → Actions → General → Workflow permissions）。不打开时，需要开 PR 的每日核对每天都会失败（分支和两个文件已经写好，只差 PR），直到打开设置；打开后的下一次运行从已有分支开出 PR。
- 合并后可手动触发一次 `MAA version check` 观察第一次运行；自动开的 PR 需要手动触发离线检查。
- 实机已核只能在真实设备上核对后登记（26 的发布验收）。
