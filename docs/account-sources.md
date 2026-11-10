# account 识别来源核对

2026-11-11 只读核对；未启动真实 MAA 或设备，不代表实机已核。

## dsh-maa-cli

在固定提交 [cdeaa8fac12bdc1db5b4ea5c33fca358dc6cf43b](https://github.com/nhyo/dsh-maa-cli/tree/cdeaa8fac12bdc1db5b4ea5c33fca358dc6cf43b) 逐字读取 `src/operators/depot.js`、`src/operators/operator-box.js`、`LICENSE`，再改写本仓库 `account-snapshot.ts`。保留 `DepotInfo/OperBoxInfo` 的字段识别与范围校验思路；不沿用完整扫描默认挑旧完成回调、强制未知数值存在、保存失败直接覆盖等行为。许可证全文和原版权见[第三方声明](../THIRD_PARTY_NOTICES.md)。

## MAA 图形界面版

固定 [v6.21.4，52d0b2acaca116585b02e1e6a9da303460f81a24](https://github.com/MaaAssistantArknights/MaaAssistantArknights/tree/52d0b2acaca116585b02e1e6a9da303460f81a24)。仅核对接口事实，未复制其 AGPL 源码或资源。表中指纹为该文件 Git blob SHA；后续版本跟踪工单可登记这些依赖，当前不宣称已自动核对所有 MAA 依赖。

| 依赖事实 | 上游文件 | 文件指纹 |
| --- | --- | --- |
| DepotInfo 的 done/data；data 可为 JSON 字符串；4001 是龙门币；模板错误回调 DepotTemplateLoadError | [DepotRecognitionTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Miscellaneous/DepotRecognitionTask.cpp) | ac98d02b0a57fca1fc75eed366ff0423f55fed60 |
| OperBoxInfo 的 done/own_opers 与 id/name/own/elite/level/potential/rarity；不含技能、专精、模组和基建布局 | [OperBoxRecognitionTask.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaCore/Task/Miscellaneous/OperBoxRecognitionTask.cpp) | 8d2bb62c89fb7e1afaee29ddeb744b98d0f3d7c9 |
| GUI 保存 done/data/syncTime 与 done/own_opers/source/syncTime；本地来源 local；空仓库识别不表示零库存 | [ToolboxViewModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/ToolboxViewModel.cs) | c5de1d401a8f3f7b76efb489a6d876a4a948a670 |
| 数据文件名 DepotData、OperBoxData | [JsonDataKey.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Constants/JsonDataKey.cs) | 5f7eb82f635053e3cd371cdec3d9667cde50ee18 |
| GUI 数据位于 BaseDir/data | [PathsHelper.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Helper/PathsHelper.cs) | 8383777c9bcc33f94dafc37dc0b6486ddc6e63c2 |

回调和缓存完成标志只能证明一次输出结束，无法证明图像识别完整覆盖所有事实。快照保留未知字段和来源时间，不推断未列物品为零；源文件自身没有账号对应关系，本工具也不猜测不同文件是否属于同一账号。用户应提供同一账号的结果。
