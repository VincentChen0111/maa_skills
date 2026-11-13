import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeConfigWrite, versionStampOf, type MaaProcess } from './maa-config.ts';
import { compareVersionStamp, readVersionStamp } from './maa-version.ts';
import { approvedJobList, approvedJobFile, approvedJobSourceFile, type ApprovedJobPlan } from './stage-job-plan.ts';
import { readPublicJson } from './public-data.ts';
import { readSettings } from './preferences.ts';

type ObjectValue = Record<string, any>;
// 'support' (需借助战): every slot but one is verified and the one left has no owned member; MAA may borrow it.
type Status = 'ready' | 'support' | 'blocked' | 'unknown';
export type StageRequest = { stages: { stageId: string; code: string; difficulty: 'normal' | 'raid'; loops: number }[];
  completions?: Record<string, 'PASS' | 'COMPLETE'>; completionEvidence?: string; maaVersion: string;
  documentChecks?: { jobId: number; contentHash: string; satisfied: boolean; reference: string }[] };
type SourceRecord = { url: string; readAt: string; sha256?: string };
/** Rating counts as the copilot site's query summary reports them; the summary is fresher than the cached detail view. */
export type JobRating = { like: number; dislike: number; notEnoughRating: boolean; ratingLevel?: number; ratingRatio?: number; source: SourceRecord };
export type Job = { id: number; content: ObjectValue; source: SourceRecord; rating?: JobRating };
export type CandidateRating = { flag: 'ok' | 'low' | 'not-enough' | 'unknown'; like?: number; dislike?: number; votes?: number; notEnoughRating?: boolean;
  likeRatio?: number; requiredRatio?: number; ratingLevel?: number | null; ratingRatio?: number | null; source?: SourceRecord | null };
type SearchCoverage = { stageId: string; mode: 'online' | 'offline'; pages: number; truncated: boolean; ids: number[] };
type SearchOutcome = 'offline' | 'empty' | 'found' | 'same-map-unproven' | 'fallback-suspected' | 'insufficient' | 'unresolved' | 'other-stages';
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
function matchOperators(snapshot: ObjectValue, content: ObjectValue) {
  const rows: { group: string; name: string; skill: unknown; required: ObjectValue; effectiveRequired: ObjectValue; actual: ObjectValue | null; status: Status; reasons: string[] }[] = [];
  const groups: { name: string; rows: typeof rows }[] = [];
  if (!Array.isArray(content.opers ?? []) || !Array.isArray(content.groups ?? [])) throw new Error('job-operators-invalid');
  const entries = [...(content.opers ?? []).map((oper: unknown, index: number) => ({ name: `operator-${index}`, opers: [oper] })), ...(content.groups ?? [])];
  const names = new Set<string>(), notOwned = new Set<(typeof rows)[number]>();
  // Absence proves "not owned" only when the snapshot carries a usable ownership list.
  const ownershipListed = Array.isArray(snapshot.operators) && ['complete', 'partial'].includes(snapshot.coverage?.operators?.status)
    && !(Array.isArray(snapshot.coverage?.operators?.issues) && snapshot.coverage.operators.issues.includes('empty-recognition'));
  for (const entry of entries) {
    const group = object(entry); const name = text(group.name);
    if (names.has(name) || !Array.isArray(group.opers) || !group.opers.length) throw new Error('job-group-invalid'); names.add(name);
    const groupRows = group.opers.map((raw: unknown) => {
      const oper = object(raw), original = object(oper.requirements ?? {}), required = effectiveRequirements(oper), operName = text(oper.name);
      const matches = Array.isArray(snapshot.operators) ? snapshot.operators.filter((item: ObjectValue) => item.name === operName) : [];
      const actual = matches.length === 1 && ['complete', 'partial'].includes(snapshot.coverage?.operators?.status) ? object(matches[0]) : null;
      const reasons: string[] = [], checks: Status[] = [];
      const check = (field: string, expected: unknown, observed: unknown) => {
        if (expected === undefined || expected === -1) return;
        if (!Number.isSafeInteger(expected) || Number(expected) < 0) { checks.push('unknown'); reasons.push(`invalid-${field}`); return; }
        if (!Number.isSafeInteger(observed)) { checks.push('unknown'); reasons.push(`unknown-${field}`); }
        else if (Number(observed) < Number(expected)) { checks.push('blocked'); reasons.push(`insufficient-${field}`); }
      };
      if (!actual) { checks.push('unknown'); reasons.push('ownership-unobserved-or-ambiguous'); }
      // MAA v6.21.4 treats a missing requirements object as "no requirement"; no grounded default exists, so it stays 待核.
      if (oper.requirements === undefined || oper.requirements === null || !Object.keys(original).length) { checks.push('unknown'); reasons.push('requirements-unstated'); }
      check('elite', required.elite === undefined || required.elite === -1 ? 0 : required.elite, actual?.elite);
      // Level thresholds apply at the required elite stage, not after a higher promotion.
      if (!(Number.isSafeInteger(required.elite) && required.elite >= 0 && Number.isSafeInteger(actual?.elite) && actual!.elite > required.elite)) check('level', required.level, actual?.level);
      check('potential', required.potentiality ?? required.potential, actual?.potential);
      // AccountSnapshot currently has no per-skill mastery contract. A scalar cannot prove S2/S3 mastery.
      check('skill-level', required.skill_level, required.skill_level > 7 ? null : actual?.skillLevel);
      if (Number.isInteger(oper.skill) && oper.skill >= 2 && oper.skill <= 3) check('skill-unlock', oper.skill - 1, actual?.elite);
      for (const key of ['module', 'module_level']) if (required[key] !== undefined && required[key] !== -1) { checks.push('unknown'); reasons.push(`unknown-${key}`); }
      if (oper.skill !== undefined && (!Number.isInteger(oper.skill) || oper.skill < 0 || oper.skill > 3)) { checks.push('unknown'); reasons.push('invalid-skill'); }
      if (oper.role !== undefined) { checks.push('unknown'); reasons.push('role-unverified'); }
      for (const key of Object.keys(required)) if (!['elite', 'level', 'potential', 'potentiality', 'skill_level', 'module', 'module_level'].includes(key)) { checks.push('unknown'); reasons.push(`unknown-requirement:${key}`); }
      const row = { group: name, name: operName, skill: oper.skill ?? 0, required: structuredClone(original), effectiveRequired: required, actual, status: status(checks), reasons };
      rows.push(row); if (ownershipListed && !matches.length) notOwned.add(row); return row;
    });
    groups.push({ name, rows: groupRows });
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
    const normalized = (index: number, rowIndex: number) => {
      const oper = structuredClone(object(entries[index].opers[rowIndex])), row = groups[index]!.rows[rowIndex]!;
      if (digest(row.required) !== digest(row.effectiveRequired)) oper.requirements = structuredClone(row.effectiveRequired);
      return oper;
    };
    // Verified slots keep only their assigned member; the borrowed slot keeps all of its (unowned) members.
    const selected = groups.map((group, index) => group === supportSlot && !assignment ? group.rows.map((_, rowIndex) => normalized(index, rowIndex))
      : [normalized(index, group.rows.findIndex(row => row.name === chosen[group.name] && row.status === 'ready'))]);
    const fixedCount = (content.opers ?? []).length;
    if (content.opers !== undefined) execution.opers = selected.slice(0, fixedCount).map(opers => opers[0]);
    if (content.groups !== undefined) execution.groups = content.groups.map((group: ObjectValue, index: number) => ({ ...structuredClone(group), opers: selected[fixedCount + index] }));
  }
  const support = !assignment && supportAssignment && supportSlot ? { slot: supportSlot.name, members: supportSlot.rows.map(row => ({ name: row.name, skill: row.skill,
    required: structuredClone(row.required), effectiveRequired: structuredClone(row.effectiveRequired) })) } : null;
  return { requirements: rows, assignment: chosen ?? {}, execution, support,
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
export function matchStageJobs(snapshotValue: unknown, tablesValue: unknown, request: StageRequest, jobs: Job[], search?: SearchCoverage[]) {
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
  if (!Array.isArray(coverage) || coverage.length !== request.stages.length || coverage.some((item, index) => item.stageId !== request.stages[index]!.stageId
    || !['online', 'offline'].includes(item.mode) || !Number.isInteger(item.pages) || item.pages < (item.mode === 'online' ? 1 : 0) || item.pages > 3
    || typeof item.truncated !== 'boolean' || item.mode === 'offline' && (item.pages !== 0 || item.truncated) || item.truncated && item.pages !== 3
    // ids are the jobs this stage's own query returned, in order; they let the report tell "no jobs" from unrelated results.
    || !Array.isArray(item.ids) || item.ids.length > item.pages * 20 || new Set(item.ids).size !== item.ids.length || item.ids.some(id => !Number.isSafeInteger(id) || id < 1 || !jobsById.has(id)))) throw new Error('search-coverage-invalid');
  const seen = new Set<string>();
  const stages = request.stages.map(selected => {
    if (seen.has(selected.stageId)) throw new Error('duplicate-stage'); seen.add(selected.stageId);
    const stage = object(tables[selected.stageId]);
    if (stage.stageId !== selected.stageId || stage.code !== selected.code || !['normal', 'raid'].includes(selected.difficulty)
      || stage.difficulty !== (selected.difficulty === 'normal' ? 'NORMAL' : 'FOUR_STAR')) throw new Error('stage-identity-mismatch');
    if (!Number.isSafeInteger(selected.loops) || selected.loops < 1 || selected.loops > 1000) throw new Error('loops-invalid');
    const map = text(stage.zoneId), levelId = text(stage.levelId);
    const difficultyGroup = text(stage.diffGroup ?? 'NONE');
    const identify = (stageName: unknown) => { const found = resolveJobStage(tables, stageName, stage, stageIndex); for (const key of found.matches) usedStages.add(key); return found.kind; };
    const prerequisiteChecks = Array.isArray(stage.unlockCondition) ? stage.unlockCondition.map((value: unknown) => {
      const requirement = object(value), actual = request.completions?.[requirement.stageId];
      const state: Status = !request.completionEvidence?.trim() || !actual ? 'unknown' : actual === requirement.completeState || actual === 'COMPLETE' && requirement.completeState === 'PASS' ? 'ready' : 'blocked';
      return { stageId: text(requirement.stageId), required: text(requirement.completeState), actual: actual ?? null, status: state };
    }) : [{ stageId: selected.stageId, required: 'unknown', actual: null, status: 'unknown' as Status }];
    const candidates = jobs.map(job => {
      if (!Number.isSafeInteger(job.id) || job.id <= 0) throw new Error('job-id-invalid');
      const content = object(job.content), reasons: string[] = [];
      const stageMatch = identify(content.stage_name);
      if (stageReasons[stageMatch]) reasons.push(stageReasons[stageMatch]!);
      // MAA v6.21.4 GUI adds a job whose difficulty is 0 or missing (DifficultyFlags.None) to the list as normal only.
      const flag = selected.difficulty === 'normal' ? 1 : 2, declared = content.difficulty === undefined ? 0 : content.difficulty;
      if (!Number.isInteger(declared) || declared < 0 || declared > 3 || declared > 0 && !(declared & flag)) reasons.push('difficulty-mismatch');
      else if (declared === 0 && flag === 2) reasons.push('difficulty-unstated-normal-only');
      if (!Array.isArray(content.actions) || !content.actions.length) reasons.push('full-job-required');
      if (content.type !== undefined && content.type !== 'Copilot') reasons.push('unsupported-job-type');
      const operators = matchOperators(snapshot, content), actionNames = scanActionNames(content, professions, usedNames);
      const checks: Status[] = [...prerequisiteChecks.map(check => check.status), operators.status, versionMet(request.maaVersion, content.minimum_required) ? 'ready' : 'unknown'];
      if (actionNames.undeclared.length) { checks.push('unknown'); reasons.push('action-operator-undeclared'); }
      if (actionNames.unrecognized.length) { checks.push('unknown'); reasons.push('action-name-unrecognized'); }
      if (!versionMet(request.maaVersion, content.minimum_required)) reasons.push('version-unverified');
      if (typeof content.doc?.details === 'string' && content.doc.details.trim()) {
        const proof = request.documentChecks?.find(check => check.jobId === job.id && check.contentHash === digest(content) && check.reference?.trim());
        checks.push(proof?.satisfied === true ? 'ready' : proof?.satisfied === false ? 'blocked' : 'unknown');
        if (!proof) reasons.push('document-conditions-unverified');
      }
      return { id: job.id, status: reasons.some(reason => blockingReasons.includes(reason)) ? 'blocked' as Status : status(checks), reasons, source: job.source, stageMatch,
        requirements: operators.requirements, assignment: operators.assignment, content: structuredClone(content), hash: digest(content),
        execution: operators.execution ? { content: operators.execution, hash: digest(operators.execution) } : null, rating: rateJob(job), actionNames, support: operators.support };
    });
    // Candidates keep the API order as evidence; suggestions demote not-enough/unknown and then low ratings, stably.
    const ranked = (state: Status) => candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => candidate.status === state)
      .sort((a, b) => ratingTier(a.candidate.rating) - ratingTier(b.candidate.rating) || a.index - b.index).map(({ candidate }) => candidate);
    const ready = ranked('ready');
    // The live backend matches level_keyword against level name / levelId / stageId; with no match it drops the stage
    // filter (no document parameter is sent) and returns unrelated site-wide jobs. Classify what this query returned.
    const searched = coverage.find(item => item.stageId === selected.stageId)!, keyword = levelId.split('level_').at(-1)!;
    const returned = searched.ids.map(id => object(jobsById.get(id)!.content).stage_name), kinds = returned.map(identify);
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
    // Requested stages plus every table entry a job's stage_name resolved to, so preparation re-resolves identically.
    tables: { stages: Object.fromEntries([...request.stages.map(stage => stage.stageId), ...[...usedStages].filter(key => !request.stages.some(stage => stage.stageId === key)).sort()]
      .map(key => [key, structuredClone(tables[key])])), source: structuredClone(object(tablesValue).source ?? { kind: 'offline-input' }),
      characters: Object.fromEntries(Object.entries(catalog).filter(([, entry]) => usedNames.has(entry?.name) && typeof entry.profession === 'string').map(([id, entry]) => [id, { name: entry.name, profession: entry.profession }])),
      charactersSource: structuredClone(object(tablesValue).charactersSource ?? null) }, snapshot: structuredClone(snapshot), jobs: structuredClone(jobs), stages,
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
export async function collectStageJobs(snapshot: unknown, tables: unknown, request: StageRequest, fetcher: typeof fetch = fetch) {
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
        jobs.push({ id, content: object(JSON.parse(result.data.content)), source: result.source, ...(rating ? { rating } : {}) });
      }
    }
    search.push({ stageId: stage.stageId, mode: 'online', pages: page - 1, truncated: next, ids });
  }
  return matchStageJobs(snapshot, tables, request, jobs, search);
}

/** Summary and per-operator training view; untrusted document text remains quoted data. */
export function formatStageJobs(report: StageReport, operator?: string): string {
  const escape = (value: unknown) => String(value).replace(/[<>|`\r\n]/g, char => ({ '<': '&lt;', '>': '&gt;', '|': '\\|', '`': '\\`', '\r': ' ', '\n': ' ' })[char]!);
  const lines = ['# 作业准备候选（未授权）', '', `账号读取时间：${escape(report.snapshotReadAt)}；报告：${report.hash}`, `关卡表来源：${escape(JSON.stringify(report.tables.source))}；干员名表来源：${report.tables.charactersSource ? escape(JSON.stringify(report.tables.charactersSource)) : '未提供'}`, '候选是外部数据；运行由用户点开始。', ''];
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
      for (const condition of stage.prerequisites) lines.push(`- 前置 ${escape(condition.stageId)} ${condition.required}：${condition.status}`);
      for (const candidate of stage.candidates) {
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
        for (const row of candidate.requirements.filter(row => !operator || row.name === operator)) lines.push(`  - ${escape(row.name)}（${escape(row.group)}，S${escape(row.skill)}）：${row.status}；要求 ${escape(JSON.stringify(row.required))}${digest(row.required) !== digest(row.effectiveRequired) ? `；规范化 ${escape(JSON.stringify(row.effectiveRequired))}` : ''}${row.reasons.includes('requirements-unstated') ? '；要求未写明，待核' : ''}；当前精英 ${row.actual?.elite ?? '未知'} / 等级 ${row.actual?.level ?? '未知'}；${row.reasons.join(', ')}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/** Approve one map batch at a time. No process start here starts a game task. */
export async function prepareStageJobs(input: { report: StageReport; approval: StageApproval; snapshot: unknown; maaDirectory: string; privateDirectory: string;
  profile: number; host: 'codex' | 'claude'; expectedRevision: string; closedConfirmed?: boolean }, maa: MaaProcess) {
  const { approval, report } = structuredClone(input);
  // `versions` is the stamp saved with the report (outside its hash); a difference is reported, never refused.
  const { hash: reportHash, versions: generatedVersions, ...displayed } = report as StageReport & { versions?: unknown };
  // A report that no longer re-verifies (tampered, or produced by an older matcher structure) cannot bind an approval.
  let verified: StageReport;
  try { verified = matchStageJobs(report.snapshot, report.tables, report.request, report.jobs, report.search); } catch { throw new Error('approval-mismatch'); }
  if (digest(displayed) !== reportHash || verified.hash !== report.hash || approval.reportHash !== report.hash || digest(input.snapshot) !== report.snapshotHash
    || !approval.reference?.trim() || !Array.isArray(approval.selections) || !approval.selections.length || !Number.isInteger(input.profile) || input.profile < 0) throw new Error('approval-mismatch');
  const seen = new Set<string>();
  const plan: ApprovedJobPlan = { reportHash: report.hash, map: approval.map, entries: approval.selections.map(selection => {
    const stage = verified.stages.find(stage => stage.stageId === selection.stageId);
    if (!stage || stage.map !== approval.map || seen.has(stage.stageId) || selection.loops !== stage.loops || !Array.isArray(selection.alternates)) throw new Error('approval-mismatch');
    seen.add(stage.stageId);
    const ids = [selection.primary, ...selection.alternates], supportJobs = selection.supportJobs ?? [];
    if (new Set(ids).size !== ids.length) throw new Error('approval-mismatch');
    // 需借助战 jobs need the user's explicit naming; naming anything else as borrowed is a mismatch, not a widening.
    if (!Array.isArray(supportJobs) || new Set(supportJobs).size !== supportJobs.length
      || supportJobs.some(id => !ids.includes(id) || stage.candidates.find(candidate => candidate.id === id)?.status !== 'support')) throw new Error('approval-mismatch');
    const selectedJobs = ids.map(id => {
      const candidate = stage.candidates.find(candidate => candidate.id === id);
      if (!candidate || !candidate.execution || !(candidate.status === 'ready' || candidate.status === 'support' && supportJobs.includes(id))) throw new Error('approval-requires-ready-candidate');
      return { id, hash: candidate.execution.hash, sourceHash: candidate.hash, source: candidate.source,
        ...(candidate.support ? { support: { slot: candidate.support.slot, members: candidate.support.members.map(member => member.name) } } : {}) };
    });
    return { stageId: stage.stageId, code: stage.code, difficulty: stage.difficulty, difficultyGroup: stage.difficultyGroup, loops: selection.loops, primary: selectedJobs[0]!, alternates: selectedJobs.slice(1) };
  }) };
  const list = approvedJobList(plan, input.privateDirectory);
  for (const entry of plan.entries) for (const selected of [entry.primary, ...entry.alternates]) {
    const candidate = verified.stages.find(stage => stage.stageId === entry.stageId)!.candidates.find(job => job.id === selected.id)!;
    for (const [file, content] of [[approvedJobFile(input.privateDirectory, report.hash, selected.id), candidate.execution!.content], [approvedJobSourceFile(input.privateDirectory, report.hash, selected.id), candidate.content]] as const) {
      const bytes = JSON.stringify(content) + '\n';
      await mkdir(dirname(file), { recursive: true });
      let handle;
      try { handle = await open(file, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== bytes) throw new Error('job-file-conflict'); }
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
/** The read-only entry's stage tables; the cultivation report reuses it for job-site evidence. Offline files may carry an optional characters map; online queries also read the pinned character table, degrading to unclassified names. */
export async function loadStageTables(file?: unknown, withCharacters = false, fetcher: typeof fetch = fetch) {
  if (file !== undefined) {
    const tables = object(JSON.parse(await readFile(text(file), 'utf8')));
    return { ...tables, source: { kind: 'offline-input' }, ...(tables.characters !== undefined ? { charactersSource: { kind: 'offline-input' } } : {}) };
  }
  const [result, characters] = await Promise.all([readPublicJson(stageTableSource, fetcher), withCharacters ? readPublicJson(characterTableSource, fetcher).catch(() => null) : null]);
  return { ...object(result.value), source: result.source, ...(withCharacters ? characters ? { characters: characters.value, charactersSource: characters.source } : { charactersSource: { kind: 'unavailable' } } : {}) };
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
  try {
    if (process.argv.length !== 3 || !['stages', 'query', 'prepare'].includes(process.argv[2]!)) throw new Error('action-invalid');
    let raw = ''; for await (const chunk of process.stdin) { raw += String(chunk); if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('input-too-large'); }
    const input = object(JSON.parse(raw)), settings = await readSettings();
    if (process.argv[2] === 'stages') {
      if (Object.keys(input).some(key => !['codes', 'tablesFile'].includes(key))) throw new Error('request-invalid');
      const tables = await loadStageTables(input.tablesFile);
      console.log(JSON.stringify({ ok: true, stages: findStages(tables, input.codes), tablesOrigin: input.tablesFile ? 'offline-input' : stageTableSource }));
    } else if (process.argv[2] === 'query') {
      const snapshot = JSON.parse(await readFile(join(settings.privateDirectory, 'account-snapshot.json'), 'utf8'));
      if (Object.keys(input).some(key => !['request', 'tablesFile', 'jobsFile', 'operator', 'format', 'saveReport'].includes(key))
        || input.format !== undefined && !['json', 'markdown'].includes(input.format) || input.saveReport !== undefined && typeof input.saveReport !== 'boolean') throw new Error('request-invalid');
      const tables = await loadStageTables(input.tablesFile, true);
      const matched = input.jobsFile ? matchStageJobs(snapshot, tables, input.request, JSON.parse(await readFile(text(input.jobsFile), 'utf8'))) : await collectStageJobs(snapshot, tables, input.request);
      // The MAA and record versions read now travel with the report; prepare reports any difference.
      const report = { ...matched, versions: await readVersionStamp(settings.maaDirectory) };
      if (input.saveReport) {
        const file = join(settings.privateDirectory, 'stage-jobs', 'reports', `${report.hash}.json`);
        await mkdir(dirname(file), { recursive: true });
        let handle; try { handle = await open(file, 'wx', 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        if (handle) try { await handle.writeFile(JSON.stringify(report) + '\n'); await handle.sync(); } finally { await handle.close(); }
      }
      console.log(input.format === 'markdown' ? formatStageJobs(report, input.operator === undefined ? undefined : text(input.operator)) : JSON.stringify({ ok: true, report, tablesOrigin: input.tablesFile ? 'offline-input' : stageTableSource }));
    } else {
      const snapshot = JSON.parse(await readFile(join(settings.privateDirectory, 'account-snapshot.json'), 'utf8'));
      if (Object.keys(input).some(key => !['approval', 'profile', 'host', 'expectedRevision', 'closedConfirmed'].includes(key)) || !settings.maaDirectory) throw new Error('request-invalid');
      const hash = text(input.approval?.reportHash); if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('approval-invalid');
      const report = JSON.parse(await readFile(join(settings.privateDirectory, 'stage-jobs', 'reports', `${hash}.json`), 'utf8'));
      const { createMaaProcess } = await import('./maa-process.ts');
      let processBoundary: MaaProcess | undefined; const get = () => processBoundary ??= createMaaProcess(settings.maaDirectory!);
      const result = await prepareStageJobs({ ...input, report, snapshot, maaDirectory: settings.maaDirectory, privateDirectory: settings.privateDirectory } as Parameters<typeof prepareStageJobs>[0],
        { inspect: () => get().inspect(), close: () => get().close(), start: () => get().start(), version: () => get().version!() });
      console.log(JSON.stringify({ ok: result.status === 'complete', ...result })); if (result.status !== 'complete') process.exitCode = 1;
    }
  } catch { console.log(JSON.stringify({ ok: false, status: 'check-required' })); process.exitCode = 1; }
}
