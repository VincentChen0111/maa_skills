# 26 评测框架修复包 H4（结果未知时的 doctor 交接与禁止尝试）：独立审查

日期：2026-11-15。范围 `dd77d09..eca8106`：
- `6855653`：实现；
- `8b811ce`：协调者补记三次重跑；
- `2ac53ea`、`49c201b`、`eca8106`：审查修复。

## 起因

第三次真 Codex 运行在候选 `24ac409` 上，`daily-base-apply-unknown` 由过变挂：
- 提示词要求「转给 maa-doctor 核对」，模型照做了；
- doctor 核对写下了 `private/doctor-latest.json`，场景却没有授权这个文件，于是挂了 authorization。

这和第一次运行里 `daily-unknown` 的问题（R8a/R8b）同类，是第二次出现，按复发规则改成一个辅助函数、一个所有者，再加一致性测试。

## 审查方式

- 每轮一名新上下文的独立审查员，用真实 CLI 加合成 MAA 的夹具和宿主替身离线复现，不调用模型、不运行宿主 CLI、不联网；
- 三轮，在维护者定的上限（「轮数上限3」）之内。

## 第一轮

结论：有条件通过，P1 0、P2 1、P3 1。

| 意见 | 处置 | 理由 |
| --- | --- | --- |
| P2（安全）：交接放行了所有 `doctor.ts` 命令，场景里没有禁止调用；被产品拒绝的 `doctor repair` 尝试判通过。H4 之前这种尝试会判失败。被锁拒掉的 `base-apply apply`、`maa-config write` 也判通过，这一点原来就有 | 接受（`2ac53ea`）：`doctorHandoff` 禁止 repair 和重放写入，`daily-base-apply-unknown` 另外禁止 apply | 「结果未知只核对、不重放」考的正是模型会不会尝试；产品拒绝了，不等于模型做对了 |
| P3：一致性测试只覆盖预置遗留锁的世界，漏了运行中才变成未知结果的 `daily-close-failure`、`daily-restart-failure` | 接受（`2ac53ea`）：新增 `runtimeDoctorHandoff`，按结构可选授权 `private/doctor-latest.json`（评分器加 `fieldTypes`）；一致性测试覆盖全部未知结果场景 | 模型照流程交接时会被误判失败、挡住发布；这两个世界的记录不是固定值，没法逐字授权 |

协调者另外要求一并修 maa-doctor 组的同类缺口（`49c201b`）：10 个场景的正确行为都不该调用 repair，却没有禁止它，于是加上禁止，并新增一致性测试：放行 repair 的每个场景，要么期望 repair，要么禁止它。

## 第二轮

结论：不通过，P1 0、P2 1、P3 0。

| 意见 | 处置 | 理由 |
| --- | --- | --- |
| P2（安全）：maa-doctor 组的四个遗留锁世界只禁止了 repair，没有禁止重放写入；离线复现中，被写入器拒绝的重放判 8/8 通过 | 接受（`eca8106`） | 同一类问题第三次出现。按复发规则，统一由一个判定 `refusesReplay` 覆盖全部 14 个放行者：每个未知结果场景都必须禁止重放写入，只有事务本身限定只许一次写入的运行中未知世界例外 |

审查员另核实了构建者的一条观察：在 `daily-restart-failure` 的世界里，`doctor repair` 带模型自己写的引用会成功，原因是评测的 MAA 进程替身总是报告在运行。真实的重启失败中 MAA 已关闭，repair 会以 `reconciliation-unproven` 被拒。按产品设计，引用就是用户的原话，CLI 无法核实是谁写的。这不是产品缺陷。

## 第三轮

结论：通过，P1 0、P2 0、P3 0。审查员核对了：
- **重放复现。** 第二轮的复现全部判失败；正确路径都通过，包括带 repair 的 `doctor-reconcile-approved`。
- **判定的例外收得紧。** 在临时副本上做了六种变异：遗留锁世界拿不到运行中未知的例外；逐个去掉禁止，都会报错。
- **其他禁止尝试都判失败。** 经 shell 删锁或改名，在 7 个世界里全部判失败；其余动作在这些世界里没有可执行的前提。
- **改动范围与文档相符。** 共改了 14 个场景定义，其余不变，与文档一致。

## 验证

- 审查员三轮都运行了 typecheck 和受影响的单文件测试，全部通过：doctor-handoff、doctor-repair、doctor-scenarios、base-apply-scenarios、daily-evaluation、cross-skill-scenarios、eval-batch、evaluation、eval-comparability、eval-redact、docs-consistency 等。另外运行了 privacy 和 tracker，都通过。
- 完整离线入口以本 PR 的 CI 为准。
- 场景定义和评分器都变了：三类批次在下一个候选上全部重跑。真模型表现未验证。
