# 环境接入与下载接口

脚本只有相邻 `maa-core/scripts/setup.ts` 一份实现。Node 24，Windows GUI MAA；游戏客户端接受国服 `Official`／`Bilibili`，客户端字段来自当前配置 `Gui.RuntimeSettings.ClientType`，不能只凭设置中的 CN 推断。没有该字段时请用户在 MAA 界面检查，不默认通过。设置由偏好脚本读取；所有输入是标准输入 JSON，不把用户路径或原话拼进 shell 命令。

`node <本目录>/../../maa-core/scripts/setup.ts <动作> --json`。省略 `--json` 输出缩进 JSON，内容同为白名单。退出码 0 正常（版本提醒不阻断），1 有错误／需选择／未满足写入条件，2 意外失败需核对；具体看 `status`、`reason`、`checks`，不把退出码当游戏任务结果。

| 动作 | 输入 | 完成条件 |
| --- | --- | --- |
| `check` | `{}`，首次可传 `maaDirectory` 绝对路径 | 现场只读，返回每项状态、原因、修法及执行者；不创建设置或私有记录 |
| `prepare` | `{}` | 已经经偏好脚本保存设置；创建私有目录及原子替换 `setup-environment.json`，不创建账号／报告文件 |
| `discover` | `{}`；可传 `adbPaths` 绝对路径数组、`addresses` 数组 | 返回 adb 数量、读取失败数、脱敏候选及 `discoveryRevision`；每次重新发现 |
| `test` | `discoveryRevision`、所选 `candidate`；以及与 discover 相同的可选候选输入 | 重新发现与指纹一致，`connect` 后指定设备 `get-state` 返回 device；单一候选可省略 candidate |
| `apply` | test 的输入，另加 `host: "codex"` 或 `"claude"`、本次授权原话 `reference`；已获得关闭确认才加 `closedConfirmed: true` | 重新发现与复测，统一 writer 完成持锁关停、备份、必要键更新、受限重开、读回、记录和释放锁；已一致且无遗留锁才返回 unchanged |
| `plan` | `program`：`maa`、`node`、`adb` 或 `emulator`；模拟器另传 `vendor`、官方页面上的安装包 `url` 和页面写的 `version` | 只读官方发布索引，返回 `planned` 方案（`planId`、`fingerprint`、文件名、版本及出处、来源、官方页面、大小或未知、校验值、许可协议、步骤及执行者）；已装好返回 `not-needed`，已有核对过的下载返回 `already-downloaded`；不写文件 |
| `download` | 方案的 `program`、`planId`、`fingerprint`，用户对这份方案的确认原话 `reference`；adb 另需用户本人接受许可协议后的 `termsAccepted: true`；模拟器另传与 plan 相同的 `vendor`、`url`、`version` | 重新读取官方索引并与方案指纹一致，独占登记这份方案后才请求文件；逐跳检查官方主机，核对大小与官方校验值后才保存为 `downloaded`；一份方案只用一次 |
| `downloads` | `{}` | 每次重新核对文件摘要：`downloaded`、`download-invalid`、`failed`、`interrupted`、`in-progress`，以及解压状态 |
| `install` | 下载记录的 `planId`；MAA／adb 另传用户所选空文件夹 `target` 绝对路径 | 先重新核对文件；MAA／adb 用系统 `tar.exe` 解压（最多 600 秒，超时为 `extract-timeout`）并核对 `MAA.exe`／`platform-tools/adb.exe`，失败或超时都清空该文件夹；已解压返回 `already-extracted`；Node／模拟器只返回用户步骤 |
| `recheck` | `{}`，或用户选定的候选 `candidate`（候选 id），以及 discover 的可选候选输入；不接受 `discoveryRevision` | 重新检查 Node、MAA、设置、私有目录、下载状态；每次重新发现连接，按候选 id（只由 adb 路径和地址算出，连接写入和 MAA 改写配置后不变）找到同一候选后测试，找不到为 `candidate-unavailable`，没传候选不发起连接；原子替换 `setup-environment.json`；只有全部通过且连接测试通过才 `complete: true`、退出码 0 |

设置损坏／不可读时，`check` 返回退出码 1、`settings-unreadable` 及保留原文件后修复 JSON、字段或访问权限的用户修法。Windows、Node 和明确提供的 MAA 目录仍检查；未知私有目录返回 `private-directory-unverified`，不猜默认目录、不显示首次偏好提示，也不覆盖或自动创建。修复后重新检查。

发现范围：当前配置的 adb 路径、MAA 目录的 `adb.exe`／`adb/adb.exe`／`adb/platform-tools/adb.exe`、当前配置中模拟器程序目录相邻的 adb、PATH 的 adb，以及用户给定路径。相对 MAA 配置路径按 MAA 安装目录解析。只调用已存在且文件名以 adb 段结尾的 `.exe`，参数数组调用，不经过 shell；没有候选时不扫描全盘、不猜测安装位置。候选地址来自现有 Address／AddressHistory、`adb devices` 和用户输入，本票自动测试仅接收 `127.0.0.1:端口`、`localhost:端口`、`emulator-编号`，其它连接交用户手动核对。发现数量最多 32 个 adb、128 对连接，用户补充列表各最多 32 项；每个 adb 命令最多 5 秒、64 KiB 输出，失败不回显底层输出。

多个候选必须由用户选；返回的 id 只绑定本次候选，不是账号标识。地址、路径与私人配置名称不会出现在摘要。候选来源或状态无法帮助用户定位时，让其在本机 MAA／模拟器界面查看并提供所选路径与地址。显式 `adbPaths` 将 adb 发现限定到这些路径；显式 `addresses` 将地址限定到这些值，空列表表示不选择任何项。重新 discover 后再使用新指纹。`discovery-changed` 表示配置或候选集合变化，应重新检查与选择，不能重用旧选择。

写入仅使用当前配置里已存在的 `Gui.ConnectSettings.AdbPath`、`Address`、`AutoDetect`、`AlwaysAutoDetect`；两个自动发现开关设 false，让选择的连接保持确定。缺少这些字段先由用户在 MAA GUI 初始化。连接预设 `Config` 和增强／触控设置保留；adb 通不能证明这些设置正确。统一写入器复用现有 `daily-pending.jsonl`、`daily-runs.jsonl` 和配置备份目录，记录 skill 为 maa-setup；这些由 writer 管理，setup 不自行编辑或删除。doctor 可以核对该单配置事务。

`setup.ts apply` 调用统一 writer 的 `executeSetupConfigWrite`；该入口自身通过 `setup-connection.ts` 重新发现、选定并复测，按现场当前配置生成精确四字段差异，不接受任意 changes 或其他授权 grant。普通 `maa-config.ts write`／`executeConfigWrite` 不允许连接字段，不能用 approved-report 绕过。原空地址、空／相对 adb 路径及开关仅能经 doctor 已核遗留事务恢复。无变更仍检查 active／stale／unknown 锁；失败重开后不得把已写入当成接入完成。

`version` 从 MAA.exe 的 Windows ProductVersion 读取；缺少或格式未知时为 null。随包 [验证版本记录](../../maa-core/references/verified-versions.json) 目前两个列表都为空：仅核对若干固定源码字段不等于完整版本源码已核，更不等于实机已核。修改验证列表必须有本仓库实际验证证据。版本提醒不阻止接入。

官方入口：[MAA 下载与安装](https://docs.maa.plus/zh-cn/manual/install.html)、[MAA 官方发布](https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases)、[Node 官方下载](https://nodejs.org/en/download)（选择 24.x）、[Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools)、[MAA Windows 模拟器支持说明](https://docs.maa.plus/zh-cn/manual/device/windows.html)（从说明进入对应模拟器官方站点）。给出入口不等于已获下载同意。

## 下载流程

`setup-download.ts` 是唯一实现，`setup.ts` 的 `plan`、`download`、`downloads`、`install`、`recheck` 调用它。只替代网络（fetch）和解压工具两个系统边界。

| 程序 | 版本出处（只读索引） | 下载与校验 |
| --- | --- | --- |
| MAA | GitHub API 的 MaaAssistantArknights 最新正式发布（非草稿、非预发布）；文件 `MAA-v<版本>-win-<x64/arm64>.zip` | `github.com` 该仓库 releases/download 地址，可跳转到 `objects.githubusercontent.com`／`release-assets.githubusercontent.com`；大小与发布资产的 sha256 摘要（有则核对） |
| Node | `nodejs.org/dist/index.json` 中最高的 v24.x.y；文件 `node-v<版本>-<x64/arm64>.msi` | `nodejs.org/dist`；大小来自 HEAD 的 Content-Length，没有则如实写未知；sha256 来自同版本 `SHASUMS256.txt`，列表里没有该文件就不出方案 |
| adb | Google SDK 仓库索引 `repository2-1.xml` 中唯一稳定频道（channel-0）的 platform-tools 及其 Windows 归档 | `dl.google.com/android/repository`；大小与索引里的 SHA-1；下载前需用户本人接受 [Android SDK 许可协议](https://developer.android.com/studio/terms) |
| 模拟器 | MAA 模拟器页「完美支持」中的厂商：`mumu`、`ldplayer`、`bluestacks-cn`、`bluestacks`、`nox`、`memu`；版本是用户在厂商官方页面读到的值，记为 `official-page-stated` | 只接受该厂商官方域名及其子域名的 https 地址；MuMu 的域名只放行 `mumu.163.com`，另加两个确切主机（不含子域名）：下载接口 `mumu.nie.netease.com` 和它跳转到的文件主机 `a11.gdl.netease.com`。每次跳转同样检查。地址取自用户在官方页面点下载后浏览器下载列表里的地址；文件名取最终地址的路径名，路径里没有安装包名时才用 Content-Disposition（MuMu 每次请求给的 Content-Disposition 名字都不同）；大小来自 HEAD，没有则未知；厂商不公布校验值，`checksumVerified: false` |

方案不写文件，`planId` 每次随机。`download` 先拒绝缺少确认原话（`confirmation-required`）、已用过的方案（`plan-already-used`）、发布已变化或指纹不符（`plan-changed`）、adb 未接受协议（`terms-acceptance-required`），这些情况都不请求文件；再在私有目录 `downloads/records/<planId>.json` 独占登记后才请求文件。跳转最多 5 次，地址不是 https 官方主机即 `unofficial-source`；60 秒没有新数据或连接中断为 `download-interrupted`；大小不符 `size-mismatch`，校验不符 `checksum-mismatch`；大小未知时最多 4 GiB；每次读索引和 HEAD 请求最多 30 秒；确认原话最多 2000 字符，模拟器地址最多 2048 字符。失败删除临时文件，记录为 `failed`。进程中途退出留下的 `downloading` 记录由 `downloads` 报为 `interrupted`，记录保留，临时文件在下一次下载开始前回收；格式不对或文件名越界的记录一律不用。

下载文件放在私有目录 `downloads/`，记录保存版本、来源、大小、sha256 和确认原话；输出不含本机路径和确认原话。`install` 的目标必须是空文件夹或不存在，不能是盘符根目录、Program Files 或 Windows 目录下，也不能与私有目录互相包含。系统 `tar.exe`（bsdtar）默认拒绝绝对路径和含 `..` 的条目；解压失败或缺少预期程序时清空该文件夹，记录 `failed`。下载与解压都不写设置或 MAA 配置：MAA 目录经偏好脚本保存，adb 路径经 `apply` 写入。

`plan`、`download`、`install`、`recheck` 需要 Windows；Node 主版本不是 24 时，只有 `program: "node"` 的 `plan`／`download` 和 `downloads` 可用。没有能运行脚本的 node 时，由用户从官方页面下载安装 Node 24。
