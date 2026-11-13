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
| 模拟器 | [MAA Windows 模拟器支持](https://docs.maa.plus/zh-cn/manual/device/windows.html)（页面由脚本渲染，内容按其[文档源文件](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/dev/docs/zh-cn/manual/device/windows.md)核对） | 「完美支持」为 MuMu（mumu.163.com）、雷电（www.ldmnq.com）、蓝叠 5（www.bluestacks.cn）、蓝叠 5 国际版（www.bluestacks.com）、夜神（www.yeshen.com）、逍遥（www.xyaz.cn）；页面说明排名不分先后，不指定推荐。雷电官网首页的下载按钮指向 `lddl01.ldmnq.com`，页面显示版本但不显示大小。MuMu 下载页的按钮地址由脚本生成，静态页面里没有安装包地址、版本或大小（MuMu 的下载链路见下文 R1 补充）。厂商都没有可机读的发布索引或校验值 |

由此定下的做法（设计默认值见[规格](spec.md)「默认值及其来源」）：MAA、Node、adb 的版本和文件名由上面三个索引决定，模拟器由用户在厂商官方页面点下载、从浏览器下载列表取得实际下载地址并读出版本号，脚本只接受该厂商官方域名下的 https 地址（MuMu 的域名只接受 `mumu.163.com`，另加两个确切主机，见下文），每次跳转都重新检查主机。GitHub 资产下载跳转到 `objects.githubusercontent.com` 或 `release-assets.githubusercontent.com`；GitHub 没有正式文档说明，`release-assets.githubusercontent.com` 由 R1 审查员 2026-11-13 只读核实；其他主机一律拒绝，完整性由 API 给出的 sha256 摘要保证。

### R1 补充（2026-11-13）

- MuMu 下载链路：审查员只读查看 mumu.163.com/download/ 的脚本，下载按钮加载 `adl.netease.com` 上的脚本，再调用下载接口 `https://mumu.nie.netease.com/api/dl/win`。本作者另用不跟随跨主机跳转的只读请求核对：该接口返回 302，Location 指向 `a11.gdl.netease.com` 上的 `MuMu_6.0.6_..._zh-Hans_....exe`，查询串带 `n=` 文件名和两个签名参数；没有下载安装包。因此 MuMu 另放行这两个确切主机，不放行 `adl.netease.com`（只提供脚本）和 netease.com 的其他主机。用户提供接口地址或浏览器下载列表里的文件地址都可以。R2、R3 审查员和本作者 2026-11-13 用 HEAD 只读核对：接口每次调用都给出新的 `n=` 和签名参数；文件主机的 Content-Disposition 文件名等于该地址里的 `n=` 值，同一个文件地址得到同一个名字，名字的变化来自接口每次发新的 `n=`（例如 `MuMu_6.0.6_12g9XL3C.exe` 与 `MuMu_6.0.6_12g9YkKC.exe`）。文件地址的路径名 `MuMu_<版本>_apinochannel_zh-Hans_<编号>.exe` 和大小在多次调用之间一致。签名参数 key2 的有效期为 48 小时只是 R2 审查员的观察，HEAD 无法证实，记为未核实。所以脚本用最终地址的路径名作文件名，只有路径里没有安装包名时才用 Content-Disposition；这样从接口地址或文件地址开始，方案和下载的指纹都一致。从文件地址开始时，签名一旦失效就需要用户重新取地址、重新出方案。
- MAA 发行包结构：MAA 仓库 [ci.yml](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/dev/.github/workflows/ci.yml) 把 GUI 发布到 `install` 目录（`-o install`），再在该目录内执行 `Compress-Archive -Destination MAA-<tag>-win-<arch>.zip -Path ./*`，所以 zip 的顶层就是 `install` 目录的内容。`MAA.exe` 在顶层是由此得出的推断（审查员与本作者均只读查看了 ci.yml），没有用真实发行包核实。
- 雷电：官网首页的安装包来自 `lddl01.ldmnq.com`，属于已放行的 `ldmnq.com`。

### 下载链路核对（R3 2026-11-13，R4 2026-11-14 复核）

R3 审查发现夜神、逍遥的真实下载跳转到官网域名以外的主机，和 R1 的 MuMu 是同一类问题。脚本改为只从一张厂商表判断：官网域名（含子域名，沿用原有范围）加上下表记录的链路里出现的确切主机（不含子域名）。每条链路由本作者 2026-11-13 用 `curl -I`（只发 HEAD、不跟随跳转）逐跳核对；R4 审查发现蓝叠 5 的起点已返回 403 之后，本作者 2026-11-14 又逐跳复核全部链路：用 Node 的 fetch 只发 HEAD、`redirect: 'manual'` 不跟随跳转、只带脚本自己的 User-Agent `maa-skills-setup`，每个 Location 单独再发一次 HEAD；夜神后两条起点当时 Node 连接超时，改用同样只发 HEAD、不跟随跳转、同一 User-Agent 的 `curl -I` 核对。两次都没有下载任何安装包，没有发送 Referer 或任何模仿浏览器的请求头；签名参数已省略。

下表是 2026-11-14 的结果。表中的起点地址、主机、每一跳的 HEAD 状态（`observed`，每个地址一个）和核对日期（`checked`）与 `skills/maa-core/scripts/setup-download.ts` 的 `emulatorVendors` 一一对应，`tests/setup-download-vendors.test.ts` 检查两边一致，并按记录的状态逐条回放。

| 厂商 | 起点（官方页面使用的地址） | 逐跳 HEAD 状态与文件（2026-11-14） | 表中 `observed` |
| --- | --- | --- | --- |
| MuMu | `https://mumu.nie.netease.com/api/dl/win`（官网下载按钮的脚本调用；浏览器下载列表里的文件地址也可作起点） | 302 → `a11.gdl.netease.com` 的 `MuMu_6.0.6_apinochannel_zh-Hans_<编号>.exe?n=…`：200，6,466,544 字节 | `[302, 200]` |
| 雷电 | `https://lddl01.ldmnq.com/downloader/ldplayerinst14.exe`；`https://lddl01.ldmnq.com/downloader/ldplayerinst9.exe?n=ldplayer9_ld_412572_ld.exe`（官网首页按钮） | 起点即文件主机：两条都是 200，各 1,594,848 字节（在线安装器） | 各 `[200]` |
| 蓝叠 5 | `https://aliosscdn1.bluestacks.cn/BSLive/BlueStacksMicroInstaller.exe` | 起点即文件主机：**403**，响应头 `x-oss-ec: 0003-00000501`（阿里云 OSS 防盗链：没有 Referer 的请求被拒）。2026-11-13 R3 时这一地址 HEAD 200、约 0.8 MB；R4 审查员 2026-11-14 用脚本 User-Agent 和 curl User-Agent 三次 HEAD 都是 403，本作者同日用 Node fetch 和 `curl -I` 复核也都是 403。官网 downloads.html 另列的 `BlueStacksMicroInstallerForWin7.exe` 在 2026-11-13 已是 403，没有收进表里 | `[403]`：脚本不能下载 |
| 蓝叠 5 国际版 | `https://cloud.bluestacks.com/api/getdownloadnow?platform=win`（官网 tw/download.html 的 Windows 下载按钮） | 302 → `ak-build.bluestacks.com` 的 `BlueStacksMicroInstaller_5.22.290.1031_native.exe`：200，955,232 字节。两个主机都在原已放行的 `bluestacks.com` 内，此处仍逐一记录 | `[302, 200]` |
| 夜神 | 三条起点，是三个不同的安装包：`https://www.yeshen.com/cn/download/fullPackage/win_64?formal`、`https://www.yeshen.com/cn/download/fullPackage/win_64_9?formal`、`https://www.yeshen.com/cn/download/fullPackage?formal` | 每条都是 302 → `res06.bignox.com` 上以十六进制命名的 `.exe`，再 200：`win_64` 跳到路径日期 20241211 的文件，572,471,032 字节；`win_64_9` 跳到路径日期 20250226 的文件，600,709,368 字节；`fullPackage?formal` 跳到路径日期 20250317 的文件，431,437,560 字节。三者的 Content-Disposition 都是 `filename="nox_setup_v7.0.6.2_full.exe"`，但大小不同。`fullPackage/win_64_12?formal` 跳到 `.7z` 包，脚本只接受 exe／msi／zip，没有记录 | 各 `[302, 200]` |
| 逍遥 | `https://www.xyaz.cn/download.php?file_name=XYAZ-Installer` | 303 → `download.microvirt.com` 的 `XYAZ-Installer.exe`：200，19,919,104 字节 | `[303, 200]` |

新增放行的确切主机只有 `res06.bignox.com` 和 `download.microvirt.com`；同公司的其他主机（例如 `bignox.com`、`microvirt.com` 的其他子域名）一律拒绝。厂商更换 CDN 主机时下载会以 `unofficial-source` 失败，需要重新核对并更新这张表。夜神按路径名命名的文件是十六进制串，方案原样显示该文件名。

### 官方服务器拒绝脚本请求（R4，2026-11-14）

脚本只发自己的 User-Agent（读 GitHub 索引时另加 Accept），不发 Referer、Cookie 或任何模仿浏览器的请求头，也不为了绕过厂商的防盗链换请求头重试。由此定下（设计默认值，2026-11-14，见[规格](spec.md)「默认值及其来源」）：

- 任何一跳返回 401 或 403，表示官方服务器拒绝脚本的请求：出方案时不出方案，结果是 `source-refused`；下载时记为 `failed`，原因 `source-refused`。不重试，不换请求头。判断只有一处：`setup-download.ts` 的 `chainScriptable`，厂商表的记录状态和每一次实际请求都用它。
- 记录状态里有 401／403 的厂商，出方案和下载都直接返回 `source-refused`，不向它发任何请求。脚本不能下载的厂商：`bluestacks-cn`（蓝叠 5）。用户在自己的浏览器里从官方页面 `https://www.bluestacks.cn/` 下载安装包，然后从方案里的 `run-emulator-installer` 这一步继续：由用户自己运行安装程序，不需要把文件交给脚本；之后照常是模拟器首次设置、游戏客户端（用户）和 adb 连接、复检（skill）。
- 若维护者同意带官网页面作 Referer，需作为新规则登记：这是维护者才能做的决定，要在规格两张来源表登记来源，重新只读核对后再改厂商表。目前没有这个授权。

未核实的事实：MAA zip 解压后 `MAA.exe` 在顶层（见上一条，按 ci.yml 推断）；platform-tools zip 解压后是 `platform-tools/adb.exe`（MAA 自身替换 adb 时也使用 `adb/platform-tools/adb.exe`，见上文 ConnectSettingsUserControlModel 的核对）。脚本按这些假设核对解压结果，不符时解压记为失败并清空目标文件夹，不会记为成功。上表的模拟器下载主机和状态已由 HEAD 核对，但只代表核对当日：没有下载任何安装包，安装包内容和完整性没有核对（大小只来自 HEAD 的 Content-Length）；蓝叠 5 的 403 以后是否解除未知，解除后也要重新核对并改表，脚本才会下载它。Windows 自带 `tar.exe`（bsdtar）解压 zip、拒绝含 `..` 的条目，本机用合成 zip 实测过（见 [setup 验证记录](setup-verification.md)）。
