# 凭据验证记录

2026-11-13，工单 [09](issues/09-manual-credentials.md) 从 `origin/main` `4a1fd26` 在分支 `claude/09-manual-credentials` 实施。实施进度：进行中，等待独立审查，尚未合并。

## 交付内容

- `skills/maa-core/scripts/credentials.ts`：用户在自己终端运行的输入流程（`input nga|skland|bilibili`）、只读共享检查（`check` 与导出的 `inspectCredentials`）、读取器取值（`readCredential`）与记下实际读取结果（`recordCredentialOutcome`）。
- `skills/maa-core/scripts/credential-protection.ts`：Windows 当前用户加密边界（DPAPI）。
- `setup.ts check` 和 `doctor.ts check` 末尾附带同一组凭据检查；`doctor.ts repair` 对凭据修法返回 `user-manual-repair`。
- 文档：[凭据接口](../skills/maa-core/references/credentials.md)、[用户手册](credentials.md)（含森空岛粘贴前的知情说明）；maa-setup、maa-doctor、maa-core、maa-help 的 SKILL 与参考文件；规格「私有目录与设置文件」「检查与修法」「资料来源」「安全边界」和两张来源表；术语表「凭据」。
- 评测场景：`eval/maa-setup/scenarios.ts` 新增 `setup-credential-entry`、`setup-credential-pasted`；`eval/maa-doctor/scenarios.ts` 新增 `doctor-credential-expired`，原五个 doctor 场景的期望记录加上三条凭据检查。

## 验收对照

| 验收 | 证据 | 状态 |
| --- | --- | --- |
| 1 三个服务由用户直接运行并输入；agent 不索取、不代登录 | `tests/credentials.test.ts`：「the Skland input flow …」「NGA and experimental Bilibili flows …」；非终端拒绝见「cancelled, rejected or failed input …」末段。SKILL：maa-setup 第 7 步、maa-doctor 第 6 步。评测场景 `setup-credential-entry`、`setup-credential-pasted`（离线评分自检，`tests/setup-scenarios.test.ts` 含「the pasted-credential scenario fails when the chat value is saved …」） | 实现与离线测试通过；真模型未验证 |
| 2 凭据在仓库外私有位置，设置文件和普通输出只有定位/状态 | 同上第一个测试：设置文件字节不变、全部文件和 stdout/stderr 扫不到合成值；「setup and doctor report the same credential check …」（`tests/setup.test.ts`）扫描 setup、doctor 输出和 `doctor-latest.json`，无值、无本机路径 | 通过 |
| 3 区分未设置、可用、已知过期、尚未验证，不凭存在称有效，不为检查打印值 | 「the shared check separates unset, unverified, usable, known-expired and unreadable without decrypting」：刚保存是尚未验证；可用只来自同一修订号的读取结果；到期时间离线判过期；检查 CLI 不经过加密边界 | 通过（离线替身） |
| 4 取消或失败不破坏已有可用设置；错误与诊断脱敏 | 「cancelled, rejected or failed input keeps an existing usable credential and its status intact」：拒绝、无回答、空值、控制字符、过长、含空格、加密失败、非终端八种情况，私有目录逐字节不变、无临时文件、仍为可用 | 通过 |
| 5 B 站标为实验性；森空岛社区不复用账号凭据 | B 站流程在粘贴前显示实验性说明（NGA/B 站测试），检查信息含 experimental；森空岛流程写明社区调研不用此 token（第一个测试）；用户手册与规格「资料来源」 | 通过；社区读取本身属工单 19 |
| 6 setup 与 doctor 共用检查；doctor 修法仍需点名批准；重新输入属用户手动修法 | 「setup and doctor report the same credential check; credential fixes stay with the user」：两边凭据检查对象完全相同；点名批准 `reenter-credential` 等也返回 `user-manual-repair`，状态不变；原有 `named-approval-required` 规则未改（`tests/doctor.test.ts` 回归通过） | 通过 |
| 7 森空岛只走粘贴 token 一条路，无密码项，不抓登录请求，不存密码，过期后重新粘贴 | 第一个测试：森空岛流程输出没有「密码/password」，只问是否继续和粘贴 token；状态矩阵测试断言过期修法是「paste a new token」；代码没有网络、浏览器或密码路径 | 通过 |
| 8 粘贴前用用户语言说明两点，并写进用户文档 | 第一个测试断言两点说明出现在粘贴提示之前（中文）；英文见流程文字；[用户手册](credentials.md)「森空岛：粘贴前请了解」 | 通过（中英文） |

## 按用户加密保存的评估与决定

参考 [OriginiumLab/MAA-PRTS](https://github.com/OriginiumLab/MAA-PRTS)（MIT）的 README，只看保存方式：token 经 Windows DPAPI 加密，只有本机当前用户能解开，账号文件复制到别的电脑后要重新输入 token；数据目录被 `.gitignore` 排除。没有参考它取得 token 的方式，没有复制代码。

本项目的做法：系统自带的 Windows PowerShell 5.1 调用 .NET 的 `ProtectedData.Protect`／`Unprotect`（[Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata.protect)），范围 `DataProtectionScope.CurrentUser`，附加熵由服务名和每次保存的随机修订号组成。明文和密文只经子进程的标准输入输出以 base64 传递，不进命令行参数或环境变量；`CryptographicException` 映射为退出码 3，再报告为 `credential-unreadable`；其他失败为 `protection-failed`；30 秒超时。

决定：采用。理由：

1. 私有目录被备份、同步、复制，或者被 agent 浏览时，文件里只有密文；换电脑、换用户无法使用。
2. 产品只支持 Windows，DPAPI 和 PowerShell 5.1 是系统自带，不需要新依赖。
3. 检查只读明文元数据，不解密；只有读取器在用的时候解密一次。

局限：同一 Windows 用户下的任何程序都能调用 DPAPI 解密，它不防同用户下的恶意程序，也不是防 agent 的边界；防 agent 接触值靠规则（agent 不运行输入、不读文件内容）和输入流程的终端检查。重装系统、换用户或漫游配置异常后需要重新输入。限制 PowerShell 的环境（例如受限语言模式）可能无法加密：保存失败，原记录不变，未实测。每次调用 PowerShell 本机约 0.75–1.3 秒。

## 有效期与刷新

参考 [FrostN0v0/nonebot-plugin-skland](https://github.com/FrostN0v0/nonebot-plugin-skland)（MIT，固定提交 `b88a9a9cf931be0ae63ff839a101ebe5ff9aa7a7`）的 `api/login.py`、`api/request.py`，只对照思路：用户 token 先换授权码，再换 cred；访问 token 用 cred 刷新；请求响应的 code 区分未授权和登录失效。README 没有写用户 token 的有效期。

结论：没有公开、可核实的有效期数字，09 不按时间推断有效期。「可用」只来自当前这份值的实际读取结果，并带上最近一次读取时间；读取器若得到明确的到期时间可以记下，过了即离线判为已知过期。换取或刷新被对方明确拒绝时，读取器（工单 12）记 `expired`，用户重新粘贴。真实接口的信号和行为未验证。

## 外部事实来源

| 事实 | 来源 | 核实情况 |
| --- | --- | --- |
| DPAPI `Protect`／`Unprotect` 的参数、`CurrentUser` 范围、失败抛 `CryptographicException` | [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata.protect) | 已读文档；本机 Windows 11 实测往返、错误熵失败 |
| MAA-PRTS 用 DPAPI 按本机当前用户保存 token | [MAA-PRTS README](https://github.com/OriginiumLab/MAA-PRTS) | 已读 README；未读源码 |
| 森空岛鉴权链与刷新的思路 | nonebot-plugin-skland 固定提交的 `api/login.py`、`api/request.py` | 已读；未实际调用 |
| B 站读取常用名为 SESSDATA 的 Cookie | [bilibili-API-collect 讨论 #1013](https://github.com/SocialSisterYi/bilibili-API-collect/discussions/1013) 等第三方资料 | 未经本仓库实测；工单 19 核对 |
| NGA 登录所需 Cookie 名称 | 未找到可核实的公开说明 | 未验证；因此收整条 Cookie 请求头，工单 18 核对实际需要后调整 |

## 测试与运行记录

本机 Windows 11、Node 24。测试使用真实临时目录和真实 CLI；只替代加密边界（`tests/fixtures/credential-boundary.mjs` 用 `--import` 把 `credential-protection.ts` 换成可逆替身），Windows 上另有一项使用真实 DPAPI。没有网络调用，没有读取维护者的真实凭据或私有目录。

- `tests/credentials.test.ts`：6 项（森空岛流程与知情说明、取消/失败保留原设置、状态矩阵、NGA 与 B 站流程、真实 DPAPI 往返、终端按键处理）。
- `tests/setup.test.ts`：检查列表加三条凭据检查；设置损坏时三条为 `credential-unknown`；新增 setup/doctor 共用检查与 `user-manual-repair`。
- `tests/doctor.test.ts`：检查列表加三条凭据检查。
- `tests/setup-scenarios.test.ts`、`tests/doctor-scenarios.test.ts`：新场景经真实安装 CLI 和评分器自检；新增「保存了对话里的值则评分失败」的反例。

运行结果见下一节「门禁运行」。

## 门禁运行

在提交 `d6f8e40`（本记录之前的最后一个代码提交）上运行，本机 Windows 11、Node 24：

- `npm ci --ignore-scripts` 后 `npm run typecheck`：通过。
- 单文件：`node --test tests/credentials.test.ts`（6 项通过）、`tests/setup.test.ts`、`tests/doctor.test.ts`、`tests/setup-scenarios.test.ts`、`tests/doctor-scenarios.test.ts`：全部通过。
- `node scripts/check.ts`：退出码 0。396 项测试中 395 通过、0 失败、1 跳过（非 Windows 进程适配器不可用分支，本机为 Windows 时跳过）；tracker、隐私、元数据检查无问题；评分规则自检 7 条、14 份样例通过。已知的「关闭 MAA」超时偶发项本次没有出现。

## 设计默认值

都已登记在[规格](spec.md)「默认值及其来源」中以「09」开头的行，日期 2026-11-13：非终端拒绝与 `--stdin` 只供测试和用户脚本、对话里出现值时的处理；DPAPI 加密与非 Windows 不保存、检查不解密；每服务一个值与 8192 字符上限；可用只来自实际读取、不按时间降级及状态与严重程度的对应；先保存设置文件、说明文字中英文、撤销由用户删文件；读取器只在明确拒绝时记过期。另有两处实现选择不构成产品限制：检查结果多一个 `unreadable`（记录损坏或解不开）和 `unknown`（设置不可读、位置未知）状态，比验收要求的四种更细；`readCredential` 遇到解不开的记录会顺带记下 `unreadable`，让下次检查提示重新输入。

## 未验证

- 真实森空岛、NGA、B 站调用：可用和过期的实际信号要等工单 12、18、19 的读取器和真实账号，由维护者在本机核对。
- 真实终端交互：隐藏输入的 raw mode 路径（打字、右键粘贴、Ctrl+V、Ctrl+C）只用导出的按键处理函数测试；需要维护者在自己的 Windows Terminal 或 PowerShell 里用合成值运行一次 `credentials.ts input skland`，确认不回显、可取消、可保存。
- 真模型行为评测：新增和调整的场景只做了离线评分链路自检。按开发约定需要同模型、同场景的前后运行，缺隔离登录，延到工单 26。评分器的秘密输出规则只认样例里的随机秘密；对话里贴出的合成值是否被模型复述不在自动评分范围内，需要人工看记录。
- 受限 PowerShell 环境、漫游配置文件下的 DPAPI 行为。
- 非 Windows：保存和读取都拒绝（`windows-required`）；Linux 只用替身覆盖流程。

## 给后续工单的接口

工单 10（doctor 全量检查）直接复用 `inspectCredentials`／`credentialCheck`；工单 12（森空岛快照）、18（NGA）、19（B 站）用 `readCredential` 在内存取值，实际读取后调用 `recordCredentialOutcome`。说明见[凭据接口](../skills/maa-core/references/credentials.md)「导出函数」一节。
