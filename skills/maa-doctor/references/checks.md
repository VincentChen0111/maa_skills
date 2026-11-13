# 检查与恢复接口

共享入口是相邻 `../../maa-core/scripts/doctor.ts`。默认人类可读输出，加 `--json` 返回结构化结果。退出码：0 正常或仅有提醒；1 存在错误、修法拒绝或结果未知；2 意外失败。错误不回显配置、路径、原始异常或批准文本。

`check` 返回 `checkedAt`、`exitCode`、`checks` 和 `recovery`，并原子保存到私有目录 `doctor-latest.json`。每条检查包含 `id`、`status`（normal/warning/error）、`reason` 和 `repair`（id、executor 为 skill/user、description）。setup 可以复用导出的 `runChecks(context, maa)`；本接口不替 setup 推定下载或人工操作授权。

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

MAA 已关闭时，用户确认自己没有在操作后添加 `closedConfirmed: true`。若恢复会重新打开理智药、碎石或临期药，添加用户当次批准的 `medicineCount`、`stoneCount` 或 `expiringMedicine`（字段同 maa-daily 的配置事务接口），共享写入器仍检查总量、重复定时及禁止设置；碎石的保存开关和设置会留在配置里，批准前照 maa-daily 的说明告诉用户。原事务的历史授权不授权本次恢复。恢复后仍关着的一类，把字段改回事务之前的值（例如关着时留下的 `StoneCount`、`MedicineCount` 或 `MedicineExpireDays`）不需要这几个授权字段，只要当次点名批准的恢复请求：写入器只在 `restore-config` 里、逐字段对照最新关联备份放行，普通配置写入写同样的值仍要这一类的授权。拒绝时按写入器的静态原因码说明缺哪一项批准。定时窗口、非空闲、备份或重开失败仍按 05 的规则拒绝或保留未知。

原始核对证据仅保存于私有目录 `maa-config-reconciliations/`；配置写入的备份、待执行和结果仍使用 05 的目录和记录。短期恢复互斥文件 `.maa-skills-recovery.lock` 防止两个修法并发接管；遇到残留的恢复互斥也保留，交用户核对。

setup 连接事务也使用同一单配置证据格式，skill 标记为 maa-setup。恢复限于原记录的连接字段，允许恢复 MAA 原有的空／相对 adb 路径及空地址；setup 正常接入仍只选真实存在的 adb 与已测试的本机地址。恢复不重放 adb 连接测试或原安装请求。

损坏/缺失配置、字段外漂移、部分写入、缺备份、最新备份归属不一致或修改时间并列、超过 1000 项历史变更、未知记录或附带其他资源的事务均不自动恢复。MAA 已关闭且配置已生效时，重开是否成功仍未知，不能仅据字段一致就清锁；可在用户点名批准恢复后按关闭确认规则恢复，或由用户先处理 MAA 再重新诊断。
