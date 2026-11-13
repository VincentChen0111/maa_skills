# 凭据接口

入口是 `maa-core` 目录的 `scripts/credentials.ts`，Windows 按用户加密的边界在同目录 `scripts/credential-protection.ts`，两者各只有一份实现，需要 Node 24。凭据是用户为 NGA、森空岛账号和实验性 B 站在本地脚本里自己输入的值；用户手册见仓库的[凭据说明](https://github.com/VincentChen0111/maa_skills/blob/main/docs/credentials.md)。

## 谁做什么

- 输入只由用户本人在自己的终端运行 `input`。agent 不运行 `input`，不代用户输入，不替用户登录，也不请用户把 token、Cookie 或 SESSDATA 贴到对话里。
- 用户已经把值贴进对话时：不复述、不保存、不传给任何脚本；告诉用户对话里的值已经不是只在本机，建议在对应网站退出登录或换新后，再用本地脚本输入新值。
- agent 只运行 `check`，只报告状态。不要读取、复制或展示私有目录 `credentials/` 下的文件内容。
- 读取器（森空岛账号快照、NGA 与 B 站调研）在进程内用导出函数取值，用完不打印、不写日志、不另存。

## 命令

`node <maa-core>/scripts/credentials.ts check [--json]`：agent 使用。只读，不解密，不联网，不创建目录。返回 `checkedAt`、`exitCode`、`credentials`（每项 `service`、`state`、`experimental`、`savedAt`、`lastResultAt`、`expiresAt`）和 `checks`（每项 `id`、`status`、`reason`、`message`、`repair`）。退出码 0 表示没有错误（可以有提醒），1 表示有已知过期或无法读取的凭据，或请求不合法，2 表示意外失败。输出里没有值、账号标识或本机路径。

`node <maa-core>/scripts/credentials.ts input <nga|skland|bilibili> [--language <BCP 47 标签>]`：只给用户本人在自己的终端运行。agent 给出带实际路径的这条命令，让用户自己打开终端运行；给命令时附上 `--language` 和用户的语言标签。流程依次显示该服务的说明、询问是否继续（输入 y），再请用户粘贴一个值。两次输入都不显示在屏幕上，Ctrl+C 取消。森空岛的说明在粘贴之前显示，内容见用户手册。说明文字有中文和英文两种：标签以 `zh` 开头用中文，其他语言用英文；没有 `--language` 时用设置文件里的语言，再没有时用系统语言。

- 退出码 0：已保存，状态为「尚未验证」。非 0：取消、格式不对、尚未保存初始设置、设置文件不可读、不是 Windows、加密失败或终端不可用；这些情况下原有记录和状态都保持原样。
- 标准输入不是终端时拒绝（`terminal-required`），不读取管道里的内容。`--stdin` 让流程从标准输入逐行读取答案，只用于自动测试和用户自己的脚本；agent 不使用。
- 先要经偏好脚本保存过设置文件（`set-preferences-first`），值保存在设置指向的私有目录里，不会落到用户尚未确认的默认位置。

各服务只收一个值，单值最多 8192 个字符，首尾空白会去掉：

| 服务 | 收什么 | 格式要求 |
| --- | --- | --- |
| `nga` | 已登录 NGA 的浏览器里 Cookie 请求头的值 | 可打印 ASCII，含 `name=value`；开头的 `Cookie:` 会去掉 |
| `skland` | 用户自己取得的森空岛（鹰角网络通行证）token | 可打印 ASCII，不含空格；整体包在一对双引号里时去掉引号 |
| `bilibili` | 名为 `SESSDATA` 的 Cookie 值（实验性） | 同上 |

不收密码，也没有密码输入项。森空岛只收用户自己粘贴的 token：不提供账号密码登录，不通过浏览器或内嵌网页抓取登录请求，不保存密码用于过期后重新登录。

## 状态

检查不把「存在」当成「可用」。状态只来自保存的记录和读取器记下的实际读取结果：

| `state` | `status` | `reason` | 修法 `repair.id`（执行者都是 user） | 含义 |
| --- | --- | --- | --- | --- |
| `unset` | normal | `credential-unset` | `enter-credential` | 没有保存；只在需要对应功能时由用户运行 `input` |
| `unverified` | warning | `credential-unverified` | `verify-by-use` | 已保存，但当前这份值还没有实际读取结果，是否有效未知 |
| `usable` | normal | `credential-usable` | `replace-credential` | 当前这份值最近一次实际读取成功；下次读取前仍可能过期 |
| `expired` | error | `credential-expired` | `reenter-credential` | 读取器报告过期或被拒，或读取器记下的到期时间已过 |
| `unreadable` | error | `credential-unreadable` | `reenter-credential` | 记录损坏，或当前 Windows 用户解不开（例如从别的电脑或用户复制而来） |
| `unknown` | warning | `credential-unknown` | `inspect-settings` | 设置文件不可读，私有目录未知，不猜位置 |

修法都只能由用户做：过期或无法读取时，用户自己重新运行 `input` 粘贴新值。`maa-setup` 的 `check` 和 `maa-doctor` 的 `check` 都附上这三条检查（`credential-nga`、`credential-skland`、`credential-bilibili`），与本命令是同一个检查函数。`doctor.ts repair` 收到这些修法 id 时返回 `user-manual-repair`，点名批准也不会让 skill 代为输入或登录。

## 存放

私有目录下的 `credentials/` 目录，每个服务两个文件：

- `<服务>.json`：输入流程写入。明文部分只有格式版本、服务、随机修订号 `revision`、保存时间、保护方式 `windows-dpapi-current-user` 和字段名；值本身用 Windows DPAPI 的当前用户范围加密成 `ciphertext`，附加熵绑定服务和修订号。复制到别的电脑、别的 Windows 用户或别的服务文件名下都解不开。
- `<服务>.status.json`：读取器写入，记录某个修订号最近一次实际读取的结果（`usable`、`expired`、`unreadable`）、时间和可选的到期时间。重新输入会产生新修订号，旧结果随之失效。

两个文件都先写临时文件再改名替换，写到一半不会覆盖原记录。设置文件不记录任何凭据信息，凭据的位置由设置里的私有目录决定。用户想撤销时，删除对应服务的这两个文件即可；agent 不代为删除。

## 导出函数（供后续读取器）

```ts
import { inspectCredentials, credentialCheck, readCredential, recordCredentialOutcome } from '../../maa-core/scripts/credentials.ts';
```

- `inspectCredentials(privateDirectory | null, now?)`：共享检查，返回 `{ credentials, checks }`。传 `null` 表示私有目录未知。
- `credentialCheck(service, state)`：单条检查结果。评测场景不运行产品代码，期望值写成与它一致的固定字面值，由 doctor 场景测试对照安装后的 CLI 核对。
- `readCredential(service, { privateDirectory })`：在内存里解密，返回 `{ revision, values }`。错误只有固定代码：`credential-unset`、`credential-unreadable`（同时记下 `unreadable` 结果）、`windows-required`、`protection-failed`。
- `recordCredentialOutcome(service, revision, outcome, { privateDirectory, expiresAt? })`：实际读取后记下结果。`revision` 不是当前记录的修订号时不写，返回 `false`，旧值的结果不会把新值标成可用。只有对方明确拒绝凭据（例如未授权、token 换取访问凭证失败）才记 `expired`；网络失败、超时、风控、响应不完整不记，按读取器自己的状态报告。
- `saveCredential`、`normalizeCredentialValue` 只供输入流程和测试使用，skill 不调用。

测试用 `--import` 加载器替换 `credential-protection.ts`（见仓库 `tests/fixtures/credential-boundary.mjs`），文件和 CLI 保持真实；不读取维护者的真实凭据。森空岛 token 换取访问凭证、请求签名和刷新属于读取器（工单 12），本接口不联网。
