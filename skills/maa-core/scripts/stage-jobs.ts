import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, stdinJsonCode } from './stdin-json.ts';
import { executeConfigWrite, versionStampOf, type MaaProcess } from './maa-config.ts';
import { compareVersionStamp, readVersionStamp } from './maa-version.ts';
import { approvedJobList, approvedJobFile, approvedJobSourceFile, type ApprovedJobPlan } from './stage-job-plan.ts';
import { readPublicJson } from './public-data.ts';
import { readSettings } from './preferences.ts';
import { CheckRequiredError, checkRequiredFor, type CheckRequiredReason } from './check-required.ts';
import { selectSnapshot, snapshotFiles, snapshotSourceLine, SnapshotSelectionError, type SnapshotSelection } from './account-snapshot.ts';

type ObjectValue = Record<string, any>;
// 'support' (需借助战): every slot but one is verified and the one left has no owned member; MAA may borrow it.
type Status = 'ready' | 'support' | 'blocked' | 'unknown';
/**
 * MAA copilot `requirements.module` in v6.21.4 and v6.22.0 (AsstBattleDef.h, BattleFormationTask.cpp): -1 or absent is no
 * requirement, 0 asks auto-formation to pick "no module", 1-5 are the module types χ, Y, α, Δ, β. The game data names those
 * types by `typeName2` X, Y, A, D, B (MAA's OperBoxDataConfig.cpp maps the same letters). `module_level` is not read by MAA.
 */
export const moduleTypes = ['X', 'Y', 'A', 'D', 'B'] as const;
export type ModuleType = (typeof moduleTypes)[number];
/**
 * Facts the user confirmed for one operator, in the account snapshot's own units: `skillLevel` 1-7, `mastery` per skill slot
 * "1"-"3" (0-3), `moduleTypes` per module type letter (0 = not unlocked, 1-3 = its level). They fill only what the snapshot
 * does not know; a fact that contradicts a known snapshot value leaves that requirement 待核.
 */
export type OperatorFact = { name: string; source: 'user-confirmed'; reference: string; skillLevel?: number; mastery?: Record<string, number>;
  moduleTypes?: Partial<Record<ModuleType, number>> };
export type StageRequest = { stages: { stageId: string; code: string; difficulty: 'normal' | 'raid'; loops: number }[];
  completions?: Record<string, 'PASS' | 'COMPLETE'>; completionEvidence?: string; maaVersion: string;
  documentChecks?: { jobId: number; contentHash: string; satisfied: boolean; reference: string }[]; operatorFacts?: OperatorFact[]; jobConfirmations?: JobConfirmation[] };
/**
 * The user's one confirmation of a whole job (over-blocking review, 2026-11-16; the owner's 「我核实了，都是满足的。直接开始。」):
 * bound to the job's content hash as the report shows it, with the user's own words. It settles only what
 * `jobConfirmationCovers` lists; a known shortfall, a conflict, an invalid requirement, an operator the ownership list proves
 * is not owned, the stage, difficulty, version, prerequisites and empty groups keep their state.
 */
export type JobConfirmation = { jobId: number; contentHash: string; source: 'user-confirmed'; reference: string };
export const jobConfirmationCovers = { rows: ['requirements-unstated', 'role-unverified', 'unknown-*', 'mastery-skill-unspecified', 'module-level-unattributed', 'ownership-unobserved-or-ambiguous'],
  job: ['action-operator-undeclared', 'action-name-unrecognized', 'document-conditions-unverified'] } as const;
const coveredRowReason = (reason: string) => jobConfirmationCovers.rows.some(item => item.endsWith('*') ? reason.startsWith(item.slice(0, -1)) : reason === item);
/** Where the request's MAA version came from: the request itself, the installed MAA's version stamp, or neither. */
export type MaaVersionSource = 'request' | 'installed' | 'unavailable';
/** OB-3: a request that names no MAA version (absent, null or blank) takes the installed MAA's version stamp, read before matching. */
export function withInstalledMaaVersion(request: StageRequest, installed: string | null): { request: StageRequest; maaVersionSource: MaaVersionSource } {
  const value = (request as { maaVersion?: unknown }).maaVersion;
  if (!(value === undefined || value === null || typeof value === 'string' && !value.trim())) return { request, maaVersionSource: 'request' };
  return installed ? { request: { ...request, maaVersion: installed }, maaVersionSource: 'installed' } : { request, maaVersionSource: 'unavailable' };
}
/** Module ID -> its operator and type letter, from the pinned uniequip table (or an offline `modules` map of the same shape). */
type ModuleCatalog = Record<string, { charId: string; typeName2: string | null }>;
type SourceRecord = { url: string; readAt: string; sha256?: string };
/** Rating counts as the copilot site's query summary reports them; the summary is fresher than the cached detail view. */
export type JobRating = { like: number; dislike: number; notEnoughRating: boolean; ratingLevel?: number; ratingRatio?: number; source: SourceRecord };
export type Job = { id: number; content: ObjectValue; source: SourceRecord; rating?: JobRating };
export type CandidateRating = { flag: 'ok' | 'low' | 'not-enough' | 'unknown'; like?: number; dislike?: number; votes?: number; notEnoughRating?: boolean;
  likeRatio?: number; requiredRatio?: number; ratingLevel?: number | null; ratingRatio?: number | null; source?: SourceRecord | null };
type SearchCoverage = { stageId: string; mode: 'online' | 'offline'; pages: number; truncated: boolean; ids: number[] };
type SearchOutcome = 'offline' | 'empty' | 'found' | 'same-map-unproven' | 'fallback-suspected' | 'insufficient' | 'unresolved' | 'other-stages';
// A job whose content MAA cannot use (e.g. repeated group names: BattleFormationParseFailed) is blocked as job-content-invalid:<code>.
const blockingReasons = ['map-mismatch', 'stage-same-map-unproven', 'stage-name-unresolved', 'difficulty-mismatch', 'difficulty-unstated-normal-only', 'full-job-required', 'unsupported-job-type'];
export type StageReport = ReturnType<typeof matchStageJobs>;
export type StageApproval = { reportHash: string; reference: string; map: string; selections: { stageId: string; primary: number; alternates: number[]; loops: number; supportJobs?: number[] }[] };
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object-required');
  return value as ObjectValue;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown): string => { if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('text-required'); return value; };
const status = (states: Status[]): Status => states.includes('blocked') ? 'blocked' : states.includes('unknown') ? 'unknown' : states.includes('support') ? 'support' : 'ready';
function version(value: unknown, optionalPatch = false) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || !optionalPatch && match[3] === undefined) return null;
  const pre = match[4]?.split('.') ?? [], build = match[5]?.split('.') ?? [];
  if (pre.some(part => /^0\d+$/.test(part))) return null;
  return { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3] ?? '0')], pre, build };
}
function versionMet(current: unknown, required: unknown): boolean {
  const a = version(current), b = version(required, true); if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]!;
  if (!a.pre.length !== !b.pre.length) return !a.pre.length;
  // MAA uses Semver.CompareSortOrderTo: prerelease numbers sort numerically,
  // while build identifiers sort as ASCII text after equal version precedence.
  for (const field of ['pre', 'build'] as const) {
    for (let i = 0; i < Math.max(a[field].length, b[field].length); i++) {
      const left = a[field][i], right = b[field][i];
      if (left === right) continue;
      if (left === undefined || right === undefined) return right === undefined;
      if (field === 'pre') {
        const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
        if (ln !== rn) return !ln;
        if (ln) return BigInt(left) > BigInt(right);
      }
      return left > right;
    }
  }
  return true;
}
// Design default (ticket 29, 2026-11-13): the required like ratio rises with votes, 65% at 5 votes to a cap of 85% at
// 100 votes, after the vote-dependent idea in MAA-PRTS (MIT). It is applied only when the site says the rating is enough.
const requiredLikeRatio = (votes: number) => votes < 5 ? 0 : Math.min(0.85, 0.65 + 0.2 * Math.log(votes / 5) / Math.log(20));
const round4 = (value: number) => Number(value.toFixed(4));
/** Ratings order and annotate candidates only; they never change status, requirement checks or authorization. */
function rateJob(job: Job): CandidateRating {
  const rating = job.rating as unknown;
  if (!rating || typeof rating !== 'object' || Array.isArray(rating)) return { flag: 'unknown' };
  const { like, dislike, notEnoughRating, ratingLevel, ratingRatio, source } = rating as ObjectValue;
  if (!Number.isSafeInteger(like) || like < 0 || !Number.isSafeInteger(dislike) || dislike < 0 || typeof notEnoughRating !== 'boolean') return { flag: 'unknown' };
  const votes = like + dislike;
  const base = { like, dislike, votes, notEnoughRating, ratingLevel: Number.isSafeInteger(ratingLevel) ? ratingLevel : null,
    ratingRatio: typeof ratingRatio === 'number' && Number.isFinite(ratingRatio) ? ratingRatio : null,
    source: source && typeof source === 'object' && typeof source.url === 'string' && typeof source.readAt === 'string' ? structuredClone(source) as SourceRecord : null };
  if (notEnoughRating) return { ...base, flag: 'not-enough' };
  if (!votes) return { ...base, flag: 'unknown' };
  const required = requiredLikeRatio(votes);
  return { ...base, likeRatio: round4(like / votes), requiredRatio: round4(required), flag: like / votes < required ? 'low' : 'ok' };
}
const ratingTier = (rating: CandidateRating) => rating.flag === 'ok' ? 0 : rating.flag === 'low' ? 2 : 1;
function effectiveRequirements(oper: ObjectValue): ObjectValue {
  const required = structuredClone(object(oper.requirements ?? {}));
  const skill = oper.skill === 2 || oper.skill === 3 ? oper.skill - 1 : 0;
  const level = Number.isSafeInteger(required.skill_level) && required.skill_level >= 5 && required.skill_level <= 10 ? required.skill_level <= 7 ? 1 : 2 : 0;
  const module = Number.isSafeInteger(required.module) && required.module > 0 ? 2 : 0;
  const floor = Math.max(skill, level, module);
  if (floor > 0 && (required.elite === undefined || Number.isSafeInteger(required.elite) && required.elite >= -1 && required.elite < floor)) required.elite = floor;
  // Core rejects explicit -1 for S1's zero floor; skill 0/omitted still accepts it.
  else if (oper.skill === 1 && required.elite === -1) required.elite = 0;
  return required;
}
/** Job confirmations, validated once: one per job at most; a malformed entry refuses the whole request (it is the user's own scope). */
function jobConfirmations(request: StageRequest): Map<number, JobConfirmation> {
  const confirmations = new Map<number, JobConfirmation>(), raw = request.jobConfirmations as unknown;
  if (raw === undefined) return confirmations;
  const invalid = (): never => { throw new CheckRequiredError('stage-jobs-job-confirmations-invalid'); };
  if (!Array.isArray(raw) || raw.length > 200) invalid();
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid();
    const item = entry as ObjectValue;
    if (Object.keys(item).some(key => !['jobId', 'contentHash', 'source', 'reference'].includes(key)) || !Number.isSafeInteger(item.jobId) || item.jobId < 1
      || typeof item.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.contentHash) || item.source !== 'user-confirmed'
      || typeof item.reference !== 'string' || !item.reference.trim() || item.reference.length > 2048 || confirmations.has(item.jobId)) invalid();
    confirmations.set(item.jobId, item as JobConfirmation);
  }
  return confirmations;
}
/** User-confirmed operator facts, validated once; a malformed entry refuses the whole request (it is the user's own scope). */
function operatorFacts(request: StageRequest): Map<string, OperatorFact> {
  const facts = new Map<string, OperatorFact>(), raw = request.operatorFacts as unknown;
  if (raw === undefined) return facts;
  const invalid = () => { throw new CheckRequiredError('stage-jobs-operator-facts-invalid'); };
  const level = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
  const map = (value: unknown, keys: readonly string[], max: number) => {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return false;
    return Object.entries(value).every(([key, item]) => keys.includes(key) && level(item, 0, max));
  };
  if (!Array.isArray(raw) || raw.length > 200) invalid();
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid();
    const fact = entry as ObjectValue;
    if (Object.keys(fact).some(key => !['name', 'source', 'reference', 'skillLevel', 'mastery', 'moduleTypes'].includes(key)) || fact.source !== 'user-confirmed'
      || typeof fact.name !== 'string' || !fact.name.trim() || fact.name.length > 96 || typeof fact.reference !== 'string' || !fact.reference.trim() || fact.reference.length > 2048
      || fact.skillLevel !== undefined && !level(fact.skillLevel, 1, 7) || !map(fact.mastery, ['1', '2', '3'], 3) || !map(fact.moduleTypes, moduleTypes, 3)
      || fact.skillLevel === undefined && fact.mastery === undefined && fact.moduleTypes === undefined || facts.has(fact.name)) invalid();
    facts.set(fact.name, fact as OperatorFact);
  }
  return facts;
}
function moduleCatalog(tablesValue: ObjectValue): ModuleCatalog {
  const raw = tablesValue.modules, catalog: ModuleCatalog = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return catalog;
  for (const [id, entry] of Object.entries(raw)) if (entry && typeof entry === 'object' && typeof (entry as ObjectValue).charId === 'string'
    && ((entry as ObjectValue).typeName2 === null || typeof (entry as ObjectValue).typeName2 === 'string')) catalog[id] = { charId: (entry as ObjectValue).charId, typeName2: (entry as ObjectValue).typeName2 };
  return catalog;
}
/**
 * How many skills an operator has, by character ID: the report's saved subset (`skillCounts`), else the pinned character table's
 * `skills` list. Absent means unknown.
 */
function skillCounts(tablesValue: ObjectValue): Record<string, number> {
  const counts: Record<string, number> = {}, saved = tablesValue.skillCounts, characters = tablesValue.characters;
  if (characters && typeof characters === 'object' && !Array.isArray(characters)) for (const [id, entry] of Object.entries(characters as ObjectValue))
    if (entry && Array.isArray(entry.skills) && entry.skills.length >= 1 && entry.skills.length <= 3) counts[id] = entry.skills.length;
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [id, value] of Object.entries(saved as ObjectValue))
    if (Number.isSafeInteger(value) && value >= 1 && value <= 3) counts[id] = value as number;
  return counts;
}
type MatchContext = { facts: Map<string, OperatorFact>; modules: ModuleCatalog; usedModules: Set<string>; skillCounts: Record<string, number>; usedSkillCounts: Set<string> };
type Observed = { value: number | null; from: 'snapshot' | 'user-confirmed' | null; conflict: boolean };
/** The snapshot's value wins; a user-confirmed fact fills only an unknown one; a fact contradicting a known value is a conflict. */
function observe(snapshotValue: unknown, confirmed: unknown): Observed {
  if (Number.isSafeInteger(snapshotValue)) return { value: snapshotValue as number, from: 'snapshot', conflict: confirmed !== undefined && confirmed !== snapshotValue };
  return Number.isSafeInteger(confirmed) ? { value: confirmed as number, from: 'user-confirmed', conflict: false } : { value: null, from: null, conflict: false };
}
/** A module type's level from the snapshot: the operator's one module of that type in the catalogue, else unknown. */
function snapshotModuleLevel(actual: ObjectValue | null, type: ModuleType, context: MatchContext): number | null {
  if (!actual || typeof actual.id !== 'string') return null;
  const ids = Object.keys(context.modules).filter(id => context.modules[id]!.charId === actual.id);
  for (const id of ids) context.usedModules.add(id);
  const typed = ids.filter(id => context.modules[id]!.typeName2 === type);
  const value = typed.length === 1 && actual.modules && typeof actual.modules === 'object' ? actual.modules[typed[0]!] : null;
  return Number.isSafeInteger(value) ? value : null;
}
/**
 * The names MAA's auto-formation keys groups by (CopilotConfig.cpp, BattleFormationTask.cpp, v6.21.4 and v6.22.0): a single
 * `opers` entry is a group named after the operator, `groups` keep their own names, and a group with no members is skipped.
 * Any repeat makes MAA report BattleFormationParseFailed and stop before the battle.
 */
function formationNamesRepeat(content: ObjectValue): boolean {
  const names = [...(content.opers ?? []).map((oper: ObjectValue) => oper?.name),
    ...(content.groups ?? []).filter((group: ObjectValue) => Array.isArray(group?.opers) && group.opers.length).map((group: ObjectValue) => group?.name)];
  return new Set(names).size !== names.length;
}
function matchOperators(snapshot: ObjectValue, content: ObjectValue, context: MatchContext, confirmed = false) {
  const rows: { group: string; name: string; skill: unknown; required: ObjectValue; effectiveRequired: ObjectValue; actual: ObjectValue | null; status: Status; reasons: string[];
    observed: { skillLevel?: Observed; mastery?: Record<string, Observed>; module?: { type: ModuleType | null; level: Observed } }; confirmed?: true }[] = [];
  const groups: { name: string; rows: typeof rows; index: number; opers: unknown[] }[] = [];
  if (!Array.isArray(content.opers ?? []) || !Array.isArray(content.groups ?? [])) throw new Error('job-operators-invalid');
  if (formationNamesRepeat(content)) throw new Error('job-group-name-duplicate');
  const fixedCount = (content.opers ?? []).length;
  // Single operators are slots named after the operator, as in MAA; an empty group is skipped by MAA's formation and fills no slot.
  const entries: { name: string; opers: unknown[]; index: number }[] = [...(content.opers ?? []).map((oper: unknown, index: number) => ({ name: text(object(oper).name), opers: [oper], index })),
    ...(content.groups ?? []).map((group: unknown, index: number) => ({ name: text(object(group).name), opers: object(group).opers, index: fixedCount + index }))];
  const notOwned = new Set<(typeof rows)[number]>();
  // Absence proves "not owned" only when the snapshot carries a usable ownership list.
  const ownershipListed = Array.isArray(snapshot.operators) && ['complete', 'partial'].includes(snapshot.coverage?.operators?.status)
    && !(Array.isArray(snapshot.coverage?.operators?.issues) && snapshot.coverage.operators.issues.includes('empty-recognition'));
  const emptyGroups: string[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!Array.isArray(entry.opers)) throw new Error('job-operators-invalid');
    if (!entry.opers.length) { emptyGroups.push(name); continue; }
    const groupRows = entry.opers.map((raw: unknown) => {
      const oper = object(raw), original = object(oper.requirements ?? {}), required = effectiveRequirements(oper), operName = text(oper.name);
      const matches = Array.isArray(snapshot.operators) ? snapshot.operators.filter((item: ObjectValue) => item.name === operName) : [];
      const actual = matches.length === 1 && ['complete', 'partial'].includes(snapshot.coverage?.operators?.status) ? object(matches[0]) : null;
      const fact = context.facts.get(operName);
      const reasons: string[] = [], checks: Status[] = [], observed: (typeof rows)[number]['observed'] = {};
      const mark = (state: Status, reason: string) => { checks.push(state); reasons.push(reason); };
      const check = (field: string, expected: unknown, value: unknown) => {
        if (expected === undefined || expected === -1) return;
        if (!Number.isSafeInteger(expected) || Number(expected) < 0) { mark('unknown', `invalid-${field}`); return; }
        if (!Number.isSafeInteger(value)) mark('unknown', `unknown-${field}`);
        else if (Number(value) < Number(expected)) mark('blocked', `insufficient-${field}`);
      };
      const checkObserved = (field: string, expected: number, seen: Observed) => {
        if (seen.conflict) mark('unknown', `operator-fact-conflict:${field}`); else check(field, expected, seen.value);
      };
      if (!actual) mark('unknown', 'ownership-unobserved-or-ambiguous');
      // MAA v6.21.4 treats a missing requirements object as "no requirement"; no grounded default exists, so it stays 待核.
      if (oper.requirements === undefined || oper.requirements === null || !Object.keys(original).length) mark('unknown', 'requirements-unstated');
      check('elite', required.elite === undefined || required.elite === -1 ? 0 : required.elite, actual?.elite);
      // Level thresholds apply at the required elite stage, not after a higher promotion.
      if (!(Number.isSafeInteger(required.elite) && required.elite >= 0 && Number.isSafeInteger(actual?.elite) && actual!.elite > required.elite)) check('level', required.level, actual?.level);
      check('potential', required.potentiality ?? required.potential, actual?.potential);
      // skill_level 1-7 is the skill level shared by all skills; 8/9/10 is mastery 1/2/3 of the job's `skill` (AsstBattleDef.h).
      const skillLevel = required.skill_level;
      if (skillLevel !== undefined && skillLevel !== -1) {
        if (!Number.isSafeInteger(skillLevel) || skillLevel < 1 || skillLevel > 10) mark('unknown', 'invalid-skill-level');
        else if (skillLevel <= 7) { observed.skillLevel = observe(actual?.skillLevel, fact?.skillLevel); checkObserved('skill-level', skillLevel, observed.skillLevel); }
        else {
          const rank = skillLevel - 7, slot = Number.isInteger(oper.skill) && oper.skill >= 1 && oper.skill <= 3 ? String(oper.skill) : null;
          const known = actual?.mastery && typeof actual.mastery === 'object' ? actual.mastery as ObjectValue : null;
          if (slot) { observed.mastery = { [slot]: observe(known?.[slot], fact?.mastery?.[slot]) }; checkObserved('mastery', rank, observed.mastery[slot]!); }
          else {
            // skill 0/omitted: MAA keeps the default or last-used skill, so the mastery holds only if every skill has it. The
            // snapshot's skill list says how many skills there are; without one, the user's facts must name all three slots.
            // The pinned character table says how many skills the operator has (two for most 4★ and 5★); without it, all three.
            const count = typeof actual?.id === 'string' ? context.skillCounts[actual.id] : undefined;
            if (count !== undefined) context.usedSkillCounts.add(actual!.id);
            const every = Array.from({ length: count ?? 3 }, (_, index) => String(index + 1));
            const slots = known ? Object.keys(known) : every.every(key => fact?.mastery?.[key] !== undefined) ? every : [];
            observed.mastery = Object.fromEntries(slots.map(key => [key, observe(known?.[key], fact?.mastery?.[key])]));
            const seen = Object.values(observed.mastery);
            if (seen.some(item => item.conflict)) mark('unknown', 'operator-fact-conflict:mastery');
            else if (seen.length && seen.every(item => item.value !== null && item.value >= rank)) { /* every skill qualifies */ }
            else if (seen.length && seen.every(item => item.value !== null && item.value < rank)) mark('blocked', 'insufficient-mastery');
            else mark('unknown', 'mastery-skill-unspecified');
          }
        }
      }
      if (Number.isInteger(oper.skill) && oper.skill >= 2 && oper.skill <= 3) check('skill-unlock', oper.skill - 1, actual?.elite);
      const module = required.module, moduleLevel = required.module_level;
      if (module !== undefined && module !== -1) {
        if (!Number.isSafeInteger(module) || module < 0 || module > 5) mark('unknown', 'invalid-module');
        else if (module === 0) {
          // "No module" is picked on the operator's branch page; only an unlocked module proves that page exists.
          const levels = moduleTypes.map(type => observe(snapshotModuleLevel(actual, type, context), fact?.moduleTypes?.[type]));
          observed.module = { type: null, level: levels.find(item => item.value !== null && item.value >= 1) ?? { value: null, from: null, conflict: false } };
          if (levels.some(item => item.conflict)) mark('unknown', 'operator-fact-conflict:module');
          else if (observed.module.level.value === null) mark('unknown', 'unknown-module');
        } else {
          const type = moduleTypes[module - 1]!, needed = Number.isSafeInteger(moduleLevel) && moduleLevel >= 1 && moduleLevel <= 3 ? moduleLevel : 1;
          observed.module = { type, level: observe(snapshotModuleLevel(actual, type, context), fact?.moduleTypes?.[type]) };
          checkObserved('module', needed, observed.module.level);
        }
      }
      if (moduleLevel !== undefined && moduleLevel !== -1 && moduleLevel !== 0) {
        if (!Number.isSafeInteger(moduleLevel) || moduleLevel < 1 || moduleLevel > 3) mark('unknown', 'invalid-module_level');
        // MAA does not read module_level; without a module type it names no module to check.
        else if (!(Number.isSafeInteger(module) && module >= 1 && module <= 5)) mark('unknown', 'module-level-unattributed');
      }
      if (oper.skill !== undefined && (!Number.isInteger(oper.skill) || oper.skill < 0 || oper.skill > 3)) mark('unknown', 'invalid-skill');
      if (oper.role !== undefined) mark('unknown', 'role-unverified');
      for (const key of Object.keys(required)) if (!['elite', 'level', 'potential', 'potentiality', 'skill_level', 'module', 'module_level'].includes(key)) mark('unknown', `unknown-requirement:${key}`);
      // The user's one confirmation of the job settles what only the user can check on this row (jobConfirmationCovers.rows):
      // never a known shortfall, a conflict, an invalid requirement, or an operator the ownership list proves is not owned.
      // Ownership counts as settled only when the list names the operator (same-name forms); without a list the slot stays 待核.
      const unowned = ownershipListed && !matches.length;
      const settled = confirmed && status(checks) === 'unknown' && !unowned
        && reasons.every(reason => coveredRowReason(reason) && (reason !== 'ownership-unobserved-or-ambiguous' || ownershipListed && matches.length > 0));
      const row = { group: name, name: operName, skill: oper.skill ?? 0, required: structuredClone(original), effectiveRequired: required, actual,
        status: settled ? 'ready' as Status : status(checks), reasons, observed, ...(settled ? { confirmed: true as const } : {}) };
      rows.push(row); if (unowned) notOwned.add(row); return row;
    });
    groups.push({ name, rows: groupRows, index: entry.index, opers: entry.opers });
  }
  // Bipartite matching prevents reusing one owned operator in several required slots.
  const assign = (allowUnknown: boolean, slots = groups): Record<string, string> | null => {
    const owners = new Map<string, number>();
    const visit = (index: number, visited: Set<string>): boolean => {
      for (const row of slots[index]!.rows) {
        if (row.status === 'blocked' || !allowUnknown && row.status !== 'ready' || visited.has(row.name)) continue;
        visited.add(row.name); const previous = owners.get(row.name);
        if (previous === undefined || visit(previous, visited)) { owners.set(row.name, index); return true; }
      }
      return false;
    };
    if (!slots.every((_, index) => visit(index, new Set()))) return null;
    return Object.fromEntries([...owners].map(([name, index]) => [slots[index]!.name, name]));
  };
  const assignment = assign(false);
  // MAA v6.21.4 borrows a support unit only when exactly one slot is missing. Here that slot must have no owned member
  // and written, readable requirements to tell the user; every other slot must still be verified ready.
  const missing = assignment ? [] : groups.filter(group => group.rows.every(row => notOwned.has(row)));
  const borrowable = (row: (typeof rows)[number]) => !row.reasons.some(reason => reason === 'requirements-unstated' || reason.startsWith('invalid-') || reason.startsWith('unknown-requirement:'));
  const supportSlot = missing.length === 1 && missing[0]!.rows.every(borrowable) ? missing[0]! : null;
  const supportAssignment = supportSlot ? assign(false, groups.filter(group => group !== supportSlot)) : null;
  const chosen = assignment ?? supportAssignment;
  let execution: ObjectValue | null = null;
  if (chosen) {
    execution = structuredClone(content);
    const normalized = (group: (typeof groups)[number], rowIndex: number) => {
      const oper = structuredClone(object(group.opers[rowIndex])), row = group.rows[rowIndex]!;
      if (digest(row.required) !== digest(row.effectiveRequired)) oper.requirements = structuredClone(row.effectiveRequired);
      return oper;
    };
    // Verified slots keep only their assigned member; the borrowed slot keeps all of its (unowned) members. Empty groups stay as written.
    const selected = new Map(groups.map(group => [group.index, group === supportSlot && !assignment ? group.rows.map((_, rowIndex) => normalized(group, rowIndex))
      : [normalized(group, group.rows.findIndex(row => row.name === chosen[group.name] && row.status === 'ready'))]]));
    if (content.opers !== undefined) execution.opers = content.opers.map((_: unknown, index: number) => selected.get(index)![0]);
    if (content.groups !== undefined) execution.groups = content.groups.map((group: ObjectValue, index: number) => selected.has(fixedCount + index)
      ? { ...structuredClone(group), opers: selected.get(fixedCount + index) } : structuredClone(group));
  }
  const support = !assignment && supportAssignment && supportSlot ? { slot: supportSlot.name, members: supportSlot.rows.map(row => ({ name: row.name, skill: row.skill,
    required: structuredClone(row.required), effectiveRequired: structuredClone(row.effectiveRequired) })) } : null;
  return { requirements: rows, assignment: chosen ?? {}, execution, support, emptyGroups,
    status: assignment ? 'ready' as Status : support ? 'support' as Status : assign(true) ? 'unknown' as Status : 'blocked' as Status };
}

// Copilot schema v6.21.4: an action name is an operator or group name; SetUnitLocation may register non-operator units.
const setUnitLocation = new Set(['SetUnitLocation', 'Setunitlocation', 'setunitlocation', 'SETUNITLOCATION', '设置单位坐标']);
/** Names used by actions that are not declared in opers/groups; summons and devices (TOKEN/TRAP) are excluded. */
function scanActionNames(content: ObjectValue, professions: Map<string, Set<string>>, used: Set<string>) {
  const actions = Array.isArray(content.actions) ? content.actions.filter((action: unknown) => action && typeof action === 'object') as ObjectValue[] : [];
  const declared = new Set<unknown>([...(Array.isArray(content.opers) ? content.opers : []).map((oper: ObjectValue) => oper?.name),
    ...(Array.isArray(content.groups) ? content.groups : []).flatMap((group: ObjectValue) => [group?.name, ...(Array.isArray(group?.opers) ? group.opers : []).map((oper: ObjectValue) => oper?.name)])]);
  const registered = new Set(actions.filter(action => setUnitLocation.has(action.type)).map(action => action.name));
  const undeclared: string[] = [], unrecognized: string[] = [];
  for (const { name } of actions) {
    if (typeof name !== 'string' || !name || declared.has(name)) continue;
    used.add(name); const kinds = professions.get(name);
    if (kinds && [...kinds].some(kind => kind !== 'TOKEN' && kind !== 'TRAP')) { if (!undeclared.includes(name)) undeclared.push(name); }
    else if (!kinds?.size && !registered.has(name) && !unrecognized.includes(name)) unrecognized.push(name);
  }
  return { undeclared, unrecognized };
}

export type StageMatch = 'this-stage' | 'same-map-unprovable' | 'other-stage' | 'unknown';
type StageIndex = Map<string, [string, ObjectValue][]>;
// MAA v6.21.4 resolves a job's stage_name by exact, case-sensitive equality with a level's stageId, code, levelId or name
// (Tile LevelKey), takes the first match in its own data order, and list mode navigates to that level's code. Its map data
// (Arknights-Tile-Pos overview.json) stores levelIds in lowercase, so the table's mixed-case levelId is indexed lowercased:
// a job naming the mixed-case spelling is not found by MAA either. levelId tails never match.
function indexStages(stages: ObjectValue): StageIndex {
  const index: StageIndex = new Map();
  for (const [key, value] of Object.entries(stages)) {
    if (!value || typeof value !== 'object') continue;
    const levelId = typeof value.levelId === 'string' ? value.levelId.toLowerCase() : value.levelId;
    for (const field of new Set([value.stageId, value.code, levelId, value.name])) if (typeof field === 'string' && field) index.set(field, [...(index.get(field) ?? []), [key, value]]);
  }
  return index;
}
const twinDifficulties = ['NORMAL', 'FOUR_STAR'];
/**
 * The single owner of "does this job's stage_name mean the selected stage?". this-stage: every level it names is the
 * selected stage or its normal/raid twin (same levelId, code and difficulty group, the other of NORMAL/FOUR_STAR; the job's
 * difficulty bit decides). Two stages of the same difficulty on one levelId (e.g. mission _m1/_m2) are not twins.
 * same-map-unprovable: it names the same map but not this stage or its twin (another group, a mode such as #s, or a
 * same-difficulty sibling). other-stage: every level it
 * names is a different map. unknown: no level, or a mix MAA's own lookup order would decide. Only other-stage can mean
 * "no job for this stage"; nothing but this-stage can become ready.
 */
export function resolveJobStage(stages: unknown, stageName: unknown, selectedValue: unknown, index: StageIndex = indexStages(object(stages))): { kind: StageMatch; matches: string[] } {
  const selected = object(selectedValue), group = (value: ObjectValue) => value.diffGroup ?? 'NONE';
  const entries = typeof stageName === 'string' && stageName ? index.get(stageName) ?? [] : [];
  const kinds = new Set<StageMatch>(entries.map(([, entry]) => entry.stageId === selected.stageId || entry.levelId === selected.levelId && entry.code === selected.code
    && group(entry) === group(selected) && entry.difficulty !== selected.difficulty && twinDifficulties.includes(entry.difficulty) && twinDifficulties.includes(selected.difficulty) ? 'this-stage'
    : entry.levelId === selected.levelId ? 'same-map-unprovable' : 'other-stage'));
  const kind: StageMatch = !kinds.size ? 'unknown' : kinds.size === 1 ? [...kinds][0]! : kinds.has('other-stage') ? 'unknown' : 'same-map-unprovable';
  return { kind, matches: entries.map(([key]) => key) };
}
const stageReasons: Record<StageMatch, string | null> = { 'this-stage': null, 'same-map-unprovable': 'stage-same-map-unproven', 'other-stage': 'map-mismatch', unknown: 'stage-name-unresolved' };

/** The request is the user's explicit scope. Remote content contributes facts, never authorization. */
export function matchStageJobs(snapshotValue: unknown, tablesValue: unknown, request: StageRequest, jobs: Job[], search?: SearchCoverage[], options: { maaVersionSource?: MaaVersionSource } = {}) {
  const snapshot = object(snapshotValue), tables = object(object(tablesValue).stages);
  if (!Array.isArray(request.stages) || !request.stages.length || request.stages.length > 100) throw new Error('scope-invalid');
  const coverage = search ?? request.stages.map(stage => ({ stageId: stage.stageId, mode: 'offline' as const, pages: 0, truncated: false, ids: [] }));
  if (!Array.isArray(jobs)) throw new Error('jobs-invalid');
  const jobsById = new Map(jobs.map(job => [job?.id, job]));
  const stageIndex = indexStages(tables), usedStages = new Set<string>();
  // Optional character catalog (pinned game data): id -> { name, profession }. Absent means names cannot be classified.
  const rawCatalog = object(tablesValue).characters, catalog: ObjectValue = rawCatalog && typeof rawCatalog === 'object' && !Array.isArray(rawCatalog) ? rawCatalog : {};
  const professions = new Map<string, Set<string>>(), usedNames = new Set<string>();
  for (const entry of Object.values(catalog)) if (entry && typeof entry.name === 'string' && typeof entry.profession === 'string') professions.set(entry.name, (professions.get(entry.name) ?? new Set()).add(entry.profession));
  // Optional module catalogue (pinned uniequip table): without it, a snapshot's module levels cannot be tied to a module type.
  const context: MatchContext = { facts: operatorFacts(request), modules: moduleCatalog(object(tablesValue)), usedModules: new Set(),
    skillCounts: skillCounts(object(tablesValue)), usedSkillCounts: new Set() };
  const confirmations = jobConfirmations(request);
  if (!Array.isArray(coverage) || coverage.length !== request.stages.length || coverage.some((item, index) => item.stageId !== request.stages[index]!.stageId
    || !['online', 'offline'].includes(item.mode) || !Number.isInteger(item.pages) || item.pages < (item.mode === 'online' ? 1 : 0) || item.pages > 3
    || typeof item.truncated !== 'boolean' || item.mode === 'offline' && (item.pages !== 0 || item.truncated) || item.truncated && item.pages !== 3
    // ids are the jobs this stage's own query returned, in order; they let the report tell "no jobs" from unrelated results.
    || !Array.isArray(item.ids) || item.ids.length > item.pages * 20 || new Set(item.ids).size !== item.ids.length || item.ids.some(id => !Number.isSafeInteger(id) || id < 1 || !jobsById.has(id)))) throw new Error('search-coverage-invalid');
  const seen = new Set<string>();
  const stages = request.stages.map(selected => {
    if (seen.has(selected.stageId)) throw new Error('duplicate-stage'); seen.add(selected.stageId);
    if (!selected || typeof selected !== 'object' || !Object.hasOwn(tables, selected.stageId) || !tables[selected.stageId] || typeof tables[selected.stageId] !== 'object') throw new Error('stage-identity-mismatch');
    const stage = object(tables[selected.stageId]);
    if (stage.stageId !== selected.stageId || stage.code !== selected.code || !['normal', 'raid'].includes(selected.difficulty)
      || stage.difficulty !== (selected.difficulty === 'normal' ? 'NORMAL' : 'FOUR_STAR')) throw new Error('stage-identity-mismatch');
    if (!Number.isSafeInteger(selected.loops) || selected.loops < 1 || selected.loops > 1000) throw new Error('loops-invalid');
    const map = text(stage.zoneId), levelId = text(stage.levelId);
    const difficultyGroup = text(stage.diffGroup ?? 'NONE');
    const identify = (stageName: unknown) => { const found = resolveJobStage(tables, stageName, stage, stageIndex); for (const key of found.matches) usedStages.add(key); return found.kind; };
    // OB-2: each prerequisite carries its stage code when the table has it, so the agent can ask the user about all of them at
    // once; its table entry travels with the report so preparation re-verifies identically.
    const prerequisiteChecks = Array.isArray(stage.unlockCondition) ? stage.unlockCondition.map((value: unknown) => {
      const requirement = object(value), actual = request.completions?.[requirement.stageId], stageId = text(requirement.stageId);
      const state: Status = !request.completionEvidence?.trim() || !actual ? 'unknown' : actual === requirement.completeState || actual === 'COMPLETE' && requirement.completeState === 'PASS' ? 'ready' : 'blocked';
      const entry = Object.hasOwn(tables, stageId) && tables[stageId] && typeof tables[stageId] === 'object' ? tables[stageId] as ObjectValue : null;
      if (entry) usedStages.add(stageId);
      return { stageId, code: typeof entry?.code === 'string' ? entry.code as string : null, required: text(requirement.completeState), actual: actual ?? null, status: state };
    }) : [{ stageId: selected.stageId, code: selected.code as string | null, required: 'unknown', actual: null, status: 'unknown' as Status }];
    // OB-1 (over-blocking review, 2026-11-16): one job's content error is that candidate's own blocked state, never a failure
    // of the stage or the batch. `confirmed`: the user confirmed this job's content once (jobConfirmations).
    // `answered`: treat prerequisites still unverified as answered (only for `confirmable`; a known-unmet one stays blocked).
    const evaluate = (job: Job, confirmed: boolean, answered = false) => {
      if (!job.content || typeof job.content !== 'object' || Array.isArray(job.content)) throw new Error('content-not-object');
      const content = job.content, reasons: string[] = [];
      const stageMatch = identify(content.stage_name);
      if (stageReasons[stageMatch]) reasons.push(stageReasons[stageMatch]!);
      // MAA v6.21.4 GUI adds a job whose difficulty is 0 or missing (DifficultyFlags.None) to the list as normal only.
      const flag = selected.difficulty === 'normal' ? 1 : 2, declared = content.difficulty === undefined ? 0 : content.difficulty;
      if (!Number.isInteger(declared) || declared < 0 || declared > 3 || declared > 0 && !(declared & flag)) reasons.push('difficulty-mismatch');
      else if (declared === 0 && flag === 2) reasons.push('difficulty-unstated-normal-only');
      if (!Array.isArray(content.actions) || !content.actions.length) reasons.push('full-job-required');
      if (content.type !== undefined && content.type !== 'Copilot') reasons.push('unsupported-job-type');
      const operators = matchOperators(snapshot, content, context, confirmed);
      const actionNames = scanActionNames(content, professions, usedNames), versionReady = versionMet(request.maaVersion, content.minimum_required);
      const open = (check: (typeof prerequisiteChecks)[number]) => answered && check.status === 'unknown';
      const checks: Status[] = [...prerequisiteChecks.map(check => open(check) ? 'ready' : check.status), operators.status, versionReady ? 'ready' : 'unknown'];
      // OB-2: every prerequisite that is not verified or not met is named, so the agent can ask the user about all of them once.
      for (const check of prerequisiteChecks) if (check.status !== 'ready' && !open(check)) reasons.push(`${check.status === 'blocked' ? 'prerequisite-unmet' : 'prerequisite-unverified'}:${check.stageId}:${check.required}`);
      // MAA's formation skips a group with no members; the battle may still name it, so the job stays 待核.
      if (operators.emptyGroups.length) { checks.push('unknown'); reasons.push('job-group-empty'); }
      // Action names and the document's notes are what the user checks against the job text; a job confirmation covers them.
      if (actionNames.undeclared.length) { checks.push(confirmed ? 'ready' : 'unknown'); reasons.push('action-operator-undeclared'); }
      if (actionNames.unrecognized.length) { checks.push(confirmed ? 'ready' : 'unknown'); reasons.push('action-name-unrecognized'); }
      if (!versionReady) reasons.push('version-unverified');
      if (typeof content.doc?.details === 'string' && content.doc.details.trim()) {
        const proof = request.documentChecks?.find(check => check.jobId === job.id && check.contentHash === digest(content) && check.reference?.trim());
        checks.push(proof?.satisfied === true ? 'ready' : proof?.satisfied === false ? 'blocked' : confirmed ? 'ready' : 'unknown');
        if (!proof) reasons.push('document-conditions-unverified');
      }
      return { id: job.id, status: reasons.some(reason => blockingReasons.includes(reason)) ? 'blocked' as Status : status(checks), reasons, source: job.source, stageMatch,
        requirements: operators.requirements, assignment: operators.assignment, content: structuredClone(content) as unknown as ObjectValue, hash: digest(content),
        execution: operators.execution ? { content: operators.execution, hash: digest(operators.execution) } : null, rating: rateJob(job), actionNames, support: operators.support,
        confirmation: null as { reference: string } | null, confirmable: false };
    };
    const candidates = jobs.map(job => {
      if (!Number.isSafeInteger(job.id) || job.id <= 0) throw new Error('job-id-invalid');
      const confirmation = confirmations.get(job.id), applies = confirmation?.contentHash === digest(job.content ?? null);
      try {
        const candidate = evaluate(job, applies);
        if (confirmation && !applies) candidate.reasons.push('job-confirmation-content-changed');
        if (applies) candidate.confirmation = { reference: confirmation!.reference };
        // Whether one confirmation of this job (with the answer to any prerequisite still unverified) would make it ready: the
        // agent asks the user only then, and asks both in the same question.
        else if (candidate.status === 'unknown') candidate.confirmable = evaluate(job, true, true).status === 'ready';
        return candidate;
      } catch (error) {
        const code = error instanceof Error && /^[a-z][a-z0-9-]{0,63}$/.test(error.message) ? error.message : 'unreadable', content = job.content as unknown;
        return { id: job.id, status: 'blocked' as Status, reasons: [`job-content-invalid:${code}`], source: job.source,
          stageMatch: content && typeof content === 'object' && !Array.isArray(content) ? identify((content as ObjectValue).stage_name) : 'unknown' as StageMatch,
          requirements: [] as ReturnType<typeof matchOperators>['requirements'], assignment: {} as Record<string, string>, content: structuredClone(job.content ?? null) as unknown as ObjectValue,
          hash: digest(job.content ?? null), execution: null, rating: rateJob(job), actionNames: { undeclared: [] as string[], unrecognized: [] as string[] }, support: null,
          confirmation: null as { reference: string } | null, confirmable: false };
      }
    });
    // Candidates keep the API order as evidence; suggestions demote not-enough/unknown and then low ratings, stably.
    const ranked = (state: Status) => candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => candidate.status === state)
      .sort((a, b) => ratingTier(a.candidate.rating) - ratingTier(b.candidate.rating) || a.index - b.index).map(({ candidate }) => candidate);
    const ready = ranked('ready');
    // The live backend matches level_keyword against level name / levelId / stageId; with no match it drops the stage
    // filter (no document parameter is sent) and returns unrelated site-wide jobs. Classify what this query returned.
    const searched = coverage.find(item => item.stageId === selected.stageId)!, keyword = levelId.split('level_').at(-1)!;
    const returned = searched.ids.map(id => { const content = jobsById.get(id)!.content as unknown; return content && typeof content === 'object' && !Array.isArray(content) ? (content as ObjectValue).stage_name : undefined; }),
      kinds = returned.map(identify);
    const count = (kind: StageMatch) => kinds.filter(item => item === kind).length, belonging = count('this-stage'), sameMap = count('same-map-unprovable'), unresolved = count('unknown');
    // Only results that provably name other maps may be reported as "no jobs for this stage".
    const outcome: SearchOutcome = searched.mode === 'offline' ? 'offline' : belonging ? 'found' : !returned.length ? searched.truncated ? 'insufficient' : 'empty'
      : sameMap ? 'same-map-unproven' : !returned.some(name => typeof name === 'string' && name.includes(keyword)) ? 'fallback-suspected'
      : searched.truncated ? 'insufficient' : unresolved ? 'unresolved' : 'other-stages';
    return { ...selected, map, levelId, difficultyGroup, prerequisites: prerequisiteChecks, candidates, primary: ready[0]?.id ?? null, alternates: ready.slice(1, 4).map(candidate => candidate.id),
      // 需借助战 candidates are never default suggestions; the user names them explicitly at approval.
      supportCandidates: ranked('support').map(candidate => candidate.id), searchResult: { outcome, returned: returned.length, belonging, sameMap, unresolved } };
  });
  const result = { version: 1 as const, authorization: 'none' as const, request: structuredClone(request), search: structuredClone(coverage), snapshotHash: digest(snapshot), snapshotReadAt: snapshot.readAt ?? null,
    // 'skland': its read time is not the in-game data time, and how far Skland lags behind the game has not been measured.
    snapshotSource: snapshot.source === 'maa' || snapshot.source === 'skland' ? snapshot.source as 'maa' | 'skland' : null,
    // OB-3: where request.maaVersion came from (the CLI fills an absent version from the installed MAA before matching).
    ...(options.maaVersionSource ? { maaVersionSource: options.maaVersionSource } : {}),
    // Requested stages plus every table entry a job's stage_name resolved to, so preparation re-resolves identically.
    tables: { stages: Object.fromEntries([...request.stages.map(stage => stage.stageId), ...[...usedStages].filter(key => !request.stages.some(stage => stage.stageId === key)).sort()]
      .map(key => [key, structuredClone(tables[key])])), source: structuredClone(object(tablesValue).source ?? { kind: 'offline-input' }),
      characters: Object.fromEntries(Object.entries(catalog).filter(([, entry]) => usedNames.has(entry?.name) && typeof entry.profession === 'string').map(([id, entry]) => [id, { name: entry.name, profession: entry.profession }])),
      charactersSource: structuredClone(object(tablesValue).charactersSource ?? null),
      // Every module entry consulted for a snapshot operator, so preparation re-verifies module requirements identically.
      modules: Object.fromEntries([...context.usedModules].sort().map(id => [id, structuredClone(context.modules[id]!)])),
      modulesSource: structuredClone(object(tablesValue).modulesSource ?? null),
      // Skill counts consulted for a skill-0 mastery check, so preparation re-verifies it identically.
      skillCounts: Object.fromEntries([...context.usedSkillCounts].sort().map(id => [id, context.skillCounts[id]!])) }, snapshot: structuredClone(snapshot), jobs: structuredClone(jobs), stages,
    batches: [...new Set(stages.map(stage => JSON.stringify([stage.map, stage.difficulty, stage.difficultyGroup])))].map(key => {
      const [map, difficulty, difficultyGroup] = JSON.parse(key) as string[];
      return { map: map!, difficulty: difficulty!, difficultyGroup: difficultyGroup!, stages: stages.filter(stage => stage.map === map && stage.difficulty === difficulty && stage.difficultyGroup === difficultyGroup).map(stage => stage.stageId) };
    }) };
  return { ...result, hash: digest(result) };
}

async function publicResponse(url: string, fetcher: typeof fetch) {
  const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error('job-network-failed'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('job-response-empty');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
      if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('job-response-too-large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks, bytes), result = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
  if (result.status_code !== 200) throw new Error('job-api-rejected');
  return { data: object(result.data), source: { url, readAt: new Date().toISOString(), sha256: createHash('sha256').update(body).digest('hex') } };
}

/** Bounded public GET queries; no credentials, redirects, rating votes or submissions. Ratings are only read. */
export async function collectStageJobs(snapshot: unknown, tables: unknown, request: StageRequest, fetcher: typeof fetch = fetch, options: { maaVersionSource?: MaaVersionSource } = {}) {
  matchStageJobs(snapshot, tables, request, []); // Validate the entire scope before making a network request.
  const jobs: Job[] = [], seen = new Set<number>(), search: SearchCoverage[] = [];
  for (const stage of request.stages) {
    const keyword = text(object(object(object(tables).stages)[stage.stageId]).levelId).split('level_').at(-1)!;
    let next = true, page = 1; const ids: number[] = [];
    for (; next && page <= 3; page++) {
      const url = `https://prts.maa.plus/copilot/query?${new URLSearchParams({ page: String(page), limit: '20', level_keyword: keyword, language: 'cn' })}`;
      const response = await publicResponse(url, fetcher), data = response.data;
      if (!Array.isArray(data.data) || data.data.length > 20 || typeof data.has_next !== 'boolean') throw new Error('job-query-invalid');
      next = data.has_next;
      for (const entry of data.data) {
        const summary = object(entry), id = Number(summary.id);
        if (!Number.isSafeInteger(id) || id < 1) throw new Error('job-id-invalid');
        if (!ids.includes(id)) ids.push(id);
        if (seen.has(id)) continue; seen.add(id);
        const result = await publicResponse(`https://prts.maa.plus/copilot/get/${id}`, fetcher);
        if (Number(result.data.id) !== id || typeof result.data.content !== 'string') throw new Error('job-detail-invalid');
        // The detail endpoint serves an in-process cached copy; rating counts come from the fresher query summary.
        const rating = ['like', 'dislike', 'not_enough_rating'].some(key => Object.hasOwn(summary, key)) ? { like: summary.like, dislike: summary.dislike,
          notEnoughRating: summary.not_enough_rating, ratingLevel: summary.rating_level, ratingRatio: summary.rating_ratio, source: response.source } as JobRating : undefined;
        // OB-1: content that does not parse stays with its job as the raw text; the matcher blocks that one candidate.
        let content: unknown; try { content = JSON.parse(result.data.content); } catch { content = result.data.content; }
        jobs.push({ id, content: content as ObjectValue, source: result.source, ...(rating ? { rating } : {}) });
      }
    }
    search.push({ stageId: stage.stageId, mode: 'online', pages: page - 1, truncated: next, ids });
  }
  return matchStageJobs(snapshot, tables, request, jobs, search, options);
}

/** Summary and per-operator training view; untrusted document text remains quoted data. */
export function formatStageJobs(report: StageReport & { snapshotSelection?: Pick<SnapshotSelection, 'source' | 'readAt' | 'chosen' | 'lacking'> }, operator?: string): string {
  const escape = (value: unknown) => String(value).replace(/[<>|`\r\n]/g, char => ({ '<': '&lt;', '>': '&gt;', '|': '\\|', '`': '\\`', '\r': ' ', '\n': ' ' })[char]!);
  const skillsHint = '技能等级、专精和模组的要求可请用户确认（operatorFacts，或用户核实整份作业后确认一次 jobConfirmations），或先由 maa-account 读取森空岛快照后重新查询。';
  const sourceLine = report.snapshotSelection ? `${snapshotSourceLine(report.snapshotSelection)}${report.snapshotSelection.source === 'maa' ? skillsHint : ''}`
    : report.snapshotSource === 'skland' ? '账号来源：森空岛快照（只读）。读取时间是本次从森空岛读取的时间，不是游戏内的数据时间；森空岛数据比游戏内滞后多久没有测过。'
    : report.snapshotSource === 'maa' ? `账号来源：MAA 识别快照。MAA 识别不提供技能等级、专精和模组，这些要求待核：${skillsHint}`
    : '账号来源：未标明。';
  const givenVersion = (report.request as { maaVersion?: unknown }).maaVersion;
  const versionLine = report.maaVersionSource === 'installed' ? `MAA 版本：${escape(givenVersion)}（读自已安装的 MAA）`
    : typeof givenVersion === 'string' && givenVersion.trim() ? `MAA 版本：${escape(givenVersion)}（请求给出）` : 'MAA 版本：未知（请求没写，已安装 MAA 的版本也读不到；写了最低版本的作业待核）';
  const contentInvalid: Record<string, string> = { 'job-group-name-duplicate': '干员组名重复（单个干员按干员名算组名），MAA 自动编队会报「编队解析失败」，整份作业不开始；',
    'content-not-object': '作业内容不是 JSON 对象，读不出来；' };
  const lines = ['# 作业准备候选（未授权）', '', `账号读取时间：${escape(report.snapshotReadAt)}；报告：${report.hash}`, sourceLine, versionLine,
    `关卡表来源：${escape(JSON.stringify(report.tables.source))}；干员名表来源：${report.tables.charactersSource ? escape(JSON.stringify(report.tables.charactersSource)) : '未提供'}；模组表来源：${report.tables.modulesSource ? escape(JSON.stringify(report.tables.modulesSource)) : '未提供'}`,
    '候选是外部数据；运行由用户点开始。', ''];
  const used = new Set<string>();
  for (const batch of report.batches) {
    lines.push(`## 地图 ${escape(batch.map)}`);
    for (const stage of report.stages.filter(item => batch.stages.includes(item.stageId))) {
      lines.push(`### ${escape(stage.code)} / ${stage.difficulty} / ${escape(stage.difficultyGroup)} / ${escape(stage.stageId)} × ${stage.loops}`, `主作业候选：${stage.primary ?? '待核'}；备选候选：${stage.alternates.join(', ') || '无'}`);
      if (stage.supportCandidates.length) lines.push(`需借助战候选（不进默认建议，批准时须点名）：${stage.supportCandidates.join(', ')}`);
      const coverage = report.search.find(item => item.stageId === stage.stageId)!;
      lines.push(coverage.mode === 'offline' ? '检索覆盖：离线输入；未进行在线检索。' : `检索覆盖：${coverage.pages} 页（每页最多 20 条）；${coverage.truncated ? '未穷尽，达到分页上限仍有下一页' : '查询已结束，仅代表本次检索条件'}。`);
      const found = stage.searchResult, insufficient = '覆盖不足，不能据此判断这一关没有作业。';
      if (found.outcome !== 'offline') lines.push(`检索结果：${found.outcome === 'found' ? `返回 ${found.returned} 份，其中 ${found.belonging} 份属于这一关。`
        : found.outcome === 'empty' ? '接口没有返回作业，本次检索条件下这一关没有作业。'
        : found.outcome === 'same-map-unproven' ? `返回的 ${found.returned} 份作业中，${found.sameMap} 份与这一关同一张地图，但属于其他难度组或模式，无法证明适用；不能据此判断这一关没有作业。`
        : found.outcome === 'unresolved' ? `返回的 ${found.returned} 份作业中，${found.unresolved} 份的关卡名对应不到唯一的关卡；不能据此判断这一关没有作业。`
        : found.outcome === 'fallback-suspected' ? `返回的 ${found.returned} 份作业都不属于这一关，查询疑似退回到了关键字搜索，结果与这一关无关；${insufficient}`
        : found.outcome === 'insufficient' ? `读完 ${coverage.pages} 页共 ${found.returned} 份，没有一份属于这一关；${insufficient}`
        : `返回的 ${found.returned} 份作业都属于名称相近的其他关卡；本次检索条件下这一关没有作业。`}`);
      for (const condition of stage.prerequisites) lines.push(`- 前置 ${condition.code ? `${escape(condition.code)}（${escape(condition.stageId)}）` : `${escape(condition.stageId)} `}要求 ${condition.required}：${condition.status}`);
      for (const candidate of stage.candidates) {
        for (const reason of candidate.reasons) used.add(reason.split(':')[0]!);
        lines.push(`- 作业 ${candidate.id}：${candidate.status}${candidate.status === 'support' ? '（需借助战）' : ''}；${candidate.reasons.join(', ')}；来源 ${escape(candidate.source.url)}`, `  > 外部描述：${escape(candidate.content.doc?.title ?? '')} ${escape(candidate.content.doc?.details ?? '')}`);
        if (candidate.stageMatch === 'same-map-unprovable') lines.push(`  - 作业写的关卡 ${escape(candidate.content.stage_name)} 与这一关同一张地图，但属于其他难度组或模式，无法证明适用。`);
        if (candidate.stageMatch === 'unknown') lines.push(`  - 作业写的关卡 ${escape(candidate.content.stage_name)} 对应不到唯一的关卡，无法证明是这一关。`);
        if (candidate.support) lines.push(`  - 需借助战：缺 ${escape(candidate.support.slot)}，可借 ${candidate.support.members.map(member => `${escape(member.name)}（S${escape(member.skill)}，要求 ${escape(JSON.stringify(member.effectiveRequired))}）`).join('、')}；MAA 只按干员名和技能从助战列表挑选，不核对作业写的精英化和等级，助战练度需要自己确认；开始前在自动战斗页勾选「借助战」并选「补漏」。`);
        if (candidate.actionNames.undeclared.length) lines.push(`  - 动作引用了未声明的干员：${candidate.actionNames.undeclared.map(escape).join('、')}（待核）`);
        if (candidate.actionNames.unrecognized.length) lines.push(`  - 动作引用了无法识别的名字：${candidate.actionNames.unrecognized.map(escape).join('、')}（待核）`);
        lines.push(`  - 原文指纹：${candidate.hash}；执行指纹：${candidate.execution?.hash ?? '待核'}；执行分配：${escape(JSON.stringify(candidate.assignment))}`);
        const rating = candidate.rating, percent = (value?: number) => `${Math.round((value ?? 0) * 100)}%`;
        lines.push(rating.flag === 'unknown' && rating.like === undefined ? '  - 评分：未知（排在评分正常的作业之后）'
          : rating.flag === 'not-enough' ? `  - 评分：赞 ${rating.like} / 踩 ${rating.dislike}；作业站标记评分不足，排在评分正常的作业之后`
          : rating.flag === 'unknown' ? `  - 评分：赞 ${rating.like} / 踩 ${rating.dislike}；评分未知（排在评分正常的作业之后）`
          : `  - 评分：赞 ${rating.like} / 踩 ${rating.dislike}（好评率 ${percent(rating.likeRatio)}，所需 ${percent(rating.requiredRatio)}）；${rating.flag === 'low' ? '好评率低，排在后面' : '评分正常'}`);
        for (const reason of candidate.reasons.filter(item => item.startsWith('job-content-invalid:'))) {
          const code = reason.slice('job-content-invalid:'.length);
          lines.push(`  - 作业内容不合法（${escape(code)}）：${contentInvalid[code] ?? 'MAA 用不了这份作业的干员列表或格式；'}不能准备，改选其他作业。`);
        }
        if (candidate.confirmation) lines.push(`  - 用户确认（整份作业一次）：${escape(candidate.confirmation.reference)}`);
        else if (candidate.confirmable) lines.push(`  - 其余待核项只有用户能核对：用户核实后对这份作业确认一次即可准备（jobConfirmations：jobId ${candidate.id}、原文指纹 ${candidate.hash}、用户原话）${candidate.reasons.some(reason => reason.startsWith('prerequisite-unverified:')) ? '；前置也没核实：把前置和这份作业的确认放进同一个问题' : ''}。`);
        if (candidate.reasons.includes('job-group-empty')) lines.push('  - 有成员为空的干员组：MAA 编队会跳过它，作业动作若用到这个组就部署不了，待核。');
        for (const row of candidate.requirements.filter(row => !operator || row.name === operator)) {
          const seen = (item: Observed | undefined) => item?.value === null || item === undefined ? '未知' : `${item.value}${item.from === 'user-confirmed' ? '（用户确认）' : ''}`;
          const skills = [row.observed.skillLevel ? `技能等级 ${seen(row.observed.skillLevel)}` : '',
            ...Object.entries(row.observed.mastery ?? {}).map(([slot, item]) => `${slot} 技能专精 ${seen(item)}`),
            row.observed.module ? `${row.observed.module.type ? `${row.observed.module.type} 模组等级` : '已解锁模组'} ${seen(row.observed.module.level)}` : ''].filter(Boolean).join(' / ');
          for (const reason of row.reasons) used.add(reason.split(':')[0]!);
          lines.push(`  - ${escape(row.name)}（${escape(row.group)}，S${escape(row.skill)}）：${row.status}${row.confirmed ? '（用户对整份作业确认）' : ''}；要求 ${escape(JSON.stringify(row.required))}${digest(row.required) !== digest(row.effectiveRequired) ? `；规范化 ${escape(JSON.stringify(row.effectiveRequired))}` : ''}${row.reasons.includes('requirements-unstated') ? '；要求未写明，待核' : ''}；当前精英 ${row.actual?.elite ?? '未知'} / 等级 ${row.actual?.level ?? '未知'}${skills ? ` / ${skills}` : ''}；${row.reasons.join(', ')}`);
        }
      }
    }
  }
  const legend: [string, string][] = [
    ['prerequisite-unverified', '这一关的前置关卡没有核实（原因码依次是前置关卡和要求的通关状态：PASS 为通过，COMPLETE 为三星）。把这次所有关卡的前置合成一个问题问用户（例如「SYN-0 打过了吗？」），把回答写进 completions、用户原话写进 completionEvidence 后重新查询；不问就不会变成可准备。'],
    ['prerequisite-unmet', '用户说的通关状态不够前置要求（例如突袭要求普通关三星），这份作业不能准备。'],
    ['version-unverified', '核对不了作业要求的最低 MAA 版本：请求没写 maaVersion 时读已安装 MAA 的版本，读不到时待核。'],
    ['job-content-invalid', '作业内容不合法，MAA 用不了，这份作业不能准备；同一关的其他作业照常核对。'],
    ['job-confirmation-content-changed', '用户确认的是另一份原文（指纹不同），这次确认不适用；把这份作业现在的内容告诉用户后重新确认。'],
    ['requirements-unstated', '作业没写这位干员的练度要求，无从核对：用户核实后可对整份作业确认一次（jobConfirmations）。'],
    ['role-unverified', '作业写了干员职责（role），这里不核对：用户核实后可对整份作业确认一次（jobConfirmations）。'],
    ['unknown-requirement', '作业写了 MAA 不读的要求字段：用户核实后可对整份作业确认一次（jobConfirmations）。'],
    ['ownership-unobserved-or-ambiguous', '快照里没有唯一一位同名干员：干员列表里没有这个名字（没有这位干员），或快照没有干员列表时，不能确认；同名异格时用户核实后可对整份作业确认一次（jobConfirmations）。'],
    ['action-operator-undeclared', '动作用到了没在干员和干员组里声明的干员：用户核实后可对整份作业确认一次（jobConfirmations）。'],
    ['action-name-unrecognized', '动作用到了认不出的名字：用户核实后可对整份作业确认一次（jobConfirmations）。'],
    ['document-conditions-unverified', '作业说明里有文字条件：读给用户，按 documentChecks 记下结论，或用户核实整份作业后确认一次（jobConfirmations）。'],
    ['unknown-skill-level', '快照没有技能等级（MAA 识别不提供）：改用森空岛快照，或请用户确认后写进 operatorFacts，或用户核实整份作业后确认一次（jobConfirmations）。'],
    ['unknown-mastery', '快照没有这个技能的专精（MAA 识别不提供）：改用森空岛快照，或请用户确认后写进 operatorFacts，或用户核实整份作业后确认一次（jobConfirmations）。'],
    ['unknown-module', '读不到这种模组的等级：快照没有模组数据、模组表里找不到这种模组，或森空岛没返回；改用森空岛快照，或请用户确认后写进 operatorFacts 的 moduleTypes。'],
    ['mastery-skill-unspecified', '作业没指定技能（skill 为 0），MAA 沿用默认或上次的技能；只有每个技能都达到这个专精才算满足。要核对，得用列出全部技能的森空岛快照，或请用户确认这位干员每个技能各自的专精（operatorFacts；技能数取自固定干员表，读不到时按三个技能）。'],
    ['module-level-unattributed', '作业写了模组等级却没写模组类型，MAA 不读模组等级，无从核对。'],
    ['operator-fact-conflict', '用户确认的事实与快照里已知的值不同，先请用户再核对，不覆盖快照。'],
    ['insufficient-mastery', '专精已知不够，这份作业不能准备。'],
    ['insufficient-module', '这种模组未解锁或等级已知不够，这份作业不能准备；MAA 自动编队选不到这个模组时也会跳过该干员。'],
  ];
  const explained = legend.filter(([reason]) => used.has(reason));
  if (explained.length) lines.push('', '## 原因说明', ...explained.map(([reason, words]) => `- ${reason}：${words}`));
  return lines.join('\n') + '\n';
}

/** Approve one map batch at a time. No process start here starts a game task. */
export async function prepareStageJobs(input: { report: StageReport; approval: StageApproval; snapshot: unknown; maaDirectory: string; privateDirectory: string;
  profile: number; host: 'codex' | 'claude'; expectedRevision: string; closedConfirmed?: boolean }, maa: MaaProcess) {
  const { approval, report } = structuredClone(input);
  // `versions` is the stamp saved with the report (outside its hash); a difference is reported, never refused.
  // `snapshotSelection` (which saved snapshot the query read, and why) is also outside the hash.
  const { hash: reportHash, versions: generatedVersions, snapshotSelection: _selection, ...displayed } = report as StageReport & { versions?: unknown; snapshotSelection?: unknown };
  // A report that no longer re-verifies (tampered, or produced by an older matcher structure) cannot bind an approval.
  let verified: StageReport;
  try { verified = matchStageJobs(report.snapshot, report.tables, report.request, report.jobs, report.search, { maaVersionSource: report.maaVersionSource }); } catch { throw new CheckRequiredError('stage-jobs-report-stale'); }
  if (digest(displayed) !== reportHash || verified.hash !== report.hash) throw new CheckRequiredError('stage-jobs-report-stale');
  if (digest(input.snapshot) !== report.snapshotHash) throw new CheckRequiredError('stage-jobs-snapshot-changed');
  if (approval.reportHash !== report.hash || !approval.reference?.trim() || !Array.isArray(approval.selections) || !approval.selections.length
    || !Number.isInteger(input.profile) || input.profile < 0) throw new Error('approval-mismatch');
  const seen = new Set<string>();
  const plan: ApprovedJobPlan = { reportHash: report.hash, map: approval.map, entries: approval.selections.map(selection => {
    const stage = verified.stages.find(stage => stage.stageId === selection.stageId);
    if (!stage || stage.map !== approval.map || seen.has(stage.stageId) || selection.loops !== stage.loops || !Array.isArray(selection.alternates)) throw new Error('approval-mismatch');
    seen.add(stage.stageId);
    const ids = [selection.primary, ...selection.alternates], supportJobs = selection.supportJobs ?? [];
    if (new Set(ids).size !== ids.length) throw new Error('approval-mismatch');
    // 需借助战 jobs need the user's explicit naming; naming anything else as borrowed is a mismatch, not a widening.
    if (!Array.isArray(supportJobs) || new Set(supportJobs).size !== supportJobs.length
      || supportJobs.some(id => !ids.includes(id) || stage.candidates.find(candidate => candidate.id === id)?.status !== 'support')) throw new CheckRequiredError('stage-jobs-support-not-named');
    const selectedJobs = ids.map(id => {
      const candidate = stage.candidates.find(candidate => candidate.id === id);
      if (!candidate) throw new Error('approval-mismatch');
      if (candidate.status === 'support' && !supportJobs.includes(id)) throw new CheckRequiredError('stage-jobs-support-not-named');
      if (!candidate.execution || !(candidate.status === 'ready' || candidate.status === 'support')) throw new Error('approval-requires-ready-candidate');
      return { id, hash: candidate.execution.hash, sourceHash: candidate.hash, source: candidate.source,
        ...(candidate.support ? { support: { slot: candidate.support.slot, members: candidate.support.members.map(member => member.name) } } : {}) };
    });
    return { stageId: stage.stageId, code: stage.code, difficulty: stage.difficulty, difficultyGroup: stage.difficultyGroup, loops: selection.loops, primary: selectedJobs[0]!, alternates: selectedJobs.slice(1) };
  }) };
  const list = approvedJobList(plan, input.privateDirectory);
  // From the first job file on, only a known conflict keeps its reason: anything else may have left files or a transaction behind.
  try { return await writeApprovedJobs(input, report, verified, plan, list, generatedVersions, maa); }
  catch (error) { throw error instanceof Error && error.message === 'job-file-conflict' ? error : new CheckRequiredError('stage-jobs-prepare-outcome-unknown'); }
}

async function writeApprovedJobs(input: Parameters<typeof prepareStageJobs>[0], report: StageReport, verified: StageReport, plan: ApprovedJobPlan,
  list: ReturnType<typeof approvedJobList>, generatedVersions: unknown, maa: MaaProcess) {
  const approval = input.approval;
  for (const entry of plan.entries) for (const selected of [entry.primary, ...entry.alternates]) {
    const candidate = verified.stages.find(stage => stage.stageId === entry.stageId)!.candidates.find(job => job.id === selected.id)!;
    for (const [file, content] of [[approvedJobFile(input.privateDirectory, report.hash, selected.id), candidate.execution!.content], [approvedJobSourceFile(input.privateDirectory, report.hash, selected.id), candidate.content]] as const) {
      const bytes = JSON.stringify(content) + '\n';
      await mkdir(dirname(file), { recursive: true });
      let handle;
      try { handle = await open(file, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await readFile(file, 'utf8') !== bytes) throw new Error('job-file-conflict');
      }
      if (handle) try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    }
  }
  const versions = compareVersionStamp(generatedVersions, await versionStampOf(input.maaDirectory, maa));
  return { ...await executeConfigWrite({ maaDirectory: input.maaDirectory, privateDirectory: input.privateDirectory, host: input.host, expectedRevision: input.expectedRevision,
    closedConfirmed: input.closedConfirmed, authorization: { source: 'current-request', reference: approval.reference, jobPlan: plan },
    changes: [{ path: ['Configurations', input.profile, 'Copilot', 'TaskList'], value: list }, { path: ['Configurations', input.profile, 'Copilot', 'EnableUserAdditional'], value: false }] }, maa), versions };
}

export const stageTableSource = { repository: 'Kengxxiao/ArknightsGameData', commit: '6f63c14e27b847ef74b53b00fe51fc322b3cd7ff', file: 'zh_CN/gamedata/excel/stage_table.json' };
export const characterTableSource = { ...stageTableSource, file: 'zh_CN/gamedata/excel/character_table.json' };
/** The same pinned uniequip table the cost query reads; only each module's operator and type letter are kept. */
export const moduleTableSource = { ...stageTableSource, file: 'zh_CN/gamedata/excel/uniequip_table.json' };
function moduleEntries(table: unknown): ModuleCatalog {
  const equips = table && typeof table === 'object' ? (table as ObjectValue).equipDict : null, catalog: ModuleCatalog = {};
  if (equips && typeof equips === 'object') for (const [id, entry] of Object.entries(equips as ObjectValue))
    if (entry && typeof entry.charId === 'string' && (entry.typeName2 === null || entry.typeName2 === undefined || typeof entry.typeName2 === 'string')) catalog[id] = { charId: entry.charId, typeName2: entry.typeName2 ?? null };
  return catalog;
}
/**
 * The read-only entry's stage tables; the cultivation report reuses it for job-site evidence. Offline files may carry optional
 * characters and modules maps; online queries also read the pinned character and uniequip tables, degrading to unclassified
 * names and unknown module levels when either cannot be read.
 */
export async function loadStageTables(file?: unknown, withCharacters = false, fetcher: typeof fetch = fetch) {
  if (file !== undefined) {
    let tables: ObjectValue;
    try { tables = object(JSON.parse(await readFile(text(file), 'utf8'))); } catch { throw new CheckRequiredError('stage-jobs-input-file-unreadable'); }
    return { ...tables, source: { kind: 'offline-input' }, ...(tables.characters !== undefined ? { charactersSource: { kind: 'offline-input' } } : {}),
      ...(tables.modules !== undefined ? { modulesSource: { kind: 'offline-input' } } : {}) };
  }
  const [result, characters, modules] = await Promise.all([readPublicJson(stageTableSource, fetcher), withCharacters ? readPublicJson(characterTableSource, fetcher).catch(() => null) : null,
    withCharacters ? readPublicJson(moduleTableSource, fetcher).catch(() => null) : null]);
  return { ...object(result.value), source: result.source, ...(withCharacters ? characters ? { characters: characters.value, charactersSource: characters.source } : { charactersSource: { kind: 'unavailable' } } : {}),
    ...(withCharacters ? modules ? { modules: moduleEntries(modules.value), modulesSource: modules.source } : { modulesSource: { kind: 'unavailable' } } : {}) };
}
export function findStages(tables: unknown, codes: string[]) {
  if (!Array.isArray(codes) || !codes.length || codes.length > 100 || codes.some(code => typeof code !== 'string' || !code.trim())) throw new Error('stage-code-required');
  return Object.values(object(object(tables).stages)).filter(stage => codes.includes(object(stage).code)).map(value => {
    const stage = object(value);
    return { stageId: stage.stageId, code: stage.code, map: stage.zoneId, levelId: stage.levelId, difficulty: stage.difficulty === 'NORMAL' ? 'normal' : stage.difficulty === 'FOUR_STAR' ? 'raid' : 'unsupported',
      // tableDifficulty keeps the raw value: e.g. SIX_STAR (#s) has no copilot difficulty bit in MAA v6.21.4, so it stays unsupported.
      tableDifficulty: stage.difficulty ?? null, difficultyGroup: stage.diffGroup ?? null, prerequisites: stage.unlockCondition ?? null };
  });
}
const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  const action = process.argv[2];
  try {
    if (process.argv.length !== 3 || !['stages', 'query', 'prepare'].includes(action!)) throw new Error('action-invalid');
    const input = object(await readStdinJson({ maxBytes: 1024 * 1024 }));
    let settings: Awaited<ReturnType<typeof readSettings>>;
    try { settings = await readSettings(); } catch { throw new CheckRequiredError('settings-unreadable'); }
    /** A private JSON file the request names or implies: missing and unreadable are reported separately, without the path. */
    const readJson = async (file: string, missing: CheckRequiredReason, unreadable: CheckRequiredReason) => {
      let raw: string;
      try { raw = await readFile(file, 'utf8'); } catch (error) { throw new CheckRequiredError((error as NodeJS.ErrnoException).code === 'ENOENT' ? missing : unreadable); }
      try { return object(JSON.parse(raw.replace(/^﻿/, ''))); } catch { throw new CheckRequiredError(unreadable); }
    };
    // prepare reads the kind of snapshot its report was built from, unless `snapshotFile` names another.
    const snapshotPath = (fallback: string) => input.snapshotFile === undefined ? join(settings.privateDirectory, fallback) : resolve(text(input.snapshotFile));
    if (action === 'stages') {
      if (Object.keys(input).some(key => !['codes', 'tablesFile'].includes(key))) throw new Error('request-invalid');
      const tables = await loadStageTables(input.tablesFile);
      console.log(JSON.stringify({ ok: true, stages: findStages(tables, input.codes), tablesOrigin: input.tablesFile ? 'offline-input' : stageTableSource }));
    } else if (action === 'query') {
      if (Object.keys(input).some(key => !['request', 'tablesFile', 'jobsFile', 'snapshotFile', 'operator', 'format', 'saveReport'].includes(key))
        || input.format !== undefined && !['json', 'markdown'].includes(input.format) || input.saveReport !== undefined && typeof input.saveReport !== 'boolean'
        || !input.request || typeof input.request !== 'object' || Array.isArray(input.request)) throw new Error('request-invalid');
      // OB-9: without snapshotFile the shared rule picks one whole snapshot; stage jobs need owned operators and their skills.
      let selection: SnapshotSelection;
      try { selection = await selectSnapshot(settings.privateDirectory, ['operators', 'skills'], input.snapshotFile === undefined ? undefined : text(input.snapshotFile)); }
      catch (error) { throw error instanceof SnapshotSelectionError ? new CheckRequiredError(error.kind === 'missing' ? 'stage-jobs-snapshot-missing' : 'stage-jobs-snapshot-unreadable') : error; }
      const snapshot = selection.snapshot;
      // OB-3: the installed MAA's version is read before matching and fills a request that names none.
      const versions = await readVersionStamp(settings.maaDirectory);
      const { request, maaVersionSource } = withInstalledMaaVersion(input.request, versions.maaVersion);
      const tables = await loadStageTables(input.tablesFile, true);
      const jobs = input.jobsFile === undefined ? undefined : await readFile(text(input.jobsFile), 'utf8').then(raw => JSON.parse(raw.replace(/^﻿/, '')) as Job[],
        () => { throw new CheckRequiredError('stage-jobs-input-file-unreadable'); }).catch(error => { throw error instanceof CheckRequiredError ? error : new CheckRequiredError('stage-jobs-input-file-unreadable'); });
      const matched = jobs ? matchStageJobs(snapshot, tables, request, jobs, undefined, { maaVersionSource })
        : await collectStageJobs(snapshot, tables, request, undefined, { maaVersionSource });
      // The MAA and record versions read now travel with the report (prepare reports any difference), and so does which
      // snapshot was read and why.
      const { source, readAt, chosen, lacking } = selection;
      const report = { ...matched, versions, snapshotSelection: { source, readAt, chosen, lacking } };
      if (input.saveReport) {
        const file = join(settings.privateDirectory, 'stage-jobs', 'reports', `${report.hash}.json`);
        await mkdir(dirname(file), { recursive: true });
        let handle; try { handle = await open(file, 'wx', 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        if (handle) try { await handle.writeFile(JSON.stringify(report) + '\n'); await handle.sync(); } finally { await handle.close(); }
      }
      console.log(input.format === 'markdown' ? formatStageJobs(report, input.operator === undefined ? undefined : text(input.operator)) : JSON.stringify({ ok: true, report, tablesOrigin: input.tablesFile ? 'offline-input' : stageTableSource }));
    } else {
      if (Object.keys(input).some(key => !['approval', 'profile', 'host', 'expectedRevision', 'closedConfirmed', 'snapshotFile'].includes(key))) throw new Error('request-invalid');
      if (!settings.maaDirectory) throw new Error('maa-directory-unset');
      const hash = text(input.approval?.reportHash); if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('approval-invalid');
      const report = await readJson(join(settings.privateDirectory, 'stage-jobs', 'reports', `${hash}.json`), 'stage-jobs-report-missing', 'stage-jobs-report-stale');
      // Without snapshotFile, prepare reads the same kind of snapshot the report was built from.
      const snapshot = await readJson(snapshotPath(report.snapshotSource === 'skland' ? snapshotFiles.skland : snapshotFiles.maa), 'stage-jobs-snapshot-changed', 'stage-jobs-snapshot-changed');
      const { snapshotFile: _snapshotFile, ...request } = input;
      const { createMaaProcess } = await import('./maa-process.ts');
      let processBoundary: MaaProcess | undefined; const get = () => processBoundary ??= createMaaProcess(settings.maaDirectory!);
      const result = await prepareStageJobs({ ...request, report, snapshot, maaDirectory: settings.maaDirectory, privateDirectory: settings.privateDirectory } as Parameters<typeof prepareStageJobs>[0],
        { inspect: () => get().inspect(), close: () => get().close(), start: () => get().start(), version: () => get().version!() });
      console.log(JSON.stringify({ ok: result.status === 'complete', ...result })); if (result.status !== 'complete') process.exitCode = 1;
    }
  } catch (error) {
    // Ticket 26: a request refused while reading standard input reached neither MAA nor a file, so it is a plain rejection.
    const refused = stdinJsonCode(error);
    // Everything else says why and what to check (owner trial item 10); an unclassified failure of prepare is an unknown outcome.
    console.log(JSON.stringify(refused ? { ok: false, status: 'rejected', reason: refused }
      : checkRequiredFor('stage-jobs', error, action === 'prepare' ? 'stage-jobs-prepare-outcome-unknown' : undefined))); process.exitCode = 1;
  }
}
