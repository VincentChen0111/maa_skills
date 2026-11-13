// Synthetic Skland payloads for the network double. No real account, token or response is used.
// Every secret-like value is distinctive so leak checks can search outputs and files for it.
export const sklandSecrets = {
  userValue: 'synthetic-skland-user-value-7Q2W',
  grantCode: 'synthetic-grant-code-K3M9',
  cred: 'synthetic-cred-value-P8X4',
  signKey: 'synthetic-sign-key-R5T1',
  account: '91000000777',
  nickname: 'SyntheticDoctor#4242',
  userId: 'synthetic-user-id-4242',
  avatarUrl: 'https://example.invalid/synthetic-avatar.png',
};
export const unixSeconds = 1_762_992_000; // 2025-11-13T00:00:00Z

export function sklandBinding(entries?: Record<string, unknown>[], defaultAccount: string | null = sklandSecrets.account) {
  const binding = (account: string, isDefault: boolean) => ({ ['uid']: account, isOfficial: true, isDefault, channelMasterId: '1',
    channelName: '官服', nickName: sklandSecrets.nickname, isDelete: false, gameName: '明日方舟', gameId: 1, roles: [] });
  return { list: [
    { appCode: 'endfield', appName: '明日方舟：终末地', bindingList: [], defaultUid: null },
    { appCode: 'arknights', appName: '明日方舟', defaultUid: defaultAccount, bindingList: entries ?? [binding(sklandSecrets.account, true)] },
  ] };
}
export function sklandBindingEntry(account: string, isDefault: boolean, isDelete = false) {
  return { ['uid']: account, isOfficial: true, isDefault, channelMasterId: '1', channelName: '官服', nickName: sklandSecrets.nickname, isDelete,
    gameName: '明日方舟', gameId: 1, roles: [] };
}

const roomChar = (charId: string, ap: number, index = 0) => ({ charId, ap, lastApAddTime: unixSeconds, index,
  bubble: { normal: { add: -1, ts: 0 }, assist: { add: -1, ts: 0 } }, workTime: 0 });

/** player/info data: two synthetic operators, Skland's zero-based rarity and potential, and a small base. */
export function sklandInfo() {
  return {
    status: { ['uid']: sklandSecrets.account, name: sklandSecrets.nickname, level: 120, avatar: { type: 'ICON', id: 'avatar_def_01', url: sklandSecrets.avatarUrl },
      registerTs: unixSeconds - 86_400, mainStageProgress: 'main_14-21', secretary: { charId: 'char_9001_synth', skinId: 'char_9001_synth#1' },
      resume: 'synthetic resume', subscriptionEnd: 0, ap: { current: 100, max: 135, lastApAddTime: unixSeconds, completeRecoveryTime: unixSeconds + 3600 },
      storeTs: unixSeconds, lastOnlineTs: unixSeconds, charCnt: 2, furnitureCnt: 10, skinCnt: 2, exp: { current: 1, max: 2 } },
    assistChars: [], skins: [], recruit: [{ startTs: unixSeconds, finishTs: unixSeconds + 32_400, state: 2 }],
    chars: [
      { charId: 'char_9001_synth', skinId: 'char_9001_synth#1', level: 60, evolvePhase: 2, potentialRank: 0, mainSkillLvl: 7,
        skills: [{ id: 'skchr_synth1_1', specializeLevel: 3 }, { id: 'skchr_synth1_2', specializeLevel: 0 }],
        equip: [{ id: 'uniequip_001_synth1', level: 1, locked: false }, { id: 'uniequip_002_synth1', level: 2, locked: false }, { id: 'uniequip_003_synth1', level: 1, locked: true }],
        favorPercent: 100, defaultSkillId: 'skchr_synth1_1', gainTime: unixSeconds, defaultEquipId: 'uniequip_002_synth1' },
      { charId: 'char_9002_synth', skinId: 'char_9002_synth#1', level: 30, evolvePhase: 0, potentialRank: 5, mainSkillLvl: 4,
        skills: [{ id: 'skchr_synth2_1', specializeLevel: 0 }], equip: [], favorPercent: 50, defaultSkillId: 'skchr_synth2_1', gainTime: unixSeconds, defaultEquipId: '' },
    ],
    charInfoMap: {
      char_9001_synth: { id: 'char_9001_synth', name: '合成干员甲', nationId: '', groupId: '', displayNumber: 'S001', rarity: 5, profession: 'CASTER', subProfessionId: 'synth' },
      char_9002_synth: { id: 'char_9002_synth', name: '合成干员乙', nationId: '', groupId: '', displayNumber: 'S002', rarity: 0, profession: 'TANK', subProfessionId: 'synth' },
    },
    building: {
      tiredChars: [], powers: [{ slotId: 'slot_power_1', level: 3, chars: [roomChar('char_9002_synth', 4_320_000)] }],
      manufactures: [{ slotId: 'slot_manu_1', level: 3, chars: [roomChar('char_9001_synth', 8_640_000)], completeWorkTime: unixSeconds, lastUpdateTime: unixSeconds,
        formulaId: '1', capacity: 54, weight: 2, complete: 0, remain: 0, speed: 1 }],
      tradings: [], dormitories: [{ slotId: 'slot_dorm_1', level: 5, chars: [], comfort: 5000 }],
      meeting: null, hire: null,
      training: { slotId: 'slot_train', level: 3, trainee: { charId: 'char_9001_synth', targetSkill: 0, ap: 7_200_000, lastApAddTime: unixSeconds }, trainer: null,
        remainPoint: 0, speed: 1, lastUpdateTime: unixSeconds, remainSecs: 0, slotState: 2 },
      labor: { maxValue: 100, value: 50, lastUpdateTime: unixSeconds, remainSecs: 3600 }, furniture: { total: 10 },
      control: { slotId: 'slot_control', slotState: 2, level: 5, chars: [] },
    },
    equipmentInfoMap: {}, manufactureFormulaInfoMap: {},
  };
}

/** cultivate/player data: counts are numbers or digit strings; 4001 is LMD. */
export function sklandCultivate() {
  return {
    characters: [{ id: 'char_9001_synth', evolvePhase: 2, level: 60, mainSkillLevel: 7, potentialRank: 0, skills: [{ id: 'skchr_synth1_1', level: 3 }], equips: [] }],
    items: [{ id: '30012', count: 17 }, { id: '4001', count: '1200' }, { id: '3301', count: 0 }],
  };
}
