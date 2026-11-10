# 配置事务接口

唯一实现随 maa-help 安装：`../maa-help/scripts/maa-config.ts`（从 maa-daily 根目录定位）。Node 24；Windows MAA GUI 配置为 `config/gui.new.json`。CLI 从共享设置取 MAA 与私有目录，不接受临时覆盖路径。只把下面 JSON 传给标准输入，使用宿主的参数数组或安全 stdin，不把用户文字拼进 shell。

## 读取与写入

`read` 输出配置序号、任务类型/启用状态、定时槽、提醒字段与 revision 指纹。未知类型显示 `OtherTask`；不输出配置名称、任务名称、连接地址、账号或完整配置。`write.expectedRevision` 必须使用此次摘要的 `configuration.revision`，不能临时读取新值来绕过变更提示。开始时版本不符返回 configuration-changed；关停后任务/定时槽对象变化则保留 unknown，不按旧下标写入。重新核对目标与当次授权后才可重新准备请求。

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

`host` 为 `codex` 或 `claude`，不改变权限。授权来源为 `current-request` 或 `approved-report`；`reference` 记录原请求或已批准报告条目，只保存在私有待执行记录，不输出。`closedConfirmed` 仅在用户明确确认未操作已经关闭的 MAA 后设为 true。设置路径由 `MAA_SKILLS_HOME` 定位，测试必须使用临时设置。

允许修改已存在的字段；不生成新配置或任务：

| path（方括号为数组元素） | value |
| --- | --- |
| `["Configurations",配置序号,"TaskQueue",任务位置,"IsEnable"]` | 布尔值；启用仅支持已核的普通任务，未知类型和 StartUp 等入口不自动启用 |
| `["Configurations",配置序号,"TaskQueue"]` | 原队列位置的完整排列，例如 `[2,1,0]`；每个位置只出现一次，重复 TaskType 也可独立排序，保留原任务对象，不与同队列字段改动混用 |
| `["Configurations",配置序号,"TaskQueue",Fight位置,"UseMedicine"]` / `"MedicineCount"` | 当次 `authorization.medicineCount` 为本次总上限（0–2147483647）；各任务按用户明确的分配设置数量和开关，来源必须为 current-request；启用药剂时同时设置这两个字段 |
| `["Timers","List",槽位,"IsEnabled"]` | true 为每日定时、null 为原生单次、false 为关闭 |
| 同一路径末项为 `"Hour"` / `"Minute"` / `"Config"` | 本机时间小时 0–23、分钟 0–59、目标配置序号；槽位 0–7 且必须已存在 |
| `["Timers","CustomConfig"]` / `"ForceScheduledStart"` / `"ShowWindowBeforeForceScheduledStart"` / `"NotifyBeforeScheduledStart"` | 布尔值 |
| `["Timers","ScheduledStartNotificationMinutes"]` | 1–1439 分钟 |

启用 Fight 或定时还会检查其实际启用的任务，拒绝间接激活源石、免费抽卡、特殊礼包和无当次数量的药剂。不会为通过检查擅自关闭既有设置；先报告原因。临期药等无数量限制的入口不在授权通道内。未知或缺失字段停下核对；不会用猜测补键。

药剂按相关配置中所有启用 Fight 的合计核对，包含原有启用任务；不能让多个任务各自复用同一个数量。相关单次定时重复执行同一配置时按次数累计；每日重复无法由一次有限数量授权覆盖，故有药剂消耗时拒绝启用或改配该重复计划，不擅自关掉用户原有定时。

## 事务与失败

写入锁在目标 MAA 的 `config/.maa-skills.lock`，跨宿主共享；记录 skill、host、PID、时间、操作编号和阶段。每个事务由一个进程持锁。活跃锁返回 busy，遗留或损坏锁返回 unknown，均不删除。结果未知时保留锁、备份及临时证据，等待 doctor/人工核对。

本次停机预算 120 秒，包括正常关停最多 30 秒、重开最多 60 秒和文件操作余量；每个阶段重新核对。整个区间避开所有每日/单次定时前 2 分钟至触发分钟结束，使用 MAA 所在电脑本地时区；修改后的新定时也检查。超预算或未能证明窗口安全时报告实际阶段，不声明完成。

必须确认目标路径的 MAA 及已见子进程树退出后才备份、改盘；写入前再查。只正常关闭窗口，拒绝退出不强杀。托盘状态没有可关闭主窗口时，请用户恢复主窗口或自行关闭并确认。重开带 MAA 原生 `--skip-startup-auto-run`，保持原自动启动设置；当前会话 GUI started/Init 日志和目标进程共同证明就绪，历史日志不算。实际游戏任务仍由用户或已批准定时启动。

私有目录的 `maa-config-backups/<操作编号>.json` 保存关停后的原始字节；`daily-pending.jsonl` 追加授权与请求；`daily-runs.jsonl` 追加结果。按操作编号取最后记录：释放锁失败可在一次已读回记录之后追加 unknown。完整配置备份仅留本机，不粘贴到对话。CLI 成功退出 0，其余退出 1；只报告 status、phase、操作编号、允许的变更键和静态原因。部分修改不自动恢复或重开重试。

