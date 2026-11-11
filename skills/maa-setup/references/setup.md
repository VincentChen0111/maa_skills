# 现有环境接入接口

脚本只有相邻 `maa-core/scripts/setup.ts` 一份实现。Node 24，Windows GUI MAA；游戏客户端接受国服 `Official`／`Bilibili`，客户端字段来自当前配置 `Gui.RuntimeSettings.ClientType`，不能只凭设置中的 CN 推断。没有该字段时请用户在 MAA 界面检查，不默认通过。设置由偏好脚本读取；所有输入是标准输入 JSON，不把用户路径或原话拼进 shell 命令。

`node <本目录>/../../maa-core/scripts/setup.ts <动作> --json`。省略 `--json` 输出缩进 JSON，内容同为白名单。退出码 0 正常（版本提醒不阻断），1 有错误／需选择／未满足写入条件，2 意外失败需核对；具体看 `status`、`reason`、`checks`，不把退出码当游戏任务结果。

| 动作 | 输入 | 完成条件 |
| --- | --- | --- |
| `check` | `{}`，首次可传 `maaDirectory` 绝对路径 | 现场只读，返回每项状态、原因、修法及执行者；不创建设置或私有记录 |
| `prepare` | `{}` | 已经经偏好脚本保存设置；创建私有目录及原子替换 `setup-environment.json`，不创建账号／报告文件 |
| `discover` | `{}`；可传 `adbPaths` 绝对路径数组、`addresses` 数组 | 返回 adb 数量、读取失败数、脱敏候选及 `discoveryRevision`；每次重新发现 |
| `test` | `discoveryRevision`、所选 `candidate`；以及与 discover 相同的可选候选输入 | 重新发现与指纹一致，`connect` 后指定设备 `get-state` 返回 device；单一候选可省略 candidate |
| `apply` | test 的输入，另加 `host: "codex"` 或 `"claude"`、本次授权原话 `reference`；已获得关闭确认才加 `closedConfirmed: true` | 重新发现与复测，统一 writer 完成持锁关停、备份、必要键更新、受限重开、读回、记录和释放锁；已一致且无遗留锁才返回 unchanged |

设置损坏／不可读时，`check` 返回退出码 1、`settings-unreadable` 及保留原文件后修复 JSON、字段或访问权限的用户修法。Windows、Node 和明确提供的 MAA 目录仍检查；未知私有目录返回 `private-directory-unverified`，不猜默认目录、不显示首次偏好提示，也不覆盖或自动创建。修复后重新检查。

发现范围：当前配置的 adb 路径、MAA 目录的 `adb.exe`／`adb/adb.exe`／`adb/platform-tools/adb.exe`、当前配置中模拟器程序目录相邻的 adb、PATH 的 adb，以及用户给定路径。相对 MAA 配置路径按 MAA 安装目录解析。只调用已存在且文件名以 adb 段结尾的 `.exe`，参数数组调用，不经过 shell；没有候选时不扫描全盘、不猜测安装位置。候选地址来自现有 Address／AddressHistory、`adb devices` 和用户输入，本票自动测试仅接收 `127.0.0.1:端口`、`localhost:端口`、`emulator-编号`，其它连接交用户手动核对。发现数量最多 32 个 adb、128 对连接，用户补充列表各最多 32 项；每个 adb 命令最多 5 秒、64 KiB 输出，失败不回显底层输出。

多个候选必须由用户选；返回的 id 只绑定本次候选，不是账号标识。地址、路径与私人配置名称不会出现在摘要。候选来源或状态无法帮助用户定位时，让其在本机 MAA／模拟器界面查看并提供所选路径与地址。显式 `adbPaths` 将 adb 发现限定到这些路径；显式 `addresses` 将地址限定到这些值，空列表表示不选择任何项。重新 discover 后再使用新指纹。`discovery-changed` 表示配置或候选集合变化，应重新检查与选择，不能重用旧选择。

写入仅使用当前配置里已存在的 `Gui.ConnectSettings.AdbPath`、`Address`、`AutoDetect`、`AlwaysAutoDetect`；两个自动发现开关设 false，让选择的连接保持确定。缺少这些字段先由用户在 MAA GUI 初始化。连接预设 `Config` 和增强／触控设置保留；adb 通不能证明这些设置正确。统一写入器复用现有 `daily-pending.jsonl`、`daily-runs.jsonl` 和配置备份目录，记录 skill 为 maa-setup；这些由 writer 管理，setup 不自行编辑或删除。doctor 可以核对该单配置事务。

`setup.ts apply` 调用统一 writer 的 `executeSetupConfigWrite`；该入口自身通过 `setup-connection.ts` 重新发现、选定并复测，按现场当前配置生成精确四字段差异，不接受任意 changes 或其他授权 grant。普通 `maa-config.ts write`／`executeConfigWrite` 不允许连接字段，不能用 approved-report 绕过。原空地址、空／相对 adb 路径及开关仅能经 doctor 已核遗留事务恢复。无变更仍检查 active／stale／unknown 锁；失败重开后不得把已写入当成接入完成。

`version` 从 MAA.exe 的 Windows ProductVersion 读取；缺少或格式未知时为 null。随包 [验证版本记录](../../maa-core/references/verified-versions.json) 目前两个列表都为空：仅核对若干固定源码字段不等于完整版本源码已核，更不等于实机已核。修改验证列表必须有本仓库实际验证证据。版本提醒不阻止接入。

缺失程序只给官方入口：[MAA 下载与安装](https://docs.maa.plus/zh-cn/manual/install.html)、[MAA 官方发布](https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases)、[Node 官方下载](https://nodejs.org/en/download)（选择 24.x）、[Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools)、[MAA Windows 模拟器支持说明](https://docs.maa.plus/zh-cn/manual/device/windows.html)（从说明进入对应模拟器官方站点）。文件下载、解压和安装由后续下载流程处理；不把这些入口当成已获下载同意。
