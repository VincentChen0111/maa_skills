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

以上是局部接口来源事实，不是全部依赖自动指纹核对，也不是任何完整版本「源码已核／实机已核」。07 交付时随包 [验证版本记录](../skills/maa-core/references/verified-versions.json) 的两个列表因此均为空；2026-11-13 起它由工单 25 的依赖条目生成，见 [MAA 版本跟踪的来源](maa-version-sources.md)。
