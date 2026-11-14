# doctor 配置与遗留锁验证

2026-11-11，06 从 05 squash 基点 `ddd0ca80a3367b589866efde73aa1c0205732c3a` 实施。实现验收已完成，固定产品 `67af7f8d12abe31fb8514103dfb1b9db24f98f8b` 的完整 R2 通过，Standards/Spec 均无真实错误。经 [PR #40](https://github.com/VincentChen0111/maa_skills/pull/40) squash 交付为 `788ac13febf35a54e556fa527943c01431b8e215`；模型及实机范围仍未验证。下方历史记录与最终验收分列。

共享入口 `skills/maa-core/scripts/doctor.ts` 提供只读检查及最近脱敏记录；恢复由 `maa-config.ts` 的原事务实现负责。诊断字段包含状态、原因、修法和执行者；CLI 提供人类可读与 JSON 输出及 0/1/2 退出码。

## 初始候选 c0b916 的作者验证

在已批准的工具 CLI/导出函数与 skill 外部行为接缝测试，使用真实临时目录、合成配置和真实的已退出子进程 PID，仅替代 MAA 进程观察/关停/重开。没有修改真实 MAA、已安装 skill 或私人账号目录。红绿记录保留在忽略目录 `.tmp/06-evidence/`。

- `tests/doctor.test.ts`：32 项，包括活跃/消失/无法辨认持有者、相同/不同/损坏配置、MAA 开/关、备份和待执行归属（含同时间无法判定最新）、未知扩展记录、无批准/范围外批准、证据漂移、并发恢复、定时窗口、非空闲、关闭确认、重开失败、脱敏记录与 CLI 三种退出码。
- `tests/doctor-scenarios.test.ts`：5 个场景通过实际临时安装 CLI、调用观察器与精确文件差异校验（含父测试共 6 项）。这是评测链路自检，不是模型完成任务。
- 原有 `tests/maa-config.test.ts` 回归保持通过；05 的备份、最小修改、禁止设置、药剂总量和定时保护仍在原写入器中执行。

最终作者 `node scripts/check.ts`：236 项中 234 通过、2 跳过、0 失败，tracker/元数据/隐私检查通过，评分规则 7 条、14 份样例通过。跳过项是文件系统不提供 Windows 短路径别名、非 Windows 进程不可用分支；不是 doctor 路径跳过。`npm run typecheck` 通过。

第一次完整运行因沙箱阻止 Windows 目录联接、假窗口编译和本地回环服务而失败；同一入口在获准的临时环境中重跑成功，保留两份记录，不将环境失败抹去。逐文件人工隐私检查覆盖新脚本、测试与合成数据、全部 skill/参考文件、公开状态文档及规格，未移植真实账号基线；自动隐私检查无发现。

## 核对范围

自动恢复仅针对 05 已知格式的单份 GUI 配置事务：最新备份必须属于遗留锁，最新且唯一的待执行记录必须匹配同一持有者。完整当前配置必须与备份或原请求预期配置一致，未知/额外变动保留。恢复只反向修改原事务记录的字段，仍受本次授权与原写入器约束，不整份覆盖备份。

已生效但 MAA 关闭不证明原操作重开完成，不能仅据配置一致清锁。用户可先处理 MAA，再重新检查；或点名批准恢复并确认未在操作，交原事务重新写入和读回。缺失/损坏证据、无法判断进程、未知药剂授权、未来作业/训练资产或附加 manifest 均不推测完成。恢复前把原始证据仅归档到私有目录，并发恢复使用独占的短期互斥；互斥遗留本身也不自动删除。

## 宿主、模型与审查

新增 `eval/maa-doctor/scenarios.ts` 固定五个场景：正常诊断、损坏配置、未知锁、点名但证据不足、笼统全部修复。固定策略要求真实 check 调用、精确最近记录和运行窗口内时间；未批准修改和泄漏仍评分失败。正向恢复另外由导出函数与固定原生安装 CLI smoke 验证，五个模型场景不宣称覆盖所有恢复语义。

修改前 skill 原字节已冻结在本机忽略目录 `.tmp/06-baseline/skills`，来源为上述基点。候选 doctor 为新 skill，Codex/Claude 各需至少三个成功场景建立基线；help 与 daily 用相同最终框架、固定场景、固定模型比较冻结前后载荷，pass→fail 按既定规则各重跑三次。

固定初始候选 `c0b916cf4a3b2d76c7b03c41322e8265df37d66b` 的实际外部结果：

- 双平台 CI 通过，运行编号 `42908473045`。
- 根任务在 `.tmp/native-check-zw49mf` 完成双宿主固定远程原生验收：32 条命令、Codex 23 个与 Claude 175 个仓库文件逐字节核对；655 个宿主生成依赖及 lock metadata 单独审计。实际安装 CLI 的具名恢复、第二备份、归档关联、脱敏结果和正常关闭通过。R1 独立核对了 198 个仓库文件及恢复结果，相关残留进程 0；其报告明确未重新核验 655 个包的 artifact 原始字节。stale lock 由已完成合成事务重建，不冒充真实 MAA 故障。
- `.tmp/06-model-evidence/frozen-models-F8SUs6` 的 62 条真实调用全部 unverified：31 次 Codex 为实际 401 缺认证，31 次 Claude 未登录；无 runner 失败、无成功完成事件。根任务核了每份 run、evidenceHash、grade 和执行窗口，`audit.json` 保留摘要；help 6 对、daily 14 对、core 6 对共 26 对模型/CLI/scenarioHash 一致，但比较仍全部 unverified，不证明分数不降。R1 原报告只读了当时尚在运行的批次元数据，不把根任务后续完整审计冒称 R1 已审。
- R1 完整独立审查为 FAIL，仅 1 项 P2：未完整验证事务 lock/change/authorization。原发现、独立检查与作者接受理由见 [06 审查记录](reviews/2026-11-11-06-doctor.md)。旧 CI/原生/模型事实不能当作修后新候选通过。

## R1 修复与有条件交付

接受 P2 后在同一公开接口补失败测试，再严格验证已知事务的 lock/pending/change/authorization 键、必要值、phase 和历史药剂数量。未知资源、缺失或非法授权同时禁用清锁与恢复，原锁与配置保持。MAA 配置本体的未知字段不参与此 schema 限制，两种合法修法均有保留原值的正向回归。红绿和新作者检查另存 `.tmp/06-r1-fix/`；旧证据保持原样。修后完整独立 R2、固定远程原生与受影响模型批次尚待根任务执行，工单继续进行中。

R1 修后作者结果：doctor、场景、05 writer 定向组合 139 项全部通过；完整 `node scripts/check.ts` 共 278 项，276 通过、2 跳过、0 失败（短路径别名不提供及非 Windows adapter 分支），tracker/privacy/metadata 和 7 规则/14 样例评分自检通过。`npm run typecheck` 通过。逐文件人工隐私复核本次配置脚本、测试、审查报告、06/26 工单、规格与验证记录，无真实账号数据或公开私有路径；自动隐私检查无发现。未改 skill 正文、场景或评分框架，修后原生/模型仍须按新 core 载荷核对，不能借用 c0b916 的成功结果。

2026-11-11 根代理依据维护者既有常规推进授权及继续按依赖实施要求，对 06 **单独**作出有条件交付决定，不从 05 自动继承，也不称维护者明确免测：R1 错误修复并完整独立复核、离线/类型、双平台 CI、固定远程双宿主原生恢复全部通过，且所有实际模型尝试如实留存后，可交付实现。仅认证不可用可延期；真正完成后的行为失败/回归不得改成 unverified 或自动延期。

doctor 真实基线与正向恢复语义，以及本次受影响 help/daily/core 的真实分数不降，保留为 [26 发布硬门禁](issues/26-v0-1-0-release-validation.md)。没有建立模型基线、人工语义核对或分数不降，不得声称这些项目通过；真实账号、MAA、模拟器和游戏仍未验证。

## 固定修复候选的最终验收

产品与原生安装固定源为 `67af7f8d12abe31fb8514103dfb1b9db24f98f8b`。完整 [R2](reviews/2026-11-11-06-doctor-r2.md) 实现审查通过；独立运行 `node scripts/check.ts` 为 278 项中 277 通过、1 非 Windows 分支跳过，类型检查及 14 组额外探针通过。作者 276/2 与独立 277/1 的差异是 Windows 短路径条件，本轮独立环境实际通过该项。原受限环境失败记录保留。该 SHA 的 [双平台 CI](https://github.com/VincentChen0111/maa_skills/actions/runs/42910595093) 通过。

新临时原生环境 `.tmp/native-check-VhCOen` 的 32 条命令完成，预期非零仅安装目标已存在与两个 stale-check；实际已安装 CLI 在两个宿主完成合成遗留诊断、具名恢复、第二份备份、归档关联、读回、锁释放及正常关闭。Codex 23 个、Claude 176 个仓库文件逐字节等于固定源，R2 独立核对全部 199 文件和恢复结果。655 个宿主生成依赖另列哈希与锁文件元数据；未宣称独立核验 registry 包字节。相关残留进程 0。

修后 `.tmp/06-r2-model-evidence/frozen-models-XfJS76` 新增 30 条实际调用，冻结框架仍为 c0b916、payload 为 67af7f8；15 次 Codex 401、15 次 Claude 未登录，无完成事件、无 runner 失败，全部 unverified。doctor 10 对、daily 14 对、core 6 对与已留存旧批次的模型/CLI/场景和框架指纹一致，比较仍 unverified；help 目录未变，沿用旧 c0b916 实际 6 对，不冒称修后重跑。两批共 92 份原始记录由 R2 独立重算 evidenceHash、normalizeHost、grade 与执行窗口，冻结文件与对应 Git 源核对。所有模型 fixture 已清理、相关 CLI 残留 0。

本票单独列明的实现交付条件已经满足；doctor 成功模型基线、正向恢复语义及受影响 help/daily/core 分数不降继续阻塞 26。真实 MAA/模拟器/游戏、真实账号和跨版本升级仍未验证。最终验收记录只改文档，不改固定产品/skill/评测框架；原生仓库全量文件字节结论仅针对实际安装的 67af7f8。

工单 10 的八组检查、运行日志分析与转介见 [doctor 完整检查与转介验证](doctor-checks-verification.md)。

## 27 碎石与临期药的恢复

2026-11-14，工单 27 的作者验证，未经独立审查。规则见 [daily 验证记录](daily-verification.md)「27 批准后的碎石与临期药」。

- 待执行记录的授权除 `source`、`reference`、`medicineCount` 外，接受 `stoneCount` 和 `expiringMedicine`，取值由同一个谓词严格校验；未知字段、超出 32 位范围或非整数的数量、天数不在 1–30、活动项不是布尔值、多出字段，以及来源是已批准报告却带消耗授权的记录，都让证据保持未知，两种修法都不可用。用例在 `tests/doctor.test.ts` 的「unknown or malformed transaction metadata never permits either recovery action」。
- `doctor.ts repair` 的输入字段白名单加入 `stoneCount`、`expiringMedicine`，其他键仍以 `request-invalid` 拒绝（同一文件的 CLI 用例）。
- 恢复只用修复请求自己带的授权：取值无效时在加互斥锁之前以谓词的原因码拒绝（`tests/consumption-grant.test.ts` 的 `doctor-recovery` 拒绝样例）。原事务授权不复用：作者初版的说法超出了当时的用例，那两项样例里中断事务的待执行记录没有带消耗授权，把原事务授权并进修复请求的变异（C9）没有被抓到。第一轮修复后（见下）有了直接用例。

真实 MAA 上的恢复和真模型的 doctor 场景未验证，留给工单 26。

### 第一轮修复（2026-11-14，未经独立审查）

- `tests/consumption-grant.test.ts` 的「doctor recovery never reuses the interrupted transaction grant when restoring would reopen stone or expiring medicine」：中断事务的待执行记录带 `stoneCount: 3`（把碎石从第一个任务移到第二个）或 `expiringMedicine`（3 天，同样移到第二个任务），恢复会把第一个任务的碎石或临期药重新打开。修复请求不带授权时分别以 `stone-grant-required`、`expiring-grant-required` 拒绝，配置字节、保留的锁字节和配置目录都不变；带当次授权时恢复完成，配置回到事务之前。
- 在 `git archive` 导出的临时副本里，把原事务授权并进修复请求（C9）后，这个测试失败（被抓到）；副本用后删除。变异表见 [daily 验证记录](daily-verification.md)「27 批准后的碎石与临期药」的「第一轮修复」。
- 随之而来的一点：恢复要把关着的临期药天数改回原值时，按「没有某类授权时只能写关闭值」的规则也要带临期药授权，天数等于改回的天数；同一次恢复若还要用别的天数重新打开另一个任务的临期药，一份授权满足不了两个天数，恢复被拒绝，交用户手动核对（失败方向是不写）。这一点只直接调用谓词核对过（两种天数都得到 `expiring-days-mismatch`），没有写成用例。第二轮修复改掉了这一点，见下。

### 第二轮修复（2026-11-14，未经独立审查）

第二轮独立审查指出（协调者接受，P3，第一轮修复带来的回退）：恢复撤销一次打开了某一类的中断事务时，这一类恢复后关着，但要改回的天数或剩余数量不是关闭值，第一轮的规则要求带这一类的授权，而且要等于事务之前的值。例如临期药原来关着、天数是 MAA 默认的 2，事务按批准的 3 天打开后中断：不带授权以 `expiring-grant-required` 拒绝，带 3 天以 `expiring-days-mismatch` 拒绝，只有用户从没批准过、代理也看不到的 2 天能过；碎石关着、留着数量 5 时同理。锁一直留着，挡住 daily 的写入。

修法：谓词新增消费方 `doctor-restore`，目标可以带 `restore`（中断事务备份里的同一任务）。只有 `restore-config` 把最新关联备份作为 `restoreTo` 交给写入器，写入器改用这个消费方核对改动的字段；这一类恢复后仍关着、每个改动值都等于备份里同一任务的值时，只要当次请求。恢复后重新打开这一类，仍要修复请求自己的当次授权，原事务授权照旧不复用。其他消费方的目标带 `restore` 时一律以 `consumption-grant-invalid` 拒绝，普通写入写同样的「旧值」拿不到这个放行。重放 doctor 自己的待执行记录（被中断的恢复）时，按记录里的值放行同一类改动：这些值是写入器从备份取的，重放只用来算预期配置，不写文件。

新增用例，都在 `tests/consumption-grant.test.ts`，恢复都走真实的 `executeRepairs`：

- 「doctor restore returns a class that stays closed to its pre-transaction values without a class grant; reopening still needs the current grant」，6 个子项。临期药（审查的 H1）、碎石（H2）和理智药三种，都是原来关着、带剩余值，事务打开后中断：不带授权的恢复完成，配置等于备份，锁已释放。一次恢复里第一个任务关回 2 天、第二个任务按自己的 5 天重新打开：不带授权和带 3 天都拒绝，带 5 天才完成，第一轮记录的那个两种天数冲突因此消失。另有两项是备份里这一类本来开着（临期药 2 天、碎石 5）：恢复会重新打开，不带授权和带原事务的值都拒绝，只有当次批准备份的值才完成。每次拒绝后，配置字节、锁字节和配置目录都不变。
- 「an interrupted restore that took a closed class back without a grant can itself be reconciled」：不带授权的 H1 恢复在重开 MAA 时失败，结果是 `unknown`，锁由 doctor 持有。持有者退出后，检查结果是 `applied`；MAA 就绪后可以清锁，配置保持恢复后的值。
- 「an ordinary write of the pre-transaction values gets no restore allowance」，2 个子项：普通写入不带授权，把临期药写回关着的 2 天，或把碎石写回关着的 5，仍以 `expiring-grant-required`、`stone-grant-required` 在访问进程之前拒绝。
- 「the restore allowance needs the doctor-restore consumer, values equal to the backup task and a class that ends closed」：直接调用谓词。改动值不等于备份值、备份任务不是 Fight 任务、恢复后这一类开着、来源不是当次请求，这四种都拒绝；其他七个消费方遇到带 `restore` 的目标也都拒绝。
- 一致性表登记了 `doctor-restore`。允许样例：关着的临期药恢复回 2 天，不带授权。拒绝样例：恢复会重新打开临期药时，不带授权被拒绝，带当次 2 天才能恢复。

审查者的探针 `probe5.ts`（H1、H2、H3）在修复后的工作区重跑：三项不带授权都是 `complete`，配置目录只剩 `gui.new.json`。变异表和测试数见 [daily 验证记录](daily-verification.md)「27 批准后的碎石与临期药」的「第二轮修复」。

未验证：doctor 的 skill 正文（`SKILL.md` 第 4 步和 `references/checks.md` 的恢复说明）改了，真模型的 doctor 行为评测没有运行，评测前后对比留给工单 26；真实 MAA 上的恢复同上。
