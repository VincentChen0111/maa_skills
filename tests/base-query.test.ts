import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseMaaSnapshot } from '../skills/maa-core/scripts/account-snapshot.ts';
import { queryBaseSkills, formatBaseSkills } from '../skills/maa-core/scripts/base-query.ts';

const characters = { char_alpha: { name: '合成甲' }, char_beta: { name: '合成乙' } };
const building = {
  chars: { char_alpha: { buffChar: [
    { buffData: [{ buffId: 'first', cond: { phase: 'PHASE_0', level: 30 } }, { buffId: 'upgrade', cond: { phase: 'PHASE_2', level: 1 } }] },
    { buffData: [{ buffId: 'second', cond: { phase: 'PHASE_1', level: 50 } }] },
  ] }, char_beta: { buffChar: [{ buffData: [{ buffId: 'first', cond: { phase: 'PHASE_0', level: 1 } }] }] } },
  buffs: {
    first: { buffName: '初级合成', roomType: 'MANUFACTURE', description: '进驻制造站时，生产力+10%' },
    upgrade: { buffName: '高级合成', roomType: 'MANUFACTURE', description: '与特定阵营同处时，生产力+40%，心情每小时额外消耗0.25' },
    second: { buffName: '合成线索', roomType: 'MEETING', description: '进驻会客室时，线索搜集速度+20%' },
  },
};
function snapshot(elite: number | null, level: number | null) {
  return parseMaaSnapshot(JSON.stringify({ taskchain: 'OperBox', what: 'OperBoxInfo', details: { done: true,
    own_opers: [{ id: 'char_alpha', name: '合成甲', own: true, elite, level }] } }), '2026-11-11T00:00:00.000Z');
}

test('owned skills unlock by elite then level and same-slot upgrades replace earlier skills', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'snapshot.json');
  await writeFile(file, JSON.stringify(snapshot(1, 1)));
  const before = await readFile(file, 'utf8');
  const result = queryBaseSkills(JSON.parse(before), { characters, building }, { operators: ['合成甲'] });
  assert.deepEqual(result.operators[0]!.skills.map(skill => [skill.id, skill.status]), [
    ['first', 'active'], ['upgrade', 'locked'], ['second', 'locked'],
  ]);
  const promoted = queryBaseSkills(snapshot(2, 1), { characters, building }, { operators: ['合成甲'] });
  assert.deepEqual(promoted.operators[0]!.skills.map(skill => [skill.id, skill.status]), [
    ['first', 'superseded'], ['upgrade', 'active'], ['second', 'active'],
  ]);
  assert.equal(promoted.operators[0]!.skills[0]!.supersededBy, 'upgrade');
  assert.equal(await readFile(file, 'utf8'), before);
});

test('room query includes only observed ownership and uncertain upgrades are never labelled active', () => {
  const result = queryBaseSkills(snapshot(1, null), { characters, building }, { room: '制造站' });
  assert.deepEqual(result.operators.map(row => row.id), ['char_alpha']);
  assert.deepEqual(result.operators[0]!.skills.map(skill => [skill.id, skill.status]), [['first', 'active'], ['upgrade', 'locked']]);
  const unknown = queryBaseSkills(snapshot(null, null), { characters, building }, { room: 'MANUFACTURE' });
  assert.ok(unknown.operators[0]!.skills.every(skill => skill.status === 'unknown'));
  const missing = queryBaseSkills(snapshot(2, 1), { characters, building }, { operators: ['合成乙'] });
  assert.equal(missing.operators[0]!.ownership, 'unknown');
  assert.ok(missing.operators[0]!.skills.every(skill => skill.status === 'unknown'));
  assert.match(missing.warnings.join(' '), /ownership-unobserved/);
});

test('ambiguous names require an explicit game ID; an unknown query is reported', () => {
  const duplicate = { ...characters, char_twin: { name: '合成甲' } };
  assert.throws(() => queryBaseSkills(snapshot(2, 1), { characters: duplicate, building }, { operators: ['合成甲'] }), /base-name-ambiguous:char_alpha,char_twin/);
  assert.equal(queryBaseSkills(snapshot(2, 1), { characters: duplicate, building }, { operators: ['char_alpha'] }).operators.length, 1);
  assert.deepEqual(queryBaseSkills(snapshot(2, 1), { characters, building }, { operators: ['不存在'] }).warnings, ['operator-not-found:不存在']);
});

test('non-operator entities do not cause name ambiguity and missing roster data is explicit', () => {
  const entities = { ...characters, token_synthetic: { name: '合成甲' } };
  assert.equal(queryBaseSkills(snapshot(2, 1), { characters: entities, building }, { operators: ['合成甲'] }).operators.length, 1);
  const result = queryBaseSkills(snapshot(2, 1), { characters: {}, building }, {});
  assert.deepEqual(result.operators.map(row => [row.id, row.ownership, row.skills.length]), [['char_alpha', 'owned', 0]]);
  assert.deepEqual(result.warnings, ['game-operator-incomplete:char_alpha']);
});

test('missing game facts stay pending and invalid snapshot facts cannot assert ownership', () => {
  const broken = structuredClone(building);
  delete (broken.chars.char_alpha.buffChar[0]!.buffData[1] as { cond?: unknown }).cond;
  const result = queryBaseSkills(snapshot(2, 1), { characters, building: broken }, { operators: ['合成甲'] });
  assert.deepEqual(result.operators[0]!.skills.slice(0, 2).map(skill => skill.status), ['unknown', 'unknown']);
  assert.equal(result.operators[0]!.skills[1]!.unlock, null);
  assert.match(result.warnings.join(' '), /game-skill-incomplete:upgrade/);
  delete (broken.buffs as Record<string, unknown>).second;
  const missing = queryBaseSkills(snapshot(2, 1), { characters, building: broken }, { operators: ['合成甲'] });
  assert.equal(missing.operators[0]!.skills[2]!.status, 'unknown');
  assert.match(missing.warnings.join(' '), /game-skill-incomplete:second/);
  for (const bad of [{}, { ...snapshot(2, 1), version: 2 }, { ...snapshot(2, 1), operators: [{ id: 'char_alpha', elite: 9, level: 1 }] }]) {
    assert.throws(() => queryBaseSkills(bad, { characters, building }, {}), /base-snapshot-invalid/);
  }
});

test('Markdown retains full conditions and explicitly separates unlocks from final yield', () => {
  const result = queryBaseSkills(snapshot(1, 1), { characters, building }, { operators: ['合成甲'] });
  const markdown = formatBaseSkills(result);
  assert.match(markdown, /高级合成.*后续解锁/);
  assert.match(markdown, /精2.*1级/);
  assert.match(markdown, /与特定阵营同处时，生产力\+40%，心情每小时额外消耗0.25/);
  assert.match(markdown, /阵营.*全局.*心情/);
  assert.match(markdown, /百分比.*最终收益/);
  assert.match(markdown, /解锁.*不.*进驻/);
  assert.match(markdown, /2026-11-11T00:00:00.000Z/);
  assert.match(formatBaseSkills(result, 'en'), /Final yield is not calculated/);
});

test('cross-check differences are reported without replacing game skills or importing suggested bonuses', () => {
  const crossCheck = { operators: [{ name: '合成甲', skills: [
    { facility: 'factory', skill_name: '初级合成', elite: 0, required_level: 30, description: '进驻制造站时，生产力+99%', base_bonus_pct: 99 },
    { facility: 'factory', skill_name: '高级合成', elite: 2, required_level: 1, description: building.buffs.upgrade.description },
    { facility: 'reception_room', skill_name: '合成线索', elite: 1, required_level: 50, description: building.buffs.second.description },
  ] }] };
  const result = queryBaseSkills(snapshot(2, 1), { characters, building, crossCheck }, { operators: ['合成甲'] });
  assert.equal(result.operators[0]!.skills[0]!.text, '进驻制造站时，生产力+10%');
  assert.equal(result.crossCheck.status, 'compared');
  assert.deepEqual(result.crossCheck.differences.map(row => row.onlyIn), ['game', 'cross-check']);
  assert.match(formatBaseSkills(result), /交叉核对.*2/);
  assert.match(formatBaseSkills(result), /生产力\+99%/);
  assert.equal(queryBaseSkills(snapshot(2, 1), { characters, building }, {}).crossCheck.status, 'not-requested');
});

test('CLI emits the same JSON and Markdown from supplied tables and leaves snapshot/settings unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-base-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = JSON.stringify(snapshot(2, 1)), settings = JSON.stringify({ language: 'en', privateDirectory: root });
  await writeFile(join(root, 'account-snapshot.json'), source);
  await writeFile(join(root, 'config.json'), settings);
  await writeFile(join(root, 'tables.json'), JSON.stringify({ characters, building }));
  const entry = fileURLToPath(new URL('../skills/maa-core/scripts/base-query.ts', import.meta.url));
  const run = (input: object) => spawnSync(process.execPath, [entry, 'query'], { input: JSON.stringify(input), encoding: 'utf8', cwd: root,
    env: { ...process.env, MAA_SKILLS_HOME: root, USERPROFILE: root, HOME: root } });
  const json = run({ operators: ['合成甲'], tablesFile: 'tables.json' });
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.result.source.mode, 'supplied');
  assert.match(result.summary, /Final yield is not calculated/);
  const markdown = run({ operators: ['合成甲'], tablesFile: 'tables.json', format: 'markdown' });
  assert.equal(markdown.stdout, result.summary);
  assert.equal(await readFile(join(root, 'account-snapshot.json'), 'utf8'), source);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), settings);
  const invalid = run({ tablesFile: 'missing-synthetic-secret.json' });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /missing-synthetic-secret|Error:|stack|[A-Z]:\\/);
});
