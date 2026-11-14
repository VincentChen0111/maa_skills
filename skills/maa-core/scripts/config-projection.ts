/**
 * Ticket 30: the one projection of MAA's `gui.new.json` that approvals bind to, and the whole-configuration fingerprint that
 * doctor's recovery compares. Two functions, two purposes; no caller uses one in place of the other.
 *
 * - `projectionRevision`: the revision the read summary returns and every writer entry compares (the common writer,
 *   setup's dedicated entry, base apply, the alternate switch, job and training plan writes). It covers the whole
 *   configuration except the fields in `projectionExclusions`, so a change MAA makes by itself to one of those does not
 *   make an approval stale; any other field that changes does, in the same raw JSON form (an omitted key and a null differ).
 * - `wholeConfigFingerprint`: every field. Doctor decides "the configuration equals the backup" or "equals the expected
 *   result" with it, because recovery is offered only on an exact match (spec 「检查与修法」).
 *
 * Fail-closed: a field is in the projection unless it is listed below. Each exclusion is a field the pinned MAA v6.21.4
 * writes by itself while it runs (sources in docs/daily-verification.md, 「30 配置写入器加固」) and that no maa-skills code
 * reads or writes. Fields MAA also changes at runtime but the writer reads or writes (for example `IsEnable`, `PlanSelect`,
 * `StagePlan`, `Current`, a one-shot timer's `IsEnabled`) stay in: an approval then goes stale after a run, which is safe.
 * tests/config-projection.test.ts enumerates the writer's whitelist and every field its decisions read and requires each
 * to be in the projection.
 */
import { createHash } from 'node:crypto';

/** One path pattern: a key, `*` for any object key (a profile name) or `#` for any array index. */
export type FieldPattern = readonly string[];

/** The only fields outside the projection. */
export const projectionExclusions: readonly FieldPattern[] = [
  // Root GUI state: the window position saved when the main window closes, the hotkey map re-saved at every start.
  ['Gui', 'WindowPlacement'],
  ['Gui', 'HotKeys'],
  // Update bookkeeping MAA writes when it finds, downloads or applies a release, and clears after the first start.
  ['Update', 'Name'],
  ['Update', 'UpdatePackage'],
  ['Update', 'IsFirstBoot'],
  // Reset when MAA fetches a new announcement at start.
  ['AnnouncementInfo', 'DoNotShowAgain'],
  // The task selected in MAA's task list: normalized at start and changed by a click.
  ['Configurations', '*', 'TaskSelectedIndex'],
  // The game day of the last credit fight and friend visit, written when those sub-tasks complete during a run.
  ['Configurations', '*', 'TaskQueue', '#', 'CreditFightLastTime'],
  ['Configurations', '*', 'TaskQueue', '#', 'VisitFriendsLastTime'],
];

type Value = unknown;
const isRecord = (value: Value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keyMatches = (pattern: string, key: string | number) =>
  typeof key === 'number' ? pattern === '#' || pattern === String(key) : pattern === '*' || pattern === key;

function project(value: Value, patterns: readonly FieldPattern[]): Value {
  if (!patterns.length) return value;
  if (Array.isArray(value)) return value.map((item, index) => project(item, patterns.filter(pattern => keyMatches(pattern[0]!, index)).map(pattern => pattern.slice(1))));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const below = patterns.filter(pattern => keyMatches(pattern[0]!, key)).map(pattern => pattern.slice(1));
    if (below.some(pattern => !pattern.length)) continue;
    result[key] = project(item, below);
  }
  return result;
}

/** The configuration without the excluded fields; every other key keeps its order, its value and its presence. */
export function projectConfig(config: Value, exclusions: readonly FieldPattern[] = projectionExclusions): Value {
  return project(config, exclusions);
}

/** The approval revision: SHA-256 of the projection's JSON. */
export function projectionRevision(config: Value): string {
  return createHash('sha256').update(JSON.stringify(projectConfig(config))).digest('hex');
}

/** Doctor's exact comparison: SHA-256 of the whole configuration's JSON. */
export function wholeConfigFingerprint(config: Value): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

/** The value at a change path; MAA's omitted one-shot flag (`Timers.List[i].IsEnabled`) reads as null, as it does for MAA. */
function valueAt(root: Value, path: (string | number)[]): Value {
  let value = root;
  for (const [index, key] of path.entries()) {
    if (index === 3 && path.length === 4 && path[0] === 'Timers' && path[1] === 'List' && key === 'IsEnabled' && isRecord(value) && !Object.hasOwn(value, key)) return null;
    if (['__proto__', 'constructor', 'prototype'].includes(String(key)) || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('change-not-allowed');
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
export type DiffEntry = { path: (string | number)[]; before: unknown; after: unknown };
/**
 * Ticket 30: the diff a write makes and its fingerprint, the one definition the writer (preview, the checks before and
 * after closing MAA, the pending record) and the eval grader share. An entry for each resolved change path whose projected
 * value differs; the fingerprint covers the exact paths and values, so the same request on a configuration that differs
 * only outside the projection has the same fingerprint, and any other difference at a changed field gives another.
 */
export function configDiff(before: Value, after: Value, paths: (string | number)[][]): { entries: DiffEntry[]; fingerprint: string } {
  const projectedBefore = projectConfig(before), projectedAfter = projectConfig(after);
  const entries = paths.map(path => ({ path, before: valueAt(projectedBefore, path), after: valueAt(projectedAfter, path) }))
    .filter(entry => JSON.stringify(entry.before) !== JSON.stringify(entry.after));
  return { entries, fingerprint: createHash('sha256').update(JSON.stringify(entries.map(entry => [entry.path, entry.before, entry.after]))).digest('hex') };
}

/**
 * Whether some instance of `field` (a path pattern) can fall inside an excluded field: an exclusion that is a prefix of it
 * under wildcard matching. A field with an exclusion only below it (a task queue, whose tasks keep everything but the two
 * date fields) is in the projection.
 */
export function excludedBy(field: FieldPattern, exclusions: readonly FieldPattern[] = projectionExclusions): FieldPattern | undefined {
  const overlap = (left: string, right: string) => left === right
    || (left === '*' || right === '*') && left !== '#' && right !== '#'
    || (left === '#' && (right === '#' || /^\d+$/.test(right))) || (right === '#' && /^\d+$/.test(left));
  return exclusions.find(exclusion => exclusion.length <= field.length && exclusion.every((part, index) => overlap(part, field[index]!)));
}
