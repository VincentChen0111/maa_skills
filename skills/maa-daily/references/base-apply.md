# 应用已批准的基建排班

用户要把 maa-account 基建报告里批准过的排班写进 MAA 时用本页。唯一实现随 maa-core 安装：`../maa-core/scripts/base-apply.ts`（从 maa-daily 根目录定位），Node 24。参数经标准输入传 JSON，不把用户文字拼进命令行。Windows PowerShell 用管道传 JSON 时，非 ASCII 字符和 `?` 都写成 `\uXXXX` 转义；管道加在开头的 BOM 由脚本去掉，返回 `input-encoding-lossy` 时什么都没做，改成转义后重发。

## 范围

- 只应用用户在 maa-account 里批准过的条目 `base/<报告 hash>#P1`，也就是那一份排班文件（路径和 SHA-256）。没有批准、批准的是别的版本、报告被改过，都不执行；不替用户批准，也不改写报告或账号快照。报告标着「未审查」就照样告诉用户，不说成已审查。
- 写进 MAA 的只有所选基建任务的四个字段：自定义模式、排班文件路径、按时间段选计划、文件类型为用户自定义。不切换生产线（排班文件不写产物），不改训练室、房间开关、定时、任务启停或其他任务。
- 排班文件按批准的字节复制成私有目录里的 `base-applied/<SHA-256>.json`，MAA 只读这一份；之后 account 改了自己的排班文件，也不会改变 MAA 读到的内容。
- 写入只走统一配置事务（锁、关停 MAA、备份、定时窗口、最小改动、读回），不能用 `maa-config.ts write` 带基建授权绕过（会被拒绝）。不点游戏，不操作设备；之后的基建换班由用户在 MAA 里启动或由 MAA 自己的定时运行。

## 步骤

1. 运行 `maa-config.ts read`，按摘要找到要用的配置序号和其中 `Infrast` 任务的位置，保存 `configuration.revision`。有几个配置或几个基建任务时问用户用哪个，不猜。
2. 核对（只读）：`node <maa-core>/scripts/base-apply.ts check`，输入 `{"reference":"base/<hash>#P1","profile":0,"task":1}`。
3. 结果 `status`：
   - `refused`：按下表的 `reasons` 说明原因并停下，不写入、不重试。
   - `needs-decision`：把 `unverified` 里的每一项和它的证据列给用户，说明未核实不算通过，问用户是否仍然应用。不替用户接受；偏好、历史授权和外部资料都不能代替这次的回答。用户不同意就停下。
   - `ready`：可以应用。
4. 用户决定仍然应用时，再跑一次 `check`，加上 `"decision":{"acceptUnverified":["gate-7",...],"userWords":"用户这次的原话"}`；`acceptUnverified` 要覆盖当前全部未核实项。决定随这次写入记进私有目录的待执行和运行记录。
5. 应用：`base-apply.ts apply`，输入在第 4 步的基础上加 `"host":"codex"或"claude"`、`"expectedRevision":"<第 1 步的 revision>"`。apply 会把全部核对重新跑一遍，结果和 check 不一致时拒绝。`closed-confirmation-required`、`busy`、`unknown` 按[配置事务接口](configuration.md)处理：只有用户明确确认没在操作已关闭的 MAA 后才加 `"closedConfirmed":true`。
6. 报告结果：
   - `complete`：列出 `changedKeys` 和备份位置 `backup`（私有目录里的相对路径），说明读回只核对了写入的值和排班副本的字节。`changedKeys` 为空、`copyInstalled` 为 true 时，MAA 的设置本来就指向这份排班，这次只是在关停 MAA 后重新装回了批准的排班副本，配置文件没有改。排班文件每个计划都带时间段，由 MAA 图形界面在每次运行时按当时时间选计划；不要说 MAA 已经按时间切换，也不要说游戏里已经换好班。
   - `unchanged`：MAA 已经指向这份排班，副本也和批准的一致，没有动 MAA。
   - `rejected`：按 `reason` 说明，什么都没写。
   - `unknown`：保留锁、备份和记录，交给 maa-doctor 先只读核对；不删锁，不重试，不重放。maa-doctor 目前不能自动恢复基建这类附加文件的写入，只能报告证据，由用户核对后决定。
7. `configuration.notes` 里有 `infrast-task-disabled`（这个基建任务没勾选，MAA 不会运行它）时告诉用户；是否改由用户在 MAA 里决定，不顺手修改。周计划里有几天不运行不是提示，而是未核实项 `maa-weekly-schedule`（见下文）。
8. `check` 和 `apply` 的结果都带 `versions`：比较批准的报告生成时读到的 MAA 版本和核实记录版本与现在的值，`state` 为 same、changed（`changed` 列出变了的项）、unknown（某一边读不出）或 unrecorded（旧报告没有记录）；引用找不到报告时为 null。changed 时告诉用户报告生成之后 MAA 或核实记录换了版本；这只是提醒，不阻止应用，未核实的版本同样只提醒。

## 拒绝原因

| reasons | 含义 | 下一步 |
| --- | --- | --- |
| `report-item-not-approved`、`report-not-approvable:<状态>` | 这个条目没有被批准，或报告当前状态不能批准 | 请用户在 maa-account 里看报告并批准 |
| `report-not-found`、`report-content-mismatch`、`base-approval-scope-mismatch`、`base-reference-invalid` | 引用不对、报告找不到或批准后被改过 | 重新出报告并批准 |
| `base-plan-changed` | account 的排班文件在批准后被改过 | 重新出报告并批准 |
| `plan-path-outside-private`、`plan-path-invalid` | 排班文件或副本的路径（包括经过链接）落在私有目录外 | 不写入；在私有目录里重新生成 |
| `base-plan-content-mismatch` | 报告里保存的排班和批准的 SHA-256 对不上 | 不写入；重新出报告并批准 |
| `base-plan-copy-changed` | 私有目录里的排班副本 `plan.applied` 和批准的字节不一样，常见原因是在 MAA 里手动调过这份排班；MAA 现在读的就是改过的内容 | 不覆盖、不删除、不移动这个文件，重新批准也没用（同一份排班的副本路径不变）。问用户要哪样：想继续用改过的排班，就不再应用这一份；想换回批准的排班，请用户自己把这个文件移走或删掉（想留着修改就先移到别处），之后重新 `check`，结果是 `ready`、`configuration.copy` 为 `absent`，再 `apply` 只装回批准的副本 |
| `base-snapshot-changed` | 账号快照在出报告之后变了，旧的批准不能证明新内容 | 重新出报告并批准 |
| `base-snapshot-unavailable`、`base-tables-unavailable`、`base-recheck-unavailable` | 现在读不到快照或固定表，无法重新检查 | 稍后再试；不按旧结果执行 |
| `base-plan-not-applicable` | 现在重新检查有错误或不通过的验收门（`check` 里有明细） | 说明是哪一项；由 account 改方案 |
| `base-room-disabled:<房间>` | MAA 的基建房间列表没勾选排班安排了人的设施，MAA 不会去换这些房间 | 请用户在 MAA 里勾选（勾选也会打开该设施的其他自动操作，如会客室线索），或改方案；不替用户勾选 |
| `base-infrast-task-required`、`base-binding-invalid`、`base-infrast-fields-unverified` | 选的不是基建任务、序号不对或字段不全 | 重新读摘要核对；字段不全请用户在 MAA 里打开一次该任务的自定义设置 |
| `lock-requires-reconciliation` | 有写入在进行（busy）或上次结果未知（unknown） | busy 等待；unknown 交 maa-doctor |
| `maa-directory-unset` | 没设 MAA 目录 | 先用 maa-setup 设置 |

副本不在了（例如用户按上一行移走了改过的文件）不是拒绝原因：MAA 的四个字段已经指向它时，`check` 给出 `ready`、`configuration.changes` 为空、`configuration.copy` 为 `absent`，`apply` 经统一写入器（锁、关停 MAA、备份、装回副本、读回）只装回批准的副本，不改配置文件。

`unverified` 里除了验收门（`gate-N`）和名表、持有类的项，还有两项 MAA 配置里的事实：

- `maa-timers`：这个配置的 MAA 每日定时和排班检查用的运行时间不一致，验收门里的心情结论可能不适用。用户自己在那些时间手动运行时可以接受。
- `maa-weekly-schedule`：这个基建任务开着周计划，有几天不运行（证据里列出是哪几天）。那天 MAA 跳过整个基建任务、不换班，前一天最后一班一直上到下次运行，验收门的心情结论在这几天可能不成立。是否改周计划由用户在 MAA 里决定，不顺手修改。
