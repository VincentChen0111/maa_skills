// Independent calculations from fixed table fields and complete skill descriptions; see training-sources.md.
import { queryBaseSkills } from './base-query.ts';
import { calculateCultivationGaps, type GapTables, type GapResult } from './cultivation-gaps.ts';
import { loadOperatorCostTables, operatorCostSources } from './operator-cost.ts';
import { craftingSources } from './cultivation-gaps.ts';
import { readPublicJson, type PublicJsonSource } from './public-data.ts';
import { readSettings } from './preferences.ts';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const professions: Record<string, string> = { PIONEER: '先锋', WARRIOR: '近卫', TANK: '重装', SNIPER: '狙击', CASTER: '术师', SUPPORT: '辅助', MEDIC: '医疗', SPECIAL: '特种' };
export type TrainingTables = GapTables & { skillNames: unknown };
export type TrainingAssistant = { id: string; name: string; available: boolean | null; speedBonus: number | null; estimatedSeconds: number | null; conditions: string[]; issues: string[] };
export type TrainingResult = { status: 'ok' | 'needs-input'; operator: { id: string; name: string } | null; skill: number | null; skillId: string | null;
  skillName: string | null; currentRank: number | null; targetRank: number | null; role: string | null; materials: GapResult; issues: string[];
  stages: { rank: number; baseSeconds: number | null; recommendedAssistant: string | null; afterStartAssistant: string | null; estimatedSeconds: number | null; assistants: TrainingAssistant[] }[];
  assumptions: string[] };

/** Read-only. Missing facts stay unknown; estimates never claim a training has started. */
export function calculateTraining(tables: TrainingTables, snapshotInput: unknown, input: unknown): TrainingResult {
  const request = object(input), snapshot = object(snapshotInput), facts = object(request.facts), current = object(request.current);
  const skill = integer(request.skill, 1, 3) ? request.skill : null, targetRank = integer(request.target, 1, 3) ? request.target : null;
  const costTarget = { name: request.name, ...(request.operatorId === undefined ? {} : { operatorId: request.operatorId }), current,
    target: { mastery: { [String(skill)]: targetRank } } };
  const materials = calculateCultivationGaps(tables, snapshot, { targets: [costTarget], mode: 'no-craft' });
  const cost = materials.costs[0];
  const result: TrainingResult = { status: 'needs-input', operator: cost?.operator ?? null, skill, skillId: null, skillName: null,
    currentRank: null, targetRank, role: null, materials, issues: [...materials.issues, ...cost?.issues ?? []], stages: [],
    assumptions: ['Estimated duration = base seconds / (1 + assistant base bonus + applicable skill bonuses). This is a table/text inference, not live timing.',
      'Actual countdown and completion evidence supersede estimates; active skills do not prove assignment or condition activation.'] };
  if (Object.keys(request).some(key => !['name', 'operatorId', 'skill', 'target', 'current', 'facts'].includes(key))) result.issues.push('training:unsupported-field');
  if (skill === null || targetRank === null || !cost?.operator || !cost.total) return result;
  const operator = array(snapshot.operators).map(object).find(row => row.id === cost.operator!.id)!;
  const start = object(operator.mastery)[String(skill)] ?? object(current.mastery)[String(skill)];
  if (!integer(start, 0, 3)) { result.issues.push('training:current-rank-unknown'); return result; }
  result.currentRank = start;
  const char = object(object(tables.characters)[cost.operator.id]);
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
  const helpers = queryBaseSkills(snapshot, tables, { room: 'TRAINING' });
  for (let rank = start + 1; rank <= targetRank; rank++) {
    const seconds = object(array(selectedSkill.levelUpCostCond)[rank - 1]).lvlUpTime;
    const baseSeconds = integer(seconds, 1, 31 * 86400) ? seconds : null;
    const assistants: TrainingAssistant[] = [];
    for (const helper of helpers.operators.filter(row => row.id !== cost.operator!.id)) {
      const active = helper.skills.filter(row => row.status === 'active');
      const issues: string[] = [];
      let bonus = baseBonus ?? 0, durationFactor = 1;
      if (baseBonus === null) issues.push('assistant:base-speed-unknown');
      if (helper.ownership !== 'owned' || helper.skills.some(row => row.status === 'unknown')) issues.push('assistant:skill-or-ownership-unknown');
      for (const item of active) {
        if (item.text === '进驻训练室单次协助一名干员训练时长达5小时，则该名干员下次训练所需时间-50%（任意一方离开训练室时，效果消失）') {
          const prior = object(facts.previousAssistance);
          if (rank !== start + 1 || facts.source !== 'user-confirmed' || !integer(prior.seconds, 0, 31 * 86400) || typeof prior.remainedTogether !== 'boolean'
            || typeof prior.assistantId !== 'string' || typeof prior.traineeId !== 'string') issues.push(`assistant:prior-assistance-unverified:${item.id}`);
          else if (prior.seconds >= 18000 && prior.remainedTogether && prior.assistantId === helper.id && prior.traineeId === cost.operator!.id) durationFactor = 0.5;
          continue;
        }
        if (/^进驻训练室协助(先锋|近卫|重装|狙击|术师|医疗|辅助|特种)干员训练专精技能至[1-3]级时，心情每小时消耗\+1$/.test(item.text)) continue;
        const rankOnly = /^进驻训练室协助位时，如果本次训练专精技能至([1-3])级，专精技能训练速度\+(\d+)%$/.exec(item.text);
        if (rankOnly) { if (rank === Number(rankOnly[1])) bonus += Number(rankOnly[2]) / 100; continue; }
        const match = /^进驻训练室协助位时，(.*?)干员的专精技能训练速度\+(\d+)%(?:，如果本次训练专精技能至([1-3])级，则训练速度额外\+(\d+)%|，如果训练位干员分支为([^，]+)，则训练速度额外\+(\d+)%)?(?:，心情每小时消耗\+1)?$/.exec(item.text);
        if (!match) { issues.push(`assistant:condition-unverified:${item.id}`); continue; }
        const classes = match[1]!.split('与');
        if (match[1] === '' || result.role && classes.includes(professions[result.role]!)) {
          bonus += Number(match[2]) / 100;
          if (match[3] && rank === Number(match[3])) bonus += Number(match[4]) / 100;
          if (match[5]) {
            if (typeof facts.branchName !== 'string' || facts.source !== 'user-confirmed') issues.push(`assistant:branch-unverified:${item.id}`);
            else if (match[5] === facts.branchName) bonus += Number(match[6]) / 100;
          }
        }
      }
      const isAvailable = available === null ? null : available.includes(helper.id);
      if (isAvailable !== true) issues.push(isAvailable === false ? 'assistant:unavailable' : 'assistant:availability-unverified');
      const speedBonus = issues.some(issue => issue !== 'assistant:unavailable' && issue !== 'assistant:availability-unverified') ? null : Math.round(bonus * 1e6) / 1e6;
      assistants.push({ id: helper.id, name: helper.name, available: isAvailable, speedBonus,
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
export async function queryTraining(input: unknown, options: { home?: string; fetcher?: typeof fetch } = {}) {
  const request = object(input), settings = await readSettings(options.home);
  const snapshot = JSON.parse(await readFile(typeof request.snapshotFile === 'string' ? request.snapshotFile : join(settings.privateDirectory, 'account-snapshot.json'), 'utf8'));
  let tables: TrainingTables;
  if (typeof request.tablesFile === 'string') tables = JSON.parse(await readFile(request.tablesFile, 'utf8'));
  else {
    const [costs, building, stages, skillNames] = await Promise.all([loadOperatorCostTables(options.fetcher),
      readPublicJson(trainingSources.building!, options.fetcher), readPublicJson(trainingSources.stages!, options.fetcher), readPublicJson(trainingSources.skillNames!, options.fetcher)]);
    tables = { ...costs, building: building.value, stages: stages.value, skillNames: skillNames.value,
      sources: [...costs.sources ?? [], building.source, stages.source, skillNames.source] };
  }
  const { tablesFile: _tables, snapshotFile: _snapshot, format: _format, ...body } = request;
  const result = calculateTraining(tables, snapshot, body);
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
    for (const helper of stage.assistants) lines.push(`- ${helper.name}: ${helper.speedBonus === null ? '?' : `${Math.round(helper.speedBonus * 10000) / 100}%`} / ${helper.estimatedSeconds ?? '?'}s; ${helper.conditions.join('；')}; ${helper.issues.join(', ')}`);
  }
  lines.push('', `${en ? 'Pending facts' : '待核'}: ${result.issues.join(', ') || '-'}`, `${en ? 'Material issues' : '材料待核'}: ${result.materials.issues.join(', ') || '-'}`);
  return lines.join('\n');
}

const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'query') throw new Error();
    let text = ''; for await (const chunk of process.stdin) { text += String(chunk); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error(); }
    const request = object(JSON.parse(text));
    if (request.format !== undefined && !['json', 'markdown'].includes(String(request.format))) throw new Error();
    const output = await queryTraining(request), summary = formatTraining(output.result, output.language);
    console.log(request.format === 'markdown' ? summary : JSON.stringify({ ok: true, ...output, summary }));
  } catch { console.error(JSON.stringify({ ok: false, error: 'training-query-failed' })); process.exitCode = 1; }
}
