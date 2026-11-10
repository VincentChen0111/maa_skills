# 05、11 跟进主分支变基

- 维护者要求：先 fetch，再将 05、11 变基到包含 PR #34 的主分支；不修改或推送 `claude/maa-core`。
- 已 fetch 的 main 为 `856538fa812be691add4e675eacc8462c71a1ba9`，包含 #34 的 `37167326638c55d4cdd33a48a51b8391c29c4e9e` 及已 squash 合并的 #33。
- 05 原候选 `4ff52d8` 保留于本地备份分支后重放到 main；跳过已在 main 的伴随安装、生成时间支持。保留上游账号、偏好、版权和规格，恢复原合并提交独有的验证记录及 daily 夹具 core 来源。索引通过 `node scripts/tracker.ts --write` 生成，没有手工合并冲突。
- 11 的原候选 `47b99e7f82309e1d4594a5a8505571a1203e9022` 已完整 squash 合并为 main，树一致；备份后将分支变基到该 main，不重复引入已交付提交。两分支的通用伴随安装测试改为 `maa-core`。

## 路径和验证

- 共享实现只在 `skills/maa-core/scripts/`；daily 使用 `maa-config.ts`、`maa-process.ts`，account 使用 `account-snapshot.ts`，共用 `preferences.ts`。`skills/maa-help/` 无 scripts；操作入口开头均自行检查 core 并提供宿主安装指引。
- 调用、评测和测试路径覆盖 `skills/maa-daily/`、`skills/maa-account/`、`eval/maa-daily/`、`eval/maa-account/`、`tests/maa-config.test.ts`、`tests/maa-process.test.ts`、`tests/daily-evaluation.test.ts`、`tests/account-installation.test.ts`、`tests/eval-fixture.test.ts`。通用运行器继续通过 companionSkills 接收 core，未加入 help 依赖。
- 05：变基后的 `node scripts/check.ts` 为 96 项中 95 通过、1 项非 Windows 测试跳过；`npm run typecheck` 通过。11：同命令 50/50 通过，类型检查通过。两分支 tracker、privacy、metadata 和规则自检均通过。
- 05 的 skills/scripts/eval 与变基前逐文件无差异；11 的产品载荷与已合并 main 无差异。此前固定提交的原生安装和合成事务已验证，详见各验证记录；尚未针对新的变基提交 SHA 重做原生安装和远端 CI，不将旧提交的安装记录改写成新 SHA。
- 固定真实模型调用仍因隔离认证缺失为 unverified；未操作真实 MAA/设备。05 产品额外一轮复核由维护者另行批准，尚未开始；本变基说明不替代产品审查。

## 独立审查

变基与通用测试调整尚待独立核对；不记为通过。
