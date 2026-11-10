# 宿主与安装

正文在 Codex 和 Claude Code 上相同。所有共享脚本随 `maa-help` 目录原样安装，路径相对于加载的 `SKILL.md`，不依赖 clone 根目录或正常用户的另一份安装。其他 skill 发布后，通过相邻目录 `../maa-help/scripts/` 复用；安装其他入口时也须安装同版本的 maa-help。

Codex：让原生 skill-installer 从 `VincentChen0111/maa_skills` 安装路径 `skills/maa-help`。其脚本命令为 `install-skill-from-github.py --repo VincentChen0111/maa_skills --path skills/maa-help --ref <固定提交> --dest <临时宿主的 skills 目录>`。安装器遇已存在目标会拒绝覆盖，不提供原地更新选项。更新时先将目标版本安装到另一个新的临时目录验证；确认后移除旧安装，再用同一原生安装命令重新安装。评测只对临时安装演示移除/重装，不能替用户删除正常安装，也不另造复制安装器。

Claude Code：运行 `claude plugin marketplace add VincentChen0111/maa_skills`，再运行 `claude plugin install maa-skills@maa-skills --scope user`。更新时运行 `claude plugin marketplace update maa-skills` 和 `claude plugin update maa-skills@maa-skills --scope user`，随后重启会话。命令依据 [Claude 官方插件命令参考](https://code.claude.com/docs/en/plugins/cli-reference)；评测时所有命令只在隔离 home 中执行。开发时可用 `claude --plugin-dir <clone>`，仅让隔离的临时配置读取 clone。插件根目录中的 `skills/maa-help` 自带运行需要的脚本。

Windows 开发目录联接：只在新建的临时宿主目录中，用 PowerShell `New-Item -ItemType Junction` 把该宿主的 `skills/maa-help` 指向 clone 的 `skills/maa-help`。先核实临时目标不存在。验证后仅清理临时联接，不移动或替换正常宿主安装；不要递归删除联接目标。

建议报告的独立审查：Codex 用新的 `codex exec` 进程，Claude 用全新上下文，提供任务、规格、固定版本和 diff/报告全文的自包含说明。仅一名审查员，只审一轮，只报告真实错误；接受的错误改正后不再复审，在报告里列出这些改动；不能运行时写明未验证。用户当次明确跳过报告审查时标为「未审查」。maa-help 本身不创建建议报告。
