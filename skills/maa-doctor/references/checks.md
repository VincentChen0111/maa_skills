# 检查与恢复接口

共享入口是相邻 `../../maa-core/scripts/doctor.ts`，动作为 `check [--json] [--online]`、`analyze [--json]` 和 `repair [--json]`。默认人类可读输出，加 `--json` 返回结构化结果。退出码：0 正常或仅有提醒（`analyze` 为运行已完成）；1 存在错误、修法拒绝、输入被拒或结果未知（`analyze` 为失败、停止或未知）；2 意外失败。错误不回显配置、路径、原始异常或批准文本。

`check` 返回 `checkedAt`、`exitCode`、`checks`、`recovery`、`version` 和 `skills`，并原子保存到私有目录 `doctor-latest.json`。每条检查包含 `id`、`group`、`status`（normal/warning/error）、`reason`、`repair`（id、executor 为 skill/user、description；执行者为 skill 时另有 `channel`，即执行它的现有脚本入口），新增各项另有 `message` 一句说明和可选的 `details`（只含字段种类、文件名或 skill 名）。setup 和 doctor 共用 `maa-core/scripts/checks.ts` 的原因与修法表，安装组与 `setup.ts check` 是同一个函数（`inspectInstallation`）；导出的 `runChecks(context, maa)` 的 context 需要 `home`（设置目录）。本接口不替 setup 推定下载或人工操作授权。

## 八组检查

| group | 检查 | 内容 |
| --- | --- | --- |
| installation | `platform`、`maa`、`server`、`node`、`settings`、`private-directory`、`version` | 与 setup 相同。`version` 读 MAA.exe 的产品版本并对照随包核实记录：记录缺失、为空（`verification-record-empty`）、版本未知或未完全核实都只是提醒，不阻止使用 |
| connection | `connection` | 读当前配置的 adb 路径和地址，只运行 `adb devices`（adb 服务没在运行时 adb 会自行启动它，与 setup 的发现相同）：在线正常；离线、未授权为错误；不在列表里、adb 无法运行、未配置为提醒。不连接、不选择、不写入，不输出地址或路径 |
| configuration | `configuration`、`configuration-fields`、`remote-control` | 能否解析；本项目写入的任务开关、理智药和定时字段的类型与范围（只给字段种类）；MAA 远程控制是否已配置 |
| write-lock | `write-lock` | 遗留写入核对，规则见下文 |
| credentials | `credential-nga`、`credential-skland`、`credential-bilibili` | 见下一段 |
| private-files | `private-files` | 私有目录顶层由本项目保存的记录能否解析，以及中断写入留下的临时文件；不修改、不删除 |
| skill-version | `skill-version` | 安装的 maa-core 版本；只有加 `--online` 才只读访问 GitHub 公开接口查最新正式发布（10 秒超时），查不到为提醒 |
| skill-links | `skill-links` | 宿主 skill 目录里已安装的 maa_skills 目录（含目录联接）能否解析、有没有 SKILL.md；按宿主调用的路径检查，不跟随联接，也不修改宿主目录 |

`remote-control` 只报告已配置或未配置：任何一个配置的 `Gui.RemoteControl.RemoteControlGetTaskEndpointUri` 非空即为已配置（提醒），因为固定版本的 MAA 会轮询该端点，远端可以下发包括抽卡在内的任务，且不经过本项目的写入器。修法执行者是用户：在 MAA 设置里决定是否保留。写入器不管理这些字段，doctor 不提供自动修法，也不输出端点或身份标识。

执行者为 skill 的修法只经 `channel` 所列的现有入口执行：`doctor.ts repair`（遗留写入的两个修法）、`setup.ts prepare`（私有目录骨架）、`preferences.ts set`（首次设置，需要用户给出的选择）、`setup.ts discover|test|apply`（maa-setup 的连接流程，`apply` 仍需它自己的批准原话和关闭确认）、`doctor.ts check --online`（只读查询发布）。doctor 没有第二套写入逻辑。

`checks` 末尾附带共享凭据检查 `credential-nga`、`credential-skland`、`credential-bilibili`，与 setup 及 `credentials.ts check` 是同一个函数（`inspectCredentials`）。这三项另有 `message` 一句说明，`reason` 是 `credential-<状态>` 代码；人类可读输出显示 `message`。检查只读、不解密、不联网，最近记录里也只有状态。它们的修法执行者都是用户：`repair` 的批准列表含 `enter-credential`、`verify-by-use`、`replace-credential` 或 `reenter-credential` 时整体拒绝，返回 `user-manual-repair`，不执行同一请求里的其他修法。状态和修法见 [凭据接口](../../maa-core/references/credentials.md)。

核对证据中的 `lock` 区分 none、active、stale、unknown。只有已确认不存在的进程号才算 stale；不可辨认或无法确认进程状态的锁留给用户处理。`comparison` 表示全部当前配置与备份相同（unchanged）、与原请求预期结果相同（applied），或者 unknown。字段证据只显示脱敏键名和状态，不显示私人配置名或值。

已关联的最新备份、唯一匹配且为最新的待执行记录、持有者信息、当前配置和 MAA 进程状态共同构成 `evidenceRevision`。证据变化时批准失效，重新诊断。`canReconcile` 和 `canRestore` 是可选动作的前提，不代表已经批准。

通过标准输入向 `repair --json` 传 JSON：

```json
{
  "host": "codex",
  "approved": ["reconcile-lock"],
  "evidenceRevision": "<check 返回的 64 位指纹>",
  "reference": "<用户当次点名批准原话>"
}
```

Claude Code 的 host 是 `claude`。标准输入上限 64 KiB。批准列表逐项点名；目前同一遗留事务只有两个互斥修法，不能同时选择：

| 修法 | 前提与结果 |
| --- | --- |
| `reconcile-lock` | 已证明配置未改变，且 MAA 已就绪或完整退出；或配置已生效且 MAA 已就绪。先归档原证据，再核对并清锁，不改配置或重放操作。 |
| `restore-config` | 当前配置精确匹配原已批准事务的预期结果，且有最新关联备份；按原事务改动字段生成反向修改，再走原配置事务。保留额外证据及新备份，不整体覆盖文件。 |

MAA 已关闭时，用户确认自己没有在操作后添加 `closedConfirmed: true`。若恢复会重新启用药剂，添加用户当次明确数量 `medicineCount`，共享写入器仍检查总量、重复定时及禁止设置。原事务的历史药剂授权不授权本次恢复。定时窗口、非空闲、备份或重开失败仍按 05 的规则拒绝或保留未知。

原始核对证据仅保存于私有目录 `maa-config-reconciliations/`；配置写入的备份、待执行和结果仍使用 05 的目录和记录。短期恢复互斥文件 `.maa-skills-recovery.lock` 防止两个修法并发接管；遇到残留的恢复互斥也保留，交用户核对。

setup 连接事务也使用同一单配置证据格式，skill 标记为 maa-setup。恢复限于原记录的连接字段，允许恢复 MAA 原有的空／相对 adb 路径及空地址；setup 正常接入仍只选真实存在的 adb 与已测试的本机地址。恢复不重放 adb 连接测试或原安装请求。

损坏/缺失配置、字段外漂移、部分写入、缺备份、最新备份归属不一致或修改时间并列、超过 1000 项历史变更、未知记录或附带其他资源的事务均不自动恢复。MAA 已关闭且配置已生效时，重开是否成功仍未知，不能仅据字段一致就清锁；可在用户点名批准恢复后按关闭确认规则恢复，或由用户先处理 MAA 再重新诊断。

## 运行分析与转介

`analyze` 只读 MAA 目录下 `debug/asst.log` 的最后 8 MiB，按结构化回调把日志分成若干次运行，分析最近一次；标准输入 JSON 可以带：

```json
{ "run": 1, "processExitCode": 0, "interfaceUnobscured": true, "conclusion": "emulator-compatibility" }
```

- `run`：1–20，1 是最近一次。
- `processExitCode`：用户或宿主看到的 MAA 退出码，只回显为 `processExit: "not-evidence"`，不参与判断。
- `interfaceUnobscured`：仅在用户当次确认游戏画面没有被遮挡后传 `true`。
- `conclusion`：`maa-defect`、`emulator-compatibility` 或 `game-update-not-adapted`，仅在查明当前状态后仍认定原因在本项目范围外时传；不能跳过识别失败的本机检查。

返回 `analyzedAt`、`outcome`（completed/failed/stopped/unknown）、`run`、`window`（日志时间段）、`taskchains`、`evidence`（白名单字段：时间、消息名、`what`、任务链、子任务、`task` 名、异常类型）、`classification`（`category`、`environment`、`cause`）、`currentState`（`connection` 同 `check`，`maa` 为 running/not-running/unknown）、`localChecks`、`nextSteps`、`decidedBy`（总是 model）、`replay`（未知时 forbidden，失败时 within-existing-approval，停止时 ask-user，完成时 not-needed）、`screenshots`（相对 MAA 目录）、`missingEvidence` 和 `referral`。结果原子保存到私有目录 `doctor-analysis-latest.json`。

`referral.state` 为 `not-applicable`、`pending`（`remaining` 列出未完成的本机检查）或 `ready`；`ready` 时带 `summary`（`overview`、`keyEvidence`、`rootCause`、`confidence`、`missingEvidence`）和 `entries`（MAA 常见问题、连接说明、issue 列表、日志压缩包的生成位置）。类别、排查顺序和何时转介见 [排查与转介对照](triage.md)。
