import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMaaSnapshot } from '../../skills/maa-core/scripts/account-snapshot.ts';
import { planTableSources } from '../../skills/maa-core/scripts/base-plan.ts';

// Synthetic operators, skills, rooms and MAA name table for the base plan tests (ticket 22). No real roster or
// layout: every name is invented, every number is a small synthetic value. Only the network is replaced.
const roster: [string, string, string[]][] = [
  ['char_ctrl1', '合成控一', ['ctrl_aura']], ['char_ctrl2', '合成控二', ['ctrl_aura']], ['char_ctrl3', '合成控三', ['ctrl_other']],
  ['char_gold1', '合成金一', ['mfg_gold']], ['char_gold2', '合成金二', ['mfg_gold']], ['char_gold3', '合成金三', ['mfg_gold']], ['char_gold4', '合成金四', ['mfg_gold']],
  ['char_rec1', '合成记一', ['mfg_record']], ['char_trade1', '合成贸一', ['trade_gen']], ['char_trade2', '合成贸二', ['trade_gen']], ['char_trade3', '合成贸三', ['trade_gen']],
  ['char_dorm1', '合成宿一', ['dorm_rec']], ['char_form1', '合成形态', ['trade_gen']], ['char_form2', '合成形态异', ['trade_gen']],
  ['char_fia', '合成菲', ['dorm_recExcludeOther[000]', 'dorm_exchangeAp[000]']], ['char_ghost', '合成未观察', ['trade_gen']],
  // One display name, two game IDs (the real table has such pairs); the default snapshot owns only the second.
  ['char_dup_a', '合成同名', []], ['char_dup_b', '合成同名', ['trade_gen']],
];
const phases = (...sizes: number[]) => sizes.map(maxStationedNum => ({ maxStationedNum }));
export function planTables() {
  return {
    characters: Object.fromEntries(roster.map(([id, name]) => [id, { name }])),
    building: {
      manpowerDisplayFactor: 360000,
      rooms: { CONTROL: { maxCount: 1, phases: phases(1, 2, 3, 4, 5) }, MANUFACTURE: { maxCount: 5, phases: phases(1, 2, 3) }, TRADING: { maxCount: 5, phases: phases(1, 2, 3) },
        POWER: { maxCount: 3, phases: phases(1, 1, 1) }, DORMITORY: { maxCount: 4, phases: phases(5, 5, 5, 5, 5) }, MEETING: { maxCount: 1, phases: phases(2, 2, 2) },
        HIRE: { maxCount: 1, phases: phases(1, 1, 1) }, WORKSHOP: { maxCount: 1, phases: phases(1, 1, 1) }, TRAINING: { maxCount: 1, phases: phases(2, 2, 2) },
        RECYCLE: { maxCount: 1, phases: phases(1, 2, 2) } },
      chars: Object.fromEntries(roster.map(([id, , buffs]) => [id, { charId: id, maxManpower: 8640000,
        buffChar: buffs.map(buffId => ({ buffData: [{ buffId, cond: { phase: 'PHASE_0', level: 1 } }] })) }])),
      buffs: {
        ctrl_aura: { buffName: '合成光环', roomType: 'CONTROL', description: '进驻控制中枢时，控制中枢内所有干员的心情每小时恢复+0.05' },
        ctrl_other: { buffName: '合成调度', roomType: 'CONTROL', description: '进驻控制中枢时，所有贸易站订单效率+7%' },
        mfg_gold: { buffName: '合成金工', roomType: 'MANUFACTURE', description: '进驻制造站时，贵金属类配方的生产力+30%' },
        mfg_record: { buffName: '合成录像', roomType: 'MANUFACTURE', description: '进驻制造站时，作战记录类配方的生产力+30%' },
        trade_gen: { buffName: '合成交涉', roomType: 'TRADING', description: '进驻贸易站时，订单获取效率+20%' },
        dorm_rec: { buffName: '合成安眠', roomType: 'DORMITORY', description: '进驻宿舍时，该宿舍内所有干员的心情每小时恢复+0.2' },
        'dorm_recExcludeOther[000]': { buffName: '合成自律', roomType: 'DORMITORY', description: '进驻宿舍时，自身心情每小时恢复<@cc.vup>+2</>，同时<@cc.vdown>无法获得</>其他来源提供的心情恢复效果' },
        'dorm_exchangeAp[000]': { buffName: '合成互换', roomType: 'DORMITORY', description: '进驻宿舍时，如果自身为<@cc.kw>满心情</>，则与当前宿舍<@cc.kw>前一位</>进驻的干员互换心情' },
      },
    },
    charMeta: { spCharGroups: { char_form1: ['char_form1', 'char_form2'], char_gold1: ['char_gold1'] } },
  };
}
const raw = (source: { repository: string; commit: string; file: string }) => `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`;
export function planNetwork(tables: ReturnType<typeof planTables> = planTables()): typeof fetch {
  const routes: Record<string, unknown> = Object.fromEntries(Object.entries(planTableSources).map(([key, source]) => [raw(source), tables[key as keyof typeof tables]]));
  return async (input) => {
    if (!Object.hasOwn(routes, String(input))) throw new Error(`unexpected request ${String(input)}`);
    return new Response(JSON.stringify(routes[String(input)]));
  };
}
export function planNetworkFixtures(): Record<string, unknown> {
  const tables = planTables();
  return Object.fromEntries(Object.entries(planTableSources).map(([key, source]) => [raw(source), tables[key as keyof typeof tables]]));
}
export function planSnapshot(exclude: string[] = ['char_ghost', 'char_dup_a']) {
  return parseMaaSnapshot(JSON.stringify({ taskchain: 'OperBox', what: 'OperBoxInfo', details: { done: true,
    own_opers: roster.filter(([id]) => !exclude.includes(id)).map(([id, name]) => ({ id, name, own: true, elite: 2, level: 1, potential: 1, rarity: 5 })) } }), '2026-11-13T00:00:00.000Z');
}
/** A synthetic MAA battle_data.json: the name table MAA matches infrastructure names against. */
export function nameTable() {
  return { chars: { ...Object.fromEntries(roster.map(([id, name]) => [id, { name, profession: 'WARRIOR' }])), token_synthetic: { name: '合成召唤物', profession: 'TOKEN' } }, ranges: {} };
}
export const layout = () => [{ type: 'control', level: 1 }, { type: 'manufacture', level: 2, product: 'Pure Gold' }, { type: 'trading', level: 1, product: 'LMD' }, { type: 'dormitory', level: 1 }];
export const shifts = () => [
  { name: '白班', period: '08:00-20:00', rooms: { control: [['合成控一']], manufacture: [['合成金一', '合成金二']], trading: [['合成贸一']],
    dormitory: [['合成宿一', '合成控二', '合成金三', '合成金四', '合成贸二']] }, drones: { room: 'manufacture', index: 1, order: 'pre' } },
  { name: '夜班', period: '20:00-08:00', rooms: { control: [['合成控二']], manufacture: [['合成金三', '合成金四']], trading: [['合成贸二']],
    dormitory: [['合成宿一', '合成控一', '合成金一', '合成金二', '合成贸一']] } },
];
export const planInput = () => ({ title: '合成两班', layout: layout(), shifts: shifts(), moodDefault: { work: 1, rest: 2, basis: '合成样例假设：上班每小时 -1，宿舍每小时 +2' },
  combos: [], exclusions: [], efficiency: [0, 1].map(plan => ({ plan, room: 'manufacture[0]', base: 100, skill: 60, global: 5, basis: '合成样例：两名金工各 +30%' })) });

/** A temporary home: settings, private directory, synthetic snapshot and a synthetic MAA directory with its name table. */
export async function planHome(snapshot: unknown = planSnapshot()) {
  const directory = await mkdtemp(join(tmpdir(), 'maa-base-plan-'));
  const maa = join(directory, 'maa');
  await mkdir(join(maa, 'resource'), { recursive: true });
  await writeFile(join(maa, 'resource', 'battle_data.json'), JSON.stringify(nameTable()));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: directory, maaDirectory: maa }));
  await writeFile(join(directory, 'account-snapshot.json'), JSON.stringify(snapshot));
  return directory;
}
