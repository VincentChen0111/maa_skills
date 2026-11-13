# 关卡运行跟踪

共享入口为 `node <本目录>/../maa-core/scripts/stage-run.ts <action>`，JSON 走标准输入。先读偏好，用已保存语言解释结果。脚本对 MAA 只读：读配置摘要、MAA 自己的 `debug/asst.log` 和 `debug/gui.log`、看进程状态；不启动、不关闭、不点游戏、不操作设备，也不改配置。运行记录存在私有目录 `stage-runs/<runId>.json`。

## 开始信号

1. 只跟踪 [关卡作业接口](stage-jobs.md) 里 `prepare` 返回 `complete` 的批次。交接时照常请用户确认地图、难度/环境、列表模式和勾选项。
2. 用户说要点开始时（开始信号），先运行 `start`，再请用户点开始：

   ```json
   {"operation":"<prepare 返回的 operation>","reference":"<用户这次的原话>"}
   ```

   `start` 先记下两份日志的起点（字节偏移、大小、文件身份、末尾哈希），只有起点之后的行算这次运行。用户说已经点过开始时照样运行 `start`，但起点之前的回调不算，结果通常是未知，只能核对。
3. `start` 拒绝时按原因处理：`batch-not-prepared`（没有完成的准备）、`prepared-list-changed`（MAA 里的作业列表和批准的不一致，取消勾选部分条目不算）、`job-file-changed`（作业文件变了）。这三种都先告诉用户，不自行重新准备。

## 跟踪和报告

4. 用 `observe` 持续跟踪，例如 `{"runId":"<runId>","waitSeconds":300}`。最多等 600 秒，一有新发现或运行结束就提前返回；没结束就再调用。`quietSeconds` 只表示多久没有新日志，沉默不算失败。
5. `newFindings` 每条只返回一次，收到就告诉用户：失败、未三星、理智不足、明确超时、环境类失败、MAA 报告的用药、被接管、证据不全、启动失败。转述时带上证据：MAA 的消息名、`what`、子任务和任务名，以及 `screenshots` 里 MAA 自己保存的调试截图路径（只给路径，不打开图片）。
6. 结果分两层，不互相推出：
   - `execution`：`tracking`、`completed`、`failed`、`unknown`。进程退出码为 0 不代表完成；回调里有失败就是失败。
   - `stages[].result`：`not-evaluated`、`success`、`failed`、`not-three-star`、`no-sanity`、`timeout`、`unknown`。有对应回调才评估；运行结束仍没有证据的记为 `unknown`。环境类失败不记为该关失败。
   - `stages[].stageCheck`：只比较掉落回调里的关卡，给 `match`、`mismatch`、`not-fought`、`unknown`。固定版本的自动战斗不发掉落回调，打过的关通常是 `unknown`。
7. `medicine.count` 是 MAA 报告用掉的理智药数，读不到是 `"unknown"`，不要说成 0。`approved` 恒为 0：本项目不为自动战斗授予理智药或碎石。`unapproved` 为 true 或 `"unknown"`、或 `enabledAtStart` 不是 false（MAA 窗口里的「使用理智药」开着或不知道）时，告诉用户，只能停下。
8. 用户说自己正在模拟器或官方 PC 客户端上手动玩、或者手动登录把 MAA 顶下线时，在 `observe` 里带 `{"userReport":{"kind":"manual-play","quote":"<原话>"}}`（手动登录用 `manual-login`）。这按环境类失败处理，不算作业失败。

## 核对和决定

9. `next` 为 `verify` 时运行 `verify`（`{"runId":"<runId>"}`）。它只读：MAA 进程、批准的列表和作业文件、共享 doctor 检查；理智、理智药、源石和关卡进度一律标为未知，不沿用批准时的值，需要时请用户告诉你或重新读取。
10. 核对清楚后 `next` 为 `decide`，由你在 `allowedDecisions` 里选一项并用 `decide` 记录理由：`{"runId":"<runId>","decision":"<选项>","reason":"<理由>"}`。
    - `retry-within-approval`：同一批准范围内重试，请用户自己再点开始，先 `start` 并带 `"retryOf":"<runId>"`。不增加任何药剂或碎石授权，也不改启动方式。
    - `switch-alternate`：换下一份已批准的备选。自动切换由后续工单交付；现在告诉用户结果和已批准的备选，由用户决定。
    - `stop-and-tell-user`：停下告诉用户。
11. 结果未知（证据不全、被 MAA 原生定时或其他任务接管、列表不符或没开列表模式、MAA 进程中断）时只核对，`allowedDecisions` 只有停下：不重新开始、不重打、不换作业。MAA 明确报告失败或未三星时才会出现 `switch-alternate`；理智不足和明确超时只停下告诉用户。
12. 点开始前就连接失败、任务链还没开始时，`execution` 仍是 `tracking`：核对后请用户处理好再点开始，同一次跟踪会接着记录。`start` 之后用户先跑了别的任务（例如日常队列）会被记为接管；要跟踪这一批，就在用户点开始前重新 `start`。
13. 已结束的记录用 `read` 查看（`{"runId":"<runId>"}`，省略时读最近一次）。输出不含设备号、连接地址、作业文件路径、配置名或完整配置，转述时也不要补这些。

## 给后续工单的接口

`stage-run.ts` 导出 `readStageRun`、`summarizeStageRun`、`stageRunOutcome` 和 `StageRunRecord` 类型。`stageRunOutcome` 给出每关的主作业、已批准备选、业务结果、关卡核对、允许的决定和最后一次决定；切换备选由使用它的工单实现。MAA 事实的来源与核对记录在仓库的 `docs/stage-run-sources.md`。
