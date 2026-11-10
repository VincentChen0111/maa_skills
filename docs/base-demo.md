# 基建查询离线演示

运行 `node scripts/base-demo.ts`。演示创建临时 home、私有目录、合成账号和合成游戏表，通过原生安装布局里的唯一共享 CLI 生成 Markdown，结束时清理临时目录。无需网络，不读取已安装 skill 或真实 MAA。

输入与三个固定行为场景共用 [base-scenarios.ts](../eval/maa-account/base-scenarios.ts)。合成干员已持有，精英与等级未知；同槽两个条目阈值分别为精0、1级和精2、1级，交叉表将基础技能的 10% 写成 11%。输出节选：

```text
来源：所提供的数据；本次未从公开镜像获取或核验。
已持有；精英阶段 / 等级：? / ?
合成基础 | 制造站 | 精0 1级 | 待核
合成升级 | 制造站 | 精2 1级 | 待核
交叉核对：compared；2 条差异
game：生产力+10%
cross-check：生产力+11%
```

完整输出保留配方与心情条件，说明百分比不是最终收益。两个技能都待核，未知练度未推为精二。JSON 的同一 `result` 渲染为 `summary`，Markdown 模式原样输出摘要。

`node --test tests/base-query.test.ts tests/base-installation.test.ts` 覆盖阈值、替换、未知项、歧义、缺字段、交叉差异、网络失败和两种原生安装布局。网络测试仅替代 fetch 边界并连接本机临时 HTTP 服务；环境需允许 loopback，不访问外网。这是脚本与安装布局验证，不等于真模型通过。
