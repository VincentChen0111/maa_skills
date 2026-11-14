---
name: maa-doctor
description: 按症状诊断 MAA 使用问题：检查安装、连接、配置（含远程控制）、写入锁、凭据状态、私有文件、skill 版本和目录联接八组，读 MAA 日志判断上次运行为什么失败。修法逐项点名批准后经已有的 setup、偏好或配置通道执行；遗留写入可核对清锁或恢复已记录字段。查明是 MAA 自身问题时给官方入口和去掉账号信息的日志摘要。凭据只报告状态，重新输入由用户在自己的终端完成。
---

# maa-doctor

开始前确认相邻 `../maa-core/scripts/` 中的 `preferences.ts`、`doctor.ts`、`doctor-checks.ts`、`maa-log.ts`、`checks.ts`、`maa-config.ts` 和 `credentials.ts` 存在。缺少 core 时停止：Codex 使用自带 skill-installer，从 `VincentChen0111/maa_skills` 同一版本安装 `skills/maa-core` 与 `skills/maa-doctor`；Claude Code 使用原生市场 `/plugin marketplace add VincentChen0111/maa_skills`、`/plugin install maa-skills@maa-skills` 安装完整插件，已有安装用原生更新入口更新。

运行 `node <本目录>/../maa-core/scripts/preferences.ts read`，标准输入传 `{"currentLanguage":"<当前用户语言的 BCP 47 标签>"}`（Windows PowerShell 管道里的非 ASCII 字符和 `?` 写成 `\uXXXX` 转义，见 [maa-core 的调用方约定](../maa-core/SKILL.md)）。按返回语言回复；未设置时提示可以设置。用户要求改设置或记录偏好原话时使用 [共享偏好接口](../maa-core/references/preferences.md)。

1. 运行 `node <本目录>/../maa-core/scripts/doctor.ts check --json`，接口见 [检查与恢复接口](references/checks.md)。检查只读，仅更新私有目录的最近检查记录。按 `group` 列出每条状态、原因、修法和执行者，先讲和用户症状相关的组；说明 `recovery.changes` 中已生效、未生效及未知项。返回的是白名单证据，不读取完整配置到对话。用户问到 skill 更新、版本，或同意联网查询时，改用 `check --json --online`（只读访问 GitHub 公开接口）。
2. 版本：`version` 只按随包核实记录提醒，未核实或记录为空都照常可用，如实说明列表为空。`maa-upgrade-available` 时告诉用户可以升级到 `newerSourceVerified`，说明它是源码已核、是否也实机已核（`newerDeviceVerified`），当前版本照常可用；要升级由用户自己在 MAA 的更新设置或官方发布页完成，你不下载、不安装、不替用户升级 MAA，即使用户要求也只说明怎么做。不建议降级。`recovery.versions` 或修法结果的 `versions` 为 changed 时，告诉用户遗留写入之后 MAA 或核实记录换了版本，这只是提醒，不改变修法的前提。`skill-version` 提醒有新发布时，更新由用户走宿主自己的更新入口，同时更新 maa-core。`skill-links` 报告损坏的目录联接或缺少 SKILL.md 时，由用户重建联接或重新安装，doctor 不改宿主目录。
3. `remote-control` 为提醒时告诉用户：MAA 的远程控制已配置，远端可以让 MAA 执行包括抽卡在内的任务，这条路不经过本项目的写入器；是否保留由用户在 MAA 设置里决定，doctor 不提供自动修法。不复述端点地址或身份标识。
4. 用户描述的是运行失败、报错或「MAA 没做完」时，读 [排查与转介对照](references/triage.md)，运行 `doctor.ts analyze --json`，标准输入传 `{}`；用户提到 MAA 退出码时一并传 `processExitCode`，它不作为成功的证据。按 `outcome` 说明结果：只有 `completed` 是完成；`unknown` 时只核对当前状态，不重新运行、不重试、不改配置。
5. 环境类失败（`classification.environment` 为 true：连接、识别环境、MAA 进程）先讲原因、证据和 `currentState`，再从 `nextSteps` 里由你判断：在原有批准范围内重试、换下一份已批准的备选，或停下告诉用户。不按失败次数自动交给用户或换作业；重试不增加理智药或碎石的数量，也不改变启动方式。需要连接检查时用 `check` 的同一结果，不另跑别的连接命令。`device-not-connected` 不说明模拟器关着，先问用户模拟器是否开着。
6. 转介只在 `referral.state` 为 `ready` 时进行。`pending` 时按 `remaining` 先完成本机检查：识别失败要先排除分辨率、连接和界面遮挡，界面是否被遮挡要问用户，可以给出 `screenshots` 里的相对路径让用户自己查看；用户确认后再以 `interfaceUnobscured: true` 重跑。环境类或原因不明的失败，只有查明当前状态后仍认定在本项目范围外，才以 `conclusion` 重跑。`ready` 时按摘要的五部分（现象概要、关键证据、根因判断和证据链、置信度、还缺什么证据）转述，给出 `entries` 里的官方入口，请用户在 MAA 里自己生成日志压缩包并提交；不代发 issue，不补充配置、地址、标识或私人路径。
7. 修法每项先获得当次点名批准；允许用户一次点名多项，逐项按 `repair.channel` 走已有入口：`doctor.ts repair`（遗留写入）、`setup.ts prepare`、`preferences.ts set`、maa-setup 的连接流程（`setup.ts discover|test|apply`，按它自己的规则取得批准和关闭确认）。笼统「全部修复」不构成批准。执行者为 user 的修法只说明怎么做，不替用户做。
8. 遗留写入：活跃锁等待原持有者完成。遗留锁根据当前配置、最新关联备份、待执行记录和 MAA 状态核对。`unknown`、损坏配置、缺失/不匹配证据或未支持的事务均保留锁，给用户说明仍缺什么；不能证明时不宣称恢复完成，也不自动重放原操作。同一遗留事务的 `reconcile-lock` 与 `restore-config` 是互斥选择，先让用户选定意图。
9. 调用共享 `doctor.ts repair --json`，绑定刚才的 `evidenceRevision` 和用户批准原话。配置恢复由同一个配置写入器执行，不能直接复制备份、编辑 JSON 或删锁。MAA 已关闭时仍需确认用户没有在操作，再传 `closedConfirmed: true`。恢复会重新打开理智药、碎石或临期药时，需要用户当次批准的数量或临期药策略，原事务的授权不复用；恢复后这一类仍关着、只是改回事务之前的值（例如关着时留下的数量或临期天数）时，不需要这一类的批准，用户点名批准这次恢复即可；抽卡、礼包、付费、登录和碎石以外的源石用途不执行。
10. `complete` 才报告该修法完成，并再次运行 check 保存最新诊断。清锁完成仅表示遗留写入已核对，不表示游戏任务完成。`rejected` 说明前提不满足；`unknown` 保留证据并交用户处理，不自行重试。只有新的诊断与用户重新点名批准才能进入下一次修法。
11. 凭据检查 `credential-nga`、`credential-skland`、`credential-bilibili` 与 maa-setup 共用，只有状态，没有值；含义见 [凭据接口](../maa-core/references/credentials.md)，保存了不等于可用。凭据的修法（`enter-credential`、`verify-by-use`、`replace-credential`、`reenter-credential`）执行者都是用户，不调用 repair；即使用户点名批准，`repair` 也返回 `user-manual-repair`。已知过期或无法读取时，给出带实际路径和 `--language <用户语言的 BCP 47 标签>` 的 `credentials.ts input <服务>` 命令，请用户自己打开终端运行并重新粘贴；agent 不运行 `input`、不替用户登录，也不请用户把 token、Cookie 或 SESSDATA 贴到对话里，用户已经贴出时不复述、不保存。森空岛 token 过期后的修法只有重新粘贴；B 站功能是实验性的。用户说已完成后重新 check。

遗留写入核对覆盖已知单配置事务，包括 daily 配置和 setup 连接字段事务；新事务若附带作业、训练计划或其他资源，其证据未经支持时交用户核对，不把它当作可恢复的普通配置事务。MAA 自身的缺陷、模拟器兼容和游戏更新后未适配只转介，不修；下载缺失程序是后续能力。
