import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TrainingPlan } from '../../skills/maa-core/scripts/training-state.ts';
import type { TrainingGrant } from '../../skills/maa-core/scripts/training-config.ts';
import type { MaaProcess } from '../../skills/maa-core/scripts/maa-config.ts';

export function plan(): TrainingPlan {
  return { version: 1, id: 'synthetic-plan', authorization: { source: 'current-request', reference: 'synthetic request' },
    target: { operatorId: 'char_synthetic', name: '合成干员', skill: 1, skillName: '合成技能', role: 'Warrior', currentRank: 0, goal: 2 },
    rank: 1, state: 'pending', createdAt: '2026-11-11T01:00:00.000Z', preplacementRequired: true,
    binding: { profile: 0, infrastTask: 0, progressTask: 1, timer: 0 }, assistants: { '1': '合成助手', '2': '合成助手' },
    materialReady: true, manualTraining: false, action: { kind: 'start', dueAt: '2026-11-11T01:05:00.000Z', armedAt: '2026-11-11T01:00:00.000Z' },
    history: [], consumed: [], issues: [], assistantState: 'unverified' };
}
export function log(at: string, message: string, payload: unknown) { return `[${at}] [INF] Assistant::append_callback | ${message} ${JSON.stringify(payload)}\n`; }
export function confirmation(at = '2026-11-11T01:05:01.000Z') { return log(at, 'SubTaskCompleted', { taskchain: 'OperProgress', taskid: 4, subtask: 'ProcessTask', details: { task: 'InfrastTrainingConfirm' } }); }
export function countdown(at = '2026-11-11T01:05:10.000Z', extra = {}) { return log(at, 'SubTaskExtraInfo', { taskchain: 'Infrast', taskid: 5, what: 'InfrastTrainingTimeLeft', details: { operator: '合成干员', skill: '合成技能', level: 1, time: '01:00:00', ...extra } }); }

export function trainingConfig() {
  return { Current: 'synthetic', Configurations: { synthetic: { TaskQueue: [
    { $type: 'InfrastTask', TaskType: 'Infrast', IsEnable: false, Mode: 0, Filename: '', PlanSelect: 0, ContinueTraining: false, UseWeeklySchedule: false,
      RoomList: [{ Room: 'Training', IsEnabled: true }, { Room: 'Mfg', IsEnabled: true }] },
    { $type: 'OperProgressTask', TaskType: 'OperProgress', IsEnable: false, Plans: [] },
    // A disabled Fight task holding approved stone (MAA v6.21.4 fields); a training write keeps it disabled.
    { $type: 'FightTask', TaskType: 'Fight', IsEnable: false, UseMedicine: false, MedicineCount: 0, UseStone: true, StoneCount: 1, UseStoneAllowSave: true,
      UseExpiringMedicine: false, MedicineExpireDays: 2, UseExpireMedicineForActivity: false },
  ] } }, Timers: { CustomConfig: false, ForceScheduledStart: false, List: [{ Id: 0, IsEnabled: false, Config: 'synthetic', Hour: 0, Minute: 0 }] } };
}
export function trainingGrant(): TrainingGrant {
  const due = new Date(Math.ceil((Date.now() + 3600000) / 60000) * 60000);
  return { planId: 'synthetic', kind: 'preplace', binding: { profile: 0, infrastTask: 0, progressTask: 1, timer: 0 }, dueAt: due.toISOString(),
    target: { name: '合成干员', role: 'Warrior', skill: 1, rank: 1 }, assistant: '合成助手' };
}
export async function configFixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'training-write-')); t.after(() => rm(root, { recursive: true, force: true }));
  const maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private'); await mkdir(join(maaDirectory, 'config'), { recursive: true });
  const file = join(maaDirectory, 'config', 'gui.new.json'), config = trainingConfig(); await writeFile(file, JSON.stringify(config));
  let running = false;
  const maa: MaaProcess = { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { running = false; }, start: async () => { running = true; } };
  return { root, maaDirectory, privateDirectory, file, config, maa };
}
