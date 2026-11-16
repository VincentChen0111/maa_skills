# 26 重建的发布候选包（试用修复之后）：独立审查

日期：2026-11-16。范围 `f51ba18..5d339bc`：
- `31189cc`：发布候选分支 `f51ba18` 合并 main `f99a037`（#105、#106、#107 试用修复），就是重建后冻结的最终候选；
- `5d339bc`：发布验证计划里「第五次真实运行」的评测计划、冻结结果、载荷表和人工核实清单的新行，以及发布说明和更新记录里试用修复对用户的变化。

最终候选 `31189cc`（`5d339bc` 只改文档，这三个值相同）：
- `skills/` 树：`2dae9c585b9aa83979fef4550f6c45f6dfd5e59a`；
- `.claude-plugin/` 树：`e69d80fa425fe0693da3ba6f1b08c40374a88439`；
- 载荷内容摘要：`64e95544ac169b295d1784af1e24a99c3da48ed4e01f286ed388bc5fd6447f4e`。

本包不发布、不打标签；按 D-N2，合并发布候选的 PR（#95）、打标签和装进维护者自己的 Codex 都留给维护者。

审查方式：
- 每轮一名新上下文的独立审查员，不调用模型、不运行宿主 CLI、不联网（维护者的「单审查员所有包」）；
- 最多三轮（维护者定的上限「轮数上限3」）；
- 协调者逐条复核发现，只接受真正的缺陷，弱点拒绝。

## 第 1 轮

范围 `f51ba18..5d339bc`。一名新的独立审查员。结论 NO-GO：P2 1、P3 4，没有 P1，没有安全类发现。

审查员核对了，都正确：
- **合并。** 合并提交 `31189cc` 逐个 blob 与两个父提交核对。
- **冻结事实。** 发布验证计划第 1 步「冻结结果」记的提交、两棵树和载荷内容摘要。
- **场景清单。** 「后」批次、基线批次和 13 行「前」各自的场景清单。
- **载荷清单。** 第 2 步表里各提交的载荷。
- **发布说明。** 发布说明和更新记录。

审查员另外判定：#106 新增的 11 个场景只建基线是已登记的设计默认值，可以接受，不改。

协调者逐条复核：

| 编号 | 发现 | 结论 | 理由 |
| --- | --- | --- | --- |
| F1（P2） | 发布验证计划的 J16（`daily-stage-prepare-user-confirmed`，约第 415 行）通过条件要求第一次查询作业 1 是 unknown、第二次查询带用户确认的事实。场景并不要求两次查询：提示词给出用户原话，要求用 `stage-jobs.ts query`、`saveReport` 为 true、只保存一次报告（`eval/maa-daily/stage-scenarios.ts` 第 68、80 行），生成文件是 3 个（第 75 行）；最可能的正确做法是第一次、也就是保存报告的那次查询就带上用户确认的 `operatorFacts`（`skills/maa-daily/references/stage-jobs.md` 第 11 行允许） | 接受 | 现在的写法会把正确的运行判为不通过，发布会被假失败挡住 |
| F2（P3） | G4（约第 337 行和文首设计默认值第 52 行）：模型自己改正的输入错误（`stage-jobs-request-invalid`、`stage-jobs-operator-facts-invalid`、`stage-jobs-job-confirmations-invalid` 都输出 `status: "check-required"`，`skills/maa-core/scripts/check-required.ts` 第 58–63 行）也会触发 G4，而正确的最终回复不必提起模型自己改掉的错误 | 接受 | 否则正确的运行会被判不通过 |
| F3（P3） | 约第 415、420、428、430、432 行写归一 `events` 里有 query、prepare 的标准输入。`events` 只记文件、动作、退出码和进程号（`eval/observe-node.mjs` 第 20–23 行）；标准输入只有 `maa-config.ts` 的调用记在 `daily` 的 `inputBase64`（`eval/daily-observer.mjs` 第 87–99 行）。`stage-jobs.ts`、`training-plan.ts` 的输入只在命令文本里：`host.jsonl` 的 `command_execution`，或 `evidence.json` 的 `transcript.calls[].input`（`scripts/evaluation.ts` 第 41–43 行） | 接受 | 记录指错了要看的位置 |
| F4（P3） | T17（约第 433 行）通过条件「只有 list」比场景严：场景允许 `training-plan.ts read`（`eval/maa-daily/training-scenarios.ts` 第 36 行），禁止的是 prepare、apply、refresh、close、reconcile（第 89 行） | 接受 | 一次无害的 read 会让这一项不通过 |
| F5（P3） | 维护者试用的两项要求既没有检查项，也没有登记为未验证：训练流程里的材料券建议（maa-core `references/training.md` 第 13 行：先问券的数量，用户不回答也按 `decomposition.vouchers` 给不依赖数量的建议；试用第 6 项），和养成报告展开到基础材料（maa-account `references/cultivation-report.md` 里 #106 加的一段；试用第 8 项）。T6b 只核 `short` 和 `lmdGap`，材料券建议只有 maa-account 缺口查询的 P10 核 | 接受 | 记录不能暗示有它没有的覆盖 |

修复（一个提交，只改 `docs/release-verification.md` 和本文件；`skills/`、`.claude-plugin/`、`eval/`、`scripts/`、`tests/` 都不改，最终候选和正在运行的评测不受影响）：

- F1：J16 改为：生成并被准备的那份报告来自带这条事实（`source: "user-confirmed"`、用户原话作 `reference`、二技能专精 3、Y 模组 2 级）的 query；作业 1 是 unknown 的报告不准备；快照不变；一次 query 或两次 query 都算通过。
- F2：G4 只核运行留给用户的那一次 check-required（用户这次要求的最终结果，或模型转述给用户、因它停下的那一次）；模型在同一次运行里改正自己的输入、重发后成功的那一次不按 G4 判，在记录里注明。文首设计默认值那一行、清单的 G4 行和「范围和适用规则」都改了，来源仍是维护者原话「check required 要给我具体的，和有没有替代」。
- F3：清单前加一段「脚本输入在哪里看」：`events` 不记输入；`maa-config.ts` 的标准输入在 `daily.observations[]` 的 `inputBase64`；其他脚本的输入看 `host.jsonl` 的 `command_execution` 或 `transcript.calls[].input`。J16、J21、T12、T14、T16 五行的「看哪份」改到这些位置。同类的 S2b（`daily-expiring-approved`，「归一 `events`（write 的标准输入）」）审查员没有点名，按「一个修复包覆盖这条规则的每个使用者」一并改为 `daily.observations[]` 里 `write` 那条的 `inputBase64`。
- F4：T17 通过条件改为「`training-plan.ts` 只有只读调用（list、read）；没有任何写入」。
- F5：「未验证与需要维护者的事项（变化）」加一条：这两项要求这次没有任何场景覆盖，留给维护者在 Codex 里手动试用时核对。

修复后运行（2026-11-16，本机 Windows，修复提交之前的工作区）：

| 命令 | 结果 |
| --- | --- |
| `node scripts/release-check.ts versions --release` | 退出 0，`ok: true`，版本 `0.1.0`，没有错误 |
| `node --test tests/docs-consistency.test.ts tests/release-check.test.ts` | 18 项全部通过 |
| `node scripts/privacy.ts` | 退出 0，没有发现 |
| `git diff --stat 5d339bc..<修复提交>` | 只有 `docs/release-verification.md` 和本文件 |

没有调用模型，没有启动宿主，没有推送；没有碰正在运行的评测的冻结框架。

第 2 轮审查复核这次修复。

## 第 2 轮

（待审查：范围 `5d339bc..<修复提交>`，一名新的独立审查员，复核上面五条修复和 S2b 的同类修正。）

## 结论与未验证

- 到第 1 轮修复为止：结论待第 2 轮；F1（P2）在第 2 轮确认修好之前，本包不进 main、不进任何发布。
- 未验证：第五次真实运行的批次、`compare` 和第 3 步人工核实（正在运行或还没做）；F5 的两项要求只能靠维护者手动试用核对；两个宿主在最终候选上的原生安装。
