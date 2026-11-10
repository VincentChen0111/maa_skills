# 05、11 跟进主分支变基

- 维护者要求：先 fetch，再将 05、11 变基到包含 PR #34 的主分支；不修改或推送 `claude/maa-core`。
- 已 fetch 的 main 为 `856538fa812be691add4e675eacc8462c71a1ba9`，包含 #34 的 `37167326638c55d4cdd33a48a51b8391c29c4e9e` 及已 squash 合并的 #33。
- 05 原候选 `4ff52d8` 保留于本地备份分支后重放到 main；跳过已在 main 的伴随安装、生成时间支持。保留上游账号、偏好、版权和规格，恢复原合并提交独有的验证记录及 daily 夹具 core 来源。索引通过 `node scripts/tracker.ts --write` 生成，没有手工合并冲突。
- 11 的原候选 `47b99e7f82309e1d4594a5a8505571a1203e9022` 已完整 squash 合并为 main，树一致；备份后将分支变基到该 main，不重复引入已交付提交。两分支的通用伴随安装测试改为 `maa-core`。

## 路径和验证

- 共享实现只在 `skills/maa-core/scripts/`；daily 使用 `maa-config.ts`、`maa-process.ts`，account 使用 `account-snapshot.ts`，共用 `preferences.ts`。`skills/maa-help/` 无 scripts；操作入口开头均自行检查 core 并提供宿主安装指引。
- 调用、评测和测试路径覆盖 `skills/maa-daily/`、`skills/maa-account/`、`eval/maa-daily/`、`eval/maa-account/`、`tests/maa-config.test.ts`、`tests/maa-process.test.ts`、`tests/daily-evaluation.test.ts`、`tests/account-installation.test.ts`、`tests/eval-fixture.test.ts`。通用运行器继续通过 companionSkills 接收 core，未加入 help 依赖。
- 05：变基后的 `node scripts/check.ts` 为 96 项中 95 通过、1 项非 Windows 测试跳过；`npm run typecheck` 通过。11：同命令 50/50 通过，类型检查通过。两分支 tracker、privacy、metadata 和规则自检均通过。
- 05 的 skills/scripts/eval 与变基前逐文件无差异；11 的产品载荷与已合并 main 无差异。新的变基提交已另跑官方两宿主原生安装：05 固定 `74d739a0412f67532fdec59edc819f965b609080`，core/help/daily 各 14 文件字节一致，合成事务/备份/关停通过；11 固定 `530c9eac7b335edb75eaf0d120314d416d98e902`，core/help/account 各 11 文件内容与许可证核对通过，实际安装的 set/read/inspect/import 和合成快照通过。两次都包含 Codex 重复拒绝/临时重装及 Claude 原生同版更新入口，未验证跨版本升级。05 该 SHA 的 Windows/Ubuntu 远端 CI 均通过；11 原 PR 已合并、远端分支已删除，按明确空引用租约重建分支，未新建 PR，工作流不为普通分支 push 触发 CI。
- 固定真实模型调用仍因隔离认证缺失为 unverified；未操作真实 MAA/设备。维护者另行批准的 05 产品 R4 已完成但仍未通过，发现任务多态身份与单次定时编码问题；本变基核对不替代产品审查。

## 独立审查

变基与通用 companion 调整独立核对通过：审查员核对 05 的产品/scripts/eval 与变基前一致，11 候选 `6450294d5a1612e1375cebfef96007a8998070e1` 相对 main 仅通用 companion 测试及记录变化；另独立运行伴随安装测试 7/7。该狭义结论不重新认证完整 11 产品，也不改变 05 产品 R4 未通过。
