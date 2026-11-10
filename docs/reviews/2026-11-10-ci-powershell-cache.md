# Windows CI 临时缓存隔离审查

日期：2026-11-10。独立改动包为测试运行环境修正，基点 `1bc3f8c`；产品实现已在工单 04 的三轮审查中完成，本包不改变 skill、共享脚本或评测评分逻辑。

## 事实与修正

PR #32 的 Windows CI 28/28 测试通过后，公开离线检查在检出目录发现 PowerShell 自动生成的 `Microsoft/Windows/PowerShell/ModuleAnalysisCache`，因其中含本机路径而失败。没有把缓存加入版本控制或隐私检查白名单。

短路径测试启动真实 Windows PowerShell 时，显式把工作目录设为 fixture 工作区，并将 `PSModuleAnalysisCachePath` 指向 fixture 临时 home 下的文件。该环境变量是 [PowerShell 官方支持的缓存位置设置](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1#module-analysis-cache)，只对这个子进程生效。fixture 原有清理会一并移除缓存。

## 第一轮

独立审查员 `review_ci_paths` 第一轮通过，真实错误 0 项。确认 cwd 与缓存均位于 fixture 内，父目录已创建，清理覆盖缓存；没有放宽隐私检查。

独立复跑 Windows 离线入口 28/28，短路径测试实际执行，privacy、tracker、metadata、评分器与类型检查均通过；检出目录未产生缓存，Git 状态仅含预期文件。远程复测结果见 [PR #32 检查](https://github.com/VincentChen0111/maa_skills/pull/32/checks)。本次仅审查独立 CI 修正，未重审工单 04 产品实现。
