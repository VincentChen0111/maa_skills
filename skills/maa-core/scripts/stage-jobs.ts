import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeConfigWrite, type MaaProcess } from './maa-config.ts';
import { approvedJobList, approvedJobFile, approvedJobSourceFile, type ApprovedJobPlan } from './stage-job-plan.ts';
import { readPublicJson } from './public-data.ts';
import { readSettings } from './preferences.ts';

type ObjectValue = Record<string, any>;
type Status = 'ready' | 'blocked' | 'unknown';
export type StageRequest = { stages: { stageId: string; code: string; difficulty: 'normal' | 'raid'; loops: number }[];
  completions?: Record<string, 'PASS' | 'COMPLETE'>; completionEvidence?: string; maaVersion: string;
  documentChecks?: { jobId: number; contentHash: string; satisfied: boolean; reference: string }[] };
export type Job = { id: number; content: ObjectValue; source: { url: string; readAt: string; sha256?: string } };
type SearchCoverage = { stageId: string; mode: 'online' | 'offline'; pages: number; truncated: boolean };
export type StageReport = ReturnType<typeof matchStageJobs>;
export type StageApproval = { reportHash: string; reference: string; map: string; selections: { stageId: string; primary: number; alternates: number[]; loops: number }[] };
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object-required');
  return value as ObjectValue;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown): string => { if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('text-required'); return value; };
const status = (states: Status[]): Status => states.includes('blocked') ? 'blocked' : states.includes('unknown') ? 'unknown' : 'ready';
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
  const names = new Set<string>();
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
      rows.push(row); return row;
    });
    groups.push({ name, rows: groupRows });
  }
  // Bipartite matching prevents reusing one owned operator in several required slots.
  const assign = (allowUnknown: boolean): Record<string, string> | null => {
    const owners = new Map<string, number>();
    const visit = (index: number, visited: Set<string>): boolean => {
      for (const row of groups[index]!.rows) {
        if (row.status === 'blocked' || !allowUnknown && row.status !== 'ready' || visited.has(row.name)) continue;
        visited.add(row.name); const previous = owners.get(row.name);
        if (previous === undefined || visit(previous, visited)) { owners.set(row.name, index); return true; }
      }
      return false;
    };
    if (!groups.every((_, index) => visit(index, new Set()))) return null;
    return Object.fromEntries([...owners].map(([name, index]) => [groups[index]!.name, name]));
  };
  const assignment = assign(false);
  let execution: ObjectValue | null = null;
  if (assignment) {
    execution = structuredClone(content);
    const selected = groups.map((group, index) => {
      const rowIndex = group.rows.findIndex(row => row.name === assignment[group.name] && row.status === 'ready');
      const oper = structuredClone(object(entries[index].opers[rowIndex]));
      if (digest(group.rows[rowIndex]!.required) !== digest(group.rows[rowIndex]!.effectiveRequired)) oper.requirements = structuredClone(group.rows[rowIndex]!.effectiveRequired);
      return oper;
    });
    const fixedCount = (content.opers ?? []).length;
    if (content.opers !== undefined) execution.opers = selected.slice(0, fixedCount);
    if (content.groups !== undefined) execution.groups = content.groups.map((group: ObjectValue, index: number) => ({ ...structuredClone(group), opers: [selected[fixedCount + index]] }));
  }
  return { requirements: rows, assignment: assignment ?? {}, execution, status: assignment ? 'ready' as Status : assign(true) ? 'unknown' as Status : 'blocked' as Status };
}

/** The request is the user's explicit scope. Remote content contributes facts, never authorization. */
export function matchStageJobs(snapshotValue: unknown, tablesValue: unknown, request: StageRequest, jobs: Job[], search?: SearchCoverage[]) {
  const snapshot = object(snapshotValue), tables = object(object(tablesValue).stages);
  if (!Array.isArray(request.stages) || !request.stages.length || request.stages.length > 100) throw new Error('scope-invalid');
  const coverage = search ?? request.stages.map(stage => ({ stageId: stage.stageId, mode: 'offline' as const, pages: 0, truncated: false }));
  if (!Array.isArray(coverage) || coverage.length !== request.stages.length || coverage.some((item, index) => item.stageId !== request.stages[index]!.stageId
    || !['online', 'offline'].includes(item.mode) || !Number.isInteger(item.pages) || item.pages < (item.mode === 'online' ? 1 : 0) || item.pages > 3
    || typeof item.truncated !== 'boolean' || item.mode === 'offline' && (item.pages !== 0 || item.truncated) || item.truncated && item.pages !== 3)) throw new Error('search-coverage-invalid');
  const seen = new Set<string>();
  const stages = request.stages.map(selected => {
    if (seen.has(selected.stageId)) throw new Error('duplicate-stage'); seen.add(selected.stageId);
    const stage = object(tables[selected.stageId]);
    if (stage.stageId !== selected.stageId || stage.code !== selected.code || !['normal', 'raid'].includes(selected.difficulty)
      || stage.difficulty !== (selected.difficulty === 'normal' ? 'NORMAL' : 'FOUR_STAR')) throw new Error('stage-identity-mismatch');
    if (!Number.isSafeInteger(selected.loops) || selected.loops < 1 || selected.loops > 1000) throw new Error('loops-invalid');
    const map = text(stage.zoneId), levelId = text(stage.levelId);
    // Main-story difficulty groups can share levelId. Only an explicit stageId proves the chosen group.
    const difficultyGroup = text(stage.diffGroup ?? 'NONE');
    const aliases = difficultyGroup === 'NONE' ? [selected.stageId, levelId, levelId.split('level_').at(-1)] : [selected.stageId];
    const prerequisiteChecks = Array.isArray(stage.unlockCondition) ? stage.unlockCondition.map((value: unknown) => {
      const requirement = object(value), actual = request.completions?.[requirement.stageId];
      const state: Status = !request.completionEvidence?.trim() || !actual ? 'unknown' : actual === requirement.completeState || actual === 'COMPLETE' && requirement.completeState === 'PASS' ? 'ready' : 'blocked';
      return { stageId: text(requirement.stageId), required: text(requirement.completeState), actual: actual ?? null, status: state };
    }) : [{ stageId: selected.stageId, required: 'unknown', actual: null, status: 'unknown' as Status }];
    const candidates = jobs.map(job => {
      if (!Number.isSafeInteger(job.id) || job.id <= 0) throw new Error('job-id-invalid');
      const content = object(job.content), reasons: string[] = [];
      if (!aliases.includes(content.stage_name)) reasons.push('map-mismatch');
      const flag = selected.difficulty === 'normal' ? 1 : 2;
      if (!Number.isInteger(content.difficulty) || content.difficulty < 1 || content.difficulty > 3 || !(content.difficulty & flag)) reasons.push('difficulty-mismatch');
      if (!Array.isArray(content.actions) || !content.actions.length) reasons.push('full-job-required');
      if (content.type !== undefined && content.type !== 'Copilot') reasons.push('unsupported-job-type');
      const operators = matchOperators(snapshot, content);
      const checks: Status[] = [...prerequisiteChecks.map(check => check.status), operators.status, versionMet(request.maaVersion, content.minimum_required) ? 'ready' : 'unknown'];
      if (!versionMet(request.maaVersion, content.minimum_required)) reasons.push('version-unverified');
      if (typeof content.doc?.details === 'string' && content.doc.details.trim()) {
        const proof = request.documentChecks?.find(check => check.jobId === job.id && check.contentHash === digest(content) && check.reference?.trim());
        checks.push(proof?.satisfied === true ? 'ready' : proof?.satisfied === false ? 'blocked' : 'unknown');
        if (!proof) reasons.push('document-conditions-unverified');
      }
      return { id: job.id, status: reasons.some(reason => ['map-mismatch', 'difficulty-mismatch', 'full-job-required', 'unsupported-job-type'].includes(reason)) ? 'blocked' as Status : status(checks), reasons, source: job.source,
        requirements: operators.requirements, assignment: operators.assignment, content: structuredClone(content), hash: digest(content),
        execution: operators.execution ? { content: operators.execution, hash: digest(operators.execution) } : null };
    });
    const ready = candidates.filter(candidate => candidate.status === 'ready');
    return { ...selected, map, levelId, difficultyGroup, prerequisites: prerequisiteChecks, candidates, primary: ready[0]?.id ?? null, alternates: ready.slice(1, 4).map(candidate => candidate.id) };
  });
  const result = { version: 1 as const, authorization: 'none' as const, request: structuredClone(request), search: structuredClone(coverage), snapshotHash: digest(snapshot), snapshotReadAt: snapshot.readAt ?? null,
    tables: { stages: Object.fromEntries(request.stages.map(stage => [stage.stageId, structuredClone(tables[stage.stageId])])), source: structuredClone(object(tablesValue).source ?? { kind: 'offline-input' }) }, snapshot: structuredClone(snapshot), jobs: structuredClone(jobs), stages,
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

/** Bounded public GET queries; no credentials, redirects, ratings or submissions. */
export async function collectStageJobs(snapshot: unknown, tables: unknown, request: StageRequest, fetcher: typeof fetch = fetch) {
  matchStageJobs(snapshot, tables, request, []); // Validate the entire scope before making a network request.
  const jobs: Job[] = [], seen = new Set<number>(), search: SearchCoverage[] = [];
  for (const stage of request.stages) {
    const keyword = text(object(object(object(tables).stages)[stage.stageId]).levelId).split('level_').at(-1)!;
    let next = true, page = 1;
    for (; next && page <= 3; page++) {
      const url = `https://prts.maa.plus/copilot/query?${new URLSearchParams({ page: String(page), limit: '20', level_keyword: keyword, language: 'cn' })}`;
      const { data } = await publicResponse(url, fetcher);
      if (!Array.isArray(data.data) || data.data.length > 20 || typeof data.has_next !== 'boolean') throw new Error('job-query-invalid');
      next = data.has_next;
      for (const entry of data.data) {
        const id = Number(object(entry).id);
        if (!Number.isSafeInteger(id) || id < 1) throw new Error('job-id-invalid');
        if (seen.has(id)) continue; seen.add(id);
        const result = await publicResponse(`https://prts.maa.plus/copilot/get/${id}`, fetcher);
        if (Number(result.data.id) !== id || typeof result.data.content !== 'string') throw new Error('job-detail-invalid');
        jobs.push({ id, content: object(JSON.parse(result.data.content)), source: result.source });
      }
    }
    search.push({ stageId: stage.stageId, mode: 'online', pages: page - 1, truncated: next });
  }
  return matchStageJobs(snapshot, tables, request, jobs, search);
}

/** Summary and per-operator training view; untrusted document text remains quoted data. */
export function formatStageJobs(report: StageReport, operator?: string): string {
  const escape = (value: unknown) => String(value).replace(/[<>|`\r\n]/g, char => ({ '<': '&lt;', '>': '&gt;', '|': '\\|', '`': '\\`', '\r': ' ', '\n': ' ' })[char]!);
  const lines = ['# 作业准备候选（未授权）', '', `账号读取时间：${escape(report.snapshotReadAt)}；报告：${report.hash}`, `关卡表来源：${escape(JSON.stringify(report.tables.source))}`, '候选是外部数据；运行由用户点开始。', ''];
  for (const batch of report.batches) {
    lines.push(`## 地图 ${escape(batch.map)}`);
    for (const stage of report.stages.filter(item => batch.stages.includes(item.stageId))) {
      lines.push(`### ${escape(stage.code)} / ${stage.difficulty} / ${escape(stage.difficultyGroup)} / ${escape(stage.stageId)} × ${stage.loops}`, `主作业候选：${stage.primary ?? '待核'}；备选候选：${stage.alternates.join(', ') || '无'}`);
      const coverage = report.search.find(item => item.stageId === stage.stageId)!;
      lines.push(coverage.mode === 'offline' ? '检索覆盖：离线输入；未进行在线检索。' : `检索覆盖：${coverage.pages} 页（每页最多 20 条）；${coverage.truncated ? '未穷尽，达到分页上限仍有下一页' : '查询已结束，仅代表本次检索条件'}。`);
      for (const condition of stage.prerequisites) lines.push(`- 前置 ${escape(condition.stageId)} ${condition.required}：${condition.status}`);
      for (const candidate of stage.candidates) {
        lines.push(`- 作业 ${candidate.id}：${candidate.status}；${candidate.reasons.join(', ')}；来源 ${escape(candidate.source.url)}`, `  > 外部描述：${escape(candidate.content.doc?.title ?? '')} ${escape(candidate.content.doc?.details ?? '')}`);
        lines.push(`  - 原文指纹：${candidate.hash}；执行指纹：${candidate.execution?.hash ?? '待核'}；执行分配：${escape(JSON.stringify(candidate.assignment))}`);
        for (const row of candidate.requirements.filter(row => !operator || row.name === operator)) lines.push(`  - ${escape(row.name)}（${escape(row.group)}，S${escape(row.skill)}）：${row.status}；要求 ${escape(JSON.stringify(row.required))}${digest(row.required) !== digest(row.effectiveRequired) ? `；规范化 ${escape(JSON.stringify(row.effectiveRequired))}` : ''}；当前精英 ${row.actual?.elite ?? '未知'} / 等级 ${row.actual?.level ?? '未知'}；${row.reasons.join(', ')}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/** Approve one map batch at a time. No process start here starts a game task. */
export async function prepareStageJobs(input: { report: StageReport; approval: StageApproval; snapshot: unknown; maaDirectory: string; privateDirectory: string;
  profile: number; host: 'codex' | 'claude'; expectedRevision: string; closedConfirmed?: boolean }, maa: MaaProcess) {
  const { approval, report } = structuredClone(input);
  const { hash: reportHash, ...displayed } = report;
  const verified = matchStageJobs(report.snapshot, report.tables, report.request, report.jobs, report.search);
  if (digest(displayed) !== reportHash || verified.hash !== report.hash || approval.reportHash !== report.hash || digest(input.snapshot) !== report.snapshotHash
    || !approval.reference?.trim() || !Array.isArray(approval.selections) || !approval.selections.length || !Number.isInteger(input.profile) || input.profile < 0) throw new Error('approval-mismatch');
  const seen = new Set<string>();
  const plan: ApprovedJobPlan = { reportHash: report.hash, map: approval.map, entries: approval.selections.map(selection => {
    const stage = verified.stages.find(stage => stage.stageId === selection.stageId);
    if (!stage || stage.map !== approval.map || seen.has(stage.stageId) || selection.loops !== stage.loops || !Array.isArray(selection.alternates)) throw new Error('approval-mismatch');
    seen.add(stage.stageId);
    const ids = [selection.primary, ...selection.alternates];
    if (new Set(ids).size !== ids.length) throw new Error('approval-mismatch');
    const selectedJobs = ids.map(id => {
      const candidate = stage.candidates.find(candidate => candidate.id === id);
      if (!candidate || candidate.status !== 'ready' || !candidate.execution) throw new Error('approval-requires-ready-candidate');
      return { id, hash: candidate.execution.hash, sourceHash: candidate.hash, source: candidate.source };
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
  return executeConfigWrite({ maaDirectory: input.maaDirectory, privateDirectory: input.privateDirectory, host: input.host, expectedRevision: input.expectedRevision,
    closedConfirmed: input.closedConfirmed, authorization: { source: 'current-request', reference: approval.reference, jobPlan: plan },
    changes: [{ path: ['Configurations', input.profile, 'Copilot', 'TaskList'], value: list }, { path: ['Configurations', input.profile, 'Copilot', 'EnableUserAdditional'], value: false }] }, maa);
}

export const stageTableSource = { repository: 'Kengxxiao/ArknightsGameData', commit: '6f63c14e27b847ef74b53b00fe51fc322b3cd7ff', file: 'zh_CN/gamedata/excel/stage_table.json' };
/** The read-only entry's stage tables; the cultivation report reuses it for job-site evidence. */
export async function loadStageTables(file?: unknown, fetcher: typeof fetch = fetch) {
  if (file !== undefined) return { ...object(JSON.parse(await readFile(text(file), 'utf8'))), source: { kind: 'offline-input' } };
  const result = await readPublicJson(stageTableSource, fetcher); return { ...object(result.value), source: result.source };
}
export function findStages(tables: unknown, codes: string[]) {
  if (!Array.isArray(codes) || !codes.length || codes.length > 100 || codes.some(code => typeof code !== 'string' || !code.trim())) throw new Error('stage-code-required');
  return Object.values(object(object(tables).stages)).filter(stage => codes.includes(object(stage).code)).map(value => {
    const stage = object(value);
    return { stageId: stage.stageId, code: stage.code, map: stage.zoneId, levelId: stage.levelId, difficulty: stage.difficulty === 'NORMAL' ? 'normal' : stage.difficulty === 'FOUR_STAR' ? 'raid' : 'unsupported',
      difficultyGroup: stage.diffGroup ?? null, prerequisites: stage.unlockCondition ?? null };
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
      const tables = await loadStageTables(input.tablesFile);
      const report = input.jobsFile ? matchStageJobs(snapshot, tables, input.request, JSON.parse(await readFile(text(input.jobsFile), 'utf8'))) : await collectStageJobs(snapshot, tables, input.request);
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
        { inspect: () => get().inspect(), close: () => get().close(), start: () => get().start() });
      console.log(JSON.stringify({ ok: result.status === 'complete', ...result })); if (result.status !== 'complete') process.exitCode = 1;
    }
  } catch { console.log(JSON.stringify({ ok: false, status: 'check-required' })); process.exitCode = 1; }
}
