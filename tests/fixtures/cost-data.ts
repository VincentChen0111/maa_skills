// Entirely synthetic tables. IDs and values deliberately do not describe an account or game operator.
export function costTables() {
  const material = (count: number) => [{ id: 'mat', count, type: 'MATERIAL' }];
  const character = { name: '合成干员', rarity: 'TIER_6', isNotObtainable: false,
    phases: [{ maxLevel: 3, evolveCost: null }, { maxLevel: 3, evolveCost: material(2) }, { maxLevel: 3, evolveCost: material(4) }],
    allSkillLvlup: Array.from({ length: 6 }, () => ({ unlockCond: { phase: 'PHASE_0', level: 1 }, lvlUpCost: material(1) })),
    skills: [{ skillId: 'synthetic_skill', unlockCond: { phase: 'PHASE_0', level: 1 }, levelUpCostCond: [1, 2, 3].map(n => ({ unlockCond: { phase: 'PHASE_2', level: 1 }, levelUpCost: material(n) })) }],
  };
  return {
    characters: { char_synthetic: character }, patches: { infos: {}, patchChars: {} },
    constants: { evolveGoldCost: [[], [], [], [], [], [100, 200]], characterExpMap: [[10, 20], [30, 40], [50, 60]], characterUpgradeCostMap: [[1, 2], [3, 4], [5, 6]] },
    items: { items: { mat: { name: '合成材料' }, exp_card: { name: '合成记录' } }, expItems: { exp_card: { gainExp: 100 } } },
    modules: { charEquip: { char_synthetic: ['module_synthetic'] }, equipDict: { module_synthetic: { uniEquipId: 'module_synthetic', charId: 'char_synthetic', unlockEvolvePhase: 'PHASE_2', unlockLevel: 2, missionList: ['synthetic_mission'], itemCost: { '1': [...material(3), { id: '4001', count: 10 }], '2': material(4), '3': material(5) } } } },
    crossCultivate: { synthetic: { evolve: [{ mat: 2, '4001': 100 }, { mat: 4, '4001': 200 }], skills: { normal: Array.from({ length: 6 }, () => ({ mat: 1 })), elite: [{ name: 'synthetic_skill', cost: [{ mat: 1 }, { mat: 2 }, { mat: 3 }] }] }, uniequip: [{ id: 'module_synthetic', cost: [{ mat: 3, '4001': 10 }, { mat: 4 }, { mat: 5 }] }] } },
    crossLevel: { characterExp: [[10, 20], [30, 40], [50, 60]], characterUpgradeCost: [[1, 2], [3, 4], [5, 6]] },
  };
}
export function costSnapshot() {
  return { version: 1, source: 'maa', readAt: '2026-11-11T00:00:00.000Z', sourceTimes: { operators: null, inventory: null },
    operators: [{ id: 'char_synthetic', name: '合成干员', elite: 0, level: 2, skillLevel: null, mastery: null, modules: null }],
    items: { mat: 5 }, lmd: 150, coverage: { operators: { status: 'complete' }, inventory: { status: 'partial' } } };
}
