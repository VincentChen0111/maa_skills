# 基建排班生成与检查接口

`base-plan.ts` 是共享的基建排班工具：按用户的布局、账号快照里已持有的干员和有效技能（复用 [基建技能查询](base-query.md)）生成 MAA 自定义基建排班文件（排班文件），检查六条规则、MAA 干员名表、时间段和 15 项验收门，只在私有目录里写排班文件。需要 Node 24。它是建议工具：不写 MAA 配置、不启动 MAA、不点游戏、不操作设备。把批准的排班写进 MAA 是 maa-daily 的事（工单 23），应用前会重新检查。

带审查和批准的完整报告用 maa-account 的 [基建报告](../../maa-account/references/base-report.md)；本页的 `generate` 只生成并检查排班文件，不保存报告，不能拿去批准。

## 命令

`node <maa-core>/scripts/base-plan.ts <动作>`，参数是经标准输入传入的 JSON；`format` 为 `json`（默认）或 `markdown`。Windows PowerShell 用管道传 JSON 时，非 ASCII 字符和 `?` 都写成 `\uXXXX` 转义；管道加在开头的 BOM 由脚本去掉，返回 `input-encoding-lossy` 时什么都没做，改成转义后重发。

| 动作 | 输入 | 结果 |
| --- | --- | --- |
| `candidates` | `{layout, snapshotFile?, tablesFile?}` | 布局里每间房：有该房间生效技能的已持有干员，按快照顺序，不排序；技能只作用于别的产物时标出 |
| `generate` | 方案（见下）`+ target?, base?, snapshotFile?, tablesFile?` | `{ok, applicable, planFile, sha256, source, errors, warnings, unverified, gates, fills, dropped}`；输入不全时 `{ok:false, status:"needs-input", issues}` |
| `check` | `{planFile, layout, shifts?, mood?, moodDefault?, combos?, exclusions?, efficiency?, tolerance?, runs?, snapshotFile?, tablesFile?}` | `{ok, result}`：检查结果，只读 |

退出码 0 表示成功；1 表示 `needs-input` 或被拒绝，输出 `{ok:false, error:<代码>}`。常见代码：`plan-path-outside-private`、`plan-path-invalid`、`plan-file-missing`、`plan-snapshot-unavailable`、`plan-base-invalid`、`plan-tables-invalid`、`plan-layout-invalid`、`plan-input-invalid`、`public-data-*`。错误只有固定代码，不打印路径或原始内容。

## 方案（agent 提出，标为推断）

```json
{"title":"两班","layout":[{"type":"control","level":5},{"type":"manufacture","level":3,"product":"Pure Gold"},{"type":"dormitory","level":5}],
 "runs":["08:00","20:00"],
 "shifts":[{"name":"白班","period":"07:00-19:00","rooms":{"control":[["干员A","干员B"]],"manufacture":[["干员C","干员D","干员E"]],"dormitory":[["干员F"]]},
   "drones":{"room":"manufacture","index":1,"order":"pre"},"reasons":{"manufacture[0]":"……"}},
  {"name":"夜班","period":"19:00-07:00","rooms":{}}],
 "moodDefault":{"work":1,"rest":2,"basis":"……"},"mood":{"干员A":{"work":0.75,"rest":2,"basis":"……"}},
 "combos":[],"exclusions":[],"efficiency":[{"plan":0,"room":"manufacture[0]","base":100,"skill":60,"global":5,"basis":"……"}],"fill":false}
```

- `layout`：用户说的布局，按 MAA 扩充协议的写法，`type` 取 `control`、`manufacture`、`trading`、`power`、`meeting`、`hire`、`dormitory`、`processing`、`training`、`recycle`，`level` 是房间等级；制造站和贸易站可以写当前产物 `product`（`Battle Record`、`Pure Gold`、`Originium Shard`、`Dualchip`；`LMD`、`Orundum`）。同类房间的顺序就是排班里的顺序和无人机的间号。账号快照里没有基建布局（MAA 识别不提供），所以布局由用户说，缺了就先问。
- `shifts`：每个班次一个计划。`period` 写 `hh:mm-hh:mm` 或 MAA 的 `[["hh:mm","hh:mm"]]`；跨天的会拆成两段（`22:00-06:00` 写成 `22:00–23:59` 和 `00:00–06:00`）。每个班次都必须有时间段。`rooms` 里每间房是名字数组或 `{operators, sort}`；`null` 表示这间房跳过；没写的房间不安排（MAA 跳过它，上一班放进去的人留在原处），`fill: true` 时由工具按快照顺序填入有该房间生效技能、这个班次没用到、相邻的前后两班都没有安排（班次排成一圈，第一班的前一班是最后一班；已经填补的人也算安排）的已持有干员（不比较收益）。训练室不在这里安排。
- `runs`：用户的 MAA 每天运行基建换班的时间（MAA 的定时），`hh:mm`，至少一个、不重复。MAA 运行时按当时时间选包含它的计划，所以要容忍提前运行，时间段的开始要比运行时间早容差时长：用户说「08:00 和 20:00 换班」时，`runs` 写 `08:00`、`20:00`，时间段写 `07:00-19:00`、`19:00-07:00`（上例）。不写 `runs` 时检查把时间段里换计划的时刻当作运行时间，提前运行就会落到上一班。
- `fiammetta`：`{target, order?}`，`order` 只能是 `pre`（默认）；`post` 会被拒绝（`shift-fiammetta-post`）：MAA 在所有设施换班之后才执行菲亚梅塔的两步，宿舍 1 只剩目标和菲亚梅塔，宿舍 1 名单里的其他人整班不恢复，目标也离开工作的房间。`drones`：`{room, index, order}`。
- `mood`、`moodDefault`：每小时净消耗（上班）和每小时恢复（在宿舍），带依据；`combos`：`{members, dependsOn?, basis}`；`exclusions`：`{members, basis}`；`efficiency`：每间房每个计划的基础、技能、全局三部分，带依据、条件和未建模部分。这些都是推断；没给时对应的验收门是「未核实」，不是通过。
- 文字（`title`、`description`、班次的 `name` 和 `reasons`、各处的依据 `basis`、条件和未建模部分，以及基建报告的 `summary`、`assumptions` 和假设的目标）里不写「最优」「最佳」「最好」「最强」「最高效」「optimal」「optimum」「best」，否定句也不写（例如「不是最优」「本方案不声称最优」）：第 15 项验收门不区分肯定和否定，见到这些词就不通过。要说明局限时，写做了哪些检查、没有和其他排法比较过。
- `tolerance`：早晚上线的容差，小时，默认 1。
- `target`：私有目录里的相对路径，默认 `base-plans/plan-<哈希>.json`；`base`：在私有目录里已有的排班文件上修改，保留本工具不认识的字段。

## 导出

每个计划写 `name`、`period`、`duration`（分钟，MAA 的保留字段）、可选的 `Fiammetta`、`drones` 和全部十个设施键：布局里有的设施按间写人，没安排的写 `{"skip": true}`；布局里没有的设施写 `[]`。不写 `product`：MAA 写了产物会尝试切换生产线，方案不依赖这一点。相同的方案和基础文件导出的字节相同。

## 检查结果

- `errors`：房间容量 `room-capacity`、布局外的房间 `room-missing`、计划数 `plan-count`、同一计划重复 `plan-duplicate`、键名大小写 `key-case`、产物 `product-invalid` / `product-switch`、名字不在本机 MAA 名表 `name-unknown`、时间段 `period-format` / `period-overlap` / `period-mixed`、布局超过固定表 `layout-count` / `layout-level`。
- `warnings`：快照里没观察到的干员 `operator-unowned`（和 `name-unknown` 分开），不认识的设施键 `facility-unknown`。
- 显示名对应多个游戏 ID 时取快照里持有的那个形态；快照里都有时记 `ownership-ambiguous:<名字>` 为未核实，技能按未知处理。
- `gates`：15 项验收门，每项 `pass`、`fail` 或 `unverified` 加证据；清单见工单 22，判定条件见仓库里的 `docs/base-plan-verification.md`。
- `unverified`：未核实的验收门（`gate-N`）和不能核对的规则（如 `names:maa-directory-unset`、`ownership`）。未核实不算通过，由用户决定是否仍然应用。
- `applicable`：没有错误、没有不通过的验收门才是 `true`。
- 心情按一条时间线算，照 MAA 的做法逐次运行：每到一次运行时间按时间段选计划，写了名单的房间清空再放人，跳过的房间保持原样，菲亚梅塔满心情时才和目标互换（她不在宿舍名单里就恢复不了）；两次运行之间上班的人消耗、宿舍里的人恢复，其他人不变。模拟到稳定后没有人心情降到 0 才通过第 4 项。第 14 项把一次运行提前或推迟容差时长（以及容差以内 MAA 改选计划的地方两侧）再看一遍；提前运行落在这一班时间段之前时，MAA 选的仍是上一班，上一班一直上到下一次选到别的计划的运行。证据里会写出改法：时间段的开始提前，运行时间写进 `runs`。
- 心情上限、床位、容量和菲亚梅塔的恢复量都从固定游戏表读取；名表读用户本机 MAA 目录下的 `resource/battle_data.json`。

## 导出函数

`generateBasePlan`、`checkPlanText`、`exportMaaPlan`、`parsePlanSpec`、`writePlanFile`、`readPrivateFile`、`planFreshness`、`snapshotFingerprint`、`formatPlanMarkdown` 是同一实现的接缝；maa-daily 应用前经 `base-report.ts` 的 `baseApplyRecheck` 用同一个 `checkPlanText` 和 `planFreshness` 重新检查，见 [基建排班应用](../../maa-daily/references/base-apply.md)。
