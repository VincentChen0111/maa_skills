# maa_skills

MAA skills for Arknights CN on Windows, designed for Codex and Claude Code. Work in progress; no playable automation is shipped yet.

面向 Windows MAA 图形界面版、国服玩家的 skill 集合。规划包含 setup、account、daily、doctor、help，产品边界见[规格](docs/spec.md)。当前 maa-help 只提供文字帮助，maa-account 提供 MAA 本地识别结果的账号快照导入、逐级培养成本、共享库存下加工与材料券缺口比较，以及已持有干员基建技能查询；maa-daily 维护已有队列、提醒与定时，06 候选 maa-doctor 核对配置和遗留锁，经点名批准恢复已记录字段。共享脚本集中在 maa-core，其余功能按[工单索引](docs/issues/INDEX.md)实施。原生安装与模型状态分别见 [help](docs/help-verification.md)、[account](docs/account-verification.md)、[成本](docs/operator-cost-verification.md)、[加工缺口](docs/crafting-verification.md)、[基建](docs/base-verification.md)、[daily](docs/daily-verification.md)和 [doctor](docs/doctor-verification.md)验证记录。真实模型基线仍是发布门禁，离线测试或源码检查不代表实机已核。

需要 Node 24。在干净检出运行 `node scripts/check.ts` 即可离线检查，不必安装依赖。开发、类型检查和 PR 流程见[贡献指南](CONTRIBUTING.md)，原生安装结构见[宿主说明](docs/hosts.md)。问题通过 [Issues](https://github.com/VincentChen0111/maa_skills/issues)报告，修改通过 PR 和 squash 交付。

双宿主运行器、离线评分样例与固定版本比较见[行为评测](docs/evaluation.md)。本机缺少隔离认证或宿主的项目标记为未验证，不代表模型基线已通过。

## 致谢

- [MAA](https://github.com/MaaAssistantArknights/MaaAssistantArknights)：图形界面版及其识别、任务和定时机制。
- [dsh-maa-cli](https://github.com/nhyo/dsh-maa-cli)：结构化失败分类、作业匹配和假 MAA 进程测试思路。
- [arknights-base-skill](https://github.com/KayChung17/arknights-base-skill)：基建技能与排班参考。
- [MAA-PRTS](https://github.com/OriginiumLab/MAA-PRTS)：森空岛账号读取与作业匹配参考。
- [企鹅物流](https://penguin-stats.io/)与[明日方舟一图流](https://ark.yituliu.cn/)：数据来源；数据不随本仓库打包。

借用代码的许可、版权行及固定提交登记在[第三方声明](THIRD_PARTY_NOTICES.md)。本项目采用 [MIT](LICENSE)。

## 免责声明

- 本项目为非官方项目，与鹰角网络和 MAA 无关。
- 自动化可能违反游戏用户协议，账号风险自负。
- 自行修改（尤其是去掉安全限制）的后果自负。
- 不对任何账号、资源或数据损失负责；MIT 的不担保条款照常适用。
