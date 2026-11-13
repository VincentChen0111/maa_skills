---
name: maa-doctor
description: 诊断 MAA 配置和写入锁，核对遗留写入的配置、备份及进程证据；用户点名批准后，经共享写入通道清理已核对的锁或恢复已记录字段。也报告 NGA、森空岛账号和实验性 B 站凭据的状态（不显示值），重新输入由用户在自己的终端完成。连接、安装与 MAA 自身问题当前交用户检查。
---

# maa-doctor

开始前确认相邻 `../maa-core/scripts/` 中的 `preferences.ts`、`doctor.ts`、`maa-config.ts` 和 `credentials.ts` 存在。缺少 core 时停止：Codex 使用自带 skill-installer，从 `VincentChen0111/maa_skills` 同一版本安装 `skills/maa-core` 与 `skills/maa-doctor`；Claude Code 使用原生市场 `/plugin marketplace add VincentChen0111/maa_skills`、`/plugin install maa-skills@maa-skills` 安装完整插件，已有安装用原生更新入口更新。

运行 `node <本目录>/../maa-core/scripts/preferences.ts read`，标准输入传当前用户语言的 BCP 47 标签。按返回语言回复；未设置时提示可以设置。用户要求改设置或记录偏好原话时使用 [共享偏好接口](../maa-core/references/preferences.md)。

1. 运行 `node <本目录>/../maa-core/scripts/doctor.ts check --json`。检查只读配置、锁和证据，仅更新私有目录的最近检查记录。列出每条状态、原因、修法和执行者，说明 `recovery.changes` 中已生效、未生效及未知项。返回的是白名单证据，不读取完整配置到对话。结果末尾的 `credential-nga`、`credential-skland`、`credential-bilibili` 是与 maa-setup 共用的凭据检查，只有状态，没有值；含义见 [凭据接口](../maa-core/references/credentials.md)，保存了不等于可用。
2. 活跃锁等待原持有者完成。遗留锁根据当前配置、最新关联备份、待执行记录和 MAA 状态核对。`unknown`、损坏配置、缺失/不匹配证据或未支持的事务均保留锁，给用户说明仍缺什么；不能证明时不宣称恢复完成，也不自动重放原操作。
3. 每项修法先获得当次点名批准，再读 [检查与恢复接口](references/checks.md)。允许用户一次点名多项；只执行已批准且本次检查可用的修法。笼统“全部修复”不构成批准。同一遗留事务的 `reconcile-lock` 与 `restore-config` 是互斥选择，先让用户选定意图。
4. 调用共享 `doctor.ts repair --json`，绑定刚才的 `evidenceRevision` 和用户批准原话。配置恢复由同一个配置写入器执行，不能直接复制备份、编辑 JSON 或删锁。MAA 已关闭时仍需确认用户没有在操作，再传 `closedConfirmed: true`。本次理智药数量需要当次明确批准；源石、抽卡、礼包、付费和登录不执行。
5. `complete` 才报告该修法完成，并再次运行 check 保存最新诊断。清锁完成仅表示遗留写入已核对，不表示游戏任务完成。`rejected` 说明前提不满足；`unknown` 保留证据并交用户处理，不自行重试。只有新的诊断与用户重新点名批准才能进入下一次修法。
6. 凭据的修法（`enter-credential`、`verify-by-use`、`replace-credential`、`reenter-credential`）执行者都是用户，不调用 repair；即使用户点名批准，`repair` 也返回 `user-manual-repair`。已知过期或无法读取时，给出带实际路径和 `--language <用户语言的 BCP 47 标签>` 的 `credentials.ts input <服务>` 命令，请用户自己打开终端运行并重新粘贴；agent 不运行 `input`、不替用户登录，也不请用户把 token、Cookie 或 SESSDATA 贴到对话里，用户已经贴出时不复述、不保存。森空岛 token 过期后的修法只有重新粘贴；B 站功能是实验性的。用户说已完成后重新 check。

当前范围是配置解析与已知单配置写入锁核对，包括 daily 配置和 setup 连接字段事务。凭据只检查状态；连接、版本、日志转介和安装诊断的 doctor 集成由后续工单交付；已有环境接入可交 maa-setup。新事务若附带作业、训练计划或其他资源，其证据未经支持时交用户核对，不把它当作可恢复的普通配置事务。
