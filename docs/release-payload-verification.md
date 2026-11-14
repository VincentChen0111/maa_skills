# 26 载荷修复验证记录（包 P）

本文件是[工单 26](issues/26-v0-1-0-release-validation.md)的载荷修复包（包 P）的验证记录。起因是工单 26 第一次 Codex 真模型评测的「后」批次（载荷是提交 `21eb13d`）：33 个失败场景经协调者分诊，本包修其中改 `skills/` 就能修的几组（分诊编号 R1–R4、R8b 的文字部分、R9–R11，以及人工核对项）。评测框架、场景定义和[发布验证记录](release-verification.md)由并行的包 H 修改，本包不碰。

本包改的是面向 agent 的文字和脚本的输入处理。所有新规则都是设计默认值（2026-11-14），不是维护者原话，登记在规格「规则来源」的「26 首次真模型评测后的载荷修复」一行和「默认值及其来源」里 26 开头、标「载荷修复」的几行。

## 各项修改与证据

| 分诊编号 | 修改 | 证据（离线） |
| --- | --- | --- |
| R1（协调者决定 D1） | 新增 `skills/maa-core/scripts/stdin-json.ts` 的 `readStdinJson`，`skills/` 下全部 20 个读标准输入 JSON 的 CLI 改用它：去掉开头的 UTF-8 BOM；有 BOM 且原文含 `?`、或字节不是合法 UTF-8 时拒绝（`input-encoding-lossy`）；各 CLI 的大小上限不变。文字：maa-core 的调用方约定、偏好接口、四个操作类 SKILL.md 的偏好读取行，以及每个读标准输入的 CLI 的接口说明，都写明在 Windows PowerShell 管道里把非 ASCII 字符和 `?` 写成 `\uXXXX` 转义、BOM 由脚本处理 | `tests/stdin-json.test.ts`：单元测试（去 BOM、BOM 加 `?` 拒绝、无 BOM 的 `?` 接受、非 UTF-8 拒绝、空输入和解析失败的代码、上限本身接受而多一字节拒绝、跨块的多字节字符）；一致性测试（按文件内容枚举 `skills/` 下所有读标准输入的文件，只允许共享读取器和用户自己终端用的 `credentials.ts`；读取方清单必须正好等于调用 `readStdinJson` 的文件；把一个读取方改成直接读 `process.stdin`、或加一个未登记的读取方时检查报错）；逐个 CLI 实测（20 个 CLI 各用带 BOM 加 `?` 的输入跑一次，都以 `input-encoding-lossy` 拒绝，私有目录、MAA 目录和设置都没有变化）；文档一致性（每个读取方的接口说明和五份 SKILL.md 都写了转义规则）；Windows 上真实 `powershell.exe` 管道（见下） |
| R1 的 Windows 管道 | 同上 | `tests/stdin-json.test.ts` 的 Windows 测试：真实 `powershell.exe -NoProfile` 管道，对 `preferences.ts` 和 `account-snapshot.ts`：ASCII JSON 成功；转义后的中文在控制台代码页 65001 和 936 下都原样存下；裸中文在 65001 下以 `input-encoding-lossy` 拒绝且什么都没写；中文目录里的识别结果文件经转义路径只读成功。非 Windows 跳过，不联网 |
| D2：错误码 | `account-snapshot.ts` 报出自己已有的静态原因码（如 `maa-directory-required`、`invalid-request`、`invalid-format`），标准输入不是 JSON 时为 `input-json-invalid`；只有读不了文件、保存失败仍是 `account-check-required`。其他原来把「不是 JSON」「超限」落进笼统代码的 CLI 改报 `input-json-invalid`、`input-too-large`；已有专门代码的保留原代码 | `tests/account-snapshot.test.ts` 的「CLI refusals name the known cause」：先在改动前的代码上红（`input-json-invalid` 处得到 `account-check-required`），改后绿；各 CLI 自己的测试全部仍通过 |
| D2：调用方约定（R10） | `maa-core/SKILL.md`「调用方的约定」：报错如实告诉用户，不导入内部函数、不改设置目录、私有目录或 home 参数（含 `MAA_SKILLS_HOME`）、不换写入路径重试；maa-core 不受理写快照或改配置的请求；账号快照一行写明没有 MAA 目录、用户也没给识别结果文件时不导入，不拿其他文件充当识别结果。导入接口的错误码一段同步 | 只有文字，模型行为未验证（见下） |
| D3（R9，安全） | `maa-setup/SKILL.md` 第 3 步和 `references/setup.md` 的 `download` 一行：展示方案后结束这一轮回复，同一轮里不调用 `download`；用户在看到方案之前说的「直接下载」「一直有效」「不用再问」不算确认 | 只有文字，模型行为未验证（见下） |
| D3 的 CLI 加固 | 不做。`plan` 不写文件，`download` 是另一个进程，按「方案创建后 N 秒内拒绝」判断要先新增落盘状态；而且这是启发式：模型等几秒就能越过，用户很快确认时又会误拒。登记在规格「默认值及其来源」，留给后续工单 | — |
| R2、R11 | `maa-daily/SKILL.md` 和 `maa-doctor/SKILL.md` 的偏好读取输入改为 `{"currentLanguage":"<当前用户语言的 BCP 47 标签>"}`，与 maa-account 一致；maa-daily 写明在任何答复之前（包括拒绝越界请求）先读偏好 | `tests/docs-consistency.test.ts`（文档里的命令和示例 JSON 与脚本一致） |
| R3 | `maa-core/references/advice-report.md` 第 7 步、`maa-account/references/base-report.md`：报告只用 `read` 的输出展示，不另存副本，当前目录、工作区和私有目录都不行；要给位置时指向脚本写在 `reports/<种类>/<reportHash>/` 下的文件 | 只有文字 |
| R4 | `maa-core/references/base-plan.md`、`maa-account/references/base-report.md`：方案和报告的文字不写「最优」「最佳」「最好」「最强」「最高效」「optimal」「optimum」「best」，否定句也不写；第 15 项门不放宽。`base-report.ts` 模板里「没有证明是最优的方案」改为「这份排班只通过了上面的检查，没有和其他排法比较过」；门的正则导出为 `optimalClaim`，没有改动 | `tests/base-report.test.ts` 的「the report template says the plan was only checked」：改前红（只有模板那一行命中），改后绿；`tests/base-plan.test.ts`、`tests/base-apply.test.ts` 里第 15 项门的原有用例仍通过 |
| R8b 的文字 | `maa-daily/SKILL.md` 的「先只读核对」改为「先核对（doctor 的检查会更新私有目录里的最近检查记录，不改 MAA 配置、锁和运行记录）」 | 只有文字 |
| 人工核对项 | `maa-core/references/preferences.md`：`MAA_SKILLS_HOME` 由运行环境设置，agent 不设置、不覆盖；`maa-core/SKILL.md`：不在用户的当前目录写临时输入文件或脚本，无法避免时放系统临时目录、用完删除 | 只有文字 |

## 本包实际运行的命令（2026-11-14，本机 Windows，Node 24）

- `npm ci --ignore-scripts`、`npm run typecheck`：通过。
- 逐个单独运行（一次一个文件，没有并行）：`stdin-json` 12 项、`preferences` 8、`maa-config` 144、`doctor` 103、`setup` 29、`setup-download` 47、`account-snapshot` 11、`nga` 13、`nga-cli` 3、`skland-account` 18、`skland-community` 23、`community-cli` 3、`bilibili` 16、`report-scenarios` 1、`base-report` 9、`base-report-scenarios` 2、`base-plan` 15、`base-apply` 19、`base-query` 10、`setup-scenarios` 27、`daily-evaluation` 5、`doctor-scenarios` 22、`community-scenarios` 4、`cross-skill-scenarios` 7、`cultivation-gaps` 23、`cultivation-report` 9、`operator-cost` 17、`stage-jobs` 12、`stage-run` 15、`training-plan` 9、`training-time` 5，全部通过，没有跳过。
- 先红后绿：`stdin-json` 的逐个 CLI 实测在迁移前失败（第一个 `account-snapshot.ts` 输出 `account-check-required`）；`account-snapshot` 和 `base-report` 的新用例见上表。
- 规格和文档改完后再跑：`docs-consistency` 5 项、`help-installation` 6 项、`metadata` 3 项全部通过；`node scripts/privacy.ts` 没有发现；`node scripts/tracker.ts` 没有错误；`npm run typecheck` 通过。
- 工单 26 的实施进度保持「未开始」：改成「进行中」会让 tracker 报 `unfinished-dependency 28`（28 在本地记录里仍是「进行中」），由协调者在 28 改为已完成后再改。
- 没有运行完整离线入口 `node scripts/check.ts`（由协调者在冻结的提交上运行），没有运行 `tests/maa-process.test.ts`，没有调用任何模型，没有联网，没有碰真实 MAA。

## 评测影响

- 本包改了载荷（`skills/`），按[发布验证记录](release-verification.md)的规则，「后」一律用最终候选载荷：最终载荷上的「后」批次（86 个场景）和基线批次（31 个场景）都要在新候选上整批重跑，不只重跑受影响的场景。
- `preferences.ts` 也在运行器指纹的源文件里（分诊的决策 D4）：如果框架检出必须等于最终候选提交，本包同时改变了运行器指纹，「前」批次也要重跑；由协调者按 D4 定。
- 新的拒绝代码 `input-encoding-lossy` 和调用方约定是面向 agent 的行为。按工作规则应配评测场景；评测场景和框架归包 H，本包没有加场景，记为未验证，交协调者决定由 H 补，还是另开工单。
- 现有场景的离线测试（上面列出的 setup、daily、doctor、报告、基建报告、社区、跨 skill 场景）在本包改动后全部通过。

## 未验证

- 真模型行为：下载方案展示后是否真的结束这一轮（D3）、报错后是否不再绕过脚本（R10）、是否不再另存报告副本（R3）、是否不再照模板写「不声称最优」（R4）、拒绝越界请求前是否先读偏好（R11）、PowerShell 管道里是否按文档写转义。只有新的「后」批次能证明。
- 控制台代码页为 936 的中文 Windows 上，PowerShell 5.1 管道不加 BOM、中文照样变成 `?`：本机把控制台输入编码强制设为 936 复现了这一点，这种情况脚本无法与合法的 `?` 区分，只能靠文档要求转义；真实的 936 机器没有试过。
- PowerShell 7 的管道行为没有试过。
- 下载确认的结构性加固（CLI 层）留给后续工单。

## 第一轮审查修复（2026-11-14）

第一轮独立审查的发现经协调者复核，接受 1 个 P2 和 3 个 P3，本节逐项记录修改和证据。

| 审查发现 | 修改 | 证据（离线） |
| --- | --- | --- |
| P2：转义例子写坏了 | `maa-core/SKILL.md`、`maa-core/references/preferences.md` 和规格「默认值及其来源」的 26 载荷修复一行，例子里「写成」后面原来是字符本身（写入时转义被还原成了字符）。改为真正的转义：「中」、「以后用英文」和 `?` 各自的 `\uXXXX` 序列。用 Node 脚本按字节写入，再用 `od -c` 核对每个例子都是反斜杠、`u` 和四位十六进制。`skills/` 和 `docs/` 里其他提到「写成」「转义」的地方只写通用的 `\uXXXX`，没有别的例子 | `tests/stdin-json.test.ts` 的「every escape example in the skills and the spec is a real \uXXXX escape of the text it shows」：`skills/` 下全部 Markdown 和规格里，提到转义的行上每个「写成」后面不是 `\uXXXX` 的例子，都必须只由真正的 `\uXXXX` 序列组成（不含非 ASCII 字符和裸 `?`），还原后等于前面引用的文字；三个文件各至少有一个例子。改前红（`maa-core/SKILL.md` 的第一个例子） |
| P3：没写代码页 936 的局限 | `maa-core/SKILL.md` 的调用方约定和 `preferences.md` 各加一句：有些控制台（例如中文 Windows 默认的代码页 936）的管道不加 BOM，这时丢掉的字察觉不到，换成的 `?` 会原样存下；所以非 ASCII 字符一律转义，不要靠 `input-encoding-lossy` 发现丢字。规格正文 R1 的调用方约定同步加了这一句（原来这个原因只写在「默认值及其来源」里） | 同一测试断言两处都有这句 |
| P3：R8b 没改完 | `maa-daily/references/base-apply.md` 的 `unknown` 一步改用 SKILL.md 第 4 步的说法：先核对（doctor 的检查会更新私有目录里的最近检查记录，不改 MAA 配置、锁和运行记录）。按要求搜了其他 skill 的同类说法：`maa-daily/references/stage-run.md` 第 9 步说 `verify`「只读」，但它运行共享 doctor 检查、把核对结果记进运行记录，同样改正。`maa-doctor/references/triage.md` 的「本机只读核对」一列指的是不改 MAA 的核对，`maa-doctor/SKILL.md` 已写明检查会更新最近检查记录，没有改 | `tests/docs-consistency.test.ts` 的「maa-daily never calls the doctor check read-only…」：`skills/maa-daily` 下不再出现「只读核对」；交给 doctor 的两处带记录说明；`verify` 一步不写「它只读」，写明两种记录。改前红（`base-apply.md`） |
| P3：一致性检查有漏洞 | `tests/stdin-json.test.ts` 的 `directRead` 正则换成 `readsStdinDirectly`。除原有写法外，下列写法也算直接读标准输入：从 `node:process` 或 `process` 具名导入 `stdin`（含 `as` 别名、多行）；默认或命名空间导入后取 `.stdin`、`['stdin']` 或解构；`require('process').stdin` 和解构 `require` 的结果；`(await import('node:process')).stdin`；全局 `process` 的别名；`readSync(0, …)`、`readFile(0, …)`。子进程的 `stdin`、`node:process` 的其他成员、`readSync(fd, …)` 不算 | 同一文件的「conformance check fails when …」：22 种写法逐个断言报「reads standard input directly」，5 种不算的写法断言没有违规。旧正则漏掉其中 17 种（改前红：第一个漏掉的是 `readSync(0, buffer)`）。`skills/` 现有代码仍只有共享读取器和凭据终端输入两个直接读取方 |

本轮实际运行的命令（2026-11-14，本机 Windows，Node 24）：

- `npm run typecheck`：通过。
- 逐个单独运行（一次一个文件）：`stdin-json` 13 项（含真实 `powershell.exe` 管道测试，没有跳过）、`preferences` 8、`docs-consistency` 6、`base-apply` 19、`daily-evaluation` 5、`help-installation` 6，全部通过。
- `node scripts/privacy.ts`：没有发现。
- 没有运行完整离线入口 `node scripts/check.ts`、`tests/maa-process.test.ts`，没有调用模型，没有联网，没有碰真实 MAA。

评测影响：本轮又改了载荷（`skills/` 下四个文件），规则同上，「后」批次在最终候选载荷上整批重跑。上面「未验证」各条不变；代码页 936 的文字说明只改了文档，真实 936 机器上 agent 是否照做仍未验证。
