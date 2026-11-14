# Issue #76 测试联网防护读取 shell 选项：独立审查

日期：2026-11-14。范围 `89db659..76e9cfc`，只有一个提交，只改测试防护 `tests/fixtures/offline-network.mjs`、它的测试和 [community 验证记录](../community-verification.md)，没有改产品代码。

审查方式：一名新上下文的独立审查员，用离线探针复现，没有联网，没有启动 PowerShell。

## 第一轮

结论：通过，没有意见。审查员核对了以下各点：
- **参数解析与 Node 一致。** 审查员对照本机 Node 24.22.1 自带的 `child_process` 源码，核对了 null 参数表、选项位置、`shell: true` 选用的默认 shell（Windows 上是 `ComSpec` 或 cmd.exe，其他平台是 `/bin/sh`），以及 `exec` 系列的 `shell` 处理。
- **红灯成立。** 换回旧防护后，Issue 的 5 个复现和另外 6 种写法都越过防护，到达下层兜底；兜底先加载，所以没有启动任何进程。
- **应拒的都拒了。** 自写探针试了 29 种应拒写法，全部在创建进程之前被拒绝。其中包括：
  - 大写路径、带空格的路径、正斜杠路径；
  - promisify 后的调用；
  - `ComSpec` 指向 PowerShell。
- **没有误拒。** 15 种合法写法都放行，包括：cmd、node、git、sh、Git bash 完整路径，以及 `exec` 的 shell 为空字符串。
- **Linux 分支不是空测试。** 把平台伪装成 linux 运行新用例：新防护下通过，旧防护下 9 种写法到达下层。
- **覆盖说法属实。** 夹具注释和验证记录写的覆盖范围、「不覆盖」清单都与代码一致。

审查员运行了 typecheck 和用到防护的 6 个测试文件，全部通过。

## 验证

- 完整离线入口以 PR 的 CI（Windows、Ubuntu）为准。
- 「不覆盖」清单里的写法仍可能越过防护：改名的 PowerShell 副本、shell 运行时才拼出的名字，以及 7 个函数以外的启动方式。验证记录写明了这些。
