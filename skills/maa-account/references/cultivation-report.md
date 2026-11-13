# 培养报告接口

培养报告回答「按我的玩法优先级先练谁、每一步花多少、库存够到哪一步」。用 Node 24 运行相邻的 `../maa-core/scripts/cultivation-report.ts`；保存之后的审查、跳过、改正和批准按 [建议报告与独立审查接口](../../maa-core/references/advice-report.md) 处理。缺共享脚本时按入口的同版本安装指引处理。

报告里的数字都来自工单 14 的共享缺口计算（[缺口接口](gaps.md)），资料来自共享调研工具（[社区调研接口](../../maa-core/references/research.md)）和作业站的只读查询。你提供的只有：玩法优先级、步骤顺序、每一步的推荐理由、假设和总体推断，报告把它们标为推断。不要在理由里自己写数字；需要数字时引用报告的工具计算。

## draft 的输入

```json
{
  "priorities": { "source": "user-stated", "text": "用户原话，例如：肉鸽优先" },
  "steps": [
    { "name": "合成干员", "target": { "elite": 2, "level": 1 }, "reason": "推荐理由（推断）", "evidence": ["E1", "J1"] },
    { "name": "合成二号", "operatorId": "可选", "target": { "mastery": { "2": 3 } }, "current": { "source": "user-confirmed", "skillLevel": 7, "mastery": { "2": 0 } }, "reason": "……" }
  ],
  "evidence": [
    { "id": "E1", "type": "nga-post", "thread": 12345, "page": 1, "floor": 3 },
    { "id": "J1", "type": "job", "stageId": "<固定关卡表 stageId>", "code": "1-7", "difficulty": "normal", "jobId": 12345 },
    { "id": "C1", "type": "research-item", "sourceLabel": "森空岛社区", "experimental": false, "item": { "…": "共用结果格式 items[] 中的一条，原样" } }
  ],
  "assumptions": ["其他假设（推断）"],
  "summary": "总体推断",
  "progress": { "source": "user-confirmed" },
  "inventory": { "source": "user-confirmed" },
  "mode": "craft",
  "format": "json"
}
```

1. `priorities` 必填。用户说过玩法优先级时，`source` 为 `user-stated`，`text` 用用户原话；没说时先问，或者写出你的假设并用 `assumed`，报告会标「假设（你没有说明，请确认）」。缺少时返回 `priorities:missing`，不保存。
2. `steps` 按你建议的顺序排列，每一步都要有 `reason`。`name`、`operatorId`、`target`、`current` 的写法和 [成本接口](cost.md) 一样，`progress`、`inventory`、`mode`、`snapshotFile` 和 [缺口接口](gaps.md) 一样，含义也一样：用户确认的事实才加 `user-confirmed`，未知不当 0。同一个干员只能出现一次：同一干员的几个目标合并成一步，这是共享缺口计算的规则（`gaps:targets:duplicate-operator-combine-goals`）。
3. `evidence` 每条有唯一的 `id`，步骤用 `evidence` 列出引用的编号。
   - `nga-post`：只能引用你已经用 `nga.ts read` 读过的那一楼。报告工具只从共享 NGA 读取工具的缓存里取，不发请求；没读过返回 `evidence:<id>:not-cached`，楼层不在这一页返回 `post-not-found`。检索结果只有标题，不能当成观点引用。
   - `job`：关卡用 `stage-jobs.ts stages` 得到的精确 `stageId`、代码和难度，作业编号来自作业查询。报告工具重新运行共享的只读作业查询（公开 GET）和逐成员匹配，取这份作业对报告里干员的要求和当前快照的核对结果；作者和日期未知，作业能否通关未验证。查不到返回 `job-not-found`，站点不可用返回 `job-site-unavailable`。
   - `research-item`：其他来源（工单 19 的森空岛社区、实验性 B 站）的结果，把共用结果格式里的一条 `items[]` 原样放进 `item`。报告标「调用方转交，报告工具未从缓存核对」。NGA 的条目不能这样传，必须用 `nga-post`。
4. `revisionOf` 只在按审查改正时使用，见建议报告接口。

## 结果

保存成功时输出 `{ok:true, status:"pending-review", reportHash, reference, supportedThrough, steps:[{id, title}]}`。步骤编号依次为 S1、S2……，也是批准时用的条目编号。输入不全时输出 `{ok:false, status:"needs-input", issues}` 并退出 1，不保存：`priorities:*`、`steps:S<n>:*`（例如 `reason-missing`、`evidence-unknown:<id>`、成本工具的 `operator:not-found`、`current.<字段>:unknown-or-invalid`）、`evidence:<id>:*`、`gaps:*`（共享缺口计算的待核项）。照这些项问用户或补读资料，不要猜。

报告内容（`read` 可以看到全文）：

- 每一步的 `cost`：这一步自己的原始材料、龙门币和经验，就是共享计算里这个目标的成本。
- 每一步的 `cumulative`：共享缺口计算对第 1 到第 k 步一起计算、所选方案（加工或不加工）的需求、库存和仍缺，以及其中的加工费用；`supported` 为 `true`（到这一步库存足够）、`false`（按这个方案仍缺）或 `null`（有待核项）。
- `supportedThrough`：从第 1 步起连续够用的步数。共享计算按输入顺序分配、未穷举替代路线，所以「不够」只是这个方案不够，不代表任何方案都不够。
- `gaps`：全部步骤一起计算的完整共享结果，包括路线、账本、来源提交和读取时间。
- `evidence`：每条资料的作者、发布时间、来源链接和楼层、读取时间、可信度和局限；作者或日期未知就写未知。

Markdown 模板是中文，按设置语言转述。正文分「事实」（工具计算、快照、原文摘录）和「推断」（你的理由、假设、总体推断），帖子和作业标题只放在引用块里。报告只是建议，不加工、不兑换、不写 MAA 配置、不操作设备。
