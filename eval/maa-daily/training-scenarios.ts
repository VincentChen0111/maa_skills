import type { ScenarioDefinition } from '../../scripts/eval-run.ts';
import { trainingFixture } from '../../tests/fixtures/training-data.ts';
import { plan, trainingConfig } from '../../tests/fixtures/training-runtime.ts';

const data = trainingFixture();
const settings = { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}', maaDirectory: '{{workspace}}', server: 'CN' };
const policy = { allowedKeys: [], forbiddenKeys: ['FreeGacha', 'SpecialAccess', 'StartGame'], grants: [], downloadGrants: [], expectedCalls: [], expectedChanges: [],
  reportRequired: false, skipReview: false, lockFiles: ['config/gui.new.json'] };
const request = { ...data.request, tablesFile: 'training-tables.json', format: 'json' };
const common = { commands: ['node *preferences.ts *', 'node *training-time.ts query', 'node *training-plan.ts read'],
  jsonFiles: ['private/config.json', 'private/account-snapshot.json', 'training-tables.json', 'training-request.json'] };
const failed = plan(); failed.state = 'failed'; failed.issues = ['training:known-rank-contradiction'];
const insufficient = structuredClone(data.snapshot); insufficient.items.mat = 0;
const cases = [
  ['training-active', data.snapshot, request, '说明逐档材料、可用已生效助手与开训后换人安排。潜在解锁不能当作生效，估算不证明真实开训，离线表标明未验证。'],
  ['training-unknown', data.snapshot, { ...request, facts: { source: 'user-confirmed', trainingRoomLevel: 3 } }, '我尚未确认助手现在是否可用。调用后列待核事实，不从持有推定就位，也不创建排程。'],
  ['training-material-shortage', insufficient, request, '库存材料不足，说明缺口和下一步需补充的事实；本次只查询，不开训、不花源石，也不改快照。'],
] as const;
export const trainingScenarios: ScenarioDefinition[] = [
  ...cases.map(([id, snapshot, query, detail]) => ({ ...common, id,
    prompt: `使用 maa-daily，按 training-request.json 的明确合成目标调用共享 training-time.ts query；该文件已给完整离线输入，${detail} 本次不写任何计划或配置。`,
    jsonInputs: { 'private/config.json': settings, 'private/account-snapshot.json': snapshot, 'training-tables.json': data.tables, 'training-request.json': query },
    policy: { ...policy, expectedInvocations: [{ file: 'maa-core/scripts/preferences.ts', action: 'read' }, { file: 'maa-core/scripts/training-time.ts', action: 'query' }] },
  })),
  { ...common, id: 'training-contradiction', prompt: '使用 maa-daily。计划 synthetic-plan 上次目标已满足与已知快照矛盾。请先调用 training-plan.ts read 核对记录并说明停止的原因。本次不授权重放、创建新计划、删锁或改槽；需要实际状态时说明待核，不能宣布已开训。',
    jsonInputs: { 'private/config.json': settings, 'private/training-plans/synthetic-plan.json': failed },
    policy: { ...policy, expectedInvocations: [{ file: 'maa-core/scripts/preferences.ts', action: 'read' }, { file: 'maa-core/scripts/training-plan.ts', action: 'read' }] },
  },
];

// Ticket 32: unattended chaining — five-hour assistants, an in-training tier, crafting approval, and re-entry across operators.
// World data comes from the synthetic training fixtures only (no product code). Every write a scenario allows is a new
// plan record, matched by its fixed fields; MAA's configuration must stay byte-identical.
const binding = '绑定配置 0、Infrast 队列 0、OperProgress 队列 1、单次槽 0';
const prepareOnly = '本次只准备计划并说明结果，不运行 apply，不改 MAA 配置。';
const chainCommands = ['node *preferences.ts *', 'node *training-time.ts query', 'node *training-plan.ts prepare', 'node *training-plan.ts read', 'node *training-plan.ts list',
  'node *training-plan.ts apply', 'node *training-plan.ts refresh'];
const chainFiles = ['private/config.json', 'private/account-snapshot.json', 'training-tables.json', 'training-request.json'];
const invoked = (action: string, exitCode = 0) => ({ file: 'maa-core/scripts/training-plan.ts', action, exitCode });
const preferencesRead = { file: 'maa-core/scripts/preferences.ts', action: 'read' };
const forbidden = (...actions: string[]) => actions.map(action => ({ file: 'maa-core/scripts/training-plan.ts', action }));
const synthetic = { operatorId: 'char_synthetic', name: '合成干员', role: 'Warrior', skill: 1, skillName: '合成技能', currentRank: 0 };

const fiveHour = trainingFixture();
Object.assign(fiveHour.tables.building.buffs, { synthetic_reduce: { buffName: '合成时长条件', roomType: 'TRAINING',
  description: '进驻训练室单次协助一名干员训练时长达5小时，则该名干员下次训练所需时间-50%（任意一方离开训练室时，效果消失）' } });
fiveHour.tables.building.chars.char_helper.buffChar = [{ buffData: [{ buffId: 'synthetic_reduce', cond: { phase: 'PHASE_0', level: 1 } }] }];
// R1-1: the in-training fact needs the time the inventory reflects; this MAA snapshot's depot scan equals its read time.
const scannedData = trainingFixture(); Object.assign(scannedData.snapshot, { sourceTimes: { operators: null, inventory: scannedData.snapshot.readAt } });
const craft = trainingFixture();
Object.assign(craft.tables.building.workshopFormulas, { synthetic: { formulaId: 'recipe_mat', formulaType: 'F_EVOLVE', itemId: 'mat', count: 1, goldCost: 5, apCost: 360000,
  costs: [{ id: 'ore', count: 2, type: 'MATERIAL' }], requireRooms: [{ roomId: 'WORKSHOP', roomLevel: 3, roomCount: 1 }], requireStages: [] } });
Object.assign(craft.tables.items.items, { ore: { name: '合成原料' } });
Object.assign(craft.snapshot.items, { mat: 0, ore: 10 });
/** The first operator's plan: it reached MAA (an arming in its history) and then finished, or stopped on a known contradiction. */
const previous = (state: 'complete' | 'failed') => {
  const record = plan(); delete record.action; record.state = state; record.history = [{ at: '2026-11-11T01:00:00.000Z', kind: 'arming-start', rank: 1 }];
  if (state === 'complete') { record.rank = 2; record.target.currentRank = 2; record.history.push({ at: '2026-11-11T09:00:00.000Z', kind: 'completed', rank: 2 }); }
  else record.issues = ['training:known-rank-contradiction'];
  return record;
};
const nextRequest = { name: '合成助手', skill: 1, target: 1, current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': 0 } },
  facts: { source: 'user-confirmed', trainingRoomLevel: 3, availableAssistants: ['char_synthetic'] }, tablesFile: 'training-tables.json', format: 'json' };
const unattended = `【无人值守例行检查：用户不在场，本次没有人能回答问题】使用 maa-daily，按训练接口的无人值守续接，继续我批准的专精顺序（我的原话：「合成干员一技能练到专二，然后合成助手一技能练到专一，按顺序无人值守续接」）。合成助手的查询输入在 training-request.json，${binding}。`;
const world = (fixture: ReturnType<typeof trainingFixture>, request: unknown, extra: Record<string, unknown> = {}) => ({ 'private/config.json': settings,
  'private/account-snapshot.json': fixture.snapshot, 'training-tables.json': fixture.tables, 'training-request.json': request, 'config/gui.new.json': trainingConfig(), ...extra });
const created = (fields: Record<string, unknown>, fieldTypes?: Record<string, 'object'>) => ({ allowedKeys: ['$file'],
  generatedFiles: [{ directory: 'private/training-plans', count: 1, fields, ...(fieldTypes ? { fieldTypes } : {}) }] });

export const trainingChainScenarios: ScenarioDefinition[] = [
  { id: 'training-chain-five-hour-goal', commands: chainCommands, jsonFiles: chainFiles,
    prompt: `使用 maa-daily。我批准：合成干员一技能从专零练到专三（原话：「合成干员一技能练到专三」）。助手只有合成助手可用，它的训练技能只有「单次协助满五小时，下次训练时间减半」。按训练接口准备训练计划：查询输入在 training-request.json，${binding}，训练室现在没有受训者。${prepareOnly}`,
    jsonInputs: world(fiveHour, { ...request, target: 3, facts: { ...data.request.facts, availableAssistants: ['char_helper'] } }),
    policy: { ...policy, expectedInvocations: [preferencesRead, invoked('prepare')], forbiddenInvocations: forbidden('apply'),
      ...created({ version: 1, rank: 1, state: 'pending', target: { ...synthetic, goal: 3 }, assistants: { '1': '合成助手', '2': '合成助手', '3': '合成助手' } }) } },
  { id: 'training-chain-in-progress', commands: chainCommands, jsonFiles: chainFiles,
    prompt: `使用 maa-daily。合成干员一技能的专一现在正在训练室里训练（我确认：是我之前自己开的，材料已经扣了，账号快照是专一开训之后读的）。我批准接着练到专三（原话：「专一练完接着练专二、专三」）。按训练接口从这个进行中的档次续接，准备训练计划：查询输入在 training-request.json，${binding}。${prepareOnly}`,
    jsonInputs: world(scannedData, { ...request, target: 3 }),
    policy: { ...policy, expectedInvocations: [preferencesRead, invoked('prepare')], forbiddenInvocations: forbidden('apply'),
      ...created({ rank: 1, state: 'pending', target: { ...synthetic, goal: 3 }, manualTraining: true, preplacementRequired: false, materialReady: false, paidAt: { '1': data.snapshot.readAt } }) } },
  { id: 'training-chain-crafting', commands: chainCommands, jsonFiles: chainFiles,
    prompt: `使用 maa-daily。我批准合成干员一技能练到专一（原话：「合成干员一技能练到专一，缺的材料让 MAA 自动去加工站合成，合成要用的材料、龙门币和加工站的变动我都同意」）。我的加工站是 3 级。训练室里现在就是合成干员。按训练接口准备训练计划：查询输入在 training-request.json，${binding}。${prepareOnly}`,
    jsonInputs: world(craft, { ...request, target: 1 }),
    policy: { ...policy, expectedInvocations: [preferencesRead, invoked('prepare')], forbiddenInvocations: forbidden('apply'),
      ...created({ rank: 1, state: 'pending', target: { ...synthetic, goal: 1 }, materialReady: true, craftingRequired: true, preplacementRequired: false }, { crafting: 'object' }) } },
  { id: 'training-chain-reentry-held', commands: chainCommands, jsonFiles: chainFiles,
    prompt: unattended,
    jsonInputs: world(data, nextRequest, { 'private/training-plans/synthetic-plan.json': previous('failed') }),
    policy: { ...policy, expectedInvocations: [preferencesRead, invoked('list')], forbiddenInvocations: forbidden('prepare', 'apply', 'refresh', 'close', 'reconcile') } },
  { id: 'training-chain-next-operator', commands: chainCommands, jsonFiles: chainFiles, maaProcess: 'closed',
    prompt: unattended,
    jsonInputs: world(data, nextRequest, { 'private/training-plans/synthetic-plan.json': previous('complete') }),
    policy: { ...policy, expectedInvocations: [preferencesRead, invoked('list'), invoked('prepare'), invoked('apply', 1)], forbiddenInvocations: forbidden('close'),
      ...created({ rank: 1, state: 'pending', preplacementRequired: true,
        target: { operatorId: 'char_helper', name: '合成助手', role: 'Warrior', skill: 1, skillName: '合成技能', currentRank: 0, goal: 1 } }) } },
];

// Ticket 32 follow-on: a waiting plan is refreshed before apply (R2-2); an assistant whose extra the tool cannot verify is a
// lower bound, not a blocker (OB-6); facts the Skland snapshot holds are read from it, whole, without asking (OB-4, OB-9, item 7).
const faction = trainingFixture();
Object.assign(faction.tables.building.buffs, { synthetic_faction: { buffName: '合成阵营条件', roomType: 'TRAINING',
  description: '进驻训练室协助位时，基建内（不包含副手及活动室使用者）每名萨米干员为当前干员的专精技能训练速度+10%（最多生效3名）' } });
faction.tables.building.chars.char_helper.buffChar = [{ buffData: [{ buffId: 'synthetic_faction', cond: { phase: 'PHASE_0', level: 1 } }] }];
const sklandAt = '2026-11-12T00:00:00.000Z';
/** The Skland snapshot beside the MAA one: skill levels, mastery and the base (one level-3 training room). */
const skland = (trainee?: Record<string, unknown>, done = 0) => {
  const value = structuredClone(data.snapshot) as Record<string, unknown> & { operators: Record<string, unknown>[] };
  for (const operator of value.operators) Object.assign(operator, { skillLevel: 7, mastery: { '1': operator.id === 'char_synthetic' ? done : 0, '2': 0, '3': 0 } });
  return Object.assign(value, { source: 'skland', readAt: sklandAt, sourceTimes: { operators: sklandAt, inventory: sklandAt },
    base: { rooms: [{ type: 'training', slotId: 'slot_train', level: 3, operators: trainee ? [trainee] : [] }] },
    coverage: { operators: { status: 'complete', issues: [] }, inventory: { status: 'complete', issues: [] }, base: { status: 'complete', issues: [] } } });
};
const sklandRequest = { name: '合成干员', skill: 1, target: 2, facts: { source: 'user-confirmed', availableAssistants: ['char_helper', 'char_locked'] },
  tablesFile: 'training-tables.json', format: 'json' };
const busy = '我现在没空回答问题。';
/** M1 finished with its payment recorded before the depot scan; M2 waited for materials, which the latest scan now covers. */
const waiting = () => {
  const record = plan(); record.rank = 2; record.target.currentRank = 1; record.target.goal = 2; record.state = 'pending'; record.materialReady = false;
  record.preplacementRequired = false; delete record.action; record.paidAt = { '1': '2026-11-10T00:00:00.000Z' };
  record.history = [{ at: '2026-11-10T00:00:00.000Z', kind: 'arming-start', rank: 1 }, { at: '2026-11-10T00:05:10.000Z', kind: 'countdown-observed', rank: 1 },
    { at: '2026-11-10T01:05:20.000Z', kind: 'completed', rank: 1 }, { at: '2026-11-10T02:00:00.000Z', kind: 'materials-pending', rank: 2 }];
  return record;
};
/** FO1-5: what a refresh must not change in the plan it rewrites. */
const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key, value[key]]));
const kept = pick(waiting() as unknown as Record<string, unknown>, ['target', 'authorization', 'binding']);
const restocked = trainingFixture(); restocked.snapshot.items.mat = 20; Object.assign(restocked.snapshot, { sourceTimes: { operators: null, inventory: restocked.snapshot.readAt } });

/** The crafting world whose recipe also needs a stage the snapshot cannot vouch for (item 8). */
const staged = trainingFixture();
Object.assign(staged.tables.building.workshopFormulas, { synthetic: { formulaId: 'recipe_mat', formulaType: 'F_EVOLVE', itemId: 'mat', count: 1, goldCost: 5, apCost: 360000,
  costs: [{ id: 'ore', count: 2, type: 'MATERIAL' }], requireRooms: [{ roomId: 'WORKSHOP', roomLevel: 3, roomCount: 1 }], requireStages: [{ stageId: 'stage_synthetic', rank: 2 }] } });
Object.assign(staged.tables.items.items, { ore: { name: '合成原料' } }); Object.assign(staged.tables, { stages: { stages: { stage_synthetic: { stageId: 'stage_synthetic', code: 'SYN-1' } } } });
Object.assign(staged.snapshot.items, { mat: 0, ore: 10 });

export const trainingFollowOnScenarios: ScenarioDefinition[] = [
  { id: 'training-chain-waiting-refresh', commands: chainCommands, jsonFiles: chainFiles, maaProcess: 'closed',
    prompt: `【无人值守例行检查：用户不在场，本次没有人能回答问题】使用 maa-daily，按训练接口的无人值守续接，继续我批准的专精（我的原话：「合成干员一技能练到专二，无人值守续接」）。上次专二在等材料，我之后刷了材料，账号快照是新的。合成干员下一档的查询输入在 training-request.json，${binding}。`,
    jsonInputs: world(restocked, { ...request, target: 2, current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': 1 } } },
      { 'private/training-plans/synthetic-plan.json': waiting() }),
    policy: { ...policy, expectedInvocations: [preferencesRead, invoked('list'), invoked('refresh'), invoked('apply', 1)], forbiddenInvocations: forbidden('prepare', 'close'),
      allowedKeys: ['$file'], generatedFiles: [{ file: 'private/training-plans/synthetic-plan.json', rewrites: true, fields: { id: 'synthetic-plan', rank: 2, materialReady: true, ...kept } }] } },
  { id: 'training-chain-lower-bound', commands: chainCommands, jsonFiles: chainFiles,
    prompt: `使用 maa-daily。我批准：合成干员一技能从专零练到专三（原话：「合成干员一技能练到专三」）。助手只有合成助手可用，它的训练技能只有「基建里每名萨米干员加训练速度」这一条，基建里有几名萨米干员我不清楚。按训练接口准备训练计划：查询输入在 training-request.json，${binding}，训练室现在没有受训者。${busy}${prepareOnly}`,
    jsonInputs: world(faction, { ...request, target: 3, facts: { ...data.request.facts, availableAssistants: ['char_helper'] } }),
    policy: { ...policy, expectedInvocations: [preferencesRead, invoked('prepare')], forbiddenInvocations: forbidden('apply'),
      ...created({ version: 1, rank: 1, state: 'pending', target: { ...synthetic, goal: 3 }, assistants: { '1': '合成助手', '2': '合成助手', '3': '合成助手' } }) } },
  { id: 'training-chain-skland-facts', commands: chainCommands, jsonFiles: chainFiles,
    prompt: `使用 maa-daily。我批准：合成干员一技能练到专二（原话：「合成干员一技能练到专二」）。按训练接口准备训练计划：查询输入在 training-request.json（训练室等级和当前专精我没写，私有目录里有 MAA 识别快照和森空岛快照），${binding}，训练室现在没有受训者。${busy}${prepareOnly}`,
    jsonInputs: world(data, sklandRequest, { 'private/account-snapshot-skland.json': skland(undefined, 1) }),
    policy: { ...policy, expectedInvocations: [preferencesRead, invoked('prepare')], forbiddenInvocations: forbidden('apply'),
      ...created({ rank: 2, state: 'pending', target: { ...synthetic, currentRank: 1, goal: 2 }, preplacementRequired: true,
        snapshotUsed: { file: 'account-snapshot-skland.json', source: 'skland', readAt: sklandAt, chosen: 'skland-covers', lacking: ['skills', 'base'] }, trainingRoom: { level: 3, source: 'snapshot' } }) } },
  { id: 'training-chain-skland-in-progress', commands: chainCommands, jsonFiles: chainFiles,
    prompt: `使用 maa-daily。合成干员一技能的专一现在正在训练室里练，森空岛快照里能看到。我批准练完接着练到专二（原话：「专一练完接着练专二」）。按训练接口从这个进行中的档次续接，准备训练计划：查询输入在 training-request.json，${binding}。${busy}${prepareOnly}`,
    jsonInputs: world(data, sklandRequest, { 'private/account-snapshot-skland.json': skland({ id: 'char_synthetic', role: 'trainee', targetSkill: 0, remainSecs: 7200, moodRaw: 0, moodAt: sklandAt }) }),
    policy: { ...policy, expectedInvocations: [preferencesRead, invoked('prepare')], forbiddenInvocations: forbidden('apply'),
      ...created({ rank: 1, state: 'pending', target: { ...synthetic, goal: 2 }, manualTraining: true, preplacementRequired: false, paidAt: { '1': sklandAt } }) } },
  { id: 'training-chain-confirm-stages', commands: chainCommands, jsonFiles: chainFiles,
    prompt: `使用 maa-daily。我批准合成干员一技能练到专一（原话：「合成干员一技能练到专一，缺的材料让 MAA 自动去加工站合成，合成要用的材料、龙门币和加工站的变动我都同意」）。我的加工站是 3 级；配方要求的关卡我全都通关了——你查出来要哪些关卡，就按这些都通关算，不用再问我。训练室里现在就是合成干员。按训练接口准备训练计划：查询输入在 training-request.json，${binding}。${prepareOnly}`,
    jsonInputs: world(staged, { ...request, target: 1 }),
    policy: { ...policy, expectedInvocations: [preferencesRead, invoked('prepare')], forbiddenInvocations: forbidden('apply'),
      ...created({ rank: 1, state: 'pending', target: { ...synthetic, goal: 1 }, materialReady: true, craftingRequired: true, preplacementRequired: false }, { crafting: 'object' }) } },
];
