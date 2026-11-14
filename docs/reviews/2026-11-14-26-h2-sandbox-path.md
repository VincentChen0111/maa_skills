# 26 评测框架修复包 H2（沙箱 shell 的 PATH）：独立审查

日期：2026-11-14。范围 `53b7ac7..bb04965`，一个提交。

## 起因

第一次在发布候选 `4247383` 上开批时，13 批都没有调用模型就停了：
- 批次在读保护检查这一步中止，原因是 `read-protection-failed`，detail 是 `login-directory-in-environment`；
- 这是包 H 的环境探针按设计拒绝。

协调者另做了一次诊断：在评测登录配置下跑真实的 `codex sandbox`，不调用模型，只打印变量名。结果有三点：
- **`CODEX_HOME` 已经排除。** `shell_environment_policy.exclude` 生效了。
- **`PATH` 第 0 项落在登录目录下。** 这一项是 `<登录目录>/tmp/arg0-windows/codex-arg0…`，是 Codex 自己加在前面的辅助目录。`exclude` 只能排除整个变量，排除不了 `PATH` 里的一项。
- **固定 `PATH` 后探针干净。** 用 `shell_environment_policy.set` 把 `PATH` 固定为框架交给 Codex 的那份之后，再列一次，没有任何变量含登录目录。

登录目录路径在评测里算作秘密。第一次真实批次里，就有两个场景因为模型列出环境变量，被判泄露秘密。

## 修法

修法由协调者定，登记为设计默认值：
- **只有一个出处生成 `set`。** Codex 权限配置用 `shell_environment_policy.set` 把沙箱 shell 的 `PATH` 固定为子进程环境的 `PATH`，只由 `codexPermissionArguments` 生成。`exec` 和读保护探针都用它。
- **值按 TOML 基本字符串编码。** 没有 `PATH` 或编码不了时，拒绝开跑。
- **原有防护不变。** `exclude` 和环境探针都保留。

## 审查方式

- 一名新上下文的独立审查员，只用宿主替身，不调用模型、不运行宿主 CLI、不联网；
- 一轮，在维护者定的上限（「轮数上限3」）之内。

构建之后，协调者用本分支的 `codexSandboxArguments` 和 `childPath` 又跑了一次真实的 `codex sandbox`，同样只打印变量名。结果没有任何变量、任何 `PATH` 项含登录目录。所以 `codex sandbox` 接受这里的基本字符串写法。`codex exec` 是否照办，要等真实批次运行才能核实；不照办时，探针会在开批前拦下。

## 第一轮

结论：有条件通过，P1 0、P2 0、P3 1。审查员核对了：
- **同一个配置。** 场景运行的 `exec`、读保护探针的三类 `codex sandbox` 调用和读保护的 `exec`，都出自 `codexPermissionArguments`，带同一个 `shellPath`；没有别的 Codex 启动点。
- **失败即停。** 缺 `PATH` 或编码不了时，在删除或写入哨兵、启动任何沙箱或模型进程之前就拒绝。Windows 上 Node 会给缺 `PATH` 的子进程补上运行器的 `PATH`，但拒绝发生在那之前，补进来的 `PATH` 到不了 Codex。
- **编码不能被注入。** `tomlBasicString` 总是输出合法的 TOML 基本字符串。构造出来的 `PATH` 闭合不了字符串，也注入不了别的键。
- **固定的 `PATH` 是夹具的。** 垫片目录排在第一位，node 和系统目录都在。整个仓库搜不到 `apply_patch`，没有场景依赖它。
- **测试能抓到退化。** 替身模拟了 Codex 的 arg0 目录。在临时副本里删掉 `set`，或者让场景运行改传运行器的 `PATH`，对应的测试都会失败。
- **可比性。** 三个改动文件都在运行器指纹和场景指纹里，所以三类批次都要在新候选上重跑，文档写得对。
- **13 个中止批次的编号真实存在。** 都是 `login-directory-in-environment`。

| 意见 | 处置 | 理由 |
| --- | --- | --- |
| P3：四处文档仍把「真实 Codex 是否接受基本字符串写法」写成未验证，与协调者构建后的诊断不一致 | 拒绝 | 少记了一项已核实的范围，不会在真实环境里造成失败。证据记在本记录里；真实批次跑完后，结果包会一并更新这几处未验证项 |

## 验证

- 审查员运行了 typecheck 和 11 个单文件测试，全部通过；另运行了 eval-selftest、用临时 home 的 eval-preflight、privacy 和 tracker，都通过。还做了两次变异核对。
- 完整离线入口以本 PR 的 CI 为准。
- 未验证：真实 `codex exec` 是否照办 `set`。
