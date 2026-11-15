// Independent calculations from fixed table fields and complete skill descriptions; see training-sources.md.
import { queryBaseSkills, isBaseRoom } from './base-query.ts';
import { calculateCultivationGaps, formatDecomposition, type GapTables, type GapResult, type GapPlan } from './cultivation-gaps.ts';
import { loadOperatorCostTables, operatorCostSources, operatorCatalog } from './operator-cost.ts';
import { craftingSources } from './cultivation-gaps.ts';
import { readPublicJson, type PublicJsonSource } from './public-data.ts';
import { readSettings } from './preferences.ts';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, stdinJsonCode } from './stdin-json.ts';
import { staticCode, trainingCheckRequired, type TierPayment, type Spend } from './training-state.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const reductionPending = 'assistant:five-hour-reduction-pending:';
/** Ticket 32 follow-on OB-6: an extra the tool cannot verify. The assistant keeps its verified bonus as a lower bound. */
const lowerBoundIssue = (issue: string) => issue.startsWith(reductionPending) || issue.startsWith('assistant:condition-unverified:') || issue.startsWith('assistant:branch-unverified:');
/** Issues that still allow a speed estimate: availability (handled by selection) and unverified extras (estimated without them). */
const estimateKeepingIssue = (issue: string) => issue === 'assistant:unavailable' || issue === 'assistant:availability-unverified' || lowerBoundIssue(issue);
const professions: Record<string, string> = { PIONEER: '先锋', WARRIOR: '近卫', TANK: '重装', SNIPER: '狙击', CASTER: '术师', SUPPORT: '辅助', MEDIC: '医疗', SPECIAL: '特种' };
const fiveHourText = '进驻训练室单次协助一名干员训练时长达5小时，则该名干员下次训练所需时间-50%（任意一方离开训练室时，效果消失）';
export type TrainingTextContext = { rank: number; role: string | null; branch: string | null; reduction: boolean | null };
export type TrainingTextEffect = { bonus: number; durationFactor: number; pending: 'five-hour-reduction-pending' | 'branch-unverified' | 'condition-unverified' | null };
/**
 * Ticket 32 follow-on OB-6 (recurrence rule): the one reading of a training-room skill text. Parsed forms give an exact
 * bonus for this tier, trainee class and branch; a part the tool cannot verify (the five-hour reduction without its fact, an
 * unknown branch, faction counts, 人间烟火, 武道 and any unparsed text) adds nothing and is returned as pending. Every such
 * extra in the pinned table is a non-negative speed or a time reduction, so the result is a lower bound on the speed and the
 * estimate an upper bound on the duration; the real countdown and completion callback still decide. The conformance test runs
 * every pinned text through it.
 */
export function trainingTextEffect(text: string, context: TrainingTextContext): TrainingTextEffect {
  const none: TrainingTextEffect = { bonus: 0, durationFactor: 1, pending: null };
  if (text === fiveHourText) return context.reduction === null ? { ...none, pending: 'five-hour-reduction-pending' } : { ...none, durationFactor: context.reduction ? 0.5 : 1 };
  if (/^进驻训练室协助(先锋|近卫|重装|狙击|术师|医疗|辅助|特种)干员训练专精技能至[1-3]级时，心情每小时消耗\+1$/.test(text)) return none;
  const rankOnly = /^进驻训练室协助位时，如果本次训练专精技能至([1-3])级，专精技能训练速度\+(\d+)%$/.exec(text);
  if (rankOnly) return { ...none, bonus: context.rank === Number(rankOnly[1]) ? Number(rankOnly[2]) / 100 : 0 };
  const branchExtra = (names: string, percent: string): TrainingTextEffect => context.branch === null ? { ...none, pending: 'branch-unverified' }
    : { ...none, bonus: names.split('或').includes(context.branch) ? Number(percent) / 100 : 0 };
  const branchOnly = /^进驻训练室协助位时，如果训练位干员分支为([^，]+)，则专精技能训练速度额外\+(\d+)%$/.exec(text);
  if (branchOnly) return branchExtra(branchOnly[1]!, branchOnly[2]!);
  const match = /^进驻训练室协助位时，(.*?)干员的专精技能训练速度\+(\d+)%(?:，如果本次训练专精技能至([1-3])级，则训练速度额外\+(\d+)%|，如果训练位干员分支为([^，]+)，则训练速度额外\+(\d+)%)?(?:，心情每小时消耗\+1)?$/.exec(text);
  if (!match) return { ...none, pending: 'condition-unverified' };
  if (match[1] !== '' && !(context.role && match[1]!.split('与').includes(professions[context.role]!))) return none;
  let bonus = Number(match[2]) / 100;
  if (match[3] && context.rank === Number(match[3])) bonus += Number(match[4]) / 100;
  if (!match[5]) return { ...none, bonus };
  const extra = branchExtra(match[5], match[6]!);
  return { ...extra, bonus: bonus + extra.bonus };
}
export type TrainingTables = GapTables & { skillNames: unknown };
/** `speedBonus` is a lower bound (and `estimatedSeconds` an upper bound) when `lowerBound`: an extra is listed as pending in `issues`. */
export type TrainingAssistant = { id: string; name: string; available: boolean | null; speedBonus: number | null; lowerBound: boolean; estimatedSeconds: number | null; conditions: string[]; issues: string[] };
export type TrainingResult = { status: 'ok' | 'needs-input'; operator: { id: string; name: string } | null; skill: number | null; skillId: string | null;
  skillName: string | null; currentRank: number | null; targetRank: number | null; role: string | null; materials: GapResult; issues: string[];
  /** Ticket 32: the user-confirmed rank now in training, the rank costs are counted from (tiers paid in the snapshot excluded), the time its inventory reflects, and the materials of the next tier to start. */
  inTrainingRank: number | null; costFromRank: number | null; inventoryAt: string | null; startMaterials: GapResult | null;
  /** Ticket 32 R3-2: other plans' tiers paid after the inventory time, whose cost was taken out of the stock before the gate. */
  reservedTiers: TierPayment[];
  stages: { rank: number; baseSeconds: number | null; recommendedAssistant: string | null; afterStartAssistant: string | null; estimatedSeconds: number | null; assistants: TrainingAssistant[] }[];
  assumptions: string[] };
/** Ticket 32: a plan's own evidence, passed only by training-plan (never from query JSON): its evidence-backed completed rank and when each rank was paid. */
export type TrainingEvidence = { completedRank: number; paidAt: Record<string, string> };

const rowsOf = (plan: GapPlan) => [...Object.values(plan.materials), plan.lmd, plan.exp];
const covered = (plan: GapPlan) => rowsOf(plan).every(row => row.remaining === 0) && !plan.voucherAllocations.length && plan.route.every(step => step.kind === 'craft');
/**
 * Ticket 32: the one start gate (prepare and refresh share it). `ready`: the tier's finished materials are in stock.
 * `crafting`: only with the user's crafting approval, the shortage is covered by workshop crafting from stock with base
 * materials and LMD (fees included) reserved; MAA's OperProgress crafts missing mastery materials itself (training-sources).
 * MAA never exchanges vouchers, so no route that uses one counts.
 */
/**
 * Ticket 32 R4-1: what a start under this gate takes out of the stock, from the route the gate chose (`ready`: the no-craft
 * plan; `crafting`: the craft plan, inputs consumed by crafting and the fees included). Stored on the plan for that tier and
 * reserved by every later gate whose inventory predates the payment.
 */
export function gateSpend(gaps: GapResult | null, gate: 'ready' | 'crafting'): Spend | null {
  const plan = gate === 'crafting' ? gaps?.comparison?.craft : gaps?.comparison?.noCraft;
  if (!plan || plan.lmd.required === null || !Number.isSafeInteger(plan.lmd.required)) return null;
  const items: Record<string, number> = {};
  // Ticket 32 R6-1: the gross use of every item on the route (taken for the tier plus used by crafting), intermediates the
  // route crafts and uses included. MAA crafts against the stock at the start; whatever it finds there by then it uses instead of
  // crafting, so the gross use bounds what the start can take of each item. A row the route never used (a material voucher
  // whose count no snapshot carries, R5-1) is not a spend.
  for (const [id, row] of Object.entries(plan.ledger)) {
    const used = row.allocated + row.consumed;
    if (!Number.isSafeInteger(used) || used < 0) return null;
    if (used > 0) items[id] = used;
  }
  return { items, lmd: plan.lmd.required };
}
/**
 * Ticket 32 R5-3 (recurrence rule: the one owner of what a payment took out of an inventory read before it). Per item the
 * larger of the tier's finished materials and the route its gate recorded (crafting inputs and fees): the start used the
 * finished materials when the stock had them by then, or crafted them from the inputs otherwise, and either may still be in
 * an inventory read before it. A tier paid outside a gate (by hand in the game, which never crafts) has only its finished cost.
 */
export function paymentTaken(catalog: Record<string, unknown>, payment: TierPayment): Spend | null {
  const row = object(array(object(array(object(catalog[payment.operatorId]).skills)[payment.skill - 1]).levelUpCostCond)[payment.rank - 1]);
  const costs = array(row.levelUpCost).map(object);
  if (!costs.length || costs.some(entry => typeof entry.id !== 'string' || !integer(entry.count, 1, 1e9))) return null;
  const finished: Spend = { items: {}, lmd: 0 };
  for (const entry of costs) if (entry.id === '4001') finished.lmd += Number(entry.count); else finished.items[entry.id as string] = (finished.items[entry.id as string] ?? 0) + Number(entry.count);
  if (payment.spent === undefined) return finished;
  if (!validSpend(payment.spent)) return null;
  const items = { ...finished.items };
  for (const [id, count] of Object.entries(payment.spent.items)) items[id] = Math.max(items[id] ?? 0, count);
  return { items, lmd: Math.max(finished.lmd, payment.spent.lmd) };
}
const validSpend = (spend: unknown): spend is Spend => !!spend && typeof spend === 'object' && integer((spend as Spend).lmd, 0, 1e12)
  && !!(spend as Spend).items && typeof (spend as Spend).items === 'object' && Object.values((spend as Spend).items).every(count => integer(count, 0, 1e12));

export function materialGate(gaps: GapResult | null, crafting: boolean): 'ready' | 'crafting' | 'short' {
  const comparison = gaps?.comparison;
  if (!comparison) return 'short';
  if (covered(comparison.noCraft)) return 'ready';
  return crafting && covered(comparison.craft) ? 'crafting' : 'short';
}

/** Read-only. Missing facts stay unknown; estimates never claim a training has started. */
export function calculateTraining(tables: TrainingTables, snapshotInput: unknown, input: unknown, evidence?: TrainingEvidence, payments: TierPayment[] = []): TrainingResult {
  const request = object(input), snapshot = object(snapshotInput), facts = object(request.facts), current = object(request.current);
  const skill = integer(request.skill, 1, 3) ? request.skill : null, targetRank = integer(request.target, 1, 3) ? request.target : null;
  // Workshop and stage facts for crafting routes; training never spends vouchers, so voucher validity is not passed on.
  const progress = request.progress === undefined ? {} : { progress: request.progress !== null && typeof request.progress === 'object' && !Array.isArray(request.progress)
    ? Object.fromEntries(Object.entries(request.progress).filter(([key]) => key !== 'voucherValidity')) : request.progress };
  /** Shared costs to rank `to`; `from` re-bases this skill's current rank (a tier already paid in the snapshot). */
  const gaps = (to: number | null, from?: number, operatorId?: string) => {
    const key = String(skill);
    let costSnapshot: unknown = stock, costCurrent: ObjectValue = current;
    if (from !== undefined && operatorId) {
      costSnapshot = { ...stock, operators: array(stock.operators).map(row => object(row).id === operatorId && object(object(row).mastery)[key] != null
        ? { ...object(row), mastery: { ...object(object(row).mastery), [key]: from } } : row) };
      if (object(current.mastery)[key] !== undefined) costCurrent = { ...current, mastery: { ...object(current.mastery), [key]: from } };
    }
    return calculateCultivationGaps(tables, costSnapshot, { targets: [{ name: request.name, ...(request.operatorId === undefined ? {} : { operatorId: request.operatorId }),
      current: costCurrent, target: { mastery: { [key]: to } } }], ...progress, mode: 'no-craft' });
  };
  let stock: ObjectValue = snapshot;
  const materials = gaps(targetRank);
  const cost = materials.costs[0];
  const result: TrainingResult = { status: 'needs-input', operator: cost?.operator ?? null, skill, skillId: null, skillName: null,
    currentRank: null, targetRank, role: null, materials, issues: [...materials.issues, ...cost?.issues ?? []],
    inTrainingRank: null, costFromRank: null, inventoryAt: null, startMaterials: null, reservedTiers: [], stages: [],
    assumptions: ['Estimated duration = base seconds / (1 + assistant base bonus + applicable skill bonuses). This is a table/text inference, not live timing.',
      'Actual countdown and completion evidence supersede estimates; active skills do not prove assignment or condition activation.'] };
  const sharedIssues = result.issues.length;
  if (Object.keys(request).some(key => !['name', 'operatorId', 'skill', 'target', 'current', 'facts', 'inTraining', 'progress'].includes(key))) result.issues.push('training:unsupported-field');
  if (skill === null || targetRank === null || !cost?.operator || !cost.total) return result;
  const operator = array(snapshot.operators).map(object).find(row => row.id === cost.operator!.id)!;
  const observed = object(operator.mastery)[String(skill)] ?? object(current.mastery)[String(skill)];
  if (!integer(observed, 0, 3)) { result.issues.push('training:current-rank-unknown'); return result; }
  // Ticket 32 R1-1: the time the inventory reflects. Skland reads the live account, so its read time; an MAA import's read
  // time is only the import, its depot scan time is `sourceTimes.inventory`, and without one the inventory time is unknown.
  const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  const inventoryAt = snapshot.source === 'skland' ? time(snapshot.readAt) : snapshot.source === 'maa' ? time(object(snapshot.sourceTimes).inventory) : null;
  result.inventoryAt = inventoryAt;
  // A plan's real completion evidence outranks an older snapshot; a snapshot ahead of it stays as read (the caller stops on the mismatch).
  const start = evidence && integer(evidence.completedRank, 0, 3) && evidence.completedRank > observed ? evidence.completedRank : observed;
  result.currentRank = start;
  // The user confirms the next rank is training now and its materials were already taken from the inventory this snapshot reflects.
  if (request.inTraining !== undefined) {
    const fact = object(request.inTraining);
    if (evidence || Object.keys(fact).some(key => !['source', 'rank'].includes(key)) || fact.source !== 'user-confirmed' || fact.rank !== start + 1 || start + 1 > targetRank)
      result.issues.push('training:in-training-invalid');
    else if (!inventoryAt) result.issues.push('training:in-training-inventory-time-unknown');
    else result.inTrainingRank = start + 1;
  }
  // A tier paid at or before the inventory time is already gone from it and is not counted again. A tier this plan paid
  // after it, or when the inventory time is unknown, still has its materials in it and is counted, whatever rank was stated.
  const paidBefore = (at: unknown) => inventoryAt !== null && time(at) !== null && Date.parse(at as string) <= Date.parse(inventoryAt);
  const paid: Record<string, string> = { ...evidence?.paidAt ?? {}, ...(result.inTrainingRank !== null ? { [String(result.inTrainingRank)]: inventoryAt! } : {}) };
  // Ticket 32 R5-2: costs start at the completed rank (or the tier in training), so a gate covers exactly the tier it opens and
  // records exactly that tier's spend. A tier paid at or before the inventory time is already out of it; one paid after it, by
  // this plan or another (an unknown inventory time included), is still in it and is reserved below, by the one owner.
  let costFrom = start;
  for (const [rank, at] of Object.entries(paid)) {
    const value = Number(rank);
    if (integer(value, 1, 3) && value > costFrom && value <= targetRank && paidBefore(at)) costFrom = value;
  }
  result.costFromRank = costFrom;
  const latest = new Map<string, TierPayment>();
  for (const payment of payments) {
    if (!integer(payment.rank, 1, 3) || !integer(payment.skill, 1, 3) || typeof payment.operatorId !== 'string' || paidBefore(payment.at)) continue;
    if (payment.operatorId === cost.operator.id && payment.skill === skill && payment.rank > costFrom) continue;
    const key = `${payment.operatorId}:${payment.skill}:${payment.rank}`, known = latest.get(key);
    if (!known || (time(payment.at) ?? '') > (time(known.at) ?? '')) latest.set(key, payment);
  }
  result.reservedTiers = [...latest.values()];
  if (result.reservedTiers.length) {
    const tiers = operatorCatalog(tables), items: Record<string, number> = {}; let lmd = 0;
    for (const payment of result.reservedTiers) {
      const taken = paymentTaken(tiers, payment);
      if (!taken) { result.issues.push('training:reserved-cost-unknown'); continue; }
      for (const [id, count] of Object.entries(taken.items)) items[id] = (items[id] ?? 0) + count;
      lmd += taken.lmd;
    }
    const held = object(snapshot.items);
    stock = { ...snapshot, items: Object.fromEntries(Object.entries(held).map(([id, count]) => [id, typeof count === 'number' && items[id] ? Math.max(0, count - items[id]!) : count])),
      lmd: typeof snapshot.lmd === 'number' ? Math.max(0, snapshot.lmd - lmd) : snapshot.lmd };
  }
  if (costFrom !== observed || result.reservedTiers.length) {
    result.materials = gaps(targetRank, costFrom, cost.operator.id);
    result.issues.splice(0, sharedIssues, ...result.materials.issues, ...result.materials.costs[0]?.issues ?? []);
  }
  const firstStart = (result.inTrainingRank ?? start) + 1;
  if (firstStart <= targetRank && costFrom < firstStart) result.startMaterials = firstStart === targetRank ? result.materials : gaps(firstStart, costFrom, cost.operator.id);
  const catalog = operatorCatalog(tables), char = object(catalog[cost.operator.id]);
  const selectedSkill = object(array(char.skills)[skill - 1]);
  result.skillId = typeof selectedSkill.skillId === 'string' ? selectedSkill.skillId : null;
  const name = object(array(object(object(tables.skillNames)[String(result.skillId)]).levels)[0]).name;
  result.skillName = typeof name === 'string' && name.trim() ? name : null;
  result.role = typeof char.profession === 'string' && Object.hasOwn(professions, char.profession) ? char.profession : null;
  if (!result.skillName || !result.role) result.issues.push('training:target-identity-incomplete');
  if (facts.source !== 'user-confirmed' || !integer(facts.trainingRoomLevel, 1, 3)) result.issues.push('training:room-unverified');
  const trainingData = object(object(tables.building).trainingData);
  const roomLimit = object(array(trainingData.phases)[Number(facts.trainingRoomLevel) - 1]).specSkillLvlLimit;
  if (!integer(roomLimit, 1, 3) || roomLimit < targetRank) result.issues.push('training:room-rank-unavailable');
  const base = trainingData.basicSpeedBuff;
  const baseBonus = typeof base === 'number' && Number.isFinite(base) && base >= 0 && base <= 1 ? base : null;
  const available = facts.source === 'user-confirmed' && Array.isArray(facts.availableAssistants) && facts.availableAssistants.every(id => typeof id === 'string') ? facts.availableAssistants : null;
  const helpers = queryBaseSkills(snapshot, { ...tables, characters: catalog }, {});
  // Ticket 32 follow-on OB-5: the trainee's branch is an immutable fact of the pinned tables (character subProfessionId →
  // uniequip subProfDict name), never a user fact; without the table the branch extra stays pending.
  const branchName = object(object(object(tables.modules).subProfDict)[String(char.subProfessionId)]).subProfessionName;
  const branch = typeof branchName === 'string' && branchName.trim() ? branchName : null;
  const sourceWarnings = new Set(helpers.warnings);
  for (let rank = start + 1; rank <= targetRank; rank++) {
    const seconds = object(array(selectedSkill.levelUpCostCond)[rank - 1]).lvlUpTime;
    const baseSeconds = integer(seconds, 1, 31 * 86400) ? seconds : null;
    const assistants: TrainingAssistant[] = [];
    for (const helper of helpers.operators.filter(row => row.id !== cost.operator!.id)) {
      const trainingSkills = helper.skills.filter(row => row.room === 'TRAINING');
      const active = trainingSkills.filter(row => row.status === 'active');
      const issues: string[] = [];
      let bonus = baseBonus ?? 0, durationFactor = 1;
      if (baseBonus === null) issues.push('assistant:base-speed-unknown');
      if (sourceWarnings.has(`game-operator-incomplete:${helper.id}`) || helper.skills.some(row => sourceWarnings.has(`game-skill-incomplete:${row.id}`)
        || !isBaseRoom(row.room) || !row.name.trim() || !row.text.trim())) issues.push('assistant:source-incomplete');
      if (helper.ownership !== 'owned' || trainingSkills.some(row => row.status === 'unknown')) issues.push('assistant:skill-or-ownership-unknown');
      // Ticket 32: an unknown five-hour fact (any tier after the next, or no confirmed prior assistance) estimates without the
      // reduction and keeps it pending; real countdowns supersede the estimate. It never disqualifies the assistant.
      const prior = object(facts.previousAssistance);
      const reduction = rank !== start + 1 || facts.source !== 'user-confirmed' || !integer(prior.seconds, 0, 31 * 86400) || typeof prior.remainedTogether !== 'boolean'
        || typeof prior.assistantId !== 'string' || typeof prior.traineeId !== 'string' ? null
        : prior.seconds >= 18000 && prior.remainedTogether && prior.assistantId === helper.id && prior.traineeId === cost.operator!.id;
      for (const item of active) {
        const effect = trainingTextEffect(item.text, { rank, role: result.role, branch, reduction });
        bonus += effect.bonus; durationFactor *= effect.durationFactor;
        if (effect.pending) issues.push(`assistant:${effect.pending}:${item.id}`);
      }
      const isAvailable = available === null ? null : available.includes(helper.id);
      if (isAvailable !== true) issues.push(isAvailable === false ? 'assistant:unavailable' : 'assistant:availability-unverified');
      const speedBonus = issues.some(issue => !estimateKeepingIssue(issue)) ? null : Math.round(bonus * 1e6) / 1e6;
      assistants.push({ id: helper.id, name: helper.name, available: isAvailable, speedBonus, lowerBound: speedBonus !== null && issues.some(lowerBoundIssue),
        estimatedSeconds: baseSeconds !== null && speedBonus !== null ? Math.ceil(baseSeconds * durationFactor / (1 + speedBonus)) : null,
        conditions: active.map(item => item.text), issues });
    }
    const best = assistants.filter(row => row.available === true && row.estimatedSeconds !== null).sort((a, b) => a.estimatedSeconds! - b.estimatedSeconds! || a.id.localeCompare(b.id))[0];
    const after = assistants.filter(row => row.available === true && row.speedBonus !== null).sort((a, b) => b.speedBonus! - a.speedBonus! || a.id.localeCompare(b.id))[0];
    result.stages.push({ rank, baseSeconds, recommendedAssistant: best?.id ?? null, afterStartAssistant: after?.id ?? null, estimatedSeconds: best?.estimatedSeconds ?? null, assistants });
    if (!baseSeconds || !best) result.issues.push(`training:stage-${rank}-pending`);
  }
  if (!result.issues.length) result.status = 'ok';
  return result;
}

export const trainingSources: Record<string, PublicJsonSource> = { ...craftingSources, skillNames: { ...operatorCostSources.characters!, file: 'zh_CN/gamedata/excel/skill_table.json' } };
/** tablesFile is explicitly unverified offline input; public mode records actual fixed-source hashes. */
export async function queryTraining(input: unknown, options: { home?: string; fetcher?: typeof fetch; evidence?: TrainingEvidence; payments?: TierPayment[] } = {}) {
  const request = object(input), settings = await readSettings(options.home);
  // Ticket 32: read failures carry static codes (never a path) so the CLI can say what to check.
  let snapshot: unknown;
  try { snapshot = JSON.parse(await readFile(typeof request.snapshotFile === 'string' ? request.snapshotFile : join(settings.privateDirectory, 'account-snapshot.json'), 'utf8')); }
  catch { throw new Error('training-snapshot-unreadable'); }
  let tables: TrainingTables;
  if (typeof request.tablesFile === 'string') { try { tables = JSON.parse(await readFile(request.tablesFile, 'utf8')); } catch { throw new Error('training-tables-unreadable'); } }
  else {
    const [costs, building, stages, skillNames] = await Promise.all([loadOperatorCostTables(options.fetcher),
      readPublicJson(trainingSources.building!, options.fetcher), readPublicJson(trainingSources.stages!, options.fetcher), readPublicJson(trainingSources.skillNames!, options.fetcher)])
      .catch(() => { throw new Error('training-tables-unavailable'); });
    tables = { ...costs, building: building.value, stages: stages.value, skillNames: skillNames.value,
      sources: [...costs.sources ?? [], building.source, stages.source, skillNames.source] };
  }
  const { tablesFile: _tables, snapshotFile: _snapshot, format: _format, ...body } = request;
  const result = calculateTraining(tables, snapshot, body, options.evidence, options.payments);
  return { result, language: settings.language ?? 'zh-CN', source: request.tablesFile ? 'supplied-unverified' : 'fixed-public', sources: request.tablesFile ? [] : tables.sources ?? [] };
}

export function formatTraining(result: TrainingResult, language = 'zh-CN'): string {
  const en = language.toLowerCase().startsWith('en');
  const lines = [en ? '# Training estimate' : '# 训练估算', '', `${result.operator?.name ?? '?'} / S${result.skill ?? '?'} / M${result.currentRank ?? '?'} → M${result.targetRank ?? '?'}`, '',
    en ? 'Estimates are not start or completion evidence. Confirm conditions and use actual countdowns.' : '估算不是开训或完成证据；核对条件，以实际倒计时修正。', '',
    en ? '| Rank | Assistant | Seconds (estimate) |' : '| 档次 | 助手 | 秒数（估算） |', '| --- | --- | --- |'];
  for (const stage of result.stages) {
    lines.push(`| M${stage.rank} | ${stage.recommendedAssistant ?? '?'} | ${stage.estimatedSeconds ?? '?'} |`);
    lines.push(`${en ? 'After verified start, attempt assistant' : '核实开训后尝试换助手'}: ${stage.afterStartAssistant ?? '?'}; ${en ? 'assignment and retained reduction remain unverified' : '实际就位及减时保留效果待核'}。`);
    for (const helper of stage.assistants) lines.push(`- ${helper.name}: ${helper.speedBonus === null ? '?' : `${helper.lowerBound ? '≥' : ''}${Math.round(helper.speedBonus * 10000) / 100}%`} / ${helper.estimatedSeconds ?? '?'}s; ${helper.conditions.join('；')}; ${helper.issues.join(', ')}`);
  }
  // Ticket 32 R4-2: the other plans' tiers taken out of this stock, and how the user can lift it.
  if (result.reservedTiers.length) lines.push('', en ? `Tiers already paid after this inventory was read (by this plan or another) are taken out of it: ${result.reservedTiers.map(row => `${row.operatorId} S${row.skill} M${row.rank} (${row.at})`).join(', ')}. A newer inventory read stops this.`
    : `在这份库存读取之后已经付过料的档次（本计划或别的计划）已从库存里扣掉：${result.reservedTiers.map(row => `${row.operatorId} S${row.skill} M${row.rank}（${row.at}）`).join('、')}；重新读取库存（扫描时间晚于这些付料）后就不再扣。`);
  if (result.inTrainingRank !== null) lines.push('', en ? `M${result.inTrainingRank} is in training (user-confirmed); its materials are already paid and not counted again.`
    : `M${result.inTrainingRank} 正在训练（用户确认），材料已付，不再计入。`);
  lines.push('', `${en ? 'Pending facts' : '待核'}: ${result.issues.join(', ') || '-'}`, `${en ? 'Material issues' : '材料待核'}: ${result.materials.issues.join(', ') || '-'}`);
  // Ticket 32 R2-4: what the next start still lacks, down to base materials and the LMD gap (the start gate's tier).
  const gate = result.startMaterials ?? result.materials, decomposition = gate.comparison?.craft.decomposition, noCraft = gate.comparison?.noCraft;
  const missing = noCraft ? Object.entries(noCraft.materials).filter(([, row]) => row.remaining !== 0).map(([id, row]) => `${id} × ${row.remaining ?? '?'}`) : [];
  if (noCraft && noCraft.lmd.remaining !== 0) missing.push(`${en ? 'LMD' : '龙门币'} × ${noCraft.lmd.remaining ?? '?'}`);
  const tier = result.currentRank === null ? null : (result.inTrainingRank ?? result.currentRank) + 1;
  if (missing.length) {
    lines.push('', `${en ? 'The next start' : '下一次开训'}${tier === null ? '' : `（M${tier}）`}${en ? ' still lacks' : '还缺'}: ${missing.join(en ? ', ' : '、')}`);
    if (materialGate(gate, true) === 'crafting') lines.push(en ? 'Crafting from current stock covers it; MAA crafts it at the start only with the user\'s own crafting approval.'
      : '按现有库存加工可以补齐；只有用户亲口批准加工，开训时才让 MAA 自动合成。');
  }
  if (decomposition &&(Object.keys(decomposition.short).length || decomposition.steps.length || decomposition.pending.length || (decomposition.lmdGap ?? 1) > 0))
    lines.push('', ...formatDecomposition(decomposition, gate.stageCodes));
  return lines.join('\n');
}

const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'query') throw new Error('training-action-invalid');
    const request = object(await readStdinJson({ maxBytes: 1024 * 1024 }));
    if (request.format !== undefined && !['json', 'markdown'].includes(String(request.format))) throw new Error('training-request-invalid');
    const output = await queryTraining(request), summary = formatTraining(output.result, output.language);
    console.log(request.format === 'markdown' ? summary : JSON.stringify({ ok: true, ...output, summary }));
  } catch (error) {
    // Ticket 32: standard-input rejections keep their own code; everything else names its reason, what to check and the alternatives.
    const stdin = stdinJsonCode(error);
    console.error(JSON.stringify(stdin ? { ok: false, error: stdin } : trainingCheckRequired(staticCode(error) ?? 'training-unclassified-failure')));
    process.exitCode = 1;
  }
}
