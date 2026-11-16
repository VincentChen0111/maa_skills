# 26 D-N1（写入请求只带会变的字段）：独立审查

日期：2026-11-16。改动包 `a6e306a..a5a5ac7`（一个提交 `a5a5ac7`，基点是当时的 main `a6e306a`）。范围：`skills/maa-daily/references/configuration.md`「预览与差异指纹」一节新增「请求只带会变的字段」一段，规格三处登记（`docs/spec.md`），两项测试（`tests/docs-consistency.test.ts`、`tests/consumption-grant.test.ts`），验证记录 `docs/release-payload-verification.md` 的 D-N1 一节。#106 合并为 main `2c9f520` 后，本分支无冲突变基到 `480fc86`，`skills/` 的差异与 `a5a5ac7` 逐字节相同（协调者决定 D-N5，见验证记录）。每轮一名新的独立审查员，读自包含说明、规格和 diff，只报告真实缺陷；协调者逐条复核，只接受真实环境里会发生的具体故障，理由写在每条后面。轮次上限 3。

## 第 1 轮

范围 `a6e306a..a5a5ac7`。一名新的独立审查员。结论 GO：P3 2，没有 P1、P2，没有安全类发现。

协调者逐条复核：

| 编号 | 发现 | 结论 | 理由 |
| --- | --- | --- | --- |
| P3-1（文档） | 验证记录 D-N1 一节（`a5a5ac7` 约第 178 行）说历史上 8 次运行都在 main 自己的载荷上；实际只有 4 次在 `a6e306a`，另外 4 次在训练修复分支的载荷 `5761e35`（`configuration.md` 与 main 相同） | 接受 | 记录写的事实与证据不符 |
| P3-2（文档） | 同一节「评测影响」（约第 197 行）说受影响的是经 `maa-config.ts` 读或写配置的场景，却只列了 `eval/maa-daily/scenarios.ts` 的 15 个和 `cross-skill-setup-account-daily`；maa-daily 的关卡作业准备、基建排班应用等场景也运行 `maa-config.ts read`，专精场景经 `training-plan.ts apply` 写入 | 接受 | 记录要如实写出本包评测的范围；完整的场景目录在发布前比较 |
| W-1、W-2（审查员列出的两种退出保存情形） | 写入期间，MAA 退出时的整份保存改动了一个本来已是目标值、因而从请求里去掉的字段 | 拒绝 | 弱点而不是缺陷：要用户恰好在写入的那几秒内到 MAA 界面里切换这个字段，正式环境几乎不会出现；写入器也不会因此打开任何消耗设置 |

审查员同时指出实现者说明里的机制写错了：抓到上面这种情况的不是 `prepare()`，而是写入器在关停 MAA 后的配置上运行的 `checkTargets`（`skills/maa-core/scripts/maa-config.ts` 第 863 行）。目标路径在 TaskQueue 上截到任务一级（第 768 至 772 行），所以被去掉的字段变了也会让整个任务的比较不同，以 `authorized-target-changed` 停下；这时还没有备份和写入，结果记为 `unknown`（`reconciliation-required`），锁保留，失败即关闭。仓库文字里没有写 `prepare()` 这一机制（搜索了 `prepare()`、`checkTargets` 和本分支的全部差异），不需要更正。

修复（记录修复提交，只改文档）：

- P3-1：验证记录按载荷分别写次数：main 的载荷 `a6e306a` 4 次失败 3 次（`Gs7BLk` 的 `nltyKo`，`zy4Rgo` 的 `jehc2r`、`xXTENM`；通过的是 `zy4Rgo` 的 `bSTMDH`），训练修复分支的载荷 `5761e35` 4 次失败 2 次（`XgvbIz` 的 `SG8LFY`、`utFHPG`；通过的是 `XgvbIz` 的 `mPN2yX`、`AGAdmw` 的 `cLPJ3M`）。已只读核对这 8 次运行的 `run.json`：载荷提交和评分结果与上面一致，5 次失败都挂 authorization、write-lock、expected-behavior。
- P3-2：「评测影响」改为本包评测的真实标准：agent 直接调用 `maa-config.ts`、要写时写入请求由 agent 自己拼的场景（新增的一段只管这一件事），仍是这 16 个；另外列出也读 `configuration.md`、但写入请求由脚本生成的场景（关卡作业准备 4 个经 `stage-jobs.ts prepare`，关卡运行与换备选 10 个经 `stage-run.ts`，专精 14 个经 `training-plan.ts`，基建排班应用 10 个经 `base-apply.ts`，setup 的连接写入 `setup-connection-write` 经 `setup.ts apply`），写明它们由发布评测在重建的候选上按整份场景目录比较。
- 同一节把「未验证：真模型是否照这段文字只带会变的字段」换成实际的前后评测：前批 `batch-LQzEgy`（`a6e306a`）15 通过 1 失败，后批 `batch-4GYJr1`（`a5a5ac7`）16 通过，`compare` 退出码 0、总体 `pass`、没有要重跑的场景，`daily-expiring-approved` 单独重跑两批 `batch-6xDeZy`、`batch-clOACv` 各 3 次通过；变基不重跑评测（D-N5）。仍未验证的保留：Claude 一侧没有评测；「去掉后再预览一次」的路径没有专门场景；其他场景和与 #106 合在一起的载荷由发布评测比较。
- 「本包实际运行的命令」里「没有调用模型，没有运行真实的 `codex`」改为只说离线检查，真模型只在前后评测里运行。

第 2 轮审查复核这次记录修复。

## 第 2 轮

范围：`480fc86..8ee313c`（只改 `docs/release-payload-verification.md` 和本文件），并复核变基：`2c9f520..480fc86` 与第 1 轮的 `a6e306a..a5a5ac7` 内容逐文件相同，`configuration.md` 在 `a5a5ac7` 和 `480fc86` 是同一个 blob。一名新的独立审查员。结论 GO：P3 1，没有 P1、P2。

| 编号 | 发现 | 结论 | 理由 |
| --- | --- | --- | --- |
| R2-P3-1（P3） | 上面 P3-1 的修复说明写「已只读核对这 8 次运行的 `run.json`：载荷提交……」；`run.json` 没有载荷提交字段，提交在同一批次的 `manifest.json`，`run.json` 只经 `payloadFingerprint` 与它对应。写下的事实和次数都对 | 拒绝，判为弱点，不修 | 次数、运行 id 和结论都与证据相符，只是把一项核对的出处写成了同一批次目录里的另一个文件；没有门禁或结论依赖它 |

审查员实际核对：变基前后的改动相同；在变基后的头上 `npm run typecheck` 通过，`docs-consistency`、`consumption-grant`、`maa-config` 共 193 项全部通过；四批的清单（模型、宿主版本、认证、运行器指纹 `5408aba3…`、载荷提交和摘要）与记录一致；`compare batch-LQzEgy batch-4GYJr1` 退出码 0、总体 `pass`；修复后 7 次运行的写入请求都只带两项；P3-2 列出的场景数按场景模块逐个枚举相符。

本包的审查到此结束，没有未关闭的 P1、P2。
