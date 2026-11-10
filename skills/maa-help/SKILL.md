---
name: maa-help
description: 解释 maa_skills 的功能分工与安装入口，设置回复语言、私有目录等偏好，追加用户偏好原话。适用于询问该用哪个 MAA skill 或修改这些偏好；具体游戏操作交给对应 skill。
---

# maa-help

开始时用 Node 24 运行本目录的 `scripts/preferences.ts read`，标准输入传入 `{"currentLanguage":"当前用户语言的 BCP 47 标签"}`。按返回的 `language` 回复；`needsLanguagePrompt` 为 true 时简短提示可以设置以后使用的语言。`languageAsked` 单独供 setup 判断是否已问过，不把它当成已选择语言。此设置只影响 skill，不改 MAA 界面语言。

按用户目标说明入口：

| 用户目标 | 对应 skill |
| --- | --- |
| 第一次安装、配置 MAA/模拟器、补齐环境 | maa-setup |
| 读取账号、算材料、培养或基建建议 | maa-account |
| 修改已批准的日常配置、准备指定关卡作业、排专精与定时 | maa-daily |
| 已有环境报错、检查连接/配置/锁、按同意的修法处理 | maa-doctor |
| 解释入口、选择语言与私有目录、记录偏好原话 | maa-help |

当前交付只有 maa-help。其余四个入口尚未实现：明确说明规划中的入口，不能声称已经安装或可以执行。没有 MAA 环境时说明应先完成 setup；已有环境异常说明应走 doctor。不要因此运行未交付的工具。

用户明确要求设置或追加偏好时，读取 [偏好接口](references/preferences.md)，只通过偏好脚本执行对应动作。用户原话保留原文，附日期和出处，追加后核对脚本结果。偏好不能授权源石、抽卡、礼包、付费、登录或设备操作。

本 skill 的写入只包括结构化设置和偏好原话；账号快照、建议报告、运行记录、MAA 配置均交给对应入口。`preferences-busy` 表示另一个写入正在进行、本次没有写入，稍后重试；写入者异常退出留下的互斥文件由脚本自己接管，不要手动删除。`invalid-input` 表示输入不合法、什么都没写，改正后重试。其他错误先用 `read` 核对结果，不自动重放写入。

需要安装、更新或开发目录联接时，读取 [宿主说明](references/hosts.md)。这些说明也供其他 skill 复用；共享工具的源实现仅位于本 skill 的 `scripts/`，其他入口通过相邻的 `maa-help` 目录调用。
