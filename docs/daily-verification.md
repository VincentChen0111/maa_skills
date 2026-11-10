# daily 验证记录

工单 05 的候选实现，交付在 [草稿 PR #35](https://github.com/VincentChen0111/maa_skills/pull/35)；当前仍进行中，不宣称真实模型基线或实机通过。

## 起点和来源

维护者原有 maa-daily 的通用关停、备份、最小修改、重开及白名单读回流程是起点。重新实现事务工具，未移入个人路径、账号数据、默认队列或私人授权，未修改原安装。原起点的私人保留项与较长定时缓冲不作为通用规则。

MAA 固定在官方 v6.21.4，提交 `52d0b2acaca116585b02e1e6a9da303460f81a24`；以下仅核对字段和行为，不复制或打包 MAA 代码。MAA 为 AGPL，原代码只下载到被忽略的临时目录：

- [Timer.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Global/Timer.cs) 与 [TimerSettings.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Global/TimerSettings.cs)：定时字段、八槽由 GUI 使用，null 表示单次。
- [TaskQueueViewModel.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/ViewModels/UI/TaskQueueViewModel.cs#L1080)：本机本地时间；定时前两分钟配置切换，午夜跨日；触发后 null 置为 false。
- [FightTask.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/MaaTask/FightTask.cs) 与 [AwardTask.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Configuration/Single/MaaTask/AwardTask.cs)：药剂、源石、免费抽卡与特殊礼包字段，按类型白名单独立实现。
- [Bootstrapper.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Bootstrapper.cs#L525) 与 [AsstProxy.cs](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/52d0b2acaca116585b02e1e6a9da303460f81a24/src/MaaWpfGui/Main/AsstProxy.cs#L757)：原生参数跳过自动连接目标启动与 LinkStart，避免维护后自动开任务；不修改保存设置。

这不是完整 MAA 版本的「源码已核」认证；依赖清单和自动指纹跟踪仍由 25 交付。其它版本可检查，但未核字段和进程状态不能猜测为安全。

## 测试与未验证项

在 CLI/导出函数接缝先看到失败，再实现：配置最小改动、并发锁、遗留锁、药剂数量、队列重排、定时全窗口/午夜、失败阶段与记录、公开输出脱敏。进程边界用真实临时 Node 进程和由合成 C# 源码编译的临时 Windows GUI；不启动真实 MAA 或设备。

2026-11-11 修复第三轮已知问题后，完整离线入口 70 项：69 通过、1 项非 Windows 专用测试跳过；类型、隐私、元数据与工单检查通过。含从真实临时设置，经 CLI 到原生 PowerShell 关停/启动合成 Windows GUI 的全链验证，以及版本/目标及依赖绑定、重开后依赖读回、重复任务排序、药剂整数范围和跨配置总量/触发次数、夏令时回拨前两分钟和重复触发时刻的校验。两宿主真实 installer 证据仍待填写，产品独立审查最终未通过，见下节。

模型尝试固定 Codex 0.167.0-alpha.3.2 / gpt-6、Claude Code 2.1.322 / claude-sonnet-4-6。初次六项均因隔离认证缺失为 unverified；当时并行编辑共享载荷，整体指纹不一致，比较器正确判为 incomparable，该批不用于基线比较。后续评测先冻结待测 skill 和 companion 副本，避免运行中源文件变化。原始证据只保存在被忽略的本机临时目录。

冻结后的六项指纹均为 `9613f4b398cbbe69e4d5bfc31d6a78ff31a88c01eb8e0f4610739b3ac3970626`，每项仍为 unverified，比较器结果为 unverified。没有通过分数，不能据此声称改动后模型行为无回归。两个原生目录各保留本仓库 MIT 全文。

第一轮审查修复后，另冻结载荷并按相同三场景、模型、宿主和评分器运行六次；载荷指纹一致为 `b84318e4bfce1d3d20a4336ec64f6da9f68f70b040c527943be6ae28b409d9aa`。前后 scenarioHash 一致，六项仍全部因隔离认证缺失为 unverified，前后比较也是 unverified。未产生 pass→fail，不能将认证失败写成模型回归通过。

第二轮修复后同样冻结重跑六次，载荷指纹 `3f6dee1a2876b3284769f487f647c2366c5359cbe66c051f85dec606d42b72d9`，前后场景指纹一致，仍全部 unverified；本批发生于第三轮审查修复前，不冒充最终载荷证据。

第三轮已知问题修复后、core 迁移前，六次固定场景仍全部 unverified，载荷指纹一致为 `19cb1f3f48366a1ccb49399d8e14357b5fd708a2410c2955782270343165ae94`。原始批次分别保留，不覆盖先前证据。

产品包已完成三轮独立审查，最终仍未通过，见 [审查与处置](reviews/2026-11-11-05-daily.md)。第三轮的两项已知错误已按失败测试修复，但未经追加独立审查；达到三轮上限后保持草稿，不自行将作者测试改记为审查通过，05 下游不解锁。

两宿主新 skill 模型基线未通过前，05 不记完成；当前三个只读/拒绝场景不能替代正向写入、关闭确认及失败处理的模型验收。动态操作编号与记录时间的授权断言、合成进程场景安装仍待评测框架补齐。真实 MAA 与设备未运行。

## 原生安装与 core 集成

在迁移前的公开固定提交 `23bebaeab946f4d9b48ab0b50c98dba022c972d3`，官方 Codex installer 的首次安装、已有目录拒绝及临时目录内重装通过；Claude Code 2.1.322 的市场安装、市场更新和同版本插件更新入口通过，安装记录 SHA 与固定提交一致。两宿主 help/daily 各 11 个文件逐字节 hash 相同，MIT 全文齐全；实际安装载荷执行 read→expectedRevision→write，验证原值保留、备份、锁释放、合成 GUI ready 与正常关停。23 个主命令中 22 个退出 0，唯一退出 1 是预期的已有目录拒绝。使用 Node 24.22.1、Python 3.12.14，全在新的临时 home 内，不代表跨版本升级、模型基线或产品审查通过。

随后主分支 PR #34 将共享脚本改放 maa-core，并修订 help 为纯文字。05 合并该主分支，保留新的偏好锁、建议报告单轮审查、专精规则及发布依赖；配置和进程脚本原样迁至 maa-core，daily 和场景按同版本相邻 core 调用。新路径测试先失败再迁移。旧安装和模型证据只证明迁移前提交；迁移后的安装及评测需重新核对，不能沿用旧结果。集成包审查范围与产品未通过状态见 [core 集成记录](reviews/2026-11-11-05-core-integration.md)。

core 集成后完整离线入口 75 项：74 通过、1 项平台条件跳过；类型、隐私、元数据、tracker 通过。固定原三场景与两宿主再运行六次，载荷指纹一致为 `d22306045b35396424bbfcb232cae5244dfb803f85afeaada074fa2912f3e0c5`，仍全部 unverified。预期调用路径已变为 core，场景指纹也随之改变，不将跨迁移结果宣称为同场景回归通过。迁移后原生安装待补。
