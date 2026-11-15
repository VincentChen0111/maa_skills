/**
 * The single owner of the `check-required` result (owner trial item 10; the owner's words, 2026-11-16:
 * 「check required 要给我具体的，和有没有替代」).
 *
 * A CLI that stops because a person or the agent has to verify something emits exactly
 * `{ok: false, status: 'check-required', reason, check, alternatives}`, and only through this module:
 * - `reason` is a stable kebab-case code from the catalogue below;
 * - `check` says what the user or the agent must verify;
 * - `alternatives` lists other ways forward. It is empty only when there is none, and then `check` ends with `noAlternative`.
 *
 * Every text is static: no path, address, account identifier, credential or system message is ever put into it, so the
 * result can be shown and logged as it is. Producers map their own static failure codes to catalogue reasons in
 * `producers`; anything they cannot classify becomes their declared fallback reason, never a reasonless result.
 * Requests refused while standard input was read (`stdin-json.ts`) keep their own rejection and are not check-required.
 */

export type CheckRequired = { ok: false; status: 'check-required'; reason: CheckRequiredReason; check: string; alternatives: string[] };
/** Appended to `check` when a reason has no alternative, so the user is told so rather than left guessing. */
export const noAlternative = '没有替代办法。';

type Group = { readonly reasons: readonly string[]; readonly check: string; readonly alternatives: readonly string[] };

const groups = [
  // Shared by several producers.
  { reasons: ['settings-unreadable'], check: '设置文件读不了（被占用、没有权限或已损坏），脚本没有继续，什么都没改。',
    alternatives: ['运行 maa-doctor 的检查，核对设置和私有文件', '由用户经 maa-setup 重新保存设置（语言、私有目录、MAA 目录）'] },
  { reasons: ['maa-directory-unset'], check: '设置里还没有 MAA 目录，脚本不能读取或改动 MAA 的配置和日志。',
    alternatives: ['经 maa-setup 设置 MAA 目录后重试'] },
  { reasons: ['maa-config-unreadable'], check: 'MAA 配置（config/gui.new.json）读不了，或不是本工具认识的格式；什么都没改。',
    alternatives: ['确认设置里的 MAA 目录正确，并且 MAA 至少正常启动、退出过一次', '运行 maa-doctor 的检查，核对 MAA 安装与配置'] },
  { reasons: ['account-save-failed'], check: '账号快照可能没有保存：私有目录不可写，或保存途中出错。原来的快照文件只会被完整替换，不会写一半。',
    alternatives: ['确认私有目录存在且可写后重试导入', '只想看一眼时用 inspect（只读，不保存）'] },

  // stage-jobs.ts
  { reasons: ['stage-jobs-request-invalid'], check: '请求不符合关卡作业接口（动作、字段或取值不对），什么都没做。',
    alternatives: ['按 maa-daily 的关卡作业接口（stage-jobs.md）改正请求后重发'] },
  { reasons: ['stage-jobs-scope-invalid'], check: '关卡范围和固定关卡表对不上：stageId、代号、难度或次数不对，或者同一关写了两次；什么都没查。',
    alternatives: ['先运行 stages 取精确的 stageId 和难度，再按用户本次指定的关卡重新 query', '每关次数写 1 到 1000'] },
  { reasons: ['stage-jobs-operator-facts-invalid'], check: 'request.operatorFacts 写法不对：每位干员只能写一条，source 必须是 user-confirmed，要带用户原话 reference，并且只写 skillLevel（1–7）、mastery（技能 1–3 的专精 0–3）、moduleTypes（X、Y、A、D、B 的模组等级 0–3）中至少一项。什么都没查。',
    alternatives: ['按 stage-jobs.md 的 operatorFacts 格式改正后重发', '去掉 operatorFacts，相关要求保持待核'] },
  { reasons: ['stage-jobs-job-confirmations-invalid'], check: 'request.jobConfirmations 写法不对：每份作业最多一项，每项只写 jobId、contentHash（报告里这份作业的原文指纹）、source（必须是 user-confirmed）和用户原话 reference。什么都没查。',
    alternatives: ['按 stage-jobs.md 的 jobConfirmations 格式改正后重发', '去掉 jobConfirmations，相关项保持待核'] },
  { reasons: ['stage-jobs-snapshot-missing'], check: '找不到账号快照：没传 snapshotFile 时读私有目录的 MAA 识别快照，没有它时读森空岛快照；传了时读它指的那份。没有快照就不能核对练度。',
    alternatives: ['转 maa-account 导入 MAA 识别快照', '用森空岛快照（有逐技能专精和模组）：先由 maa-account 读取森空岛，再重新查询（会自动选用），或传 snapshotFile 指向它'] },
  { reasons: ['stage-jobs-snapshot-unreadable'], check: '账号快照读不了，或不是账号快照的格式。',
    alternatives: ['转 maa-account 重新导入或读取快照', '改用另一份快照（MAA 识别或森空岛），用 snapshotFile 指定'] },
  { reasons: ['stage-jobs-input-file-unreadable'], check: '请求里的离线文件（tablesFile 或 jobsFile）读不了，或不是合法的 JSON。',
    alternatives: ['核对文件路径和内容后重发', '省略这两个字段，改用固定公开关卡表和作业站在线查询'] },
  { reasons: ['stage-jobs-tables-unavailable'], check: '固定公开关卡表没能读到（网络、HTTP 或内容校验失败），这次没有查询作业。',
    alternatives: ['稍后重试 query', '用户提供关卡表文件时，用 tablesFile 离线核对'] },
  { reasons: ['stage-jobs-site-unavailable'], check: '作业站（prts.maa.plus）查询失败，或返回的内容不合格；这次没有候选。',
    alternatives: ['稍后重试 query', '用户自己从作业站下载作业文件后，用 jobsFile 离线核对（报告会写明没有经过本次在线检索）',
      '用户自己在 MAA 的自动战斗页导入作业（不经本工具，没有练度核对和运行跟踪）'] },
  { reasons: ['stage-jobs-report-missing'], check: '私有目录里没有这份报告：reportHash 不对，或者 query 时没有加 saveReport: true。',
    alternatives: ['用 saveReport: true 重新 query，请用户按新报告批准'] },
  { reasons: ['stage-jobs-report-stale'], check: '这份报告不能再核对：报告文件被改过，或者是旧版本工具生成的。什么都没写。',
    alternatives: ['重新 query 并保存报告，请用户按新报告重新批准'] },
  { reasons: ['stage-jobs-snapshot-changed'], check: '账号快照在报告生成之后变了，或者这次读的不是生成报告的那份快照（MAA 识别快照和森空岛快照是两份）。什么都没写。',
    alternatives: ['prepare 传与 query 相同的 snapshotFile 重试', '重新 query，请用户按新报告重新批准'] },
  { reasons: ['stage-jobs-approval-mismatch'], check: '批准和报告对不上：地图、关卡、次数、作业 ID、配置序号，或者缺少批准原话。什么都没写。',
    alternatives: ['按报告逐项重填 approval：同一地图、同一难度批次、原循环次数、报告里的作业 ID 和用户的批准原话', '次数或范围要变时重新 query，请用户重新批准'] },
  { reasons: ['stage-jobs-support-not-named'], check: '需借助战的作业没有在 supportJobs 里点名，或者点名的作业不是需借助战。什么都没写。',
    alternatives: ['用户本次点名同意借助战后，把作业 ID 写进该关的 supportJobs', '改选 ready 的作业'] },
  { reasons: ['stage-jobs-candidate-not-ready'], check: '批准的作业不是 ready：仍有待核（unknown）或已知不满足（blocked）的要求，逐项原因在报告的 requirements 和 reasons 里。什么都没写。',
    alternatives: ['改选 ready 的作业', '待核的专精或模组：有森空岛快照时传 snapshotFile 用它核对；或请用户确认后写进 request.operatorFacts，重新 query',
      '描述里的额外条件核实后写进 request.documentChecks，重新 query'] },
  { reasons: ['stage-jobs-batch-too-large'], check: '这一批展开后超过 1000 项（每关次数相加），没有写入，也不会静默截断。',
    alternatives: ['请用户把这一批拆成几次批准和准备'] },
  { reasons: ['stage-jobs-batch-mixed'], check: '这一批混了不同的难度或环境（普通/突袭、难度组），MAA 的列表导航不能证明会自动切换，没有写入。',
    alternatives: ['按地图、普通/突袭和难度组分批批准和准备'] },
  { reasons: ['stage-jobs-job-file-conflict'], check: '私有目录里同一报告、同一作业的文件已经存在，内容却不同，可能被改过；没有写 MAA 配置。',
    alternatives: ['重新 query 生成新报告，请用户按新报告批准'] },
  { reasons: ['stage-jobs-query-failed'], check: '查询遇到未分类的错误，这次没有候选。query 和 stages 不写 MAA 配置；只有加了 saveReport 时才可能写下报告文件。',
    alternatives: ['重试一次 query', '仍然失败时，用户可以自己在 MAA 自动战斗页导入作业（没有练度核对和运行跟踪）'] },
  { reasons: ['stage-jobs-prepare-outcome-unknown'], check: '准备遇到未分类的错误：作业文件可能已经写进私有目录，配置事务可能没开始，也可能没做完，结果不确定。',
    alternatives: ['不要直接重试 prepare：先运行 maa-config.ts read 核对作业列表和写入锁，结果未知时交 maa-doctor 核对'] },

  // stage-run.ts: its own reasons are already specific; each still says what to check and what else can be done.
  { reasons: ['action-invalid', 'request-invalid', 'operation-invalid', 'wait-invalid', 'user-report-invalid', 'exit-code-invalid', 'decision-invalid',
    'progress-invalid', 'revision-required', 'stage-invalid', 'run-id-invalid', 'switch-key-invalid'],
  check: '请求不符合运行跟踪接口（动作、字段或取值不对），什么都没做。', alternatives: ['按 maa-daily 的运行跟踪接口（stage-run.md）改正请求后重发'] },
  { reasons: ['reference-required', 'reason-required'], check: '必填的一项缺少、为空或超过 500 字：start、progress 要用户这次的原话 reference，decide 要选这个决定的理由 reason；什么都没记。',
    alternatives: ['补上 reference（用户原话）或 reason（决定的理由）后重发；原话超过 500 字时，摘取用户表态的那一句（仍是原话）'] },
  { reasons: ['maa-directory-required'], check: '运行跟踪没有拿到 MAA 目录，不能读 MAA 日志。', alternatives: ['经 maa-setup 设置 MAA 目录后重试'] },
  { reasons: ['run-not-found', 'run-record-invalid', 'switch-record-invalid'], check: '找不到这条运行或换备选记录，或者记录读不了。',
    alternatives: ['用 read（不带 runId）查看最近一次运行', '记录损坏时交 maa-doctor 核对私有文件'] },
  { reasons: ['run-busy'], check: '另一个运行跟踪命令正在处理同一批或同一条记录。', alternatives: ['等它返回后再试'] },
  { reasons: ['batch-not-prepared'], check: '这一批没有完成的准备：关卡作业的 prepare 没有返回 complete，或者没有批准原话。',
    alternatives: ['先按关卡作业接口完成 prepare，再 start'] },
  { reasons: ['prepared-list-changed'], check: 'MAA 里的作业列表和批准准备的那一份不一致（只取消勾选部分条目不算）。',
    alternatives: ['告诉用户，由用户决定是否在 MAA 里恢复列表，或者重新准备这一批'] },
  { reasons: ['job-file-changed', 'job-plan-invalid', 'job-list-too-large', 'job-mixed-difficulty-batch'], check: '已批准的作业文件或作业计划变了、读不了，或者超出一批的范围。',
    alternatives: ['告诉用户；要继续时重新查询、批准和准备这一批'] },
  { reasons: ['batch-may-have-run', 'batch-evidence-incomplete', 'batch-evidence-unavailable', 'untracked-chain', 'chain-without-start', 'chain-already-started',
    'evidence-incomplete', 'evidence-inconsistent', 'outcome-unknown', 'taken-over', 'list-mismatch', 'list-unreadable', 'not-latest-run', 'start-failure', 'gui-error-conflict'],
  check: '这一批可能已经又打过、日志有缺口或对不上、被其他任务接管、启动失败，或者结果未知，脚本的再打判断不放行。',
  alternatives: ['请用户自己看游戏确认进度；不重开、不重打、不换作业', '用户要继续时重新查询、批准、准备一批'] },
  { reasons: ['medicine-used', 'medicine-unknown', 'medicine-toggle'], check: 'MAA 报告用了理智药、用量读不到，或者 MAA 窗口里的「使用理智药」开着或不知道。本项目不为自动战斗授予理智药，脚本不放行再打。',
    alternatives: ['告诉用户，停下等用户决定；用户要关掉理智药时，按配置事务接口经当次批准修改'] },
  { reasons: ['run-unresolved', 'run-tracking', 'tracking'], check: '这一批还有记录在跟踪，或者已经有任务链开始过、结果还没定。',
    alternatives: ['还在跟踪的记录用 observe 跟到运行结束', '结果未知时请用户说明这一关到现在一共打完几次，用 progress 记下', '要再跑一整批时请用户重新批准、重新准备'] },
  { reasons: ['not-verified'], check: '有环境类失败还没核对。', alternatives: ['先运行 verify'] },
  { reasons: ['retry-not-decided'], check: '没有可用的重试决定：没有 decide retry-within-approval，或者这个决定已经用过。',
    alternatives: ['只从摘要的 allowedDecisions 里选，先用 decide 记下决定', '停下告诉用户'] },
  { reasons: ['switch-not-decided'], check: '还没有用 decide 记下 switch-alternate，不能换备选。',
    alternatives: ['allowedDecisions 里有 switch-alternate 时先 decide，再 switch', '停下告诉用户'] },
  { reasons: ['decision-not-allowed', 'no-reported-failure', 'no-environment-failure', 'job-failure-reported'], check: '这个决定不在当前允许的决定里，或者和 MAA 报告的结果不符。',
    alternatives: ['只从摘要的 allowedDecisions 里选', '停下告诉用户'] },
  { reasons: ['switch-requested'], check: '这一批已经请求过换备选，原来这一批只能停下。',
    alternatives: ['换好时按新一批的 operation 运行 start', '换的结果未知时运行 verify，交 maa-doctor 核对写入锁'] },
  { reasons: ['switch-stage-mismatch'], check: '要换的关卡不是这一批最近失败或未三星的那一关。', alternatives: ['用摘要 alternates 里那一关的 stageId 重新 switch'] },
  { reasons: ['alternates-exhausted', 'no-stage-to-switch', 'nothing-left-to-switch'], check: '这一关没有下一份已批准的备选，或者已经没有剩下的次数。',
    alternatives: ['停下报告；用户想继续时重新查询和批准'] },
  { reasons: ['finished-items-ticked'], check: 'MAA 作业列表里仍然勾选的条目，多于这一关剩下的次数。',
    alternatives: ['请用户在作业列表里取消勾选已经打完和结果未知的条目，确认后再 start'] },
  { reasons: ['progress-contradicts-evidence'], check: '用户说的次数少于已经记下的次数，或者少于 MAA 回调已经证明打完的次数；记下的次数不会往下改。',
    alternatives: ['把已经记下的次数和 MAA 的证据告诉用户，请用户再看一次游戏'] },
  { reasons: ['idempotency-conflict'], check: '同一关同一对作业已经有换备选记录，这次的输入和它不同（例如带了新的 revision）。',
    alternatives: ['用 read 查看已有的换备选记录，告诉用户'] },
  { reasons: ['close-not-allowed', 'start-not-allowed'], check: '运行跟踪试图关闭或启动 MAA，被拒绝：只有 switch 经统一写入通道可以重开 MAA。这是工具缺陷，请报告问题。', alternatives: [] },
  { reasons: ['stage-run-failed'], check: '运行跟踪遇到未分类的错误。switch 时写入结果可能未知；其他动作对 MAA 只读，可能只记下了部分运行记录。',
    alternatives: ['switch：不要重发，先运行 verify，再交 maa-doctor 核对写入锁', '其他动作：用 read 查看记录后再决定'] },

  // maa-config.ts (the CLI outside the transaction; the transaction itself reports rejected/unknown with its own reasons).
  { reasons: ['maa-config-request-invalid'], check: '请求不符合配置事务接口（动作或字段不对），什么都没做。',
    alternatives: ['按 maa-daily 的配置事务接口（configuration.md）改正请求后重发'] },
  { reasons: ['base-apply-route-required'], check: '已批准的基建排班只能经 base-apply.ts 应用（它会先重新核对全部检查），配置写入器不直接接受。什么都没做。',
    alternatives: ['改用 base-apply.ts：先 check，再 apply'] },
  { reasons: ['job-continuation-route-required'], check: '关卡作业的续接（换备选）只能经 stage-run.ts switch 写入，配置写入器不直接接受。什么都没做。',
    alternatives: ['按运行跟踪接口用 decide 和 switch 换备选'] },
  { reasons: ['maa-config-read-failed'], check: '读取配置摘要遇到未分类的错误；read 只读，什么都没改。',
    alternatives: ['重试一次 read', '运行 maa-doctor 的检查，核对 MAA 安装与配置'] },
  { reasons: ['maa-config-preview-failed'], check: '预览遇到未分类的错误；预览只读，不关 MAA、不加锁，什么都没改。',
    alternatives: ['重试一次 preview', '运行 maa-doctor 的检查，核对 MAA 安装与配置'] },
  { reasons: ['maa-config-write-outcome-unknown'], check: '写入遇到未分类的错误。写入可能已经开始，结果不确定。',
    alternatives: ['不要重放这次写入：先运行 read 核对，再交 maa-doctor 核对写入锁和运行记录'] },

  // account-snapshot.ts (only its fallback; its other refusals keep their own error codes)
  { reasons: ['account-input-unreadable'], check: 'MAA 识别结果文件或 MAA 识别缓存读不了（不存在、没有权限或被占用），没有导入。',
    alternatives: ['在 MAA 里重新运行仓库识别和干员识别，再导入', '改用森空岛读取（maa-account 的森空岛接口）'] },
  { reasons: ['account-import-failed'], check: '读取或导入 MAA 识别结果遇到未分类的错误。inspect 不保存；import 的快照可能没有保存，或保存结果不确定。',
    alternatives: ['先用 inspect 只读查看识别结果，再决定是否重试 import', '改用森空岛读取（maa-account 的森空岛接口）'] },

  // skland-account.ts
  { reasons: ['skland-request-invalid'], check: '请求不符合森空岛接口（动作或字段不对），什么都没读、什么都没写。',
    alternatives: ['按 maa-account 的森空岛接口（skland.md）改正请求后重发'] },
  { reasons: ['skland-snapshot-unreadable'], check: '要比较的快照读不了，或不是账号快照的格式；没有比较。',
    alternatives: ['转 maa-account 重新导入 MAA 识别快照或重新读取森空岛', '用 maaFile 或 sklandFile 指定另一份快照'] },
  { reasons: ['skland-read-failed'], check: '森空岛读取遇到未分类的错误；不会自动重放，快照没有保存或保存结果不确定。',
    alternatives: ['稍后重试 import', '先用 inspect 只读查看能否读到', '改用 MAA 识别快照（maa-account 的导入接口）'] },

  // base-query.ts
  { reasons: ['base-snapshot-missing'], check: '找不到账号快照（默认读私有目录的 account-snapshot.json，或请求里 snapshotFile 指的那份）。',
    alternatives: ['转 maa-account 导入 MAA 识别快照', '传 snapshotFile 指向森空岛快照 account-snapshot-skland.json'] },
  { reasons: ['base-tables-file-unreadable'], check: '请求里的 tablesFile 读不了，或不是合法的 JSON。',
    alternatives: ['核对文件后重发', '省略 tablesFile，改读固定公开表'] },
  { reasons: ['base-query-failed'], check: '基建技能查询遇到未分类的错误；查询只读，什么都没改。',
    alternatives: ['重试一次', '换另一份快照（snapshotFile）再查'] },

  // credentials.ts check
  { reasons: ['credentials-check-incomplete'], check: '凭据检查没有完成，不能说明凭据可用还是不可用；检查只读，什么都没改。',
    alternatives: ['稍后重新运行 credentials.ts check', '运行 maa-doctor 的检查，核对私有目录和凭据'] },

  // preferences.ts
  { reasons: ['preferences-set-unconfirmed'], check: '设置可能已经改了，也可能没改。',
    alternatives: ['先用 read 核对，再决定是否补做 set；不要直接重发'] },
  { reasons: ['preferences-append-unconfirmed'], check: '偏好原话可能已经记上，也可能没记上；read 看不到原话。',
    alternatives: ['告诉用户这条原话可能没有记上，由用户决定是否重记'] },
  { reasons: ['preferences-read-failed'], check: '读取设置遇到未分类的错误；read 只读，什么都没改。',
    alternatives: ['重试一次 read', '运行 maa-doctor 的检查，核对设置和私有文件'] },

  // setup.ts
  { reasons: ['setup-files-unwritable'], check: 'setup 要写的私有目录或下载位置建不了、写不进（路径被文件占用、没有权限或被占用）。',
    alternatives: ['确认私有目录的路径不是文件、有写权限后重试', '经 maa-setup 换一个私有目录'] },
  { reasons: ['setup-failed'], check: '接入流程遇到未分类的错误。check、downloads 只读；prepare、apply、download 等动作可能已经做了一部分。',
    alternatives: ['重新运行 setup.ts check --json 看当前状态，再按结果继续', '运行 maa-doctor 的检查'] },
] as const satisfies readonly Group[];

export type CheckRequiredReason = (typeof groups)[number]['reasons'][number];

const catalogue = new Map<string, { check: string; alternatives: readonly string[] }>();
for (const group of groups) for (const reason of group.reasons) {
  if (catalogue.has(reason)) throw new Error(`check-required-duplicate:${reason}`);
  catalogue.set(reason, { check: group.alternatives.length ? group.check : group.check.endsWith(noAlternative) ? group.check : group.check + noAlternative, alternatives: group.alternatives });
}
/** Every reason the catalogue defines, in catalogue order. */
export const checkRequiredReasons = [...catalogue.keys()] as CheckRequiredReason[];

/**
 * Per producer: the static failure codes (or Node error codes) it may hit, mapped to a catalogue reason, and the fallback
 * for anything unclassified. A producer that already throws catalogue reasons maps them to themselves.
 */
const self = <T extends CheckRequiredReason>(...reasons: T[]) => Object.fromEntries(reasons.map(reason => [reason, reason])) as Record<T, T>;
const stageRunOwn = ['action-invalid', 'request-invalid', 'reference-required', 'reason-required', 'operation-invalid', 'wait-invalid', 'user-report-invalid', 'exit-code-invalid', 'decision-invalid',
  'progress-invalid', 'revision-required', 'stage-invalid', 'run-id-invalid', 'switch-key-invalid', 'maa-directory-unset', 'maa-directory-required', 'run-not-found',
  'run-record-invalid', 'switch-record-invalid', 'run-busy', 'batch-not-prepared', 'prepared-list-changed', 'job-file-changed', 'job-plan-invalid', 'job-list-too-large',
  'job-mixed-difficulty-batch', 'batch-may-have-run', 'batch-evidence-incomplete', 'batch-evidence-unavailable', 'untracked-chain', 'chain-without-start',
  'chain-already-started', 'evidence-incomplete', 'evidence-inconsistent', 'outcome-unknown', 'taken-over', 'list-mismatch', 'list-unreadable', 'not-latest-run',
  'start-failure', 'gui-error-conflict', 'medicine-used', 'medicine-unknown', 'medicine-toggle', 'run-unresolved', 'run-tracking',
  'tracking', 'not-verified', 'retry-not-decided', 'switch-not-decided', 'decision-not-allowed', 'no-reported-failure', 'no-environment-failure', 'job-failure-reported',
  'switch-requested', 'switch-stage-mismatch', 'alternates-exhausted', 'no-stage-to-switch', 'nothing-left-to-switch', 'finished-items-ticked',
  'progress-contradicts-evidence', 'idempotency-conflict', 'close-not-allowed', 'start-not-allowed', 'settings-unreadable'] as const;

export const producers = {
  'stage-jobs': { fallback: 'stage-jobs-query-failed', codes: {
    'action-invalid': 'stage-jobs-request-invalid', 'request-invalid': 'stage-jobs-request-invalid', 'object-required': 'stage-jobs-request-invalid',
    'text-required': 'stage-jobs-request-invalid', 'approval-invalid': 'stage-jobs-request-invalid', 'stage-code-required': 'stage-jobs-scope-invalid',
    'scope-invalid': 'stage-jobs-scope-invalid', 'stage-identity-mismatch': 'stage-jobs-scope-invalid', 'loops-invalid': 'stage-jobs-scope-invalid',
    'duplicate-stage': 'stage-jobs-scope-invalid', 'search-coverage-invalid': 'stage-jobs-input-file-unreadable', 'jobs-invalid': 'stage-jobs-input-file-unreadable',
    'job-network-failed': 'stage-jobs-site-unavailable', 'job-response-empty': 'stage-jobs-site-unavailable', 'job-response-too-large': 'stage-jobs-site-unavailable',
    'job-api-rejected': 'stage-jobs-site-unavailable', 'job-query-invalid': 'stage-jobs-site-unavailable', 'job-detail-invalid': 'stage-jobs-site-unavailable',
    'job-id-invalid': 'stage-jobs-site-unavailable', 'public-data-input-invalid': 'stage-jobs-tables-unavailable', 'public-data-network-failed': 'stage-jobs-tables-unavailable',
    'public-data-http-failed': 'stage-jobs-tables-unavailable', 'public-data-too-large': 'stage-jobs-tables-unavailable', 'public-data-json-invalid': 'stage-jobs-tables-unavailable',
    'job-plan-invalid': 'stage-jobs-approval-mismatch', 'job-list-too-large': 'stage-jobs-batch-too-large', 'job-mixed-difficulty-batch': 'stage-jobs-batch-mixed',
    'approval-mismatch': 'stage-jobs-approval-mismatch', 'approval-requires-ready-candidate': 'stage-jobs-candidate-not-ready', 'job-file-conflict': 'stage-jobs-job-file-conflict',
    'maa-directory-unset': 'maa-directory-unset', 'settings-unreadable': 'settings-unreadable',
    ...self('stage-jobs-request-invalid', 'stage-jobs-scope-invalid', 'stage-jobs-operator-facts-invalid', 'stage-jobs-job-confirmations-invalid', 'stage-jobs-snapshot-missing', 'stage-jobs-snapshot-unreadable', 'stage-jobs-input-file-unreadable',
      'stage-jobs-tables-unavailable', 'stage-jobs-site-unavailable', 'stage-jobs-report-missing', 'stage-jobs-report-stale', 'stage-jobs-snapshot-changed',
      'stage-jobs-approval-mismatch', 'stage-jobs-support-not-named', 'stage-jobs-candidate-not-ready', 'stage-jobs-job-file-conflict', 'stage-jobs-batch-too-large',
      'stage-jobs-batch-mixed', 'stage-jobs-prepare-outcome-unknown') } },
  'stage-run': { fallback: 'stage-run-failed', codes: { ...self(...stageRunOwn), 'configuration-invalid': 'maa-config-unreadable' } },
  'maa-config': { fallback: 'maa-config-read-failed', codes: { 'action-invalid': 'maa-config-request-invalid', 'request-invalid': 'maa-config-request-invalid',
    'object-required': 'maa-config-request-invalid', 'configuration-invalid': 'maa-config-unreadable', ENOENT: 'maa-config-unreadable',
    ...self('settings-unreadable', 'maa-directory-unset', 'maa-config-unreadable', 'base-apply-route-required', 'job-continuation-route-required', 'maa-config-preview-failed',
      'maa-config-write-outcome-unknown') } },
  'account-snapshot': { fallback: 'account-import-failed', codes: self('settings-unreadable', 'account-input-unreadable', 'account-save-failed') },
  'skland-account': { fallback: 'skland-read-failed', codes: { 'unknown-action': 'skland-request-invalid', 'invalid-request': 'skland-request-invalid',
    'object-required': 'skland-request-invalid', ...self('settings-unreadable', 'skland-snapshot-unreadable', 'account-save-failed') } },
  'base-query': { fallback: 'base-query-failed', codes: self('settings-unreadable', 'base-snapshot-missing', 'base-tables-file-unreadable') },
  credentials: { fallback: 'credentials-check-incomplete', codes: {} },
  preferences: { fallback: 'preferences-read-failed', codes: self('settings-unreadable', 'preferences-set-unconfirmed', 'preferences-append-unconfirmed') },
  setup: { fallback: 'setup-failed', codes: { ENOTDIR: 'setup-files-unwritable', EEXIST: 'setup-files-unwritable', EACCES: 'setup-files-unwritable',
    EPERM: 'setup-files-unwritable', ...self('settings-unreadable', 'setup-files-unwritable') } },
} as const satisfies Record<string, { fallback: CheckRequiredReason; codes: Record<string, CheckRequiredReason> }>;
export type CheckRequiredProducer = keyof typeof producers;

/** Thrown where the failing step knows the reason; a CLI catch-all keeps it as it is. */
export class CheckRequiredError extends Error {
  readonly reason: CheckRequiredReason;
  constructor(reason: CheckRequiredReason) { super(reason); this.name = 'CheckRequiredError'; this.reason = reason; }
}

/** The one constructor of the result. Unknown reasons are a programming error and throw. */
export function checkRequired(reason: CheckRequiredReason): CheckRequired {
  const entry = catalogue.get(reason);
  if (!entry) throw new Error('check-required-unknown-reason');
  return { ok: false, status: 'check-required', reason, check: entry.check, alternatives: [...entry.alternatives] };
}

/** The one predicate: exactly this shape, a catalogue reason, and texts equal to the catalogue's. */
export function isCheckRequired(value: unknown): value is CheckRequired {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== 'alternatives,check,ok,reason,status' || record.ok !== false || record.status !== 'check-required') return false;
  if (typeof record.reason !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(record.reason)) return false;
  const entry = catalogue.get(record.reason);
  return !!entry && record.check === entry.check && Array.isArray(record.alternatives) && record.alternatives.length === entry.alternatives.length
    && record.alternatives.every((item, index) => item === entry.alternatives[index]);
}

/** The reason a producer's catch-all reports for an error: a thrown reason, a mapped static or Node code, or its fallback. */
export function checkRequiredReason(producer: CheckRequiredProducer, error: unknown, fallback?: CheckRequiredReason): CheckRequiredReason {
  if (error instanceof CheckRequiredError) return error.reason;
  const table = producers[producer].codes as Record<string, CheckRequiredReason>;
  const message = error instanceof Error ? error.message : undefined;
  if (message !== undefined && Object.hasOwn(table, message)) return table[message]!;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && Object.hasOwn(table, code)) return table[code]!;
  return fallback ?? producers[producer].fallback;
}

/** The result a producer's catch-all prints. */
export function checkRequiredFor(producer: CheckRequiredProducer, error: unknown, fallback?: CheckRequiredReason): CheckRequired {
  return checkRequired(checkRequiredReason(producer, error, fallback));
}
