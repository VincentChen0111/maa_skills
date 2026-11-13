# 03 验证记录

日期：2026-11-10。验证使用真实临时 home、合成账号、样例配置及独立 CLI 进程；没有复制安装目录、真实凭据或私有项目实现。

## 离线结果

公开导出函数/CLI 测试先红后绿，复审修复后完整离线入口 18/18 通过，七项评分规则 14 份正反记录全部符合预期，类型检查和公开内容隐私检查通过。覆盖宿主归一化、异常结束、精确授权、同进程持锁、锁作用范围、配置快照、二进制附件、独立临时安装、结构化工具参数泄漏、模型/场景/版本固定、三次重跑及未验证状态。没有把宿主替身的输出当作真实模型输出。

## 本机宿主尝试

| 宿主 | 固定模型参数 | 场景 | 结果 | 证据摘要 |
| --- | --- | --- | --- | --- |
| Codex CLI 0.167.0-alpha.3.2 | `gpt-6` | approved-write | 未验证：新进程已启动，隔离环境没有认证，返回 401 | `65a3716ceb4d5313b45614c64692b3d2eaa873947d337302bf088ddad0afa0cc` |
| Codex CLI 0.167.0-alpha.3.2 | `gpt-6` | independent-review-smoke | 未验证：新进程与自包含合成 brief 已提交，认证失败，未取得模型审查 | `4723f8eed94f406dd007d08a72170f888e0f906a4aed5cf835324a4df4289531` |
| Claude CLI 不可用 | `claude-sonnet-4-6`（请求参数，未验证可用性） | approved-write / independent-review-smoke | 未验证：找不到可执行文件；没有安装或更改用户环境 | `5249a93f8247adbbd7dcce281389e75b368b1c0f5ede1429d113ac07be8fddd9`（空运行证据） |

第一次 Codex 尝试在外层沙箱超时；之后本机重试明确得到认证失败。原始 JSONL、stderr、调用参数和记录仅保留在被忽略的本机评测目录，不发布原始路径、服务端连接细节或账号标识。

其他演示场景未调用真模型，因为相同认证和宿主条件未解决；明确记为未运行。没有建立演示 skill 或产品 skill 的真模型基线，也没有宣称分数不下降。基线应在宿主可用后，使用同一版本一次跑齐至少三个场景，再比较修改前后。

真实 MAA、设备、原安装流程、真实报告/下载边界集成不在本次离线演示中验证；分别由后续产品工单验收。当前可验证的是评测框架和评分规则，不是产品 skill 已通过双宿主验收。

# 28 验证记录：可运行入口、两道预检与套餐登录

日期：2026-11-13。实现与离线验证都用真实临时目录、合成账号与宿主替身；没有登录任何宿主，没有调用任何模型，没有建立模型基线。上表 2026-11-10 记录里 Codex 的 `gpt-6` 不在 2026-11-13 的官方名单里，那两条旧记录原样保留；之后的默认模型 id 见[行为评测](evaluation.md)。

## 离线结果

见本节末尾「本次运行的命令」。离线覆盖：批量入口与场景注册表（全部 `eval/` 场景可按名字和组运行）、同一宿主串行、批次清单、用量上限等宿主级失败中止整批与按指纹续跑、`compare` 的逐场景结论和重跑清单且不改写记录、失败类别分开记录、Claude 隔离开关与 `system/init` 核对、套餐登录时子进程环境里没有任何 API key、专用登录目录的拒绝规则（私有目录由临时 `MAA_SKILLS_HOME` 下的合成设置文件指定）、日常宿主目录不被当作配置目录也不被复制、认证预检各类别且状态输出不落盘、读保护检查的通过与各种不通过（两宿主）且哨兵总被删除、记录和清单里没有登录目录路径、宿主替身记录不进比较、环境预检、文档一致性测试，以及新场景用真实 CLI 驱动后按评分策略通过。宿主替身只替代模型调用；脚本调用、锁和文件差异都是真实的。

## 未登录探测

在空的临时配置目录、临时 home、只含允许列表变量的环境里运行固定版本 Claude Code 2.1.321 与 Codex CLI 0.167.0-alpha.3.2 的 `--version`、`--help`、子命令帮助、`auth status`／`login status`，以及一次 `-p`／`exec` 以观察没有登录时的失败形状。结果写在[行为评测](evaluation.md)：开关都存在且组合可解析；未登录的 `system/init` 显示工具、MCP、命令、skill、插件与清单一致；状态命令的未登录输出；Codex 带拒绝读取的权限配置时，默认的非提权 Windows 沙箱拒绝运行，选择 MXC 沙箱后会话建立并走到 401。没有任何一步能到达已登录状态。

## 未验证项与维护者的顺序

以下都需要维护者的套餐登录，记为未验证，不写成通过：

1. 维护者在两个专用登录目录各登录一次（命令见[套餐登录](evaluation.md)）。这是唯一需要维护者本人做的一步。
2. 认证预检的真实探测：`node scripts/eval-batch.ts run <host> <模型 id> <组> --executable <CLI 可执行文件>` 会依次做认证预检、读保护检查，再跑场景；任何一道不通过就停下，清单里写明类别。
3. 两个宿主各自的读保护检查。首次结果记在下表。预计 Claude 在原生 Windows 上不通过（命令沙箱不支持原生 Windows，`node *` 的命令读得了任意文件）；不通过时 Claude 一侧不用套餐登录运行，交回维护者决定。Codex 依赖本机的 MXC 沙箱；不可用时同样交回维护者。
4. 首批试运行：读保护检查通过的宿主，各跑一个 skill 的场景一次（建议 `maa-core` 组，三个场景）。把每次运行的 token 用量和耗时记在下表，据此估出完整批次的用量。
5. 完整批次（`all`），之后才由 26 建立基线。
6. 第一次真实完成的运行之后：按它的耗时确定默认超时，写进[失败类别与超时](evaluation.md)并登记到规格两张来源表；按名字核对宿主写进登录目录的条目；核对 Claude 实际加载项和工具、`-p` 读取登录、`--restricted` 对登录的影响、状态命令的登录后输出、用量上限的报告方式、模型与用量字段，以及 skill 规定的「标准输入传 JSON」写法在真实 CLI 允许列表下是否放行、在 Codex 沙箱里能否执行。Codex 的读保护检查记录里，看有没有命令执行、模型文字、推理以外的条目碰到哨兵（有就检查不通过，类别 `other-tool-touched-sentinel`），结果写进下表的类别栏。每次升级宿主 CLI 后重做这些核对，包括重新查 `codex features list` 里默认打开、可能读文件的功能。

| 宿主 | 读保护检查首次结果 | 日期 | 类别 |
| --- | --- | --- | --- |
| Claude Code 2.1.321 | 未运行（尚未登录） | — | — |
| Codex CLI 0.167.0-alpha.3.2 | 未运行（尚未登录） | — | — |

| 宿主 | 试运行场景 | token 用量 | 耗时 |
| --- | --- | --- | --- |
| Claude Code | 未运行 | — | — |
| Codex CLI | 未运行 | — | — |

## 设计默认值

工单 28 实现时定的设计默认值登记在规格「默认值及其来源」：批内认证失败与网络不通同样中止整批、默认登录目录位置与拒绝规则、读保护检查的命令模式 `node *`、替身记录不进比较、默认模型 id、单配置事务与生成文件的评分约定；第一轮审查后另登记登录目录路径的字符限制、设置文件读不了时拒绝、同一登录目录同时只跑一批与 Ctrl+C 停批、比较只取计入完成的记录，并在读保护那一行补上尝试的形式和 Codex 关掉看图工具。另有两条只影响评测运行器、不改变产品限制的实现选择：读保护检查和每次续跑都重新做认证预检；Codex 每次调用都显式选 `cli_auth_credentials_store="file"` 与 MXC 沙箱，让登录留在专用目录、拒绝读取的配置能被沙箱执行。

## 第一轮审查修复

审查的九项（P1 一项、P2 两项、P3 六项）协调者全部接受，逐项先写会失败的测试再修。审查员的离线复现脚本在修复后重跑，结果写在每项末尾。

| 项 | 修法 | 证据 |
| --- | --- | --- |
| P1 别的命令被拒也算命令尝试 | 只算提示词要求的形式：Claude 一侧整条命令匹配允许模式、不带复合或重定向符号的那条 node 读取；Codex 一侧命令里含那段 node 读取脚本。其他工具碰到哨兵直接不通过 | `tests/eval-auth.test.ts` 新增用例：两个宿主改用不在允许列表里的命令读哨兵、或用其他工具碰哨兵时，检查都不通过；复现脚本结果从通过变为 `status fail`、`grantsToolRuns false`，登录目录检查后为空 |
| P2 登录目录路径落进 `scenario.json` | `scenario.json` 只写 `<login-dir>` 占位；路径占位按路径片段匹配，片段之间可以是任意多个斜杠或反斜杠（多层 JSON 转义）、盘符也认 `/c/…` 形式和百分号编码，名字更长的同级目录不动 | `tests/eval-batch.test.ts` 用带唯一标记的登录目录，搜索批次写出的每个文件；`tests/eval-host-double.test.ts` 覆盖单层到三层 JSON、MSYS、权限规则、`file:` URL 等写法。复现脚本：没有任何文件含标记；六种写法都已替换 |
| P2 续跑过的批次无法比较 | `batchRecords` 只取计入完成的记录：中止原因和 `interrupted` 不算；普通批次每个场景取最后一条，重跑批次取全部 | `tests/eval-batch.test.ts` 用含 `quota-exhausted`、`auth-failed` 记录的续跑批次比较为 `pass`，含 `network-unavailable` 的重跑批次仍按三次重跑判为 `unstable`。复现脚本不再是 `incomparable`：两个场景是 `regression`、一个 `pass`，与替身在前后两批都只完成了 `core-boundary` 一致（按 `compareRuns` 的规则，之后一批里的 `fail` 记为回归） |
| P3 指纹漏了 `eval-transaction.ts` | 场景哈希和运行器指纹各从一份导出清单读源码，补上 `scripts/eval-transaction.ts` 和 `eval-auth.ts` 引用的产品设置读取脚本 | 新测试沿 `evaluation.ts`、`eval-run.ts` 的静态导入遍历，要求每个本地模块都在两份清单里 |
| P3 两个进程可同时用一个登录目录 | 登录目录旁边的独占锁文件；占用时 `login-directory-busy`，不删别人的锁。Ctrl+C 在当前宿主运行返回后停批、删锁，被打断的运行在清单里标 `interrupted`，续跑重跑；第二次 Ctrl+C 立即删锁退出 | 新测试：已有锁时不做预检就停下且锁原样保留；同时启动两批，一批完成、一批 `login-directory-busy`；结束后锁不在，登录目录里没有多余文件。打断测试：开始前就打断、或第一个场景的宿主运行之后打断，都停批删锁、不留信号监听，续跑重跑被打断的场景。打断用例单独连跑五次都通过 |
| P3 多候选场景替用户选了也能通过 | 策略新增 `forbiddenInvocations`，观察到一次就不通过预期动作检查；该场景禁止 `setup.ts test` 和 `apply` | `tests/setup-scenarios.test.ts` 反例（选第一个候选并测试）在两种目录布局下都评为 `fail`；复现脚本评为 `fail`（`expected-behavior`） |
| P3 Codex「没有独立读文件工具」没有依据 | 查固定版本 0.167.0-alpha.3.2：`exec --help` 没有工具开关；程序文本里 `exec --json` 的条目类型没有读文件条目，但有内置看图工具 `view_image`（读取磁盘上的图片）。每次 Codex 运行加 `-c features.view_image=false`。其余记为未验证，由「命令以外的条目碰到哨兵就不通过」在第一次真实运行时把关 | 空的临时 `CODEX_HOME`、临时 home、允许列表环境下：`codex features list` 显示 `view_image` 生效为 `true`，加覆盖后为 `false`；没有登录，没有模型请求。参数测试固定这一项 |
| P3 Ctrl+C 留下哨兵 | 写新哨兵之前按文件名删掉旧的 `maa-eval-sentinel-*.txt`（不读内容）并确认不剩；检查中 Ctrl+C 记为 `interrupted`、删掉哨兵再停；第一个场景前批次再确认登录目录里没有哨兵 | `tests/eval-auth.test.ts` 的遗留哨兵用例 |
| P3 两条拒绝规则没有登记 | 规格两张表登记 `unsupported-character`（TOML 字面字符串装不下单引号，换行和 NUL 改变配置）与 `settings-unreadable`（找不到私有目录就无法确认不重叠）；[行为评测](evaluation.md)写明怎样换位置 | 文档一致性测试通过 |

本轮工单正文（`docs/issues/`）没有改动。上表 P2 登录目录一项和 P3 指纹一项的做法在第二轮被替换，见下节。

## 第二轮审查修复

协调者重新评估后接受两项（P2 一项、P3 一项），驳回一项（第二次 Ctrl+C 留下哨兵：只在 macOS/Linux 上出现，真模型只在维护者的 Windows 机器上运行，按协调者的决定不改）。两项都先写会失败的测试。按维护者 2026-11-13 的负载规则，本轮只跑类型检查和改到的单个测试文件，一次一个；完整离线入口由协调者每个包跑一次。

| 项 | 修法 | 先红后绿的证据 |
| --- | --- | --- |
| P2 场景摘要含产品脚本，只改产品的发布永远无法比较 | `scenarioHashSources` 去掉 `skills/maa-core/scripts/preferences.ts`；运行器指纹仍列出它。导入闭包测试改为：运行器模块必须在场景摘要里，`skills/` 下的模块必须不在，并且装入 skill 后出现在计入 skill 版本的文件里 | 新测试把 `scripts`、`eval`、`skills`、`tests/fixtures` 复制到临时目录，只给副本的 `preferences.ts` 加一行注释，两边各跑同一场景。修复前：场景摘要不同（测试报 `a product script is not part of the scenario`），闭包测试报 `preferences.ts stays out of the scenario hash`；修复后：摘要相同、skill 版本不同、`compareRuns` 为 `pass` |
| P3 路径后紧跟中文、句号等字符时整个路径落盘（与第一轮 P2 同类，按复发规则处理） | 新模块 `scripts/eval-redact.ts` 是唯一的所有者：私有路径的清单和匹配规则都在这里，每份产物都经 `artifactWriter` 写出（`runScenario` 六个文件、读保护检查两个文件、批次清单；续跑按脱敏后的指纹比较）。去掉末尾边界；分隔符串改成按首字符唯一切分的记号，保证匹配是线性的；另认 JSON `\u` 转义、百分号编码、`\\?\` 前缀、大小写混合、realpath，以及任何评测临时目录的生成名（版本探测和读保护检查的临时目录也不会落盘）。原来 `eval-host.ts` 里的 `pathRedactor` 删掉 | `tests/eval-redact.test.ts` 三项：各种写法和相邻字符的单元用例；一致性用例让替身在版本、回复和标准错误里说出登录目录、home、仓库、自己的工作区和临时目录、哨兵，两个宿主各跑一批，逐一列出全部九份产物，每份都不得含唯一标记、并且都含 `<login-dir>`（证明路径确实到了这份产物、又被替换掉）；源码检查三个产出模块只经 `artifactWriter` 写产物（除哨兵和锁）。修复前（把新测试和新替身放进上一提交的导出副本里跑）：三项都失败，一致性用例报 `claude manifest.json names loginmarker…`；修复后三项通过，耗时约 1.3 秒 |

## 第三轮审查后修复（未经审查）

第三轮是最后一轮审查。协调者接受了两项 P2，本节的修复没有经过审查，除非维护者批准第四轮。两项属于同一类问题（一次正当的前后比较被判为 `incomparable`，必经的评测门永远过不去）；加上第二轮那一项，这是第三次出现，所以按复发规则处理：可比性只设一个所有者（`scripts/evaluation.ts`），再加一个一致性测试，列出所有产出方和使用方。

| 项 | 修法 | 先红后绿的证据 |
| --- | --- | --- |
| P2-1 只挪动产品固定的数据提交，6 个成本和缺口场景的场景摘要就变了 | `scenarioIdentity` 统一计算场景摘要：网络夹具地址去掉固定提交并按来源排序，产品文件和产品派生的值不进。另修一处同类问题：原来摘要里用的是渲染后的策略，带着本次工作区的随机路径，`setup-connection-write` 每次运行都成了新场景；现在改用未渲染的场景定义 | `tests/eval-comparability.test.ts` 的第一项：遍历全部场景定义，在只挪动了两个固定提交、又改了一个产品脚本的副本里，每个场景的身份都不变；`eval/` 引用的产品模块逐一列出，新增引用会让测试失败；分别改一个场景的提示词、评分策略、网络夹具内容、评测夹具内容，只有这一个场景的身份变化。第二项：经 `runScenario` 实际运行 `core-language`、`account-cost-raw`、`setup-connection-write`，重复运行和在产品副本里运行都得到相同的场景摘要，skill 版本则不同。修复前（`.tmp/logs/r3-red.log`）：第一项因没有 `scenarioIdentity` 而失败；第二项报 `account-cost-raw: a product-only release is another scenario`、`setup-connection-write: a repeated run is another scenario`、`setup-connection-write: a product-only release is another scenario` |
| P2-2 多组批次每边有多个 skill 版本，总被判为 `incomparable`，首次基线也一样 | `compareRuns` 改为逐场景判定再汇总（无法比较 > 未验证 > 需要重跑 > 回归 > 不稳定 > 通过）；skill 版本只要求同一场景的之后那次运行和它的重跑一致；基线分支不再受多版本影响。「一批是同一个候选」由续跑拒绝不同载荷来保证 | 第三项用合成记录覆盖全部使用方：三个不同组的场景，相同的两批，`compareRuns` 为 `pass`，首次运行为 `baseline`，`compareBatches` 总体和逐场景都是 `pass`，`compare` 退出码为 0；只改产品时为 `pass`；只改一个场景时，只有这个场景是 `incomparable`，总体也是 `incomparable`，退出码为 1；重跑批次是 `unstable`，换了 skill 版本的重跑是 `incomparable`。第四项：载荷相同可以续跑，改了 skill 文件的续跑报 `fingerprint-mismatch`。修复前第三项报 `actual: 'incomparable', expected: 'pass'`。`tests/evaluation.test.ts` 里原来的「每边一个候选版本」断言改为新规则：多组的首次运行为 `baseline`，前后比较为 `pass`，重跑换了 skill 版本为 `incomparable`，一个场景变了则整体为 `incomparable` |

更正：每边一个 skill 版本的检查来自最初的评测框架（`ecc7325`），不是在本工单的 `d19e891` 里引入的；`d19e891` 加入了多组批次和整批比较，问题从那时起才会出现。

## 本次运行的命令

在提交 `9efdf75` 上（Windows，Node 24）：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `node scripts/check.ts`（完整离线入口） | 通过：422 个测试中 421 通过、0 失败、1 跳过（原有的非 Windows 专用用例）；评分规则自检 7 条规则 14 份记录通过；环境预检通过（替身记录，`double: true`、`baseline: false`）；tracker、隐私、元数据无错误 |
| `node --test tests/eval-host-double.test.ts tests/eval-auth.test.ts tests/eval-batch.test.ts tests/docs-consistency.test.ts tests/cross-skill-scenarios.test.ts tests/doctor-scenarios.test.ts tests/setup-scenarios.test.ts tests/stage-scenarios.test.ts` | 单独运行均通过 |
| 文档一致性测试的变异核对 | 临时把一处示例 JSON 的键、一处动作名和一处 `stages` 输入改错，测试按文件和行报出三处不一致；改回后通过 |

第一轮审查修复后，在提交 `b737bd4` 上（Windows，Node 24）：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `node scripts/check.ts`（完整离线入口，跑一次） | 测试阶段 426 个中 424 通过、1 失败、1 跳过。失败的是 `tests/maa-process.test.ts` 的「Windows launches and normally closes a temporary GUI…」（`maa-start-timeout`）；单独连跑三次都失败（一次 `maa-start-timeout`，两次 `maa-close-timeout`）。本轮没有改动 `maa-process` 的源码和测试，这是另行诊断中的已知 MAA 进程关闭用例，这里只记录，不算本轮通过 |
| `check.ts` 因测试阶段失败没有接着跑的几步，用同样的临时 home 环境单独运行 | tracker、隐私、元数据无错误；评分规则自检 7 条规则 14 份记录通过；环境预检通过（替身记录，`double: true`、`baseline: false`） |
| `node --test tests/eval-batch.test.ts tests/eval-host-double.test.ts tests/eval-auth.test.ts tests/eval-run.test.ts tests/eval-network.test.ts tests/setup-scenarios.test.ts tests/evaluation.test.ts tests/docs-consistency.test.ts tests/cross-skill-scenarios.test.ts` | 单独运行均通过 |
| 审查员的五个离线复现脚本 | 结果见上节各项 |

第二轮审查修复（提交 `4bee680`、`6a28b1e`，Windows，Node 24），按负载规则只跑这些，一次一个：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `node --test tests/eval-redact.test.ts` | 3 项通过 |
| `node --test tests/eval-batch.test.ts` | 10 项通过 |
| `node --test tests/eval-host-double.test.ts` | 7 项通过 |
| `node --test tests/eval-auth.test.ts` | 5 项通过 |
| `node --test tests/eval-run.test.ts` | 3 项通过 |
| 隐私、元数据检查（只调用检查函数） | 无错误 |
| 完整离线入口 | 本轮没有跑，由协调者跑 |

第三轮审查后修复（提交 `f3ba4ce`，Windows，Node 24；未经审查），按负载规则一次一个：

| 命令 | 结果 |
| --- | --- |
| `node --test tests/eval-comparability.test.ts`（修复前） | 4 项中 3 项失败，输出在 `.tmp/logs/r3-red.log` |
| `npm run typecheck` | 通过 |
| `node --test tests/eval-comparability.test.ts` | 4 项通过，约 3.3 秒 |
| `node --test tests/evaluation.test.ts` | 7 项通过 |
| `node --test tests/eval-batch.test.ts` | 10 项通过 |
| `node --test tests/eval-network.test.ts` | 3 项通过 |
| `node --test tests/eval-run.test.ts` | 3 项通过 |
| `node --test tests/eval-host-double.test.ts` | 7 项通过 |
| 完整离线入口 | 没有跑，由协调者跑 |

CI（Windows 与 Ubuntu）的运行由 PR 触发，本地没有运行；需要 Windows 的 setup 新场景测试在 Ubuntu 上跳过，与原有的 setup 连接写入测试一致。
