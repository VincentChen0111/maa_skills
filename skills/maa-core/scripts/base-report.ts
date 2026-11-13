// Base advice reports (ticket 22). The plan comes from the shared base plan tool (generation, the six rules, the MAA
// name table and the 15 gates); effective skills come from the shared base skill query (ticket 21). The agent supplies
// the goals, the proposed arrangement, mood rates, combinations and efficiency figures with their basis; the report
// labels those as inference. Saving, review, skip, correction and approval are the shared advice-report protocol.
// Nothing here writes MAA configuration, runs MAA, clicks the game or operates a device; approval is not execution.
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPlanText, gateTitles, generateBasePlan, loadPlanTables, parsePlanSpec, planFreshness, readMaaNameTable, readPrivateFile, readSnapshot, snapshotFingerprint,
  specChecks, suppliedPlanTables, tablesFingerprint, type Fill, type GenerateOptions, type GenerateResult, type OperatorFacts, type PlanCheck, type PlanInputs, type Freshness } from './base-plan.ts';
import { saveAdviceReport, loadAdviceReport, writeReviewBrief, recordReview, recordReviewFailure, recordReviewSkip, approveReportItems,
  formatAdviceReportMarkdown, type AdviceContent, type ApprovedItem, type ReportState } from './advice-report.ts';
import { readSettings } from './preferences.ts';
import { inline } from './research.ts';

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown): ObjectValue => isObject(value) ? value : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const filled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const kind = 'base';
/** The pinned MAA protocol the exported plan follows; ticket 25 registers it and adds the installed-version record. */
export const maaProtocol = { version: 'v6.21.4', commit: '52d0b2acaca116585b02e1e6a9da303460f81a24', file: 'docs/zh-cn/protocol/base-scheduling-schema.md' };

type Goals = { source: 'user-stated' | 'assumed'; text: string };
type Generated = Extract<GenerateResult, { status: 'written' }>;
export type BaseContent = AdviceContent & { kind: 'base'; input: ObjectValue; goals: Goals; assumptions: string[]; summary: string | null; maaProtocol: typeof maaProtocol;
  plan: { file: string; sha256: string; json: ObjectValue; dropped: string[]; fills: Fill[] }; snapshot: { readAt: unknown; sourceTimes: unknown; coverage: unknown; fingerprint: string };
  operators: Record<string, OperatorFacts>; check: Omit<PlanCheck, 'operators'>; sources: Generated['sources'] };
export type DraftResult = { status: 'saved'; reportHash: string; state: ReportState<BaseContent> } | { status: 'needs-input'; issues: string[] };
const reportKeys = ['goals', 'assumptions', 'summary', 'revisionOf'];

/** What approving the plan item allows: maa-daily may apply this exact file after re-running every check; nothing else. */
function planScope(content: Omit<BaseContent, 'items'>): ObjectValue {
  const failing = [...content.check.errors, ...content.check.gates.filter(gate => gate.verdict === 'fail').map(gate => `gate-${gate.gate}`)];
  return { planFile: content.plan.file, sha256: content.plan.sha256, plans: list(content.plan.json.plans).length, applicable: content.check.applicable, failing,
    unverified: [...content.check.unverified],
    dailyMayArrange: content.check.applicable ? [{ action: 'apply-custom-infrast-plan', planFile: content.plan.file, sha256: content.plan.sha256 }] : [],
    dailyMustFirst: ['recheck-rules-and-gates', 'check-freshness', 'confirm-unverified-with-user'],
    notIncluded: ['production-line-switch', 'training-room', 'stage-runs', 'stone-and-medicine', 'gacha-packs-payment-login', 'maa-config-by-account', 'game-clicks-or-device'] };
}

/** Field paths where the agent's input differs from the reviewed version's input. */
function changedFields(before: ObjectValue, after: ObjectValue): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => {
    if (key !== 'shifts' || !Array.isArray(before.shifts) || !Array.isArray(after.shifts)) return same(before[key], after[key]) ? [] : [key];
    const old = before.shifts, next = after.shifts;
    return Array.from({ length: Math.max(old.length, next.length) }, (_, index) => index).flatMap(index => old[index] === undefined || next[index] === undefined ? [`shifts[${index}]`]
      : [...new Set([...Object.keys(object(old[index])), ...Object.keys(object(next[index]))])].filter(field => !same(object(old[index])[field], object(next[index])[field])).map(field => `shifts[${index}].${field}`));
  });
}

// ---- what counts as a changed result between a reviewed version and its correction -------------------------------
// One owner for this rule (the advice-report protocol requires one predicate per report kind): every producer a draft
// re-reads or recomputes is listed here with the fields that are content. Read times and scan times only say when
// something was read, so the same content read again later is never a change. tests/base-report.test.ts enumerates
// every producer with a same-content-later case and a real-change case.
type ResultView = Record<string, unknown>;
export const resultProducers: { name: string; view: (content: ObjectValue) => ResultView }[] = [
  // The account facts the plan depends on; read and scan times are not content.
  { name: 'snapshot', view: content => ({ 'snapshot.coverage': object(content.snapshot).coverage, 'snapshot.fingerprint': object(content.snapshot).fingerprint }) },
  // Ownership and effective skills from the shared base skill query, per named operator.
  { name: 'operators', view: content => Object.fromEntries(Object.entries(object(content.operators)).map(([name, facts]) => [`operators.${name}`, facts])) },
  // The shared check: rules, gates, efficiency arithmetic and the game facts it used.
  { name: 'check', view: content => Object.fromEntries(Object.entries(object(content.check)).map(([key, value]) => [`check.${key}`, value])) },
  // The exported plan file; its path is the agent's input (target) or follows from this content.
  { name: 'plan-file', view: content => ({ 'plan.sha256': object(content.plan).sha256, 'plan.json': object(content.plan).json, 'plan.dropped': object(content.plan).dropped,
    'plan.fills': object(content.plan).fills }) },
  // MAA's local name table, identified by its content hash.
  { name: 'name-table', view: content => { const names = object(object(content.sources).names); return { 'sources.names': [names.status, names.reason, names.sha256] }; } },
  // A pinned public table is identified by repository, commit, file and content hash, not by when it was read.
  { name: 'public-tables', view: content => ({ 'sources.mode': object(content.sources).mode,
    'sources.files': list(object(content.sources).files).map(object).map(file => [file.repository, file.commit, file.file, file.sha256]) }) },
  { name: 'maa-protocol', view: content => ({ maaProtocol: content.maaProtocol }) },
];
/** The one predicate: result fields that differ between a reviewed version and its correction; they were not reviewed. */
export function changedReportResults(before: unknown, after: unknown): string[] {
  const view = (value: unknown) => Object.assign({}, ...resultProducers.map(producer => producer.view(object(value)))) as ResultView;
  const old = view(before), next = view(after);
  return [...new Set([...Object.keys(old), ...Object.keys(next)])].filter(key => JSON.stringify(old[key]) !== JSON.stringify(next[key]));
}

function parseReport(input: ObjectValue): { goals?: Goals; assumptions: string[]; summary: string | null; issues: string[] } {
  const issues: string[] = [], goals = object(input.goals);
  const ok = isObject(input.goals) && ['user-stated', 'assumed'].includes(String(goals.source)) && filled(goals.text) && Object.keys(goals).every(key => ['source', 'text'].includes(key));
  if (!ok) issues.push('goals-required');
  if (input.assumptions !== undefined && (!Array.isArray(input.assumptions) || !input.assumptions.every(filled))) issues.push('assumptions-invalid');
  if (input.summary !== undefined && !filled(input.summary)) issues.push('summary-invalid');
  return { ...(ok ? { goals: { source: goals.source as Goals['source'], text: goals.text as string } } : {}), assumptions: list(input.assumptions) as string[],
    summary: typeof input.summary === 'string' ? input.summary : null, issues };
}

/** Validates, generates and checks the plan, then saves one report version; returns needs-input instead of guessing. */
export async function draftBaseReport(value: unknown, options: GenerateOptions & { now?: () => Date } = {}): Promise<DraftResult> {
  const input = object(value);
  if (!isObject(value)) return { status: 'needs-input', issues: ['input-invalid'] };
  const report = parseReport(input);
  const planInput = Object.fromEntries(Object.entries(input).filter(([key]) => !reportKeys.includes(key)));
  const spec = parsePlanSpec(planInput, ['target', 'base', 'snapshotFile', 'tablesFile', 'format']);
  const issues = [...report.issues, ...spec.issues];
  if (issues.length || !report.goals) return { status: 'needs-input', issues };
  const revision = object(input.revisionOf);
  if (input.revisionOf !== undefined && (Object.keys(revision).some(key => !['reportHash', 'corrections'].includes(key)) || typeof revision.reportHash !== 'string'
    || !Array.isArray(revision.corrections) || revision.corrections.some(entry => Object.keys(object(entry)).some(key => !['finding', 'change'].includes(key)))))
    throw new Error('report-revision-invalid');
  const texts = [...report.assumptions, ...report.summary ? [report.summary] : [], ...report.goals.source === 'assumed' ? [report.goals.text] : []];
  const generated = await generateBasePlan(planInput, { ...options, texts: [...options.texts ?? [], ...texts] });
  if (generated.status === 'needs-input') return generated;
  const settings = await readSettings(options.home);
  const { operators, ...check } = generated.check;
  const body: Omit<BaseContent, 'items'> = { schemaVersion: 1, kind, createdAt: (options.now?.() ?? new Date()).toISOString(), revisionOf: null,
    input: Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'revisionOf' && key !== 'format')), goals: report.goals, assumptions: report.assumptions, summary: report.summary,
    maaProtocol, plan: { file: generated.relative.replaceAll('\\', '/'), sha256: generated.sha256, json: generated.plan, dropped: generated.dropped, fills: generated.fills },
    snapshot: { ...generated.snapshot, fingerprint: generated.inputs.snapshot! }, operators, check, sources: generated.sources };
  const content = { ...body, items: [{ id: 'P1', title: `基建排班：${body.plan.file}（${list(generated.plan.plans).length} 个班次）`, scope: planScope(body) }] } as BaseContent;
  if (input.revisionOf !== undefined) {
    const parent = await loadAdviceReport(settings.privateDirectory, kind, String(revision.reportHash));
    content.revisionOf = { reportHash: parent.hash, corrections: (revision.corrections as ObjectValue[]).map(entry => ({ finding: String(entry.finding ?? ''), change: String(entry.change ?? '') })),
      changedFields: changedFields(object(object(parent.content).input), content.input), changedResults: changedReportResults(parent.content, content) };
  }
  const saved = await saveAdviceReport(settings.privateDirectory, content);
  return { status: 'saved', reportHash: saved.hash, state: await loadAdviceReport(settings.privateDirectory, kind, saved.hash) as ReportState<BaseContent> };
}

/** Approval through the shared protocol; a plan the check did not mark applicable cannot be approved for application. */
export async function approveBaseReportItems(privateDirectory: string, hash: string, value: unknown) {
  const state = await loadAdviceReport(privateDirectory, kind, hash);
  for (const id of list(object(value).items)) if (object(state.content.items.find(item => item.id === id)?.scope).applicable === false) throw new Error('base-plan-not-applicable');
  return approveReportItems(privateDirectory, kind, hash, value);
}

/**
 * Three states per input (fresh, stale, unknown) against what the report recorded. When the old check is not fresh it
 * is not proof of anything: the check runs again on the current inputs and that new result is returned (not saved).
 */
export async function baseReportFreshness(privateDirectory: string, hash: string, options: { home?: string; fetcher?: typeof fetch } = {}):
  Promise<{ states: Record<keyof PlanInputs | 'check', Freshness>; recheck: PlanCheck | null }> {
  const content = (await loadAdviceReport(privateDirectory, kind, hash)).content as BaseContent;
  const settings = await readSettings(options.home), root = await realpath(resolve(privateDirectory));
  const recorded: PlanInputs = { snapshot: content.snapshot.fingerprint, tables: tablesFingerprint(content.sources.files), names: content.sources.names.sha256, plan: content.plan.sha256 };
  const snapshot = await readSnapshot(root, content.input.snapshotFile).catch(() => null);
  const tables = await (content.sources.mode === 'supplied' ? suppliedPlanTables(String(content.input.tablesFile)) : loadPlanTables(options.fetcher)).catch(() => null);
  const names = await readMaaNameTable(settings.maaDirectory);
  const text = await readPrivateFile(root, content.plan.file).catch(() => null);
  const states = planFreshness(recorded, { snapshot: snapshot === null ? null : snapshotFingerprint(snapshot), tables: tables ? tablesFingerprint(tables.files) : null,
    names: names.status === 'available' ? names.sha256 : null, plan: text === null ? null : createHash('sha256').update(text).digest('hex') });
  if (states.check === 'fresh' || text === null || snapshot === null || !tables) return { states, recheck: null };
  const spec = parsePlanSpec(Object.fromEntries(Object.entries(content.input).filter(([key]) => !reportKeys.includes(key))), ['target', 'base', 'snapshotFile', 'tablesFile', 'format']).spec;
  if (!spec) return { states, recheck: null };
  return { states, recheck: checkPlanText(text, { layout: spec.layout, snapshot, tables: tables.tables, names, ...specChecks(spec), shifts: spec.shifts.length,
    reexport: `${JSON.stringify(content.plan.json, null, 2)}\n`, texts: [] }) };
}

// ---- Markdown (Chinese template; the agent translates for other languages) ------------------------------------

const verdictWords: Record<string, string> = { pass: '通过', fail: '不通过', unverified: '未核实' };
const statusWords: Record<string, string> = { active: '当前有效', unknown: '待核' };
const ownershipWords: Record<string, string> = { owned: '已持有', unobserved: '快照里没有观察到', ambiguous: '同名多个游戏 ID，待核', 'not-found': '游戏表里没有这个名字', unknown: '未知' };
const freshWords: Record<string, string> = { fresh: '新鲜', stale: '陈旧', unknown: '未知' };
const clock = (pairs: unknown) => list(pairs).map(pair => list(pair).map(value => inline(String(value))).join('–')).join('、');
const gateLabel = (entry: string) => { const match = /^gate-(\d+)$/.exec(entry); return match ? `第 ${match[1]} 项（${gateTitles[Number(match[1]) - 1]}）` : inline(entry); };

export function formatBaseReportBody(content: BaseContent): string[] {
  const plans = list(content.plan.json.plans).map(object), check = content.check, input = content.input;
  const reasons = list(input.shifts).map(shift => object(object(shift).reasons));
  const lines = ['## 目标与假设', '', content.goals.source === 'user-stated' ? `- 目标（你的原话）：${inline(content.goals.text)}` : `- 目标（假设，不是你的原话）：${inline(content.goals.text)}`,
    ...content.assumptions.map(text => `- 假设（推断）：${inline(text)}`), `- 布局（你提供的）：${list(input.layout).map(object).map(room => `${inline(String(room.type))} ${inline(String(room.level))} 级${
      room.product ? `（${inline(String(room.product))}）` : ''}`).join('、')}`, '', '## 结论', ''];
  const failing = check.gates.filter(gate => gate.verdict === 'fail').map(gate => `第 ${gate.gate} 项（${gateTitles[gate.gate - 1]}）`);
  lines.push(check.applicable ? '- 可应用：没有不通过的验收门，校验规则没有错误。' : `- 不可应用：${[...failing, ...check.errors.length ? [`校验错误 ${check.errors.map(inline).join('、')}`] : []].join('；')}。这一版不能批准应用。`,
    `- 未核实的项（不算通过，是否应用由你决定）：${check.unverified.length ? check.unverified.map(gateLabel).join('、') : '无'}`, '',
    '## 排班（事实：工具导出的排班文件）', '', `- 排班文件：私有目录下 ${inline(content.plan.file)}；SHA-256 ${content.plan.sha256}；按 MAA ${maaProtocol.version} 的基建排班协议导出`,
    '- 没有写产物字段，MAA 不会切换生产线；布局里有但没有安排的房间写「跳过」，布局里没有的设施写空数组，MAA 都保持原样。',
    '- 时间段由 MAA 图形界面按当前时间选计划（MaaCore 不处理时间段）；时间段重叠时 MAA 选文件里靠前的计划。',
    ...content.plan.fills.map(fill => `- 工具填入（按快照顺序选有该房间生效技能的已持有干员，没有比较收益）：计划 ${fill.plan + 1} ${inline(fill.room)}：${fill.operators.map(inline).join('、')}`),
    ...(content.plan.dropped.length ? [`- 基础文件里大小写写错的键已去掉：${content.plan.dropped.map(inline).join('、')}`] : []), '');
  plans.forEach((plan, index) => {
    lines.push(`### 计划 ${index + 1}：${inline(String(plan.name ?? ''))}（${clock(plan.period)}，${inline(String(plan.duration ?? '?'))} 分钟）`, '', '| 房间 | 干员 | 理由（推断） |', '| --- | --- | --- |');
    for (const [facility, entries] of Object.entries(object(plan.rooms))) list(entries).map(object).forEach((entry, k) => {
      const room = `${facility}[${k}]`;
      lines.push(`| ${inline(room)} | ${entry.skip ? '跳过（保持原样）' : list(entry.operators).map(name => inline(String(name))).join('、') || '（空）'} | ${reasons[index]?.[room] ? inline(String(reasons[index]![room])) : ''} |`);
    });
    const fia = object(plan.Fiammetta), drones = object(plan.drones);
    if (plan.Fiammetta) lines.push('', `- 菲亚梅塔：目标 ${inline(String(fia.target))}，${fia.order === 'post' ? '换班后' : '换班前'}使用`);
    if (plan.drones) lines.push('', `- 无人机：${inline(String(drones.room))} 第 ${inline(String(drones.index))} 间，${drones.order === 'post' ? '换班后' : '换班前'}使用`);
    lines.push('');
  });
  lines.push('## 干员的有效技能（事实：来自基建技能查询；条件是否满足未建模）', '');
  for (const [name, facts] of Object.entries(content.operators)) {
    lines.push(`- ${inline(name)}（${ownershipWords[facts.ownership] ?? inline(facts.ownership)}${facts.elite !== null ? `，精${facts.elite} ${facts.level ?? '?'}级` : ''}）：${facts.skills.length
      ? facts.skills.map(skill => `${inline(skill.name)}〔${statusWords[skill.status] ?? inline(skill.status)}〕：${inline(skill.text)}`).join('；') : '没有当前有效或待核的基建技能'}`);
  }
  lines.push('', '## 收益（推断）', '', '- 下面的数字是推断：由报告作者按技能文字和条件给出，工具只核对「总效率 = 基础 + 技能 + 全局」并按班次时长加权，不证明收益。');
  if (!check.efficiency.claims.length) lines.push('- 没有给出效率数字。');
  for (const claim of check.efficiency.claims) lines.push(`- 计划 ${claim.plan + 1} ${inline(claim.room)}：基础 ${claim.base} + 技能 ${claim.skill} + 全局 ${claim.global} = ${claim.total}；依据：${inline(claim.basis)}${
    claim.conditions ? `；条件：${inline(claim.conditions)}` : ''}${claim.unmodelled ? `；未建模：${inline(claim.unmodelled)}` : ''}`);
  for (const [room, value] of Object.entries(check.efficiency.daily)) lines.push(`- ${inline(room)} 每日按班次时长加权：${value ?? '未核实'}`);
  const mood = object(input.mood), moodDefault = object(input.moodDefault);
  if (isObject(input.moodDefault)) lines.push(`- 心情速率（推断，未单列的干员）：上班每小时 ${inline(String(moodDefault.work))}，宿舍每小时 ${inline(String(moodDefault.rest))}；依据：${inline(String(moodDefault.basis))}`);
  for (const [name, entry] of Object.entries(mood)) lines.push(`- 心情速率（推断）${inline(name)}：上班每小时 ${inline(String(object(entry).work))}，宿舍每小时 ${inline(String(object(entry).rest))}；依据：${inline(String(object(entry).basis))}`);
  for (const combo of list(input.combos).map(object)) lines.push(`- 组合（推断）：${list(combo.members).map(name => inline(String(name))).join('+')}${list(combo.dependsOn).length ? `，依赖 ${list(combo.dependsOn).map(name => inline(String(name))).join('、')}` : ''}；依据：${inline(String(combo.basis))}`);
  for (const entry of list(input.exclusions).map(object)) lines.push(`- 互斥（推断）：${list(entry.members).map(name => inline(String(name))).join('、')}；依据：${inline(String(entry.basis))}`);
  lines.push('', '## 验收门', '', '| 门 | 检查 | 结论 | 证据 |', '| --- | --- | --- | --- |',
    ...check.gates.map(gate => `| ${gate.gate} | ${gateTitles[gate.gate - 1]} | ${verdictWords[gate.verdict]} | ${gate.evidence.map(inline).join('；')} |`), '',
    '## 校验规则', '', `- 错误：${check.errors.length ? check.errors.map(inline).join('、') : '无'}`, `- 警告：${check.warnings.length ? check.warnings.map(inline).join('、') : '无'}`, '');
  const drones = plans.filter(plan => object(plan.drones).enable !== false && plan.drones).length, fiammetta = plans.filter(plan => plan.Fiammetta && object(plan.Fiammetta).enable !== false).length;
  lines.push('## 你可以做的步骤和成本', '', '1. 看完报告后逐项批准 P1；审查通过不等于批准，批准也不等于执行。',
    '2. 批准后由 maa-daily 重新跑全部校验和 15 项验收门、核对数据新鲜度，再经统一写入通道写入 MAA 的自定义基建设置（工单 23）；maa-account 不写 MAA 配置。',
    `3. 每天换班 ${plans.length} 次，每次由你启动 MAA 的基建任务或用 MAA 自己的定时；本工具不点游戏、不操作设备。`,
    `4. 成本：每天 ${plans.length} 次基建换班运行；${drones ? `${drones} 个计划使用无人机` : '不使用无人机'}；${fiammetta ? `${fiammetta} 个计划使用菲亚梅塔` : '不使用菲亚梅塔'}；不切换生产线，没有额外的材料或龙门币花费；心情消耗见验收门 4（速率是推断）。`, '',
    '## 数据新鲜度（生成时）', '', `- 账号快照：${freshWords.fresh}（读取时间 ${inline(String(content.snapshot.readAt ?? '未知'))}）`,
    `- 基建技能表：${freshWords.fresh}（${content.sources.mode === 'public' ? '公开固定提交' : '所提供的离线表'}）`,
    `- MAA 干员名表：${content.sources.names.status === 'available' ? freshWords.fresh : `${freshWords.unknown}（${inline(content.sources.names.reason ?? '')}）`}`,
    '- 之后快照、技能表、名表或排班文件有变化，这份检查结果就是陈旧的，不能当作当前数据的证明；应用前会重新检查。', '',
    '## 未建模', '', '- 阵营组合与全局效果的实际叠加、配方条件、心情随时间的非线性变化、宿舍氛围与等级带来的恢复差异、订单与产物的随机性。',
    '- 心情、组合、互斥和效率数字由报告作者给出（推断），工具只做一致性检查。', '- 文本百分比不是最终收益，不作排名或加总；没有证明是最优的方案。', '',
    '## 总体推断', '', `- 总体推断：${content.summary === null ? '（无）' : inline(content.summary)}`, '', '## 来源', '',
    content.sources.mode === 'supplied' ? '- 来源：所提供的离线表，本次未从公开镜像获取或核验。' : '- 来源：公开固定提交。',
    ...content.sources.files.map(file => `- ${inline(file.repository)}@${inline(file.commit)} ${inline(file.file)}：SHA-256 ${inline(file.sha256)}；读取时间 ${inline(file.readAt)}`),
    `- MAA 干员名表 resource/battle_data.json：${content.sources.names.sha256 ? `SHA-256 ${content.sources.names.sha256}` : inline(content.sources.names.reason ?? '不可用')}`,
    `- MAA 排班协议：${maaProtocol.version}（${maaProtocol.commit}）${maaProtocol.file}`);
  return lines;
}

const scopeWords: Record<string, string> = { 'production-line-switch': '切换生产线', 'training-room': '训练室安排', 'stage-runs': '刷关（关卡要你当次交办）',
  'stone-and-medicine': '碎石、理智药、临期药（要你当次批准）', 'gacha-packs-payment-login': '抽卡、礼包、付费、登录（任何情况下都不碰）', 'maa-config-by-account': 'maa-account 写 MAA 配置',
  'game-clicks-or-device': '点游戏或操作设备', 'recheck-rules-and-gates': '重新跑校验规则和 15 项验收门', 'check-freshness': '核对数据新鲜度', 'confirm-unverified-with-user': '未核实的项交你决定' };
function scopeLines(item: ApprovedItem): string[] {
  const scope = object(item.scope), arrange = list(scope.dailyMayArrange).map(object);
  return [`maa-daily 可据此安排：${arrange.length ? arrange.map(entry => `把排班文件 ${inline(String(entry.planFile))}（SHA-256 ${inline(String(entry.sha256))}）写入 MAA 自定义基建设置`).join('、') : '无（方案不可应用）'}`,
    `maa-daily 先要：${list(scope.dailyMustFirst).map(code => scopeWords[String(code)] ?? inline(String(code))).join('、')}`,
    `批准时未核实的项：${list(scope.unverified).length ? list(scope.unverified).map(entry => gateLabel(String(entry))).join('、') : '无'}`,
    `不包括：${list(scope.notIncluded).map(code => scopeWords[String(code)] ?? inline(String(code))).join('；')}`];
}
export function formatBaseReportMarkdown(state: ReportState<BaseContent> | ReportState): string {
  return formatAdviceReportMarkdown(state, { title: '基建建议报告', body: formatBaseReportBody(state.content as BaseContent), scope: scopeLines, carriesOut: '排班' });
}

// ---- CLI ---------------------------------------------------------------------------------------------------------

const without = (input: ObjectValue, ...names: string[]) => Object.fromEntries(Object.entries(input).filter(([key]) => !names.includes(key)));
const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    const action = process.argv[2];
    if (process.argv.length !== 3 || !['draft', 'read', 'brief', 'review', 'fail', 'skip', 'approve', 'freshness'].includes(action!)) throw new Error('base-action-invalid');
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw) as unknown;
    if (!isObject(input) || input.format !== undefined && !['json', 'markdown'].includes(String(input.format))) throw new Error('base-input-invalid');
    const { privateDirectory } = await readSettings(), markdown = input.format === 'markdown';
    const load = async () => await loadAdviceReport(privateDirectory, kind, String(input.reportHash ?? '')) as ReportState<BaseContent>;
    if (action === 'draft') {
      const result = await draftBaseReport(input);
      if (result.status === 'needs-input') { console.log(JSON.stringify({ ok: false, status: 'needs-input', issues: result.issues })); process.exitCode = 1; }
      else console.log(markdown ? formatBaseReportMarkdown(result.state) : JSON.stringify({ ok: true, status: result.state.status, reportHash: result.reportHash, reference: `${kind}/${result.reportHash}`,
        applicable: result.state.content.check.applicable, planFile: result.state.content.plan.file, unverified: result.state.content.check.unverified,
        items: result.state.content.items.map(item => ({ id: item.id, title: item.title })) }));
    } else if (action === 'read') {
      if (Object.keys(input).some(key => !['reportHash', 'format'].includes(key))) throw new Error('base-input-invalid');
      const state = await load();
      console.log(markdown ? formatBaseReportMarkdown(state) : JSON.stringify({ ok: true, report: state }));
    } else if (action === 'brief') {
      if (Object.keys(input).some(key => key !== 'reportHash')) throw new Error('base-input-invalid');
      const state = await load();
      const brief = await writeReviewBrief(privateDirectory, kind, state.hash, formatBaseReportBody(state.content).join('\n'));
      console.log(JSON.stringify({ ok: true, file: brief.file, sha256: brief.sha256 }));
    } else if (action === 'freshness') {
      if (Object.keys(input).some(key => key !== 'reportHash')) throw new Error('base-input-invalid');
      console.log(JSON.stringify({ ok: true, ...await baseReportFreshness(privateDirectory, (await load()).hash) }));
    } else {
      const hash = String(input.reportHash ?? ''), rest = without(input, 'reportHash', 'format');
      if (action === 'approve') {
        const { state, approval } = await approveBaseReportItems(privateDirectory, hash, rest);
        console.log(markdown ? formatBaseReportMarkdown(state) : JSON.stringify({ ok: true, status: state.status, approved: approval.items.map(item => ({ id: item.id, reference: item.reference })) }));
      } else {
        const state = action === 'review' ? await recordReview(privateDirectory, kind, hash, rest) : action === 'fail' ? await recordReviewFailure(privateDirectory, kind, hash, rest)
          : await recordReviewSkip(privateDirectory, kind, hash, rest);
        console.log(markdown ? formatBaseReportMarkdown(state) : JSON.stringify({ ok: true, status: state.status, reference: `${kind}/${state.hash}` }));
      }
    }
  } catch (error) {
    const code = error instanceof Error && /^(report|base|plan|public-data)-[a-z0-9-]+(?::[A-Za-z0-9_-]+)?$/.test(error.message) ? error.message : 'base-report-failed';
    console.log(JSON.stringify({ ok: false, error: code })); process.exitCode = 1;
  }
}
