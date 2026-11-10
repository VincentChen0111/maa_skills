# skill 目录

每个产品 skill 在本目录下有自己的 `SKILL.md` 和参考文件。`maa-help` 只有文字，不带脚本。共享脚本集中在 `maa-core/scripts/`，每个脚本只有一份实现；`maa-core` 不是操作入口，带 `SKILL.md` 是因为 Codex 安装器要求。操作类 skill（setup、account、daily、doctor）通过相邻目录 `../maa-core/scripts/` 调用；开头确认 `maa-core` 存在，缺失时停止操作，并由自身说明给出安装指引。

当前提供 `maa-help`、`maa-account` 和共享载荷 `maa-core`；account 可读取本地识别结果与导入快照，其他操作入口未交付。真实模型基线仍未建立并阻止发布，迁移后的验收状态见[宿主说明](../docs/hosts.md)、[04 工单](../docs/issues/04-install-help-preferences.md)和 [11 工单](../docs/issues/11-maa-account-snapshot.md)。
