# 宿主与原生安装

当前 maa-help 候选实现正在工单 04 验收，状态见 [help 验证记录](help-verification.md)；其余产品入口未交付。根目录的 `.claude-plugin/plugin.json` 描述插件，`marketplace.json` 用 `./` 指向同一插件。入口放在 `skills/<名称>/SKILL.md`，参考文件和脚本随入口目录复制。

Claude Code 使用原生插件市场：`/plugin marketplace add VincentChen0111/maa_skills`，再用 `/plugin install maa-skills@maa-skills`；开发时可在隔离环境用 `claude --plugin-dir <clone>`。结构依据 [插件描述](https://code.claude.com/docs/en/plugins-reference)和[市场说明](https://code.claude.com/docs/en/plugin-marketplaces)。本票只准备描述文件，不把空插件安装当作产品可用。

Codex 使用自带的 skill-installer，按仓库和 `skills/<名称>` 路径安装，一条命令可以给多个路径；用其 `--dest` 指向临时 skill 目录做验收，避免改动用户安装。已核对本机 installer：它逐个原样复制指定的目录，要求每个目录里有 `SKILL.md`，目标已存在时拒绝覆盖。更新走宿主流程，不另写复制安装器。共享脚本位于 `skills/maa-core/scripts/`，操作类 skill 通过相邻目录复用，安装时要一并选择同版本的 `maa-core`；`maa-help` 只有文字，不依赖它。具体指引随 skill 分发，见[宿主参考](../skills/maa-help/references/hosts.md)。2026-11-11 把共享脚本从 `maa-help` 移到 `maa-core` 之后，两个宿主的原生安装尚未重新验收。

两个宿主使用同一份中文 skill 正文。Codex 的独立审查用新进程与自包含 brief；Claude 用新上下文。brief 包含任务、规格、基点和 diff，不把作者结论当作审查结果。[评测运行器](evaluation.md)已提供这两条路径；本机隔离认证或 CLI 不可用的实测项见[验证记录](evaluation-verification.md)，不声称模型审查已通过。

维护者开发模式按规格可用目录联接指向 clone；构建和评测只在临时 home 建联接，目标是当前 clone。测试应验证从临时安装入口能读到必要参考文件和工具。不要在测试中修改正常用户的宿主目录。
