# maa_skills 工单索引

本批 26 票由维护者于 2026-11-10 批准，来源为 [规格](../spec.md)。本地 Markdown 是实现工单记录，GitHub Issues 是本批发布的镜像；已逐票互链。更新状态时同步两边，实施从阻塞项全部完成的票开始。

所有票初始 triage 状态为 `ready-for-agent`；实施进度单独记录在各票正文，表示完成情况。编号为本地工单号，不是 GitHub Issue 号。

## 工单与依赖

<!-- tracker:start -->

当前已完成：01、02、03、04、05、06、07、09、10、11、12、13、14、15、16、17、18、19、20、21、22、23、24、29。当前可开始：08、25、27、28、30。

| 本地票 | 标题 | GitHub Issue | 阻塞项 | 实施进度 |
| --- | --- | --- | --- | --- |
| 01 | [修正三项规则来源](01-spec-rule-provenance.md) | [#3](https://github.com/VincentChen0111/maa_skills/issues/3) | 无 | 已完成 |
| 02 | [仓库开发与公开检查闭环](02-repository-workflow.md) | [#4](https://github.com/VincentChen0111/maa_skills/issues/4) | 01 | 已完成 |
| 03 | [双宿主行为评测](03-cross-host-evaluation.md) | [#5](https://github.com/VincentChen0111/maa_skills/issues/5) | 02 | 已完成 |
| 04 | [可安装的 help 与偏好设置](04-install-help-preferences.md) | [#6](https://github.com/VincentChen0111/maa_skills/issues/6) | 03 | 已完成 |
| 05 | [daily 安全修改配置](05-daily-safe-config-write.md) | [#7](https://github.com/VincentChen0111/maa_skills/issues/7) | 04 | 已完成 |
| 06 | [doctor 核对并恢复遗留写入](06-doctor-lock-recovery.md) | [#8](https://github.com/VincentChen0111/maa_skills/issues/8) | 05 | 已完成 |
| 07 | [setup 接入现有环境](07-setup-existing-environment.md) | [#9](https://github.com/VincentChen0111/maa_skills/issues/9) | 06 | 已完成 |
| 08 | [setup 下载并补齐环境](08-setup-program-downloads.md) | [#10](https://github.com/VincentChen0111/maa_skills/issues/10) | 07 | 未开始 |
| 09 | [用户手动设置凭据](09-manual-credentials.md) | [#11](https://github.com/VincentChen0111/maa_skills/issues/11) | 07 | 已完成 |
| 10 | [doctor 完整检查与转介](10-doctor-checks-referral.md) | [#12](https://github.com/VincentChen0111/maa_skills/issues/12) | 09 | 已完成 |
| 11 | [MAA 识别结果转账号快照](11-maa-account-snapshot.md) | [#13](https://github.com/VincentChen0111/maa_skills/issues/13) | 04 | 已完成 |
| 12 | [森空岛账号快照](12-skland-account-snapshot.md) | [#14](https://github.com/VincentChen0111/maa_skills/issues/14) | 09、11 | 已完成 |
| 13 | [单干员培养成本查询](13-operator-cost-query.md) | [#15](https://github.com/VincentChen0111/maa_skills/issues/15) | 11 | 已完成 |
| 14 | [加工与材料凭证后的缺口](14-crafting-voucher-gaps.md) | [#16](https://github.com/VincentChen0111/maa_skills/issues/16) | 13 | 已完成 |
| 15 | [指定关卡作业准备](15-stage-job-preparation.md) | [#17](https://github.com/VincentChen0111/maa_skills/issues/17) | 05、11 | 已完成 |
| 16 | [跟踪关卡运行结果](16-stage-run-tracking.md) | [#18](https://github.com/VincentChen0111/maa_skills/issues/18) | 06、15 | 已完成 |
| 17 | [批准范围内切换备选作业](17-approved-alternate-jobs.md) | [#19](https://github.com/VincentChen0111/maa_skills/issues/19) | 16 | 已完成 |
| 18 | [NGA 调研闭环](18-nga-research.md) | [#20](https://github.com/VincentChen0111/maa_skills/issues/20) | 09 | 已完成 |
| 19 | [森空岛社区与 B 站调研](19-community-bilibili-research.md) | [#21](https://github.com/VincentChen0111/maa_skills/issues/21) | 09 | 已完成 |
| 20 | [带独立审查的培养建议](20-reviewed-cultivation-report.md) | [#22](https://github.com/VincentChen0111/maa_skills/issues/22) | 14、18 | 已完成 |
| 21 | [基建技能查询](21-base-skill-query.md) | [#23](https://github.com/VincentChen0111/maa_skills/issues/23) | 11 | 已完成 |
| 22 | [基建建议与排班生成](22-base-report-and-plan.md) | [#24](https://github.com/VincentChen0111/maa_skills/issues/24) | 20、21 | 已完成 |
| 23 | [执行已批准的基建排班](23-apply-approved-base-plan.md) | [#25](https://github.com/VincentChen0111/maa_skills/issues/25) | 05、22 | 已完成 |
| 24 | [专精助手与单次定时](24-mastery-training-schedule.md) | [#26](https://github.com/VincentChen0111/maa_skills/issues/26) | 05、14、21 | 已完成 |
| 25 | [MAA 版本核对与升级提醒](25-maa-version-verification.md) | [#27](https://github.com/VincentChen0111/maa_skills/issues/27) | 10 | 未开始 |
| 26 | [v0.1.0 发布验收](26-v0-1-0-release-validation.md) | [#28](https://github.com/VincentChen0111/maa_skills/issues/28) | 08、12、17、19、23、24、27、28 | 未开始 |
| 27 | [批准后的碎石与临期药](27-approved-stone-expiring-medicine.md) | [#44](https://github.com/VincentChen0111/maa_skills/issues/44) | 03、05、06 | 未开始 |
| 28 | [行为评测可运行化与登录预检](28-runnable-evaluation-auth-preflight.md) | [#45](https://github.com/VincentChen0111/maa_skills/issues/45) | 03 | 未开始 |
| 29 | [指定关卡作业匹配改进](29-stage-job-matching-improvements.md) | [#46](https://github.com/VincentChen0111/maa_skills/issues/46) | 15 | 已完成 |
| 30 | [配置写入器加固：投影指纹与差异核对](30-config-writer-projection-diff.md) | [#47](https://github.com/VincentChen0111/maa_skills/issues/47) | 05 | 未开始 |

<!-- tracker:end -->

26 条 GitHub Issues 均标记为 ready-for-agent；发布时设置了 39 条 GitHub 原生阻塞关系，与当时的本地票号对应。2026-11-11 本地去掉了 26 对 25 的依赖，现为 38 条；GitHub 上 #28 对 #27 的阻塞关系也已同步移除。

2026-11-13 按维护者当日的决定及其设计默认值新增 27（来源见规格「默认值及其来源」），并修订 10、16、17、25、26 的验收条件。同日新增 28、29、30，并在未开始的 09、10、12、16、17、22、23、25、26 里补充验收条件和参考说明。GitHub Issue：27 为 #44，28 为 #45，29 为 #46，30 为 #47。GitHub 上的镜像（四张新票的正文、26 对 27 和 28 的阻塞关系、上述九张票修改后的正文）随引入这些改动的 PR 一起同步。

28、29、30 和这批补充来自对同类公开项目的对照。维护者 2026-11-13 同意把这些建议写进工单，原话：「各家分析和项目建议没什么问题」「都没问题，更改」。各条的具体写法是设计默认值，不是维护者原话；其中新增的限制登记在规格「默认值及其来源」。评测怎样登录，维护者同日已经决定：用 Claude 和 ChatGPT 的套餐登录，不用 API key，原话：「我可以用claude/gpt plan subscription吗？api太贵了」；协调者答复两家官方文档都支持这种用法之后，维护者确认写进工单。随之定下的设计默认值和依据的官方文档见 [28](28-runnable-evaluation-auth-preflight.md) 的「决定」，其中的限制登记在规格两张来源表。

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
| 28 | [05](05-daily-safe-config-write.md)、[30](30-config-writer-projection-diff.md) |
| 29 | [05](05-daily-safe-config-write.md)、[30](30-config-writer-projection-diff.md) |
| 30 | [05](05-daily-safe-config-write.md) |
| 31 | [05](05-daily-safe-config-write.md) |
| 32 | [15](15-stage-job-preparation.md)、[16](16-stage-run-tracking.md)、[29](29-stage-job-matching-improvements.md) |
| 33 | [16](16-stage-run-tracking.md)、[17](17-approved-alternate-jobs.md)、[29](29-stage-job-matching-improvements.md) |
| 34 | [16](16-stage-run-tracking.md)、[17](17-approved-alternate-jobs.md) |
| 35 | [16](16-stage-run-tracking.md)、[17](17-approved-alternate-jobs.md) |
| 36 | [24](24-mastery-training-schedule.md) |
| 37 | [05](05-daily-safe-config-write.md)、[15](15-stage-job-preparation.md)、[23](23-apply-approved-base-plan.md)、[24](24-mastery-training-schedule.md)、[27](27-approved-stone-expiring-medicine.md)、[29](29-stage-job-matching-improvements.md)、[30](30-config-writer-projection-diff.md) |
| 38 | [05](05-daily-safe-config-write.md)、[17](17-approved-alternate-jobs.md)、[27](27-approved-stone-expiring-medicine.md) |
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
| 53 | [05](05-daily-safe-config-write.md)、[27](27-approved-stone-expiring-medicine.md) |
| 54 | [05](05-daily-safe-config-write.md)、[09](09-manual-credentials.md) |
| 55 | [02](02-repository-workflow.md) |
| 56 | [25](25-maa-version-verification.md) |
| 57 | [25](25-maa-version-verification.md) |
| 58 | [25](25-maa-version-verification.md) |
| 59 | [25](25-maa-version-verification.md)、[26](26-v0-1-0-release-validation.md) |
| 60 | [07](07-setup-existing-environment.md)、[10](10-doctor-checks-referral.md)、[25](25-maa-version-verification.md) |
| 61 | [02](02-repository-workflow.md) |
| 62 | [03](03-cross-host-evaluation.md)、[26](26-v0-1-0-release-validation.md)、[28](28-runnable-evaluation-auth-preflight.md) |
| 63 | [02](02-repository-workflow.md)、[03](03-cross-host-evaluation.md)、[26](26-v0-1-0-release-validation.md)、[28](28-runnable-evaluation-auth-preflight.md) |
| 64 | [02](02-repository-workflow.md) |
| 65 | [26](26-v0-1-0-release-validation.md) |
| 66 | [04](04-install-help-preferences.md)、[26](26-v0-1-0-release-validation.md) |
| 67 | [02](02-repository-workflow.md) |
| 68 | [02](02-repository-workflow.md) |
| 69 | [02](02-repository-workflow.md)、[26](26-v0-1-0-release-validation.md) |
| 70 | [02](02-repository-workflow.md) |
