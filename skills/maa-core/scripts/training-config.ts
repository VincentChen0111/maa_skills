import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { join, isAbsolute, dirname } from 'node:path';
import type { Change } from './maa-config.ts';
import { sameConfigValue } from './config-projection.ts';
import type { TrainingActionKind, TrainingPlan } from './training-state.ts';

export type TrainingGrant = { planId: string; kind: TrainingActionKind | 'disable'; binding: TrainingPlan['binding'];
  target: { name: string; role: string; skill: number; rank: number }; assistant: string; dueAt: string; expectedTimer?: unknown };
export type TrainingAsset = { file: string; content: string; sha256: string };
/** Ticket 30: the task fields a training plan writes (the Infrast task's plan settings and room list, the OperProgress plans). */
export const trainingTaskFields = ['Mode', 'Filename', 'PlanSelect', 'ContinueTraining', 'RoomList', 'UseWeeklySchedule', 'Plans'] as const;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('training-configuration-invalid');
  return value as Record<string, unknown>;
};
const integer = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\r\n\x00-\x1f]/.test(value);
export function trainingTimerIdentity(value: unknown) {
  const timer = object(value);
  return { Id: timer.Id, IsEnabled: timer.IsEnabled ?? null, Config: timer.Config, Hour: timer.Hour, Minute: timer.Minute };
}

/** Derives the complete permitted change set. It cannot add tasks or accept arbitrary configuration JSON. */
export function buildTrainingChanges(input: unknown, grant: TrainingGrant, privateDirectory: string): { changes: Change[]; asset: TrainingAsset | null; profile: string } {
  if (!isAbsolute(privateDirectory) || !grant || !text(grant.planId) || !['preplace', 'start', 'assistant', 'observe', 'disable'].includes(grant.kind)
    || !grant.binding || Object.values(grant.binding).some(value => !integer(value, 10000)) || grant.binding.timer >= 8
    || grant.binding.infrastTask === grant.binding.progressTask || !text(grant.target?.name) || !text(grant.assistant)
    || !['Pioneer', 'Warrior', 'Tank', 'Sniper', 'Caster', 'Support', 'Medic', 'Special'].includes(grant.target.role)
    || !integer(grant.target.skill, 3) || grant.target.skill < 1 || !integer(grant.target.rank, 3) || grant.target.rank < 1) throw new Error('training-grant-invalid');
  const config = object(input), profiles = object(config.Configurations), profile = Object.keys(profiles)[grant.binding.profile];
  if (!profile) throw new Error('training-profile-missing');
  const queue = object(profiles[profile]).TaskQueue, timers = object(config.Timers), list = timers.List;
  if (!Array.isArray(queue) || !Array.isArray(list) || !list[grant.binding.timer]) throw new Error('training-existing-tasks-required');
  const timer = object(list[grant.binding.timer]);
  if (grant.expectedTimer !== undefined && !sameConfigValue(trainingTimerIdentity(timer), trainingTimerIdentity(grant.expectedTimer))) throw new Error('training-timer-changed');
  if (grant.kind === 'disable') {
    if (grant.expectedTimer === undefined || timer.IsEnabled === true) throw new Error('training-owned-once-timer-required');
    return { changes: [{ path: ['Timers', 'List', grant.binding.timer, 'IsEnabled'], value: false }], asset: null, profile };
  }
  if (timer.IsEnabled !== false) throw new Error('training-timer-not-free');
  if (timers.ForceScheduledStart !== false || typeof timers.CustomConfig !== 'boolean') throw new Error('training-timer-mode-unverified');
  if (list.some((other, index) => index !== grant.binding.timer && object(other).IsEnabled !== false
    && (timers.CustomConfig !== true || object(other).Config === profile))) throw new Error('training-other-timer-conflict');
  const due = new Date(grant.dueAt), now = Date.now();
  if (!Number.isFinite(due.getTime()) || due.toISOString() !== grant.dueAt || due.getTime() <= now + 240000 || due.getTime() >= now + 86400000 || due.getUTCSeconds() || due.getUTCMilliseconds()) throw new Error('training-due-time-invalid');
  if (due.getTimezoneOffset() !== new Date(now).getTimezoneOffset()) throw new Error('training-clock-transition-unverified');
  const infrast = object(queue[grant.binding.infrastTask]), progress = object(queue[grant.binding.progressTask]);
  if (infrast.$type !== 'InfrastTask' || infrast.TaskType !== 'Infrast' || progress.$type !== 'OperProgressTask' || progress.TaskType !== 'OperProgress'
    || !Array.isArray(progress.Plans) || !Array.isArray(infrast.RoomList) || infrast.RoomList.filter(row => object(row).Room === 'Training').length !== 1) throw new Error('training-existing-tasks-required');
  const room = grant.kind === 'preplace' ? { operatorsA: [grant.assistant], operatorsB: [grant.target.name] }
    : grant.kind === 'assistant' ? { operatorsA: [grant.assistant] } : {};
  const content = JSON.stringify({ title: 'maa-skills training', plans: [{ name: 'training', rooms: { training: [room] } }] }, null, 2) + '\n';
  const sha256 = createHash('sha256').update(content).digest('hex');
  const asset = { file: join(privateDirectory, 'training-assets', `${sha256}.json`), content, sha256 };
  const changes: Change[] = [];
  const add = (path: (string | number)[], value: unknown) => changes.push({ path, value });
  queue.forEach((row, index) => {
    if (typeof object(row).IsEnable !== 'boolean') throw new Error('training-task-enable-unknown');
    add(['Configurations', profile, 'TaskQueue', index, 'IsEnable'], index === (grant.kind === 'start' ? grant.binding.progressTask : grant.binding.infrastTask));
  });
  const path = ['Configurations', profile, 'TaskQueue', grant.binding.infrastTask];
  for (const [field, value] of Object.entries({ Mode: typeof infrast.Mode === 'number' ? 10000 : 'Custom', Filename: asset.file, PlanSelect: 0, ContinueTraining: false,
    RoomList: infrast.RoomList.map(row => ({ ...object(row), IsEnabled: object(row).Room === 'Training' })) })) add([...path, field], value);
  if (Object.hasOwn(infrast, 'UseWeeklySchedule')) add([...path, 'UseWeeklySchedule'], false);
  const ranks = [0, 0, 0]; ranks[grant.target.skill - 1] = grant.target.rank;
  add(['Configurations', profile, 'TaskQueue', grant.binding.progressTask, 'Plans'], grant.kind === 'start'
    ? [{ Role: grant.target.role, Name: grant.target.name, Elite: 0, SkillLevel: 0, SkillMastery: ranks, ShowRole: false }] : []);
  add(['Timers', 'CustomConfig'], true);
  for (const [key, value] of Object.entries({ IsEnabled: null, Config: profile, Hour: due.getHours(), Minute: due.getMinutes() })) add(['Timers', 'List', grant.binding.timer, key], value);
  return { changes, asset, profile };
}

/** File facts are read before and after shutdown, and after restart; symlink assets are rejected. */
export async function inspectTrainingAsset(asset: TrainingAsset): Promise<'absent' | 'matching'> {
  for (const path of [dirname(asset.file), asset.file]) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('training-asset-link'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let bytes: Buffer;
  try { bytes = await readFile(asset.file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw error; }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('training-asset-changed');
  return 'matching';
}

/** Called only while the common MAA transaction owns the lock and has proved the process tree exited. */
export async function installTrainingAsset(asset: TrainingAsset) {
  await mkdir(dirname(asset.file), { recursive: true });
  if (await inspectTrainingAsset(asset) === 'matching') return;
  const file = await open(asset.file, 'wx', 0o600);
  try { await file.writeFile(asset.content); await file.sync(); } finally { await file.close(); }
}
