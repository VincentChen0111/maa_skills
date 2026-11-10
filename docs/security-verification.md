# GitHub 配置核实

核实日期：2026-11-10。仓库：`VincentChen0111/maa_skills`。通过已登录的 GitHub 设置页只读核实，没有更改配置。

| 项目 | 观察结果 | 来源 |
| --- | --- | --- |
| Secret Protection | 已启用，显示 Disable 按钮 | [Advanced Security](https://github.com/VincentChen0111/maa_skills/settings/security_analysis) |
| Push protection | 已选中 | 同上 |
| 默认分支保护 | protect-main 为 Active；目标为默认分支；无绕过名单 | [规则 26913922](https://github.com/VincentChen0111/maa_skills/settings/rules/26913922) |
| PR、删除和强推 | Require a pull request before merging、Restrict deletions、Block force pushes 均选中 | 同上 |
| 必需状态检查 | 尚未启用；本包不修改保护规则，交付前主动等待 CI 成功 | 同上 |
| 默认分支、Issues | 默认分支 main；Issues 启用 | [General](https://github.com/VincentChen0111/maa_skills/settings) |
| 合并方式 | 仅 squash 启用；merge commit 和 rebase 未启用 | 同上 |

这是当日观察记录，不是永久保证。GitHub 连接器返回只读权限，未暴露安全配置，不能据此推断未启用；以上结果来自设置页。重新核实时读取相同项目，并记录日期与实际状态；不要存储账号会话、凭据或整页私人信息。

工单元数据：同日核对 [Labels](https://github.com/VincentChen0111/maa_skills/labels)，保留既有 `ready-for-agent`、`wontfix`，补建缺少的 `needs-triage`、`needs-info`、`ready-for-human`。五种 triage 标签齐备；没有把实施完成状态改写为 triage 标签。
