# maa_skills 工单索引

本批 26 票由维护者于 2026-11-10 批准，来源为 [规格](../spec.md)。本地 Markdown 是实现工单记录，GitHub Issues 是本批发布的镜像；发布后逐票互链。更新状态时同步两边，实施从阻塞项全部完成的票开始。

所有票初始状态为 `ready-for-agent`，实施进度为未开始；这表示内容已具备实现条件，不表示其阻塞项已经完成。当前可开始：01。编号为本地工单号，不是 GitHub Issue 号。

## 工单与依赖

| 本地票 | 标题 | 阻塞项 |
| --- | --- | --- |
| 01 | [修正三项规则来源](01-spec-rule-provenance.md) | 无 |
| 02 | [仓库开发与公开检查闭环](02-repository-workflow.md) | 01 |
| 03 | [双宿主行为评测](03-cross-host-evaluation.md) | 02 |
| 04 | [可安装的 help 与偏好设置](04-install-help-preferences.md) | 03 |
| 05 | [daily 安全修改配置](05-daily-safe-config-write.md) | 04 |
| 06 | [doctor 核对并恢复遗留写入](06-doctor-lock-recovery.md) | 05 |
| 07 | [setup 接入现有环境](07-setup-existing-environment.md) | 06 |
| 08 | [setup 下载并补齐环境](08-setup-program-downloads.md) | 07 |
| 09 | [用户手动设置凭据](09-manual-credentials.md) | 07 |
| 10 | [doctor 完整检查与转介](10-doctor-checks-referral.md) | 09 |
| 11 | [MAA 识别结果转账号快照](11-maa-account-snapshot.md) | 04 |
| 12 | [森空岛账号快照](12-skland-account-snapshot.md) | 09、11 |
| 13 | [单干员培养成本查询](13-operator-cost-query.md) | 11 |
| 14 | [加工与材料凭证后的缺口](14-crafting-voucher-gaps.md) | 13 |
| 15 | [指定关卡作业准备](15-stage-job-preparation.md) | 05、11 |
| 16 | [跟踪关卡运行结果](16-stage-run-tracking.md) | 06、15 |
| 17 | [批准范围内切换备选作业](17-approved-alternate-jobs.md) | 16 |
| 18 | [NGA 调研闭环](18-nga-research.md) | 09 |
| 19 | [森空岛社区与 B 站调研](19-community-bilibili-research.md) | 09 |
| 20 | [带独立审查的培养建议](20-reviewed-cultivation-report.md) | 14、18 |
| 21 | [基建技能查询](21-base-skill-query.md) | 11 |
| 22 | [基建建议与排班生成](22-base-report-and-plan.md) | 20、21 |
| 23 | [执行已批准的基建排班](23-apply-approved-base-plan.md) | 05、22 |
| 24 | [专精助手与单次定时](24-mastery-training-schedule.md) | 05、14、21 |
| 25 | [MAA 版本核对与升级提醒](25-maa-version-verification.md) | 10 |
| 26 | [v0.1.0 发布验收](26-v0-1-0-release-validation.md) | 08、12、17、19、23、24、25 |

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
