# maa_skills

MAA skills for Arknights CN on Windows, designed for Codex and Claude Code. Work in progress; no playable automation is shipped yet.

面向 Windows MAA 图形界面版、国服玩家的 skill 集合，产品边界见[规格](docs/spec.md)。maa-help 只提供文字帮助；maa-account 提供本地识别快照、[森空岛只读账号快照](docs/skland-account.md)、培养成本、加工与材料券缺口、已持有干员基建技能查询，带作者、日期和出处的 NGA 只读资料检索和 B 站视频读取（实验性），以及按玩法优先级、默认经独立审查并逐项批准的培养建议报告；用你自己设置的森空岛 token 只读读取你给出链接的森空岛社区帖子；maa-daily 维护已有队列、提醒与定时；maa-doctor 检查安装、连接、配置（含远程控制）、写入锁、凭据状态、私有文件、skill 版本和目录联接，读 MAA 日志判断运行失败的原因，MAA 自身问题给官方入口和脱敏摘要，经点名批准核对遗留锁或恢复已记录字段。07 候选 maa-setup 接入已有环境、设置语言和私有目录、发现并测试本机 adb、经统一写入器保存连接；当前不下载程序。NGA、森空岛账号和实验性 B 站的凭据由你在自己的终端运行脚本输入，agent 只检查状态，见[凭据说明](docs/credentials.md)（含森空岛粘贴 token 前的知情说明）。共享脚本集中在 maa-core，其余功能按[工单索引](docs/issues/INDEX.md)实施。原生安装与模型状态分别见 [setup](docs/setup-verification.md)、[help](docs/help-verification.md)、[account](docs/account-verification.md)、[成本](docs/operator-cost-verification.md)、[加工缺口](docs/crafting-verification.md)、[基建](docs/base-verification.md)、[daily](docs/daily-verification.md)、[doctor](docs/doctor-verification.md)、[凭据](docs/credentials-verification.md)、[森空岛快照](docs/skland-account-verification.md)、[NGA](docs/nga-verification.md)、[森空岛社区与 B 站](docs/community-verification.md)和[培养报告](docs/cultivation-report-verification.md)验证记录。真实模型基线仍是发布门禁，离线测试或源码检查不代表实机已核。

需要 Node 24。在干净检出运行 `node scripts/check.ts` 即可离线检查，不必安装依赖。开发、类型检查和 PR 流程见[贡献指南](CONTRIBUTING.md)，原生安装结构见[宿主说明](docs/hosts.md)。问题通过 [Issues](https://github.com/VincentChen0111/maa_skills/issues)报告，修改通过 PR 和 squash 交付。

双宿主运行器、离线评分样例与固定版本比较见[行为评测](docs/evaluation.md)。本机缺少隔离认证或宿主的项目标记为未验证，不代表模型基线已通过。

## 致谢

- [MAA](https://github.com/MaaAssistantArknights/MaaAssistantArknights)：图形界面版及其识别、任务和定时机制。
- [dsh-maa-cli](https://github.com/nhyo/dsh-maa-cli)：结构化失败分类、作业匹配和假 MAA 进程测试思路。
- [arknights-base-skill](https://github.com/KayChung17/arknights-base-skill)：基建技能与排班参考。
- [MAA-PRTS](https://github.com/OriginiumLab/MAA-PRTS)：森空岛账号读取与作业匹配参考。
- [nonebot-plugin-skland](https://github.com/FrostN0v0/nonebot-plugin-skland) 与 [arknights-toolbox](https://github.com/arkntools/arknights-toolbox)：森空岛鉴权链、签名、刷新和字段的核对参考。
- [企鹅物流](https://penguin-stats.io/)与[明日方舟一图流](https://ark.yituliu.cn/)：数据来源；数据不随本仓库打包。

借用代码的许可、版权行及固定提交登记在[第三方声明](THIRD_PARTY_NOTICES.md)。本项目采用 [MIT](LICENSE)。

## 免责声明

- 本项目为非官方项目，与鹰角网络和 MAA 无关。
- 自动化可能违反游戏用户协议，账号风险自负。
- 自行修改（尤其是去掉安全限制）的后果自负。
- 不对任何账号、资源或数据损失负责；MIT 的不担保条款照常适用。
