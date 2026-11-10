# 离线账号导入演示

样例全部合成。先把 `MAA_SKILLS_HOME` 指到一个新建临时目录，再在仓库根目录执行（PowerShell）：

```powershell
'{"callbackFile":"examples/account/completed.json","format":"markdown"}' | node skills/maa-help/scripts/account-snapshot.ts inspect
'{"callbackFile":"examples/account/completed.json","format":"markdown"}' | node skills/maa-help/scripts/account-snapshot.ts import
```

`inspect` 不写文件；`import` 在临时私有目录产生 `account-snapshot.json`，读取时间来自实际运行。不能把示例覆盖到真实账号目录。快照可供后续共享成本、作业和基建工具读取；这些消费工具仍在实施，不宣称已完成端到端验证。字段和未知值约定见 [导入接口](../../skills/maa-account/references/import.md)。
