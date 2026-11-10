# 宿主与原生安装

当前是开发骨架，还没有可调用的产品 skill；双宿主实际安装验收属于 04。根目录的 `.claude-plugin/plugin.json` 描述插件，`marketplace.json` 用 `./` 指向同一插件。后续入口放在 `skills/<名称>/SKILL.md`，参考文件和脚本随入口目录复制。

Claude Code 使用原生插件市场：`/plugin marketplace add VincentChen0111/maa_skills`，再用 `/plugin install maa-skills@maa-skills`；开发时可在隔离环境用 `claude --plugin-dir <clone>`。结构依据 [插件描述](https://code.claude.com/docs/en/plugins-reference)和[市场说明](https://code.claude.com/docs/en/plugin-marketplaces)。本票只准备描述文件，不把空插件安装当作产品可用。

Codex 使用自带的 skill-installer，按仓库和 `skills/<名称>` 路径安装；用其 `--dest` 指向临时 skill 目录做验收，避免改动用户安装。已核对本机 installer：它逐个原样复制指定的 skill 目录，目标已存在时拒绝覆盖。更新走宿主流程，不另写复制安装器。04 必须验证共享工具在复制后仍能找到；此时再落定载荷目录，不能假定安装器会复制相邻目录，更不能为两个宿主各维护一份工具实现。

两个宿主使用同一份中文 skill 正文。Codex 的独立审查用新进程与自包含 brief；Claude 用新上下文。brief 包含任务、规格、基点和 diff，不把作者结论当作审查结果。03 会验证驱动并记录无法运行的宿主。

维护者开发模式按规格可用目录联接指向 clone；构建和评测只在临时 home 建联接，目标是当前 clone。测试应验证从临时安装入口能读到必要参考文件和工具。不要在测试中修改正常用户的宿主目录。
