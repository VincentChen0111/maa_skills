# 关卡运行跟踪

共享入口为 `node <本目录>/../maa-core/scripts/stage-run.ts <action>`，JSON 走标准输入。先读偏好，用已保存语言解释结果。脚本对 MAA 只读：读配置摘要、MAA 自己的 `debug/asst.log` 和 `debug/gui.log`、看进程状态；不启动、不关闭、不点游戏、不操作设备，也不改配置。唯一的例外是换备选的 `switch`（见「换备选」）：判断允许后，经统一写入通道把作业列表换成已批准的备选，写入通道会关闭并重开 MAA；它同样不点游戏、不操作设备，开始仍由用户点。运行记录存在私有目录 `stage-runs/<runId>.json`，换备选的记录在 `stage-runs/switches/`。

## 开始信号

1. 只跟踪 [关卡作业接口](stage-jobs.md) 里 `prepare` 返回 `complete` 的批次。交接时照常请用户确认地图、难度/环境、列表模式和勾选项。
2. 用户说要点开始时（开始信号），先运行 `start`，再请用户点开始：

   ```json
   {"operation":"<prepare 返回的 operation>","reference":"<用户这次的原话>"}
   ```

   `start` 先记下两份日志的起点（字节偏移、大小、文件身份、末尾哈希），只有起点之后的行算这次运行。一批的第一次 `start` 还会搜 MAA 的 Core 日志（`debug/asst.log` 和轮转出的 `asst.bak.log`）：准备开始之后（或时间读不出）有提交或载入这一批作业文件的行，这一批就可能已经跑过或正在跑，`start` 拒绝（`batch-may-have-run`）；准备之前的这类行（同一份报告的上一批、共用作业的另一批）不算；日志够不到准备开始的时候也拒绝（`batch-evidence-incomplete`）。用户说已经点过开始时照样运行 `start`，多半会这样被拒绝：告诉用户这一批没法跟踪，请他自己看游戏，不重开、不重打。
3. `start` 拒绝时按原因处理：`batch-not-prepared`（没有完成的准备）、`prepared-list-changed`（MAA 里的作业列表和批准的不一致，取消勾选部分条目不算）、`job-file-changed`（作业文件变了）。这三种都先告诉用户，不自行重新准备。`finished-items-ticked` 见第 11 条。其余原因（例如 `batch-may-have-run`、`run-unresolved`、`untracked-chain`、`chain-without-start`、`chain-already-started`、`evidence-incomplete`、`outcome-unknown`、`retry-not-decided`）都表示这一批可能又打过、结果未知或没有可用的重试决定：停下告诉用户，不换个说法再试。

## 跟踪和报告

4. 用 `observe` 持续跟踪，例如 `{"runId":"<runId>","waitSeconds":60}`。`waitSeconds` 最多 90，一有新发现或运行结束就提前返回；没结束就再调用。执行这条命令时，宿主的命令超时至少要比 `waitSeconds` 多 30 秒（Claude Code 的 Bash 默认 120 秒；Codex 等宿主按各自的超时参数设置），否则命令会在等待中被宿主中止，那不是跟踪失败，重新 `observe` 即可。`quietSeconds` 只表示多久没有新日志，沉默不算失败。
5. `newFindings` 每条只返回一次，收到就告诉用户：失败、未三星、理智不足、明确超时、环境类失败、MAA 报告的用药、被接管、证据不全、启动失败。转述时带上证据：MAA 的消息名、`what`、子任务和任务名，以及 `screenshots` 里 MAA 自己保存的调试截图路径（只给路径，不打开图片）。
6. 结果分两层，不互相推出：
   - `execution`：`tracking`、`completed`、`failed`、`unknown`。进程退出码为 0 不代表完成；回调里有失败就是失败。
   - `stages[].result`：`not-evaluated`、`success`、`failed`、`not-three-star`、`no-sanity`、`timeout`、`unknown`。有对应回调才评估；运行结束仍没有证据的记为 `unknown`。环境类失败不记为该关失败。
   - `stages[].stageCheck`：只比较掉落回调里的关卡，给 `match`、`mismatch`、`not-fought`、`unknown`。固定版本的自动战斗不发掉落回调，打过的关通常是 `unknown`。
7. `medicine.count` 是 MAA 报告用掉的理智药数，读不到是 `"unknown"`，不要说成 0。`approved` 恒为 0：本项目不为自动战斗授予理智药或碎石。`unapproved` 为 true 或 `"unknown"`、或 `enabledAtStart` 不是 false（MAA 窗口里的「使用理智药」开着或不知道）时，告诉用户，只能停下：这一关失败了、也还有已批准的备选，同样不换备选、不重试，等用户决定。
8. 用户说自己正在模拟器或官方 PC 客户端上手动玩、或者手动登录把 MAA 顶下线时，在 `observe` 里带 `{"userReport":{"kind":"manual-play","quote":"<原话>"}}`（手动登录用 `manual-login`）。这按环境类失败处理，不算作业失败；运行已经结束后才说也一样，最后一项的超时、失败或未三星会改记为未知。

## 核对和决定

9. `next` 为 `verify` 时运行 `verify`（`{"runId":"<runId>"}`）。它只读：MAA 进程、批准的列表和作业文件、共享 doctor 检查；理智、理智药、源石和关卡进度一律标为未知，不沿用批准时的值，需要时请用户告诉你或重新读取。
10. 能不能再打（重试、换备选、重新 `start`）只看脚本的判断，`allowedDecisions`、`decide`、`progress` 和 `start` 用的是同一个判断（整批日志），不要自己推。某一项已经进入战斗或到了结算画面、结果却未知（`unresolvedAttempts` 非空，`next` 为 `ask-progress`）时，只能停下：告诉用户哪一关、哪一次结果未知，请用户自己看游戏并说明这一批里这一关到现在一共打完了几次（包括之前的记录），等用户回答后再用 `progress` 原样记下：`{"runId":"<runId>","reference":"<用户原话>","stages":[{"stageId":"<关卡>","completedRuns":<次数>}]}`。不要替用户填次数；用户说不清就停下，不猜。次数少于回调已经证明打完的次数时 `progress` 拒绝（`progress-contradicts-evidence`）：把 MAA 的证据告诉用户，请他再看一次。
11. 核对清楚、也没有未决的结果后 `next` 为 `decide`，由你在 `allowedDecisions` 里选一项并用 `decide` 记录理由：`{"runId":"<runId>","decision":"<选项>","reason":"<理由>"}`。
    - `retry-within-approval`：同一批准范围内重试。先请用户在 MAA 的作业列表里取消勾选已经打完的条目，以及结果未知、用户也说不清的条目（MAA 只在三星时自己取消勾选），确认后再 `start` 并带 `"retryOf":"<runId>"`，然后请用户点开始。`start` 会读 MAA 保存的勾选状态：每关仍勾选的条目不能多于批准次数减去已打完的次数（用户说明的和回调证明的取较大者），否则拒绝（`finished-items-ticked`），请用户取消勾选后再试。不增加任何药剂或碎石授权，也不改启动方式。一个重试决定只对应一条任务链：重试的任务链开始后，或用户在 `start` 之前自己先点了开始，同一个决定都不能再用。
    - `switch-alternate`：换下一份已批准的备选，见「换备选」。MAA 报告这一关失败或未三星、而这一关还有已批准的备选时，这是批准范围内的正常下一步；环境类失败核对清楚后，由你在重试这一份和换下一份之间选，并写明理由。
    - `stop-and-tell-user`：停下告诉用户。
12. 结果未知（证据不全、被 MAA 原生定时或其他任务接管、列表不符或没开列表模式、MAA 报告用药或用量读不到、理智药开关开着或不知道）时，`allowedDecisions` 只有停下，用户说明进度也不会放开：不重新开始、不重打、不换作业。有还没核对过的环境类失败时也只有停下，先 `verify`。MAA 明确报告失败或未三星时才会出现 `switch-alternate`，而且之后不再出现 `retry-within-approval`（同一份作业不重试）；这一关没有下一份已批准的备选、或者已经没有剩下的次数时也不出现（`alternates` 里这一关的 `next` 为 null），只停下报告。理智不足和明确超时只停下告诉用户。
    判断看整批：从这一批最早一条记录的起点起，MAA Core 日志里的每条 Copilot 任务链都要属于某条记录，日志不能有缺口，不能有找不到任务链开始的 Copilot 回调，每条记录都已结束、结果已知或用户已说明；重试和换备选只对这一批最近一条任务链所属的记录开放。整批层面的原因在 `rerunHold`。这一批里只要有一条记录的任务链开始过、日志里出现过 Copilot 任务链或有缺口，不带 `retryOf` 的 `start` 一律拒绝（`run-unresolved`）；还有记录在跟踪时，`start` 也拒绝。要再跑一整批，请用户重新批准、重新准备。
13. 点开始前就连接失败、任务链还没开始时，`execution` 仍是 `tracking`：核对后请用户处理好再点开始，同一次跟踪会接着记录。用户决定这次不点开始时，用 `decide` 选 `stop-and-tell-user` 关掉这条还没开始的跟踪。`start` 之后用户先跑了别的任务（例如日常队列）会被记为接管；只要从这一批最早的起点以来日志里没有 Copilot 任务链，就可以在用户点开始前重新 `start`。
14. 已结束的记录用 `read` 查看（`{"runId":"<runId>"}`，省略时读最近一次）。输出不含设备号、连接地址、作业文件路径、配置名或完整配置，转述时也不要补这些。

## 换备选

15. 摘要里的 `alternates` 逐关给出当前作业 `job`、下一份已批准的备选 `next` 和还剩几份 `left`。只按批准顺序往后换，不回头用前面那份，也不临时找未经批准的作业；`next` 为 null 就是这一关的备选用完了，停下报告，用户想继续时请他重新查询和批准。
16. 用 `decide` 记下 `switch-alternate` 和理由后，`next` 变为 `switch`。先运行 `maa-config.ts read` 拿到 `revision`，再运行 `switch`：

    ```json
    {"runId":"<runId>","stageId":"<要换的关卡>","expectedRevision":"<此次 read 的 revision>","host":"<codex 或 claude>"}
    ```

    脚本先用同一个判断复核，再经统一写入通道把作业列表换成：这一关换上下一份备选，次数是本批这一关的次数减去已经三星通过的次数（用户说明的次数更大时取用户的），失败或未三星的那一次由备选补上；其他关保留当前作业和剩下的次数。写入沿用这一批的批准原话，只改作业列表（连同关掉额外干员），不改任何 Fight 任务，不加任何药剂或碎石。
17. 返回的 `state`：
    - `prepared`：已经换好，`operation` 是换好的新一批。固定版本的 MAA 没有失败后自己接着换作业的机制，所以要请用户点开始：告诉用户哪一关从哪份作业换成了哪份、各关还剩几次；`unknown` 里的理智、理智药、源石和关卡进度不沿用批准时的值；照常请用户确认地图、难度/环境、列表模式和勾选项。用户说要点开始时，先用这个 `operation` 运行 `start`（见「开始信号」），再请他点开始。之后按新一批跟踪。
    - `rejected`（`next` 为 `retry-switch`）：写入通道在动手之前拒绝了，配置没有变。按 `write.reason` 处理：例如 `closed-confirmation-required` 时告诉用户 MAA 已关闭，用户确认没有在操作后带 `"closedConfirmed":true` 再请求；`configuration-changed` 时重新 `read` 拿新的 `revision`。
    - `unknown` 或 `interrupted`（`next` 为 `verify`）：写入结果未知，或者换的进程中断了。只核对：运行 `verify`，按配置事务流程交给 maa-doctor 核对写入锁；不要再请求换备选，也不要自己改列表。这一批只能停下，用户要继续时重新批准、重新准备。
18. 同一个请求重复提交（例如命令超时后重发）会返回已有的记录（`repeated` 为 true），不会再写一次。同一关同一对作业、但输入不同（例如带了新的 `revision`）时拒绝（`idempotency-conflict`），两份输入的摘要都留在记录里：停下，用 `read` 看已有的换备选记录，告诉用户。
19. 一批只换一次：换的请求交给写入通道后（动手之前被拒绝的除外），原来这一批的 `allowedDecisions` 只剩停下（`switch-requested`），`next` 为 `start-alternate` 时按第 17 条请用户点开始，新一批开始跟踪后变为 `report`。新一批再失败时，按同样的规则换它的下一份备选。

## 给后续工单的接口

`stage-run.ts` 导出 `readStageRun`、`loadBatchView`、`summarizeStageRun`、`stageRunOutcome`、`switchStageRun` 和 `StageRunRecord` 类型；能否再打、能否换备选由 `stage-run-state.ts` 的 `rerunGate` 唯一判断，并且要传入 `loadBatchView` 读到的整批证据（`summarizeStageRun(record, batch)`、`stageRunOutcome(record, batch)`；不传时只允许停下）。`stageRunOutcome` 给出每关的主作业、已批准备选、当前作业和下一份备选、业务结果、关卡核对、允许的决定、最后一次决定和这条记录的换备选。MAA 事实的来源与核对记录在仓库的 `docs/stage-run-sources.md` 和 `docs/stage-alternates-sources.md`。
