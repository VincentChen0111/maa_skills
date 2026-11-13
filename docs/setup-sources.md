# setup 接口来源核对

2026-11-11，只读官方资料与固定源码；未运行真实 MAA、adb、模拟器或游戏。实现独立编写，不复制／再分发 MAA 的 AGPL 源码。源码查看通过 GitHub 连接器；表内为固定提交的 Git blob SHA。

MAA 固定 [v6.21.4 / 52d0b2acaca116585b02e1e6a9da303460f81a24](https://github.com/MaaAssistantArknights/MaaAssistantArknights/tree/52d0b2acaca116585b02e1e6a9da303460f81a24)。

| 依赖事实 | 文件 | 指纹 |
| --- | --- | --- |
| 当前配置由 Current 选择，Configurations 为命名配置集合 | [Root.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Root.cs) | 247118236d6a3350ea8c495c76c03759efbf83b8 |
| 配置包含 Gui；Gui 包含 ConnectSettings、RuntimeSettings、StartUpSettings | [SpecificConfig.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/SpecificConfig.cs)、[Gui.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/Settings/Gui.cs) | f0764db882ea6fdfec200cadb62decbd7721cee4 / e42bde7e91dfe582567a949ee9111bf976dfaa62 |
| AdbPath、Address 为 string，默认空；AddressHistory 为 string 列表；AutoDetect／AlwaysAutoDetect 为 bool | [ConnectSettings.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/Settings/ConnectSettings.cs) | 7310f8919acac24d7f24ed1a1b7115898f39ad9c |
| EmulatorPath 保存模拟器程序路径 | [StartUpSettings.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/Settings/StartUpSettings.cs) | 0cc7529db8fb09e44c3c12794c8e8ee3bff18cb1 |
| ClientType 位于 RuntimeSettings；Official 是官服，Bilibili 是 B 服 | [RuntimeSettings.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/Settings/RuntimeSettings.cs)、[ClientType.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Constants/Enums/ClientType.cs) | da795016386b66e0d6a29f0f826dd5078cf865a7 / 5d767ae24dbde707bc2612c6d2e296f15473c222 |

另逐段查看 [ConnectSettingsUserControlModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UserControl/Settings/ConnectSettingsUserControlModel.cs)：字段回写位置、多模拟器需要选择、adb 替换后使用相对 `adb/platform-tools/adb.exe`。本工具没有复制其模拟器端口表、设备操作、下载或界面代码；只将空／相对路径的合法性用于原值恢复。

[Android 官方 adb 文档](https://developer.android.com/tools/adb) 说明 devices 枚举、connect 和指定序列号方式；设备状态只代表 adb 传输，不代表游戏或 MAA 识别成功。脚本仅这三个命令形态，不发 shell/input、截图或安装指令。[Microsoft ProductVersion](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.fileversioninfo.productversion) 说明可读取本地文件版本且可能为空；本工具只读 MAA.exe 的版本资源并验证格式，读不到时提醒。尚未对实际 MAA 安装包核实其 ProductVersion 内容，不能将该字段读法写成已实机验证。

官方安装入口已查看 [MAA 安装文档](https://docs.maa.plus/zh-cn/manual/install.html)、[Windows 模拟器支持](https://docs.maa.plus/zh-cn/manual/device/windows.html)、[Node 下载](https://nodejs.org/en/download)。Node 按仓库约束选择 24.x，而不是网页默认主版本。本票不下载发行包；首次错误链接 `manual/initialization.html` 访问失败，已改为文档导航实际给出的 `manual/install.html`。

以上是局部接口来源事实，不是全部依赖自动指纹核对，也不是任何完整版本「源码已核／实机已核」。随包 [验证版本记录](../skills/maa-core/references/verified-versions.json) 的两个列表因此均为空。

## 08 下载来源核对（2026-11-13）

2026-11-13 只读查看下列官方页面和发布索引，确定下载流程使用的官方位置与数据格式；没有下载任何发行包，脚本也没有访问真实网络。测试和评测只用合成索引与下载样例。MAA 为 AGPL：这里只记录事实，没有复制其代码或资源。

| 程序 | 官方位置 | 当日核对到的事实 |
| --- | --- | --- |
| MAA | [MAA 下载与安装](https://docs.maa.plus/zh-cn/manual/install.html)；[GitHub Releases](https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases)；索引 [releases/latest API](https://api.github.com/repos/MaaAssistantArknights/MaaAssistantArknights/releases/latest) | 文档列出官网、GitHub Releases、Mirror酱（文档写明为第三方付费加速）、QQ 群文件和 winget；Windows 选 `MAA-<版本号>-win-x64.zip`，完整解压到文件夹，不要解压到系统盘根目录或 Program Files 这类需要 UAC 的路径，先以管理员运行 `DependencySetup_依赖库安装.bat`，再双击 `MAA.exe`。当日最新正式发布为 v6.22.0（非草稿、非预发布），资产含 `name`、`size`、`browser_download_url`（`github.com/<仓库>/releases/download/<tag>/<文件>`）和 `digest`（`sha256:` 加 64 位十六进制）。本工具只用 GitHub 正式发布，不用镜像、群文件或 winget |
| Node | [Node 下载](https://nodejs.org/en/download)；索引 [dist/index.json](https://nodejs.org/dist/index.json)；校验 `dist/v<版本>/SHASUMS256.txt` | index.json 是数组，每项有 `version`、`files`、`lts` 等；当日 v24 最新为 v24.22.3（LTS Krypton）。SHASUMS256.txt 每行为 64 位 sha256、两个空格、文件名，含 `node-v24.22.3-x64.msi` 与 `node-v24.22.3-arm64.msi`。index.json 不给文件大小，大小只能取下载服务器的 Content-Length |
| adb | [SDK Platform-Tools 发布说明](https://developer.android.com/tools/releases/platform-tools)；索引 [repository2-1.xml](https://dl.google.com/android/repository/repository2-1.xml)；[Android SDK 许可协议](https://developer.android.com/studio/terms) | 发布页写明下载前必须同意条款，条款即 Android Software Development Kit License Agreement（页面日期 2021-07-27）。索引根元素为 `sdk:sdk-repository`；有两个 `platform-tools` 包：channel-2 预览版 37.0.3（`android-sdk-preview-license`）和 channel-0 稳定版 37.0.1（`android-sdk-license`）。包内结构为 `revision/major,minor,micro`、`channelRef ref`、`archives/archive/complete/size,checksum,url` 与 `host-os`；`checksum` 没有 type 属性，值为 40 位十六进制，按该格式默认的 SHA-1 处理；Windows 归档文件名为 `platform-tools_r37.0.1-win.zip` |
| 模拟器 | [MAA Windows 模拟器支持](https://docs.maa.plus/zh-cn/manual/device/windows.html)（页面由脚本渲染，内容按其[文档源文件](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/dev/docs/zh-cn/manual/device/windows.md)核对） | 「完美支持」为 MuMu（mumu.163.com）、雷电（www.ldmnq.com）、蓝叠 5（www.bluestacks.cn）、蓝叠 5 国际版（www.bluestacks.com）、夜神（www.yeshen.com）、逍遥（www.xyaz.cn）；页面说明排名不分先后，不指定推荐。雷电官网首页的下载按钮指向 `lddl01.ldmnq.com`，页面显示版本但不显示大小。MuMu 下载页的按钮地址由脚本生成，静态页面里没有安装包地址、版本或大小。厂商都没有可机读的发布索引或校验值 |

由此定下的做法（设计默认值见[规格](spec.md)「默认值及其来源」）：MAA、Node、adb 的版本和文件名由上面三个索引决定，模拟器由用户在厂商官方页面复制安装包链接、读出版本号，脚本只接受该厂商官方域名下的 https 地址（MuMu 只接受 `mumu.163.com`），每次跳转都重新检查主机。GitHub 资产下载跳转到 `objects.githubusercontent.com` 或 `release-assets.githubusercontent.com`，这一点来自社区报告和以往观察，GitHub 没有正式文档；其他主机一律拒绝，完整性由 API 给出的 sha256 摘要保证。

未核实、需要真实发行包才能确认的事实：MAA zip 解压后 `MAA.exe` 在顶层；platform-tools zip 解压后是 `platform-tools/adb.exe`（MAA 自身替换 adb 时也使用 `adb/platform-tools/adb.exe`，见上文 ConnectSettingsUserControlModel 的核对）；各厂商安装包的真实下载主机（MuMu、蓝叠、夜神、逍遥）。脚本按这些假设核对解压结果，不符时解压记为失败并清空目标文件夹，不会记为成功。Windows 自带 `tar.exe`（bsdtar）解压 zip、拒绝含 `..` 的条目，本机用合成 zip 实测过（见 [setup 验证记录](setup-verification.md)）。
