# 宿主与安装

正文在 Codex 和 Claude Code 上相同。共享脚本都在 `maa-core` 目录，操作类 skill（setup、account、daily、doctor）通过相邻目录 `../maa-core/scripts/` 调用，所以它们必须和同一版本的 `maa-core` 装在一起。`maa-help` 只有文字，不依赖 `maa-core`。

## Claude Code

运行 `claude plugin marketplace add VincentChen0111/maa_skills`，再运行 `claude plugin install maa-skills@maa-skills --scope user`。插件会把所有 skill 目录连同 `maa-core` 一起装好。更新时运行 `claude plugin marketplace update maa-skills` 和 `claude plugin update maa-skills@maa-skills --scope user`，随后重启会话。命令依据 [Claude 官方插件命令参考](https://code.claude.com/docs/en/plugins/cli-reference)。

## Codex

让原生 skill-installer 从 `VincentChen0111/maa_skills` 安装。一条命令可以给多个路径，每个路径原样复制成一个相邻目录；`maa-core` 要和操作类 skill 一起列出：

`install-skill-from-github.py --repo VincentChen0111/maa_skills --ref <固定版本> --path skills/maa-core skills/maa-help <其他已交付的 skills/maa-*>`

- 安装器要求每个路径里有 `SKILL.md`，所以 `maa-core` 也会显示成一个 skill；它不处理用户请求。
- 安装器遇到已存在的目标会拒绝，不覆盖。更新时先把目标版本装到一个新的临时目录验证，确认后移除旧的全部 `maa-*` 目录，再用同一条命令整体重装。不要只更新其中一个目录。
- 不另造复制安装器。

## 找不到 maa-core 时

操作类 skill 开始前会确认相邻的 `maa-core` 存在。缺失时它不会继续操作，而是让用户按上面对应宿主的方式补装：Claude Code 重装或更新插件；Codex 用同一固定版本安装 `skills/maa-core`（如果其他 `maa-*` 目录来自别的版本，就整体重装）。

## 开发目录联接（Windows）

只在新建的临时宿主目录中，用 PowerShell `New-Item -ItemType Junction` 把该宿主的 `skills/maa-core`、`skills/maa-help` 等目录分别指向 clone 里的同名目录。先核实临时目标不存在。验证后仅清理临时联接，不移动或替换正常宿主安装；不要递归删除联接目标。开发时也可用 `claude --plugin-dir <clone>`，仅让隔离的临时配置读取 clone。

## 建议报告的独立审查

Codex 用新的 `codex exec` 进程，Claude 用全新上下文，提供任务、规格、固定版本和报告全文的自包含说明。仅一名审查员，只审一轮，只报告真实错误；接受的错误改正后不再复审，在报告里列出这些改动；不能运行时写明未验证。用户当次明确跳过报告审查时标为「未审查」。maa-help 本身不创建建议报告。

两个宿主用同一份审查说明：maa-account 生成培养报告后由 `cultivation-report.ts brief` 写出，里面是共用模板、报告正文和报告全文。Claude Code 开一个全新上下文的子代理读取它；Codex 把它经标准输入交给新的 `codex exec --sandbox read-only --ephemeral --skip-git-repo-check -` 进程。宿主开不了子代理或 `codex exec` 时，报告标「审查未完成」，不能批准，也不会说成已审查。
