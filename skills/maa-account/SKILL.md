---
name: maa-account
description: 读取 MAA 本地识别结果并生成账号快照；按明确目标查询培养成本，比较共享库存、加工和材料凭证后的缺口；按干员或房间查询已持有干员的基建技能、后续解锁和条件。用于账号盘点、导入缓存、培养材料缺口和基建技能查询。
---

# maa-account

先确认相邻的 `../maa-core/scripts/preferences.ts` 和 `../maa-core/scripts/account-snapshot.ts` 存在；maa-account 与 maa-core 必须来自同一版本。缺失时停止操作，直接给出对应宿主的安装方式：

- Codex：用原生 skill-installer 运行 `install-skill-from-github.py --repo VincentChen0111/maa_skills --ref <当前账号入口的固定版本> --path skills/maa-core`。若现有 maa-* 来自不同版本，按宿主更新流程整体重装为同一固定版本；首次安装同时列出 `skills/maa-core skills/maa-account skills/maa-help`。
- Claude Code：首次运行 `claude plugin marketplace add VincentChen0111/maa_skills` 与 `claude plugin install maa-skills@maa-skills --scope user`；已有插件时运行 `claude plugin marketplace update maa-skills` 和 `claude plugin update maa-skills@maa-skills --scope user`，重启会话并复核相邻载荷。插件包含全部 skill 目录。

1. 用 Node 24 运行 `../maa-core/scripts/preferences.ts read`，标准输入传入 `{"currentLanguage":"当前用户语言的 BCP 47 标签"}`。按返回语言回复；未设置时简短提示可以设置。用户要求切换语言或记录偏好时，按 [共享偏好接口](../maa-core/references/preferences.md) 调用，不自己改设置或旧偏好。
   用户问加工、材料券或多个目标共用库存的缺口时，确认相邻 `cultivation-gaps.ts`、`operator-cost.ts` 和 `public-data.ts` 存在，按 [加工与凭证缺口接口](references/gaps.md) 调用只读 `cultivation-gaps.ts query`。保留未知及来源，按所选路线说明先后顺序、费用和不加工对照；有效性未确认的券不计已核覆盖。结果只是建议，不兑换或操作设备，完成后结束该分支。
   用户问单干员培养成本时，转到 [成本查询接口](references/cost.md)，确认相邻 `operator-cost.ts` 与 `public-data.ts` 存在，读取已有快照后调用只读 `query`；完成后结束该查询分支。需要补充识别才进入下面的识别流程。
   用户要查基建技能时，确认相邻的 `base-query.ts` 存在，缺失按上方同版本补装指引处理。读取 [基建查询接口](../maa-core/references/base-query.md)，运行 `base-query.ts query`；已有快照直接查询，无需重做识别。按结果列出当前有效、后续解锁、已替换和待核条目，保留条件、来源及交叉核对差异后结束此分支。仅所查询的干员已在快照中才能确认为持有；未知练度保持待核。查询不写文件、不排班，文本百分比不等于最终收益。
2. 用户要刷新时，请用户在 MAA 界面启动仓库识别、干员识别并等待完成。用户已说明完成或明确要读现有缓存时直接继续，说明读取的是缓存。设备操作和启动识别由用户完成；本 skill 不修改 MAA 配置、不调用 adb、不运行识别任务。
3. 读取 [导入接口](references/import.md)，运行共享 `account-snapshot.ts inspect`，只看脚本的白名单摘要。用户要建立或更新账号快照时再用 `import`；用户只要查看时保持只读。处理路径通过 JSON 标准输入传递，不拼接到 shell。不要把完整缓存、回调或设置文件输出到对话。
4. 报告读取时间、原扫描时间及各域状态。`pending` 请用户等待；`missing` 说明该来源未读到；`invalid` 说明该次解析失败；`partial` 列出缺失事实的类别。即使某项为 `complete`，它也只表示该回调完成并且已返回字段合法，不证明识别覆盖了整个账号。未知练度不能判断满足作业要求，未列库存不能当零。
5. `import` 后以脚本 `saved` 和实际阶段为准；它只写私有目录的账号快照。`account-busy` 表示本次未获得写入权，保留锁和证据；其他失败先核对结果，不删除锁或自动重放。

本阶段可做本地识别盘点、快照导入、培养成本、加工与材料券缺口比较和基建技能查询。森空岛、作业匹配、基建排班与采购建议由后续工单实现；不要伪造这些工具已可调用。抽卡、礼包、付费、登录、碎石以外的源石用途及设备操作仍按项目安全边界拒绝；碎石和临期药只由 maa-daily 在用户当次批准后写入，本 skill 不写。仅盘点已经识别出的数量不授予任何消费或操作权限。
