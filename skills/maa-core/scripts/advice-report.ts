// Shared protocol for advice reports: immutable report versions, one independent review round, an explicit
// skip, honest unfinished reviews, corrections without re-review, and approval item by item.
// Nothing here writes MAA configuration or carries anything out: a review is not an approval, and an
// approval is not an execution. Every record lives under <private>/reports/<kind>/<hash>/.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inline } from './research.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const isObject = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const filled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isoTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const kindPattern = /^[a-z][a-z-]{0,31}$/;
const itemPattern = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export type ReportStatus = 'pending-review' | 'review-failed' | 'reviewed' | 'needs-correction' | 'unreviewed';
export type ReportItem = { id: string; title: string; scope: ObjectValue };
export type Correction = { finding: string; change: string };
/**
 * `changedFields`: the agent's input that differs from the reviewed version. `changedResults`: what the draft
 * re-read or recalculated that differs (account snapshot, citations, public tables, tool numbers). Both are shown;
 * neither part is re-reviewed.
 */
export type Revision = { reportHash: string; corrections: Correction[]; changedFields: string[]; changedResults: string[] };
export type AdviceContent = { schemaVersion: 1; kind: string; createdAt: string; items: ReportItem[]; revisionOf: Revision | null };
export type Reviewer = { host: 'claude'; method: 'fresh-context' } | { host: 'codex'; method: 'codex-exec' };
export type Finding = { id: string; location: string; problem: string; evidence: string; fix: string | null; decision: 'accepted' | 'rejected'; reason: string };
export type ReviewRecord = { schemaVersion: 1; kind: string; reportHash: string; outcome: 'reviewed'; recordedAt: string; reviewer: Reviewer; briefSha256: string;
  findings: Finding[]; priorFailures: number };
export type SkipRecord = { schemaVersion: 1; kind: string; reportHash: string; outcome: 'skipped'; recordedAt: string; userWords: string; priorFailures: number };
export const failureReasons = ['host-unavailable', 'reviewer-error', 'no-usable-result', 'timeout'] as const;
export type FailureRecord = { schemaVersion: 1; kind: string; reportHash: string; outcome: 'failed'; recordedAt: string; reviewer: Reviewer;
  reason: typeof failureReasons[number]; detail: string | null };
export type ApprovedItem = { id: string; reference: string; title: string; scope: ObjectValue };
export type ApprovalRecord = { schemaVersion: 1; kind: string; reportHash: string; approvedAt: string; userWords: string; reviewStatus: 'reviewed' | 'unreviewed'; items: ApprovedItem[] };
export type ReportState<T extends AdviceContent = AdviceContent> = { kind: string; hash: string; content: T; status: ReportStatus;
  review: ReviewRecord | SkipRecord | null; failures: FailureRecord[]; approvals: ApprovalRecord[]; brief: { file: string; sha256: string } | null };

/** Approval is allowed only after the default review (with no uncorrected accepted error) or an explicit skip. */
export const approvableStatuses: ReportStatus[] = ['reviewed', 'unreviewed'];

export function reportDirectory(privateDirectory: string, kind: string, hash: string): string {
  if (!kindPattern.test(kind) || !hashPattern.test(hash)) throw new Error('report-reference-invalid');
  return join(resolve(privateDirectory), 'reports', kind, hash);
}
export const reportReference = (kind: string, hash: string, item: string) => `${kind}/${hash}#${item}`;

async function writeReplace(directory: string, name: string, text: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(directory, name));
  } finally { await unlink(temporary).catch(() => undefined); }
}
/** Exclusive creation: a second record of the same kind is refused, never overwritten. */
async function writeOnce(directory: string, name: string, text: string, existsCode: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  let handle;
  try { handle = await open(join(directory, name), 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(existsCode); throw error; }
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}
async function readRecord(path: string): Promise<ObjectValue | undefined> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try { const value: unknown = JSON.parse(text); if (isObject(value)) return value; } catch { /* reported below */ }
  throw new Error('report-record-invalid');
}
async function readRecords(directory: string): Promise<ObjectValue[]> {
  let names: string[];
  try { names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return Promise.all(names.map(async name => (await readRecord(join(directory, name)))!));
}

function reviewer(value: unknown): Reviewer {
  const input = object(value);
  if (Object.keys(input).some(key => !['host', 'method'].includes(key)) || !(input.host === 'claude' && input.method === 'fresh-context' || input.host === 'codex' && input.method === 'codex-exec'))
    throw new Error('report-reviewer-invalid');
  return { host: input.host, method: input.method } as Reviewer;
}
function userWords(value: unknown): string {
  if (!filled(value)) throw new Error('report-user-words-required');
  return value;
}
function exactKeys(value: unknown, allowed: string[], code: string): ObjectValue {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(code);
  return value;
}

function checkContent(content: AdviceContent): void {
  const ids = new Set<string>();
  if (content.schemaVersion !== 1 || !kindPattern.test(content.kind) || !isoTime(content.createdAt) || !Array.isArray(content.items) || !content.items.length
    || content.items.some(item => !isObject(item) || !itemPattern.test(item.id) || ids.size === ids.add(item.id).size || !filled(item.title) || !isObject(item.scope)))
    throw new Error('report-content-invalid');
  const revision = content.revisionOf;
  if (revision !== null && (!isObject(revision) || !hashPattern.test(revision.reportHash) || !Array.isArray(revision.corrections) || !Array.isArray(revision.changedFields)
    || !Array.isArray(revision.changedResults) || [...revision.changedFields, ...revision.changedResults].some(field => !filled(field)) || revision.corrections.some(item => !isObject(item) || !filled(item.finding) || !filled(item.change)))) throw new Error('report-content-invalid');
}

/** Saves one immutable report version. A revision must correct every accepted finding of its reviewed parent. */
export async function saveAdviceReport(privateDirectory: string, content: AdviceContent): Promise<{ hash: string; file: string }> {
  checkContent(content);
  const revision = content.revisionOf;
  if (revision) {
    const parent = await loadAdviceReport(privateDirectory, content.kind, revision.reportHash);
    if (parent.content.revisionOf) throw new Error('report-revision-of-revision');
    if (parent.review?.outcome !== 'reviewed') throw new Error('report-revision-requires-review');
    const accepted = parent.review.findings.filter(finding => finding.decision === 'accepted').map(finding => finding.id);
    if (!accepted.length) throw new Error('report-revision-not-needed');
    for (const correction of revision.corrections) if (!accepted.includes(correction.finding)) throw new Error(`report-correction-not-accepted:${correction.finding}`);
    for (const id of accepted) if (!revision.corrections.some(correction => correction.finding === id)) throw new Error(`report-correction-missing:${id}`);
  }
  const text = JSON.stringify(content), hash = digest(text), directory = reportDirectory(privateDirectory, content.kind, hash);
  await writeReplace(directory, 'report.json', `${text}\n`);
  return { hash, file: join(directory, 'report.json') };
}

/** Reads a report version and derives its review status from the records next to it. */
export async function loadAdviceReport(privateDirectory: string, kind: string, hash: string): Promise<ReportState> {
  const directory = reportDirectory(privateDirectory, kind, hash);
  const value = await readRecord(join(directory, 'report.json'));
  if (!value) throw new Error('report-not-found');
  if (digest(JSON.stringify(value)) !== hash) throw new Error('report-content-mismatch');
  const content = value as unknown as AdviceContent;
  if (content.kind !== kind) throw new Error('report-content-mismatch');
  checkContent(content);
  const failures = (await readRecords(join(directory, 'review-failures'))) as unknown as FailureRecord[];
  const approvals = (await readRecords(join(directory, 'approvals'))) as unknown as ApprovalRecord[];
  if ([...failures, ...approvals].some(record => record.reportHash !== hash || record.kind !== kind)) throw new Error('report-record-invalid');
  let brief: ReportState['brief'] = null;
  try { const text = await readFile(join(directory, 'review-brief.md'), 'utf8'); brief = { file: join(directory, 'review-brief.md'), sha256: digest(text) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (content.revisionOf) {
    const parent = await loadAdviceReport(privateDirectory, kind, content.revisionOf.reportHash);
    if (parent.review?.outcome !== 'reviewed') throw new Error('report-record-invalid');
    return { kind, hash, content, status: 'reviewed', review: parent.review, failures: [], approvals, brief: null };
  }
  const record = await readRecord(join(directory, 'review.json'));
  if (record && (record.reportHash !== hash || record.kind !== kind || !['reviewed', 'skipped'].includes(String(record.outcome)))) throw new Error('report-record-invalid');
  const review = (record ?? null) as ReviewRecord | SkipRecord | null;
  const status: ReportStatus = review?.outcome === 'reviewed' ? review.findings.some(finding => finding.decision === 'accepted') ? 'needs-correction' : 'reviewed'
    : review?.outcome === 'skipped' ? 'unreviewed' : failures.length ? 'review-failed' : 'pending-review';
  return { kind, hash, content, status, review, failures, approvals, brief };
}

async function reviewable(privateDirectory: string, kind: string, hash: string): Promise<ReportState> {
  const state = await loadAdviceReport(privateDirectory, kind, hash);
  if (state.content.revisionOf) throw new Error('report-revision-already-reviewed');
  if (state.review) throw new Error('report-review-exists');
  return state;
}

const templateFile = fileURLToPath(new URL('../references/report-review.md', import.meta.url));
const fence = (text: string) => { const run = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length)); return '`'.repeat(run + 1); };
/**
 * Writes the self-contained review brief both hosts use: the shared template, the report as the user sees it
 * and the full report JSON. Placeholders are filled in one pass, so report text cannot inject another one.
 */
export async function writeReviewBrief(privateDirectory: string, kind: string, hash: string, reportMarkdown: string): Promise<{ file: string; sha256: string }> {
  const state = await reviewable(privateDirectory, kind, hash);
  const json = JSON.stringify(state.content, null, 2), marker = fence(json);
  const values: Record<string, string> = { kind, reportHash: hash, markdown: reportMarkdown.trimEnd(), json: `${marker}json\n${json}\n${marker}` };
  const brief = (await readFile(templateFile, 'utf8')).replace(/\r\n/g, '\n').replace(/\{\{(kind|reportHash|markdown|json)\}\}/g, (_all, key: string) => values[key]!);
  const directory = reportDirectory(privateDirectory, kind, hash);
  await writeReplace(directory, 'review-brief.md', brief);
  return { file: join(directory, 'review-brief.md'), sha256: digest(brief) };
}

/** The one review round. The dispatcher's decision and reason are recorded for every finding the reviewer reported. */
export async function recordReview(privateDirectory: string, kind: string, hash: string, value: unknown): Promise<ReportState> {
  const input = exactKeys(value, ['reviewer', 'briefSha256', 'findings'], 'report-review-invalid');
  const who = reviewer(input.reviewer);
  const state = await reviewable(privateDirectory, kind, hash);
  if (!state.brief) throw new Error('report-brief-required');
  if (input.briefSha256 !== state.brief.sha256) throw new Error('report-brief-mismatch');
  if (!Array.isArray(input.findings)) throw new Error('report-review-invalid');
  const ids = new Set<string>();
  const findings = input.findings.map((raw): Finding => {
    const finding = exactKeys(raw, ['id', 'location', 'problem', 'evidence', 'fix', 'decision', 'reason'], 'report-finding-invalid');
    if (!filled(finding.id) || !itemPattern.test(finding.id) || ids.size === ids.add(finding.id).size || !filled(finding.location) || !filled(finding.problem)
      || !filled(finding.evidence) || finding.fix !== undefined && finding.fix !== null && typeof finding.fix !== 'string') throw new Error('report-finding-invalid');
    if (finding.decision !== 'accepted' && finding.decision !== 'rejected') throw new Error(`report-finding-decision-required:${finding.id}`);
    if (!filled(finding.reason)) throw new Error(`report-finding-reason-required:${finding.id}`);
    return { id: finding.id, location: finding.location, problem: finding.problem, evidence: finding.evidence, fix: typeof finding.fix === 'string' ? finding.fix : null,
      decision: finding.decision, reason: finding.reason };
  });
  const record: ReviewRecord = { schemaVersion: 1, kind, reportHash: hash, outcome: 'reviewed', recordedAt: new Date().toISOString(), reviewer: who,
    briefSha256: state.brief.sha256, findings, priorFailures: state.failures.length };
  await writeOnce(reportDirectory(privateDirectory, kind, hash), 'review.json', `${JSON.stringify(record)}\n`, 'report-review-exists');
  return loadAdviceReport(privateDirectory, kind, hash);
}

/** A review that produced no conclusion is recorded as such; it is not a round and never counts as reviewed. */
export async function recordReviewFailure(privateDirectory: string, kind: string, hash: string, value: unknown): Promise<ReportState> {
  const input = exactKeys(value, ['reviewer', 'reason', 'detail'], 'report-failure-invalid');
  const who = reviewer(input.reviewer);
  if (!failureReasons.includes(input.reason as never) || input.detail !== undefined && input.detail !== null && typeof input.detail !== 'string') throw new Error('report-failure-invalid');
  await reviewable(privateDirectory, kind, hash);
  const record: FailureRecord = { schemaVersion: 1, kind, reportHash: hash, outcome: 'failed', recordedAt: new Date().toISOString(), reviewer: who,
    reason: input.reason as FailureRecord['reason'], detail: typeof input.detail === 'string' && input.detail.trim() ? input.detail : null };
  await writeOnce(join(reportDirectory(privateDirectory, kind, hash), 'review-failures'), `${Date.now()}-${randomUUID()}.json`, `${JSON.stringify(record)}\n`, 'report-record-exists');
  return loadAdviceReport(privateDirectory, kind, hash);
}

/** The user's explicit skip for this report, in the user's own words. No review is started. */
export async function recordReviewSkip(privateDirectory: string, kind: string, hash: string, value: unknown): Promise<ReportState> {
  const input = exactKeys(value, ['userWords'], 'report-skip-invalid');
  const words = userWords(input.userWords);
  const state = await reviewable(privateDirectory, kind, hash);
  const record: SkipRecord = { schemaVersion: 1, kind, reportHash: hash, outcome: 'skipped', recordedAt: new Date().toISOString(), userWords: words, priorFailures: state.failures.length };
  await writeOnce(reportDirectory(privateDirectory, kind, hash), 'review.json', `${JSON.stringify(record)}\n`, 'report-review-exists');
  return loadAdviceReport(privateDirectory, kind, hash);
}

/** Records the user's approval of named items only, each with the scope the report states for it. */
export async function approveReportItems(privateDirectory: string, kind: string, hash: string, value: unknown): Promise<{ state: ReportState; approval: ApprovalRecord }> {
  const input = exactKeys(value, ['items', 'userWords'], 'report-approval-invalid');
  const words = userWords(input.userWords);
  const state = await loadAdviceReport(privateDirectory, kind, hash);
  if (!approvableStatuses.includes(state.status)) throw new Error(`report-not-approvable:${state.status}`);
  if (!Array.isArray(input.items) || !input.items.length || new Set(input.items).size !== input.items.length) throw new Error('report-approval-invalid');
  const items = input.items.map((id): ApprovedItem => {
    const item = state.content.items.find(entry => entry.id === id);
    if (!item) throw new Error(`report-item-unknown:${typeof id === 'string' && itemPattern.test(id) ? id : 'invalid'}`);
    return { id: item.id, reference: reportReference(kind, hash, item.id), title: item.title, scope: structuredClone(item.scope) };
  });
  const approval: ApprovalRecord = { schemaVersion: 1, kind, reportHash: hash, approvedAt: new Date().toISOString(), userWords: words,
    reviewStatus: state.status as 'reviewed' | 'unreviewed', items };
  await writeOnce(join(reportDirectory(privateDirectory, kind, hash), 'approvals'), `${Date.now()}-${randomUUID()}.json`, `${JSON.stringify(approval)}\n`, 'report-record-exists');
  return { state: await loadAdviceReport(privateDirectory, kind, hash), approval };
}

/** For maa-daily: the approved item behind a `kind/hash#item` reference, or a refusal. */
export async function resolveApprovedItem(privateDirectory: string, reference: string): Promise<{ state: ReportState; item: ApprovedItem; approval: ApprovalRecord }> {
  const match = /^([a-z][a-z-]{0,31})\/([a-f0-9]{64})#([A-Za-z][A-Za-z0-9_-]{0,31})$/.exec(typeof reference === 'string' ? reference : '');
  if (!match) throw new Error('report-reference-invalid');
  const [, kind, hash, id] = match;
  const state = await loadAdviceReport(privateDirectory, kind!, hash!);
  if (!approvableStatuses.includes(state.status)) throw new Error(`report-not-approvable:${state.status}`);
  for (const approval of state.approvals) {
    const item = approval.items.find(entry => entry.id === id);
    if (item) return { state, item, approval };
  }
  throw new Error('report-item-not-approved');
}

const reviewers: Record<string, string> = { claude: 'Claude Code 全新上下文的子代理', codex: 'Codex 新起的 codex exec 进程' };
const failures: Record<string, string> = { 'host-unavailable': '无法启动独立审查', 'reviewer-error': '审查员出错', 'no-usable-result': '审查员没有给出可用的结论', 'timeout': '审查超时' };
/**
 * The status banner, the kind's body, and the review, correction and approval records. Every value that did not
 * come from these templates goes through the research layer's single Markdown inertness function.
 */
export function formatAdviceReportMarkdown(state: ReportState, view: { title: string; body: string[]; scope: (item: ApprovedItem) => string[] }): string {
  const review = state.review, accepted = review?.outcome === 'reviewed' ? review.findings.filter(finding => finding.decision === 'accepted') : [];
  const failed = state.failures.map(failure => failures[failure.reason] ?? inline(failure.reason)).join('、');
  const banner = state.status === 'pending-review' ? '**【待审查】** 这份报告还没有经过默认的独立审查；审查完成前不能批准。'
    : state.status === 'review-failed' ? `**【审查未完成】** 已发起的独立审查没有得出结论（${state.failures.length} 次：${failed}），不能当作已审查。可以重新发起审查，或由你明确说跳过。`
    : state.status === 'needs-correction' ? `**【审查发现错误，待改正】** 独立审查接受了 ${accepted.length} 项真实错误；改正后生成新版本，这一版不能批准。`
    : state.status === 'unreviewed' ? `**【未审查】** 你本次明确跳过了独立审查（你的原话：「${inline((review as SkipRecord).userWords)}」）。报告里的数字和资料没有经过第二人核对，请自行权衡。`
    : state.content.revisionOf ? `**【已审查，已按审查改正】** 一名独立审查员审了一轮，接受的 ${accepted.length} 项错误已改正；按规则改正后不再复审，改动见「审查后的改动」。${
      state.content.revisionOf.changedResults.length ? '改正后重新读取或重新计算的结果与原版本不同（见「审查后的改动」），这些变化没有经过审查，请先看再批准。' : ''}`
    : `**【已审查】** 一名独立审查员审了一轮，报告 ${review?.outcome === 'reviewed' ? review.findings.length : 0} 项意见，接受 0 项。`;
  const lines = [`# ${view.title}`, '', `> ${banner}`, '', `- 报告：${state.kind}/${state.hash}`, `- 生成时间：${inline(state.content.createdAt)}`,
    '- 审查通过不等于批准，批准也不等于执行：maa-account 不写 MAA 配置、不执行培养；只有你批准的条目会交给 maa-daily，由它按自己的流程重新核对后执行。', '', ...view.body, ''];
  lines.push('## 审查记录', '');
  if (review?.outcome === 'reviewed') {
    lines.push(`- 审查员：${reviewers[review.reviewer.host]}；审查说明 SHA-256：${review.briefSha256}；记录时间：${inline(review.recordedAt)}`);
    if (state.content.revisionOf) lines.push(`- 审查的是原版本 ${state.kind}/${state.content.revisionOf.reportHash}`);
    if (review.priorFailures) lines.push(`- 此前未完成的审查：${review.priorFailures} 次`);
    if (!review.findings.length) lines.push('- 审查员没有发现真实错误。');
    for (const finding of review.findings) lines.push(`- ${inline(finding.id)}（${finding.decision === 'accepted' ? '接受' : '拒绝'}）位置：${inline(finding.location)}；问题：${inline(finding.problem)}；依据：${inline(finding.evidence)}；处理理由：${inline(finding.reason)}`);
  } else if (review?.outcome === 'skipped') {
    lines.push(`- 未审查：你本次明确跳过（原话：「${inline(review.userWords)}」）；记录时间：${inline(review.recordedAt)}`);
    if (review.priorFailures) lines.push(`- 跳过之前未完成的审查：${review.priorFailures} 次`);
  } else lines.push('- 尚无审查结论。');
  for (const failure of state.failures) lines.push(`- 未完成的审查：${reviewers[failure.reviewer.host]}，${failures[failure.reason]}；${inline(failure.recordedAt)}${failure.detail ? `；说明：${inline(failure.detail)}` : ''}`);
  if (state.content.revisionOf) {
    lines.push('', '## 审查后的改动', '', `- 原版本：${state.kind}/${state.content.revisionOf.reportHash}`);
    for (const correction of state.content.revisionOf.corrections) lines.push(`- 改正 ${inline(correction.finding)}：${inline(correction.change)}`);
    const list = (fields: string[]) => fields.length ? fields.map(inline).join('、') : '无';
    lines.push(`- 与原版本不同的输入：${list(state.content.revisionOf.changedFields)}`,
      `- 与原版本不同的工具结果和资料：${list(state.content.revisionOf.changedResults)}${state.content.revisionOf.changedResults.length ? '（改正时重新读取或重新计算，没有经过审查）' : ''}`);
  }
  lines.push('', '## 批准记录', '');
  if (!state.approvals.length) lines.push(approvableStatuses.includes(state.status) ? '- 尚未批准任何条目。可以逐项批准，未批准的条目不会执行。' : '- 当前状态不能批准。');
  for (const approval of state.approvals) {
    lines.push(`- ${inline(approval.approvedAt)}：批准 ${approval.items.map(item => inline(item.id)).join('、')}（你的原话：「${inline(approval.userWords)}」；当时${approval.reviewStatus === 'reviewed' ? '已审查' : '未审查'}）`);
    for (const item of approval.items) lines.push(`  - ${inline(item.id)} ${inline(item.title)}；引用：${item.reference}`, ...view.scope(item).map(line => `    - ${line}`));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
