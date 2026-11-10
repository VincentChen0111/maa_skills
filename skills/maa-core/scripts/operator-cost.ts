// Independent implementation of the maintainer-provided generic cost algorithms.
// Algorithm file hashes and pinned public schema revisions: docs/operator-cost-sources.md.
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicJson, type PublicJsonResult, type PublicJsonSource } from './public-data.ts';
import { readSettings } from './preferences.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const phase = (value: unknown): number | null => typeof value === 'string' && /^PHASE_[012]$/.test(value) ? Number(value.slice(-1)) : null;
type Cost = { materials: Record<string, number>; lmd: number; exp: number };
type Step = { kind: 'level' | 'promotion' | 'skill' | 'mastery' | 'module'; from: string; to: string; cost: Cost };
type Stock = { required: number; available: number | null; deficit: number | null };
export type CostTables = { characters: unknown; patches: unknown; constants: unknown; items: unknown; modules: unknown; crossCultivate?: unknown; crossLevel?: unknown; sources?: PublicJsonResult['source'][] };
export type CostResult = {
  status: 'ok' | 'needs-input'; operator: { id: string; name: string } | null; candidates: { id: string; name: string }[];
  mode: 'raw' | 'no-craft'; issues: string[]; uncertainties: string[]; currentSources: Record<string, 'snapshot' | 'user-confirmed'>;
  itemNames: Record<string, string>;
  steps: Step[]; total: Cost | null; inventory: { materials: Record<string, Stock>; lmd: Stock; exp: Stock } | null;
  snapshot: { readAt: string | null; sourceTimes: unknown; coverage: unknown }; sources: PublicJsonResult['source'][];
  crossCheck: { status: 'matched' | 'different' | 'unavailable'; differences: { step: string; primary: unknown; secondary: unknown }[] };
};
const emptyCost = (): Cost => ({ materials: {}, lmd: 0, exp: 0 });
const mainRepository = 'Kengxxiao/ArknightsGameData';
const mainCommit = '6f63c14e27b847ef74b53b00fe51fc322b3cd7ff';
const crossRepository = 'arkntools/arknights-toolbox-data';
const crossCommit = 'a07b4255b43a7171e519b26a13ddb12668a2cf0a';
export const operatorCostSources: Record<string, PublicJsonSource> = {
  characters: { repository: mainRepository, commit: mainCommit, file: 'zh_CN/gamedata/excel/character_table.json' },
  patches: { repository: mainRepository, commit: mainCommit, file: 'zh_CN/gamedata/excel/char_patch_table.json' },
  constants: { repository: mainRepository, commit: mainCommit, file: 'zh_CN/gamedata/excel/gamedata_const.json' },
  items: { repository: mainRepository, commit: mainCommit, file: 'zh_CN/gamedata/excel/item_table.json' },
  modules: { repository: mainRepository, commit: mainCommit, file: 'zh_CN/gamedata/excel/uniequip_table.json' },
  crossCultivate: { repository: crossRepository, commit: crossCommit, file: 'assets/data/cultivate.json' },
  crossLevel: { repository: crossRepository, commit: crossCommit, file: 'assets/data/level.json' },
};

/** Public tables are read at pinned revisions. Secondary failure never fills a primary fact. */
export async function loadOperatorCostTables(fetcher: typeof fetch = fetch): Promise<CostTables> {
  const values: ObjectValue = {}; const sources: PublicJsonResult['source'][] = [];
  await Promise.all(Object.entries(operatorCostSources).map(async ([key, source]) => {
    try { const result = await readPublicJson(source, fetcher); values[key] = result.value; sources.push(result.source); }
    catch { if (!key.startsWith('cross')) throw new Error(`cost-source-unavailable:${key}`); }
  }));
  return { characters: values.characters, patches: values.patches, constants: values.constants, items: values.items, modules: values.modules,
    crossCultivate: values.crossCultivate, crossLevel: values.crossLevel, sources: sources.sort((a, b) => a.file.localeCompare(b.file)) };
}

/** The same calculation serves CLI and consumers. Unknowns are never starting-level defaults. */
export function calculateOperatorCost(tables: CostTables, snapshotInput: unknown, requestInput: unknown): CostResult {
  const request = object(requestInput), snapshot = object(snapshotInput), target = object(request.target), supplied = object(request.current);
  const coverage = object(snapshot.coverage);
  const utc = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
  const statuses = ['complete', 'partial', 'pending', 'missing', 'invalid', 'unavailable'];
  const result: CostResult = { status: 'needs-input', operator: null, candidates: [], mode: request.mode === 'no-craft' ? 'no-craft' : 'raw',
    issues: [], uncertainties: [], currentSources: {}, itemNames: {}, steps: [], total: null, inventory: null,
    snapshot: { readAt: utc(snapshot.readAt), sourceTimes: { operators: utc(object(snapshot.sourceTimes).operators), inventory: utc(object(snapshot.sourceTimes).inventory) },
      coverage: Object.fromEntries(['operators', 'inventory', 'base'].map(key => [key, { status: statuses.includes(String(object(coverage[key]).status)) ? object(coverage[key]).status : 'unknown' }])) },
    sources: tables.sources ?? [], crossCheck: { status: 'matched', differences: [] } };
  const issue = (code: string) => { if (!result.issues.includes(code)) result.issues.push(code); };
  const unknownKeys = (value: ObjectValue, allowed: string[], prefix: string) => { for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(`${prefix}:unsupported-field`); };
  unknownKeys(request, ['name', 'operatorId', 'target', 'current', 'mode', 'snapshotFile', 'format'], 'request');
  unknownKeys(target, ['elite', 'level', 'skillLevel', 'mastery', 'modules'], 'target');
  unknownKeys(supplied, ['source', 'elite', 'level', 'skillLevel', 'mastery', 'modules'], 'current');
  if (request.mode !== undefined && !['raw', 'no-craft'].includes(String(request.mode))) issue('mode:invalid');
  if (!Object.keys(target).length) issue('target:missing');
  if (Object.keys(supplied).length && supplied.source !== 'user-confirmed') issue('current:confirmation-required');
  if (snapshot.version !== 1 || snapshot.source !== 'maa' || !Array.isArray(snapshot.operators) || !['complete', 'partial'].includes(String(object(coverage.operators).status))) issue('snapshot:invalid-or-incomplete');
  const catalog = { ...object(tables.characters), ...object(object(tables.patches).patchChars) };
  const matches = Object.entries(catalog).filter(([id, value]) => {
    const char = object(value); return char.isNotObtainable !== true && char.name === request.name && (request.operatorId === undefined || id === request.operatorId);
  });
  result.candidates = matches.map(([id, char]) => ({ id, name: String(object(char).name) }));
  if (typeof request.name !== 'string' || !request.name.trim() || matches.length !== 1) { issue(matches.length > 1 ? 'operator:ambiguous' : 'operator:not-found'); return result; }
  const [id, value] = matches[0]!; const char = object(value); result.operator = { id, name: String(char.name) };
  const owned = array(snapshot.operators).map(object).filter(op => op.id === id);
  if (owned.length !== 1) { issue('current:operator-not-uniquely-recognized'); return result; }
  const op = owned[0]!;
  // Check all supplied facts, even if not needed by this query. A conflict is never silently ignored.
  for (const key of ['elite', 'level', 'skillLevel', 'mastery', 'modules']) {
    if (supplied[key] === undefined) continue;
    if (['mastery', 'modules'].includes(key)) {
      if (supplied[key] === null || typeof supplied[key] !== 'object' || Array.isArray(supplied[key])) issue(`current.${key}:invalid`);
      for (const [part, current] of Object.entries(object(supplied[key]))) {
        const known = object(op[key])[part];
        if (!integer(current, 0, 3)) issue(`current.${key}.${part}:invalid`);
        if (known != null && known !== current) issue(`current.${key}.${part}:conflict`);
      }
    } else {
      if (!integer(supplied[key], key === 'elite' ? 0 : 1, key === 'elite' ? 2 : key === 'skillLevel' ? 7 : 100)) issue(`current.${key}:invalid`);
      if (op[key] != null && op[key] !== supplied[key]) issue(`current.${key}:conflict`);
    }
  }
  const current = (key: string, min: number, max: number, part?: string): number | null => {
    const label = part ? `${key}.${part}` : key;
    const observed = part ? object(op[key])[part] : op[key]; const supplement = part ? object(supplied[key])[part] : supplied[key];
    const found = observed ?? (supplied.source === 'user-confirmed' ? supplement : undefined);
    if (!integer(found, min, max)) { issue(`current.${label}:unknown-or-invalid`); return null; }
    result.currentSources[label] = observed != null ? 'snapshot' : 'user-confirmed'; return found;
  };
  const elite = current('elite', 0, 2), level = current('level', 1, 100);
  const phases = array(char.phases).map(object), constants = object(tables.constants);
  if (elite !== null && level !== null && (!integer(phases[elite]?.maxLevel, 1, 100) || level > Number(phases[elite]?.maxLevel))) issue('current.level:above-cap');
  let finalElite = elite, finalLevel = level;
  const normalizeCosts = (input: unknown, label: string): Cost | null => {
    if (!Array.isArray(input)) { issue(`${label}:cost-unavailable`); return null; }
    const cost = emptyCost();
    for (const row of input) {
      const item = object(row);
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9_]+$/.test(item.id) || ['__proto__', 'constructor', 'prototype'].includes(item.id) || !integer(item.count)) { issue(`${label}:cost-invalid`); return null; }
      const name = object(object(object(tables.items).items)[item.id]).name;
      if (typeof name === 'string') result.itemNames[item.id] = name;
      if (item.id === '4001') cost.lmd += item.count; else cost.materials[item.id] = (cost.materials[item.id] ?? 0) + item.count;
    }
    return cost;
  };
  const crossChar = object(object(tables.crossCultivate)[id.replace(/^char_/, '')]);
  const compare = (label: string, primary: unknown, secondary: unknown) => {
    if (secondary == null) { result.crossCheck.status = result.crossCheck.status === 'different' ? 'different' : 'unavailable'; result.uncertainties.push(`cross-check-unavailable:${label}`); return; }
    const stable = (value: unknown): string => JSON.stringify(typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    if (stable(primary) !== stable(secondary)) { result.crossCheck.status = 'different'; result.crossCheck.differences.push({ step: label, primary, secondary }); }
  };
  const add = (kind: Step['kind'], from: string, to: string, cost: Cost | null, secondary?: unknown) => {
    if (!cost) return;
    if (![cost.lmd, cost.exp, ...Object.values(cost.materials)].every(n => integer(n))) { issue(`${to}:cost-overflow`); return; }
    result.steps.push({ kind, from, to, cost });
    if (kind !== 'level') compare(to, { ...cost.materials, ...(cost.lmd ? { '4001': cost.lmd } : {}) }, secondary);
  };
  const levelUp = (e: number, start: number, end: number) => {
    for (let l = start; l < end; l++) {
      const exp = array(array(constants.characterExpMap)[e])[l - 1], lmd = array(array(constants.characterUpgradeCostMap)[e])[l - 1];
      if (!integer(exp) || !integer(lmd)) { issue(`level.E${e}.${l + 1}:cost-unavailable`); continue; }
      const label = `E${e} L${l + 1}`; add('level', `E${e} L${l}`, label, { materials: {}, exp, lmd });
      compare(`${label}:exp`, exp, array(array(object(tables.crossLevel).characterExp)[e])[l - 1]);
      compare(`${label}:lmd`, lmd, array(array(object(tables.crossLevel).characterUpgradeCost)[e])[l - 1]);
    }
  };
  const prerequisite = (condition: unknown, label: string) => {
    const cond = object(condition), requiredElite = phase(cond.phase), requiredLevel = cond.level;
    if (requiredElite === null || !integer(requiredLevel, 1, 100)) { issue(`${label}:prerequisite-unavailable`); return; }
    if (finalElite === null || finalLevel === null || finalElite < requiredElite || (finalElite === requiredElite && finalLevel < requiredLevel)) issue(`${label}:prerequisite-not-met`);
  };
  if ('elite' in target || 'level' in target) {
    const e = target.elite, l = target.level;
    if (!integer(e, 0, 2) || !integer(l, 1, 100)) issue('target.promotion:elite-and-level-required');
    else if (!integer(phases[e]?.maxLevel, 1, 100) || l > Number(phases[e]?.maxLevel)) issue('target.level:above-cap');
    else if (elite !== null && level !== null) {
      if (e < elite || (e === elite && l < level)) issue('target.promotion:below-current');
      else {
        let start = level;
        for (let stage = elite; stage < e; stage++) {
          const cap = phases[stage]?.maxLevel;
          if (!integer(cap, 1, 100)) { issue(`phase.${stage}:cap-unavailable`); break; }
          levelUp(stage, start, cap);
          const cost = normalizeCosts(phases[stage + 1]?.evolveCost, `promotion.${stage + 1}`);
          const rarity = typeof char.rarity === 'string' && /^TIER_[1-6]$/.test(char.rarity) ? Number(char.rarity.slice(-1)) : null;
          const gold = rarity === null ? undefined : array(array(constants.evolveGoldCost)[rarity - 1])[stage];
          if (!integer(gold)) issue(`promotion.${stage + 1}:lmd-unavailable`);
          else if (cost) { cost.lmd += gold; add('promotion', `E${stage}`, `E${stage + 1}`, cost, array(crossChar.evolve)[stage]); }
          start = 1;
        }
        levelUp(e, start, l); finalElite = e; finalLevel = l;
      }
    }
  }
  let skillLevel: number | null = null;
  if ('skillLevel' in target || 'mastery' in target) skillLevel = current('skillLevel', 1, 7);
  if ('skillLevel' in target) {
    const goal = target.skillLevel;
    if (!integer(goal, 1, 7)) issue('target.skillLevel:invalid');
    else if (skillLevel !== null) {
      if (goal < skillLevel) issue('target.skillLevel:below-current');
      for (let s = skillLevel + 1; s <= goal; s++) {
        const row = object(array(char.allSkillLvlup)[s - 2]); prerequisite(row.unlockCond, `skill.${s}`);
        add('skill', `S${s - 1}`, `S${s}`, normalizeCosts(row.lvlUpCost, `skill.${s}`), array(object(crossChar.skills).normal)[s - 2]);
      }
      skillLevel = goal;
    }
  }
  for (const section of ['mastery', 'modules'] as const) {
    if (!(section in target)) continue;
    const goals = object(target[section]);
    if (!Object.keys(goals).length) issue(`target.${section}:missing`);
    for (const [key, goal] of Object.entries(goals)) {
      if (!integer(goal, 0, 3)) { issue(`target.${section}.${key}:invalid`); continue; }
      const start = current(section, 0, 3, key); if (start === null) continue;
      if (goal < start) { issue(`target.${section}.${key}:below-current`); continue; }
      if (section === 'mastery') {
        if (!/^[1-3]$/.test(key)) { issue(`target.mastery.${key}:invalid-slot`); continue; }
        const skill = object(array(char.skills)[Number(key) - 1]);
        if (typeof skill.skillId !== 'string') { issue(`mastery.${key}:skill-unavailable`); continue; }
        if (goal > 0 && skillLevel !== 7) issue(`mastery.${key}:skill-level-7-required`);
        const cross = array(object(crossChar.skills).elite).map(object).find(s => typeof s.name === 'string' && s.name.replace(/\[(\d+)\]/g, '_$1') === skill.skillId);
        for (let n = start + 1; n <= goal; n++) {
          const row = object(array(skill.levelUpCostCond)[n - 1]); prerequisite(row.unlockCond, `mastery.${key}.${n}`);
          add('mastery', `S${key} M${n - 1}`, `S${key} M${n}`, normalizeCosts(row.levelUpCost, `mastery.${key}.${n}`), array(cross?.cost)[n - 1]);
        }
      } else {
        const modules = object(tables.modules), module = object(object(modules.equipDict)[key]);
        if (!array(object(modules.charEquip)[id]).includes(key) || module.charId !== id || !Object.keys(object(module.itemCost)).length) { issue(`module.${key}:not-available-for-operator`); continue; }
        if (goal > 0) { prerequisite({ phase: module.unlockEvolvePhase, level: module.unlockLevel }, `module.${key}`); if (!result.uncertainties.includes('module-missions-and-trust-not-verified')) result.uncertainties.push('module-missions-and-trust-not-verified'); }
        const cross = array(crossChar.uniequip).map(object).find(m => m.id === key);
        for (let n = start + 1; n <= goal; n++) add('module', `${key} L${n - 1}`, `${key} L${n}`, normalizeCosts(object(module.itemCost)[String(n)], `module.${key}.${n}`), array(cross?.cost)[n - 1]);
      }
    }
  }
  if (result.issues.length) return result;
  const total = emptyCost();
  for (const { cost } of result.steps) { total.lmd += cost.lmd; total.exp += cost.exp; for (const [item, count] of Object.entries(cost.materials)) total.materials[item] = (total.materials[item] ?? 0) + count; }
  if (![total.lmd, total.exp, ...Object.values(total.materials)].every(n => integer(n))) { issue('total:overflow'); return result; }
  result.total = total; result.status = 'ok';
  if (!tables.crossCultivate || !tables.crossLevel) { if (result.crossCheck.status === 'matched') result.crossCheck.status = 'unavailable'; result.uncertainties.push('cross-check-source-unavailable'); }
  if (result.mode === 'no-craft') {
    const validInventory = ['complete', 'partial'].includes(String(object(coverage.inventory).status)); const items = object(snapshot.items);
    const known = (value: unknown): number | null => validInventory && integer(value) ? value : null;
    const stock = (required: number, available: number | null): Stock => ({ required, available, deficit: required === 0 ? 0 : available === null ? null : Math.max(0, required - available) });
    const cards = Object.entries(object(object(tables.items).expItems)); let exp: number | null = cards.length ? 0 : null;
    for (const [item, detail] of cards) { const count = known(items[item]), gain = object(detail).gainExp; if (count === null || !integer(gain, 1) || exp === null) exp = null; else exp += count * gain; }
    if (exp !== null && !integer(exp)) exp = null;
    result.inventory = { materials: Object.fromEntries(Object.entries(total.materials).map(([item, count]) => [item, stock(count, known(items[item]))])), lmd: stock(total.lmd, known(snapshot.lmd)), exp: stock(total.exp, exp) };
    result.uncertainties.push('no-craft-is-known-stock-subtraction-only');
  }
  return result;
}

const cell = (text: unknown) => String(text).replace(/[\r\n|]/g, ' ');
export function formatOperatorCostMarkdown(result: CostResult): string {
  const cost = (value: Cost) => `${Object.entries(value.materials).map(([id, count]) => `${cell(result.itemNames[id] ?? id)} (${cell(id)}) × ${count}`).join('、') || '—'}；龙门币 ${value.lmd}；经验 ${value.exp}`;
  const lines = [`# ${cell(result.operator?.name ?? '培养成本待核')}`, `状态：${result.status}；模式：${result.mode}；快照读取：${cell(result.snapshot.readAt ?? '未知')}`];
  if (result.issues.length) lines.push(`待核：${result.issues.map(cell).join('、')}`);
  if (result.candidates.length > 1) lines.push(`候选：${result.candidates.map(c => `${cell(c.name)} (${cell(c.id)})`).join('、')}`);
  lines.push('', '| 步骤 | 成本 |', '| --- | --- |', ...result.steps.map(s => `| ${cell(s.from)} → ${cell(s.to)} | ${cost(s.cost)} |`));
  lines.push('', `总计：${result.total ? cost(result.total) : '未知，不能判断已满足'}`);
  if (result.inventory) {
    lines.push('', '| 资源 | 需求 | 已知库存 | 不加工差额 |', '| --- | --- | --- | --- |');
    for (const [name, stock] of [...Object.entries(result.inventory.materials), ['龙门币', result.inventory.lmd] as const, ['经验', result.inventory.exp] as const]) lines.push(`| ${cell(name)} | ${stock.required} | ${stock.available ?? '未知'} | ${stock.deficit ?? '未知'} |`);
  }
  lines.push('', `交叉核对：${result.crossCheck.status}`);
  for (const difference of result.crossCheck.differences) lines.push(`- ${cell(difference.step)}：主源 ${cell(JSON.stringify(difference.primary))}；核对源 ${cell(JSON.stringify(difference.secondary))}（未修正主源）`);
  for (const note of result.uncertainties) lines.push(`- ${cell(note)}`);
  lines.push('', '当前值来源：' + cell(JSON.stringify(result.currentSources)), '扫描时间：' + cell(JSON.stringify(result.snapshot.sourceTimes)), '覆盖状态：' + cell(JSON.stringify(result.snapshot.coverage)), '', '公开资料来源：');
  for (const source of result.sources) lines.push(`- ${cell(source.repository)} @ ${source.commit} / ${cell(source.file)}；SHA-256 ${source.sha256}；读取 ${source.readAt}`);
  return lines.join('\n') + '\n';
}

/** Read-only: consumes the existing snapshot, without refreshing recognition or writing a report. */
export async function queryOperatorCost(input: unknown, options: { home?: string; fetcher?: typeof fetch } = {}): Promise<CostResult> {
  const request = object(input);
  const settings = await readSettings(options.home);
  const file = typeof request.snapshotFile === 'string' ? resolve(request.snapshotFile) : settings.privateDirectory ? join(settings.privateDirectory, 'account-snapshot.json') : null;
  if (!file) throw new Error('cost-snapshot-directory-required');
  let snapshot: unknown;
  try { snapshot = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('cost-snapshot-unavailable'); }
  return calculateOperatorCost(await loadOperatorCostTables(options.fetcher), snapshot, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== 'query') throw new Error('cost-action-invalid');
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const input: unknown = JSON.parse(raw); const result = await queryOperatorCost(input);
    console.log(object(input).format === 'markdown' ? formatOperatorCostMarkdown(result) : JSON.stringify(result));
  } catch (error) { const code = error instanceof Error && /^cost-[a-z-]+(?::[A-Za-z]+)?$/.test(error.message) ? error.message : 'cost-input-invalid'; console.error(JSON.stringify({ error: code })); process.exitCode = 1; }
}
