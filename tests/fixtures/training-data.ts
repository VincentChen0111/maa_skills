import { costTables, costSnapshot } from './cost-data.ts';

export function trainingFixture() {
  const tables = costTables();
  const character = { ...tables.characters.char_synthetic, profession: 'WARRIOR', subProfessionId: 'synthetic-branch',
    skills: tables.characters.char_synthetic.skills.map(skill => ({ ...skill, levelUpCostCond: skill.levelUpCostCond.map((row, i) => ({ ...row, lvlUpTime: [3600, 7200, 14400][i] })) })) };
  const buff = (text: string) => ({ buffName: '合成训练技能', roomType: 'TRAINING', description: text });
  const slot = (...ids: string[]) => ({ buffChar: [{ buffData: ids.map((buffId, i) => ({ buffId, cond: { phase: `PHASE_${i}`, level: 1 } })) }] });
  const snapshot = costSnapshot();
  snapshot.operators[0]!.elite = 2;
  for (const [id, name] of [['char_helper', '合成助手'], ['char_locked', '合成待解锁']]) snapshot.operators.push({ ...structuredClone(snapshot.operators[0]!), id: id!, name: name!, elite: id === 'char_locked' ? 0 : 2 });
  snapshot.items.mat = 20; snapshot.lmd = 1000;
  return { tables: { ...tables, characters: { char_synthetic: character, char_helper: { ...character, name: '合成助手' }, char_locked: { ...character, name: '合成待解锁' } },
    building: { trainingData: { basicSpeedBuff: 0.05, phases: [1, 2, 3].map(specSkillLvlLimit => ({ specSkillLvlLimit })) },
      chars: { char_synthetic: slot(), char_helper: slot('synthetic_speed'), char_locked: slot('synthetic_old', 'synthetic_locked') },
      buffs: { synthetic_speed: buff('进驻训练室协助位时，近卫干员的专精技能训练速度+45%'), synthetic_old: buff('进驻训练室协助位时，干员的专精技能训练速度+25%'), synthetic_locked: buff('进驻训练室协助位时，干员的专精技能训练速度+95%') },
      workshopFormulas: {}, manufactFormulas: {} }, stages: { stages: {} }, skillNames: { synthetic_skill: { levels: [{ name: '合成技能' }] } } }, snapshot,
    request: { name: '合成干员', skill: 1, target: 2, current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': 0 } },
      facts: { source: 'user-confirmed', trainingRoomLevel: 3, availableAssistants: ['char_helper', 'char_locked'] } } };
}
