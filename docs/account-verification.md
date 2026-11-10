# account 验证记录

工单 11 的实现候选；独立审查两轮通过；完成声明仍受模型正向导入基线、真实宿主安装约束。本机仅使用临时 home、合成识别资料和复制到临时目录的 skill；没有读取真实账号、操作设备或修改已安装 skill。

- 工具层接缝：`parseMaaSnapshot`、`inspectMaaSnapshot`、`importMaaSnapshot`、`formatAccountSummary` 与 CLI。完成回调、较新未完成结果、缺失练度、损坏 JSON、非法数量、重复干员、空识别、模板错误、缓存原扫描时间及两种 GUI 缓存分别有行为测试。
- 写入接缝：真实临时目录验证配置指定私有目录、JSON 原子替换、占用锁不抢占、只读目标保存失败旧内容保留；设置、输入 MAA 缓存保持原样；合成额外凭据和账号字段不进入快照及输出。
- 安装载荷：两个临时原生目录布局内，account 通过相邻 maa-help 的唯一脚本完成 read、inspect、import。当前仅证明复制后的载荷路径可达；从公开提交用两个宿主的真实 installer 安装/更新尚未执行。
- 2026-11-11：完整 `node scripts/check.ts` 40/40 通过，七类评分规则自检、tracker、metadata、privacy 通过；`npm run typecheck` 通过。Windows 真实 rename/只读目标测试需在临时夹具中运行沙箱外命令；不以沙箱权限失败认定产品失败。公开 CI 尚待 PR。
- TDD：新增每个脚本行为前先执行失败的 CLI/导出函数测试，再实现；companion 安装最初缺少 sibling 导致失败，扩展后同场景通过。静态文案不靠逐字匹配测试。

## 模型门禁

`eval/maa-account/scenarios.ts` 当前三个场景覆盖只读盘点、由用户启动识别、拒绝越界操作。即使这些场景通过，也不代表导入写入的模型行为通过；动态读取时间的授权断言尚未在评分器安全表达，必须补上至少一个保存快照的正向模型场景后才可建立完整基线，不能为此放宽写入授权或伪造时间。

固定 CLI 和模型尝试：Codex `0.167.0-alpha.3.2` / `gpt-6`，Claude Code `2.1.322` / `claude-sonnet-4-6`。六次真实调用已在隔离 home 中执行，均为 `unverified`：Codex 缺少隔离认证（401），Claude 未登录；没有调用者认证文件复制。许可修复前后均使用相同 CLI、模型和场景各运行六次，比较结果仍为 `unverified`。最终 skill 与 companion 的整体指纹为 `541ae4bcaabdb04801b3e82f2394a276c5f9b2145934c2bb12f1ed81cc29d208`。本地忽略目录保留 run/evidence/host/stderr/invocation/scenario 证据，无通过的基线，不解除 12、13、15、21 的依赖。04 的一次性模型延期不适用于 11。

独立审查及意见处置见 [审查记录](reviews/2026-11-11-11-account.md)。

## 隐私与来源

逐文件检查新增脚本、skill、说明、样例和测试。样例干员和数量均合成，额外敏感标记使用明确合成占位，不发布原始模型 transcript。固定上游和 MAA 指纹见 [来源核对](account-sources.md)，dsh-maa-cli 的原版权和 MIT 全文见[第三方声明](../THIRD_PARTY_NOTICES.md)。
