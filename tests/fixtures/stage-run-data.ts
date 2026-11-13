import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchStageJobs, prepareStageJobs } from '../../skills/maa-core/scripts/stage-jobs.ts';
import { inspectConfiguration, type MaaProcess, type MaaState } from '../../skills/maa-core/scripts/maa-config.ts';
import { approvedJobFile } from '../../skills/maa-core/scripts/stage-job-plan.ts';
import type { CheckBoundaries } from '../../skills/maa-core/scripts/doctor.ts';
import { stageSnapshot, stageTables, stageJob } from './stage-data.ts';

/** Synthetic MaaCore / GUI log lines in the fixed v6.21.4 shapes. No real device, account or path is used. */
const base = Date.UTC(2026, 10, 13, 2, 0, 0);
export function stamp(second: number): string {
  const date = new Date(base + second * 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
export const syntheticDevice = 'synthetic-device-uuid-0001';
export const syntheticAdb = { adb: 'adb.exe', address: '127.0.0.1:16384', config: 'SyntheticEmulator' };
export function core(second: number, message: string, payload: Record<string, unknown>, processId = 4242): string {
  return `[${stamp(second)}][INF][Px${processId}][Tx31] Assistant::append_callback | ${message} ${JSON.stringify({ ...payload, uuid: syntheticDevice })}`;
}
export function gui(second: number, text: string, level = 'INF'): string {
  return `[${stamp(second)}][${level}]AsstProxy <1> ${text}`;
}
const chain = { taskchain: 'Copilot', taskid: 1 };
const processTask = (second: number, message: string, task: string) => core(second, message, { ...chain, class: 'asst::ProcessTask', subtask: 'ProcessTask', details: { task } });
export function copilotStart(second: number, options: { medicine?: boolean; files?: string[]; singleFile?: boolean } = {}): string[] {
  const list = (options.files ?? []).map((filename, id) => ({ filename, is_raid: false, id }));
  const params = options.singleFile ? { filename: 'synthetic-single.json', formation: true } : { copilot_list: list, formation: true, use_sanity_potion: options.medicine ?? false };
  return [`[${stamp(second)}][INF][Px4242][Tx30] asst::Assistant::append_task Copilot ${JSON.stringify(params)}`,
    `[${stamp(second)}][INF][Px4242][Tx30] asst::Assistant::append_task | task_id: 1`,
    core(second + 1, 'TaskChainStart', chain)];
}
export type AttemptOutcome = 'three-star' | 'not-three-star' | 'failed' | 'no-sanity' | 'start-error' | 'wait-exceeded' | 'open';
export function attempt(second: number, index: number, fileName: string, outcome: AttemptOutcome, extra: string[] = []): string[] {
  const lines = [core(second, 'SubTaskExtraInfo', { ...chain, class: 'asst::MultiCopilotTaskPlugin', what: 'CopilotListLoadTaskFileSuccess', details: { stage_name: 'synthetic', file_name: fileName, id: index } })];
  if (outcome === 'no-sanity' || outcome === 'start-error') {
    if (outcome === 'no-sanity') lines.push(processTask(second + 1, 'SubTaskStart', 'BattleStartPre@UseMedicine'));
    lines.push(core(second + 2, 'SubTaskError', { ...chain, class: 'asst::ProcessTask', subtask: 'ProcessTask', first: ['BattleStartAll'], pre_task: '', details: {} }));
    return [...lines, ...extra];
  }
  lines.push(core(second + 1, 'SubTaskStart', { ...chain, class: 'asst::BattleProcessTask', subtask: 'BattleProcessTask', details: {} }), ...extra);
  if (outcome === 'open') return lines;
  if (outcome === 'wait-exceeded') {
    lines.push(core(second + 30, 'SubTaskExtraInfo', { ...chain, class: 'asst::ProcessTask', subtask: 'ProcessTask', what: 'ExceededLimit', details: { task: 'Copilot@WaitUntilEndOfAction', exec_times: 50, max_times: 50 } }),
      core(second + 31, 'SubTaskError', { ...chain, class: 'asst::ProcessTask', subtask: 'ProcessTask', first: ['Copilot@WaitUntilEndOfAction'], pre_task: 'Copilot@WaitUntilEndOfAction', details: {} }));
    return lines;
  }
  if (outcome === 'failed') lines.push(processTask(second + 20, 'SubTaskStart', 'Copilot@FightMissionFailed'));
  lines.push(processTask(second + 25, 'SubTaskStart', 'Copilot@EndOfAction'));
  if (outcome === 'three-star') lines.push(processTask(second + 26, 'SubTaskStart', 'Copilot@StageDrops-Stars-3'), processTask(second + 26, 'SubTaskCompleted', 'Copilot@StageDrops-Stars-3'));
  else lines.push(core(second + 28, 'SubTaskError', { ...chain, class: 'asst::ProcessTask', subtask: 'ProcessTask', first: ['Copilot@WaitUntilEndOfAction'], pre_task: 'Copilot@EndOfAction', details: {} }));
  return lines;
}
export function chainEnd(second: number, message: 'TaskChainCompleted' | 'TaskChainError' | 'TaskChainStopped', details?: Record<string, unknown>): string[] {
  const lines = [core(second, message, details ? { ...chain, details } : chain)];
  if (message !== 'TaskChainStopped') lines.push(core(second + 1, 'AllTasksCompleted', { ...chain, finished_tasks: [1] }));
  return lines;
}
export const medicineUsed = (second: number, count: unknown) => core(second, 'SubTaskExtraInfo', { ...chain, class: 'asst::MedicineCounterTaskPlugin', subtask: 'MedicineCounterTaskPlugin', what: 'UseMedicine', details: { is_expiring: false, count, medicines: [{ use: count, inventory: 5, expire_days: -1 }] } });
export const medicineConfirm = (second: number) => processTask(second, 'SubTaskStart', 'MedicineConfirm');
export const connection = (second: number, what: string) => core(second, 'ConnectionInfo', { what, why: what === 'Disconnect' ? 'ReconnectFailed' : '', details: syntheticAdb });
export const offlinePopup = (second: number) => processTask(second, 'SubTaskStart', 'OfflineConfirm');
export const drops = (second: number, stageId: string, stageCode: string, stars = 3) => core(second, 'SubTaskExtraInfo', { ...chain, class: 'asst::StageDropsTaskPlugin', what: 'StageDrops', details: { drops: [], stage: { stageCode, stageId }, stars, stats: [] } });

/** One prepared map batch: SYN-1 twice, then SYN-2 once (list indexes 0, 1, 2), prepared through the real unified writer. */
export const runTables = { stages: { ...stageTables.stages,
  synthetic_02: { stageId: 'synthetic_02', code: 'SYN-2', levelId: 'Obt/Synthetic/level_synthetic_02', zoneId: 'synthetic_map', difficulty: 'NORMAL', unlockCondition: [] } } };
export const runRequest = { stages: [{ stageId: 'synthetic_01', code: 'SYN-1', difficulty: 'normal' as const, loops: 2 }, { stageId: 'synthetic_02', code: 'SYN-2', difficulty: 'normal' as const, loops: 1 }],
  completions: { synthetic_00: 'PASS' as const }, completionEvidence: '合成用户本次确认前置通过', maaVersion: 'v6.21.4' };
export const runJobs = () => [stageJob(1), stageJob(2), { ...stageJob(4), content: { ...stageJob(4).content, stage_name: 'synthetic_02' } }];
/** `adb devices` output listing the synthetic address in the given state. */
export const adbListing = (state: 'device' | 'offline') => ({ run: async () => ({ exitCode: 0, stdout: `List of devices attached
${syntheticAdb.address}	${state}
` }) });
/**
 * `home` is the settings home (its config.json names the MAA and private directories). The MAA directory is a healthy
 * CN installation: MAA.exe, a CN client and a configured adb that lists the device online. `boundaries` replaces only
 * the system boundaries the shared checks touch: MAA.exe metadata and adb; `maa.version` is the same MAA.exe metadata
 * boundary for the configuration writer's version stamp.
 */
export type PreparedBatch = { root: string; home: string; maaDirectory: string; privateDirectory: string; operation: string; reportHash: string; files: string[];
  state: MaaState; maa: MaaProcess; boundaries: CheckBoundaries; core(lines: string[]): Promise<void>; gui(lines: string[]): Promise<void>; dispose(): Promise<void> };
/** `syn1Loops` changes how many times SYN-1 is approved (default 2, as above); the list is SYN-1 that many times, then SYN-2. */
export async function preparedBatch(syn1Loops = 2): Promise<PreparedBatch> {
  const root = await mkdtemp(join(tmpdir(), 'maa-stage-run-'));
  try {
    const maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private');
    await mkdir(join(maaDirectory, 'config'), { recursive: true }); await mkdir(join(maaDirectory, 'debug'), { recursive: true });
    await writeFile(join(root, 'config.json'), JSON.stringify({ language: 'zh-CN', languageAsked: true, privateDirectory, maaDirectory, server: 'CN' }));
    await writeFile(join(maaDirectory, 'MAA.exe'), 'synthetic, not an executable');
    await writeFile(join(maaDirectory, syntheticAdb.adb), 'synthetic, not an executable');
    const settings = { RuntimeSettings: { ClientType: 'Official' }, ConnectSettings: { AdbPath: syntheticAdb.adb, Address: syntheticAdb.address } };
    await writeFile(join(maaDirectory, 'config/gui.new.json'), JSON.stringify({ Current: 'Synthetic profile', Configurations: { 'Synthetic profile': { TaskQueue: [], Copilot: { TaskList: [], EnableUserAdditional: true }, Gui: settings } }, Timers: { List: [] } }));
    /** Older than the preparation whenever the tests run: the logs reach back before it, and these lines are never the batch's. */
    const older = -30 * 86400;
    await writeFile(join(maaDirectory, 'debug/asst.log'), `${core(older, 'TaskChainError', { taskchain: 'Copilot', taskid: 9 })}\n`);
    await writeFile(join(maaDirectory, 'debug/gui.log'), `${gui(older, '任务出错: 自动战斗', 'ERR')}\n`);
    const request = { ...runRequest, stages: runRequest.stages.map(stage => stage.stageId === 'synthetic_01' ? { ...stage, loops: syn1Loops } : stage) };
    const snapshot = stageSnapshot(), report = matchStageJobs(snapshot, runTables, request, runJobs());
    const state: MaaState = { running: false, treeExited: true, idle: true, ready: false };
    // `version` is the MAA.exe metadata boundary for the writer's version stamp, the same version the shared checks read.
    const maa: MaaProcess = { inspect: async () => ({ ...state }), close: async () => { Object.assign(state, { running: false, treeExited: true, ready: false }); },
      start: async () => { Object.assign(state, { running: true, treeExited: false, ready: true }); }, version: async () => '6.21.4' };
    const approval = { reportHash: report.hash, reference: '合成用户批准 SYN-1 两次、SYN-2 一次，备选各一份', map: 'synthetic_map',
      selections: [{ stageId: 'synthetic_01', primary: 1, alternates: [2], loops: syn1Loops }, { stageId: 'synthetic_02', primary: 4, alternates: [], loops: 1 }] };
    const result = await prepareStageJobs({ report, approval, snapshot, maaDirectory, privateDirectory, profile: 0, host: 'codex', closedConfirmed: true,
      expectedRevision: (await inspectConfiguration(maaDirectory)).revision }, maa);
    if (result.status !== 'complete') throw new Error('fixture-prepare-failed');
    const files = [...Array<number>(syn1Loops).fill(1), 4].map(id => approvedJobFile(privateDirectory, report.hash, id));
    const append = (file: string) => async (lines: string[]) => { await appendFile(join(maaDirectory, 'debug', file), lines.map(line => line + '\n').join('')); };
    return { root, home: root, maaDirectory, privateDirectory, operation: result.operation, reportHash: report.hash, files, state, maa,
      boundaries: { versionReader: async () => '6.21.4', adb: adbListing('device') },
      core: append('asst.log'), gui: append('gui.log'), dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
