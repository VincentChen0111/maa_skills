// Replace only the network boundary; the CLI, preferences, snapshot reads and calculation stay real.
import { costTables } from './cost-data.ts';
const tables = costTables();
const files = { 'character_table.json': 'characters', 'char_patch_table.json': 'patches', 'gamedata_const.json': 'constants', 'item_table.json': 'items', 'uniequip_table.json': 'modules', 'cultivate.json': 'crossCultivate', 'level.json': 'crossLevel' };
globalThis.fetch = async input => {
  const url = new URL(String(input)); const key = files[url.pathname.split('/').at(-1)];
  if (url.host !== 'raw.githubusercontent.com' || !key) throw new Error('unexpected-network-request');
  return new Response(JSON.stringify(tables[key]));
};
