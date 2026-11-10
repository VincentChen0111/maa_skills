# skill 目录

每个产品 skill 在本目录下有自己的 `SKILL.md` 和参考文件。`maa-help` 只有文字，不带脚本。共享脚本集中在 `maa-core/scripts/`，每个脚本只有一份实现；`maa-core` 不是操作入口，带 `SKILL.md` 是因为 Codex 安装器要求。操作类 skill（setup、account、daily、doctor）通过相邻目录 `../maa-core/scripts/` 调用；开头确认 `maa-core` 存在，缺失时停止操作，并由自身说明给出安装指引。

当前提供 `maa-help`、`maa-account`、`maa-daily`、`maa-doctor` 和共享载荷 `maa-core`；daily 维护已有队列、提醒与定时，doctor 先核对配置和遗留锁，按点名批准修复。setup 和其他范围按工单交付。真实模型基线与分数不降仍是发布门禁；各包实际验收状态见[宿主说明](../docs/hosts.md)和 [doctor 验证记录](../docs/doctor-verification.md)。
