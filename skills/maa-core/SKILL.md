---
name: maa-core
description: maa_skills 的共享脚本和接口说明，由 maa-setup、maa-account、maa-daily、maa-doctor 调用，不直接处理用户请求。用户问该用哪个 MAA skill 或怎么安装时用 maa-help。
---

# maa-core

本目录不是操作入口。它存放 maa_skills 的共享脚本，每个脚本只有这一份实现；其他 maa skill 通过相邻目录 `../maa-core/scripts/` 调用。脚本需要 Node 24。

| 脚本 | 用途 | 接口说明 |
| --- | --- | --- |
| `scripts/preferences.ts` | 读写结构化设置（语言、私有目录、MAA 目录、服务器），追加偏好原话 | [偏好接口](references/preferences.md) |
| `scripts/maa-config.ts` | 读取白名单配置摘要，执行持锁配置事务 | 由 maa-daily 提供配置事务说明和用户授权 |
| `scripts/maa-process.ts` | 观察选定实例、正常关停与受限重开 | 由配置事务调用，不作为独立操作入口 |
| `scripts/doctor.ts` | 共用配置/锁检查、脱敏最近记录，按点名批准核对或恢复 | [检查与恢复接口](../maa-doctor/references/checks.md) |
| `scripts/account-snapshot.ts` | 读取 MAA 本地识别摘要，保存账号快照 | [账号导入接口](../maa-account/references/import.md) |
| `scripts/operator-cost.ts` | 按快照和明确目标只读查询单干员逐级培养成本 | [成本接口](../maa-account/references/cost.md) |
| `scripts/cultivation-gaps.ts` | 多目标共用库存，比较加工、材料券及券换投入后加工的缺口，只给建议 | [缺口接口](../maa-account/references/gaps.md) |
| `scripts/base-query.ts` | 只读查询已持有干员基建技能、解锁条件和交叉核对差异 | [基建查询接口](references/base-query.md) |
| `scripts/stage-jobs.ts` | 查询明确关卡的作业、逐成员核对，准备已批准的地图批次 | [关卡作业接口](../maa-daily/references/stage-jobs.md) |
| `scripts/training-time.ts`、`scripts/training-plan.ts` | 查询已授权目标的助手/时长，记录训练并逐阶段安排原生单次定时 | [训练接口](references/training.md) |

调用方的约定：

- 调用前读对应的接口说明，只通过脚本读写，不直接改它管理的文件。
- 用户的文本作为数据经标准输入传给脚本，不拼进命令行。
- 偏好不能授权源石、抽卡、礼包、付费、登录或设备操作。
- 本目录要和调用它的 skill 来自同一个版本。更新时所有 maa skill 一起重装，见 maa-help 的宿主说明。
