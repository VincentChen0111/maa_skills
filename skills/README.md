# skill 目录

每个产品 skill 在本目录下有自己的 `SKILL.md` 和参考文件。`maa-help` 只有文字，不带脚本。共享脚本集中在 `maa-core/scripts/`，每个脚本只有一份实现；`maa-core` 不是操作入口，带 `SKILL.md` 只是因为 Codex 的安装器要求。操作类 skill（setup、account、daily、doctor）通过相邻目录 `../maa-core/scripts/` 调用，并在自己的 `SKILL.md` 开头确认 `maa-core` 存在，缺失时不继续操作，按[宿主说明](maa-help/references/hosts.md)指引用户安装。当前交付只有 `maa-help` 和 `maa-core`，真模型基线尚未建立；其他入口未交付。原生安装验收见[宿主说明](../docs/hosts.md)及 [04 工单](../docs/issues/04-install-help-preferences.md)。
