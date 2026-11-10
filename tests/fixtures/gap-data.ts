// Synthetic account, costs and recipes only. Public voucher IDs identify rule categories, not an account.
import { costTables, costSnapshot } from './cost-data.ts';

export const gapProgress = { source: 'user-confirmed', rooms: { WORKSHOP: [3] }, stageRanks: { stage_synthetic: 2 }, voucherValidity: { premium_material_voucher_perm: true } };
export const gapGoal = { name: '合成干员', target: { elite: 1, level: 1 } };
export function gapTables() {
  const tables = costTables();
  Object.assign(tables.characters, { char_second: { ...structuredClone(tables.characters.char_synthetic), name: '合成二号' } });
  Object.assign(tables.items.items, {
    ore: { name: '合成下级材料', voucherRelateList: [{ voucherId: 'premium_material_voucher_perm', voucherItemType: 'MATERIAL_ISSUE_VOUCHER' }] },
    premium_material_voucher_perm: { name: '合成材料提货券', itemType: 'MATERIAL_ISSUE_VOUCHER' },
  });
  return { ...tables, building: { workshopFormulas: { synthetic: {
    formulaId: 'recipe_mat', formulaType: 'F_EVOLVE', itemId: 'mat', count: 1, goldCost: 5, apCost: 360000,
    costs: [{ id: 'ore', count: 2, type: 'MATERIAL' }], requireRooms: [{ roomId: 'WORKSHOP', roomLevel: 3, roomCount: 1 }], requireStages: [{ stageId: 'stage_synthetic', rank: 2 }],
  } }, manufactFormulas: {} }, stages: { stages: { stage_synthetic: { stageId: 'stage_synthetic', code: 'SYN-1' } } } };
}
export function gapSnapshot() {
  const snapshot = costSnapshot(); snapshot.items.mat = 0;
  Object.assign(snapshot.items, { ore: 0, exp_card: 1, premium_material_voucher_perm: 4 });
  snapshot.operators.push({ ...structuredClone(snapshot.operators[0]!), id: 'char_second', name: '合成二号' });
  return snapshot;
}
