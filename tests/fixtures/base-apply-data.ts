import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftBaseReport, approveBaseReportItems } from '../../skills/maa-core/scripts/base-report.ts';
import { recordReviewSkip, saveAdviceReport, loadAdviceReport } from '../../skills/maa-core/scripts/advice-report.ts';
import { nameTable, planInput, planSnapshot, planTables } from './base-plan-data.ts';

// Synthetic worlds for applying an approved base plan (ticket 23): a synthetic MAA GUI configuration with one Infrast
// task, and a base report drafted by the real ticket 22 tools from the synthetic roster. Only the MAA process is faked.
export const goals = { source: 'user-stated', text: '我想要龙门币和赤金稳定' };
const rooms = ['Mfg', 'Trade', 'Control', 'Power', 'Reception', 'Office', 'Recycle', 'Dorm', 'Processing', 'Training'];

/** MAA v6.21.4 writes enums as names and leaves IsEnabled out of a RoomList entry when the room is enabled. */
export function infrastConfig(options: { timers?: boolean; roomOff?: string; mode?: string | number } = {}) {
  return {
    Current: 'synthetic', ConfigVersion: 1,
    Configurations: { synthetic: {
      Gui: { ConnectSettings: { Address: 'synthetic-secret-address' }, RuntimeSettings: { StartGame: false } },
      TaskQueue: [
        { $type: 'FightTask', TaskType: 'Fight', IsEnable: false, UseStone: false, UseMedicine: false, MedicineCount: 0, UseExpiringMedicine: false, UseExpireMedicineForActivity: false, StagePlan: ['1-7'] },
        { $type: 'InfrastTask', TaskType: 'Infrast', IsEnable: true, Mode: options.mode ?? 'Normal', UsesOfDrones: 'Money', DormThreshold: 30, ContinueTraining: false,
          UseWeeklySchedule: false, CustomFileType: '153_layout_3_times_a_day.json', Filename: 'resource/custom_infrast/153_layout_3_times_a_day.json', PlanSelect: 0,
          RoomList: [...rooms.map(room => room === options.roomOff ? { Room: room, IsEnabled: false } : { Room: room }), { Room: 'AssistantChange', IsEnabled: false }] },
      ],
    } },
    Timers: { List: [{ Id: 0, IsEnabled: options.timers ? true : false, Config: 'synthetic', Hour: 8, Minute: 0 }, { Id: 1, IsEnabled: options.timers ? true : false, Config: 'synthetic', Hour: 20, Minute: 0 }],
      CustomConfig: false, ForceScheduledStart: false, ShowWindowBeforeForceScheduledStart: false, NotifyBeforeScheduledStart: false, ScheduledStartNotificationMinutes: 5 },
    UnknownSetting: { keep: 'synthetic-unknown-field' },
  };
}

export type ApplyHome = { home: string; maa: string; configFile: string; tablesFile: string; reportHash: string; reference: string };
/** A temporary home with settings, snapshot, MAA directory (name table and GUI configuration) and a saved base report. */
export async function applyHome(options: { input?: Record<string, unknown>; approve?: boolean; config?: unknown; baseFile?: unknown } = {}): Promise<ApplyHome> {
  const home = await mkdtemp(join(tmpdir(), 'maa-base-apply-')), maa = join(home, 'maa'), tablesFile = join(home, 'base-tables.json');
  await mkdir(join(maa, 'resource'), { recursive: true }); await mkdir(join(maa, 'config'), { recursive: true });
  if (options.baseFile !== undefined) {
    // An existing plan file the account edits: fields this tool does not know must survive into the applied copy.
    await mkdir(join(home, 'base-plans'), { recursive: true });
    await writeFile(join(home, 'base-plans', 'base.json'), JSON.stringify(options.baseFile));
    options = { ...options, input: { base: 'base-plans/base.json', ...options.input } };
  }
  await writeFile(join(maa, 'resource', 'battle_data.json'), JSON.stringify(nameTable()));
  await writeFile(join(maa, 'config', 'gui.new.json'), JSON.stringify(options.config ?? infrastConfig(), null, 2));
  await writeFile(join(home, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: home, maaDirectory: maa }));
  await writeFile(join(home, 'account-snapshot.json'), JSON.stringify(planSnapshot()));
  await writeFile(tablesFile, JSON.stringify(planTables()));
  const drafted = await draftBaseReport({ goals, ...planInput(), tablesFile, ...options.input }, { home, now: () => new Date('2026-11-13T09:00:00.000Z') });
  if (drafted.status !== 'saved') throw new Error(`fixture draft: ${JSON.stringify(drafted)}`);
  await recordReviewSkip(home, 'base', drafted.reportHash, { userWords: '这次跳过审查' });
  if (options.approve !== false) await approveBaseReportItems(home, drafted.reportHash, { items: ['P1'], userWords: '我批准排班这一项 P1' });
  return { home, maa, configFile: join(maa, 'config', 'gui.new.json'), tablesFile, reportHash: drafted.reportHash, reference: `base/${drafted.reportHash}#P1` };
}

const fixed = '2026-11-13T09:00:00.000Z';
export type ScenarioWorld = { reference: string; reportHash: string; inputs: Record<string, unknown> };
/**
 * Fixed evaluation inputs: the report is drafted by the real tools in a scratch directory, then made deterministic
 * (fixed times, the tables file named relative to the workspace) and saved again under its own content hash, so the
 * same scenario always has the same report version. The account's plan file is not part of the world (the fixture
 * writes JSON compactly, and the approved bytes are proved from the report itself).
 */
export async function scenarioWorld(options: { input?: Record<string, unknown>; approve?: boolean; planFile?: string; settings: unknown; config?: unknown } ): Promise<ScenarioWorld> {
  const scratch = await mkdtemp(join(tmpdir(), 'maa-base-apply-world-'));
  try {
    const maa = join(scratch, 'maa'), tablesFile = join(scratch, 'base-tables.json');
    await mkdir(join(maa, 'resource'), { recursive: true });
    await writeFile(join(maa, 'resource', 'battle_data.json'), JSON.stringify(nameTable()));
    await writeFile(join(scratch, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: scratch, maaDirectory: maa }));
    await writeFile(join(scratch, 'account-snapshot.json'), JSON.stringify(planSnapshot()));
    await writeFile(tablesFile, JSON.stringify(planTables()));
    const drafted = await draftBaseReport({ goals, ...planInput(), tablesFile, ...options.input }, { home: scratch, now: () => new Date(fixed) });
    if (drafted.status !== 'saved') throw new Error(`scenario draft: ${JSON.stringify(drafted)}`);
    const content = structuredClone(drafted.state.content) as unknown as Record<string, any>;
    content.input.tablesFile = 'base-tables.json';
    for (const file of content.sources.files) file.readAt = fixed;
    if (options.planFile) {
      content.plan.file = options.planFile;
      for (const item of content.items) { item.scope.planFile = options.planFile; for (const entry of item.scope.dailyMayArrange) entry.planFile = options.planFile; }
    }
    const saved = await saveAdviceReport(scratch, content as never);
    const state = await loadAdviceReport(scratch, 'base', saved.hash);
    const directory = `private/reports/base/${saved.hash}`, reference = `base/${saved.hash}#P1`;
    const item = state.content.items.find(entry => entry.id === 'P1')!;
    const inputs: Record<string, unknown> = {
      'private/config.json': options.settings, 'private/account-snapshot.json': planSnapshot(), 'base-tables.json': planTables(),
      'resource/battle_data.json': nameTable(), 'config/gui.new.json': options.config ?? infrastConfig({ timers: true }),
      [`${directory}/report.json`]: JSON.parse(await readFile(saved.file, 'utf8')),
      [`${directory}/review.json`]: { schemaVersion: 1, kind: 'base', reportHash: saved.hash, outcome: 'skipped', recordedAt: fixed, userWords: '这次跳过审查', priorFailures: 0 },
    };
    if (options.approve !== false) inputs[`${directory}/approvals/0001.json`] = { schemaVersion: 1, kind: 'base', reportHash: saved.hash, approvedAt: fixed,
      userWords: '我批准排班这一项 P1', reviewStatus: 'unreviewed', items: [{ id: 'P1', reference, title: item.title, scope: item.scope }] };
    return { reference, reportHash: saved.hash, inputs };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
