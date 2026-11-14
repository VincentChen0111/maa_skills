// Ticket 23: what applying an approved base plan may change in MAA's configuration, and the plan copy MAA reads.
// Only the common writer in maa-config.ts calls the change builder and installs the copy, while it holds the lock and
// after it has proved MAA exited. Field names and their meaning are pinned to MAA v6.21.4; every source position is in
// docs/base-apply-verification.md of the repository.
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Change } from './maa-config.ts';
import { readPrivateFile, writePlanFile } from './base-plan.ts';
import { resolveApprovedItem } from './advice-report.ts';

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown): ObjectValue => isObject(value) ? value : {};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const index = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10000;

/** The user's decision on the items the apply-time check could not verify; recorded with the transaction. */
export type BaseDecision = { unverified: string[]; userWords: string | null };
export type BasePlanGrant = { sha256: string; binding: { profile: number; task: number }; decision: BaseDecision };
/** The content-addressed copy of the approved plan inside the private directory; MAA's Filename points here. */
export type BaseAsset = { relative: string; file: string; content: string; sha256: string; plan: unknown };

/** Plan-file facility keys (MaaCore) and the GUI room names whose enabled list decides which facilities MAA visits. */
export const roomNames = { control: 'Control', manufacture: 'Mfg', trading: 'Trade', power: 'Power', meeting: 'Reception', hire: 'Office', dormitory: 'Dorm',
  processing: 'Processing', training: 'Training', recycle: 'Recycle' } as const;
export const baseReferencePattern = /^base\/[a-f0-9]{64}#P1$/;
/** GUI value meaning "a file the user chose", as opposed to one of MAA's bundled presets. */
export const userDefinedFile = 'user_defined';
/** PlanSelect -1: at each run the GUI picks the first plan whose period contains the current time. */
export const timeRotation = -1;
/** Ticket 30: the Infrast task fields a base plan may write (`buildBaseChanges`); the writer refuses any other. */
export const baseTaskFields = ['Mode', 'Filename', 'PlanSelect', 'CustomFileType'] as const;

export function checkGrant(grant: unknown): BasePlanGrant {
  const value = object(grant), binding = object(value.binding), decision = object(value.decision);
  if (Object.keys(value).some(key => !['sha256', 'binding', 'decision'].includes(key)) || !sha(value.sha256)
    || Object.keys(binding).some(key => !['profile', 'task'].includes(key)) || !index(binding.profile) || !index(binding.task)
    || Object.keys(decision).some(key => !['unverified', 'userWords'].includes(key)) || !Array.isArray(decision.unverified)
    || decision.unverified.some(entry => typeof entry !== 'string' || !entry || entry.length > 200) || new Set(decision.unverified).size !== decision.unverified.length
    || !(decision.userWords === null && decision.unverified.length === 0 || typeof decision.userWords === 'string' && decision.userWords.trim().length > 0 && decision.userWords.length <= 2000))
    throw new Error('base-grant-invalid');
  return value as BasePlanGrant;
}

/**
 * The approved bytes: the item must be approved, its scope must still be the report's scope and applicable, and the
 * plan the report keeps must hash to the approved SHA-256. The copy's name is that hash, so it never changes content.
 */
export async function loadBaseAsset(privateDirectory: string, reference: string, grant: BasePlanGrant): Promise<BaseAsset> {
  if (!baseReferencePattern.test(reference)) throw new Error('base-reference-invalid');
  const { state, item } = await resolveApprovedItem(privateDirectory, reference);
  const scope = object(item.scope), reportItem = state.content.items.find(entry => entry.id === item.id);
  if (!reportItem || JSON.stringify(reportItem.scope) !== JSON.stringify(item.scope)) throw new Error('base-approval-scope-mismatch');
  if (scope.applicable !== true || scope.sha256 !== grant.sha256
    || !Array.isArray(scope.dailyMayArrange) || !scope.dailyMayArrange.some(entry => object(entry).action === 'apply-custom-infrast-plan' && object(entry).sha256 === grant.sha256))
    throw new Error('base-plan-not-approved-for-apply');
  const plan = object(object(state.content).plan).json;
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  if (digest(content) !== grant.sha256) throw new Error('base-plan-content-mismatch');
  return { relative: `base-applied/${grant.sha256}.json`, file: join(resolve(privateDirectory), 'base-applied', `${grant.sha256}.json`), content, sha256: grant.sha256, plan };
}

/** Facilities some plan arranges (a room entry with operators and no skip); MAA must visit them for the plan to hold. */
export function arrangedFacilities(plan: unknown): (keyof typeof roomNames)[] {
  const found = new Set<keyof typeof roomNames>();
  for (const entry of Array.isArray(object(plan).plans) ? object(plan).plans as unknown[] : []) {
    for (const [facility, rooms] of Object.entries(object(object(entry).rooms))) {
      if (Object.hasOwn(roomNames, facility) && Array.isArray(rooms) && rooms.some(room => object(room).skip !== true && Array.isArray(object(room).operators) && (object(room).operators as unknown[]).length > 0))
        found.add(facility as keyof typeof roomNames);
    }
  }
  return Object.keys(roomNames).filter(key => found.has(key as keyof typeof roomNames)) as (keyof typeof roomNames)[];
}

/**
 * The complete permitted change set for one existing Infrast task: custom mode, the copy's path, time rotation and the
 * user-defined file type. Only fields that differ are changed; nothing is added, and no production line (`product`),
 * training, timer or other task setting is touched. A facility the plan arranges but MAA would not visit is refused.
 */
export function buildBaseChanges(input: unknown, grant: BasePlanGrant, asset: BaseAsset): { changes: Change[]; profile: string; taskPath: (string | number)[]; enabled: boolean } {
  checkGrant(grant);
  if (asset.sha256 !== grant.sha256) throw new Error('base-grant-invalid');
  const config = object(input), profiles = object(config.Configurations), profile = Object.keys(profiles)[grant.binding.profile];
  if (profile === undefined) throw new Error('base-binding-invalid');
  const queue = object(profiles[profile]).TaskQueue;
  if (!Array.isArray(queue) || !isObject(queue[grant.binding.task])) throw new Error('base-binding-invalid');
  const task = queue[grant.binding.task] as ObjectValue;
  if (task.$type !== 'InfrastTask' || task.TaskType !== 'Infrast') throw new Error('base-infrast-task-required');
  if (!['Mode', 'Filename', 'PlanSelect'].every(key => Object.hasOwn(task, key)) || typeof task.Filename !== 'string' || !Number.isSafeInteger(task.PlanSelect)
    || !(typeof task.Mode === 'number' || typeof task.Mode === 'string') || Object.hasOwn(task, 'CustomFileType') && typeof task.CustomFileType !== 'string'
    || !Array.isArray(task.RoomList)) throw new Error('base-infrast-fields-unverified');
  const visited = new Set((task.RoomList as unknown[]).filter(row => object(row).IsEnabled !== false).map(row => object(row).Room));
  const missing = arrangedFacilities(asset.plan).map(facility => roomNames[facility]).filter(room => !visited.has(room));
  if (missing.length) throw new Error(`base-room-disabled:${missing.join(',')}`);
  const target: ObjectValue = { Mode: typeof task.Mode === 'number' ? 10000 : 'Custom', Filename: asset.file, PlanSelect: timeRotation,
    ...(Object.hasOwn(task, 'CustomFileType') ? { CustomFileType: userDefinedFile } : {}) };
  const path = ['Configurations', profile, 'TaskQueue', grant.binding.task];
  return { changes: Object.entries(target).filter(([key, value]) => task[key] !== value).map(([key, value]) => ({ path: [...path, key], value })), profile, taskPath: path,
    enabled: task.IsEnable !== false };
}

/** Facts about the copy are read before shutdown, before writing and at read-back; a copy reached through a link that leaves the private directory is refused. */
export async function inspectBaseAsset(asset: BaseAsset, privateDirectory: string): Promise<'absent' | 'matching'> {
  // The nearest existing folder on the way to the copy must itself be inside the private directory (no link out).
  const root = await realpath(resolve(privateDirectory));
  for (let folder = dirname(join(root, asset.relative)); ; folder = dirname(folder)) {
    const real = await realpath(folder).catch(() => null);
    if (real === null && dirname(folder) !== folder) continue;
    const rel = real === null ? '..' : relative(root, real);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('plan-path-outside-private');
    break;
  }
  let text: string;
  try { text = await readPrivateFile(privateDirectory, asset.relative); }
  catch (error) { if ((error as Error).message === 'plan-file-missing') return 'absent'; throw error; }
  if (digest(text) !== asset.sha256) throw new Error('base-plan-copy-changed');
  return 'matching';
}

/** Called only by the common writer while it owns the lock and has proved MAA exited: atomic replace inside the private directory. */
export async function installBaseAsset(asset: BaseAsset, privateDirectory: string): Promise<void> {
  if (await inspectBaseAsset(asset, privateDirectory) === 'matching') return;
  await writePlanFile(privateDirectory, asset.relative, asset.content);
  if (await inspectBaseAsset(asset, privateDirectory) !== 'matching') throw new Error('base-plan-copy-changed');
}
