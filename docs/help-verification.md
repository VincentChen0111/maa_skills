# maa-help 验证记录

2026-11-11 补记：共享偏好脚本已从 `maa-help` 移到 `skills/maa-core/`，`maa-help` 改为只提供文字帮助。下文是移动之前的验证记录，其中的路径和场景名（`help-language`、`help-append`）对应当时的结构；移动后的 core/help/account 已从公开固定提交 `24b7ebb0a4a9a57095ee7f5a44fe1338edfa2fea` 完成临时双宿主原生安装和同版更新入口核对，见 [account 集成验收](account-verification.md)。help 更新可用入口说明前后按 `help-routing`、`help-preference`、`help-boundary` 在固定 Codex `0.167.0-alpha.3.2` / `gpt-6` 与 Claude Code `2.1.322` / `claude-sonnet-4-6` 各运行六次；12 次均因隔离认证缺失而 unverified，执行窗口和证据哈希已核对，模型基线仍未建立。help 前后载荷指纹分别为 `655a2645d71f18673a62052223a9059d0de7b36496b9393aade2e6f32605c478` 与 `bb494afef0a281fef1f2829641f001d8648a616efc7b8ebc0d8e219802df2484`。

日期：2026-11-10。工单 04 实现交付完成；真实模型基线仍未验证，作为 [26 发布门禁](issues/26-v0-1-0-release-validation.md)保留。本次收口用于解除实现依赖，不代表发布验收完成。

## 离线行为

- 全部离线测试 28/28、类型检查、七类规则自检和隐私检查通过。
- 语言设置及原话追加先写公开 CLI 失败测试，再实现。未知设置拒绝；已有设置字段和旧原话保持不变；摘要不回显原话或本机路径。
- 真实并发更新先复现丢字段，加入写入互斥后通过；Windows 只读目标导致原子替换失败时，旧文件字节保持不变且临时文件与互斥文件已清理。
- 两个临时原生目录布局各执行同一偏好脚本，实际文件变化符合语言场景授权；这只是目录布局与脚本验证，不能替代宿主模型调用。
- Windows 真实目录联接执行和标准输入导入导出函数均已验证；两项入口回归先失败后修正。
- 远程 Windows CI 另暴露短路径入口空跑。真实 8.3 路径回归先失败，双方路径规范化后通过；在该短路径环境运行完整离线入口也为 28/28。安装测试同时核对实际响应和退出码。
- 短路径修正后的 Windows CI 已跑通 28 项测试，随后隐私检查发现测试子进程的 PowerShell 缓存外溢到检出目录。缓存现显式限定在 fixture，独立 CI 修正审查和本机完整复测通过，见[缓存隔离记录](reviews/2026-11-10-ci-powershell-cache.md)；最终远程状态见 [PR 检查](https://github.com/VincentChen0111/maa_skills/pull/32/checks)。
- 评测的 Node 观察器记录临时原生目录中脚本的实际调用及退出码；语言场景同时要求 read、set、append 成功及预期文件变化。直接写对文件但未调用偏好脚本的反例判为失败。
- 原生 skill-creator 校验器通过。校验器缺少的 PyYAML 仅装在被忽略的临时依赖目录；没有修改正常 Python、已安装 skill 或用户环境。

## 模型基线尝试

场景定义见 [maa-help 场景](../eval/maa-help/scenarios.ts)，均为合成数据。固定模型参数：Codex `gpt-6`，Claude `claude-sonnet-4-6`；后者可用性未验证。

| 场景 | Codex CLI 0.167.0-alpha.3.2 | Claude CLI 2.1.322 |
| --- | --- | --- |
| help-language | 未验证：隔离认证为空，401 | 未验证：隔离认证为空，未登录 |
| help-append | 未验证：隔离认证为空，401 | 未验证：隔离认证为空，未登录 |
| help-boundary | 未验证：隔离认证为空，401 | 未验证：隔离认证为空，未登录 |

首次尝试时 Claude CLI 不可用；随后按 [Claude 官方安装说明](https://code.claude.com/docs/en/setup#install-with-npm)，将官方 npm 包固定为 2.1.322，仅下载到被忽略的临时目录。用这两个固定 CLI 对修正后的同一候选再次执行三个场景，Claude 正确发现待测 skill，但返回 `Not logged in`；Codex 均返回 401。

短路径修正前后又以同一双宿主版本、模型参数和三个场景分别尝试，六项仍全部因上述认证问题未验证，前后比较器同样返回 `unverified`。没有建立通过的产品基线。原始前后尝试、版本摘要与观察器版本均保留在本机忽略目录，不公开账号相关路径或服务连接信息。没有把脚本测试当作 skill 模型评测；没有声称改动前后分数已验证。阻塞只剩隔离的模型认证；未读取或复制正常用户账号凭据。

## 原生安装

Codex 原生 skill-installer 已从固定提交 `1bc3f8ca98e970dd064d494aed14d82216b46e22`、路径 `skills/maa-help` 安装到新建的临时 home。该临时安装只含 maa-help；重复安装正确拒绝覆盖（退出码 1），核实目标位于临时根目录后移除这份临时安装并重新安装成功。独立执行 `set`、`read`、`append` 均成功，语言切为 en，原话记录追加。没有依赖 clone 的相邻工具或另一份安装，正常用户安装未改动。

Claude CLI 2.1.322 在全新隔离 home 中，通过原生 `plugin marketplace add` 添加候选分支、`plugin install` 安装 maa-skills。原生市场刷新和插件更新命令成功，更新结果为当前版本已最新；未模拟跨版本升级。实际缓存中的偏好脚本与上述提交一致，并独立执行 `set`、`read`、`append` 成功。

两种原生安装载荷及更新入口已验证；模型驱动的 help 响应、路由及边界行为仍须通过上述真模型基线。离线实现经三轮[独立审查](reviews/2026-11-10-04-help.md)通过，最终实现提交 `538c8ae` 的 Windows/Linux CI 均通过。交付为 [PR #32](https://github.com/VincentChen0111/maa_skills/pull/32)。2026-11-10 维护者要求完成 04 并继续并行实施，本次将未验证的模型项目明确移交 26；[收口审查](reviews/2026-11-10-04-closeout.md)仅审查此交付安排，不重开产品实现的第四轮审查。

## 2026-11-11 已交付能力说明维护

本维护包承接 [13](issues/13-operator-cost-query.md) 登记的 help 说明更新，以包含 13、21 的 main 提交 `370ed68809ca12c920fd25054276c797157a4749` 为基点。按实际[账号导入接口](../skills/maa-account/references/import.md)、[单干员成本接口](../skills/maa-account/references/cost.md)和[基建技能查询接口](../skills/maa-core/references/base-query.md)，明确本地账号快照、单干员原始成本/不加工已知库存差额及基建技能查询已交付；森空岛、培养/基建排班建议、加工及凭证缺口决策仍未交付。偏好路由改指已交付的 maa-account。help 继续只用文字回答，不读设置、不运行脚本、不写文件；05 尚未合入，daily 仍列为规划入口。本包不增加产品限制或脚本行为，也不修改 account/core 实现。

13 合入前曾冻结 help 并调用原三场景 × 两宿主六次，全部 unverified。13 的网络评测支持改变了运行器与场景指纹，因此保留旧批，只将其作为历史记录。在合入后的最终框架、help 未修改时重新冻结并运行六次 before，完成后才修改 help，再冻结最终载荷运行六次 after；场景保持 `help-routing`、`help-preference`、`help-boundary`，未新增场景。

两批固定 Codex CLI `0.167.0-alpha.3.2` / `gpt-6`，Claude Code `2.1.322` / `claude-sonnet-4-6`。每项宿主版本、模型、场景指纹逐一相同；框架指纹为 `1366d00f89b78f0b14f57dfad9a57423f63463287619ba3d3a90aec9fc850fcd`。改前载荷指纹 `bb494afef0a281fef1f2829641f001d8648a616efc7b8ebc0d8e219802df2484`，改后为 `e095a3890b9574ed02e725b639aa7ed295707170c3550bc300d1c2768c46a19a`。十二次调用全部结束：Codex 隔离认证返回 401，Claude 未登录，均为 unverified；比较器同样 unverified，没有可用于判定分数不下降的通过分数。所有运行使用新的临时 home，未复制用户认证。原始调用、逐文件 hash、执行窗口和重算一致的 evidenceHash 留在本机忽略目录。

作者完整离线入口 88/88、类型检查、tracker、隐私、metadata、评分自检和 diff 检查通过；逐文件人工检查未引入私人数据。现有纯文字布局检查和三场景仍保留；这些离线检查不证明能力表述的模型语义已通过。本包独立审查、最终远程固定版本的原生安装及 CI 尚待完成，不借用旧 help 或 13 载荷的通过记录，真实模型语义和分数不下降仍为发布未验证项。
