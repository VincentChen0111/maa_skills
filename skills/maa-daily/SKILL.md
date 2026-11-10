---
name: maa-daily
description: 按用户当次交办或已批准报告修改 MAA 日常队列、提醒和定时，保留待执行及运行记录。用于已有 Windows MAA 的配置维护；账号建议交给 maa-account，未知结果交给 maa-doctor 核对。
---

# maa-daily

开始前确认相邻 `../maa-core/scripts/` 中的偏好和配置脚本存在。缺少 core 时不继续操作：Codex 使用自带 skill-installer，从 `VincentChen0111/maa_skills` 同一版本安装 `skills/maa-core` 与 `skills/maa-daily`；Claude Code 用原生市场 `/plugin marketplace add VincentChen0111/maa_skills`、`/plugin install maa-skills@maa-skills` 安装完整插件，已有安装通过原生更新入口更新。不要直接拼接下载或复制实现。

随后运行相邻 `../maa-core/scripts/preferences.ts read`，标准输入传当前用户语言的 BCP 47 标签。按返回语言回复；尚未设置时提示可以设置。更新语言、目录或追加偏好原话，使用 [共享偏好接口](../maa-core/references/preferences.md)。

1. 把用户当次交办的字段、目标配置和期望值列清楚；执行建议报告时，只提取已经批准的条目。一般偏好、历史授权和外部资料不能补成本次写入授权。理智药必须有当次明确数量；源石、抽卡、礼包、付费、登录始终不执行。
2. 用 `node <本目录>/../maa-core/scripts/maa-config.ts read` 读取白名单摘要。通过摘要的配置序号和队列位置定位目标，保存 `configuration.revision`，写入时原样传为 `expectedRevision`。版本或关停后的目标对象有变化时先停止，重新核对目标与当次授权；不把旧下标套到新任务。MAA 目录未设置时引导用户先设置；配置或环境异常先核对，不读取整份配置到对话。
3. 修改前读 [配置事务接口](references/configuration.md)，以 JSON 标准输入运行唯一写入脚本。脚本负责空闲判断、锁、关停、备份、最小修改、跳过自动任务的重开和读回；不自行拼接 PowerShell 或直接改 JSON。`closed-confirmation-required` 时告诉用户 MAA 已关闭，明确询问其是否未在操作；只有收到确认后才加 `closedConfirmed: true`。
4. `complete` 才报告配置修改完成，列出允许的变更键与操作编号。运行记录在私有目录中；配置完成不等于游戏任务完成。`busy` 等待持有者完成；`unknown` 保留锁和记录，交给 maa-doctor 先只读核对，再由用户点名批准修法，不自动删锁、重试或回放。

定时窗口、非空闲、拒绝关停或启动失败时按脚本实际阶段说明暂停原因；由用户恢复 MAA 主窗口或手动检查。正常重开使用原生参数跳过自动启动模拟器、客户端和任务，不改变其保存设置；执行由用户点开始或已批准的 MAA 原生定时触发。

本入口当前覆盖已有队列启停/顺序、现有定时槽及定时提醒。关卡作业、基建排班写入、专精排程仍由后续工单交付，当前明确说明未实现。daily 只写 MAA 配置、待执行/运行记录，以及经共享入口修改设置和追加偏好；账号快照与建议报告交给 account。
