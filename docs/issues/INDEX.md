# maa_skills 工单索引

本批 26 票由维护者于 2026-11-10 批准，来源为 [规格](../spec.md)。本地 Markdown 是实现工单记录，GitHub Issues 是本批发布的镜像；已逐票互链。更新状态时同步两边，实施从阻塞项全部完成的票开始。

所有票初始 triage 状态为 `ready-for-agent`；实施进度单独记录在各票正文，表示完成情况。编号为本地工单号，不是 GitHub Issue 号。

## 工单与依赖

<!-- tracker:start -->

当前已完成：01、02。当前可开始：03。

| 本地票 | 标题 | GitHub Issue | 阻塞项 | 实施进度 |
| --- | --- | --- | --- | --- |
| 01 | [修正三项规则来源](01-spec-rule-provenance.md) | [#3](https://github.com/VincentChen0111/maa_skills/issues/3) | 无 | 已完成 |
| 02 | [仓库开发与公开检查闭环](02-repository-workflow.md) | [#4](https://github.com/VincentChen0111/maa_skills/issues/4) | 01 | 已完成 |
| 03 | [双宿主行为评测](03-cross-host-evaluation.md) | [#5](https://github.com/VincentChen0111/maa_skills/issues/5) | 02 | 未开始 |
| 04 | [可安装的 help 与偏好设置](04-install-help-preferences.md) | [#6](https://github.com/VincentChen0111/maa_skills/issues/6) | 03 | 未开始 |
| 05 | [daily 安全修改配置](05-daily-safe-config-write.md) | [#7](https://github.com/VincentChen0111/maa_skills/issues/7) | 04 | 未开始 |
| 06 | [doctor 核对并恢复遗留写入](06-doctor-lock-recovery.md) | [#8](https://github.com/VincentChen0111/maa_skills/issues/8) | 05 | 未开始 |
| 07 | [setup 接入现有环境](07-setup-existing-environment.md) | [#9](https://github.com/VincentChen0111/maa_skills/issues/9) | 06 | 未开始 |
| 08 | [setup 下载并补齐环境](08-setup-program-downloads.md) | [#10](https://github.com/VincentChen0111/maa_skills/issues/10) | 07 | 未开始 |
| 09 | [用户手动设置凭据](09-manual-credentials.md) | [#11](https://github.com/VincentChen0111/maa_skills/issues/11) | 07 | 未开始 |
| 10 | [doctor 完整检查与转介](10-doctor-checks-referral.md) | [#12](https://github.com/VincentChen0111/maa_skills/issues/12) | 09 | 未开始 |
| 11 | [MAA 识别结果转账号快照](11-maa-account-snapshot.md) | [#13](https://github.com/VincentChen0111/maa_skills/issues/13) | 04 | 未开始 |
| 12 | [森空岛账号快照](12-skland-account-snapshot.md) | [#14](https://github.com/VincentChen0111/maa_skills/issues/14) | 09、11 | 未开始 |
| 13 | [单干员培养成本查询](13-operator-cost-query.md) | [#15](https://github.com/VincentChen0111/maa_skills/issues/15) | 11 | 未开始 |
| 14 | [加工与材料凭证后的缺口](14-crafting-voucher-gaps.md) | [#16](https://github.com/VincentChen0111/maa_skills/issues/16) | 13 | 未开始 |
| 15 | [指定关卡作业准备](15-stage-job-preparation.md) | [#17](https://github.com/VincentChen0111/maa_skills/issues/17) | 05、11 | 未开始 |
| 16 | [跟踪关卡运行结果](16-stage-run-tracking.md) | [#18](https://github.com/VincentChen0111/maa_skills/issues/18) | 06、15 | 未开始 |
| 17 | [批准范围内切换备选作业](17-approved-alternate-jobs.md) | [#19](https://github.com/VincentChen0111/maa_skills/issues/19) | 16 | 未开始 |
| 18 | [NGA 调研闭环](18-nga-research.md) | [#20](https://github.com/VincentChen0111/maa_skills/issues/20) | 09 | 未开始 |
| 19 | [森空岛社区与 B 站调研](19-community-bilibili-research.md) | [#21](https://github.com/VincentChen0111/maa_skills/issues/21) | 09 | 未开始 |
| 20 | [带独立审查的培养建议](20-reviewed-cultivation-report.md) | [#22](https://github.com/VincentChen0111/maa_skills/issues/22) | 14、18 | 未开始 |
| 21 | [基建技能查询](21-base-skill-query.md) | [#23](https://github.com/VincentChen0111/maa_skills/issues/23) | 11 | 未开始 |
| 22 | [基建建议与排班生成](22-base-report-and-plan.md) | [#24](https://github.com/VincentChen0111/maa_skills/issues/24) | 20、21 | 未开始 |
| 23 | [执行已批准的基建排班](23-apply-approved-base-plan.md) | [#25](https://github.com/VincentChen0111/maa_skills/issues/25) | 05、22 | 未开始 |
| 24 | [专精助手与单次定时](24-mastery-training-schedule.md) | [#26](https://github.com/VincentChen0111/maa_skills/issues/26) | 05、14、21 | 未开始 |
| 25 | [MAA 版本核对与升级提醒](25-maa-version-verification.md) | [#27](https://github.com/VincentChen0111/maa_skills/issues/27) | 10 | 未开始 |
| 26 | [v0.1.0 发布验收](26-v0-1-0-release-validation.md) | [#28](https://github.com/VincentChen0111/maa_skills/issues/28) | 08、12、17、19、23、24、25 | 未开始 |

<!-- tracker:end -->

26 条 GitHub Issues 均标记为 ready-for-agent；39 条直接依赖已设置为 GitHub 原生阻塞关系，以上表中的本地票号对应。

## 用户故事覆盖

下表表示对应工单负责该故事的全部或部分验收；跨票故事在 26 的发布验收中核对完整交接。

| 用户故事 | 负责工单 |
| --- | --- |
| 1 | [07](07-setup-existing-environment.md)、[08](08-setup-program-downloads.md) |
| 2 | [07](07-setup-existing-environment.md)、[08](08-setup-program-downloads.md) |
| 3 | [08](08-setup-program-downloads.md) |
| 4 | [08](08-setup-program-downloads.md) |
| 5 | [07](07-setup-existing-environment.md) |
| 6 | [09](09-manual-credentials.md) |
| 7 | [04](04-install-help-preferences.md)、[07](07-setup-existing-environment.md) |
| 8 | [04](04-install-help-preferences.md)、[07](07-setup-existing-environment.md) |
| 9 | [07](07-setup-existing-environment.md) |
| 10 | [09](09-manual-credentials.md)、[19](19-community-bilibili-research.md) |
| 11 | [04](04-install-help-preferences.md)、[26](26-v0-1-0-release-validation.md) |
| 12 | [04](04-install-help-preferences.md)、[26](26-v0-1-0-release-validation.md) |
| 13 | [04](04-install-help-preferences.md)、[26](26-v0-1-0-release-validation.md) |
| 14 | [11](11-maa-account-snapshot.md) |
| 15 | [12](12-skland-account-snapshot.md) |
| 16 | [11](11-maa-account-snapshot.md)、[12](12-skland-account-snapshot.md) |
| 17 | [13](13-operator-cost-query.md) |
| 18 | [14](14-crafting-voucher-gaps.md) |
| 19 | [14](14-crafting-voucher-gaps.md) |
| 20 | [20](20-reviewed-cultivation-report.md) |
| 21 | [18](18-nga-research.md)、[19](19-community-bilibili-research.md)、[20](20-reviewed-cultivation-report.md) |
| 22 | [21](21-base-skill-query.md)、[22](22-base-report-and-plan.md) |
| 23 | [20](20-reviewed-cultivation-report.md)、[22](22-base-report-and-plan.md) |
| 24 | [20](20-reviewed-cultivation-report.md)、[22](22-base-report-and-plan.md) |
| 25 | [13](13-operator-cost-query.md)、[18](18-nga-research.md)、[19](19-community-bilibili-research.md)、[20](20-reviewed-cultivation-report.md)、[22](22-base-report-and-plan.md) |
| 26 | [13](13-operator-cost-query.md)、[20](20-reviewed-cultivation-report.md)、[22](22-base-report-and-plan.md) |
| 27 | [05](05-daily-safe-config-write.md)、[23](23-apply-approved-base-plan.md) |
| 28 | [05](05-daily-safe-config-write.md) |
| 29 | [05](05-daily-safe-config-write.md) |
| 30 | [05](05-daily-safe-config-write.md) |
| 31 | [05](05-daily-safe-config-write.md) |
| 32 | [15](15-stage-job-preparation.md)、[16](16-stage-run-tracking.md) |
| 33 | [17](17-approved-alternate-jobs.md) |
| 34 | [16](16-stage-run-tracking.md)、[17](17-approved-alternate-jobs.md) |
| 35 | [16](16-stage-run-tracking.md)、[17](17-approved-alternate-jobs.md) |
| 36 | [24](24-mastery-training-schedule.md) |
| 37 | [05](05-daily-safe-config-write.md)、[15](15-stage-job-preparation.md)、[23](23-apply-approved-base-plan.md)、[24](24-mastery-training-schedule.md) |
| 38 | [05](05-daily-safe-config-write.md)、[17](17-approved-alternate-jobs.md) |
| 39 | [06](06-doctor-lock-recovery.md)、[10](10-doctor-checks-referral.md) |
| 40 | [06](06-doctor-lock-recovery.md)、[10](10-doctor-checks-referral.md) |
| 41 | [06](06-doctor-lock-recovery.md)、[10](10-doctor-checks-referral.md) |
| 42 | [06](06-doctor-lock-recovery.md)、[10](10-doctor-checks-referral.md) |
| 43 | [06](06-doctor-lock-recovery.md) |
| 44 | [10](10-doctor-checks-referral.md) |
| 45 | [10](10-doctor-checks-referral.md)、[25](25-maa-version-verification.md) |
| 46 | [06](06-doctor-lock-recovery.md)、[10](10-doctor-checks-referral.md) |
| 47 | [06](06-doctor-lock-recovery.md)、[10](10-doctor-checks-referral.md) |
| 48 | [04](04-install-help-preferences.md) |
| 49 | [04](04-install-help-preferences.md)、[07](07-setup-existing-environment.md) |
| 50 | [04](04-install-help-preferences.md) |
| 51 | [04](04-install-help-preferences.md) |
| 52 | [04](04-install-help-preferences.md) |
| 53 | [05](05-daily-safe-config-write.md) |
| 54 | [05](05-daily-safe-config-write.md)、[09](09-manual-credentials.md) |
| 55 | [02](02-repository-workflow.md) |
| 56 | [25](25-maa-version-verification.md) |
| 57 | [25](25-maa-version-verification.md) |
| 58 | [25](25-maa-version-verification.md) |
| 59 | [25](25-maa-version-verification.md)、[26](26-v0-1-0-release-validation.md) |
| 60 | [07](07-setup-existing-environment.md)、[10](10-doctor-checks-referral.md)、[25](25-maa-version-verification.md) |
| 61 | [02](02-repository-workflow.md) |
| 62 | [03](03-cross-host-evaluation.md)、[26](26-v0-1-0-release-validation.md) |
| 63 | [02](02-repository-workflow.md)、[03](03-cross-host-evaluation.md)、[26](26-v0-1-0-release-validation.md) |
| 64 | [02](02-repository-workflow.md) |
| 65 | [26](26-v0-1-0-release-validation.md) |
| 66 | [04](04-install-help-preferences.md)、[26](26-v0-1-0-release-validation.md) |
| 67 | [02](02-repository-workflow.md) |
| 68 | [02](02-repository-workflow.md) |
| 69 | [02](02-repository-workflow.md)、[26](26-v0-1-0-release-validation.md) |
| 70 | [02](02-repository-workflow.md) |
