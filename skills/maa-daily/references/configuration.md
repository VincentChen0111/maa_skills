# 配置事务接口

唯一实现随 maa-core 安装：`../maa-core/scripts/maa-config.ts`（从 maa-daily 根目录定位）。Node 24；Windows MAA GUI 配置为 `config/gui.new.json`。CLI 从共享设置取 MAA 与私有目录，不接受临时覆盖路径。只把下面 JSON 传给标准输入，使用宿主的参数数组或安全 stdin，不把用户文字拼进 shell。

## 读取与写入

关卡作业由 [作业准备接口](stage-jobs.md) 生成独立 jobPlan 授权，唯一写入器核对当前配置的 Copilot.TaskList 和 EnableUserAdditional=false。摘要仅新增每配置 jobCount，不输出文件路径、关卡名称或完整作业。事务还绑定 Current、整份 Copilot 设置及私有作业资产内容指纹；不与普通配置修改合成一次请求。

`read` 输出配置序号、任务类型/启用状态、定时槽、提醒字段与 revision 指纹。任务的 `$type` 和 `TaskType` 必须符合已核对应关系；缺失、未知或不一致均显示 `OtherTask`，不能凭任务名称或标签授权启用。类型已核的 Fight 任务另有 `consumption`：`medicine`（`on`、`count`）、`stone`（`on`、`count`、`allowSave`）、`expiring`（`on`、`days`、`activity`）；`on` 为 null 表示开关不是布尔值，MAA 和写入器都按开启处理，`count`/`days` 为 null 表示不是合法整数。类型不明的任务不输出这些。不输出配置名称、任务名称、关卡、连接地址、账号或完整配置。`write.expectedRevision` 必须使用此次摘要的 `configuration.revision`，不能临时读取新值来绕过变更提示。开始时版本不符返回 configuration-changed；关停后任务/定时槽对象或决定实际执行目标的当前配置、定时模式、目标队列变化则保留 unknown，不按旧下标写入。重新核对目标与当次授权后才可重新准备请求。

`write` 输入示例：

```json
{
  "host": "codex",
  "expectedRevision": "<read 返回的 configuration.revision>",
  "authorization": {
    "source": "current-request",
    "reference": "用户本次要求开启定时提醒"
  },
  "changes": [{"path":["Timers","NotifyBeforeScheduledStart"],"value":true}]
}
```

`host` 为 `codex` 或 `claude`，不改变权限。授权来源为 `current-request` 或 `approved-report`；`reference` 记录原请求或已批准报告条目，只保存在私有待执行记录，不输出。理智药、碎石和临期药的授权字段见下文「碎石与临期药」，其他授权键一律拒绝。`closedConfirmed` 仅在用户明确确认未操作已经关闭的 MAA 后设为 true。设置路径由 `MAA_SKILLS_HOME` 定位，测试必须使用临时设置。

允许修改已存在的字段；仅原生定时槽省略的 `IsEnabled` 按已核单次值 null 处理，可明确修改。不生成新配置、任务或定时槽：

| path（方括号为数组元素） | value |
| --- | --- |
| `["Configurations",配置序号,"TaskQueue",任务位置,"IsEnable"]` | 布尔值；启用仅支持已核的普通任务，未知类型和 StartUp 等入口不自动启用 |
| `["Configurations",配置序号,"TaskQueue"]` | 原队列位置的完整排列，例如 `[2,1,0]`；每个位置只出现一次，重复类型可独立排序，保留原任务对象，不与同队列字段改动混用；队列须全部为类型对应一致的已核普通任务，未知或不一致任务即使停用也拒绝重排 |
| `["Configurations",配置序号,"TaskQueue",Fight位置,"UseMedicine"]` / `"MedicineCount"` | 当次 `authorization.medicineCount` 为本次总上限（0–2147483647）；各任务按用户明确的分配设置数量和开关，来源必须为 current-request；启用药剂时同时设置这两个字段 |
| 同一路径末项为 `"UseStone"` / `"UseStoneAllowSave"` / `"StoneCount"` | 碎石。当次 `authorization.stoneCount` 为本次总上限（0–2147483647）；打开时三个字段一起写：两个开关都为 true，`StoneCount` 大于 0 且不超过授权 |
| 同一路径末项为 `"UseExpiringMedicine"` / `"MedicineExpireDays"` | 临期药。当次 `authorization.expiringMedicine.days` 是批准的临期天数（1–30）；打开时 `MedicineExpireDays` 等于这个天数 |
| 同一路径末项为 `"UseExpireMedicineForActivity"` | 活动结束前用当周过期的理智药。只在 `expiringMedicine.forActivity` 为 true（用户点名批准）时可以打开 |
| `["Timers","List",槽位,"IsEnabled"]` | true 为每日定时、null 为原生单次、false 为关闭 |
| 同一路径末项为 `"Hour"` / `"Minute"` / `"Config"` | 本机时间小时 0–23、分钟 0–59、目标配置序号；槽位 0–7 且必须已存在 |
| `["Timers","CustomConfig"]` / `"ForceScheduledStart"` / `"ShowWindowBeforeForceScheduledStart"` / `"NotifyBeforeScheduledStart"` | 布尔值 |
| `["Timers","ScheduledStartNotificationMinutes"]` | 1–1439 分钟 |

启用任务、修改药剂、重排及定时都通过同一类型识别检查；重排本身不新启用任务，但仍检查其中已启用任务的设置。要启用的任务或定时会运行到的 Fight 任务上已经开着理智药、碎石或临期药时，请求里要有当次对应的授权，数量、天数和活动项都要对得上，不能借已有值启用；免费抽卡、特殊礼包和登录入口在任何授权下都拒绝。不会为通过检查擅自关闭既有设置；先报告原因。除上述 `Timer.IsEnabled` 例外，未知或缺失字段停下核对，不猜测补键。

MAA 保存时可能省略 `IsEnabled: null`。仅这个字段的省略与 null 在单次窗口、次数计算、关停后的目标绑定和重开读回中等价；true、false、时分、目标配置及其他字段仍严格核对。revision 仍区分原始 JSON 的省略与 null，备份保留关停后原始字节；等价读回不允许重放 unknown。

理智药和碎石各按相关配置中所有启用 Fight 的合计核对，包含原有启用任务；不能让多个任务各自复用同一个数量。每个任务的数量乘以该配置单次定时的执行次数（未排定时或未启用的明确分配至少计一次），最后跨配置相加。每日重复无法由一次有限数量授权覆盖，故有理智药或碎石数量时拒绝启用或改配该重复计划，不擅自关掉用户原有定时。临期药没有数量，不参加这项核对，批准后可以留在每日重复的定时上。

## 碎石与临期药

授权字段（与 `source`、`reference` 并列，三种可以同一次请求）：`medicineCount`、`stoneCount` 是整数数量，`expiringMedicine` 是一个对象，只含 `days`（批准的临期天数，1–30）和 `forActivity`（用户是否点名批准活动临期药，布尔值）两个字段。来源必须是 `current-request`：偏好原话和已批准的报告条目不能授权。`medicineCount`、`stoneCount` 不能和 `jobPlan`、`trainingPlan` 同一次请求；`expiringMedicine` 可以随计划一起批准。

`write` 碎石示例（用户当次批准第一个配置里位置 0 的 Fight 任务碎石，最多 2 颗）：

```json
{
  "host": "codex",
  "expectedRevision": "<read 返回的 configuration.revision>",
  "authorization": {
    "source": "current-request",
    "reference": "用户本次批准第一个 Fight 任务碎石，最多 2 颗",
    "stoneCount": 2
  },
  "changes": [
    {"path": ["Configurations", 0, "TaskQueue", 0, "UseStone"], "value": true},
    {"path": ["Configurations", 0, "TaskQueue", 0, "UseStoneAllowSave"], "value": true},
    {"path": ["Configurations", 0, "TaskQueue", 0, "StoneCount"], "value": 2}
  ]
}
```

请用户批准碎石之前说明两件事：写入会同时打开 MAA 的「允许使用源石保存状态」（MAA 自己的界面把它标为危险功能）；这项设置写入后留在配置里，之后每次运行这个任务都会按数量碎石，直到再次修改。还要说明：MAA 不在理智药和源石之间选择，游戏显示理智药页面时它只用理智药，理智药数量用完就关掉页面、结束这次作战，只有游戏显示源石页面时才按碎石数量确认；背包里还有理智药时，只批准碎石通常不会碎石（依据见 daily 验证记录）。临期药批准的是「用临期药」这一策略和临期天数：开启后即使理智药数量用完，MAA 仍会使用临期天数内的药，数量授权约束不了它。

关闭碎石或临期药是普通的当次请求，不需要数量或天数：把 `UseStone`（可同时把 `UseStoneAllowSave`）、`UseExpiringMedicine` 或 `UseExpireMedicineForActivity` 改为 false。只把 `UseStoneAllowSave` 改为 false 而 `UseStone` 留在 true 不算关闭，仍需碎石授权。

拒绝时脚本给出静态原因码，据此告诉用户缺哪一项批准：`stone-grant-required`、`expiring-grant-required`、`medicine-grant-required`（缺对应授权）；`current-request-required`（来源不是当次请求）；`stone-quantity-exceeded`、`medicine-quantity-exceeded`（超出数量）；`expiring-days-mismatch`、`expiring-activity-not-approved`（天数或活动项与批准不符）；`stone-settings-invalid`、`medicine-settings-invalid`（开关或数量没有一起写对）；`recurring-quantity-not-authorized`（有限数量不能挂在每日重复的定时上）；`training-expiring-grant-required`（专精定时会运行到开着临期药的 Fight 任务：请用户把临期药和这份计划一起批准，或者先把临期药关掉）；`training-stone-enabled`（专精定时会运行到开着碎石的 Fight 任务：先经当次请求把碎石关掉）；`conflicting-authorizations`、`consumption-grant-invalid`（授权组合或取值不对）；`forbidden-setting`（抽卡、礼包，任何批准都不能打开）。

剩余数量：写进配置的理智药和碎石数量会留在那里，之后每次运行都按这个数量重新生效，「本次总上限」只对写入时核对过的那几次运行成立。带理智药或碎石数量的运行（日常队列和它的定时）结束、失败或被中断之后，再运行只能用剩下的数量，或者由用户重新批准。目前没有工具读取这类运行实际用掉了多少，所以用量一律按未知处理：停下告诉用户，请用户重新批准，不重试，也不写一个猜出来的剩余数。以后有工具可靠读到用量时，写剩余数量是一次普通的当次写入，在 `reference` 里引用原来的批准原话，数量等于剩余数；原来的批准不在当前对话里（例如宿主重启之后）就是历史授权，要重新批准。剩余数为 0 时这次批准已经用完：经普通当次请求把理智药或碎石的开关关掉、不带它再运行，或者停下告诉用户。

## 事务与失败

写入锁在目标 MAA 的 `config/.maa-skills.lock`，跨宿主共享；记录 skill、host、PID、时间、操作编号和阶段。每个事务由一个进程持锁。活跃锁返回 busy，遗留或损坏锁返回 unknown，均不删除。结果未知时保留锁、备份及临时证据，等待 doctor/人工核对。

本次停机预算 120 秒，包括正常关停最多 30 秒、重开最多 60 秒和文件操作余量；每个阶段重新核对。整个区间避开所有每日/单次定时前 2 分钟至触发分钟结束，使用 MAA 所在电脑本地时区；修改后的新定时也检查。超预算或未能证明窗口安全时报告实际阶段，不声明完成。

必须确认目标路径的 MAA 及已见子进程树退出后才备份、改盘；写入前再查。只正常关闭窗口，拒绝退出不强杀。托盘状态没有可关闭主窗口时，请用户恢复主窗口或自行关闭并确认。重开带 MAA 原生 `--skip-startup-auto-run`，保持原自动启动设置；当前会话 GUI started/Init 日志和目标进程共同证明就绪，历史日志不算。实际游戏任务仍由用户或已批准定时启动。

私有目录的 `maa-config-backups/<操作编号>.json` 保存关停后的原始字节；`daily-pending.jsonl` 追加授权与请求；`daily-runs.jsonl` 追加结果。按操作编号取最后记录：释放锁失败可在一次已读回记录之后追加 unknown。完整配置备份仅留本机，不粘贴到对话。CLI 成功退出 0，其余退出 1；只报告 status、phase、操作编号、允许的变更键和静态原因。部分修改不自动恢复或重开重试。

