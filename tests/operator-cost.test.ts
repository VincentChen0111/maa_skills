import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { calculateOperatorCost, formatOperatorCostMarkdown, queryOperatorCost, loadOperatorCostTables, operatorCostSources } from '../skills/maa-core/scripts/operator-cost.ts';
import { costTables, costSnapshot } from './fixtures/cost-data.ts';

test('promotion cost includes each intervening cap, reset, and explicit final level', () => {
  const result = calculateOperatorCost(costTables(), costSnapshot(), { name: '合成干员', target: { elite: 2, level: 2 } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.total, { materials: { mat: 6 }, lmd: 314, exp: 140 });
  assert.deepEqual(result.steps.map(step => step.kind), ['level', 'promotion', 'level', 'level', 'promotion', 'level']);
  assert.equal(result.crossCheck.status, 'matched');
  assert.match(formatOperatorCostMarkdown(result), /314/);
  assert.match(formatOperatorCostMarkdown(result), /合成材料/);
});

test('malformed material identifiers and arithmetic overflow cannot disappear from totals', () => {
  for (const replacement of [{ id: '__proto__', count: 1 }, { id: 'mat', count: Number.MAX_SAFE_INTEGER }]) {
    const tables = costTables(); const snapshot = costSnapshot();
    Object.assign(tables.characters.char_synthetic.phases[1]!, { evolveCost: [replacement, replacement] });
    const result = calculateOperatorCost(tables, snapshot, { name: '合成干员', target: { elite: 1, level: 1 } });
    assert.equal(result.status, 'needs-input'); assert.equal(result.total, null);
  }
});

test('missing practice, absent inventory and unrecognized forms remain unknown', () => {
  const tables = costTables(); const snapshot = costSnapshot();
  Object.assign(snapshot.operators[0]!, { elite: null });
  const missing = calculateOperatorCost(tables, snapshot, { name: '合成干员', target: { elite: 1, level: 1 } });
  assert.ok(missing.issues.includes('current.elite:unknown-or-invalid')); assert.equal(missing.total, null);
  const supplied = calculateOperatorCost(tables, snapshot, { name: '合成干员', current: { source: 'user-confirmed', elite: 0 }, target: { elite: 1, level: 1 } });
  assert.equal(supplied.status, 'ok'); assert.equal(supplied.currentSources.elite, 'user-confirmed');
  Object.assign(tables.patches, { patchChars: { char_synthetic_form: structuredClone(tables.characters.char_synthetic) } });
  assert.equal(calculateOperatorCost(tables, snapshot, { name: '合成干员', operatorId: 'char_synthetic_form', target: { elite: 1, level: 1 } }).status, 'needs-input');
  Object.assign(snapshot.operators[0]!, { elite: 0 }); snapshot.coverage.inventory.status = 'pending';
  const inventory = calculateOperatorCost(tables, snapshot, { name: '合成干员', operatorId: 'char_synthetic', target: { elite: 1, level: 1 }, mode: 'no-craft' });
  assert.equal(inventory.inventory?.materials.mat?.available, null); assert.equal(inventory.inventory?.lmd.available, null);
});

test('mastery and module costs keep all incremental levels, require confirmed current facts', () => {
  const snapshot = costSnapshot(); snapshot.operators[0]!.elite = 2; snapshot.operators[0]!.level = 2;
  const query = { name: '合成干员', target: { mastery: { '1': 3 }, modules: { module_synthetic: 3 } } };
  const missing = calculateOperatorCost(costTables(), snapshot, query);
  assert.equal(missing.status, 'needs-input'); assert.equal(missing.total, null);
  const result = calculateOperatorCost(costTables(), snapshot, { ...query, current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': 0 }, modules: { module_synthetic: 0 } } });
  assert.equal(result.status, 'ok'); assert.equal(result.steps.length, 6);
  assert.deepEqual(result.total, { materials: { mat: 18 }, lmd: 10, exp: 0 });
  assert.equal(result.currentSources['mastery.1'], 'user-confirmed');
  assert.ok(result.uncertainties.includes('module-missions-and-trust-not-verified'));
});

test('nonzero mastery targets validate prerequisites even when already claimed at the target rank', () => {
  const tables = costTables(); const snapshot = costSnapshot(); snapshot.operators[0]!.elite = 1; snapshot.operators[0]!.level = 1;
  for (const rank of [1, 2, 3]) {
    const request = { name: '合成干员', current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': rank } }, target: { mastery: { '1': rank } } };
    const result = calculateOperatorCost(tables, snapshot, request);
    assert.equal(result.status, 'needs-input'); assert.equal(result.total, null);
    assert.ok(result.issues.includes(`mastery.1.${rank}:prerequisite-not-met`));
    snapshot.operators[0]!.elite = 2;
    assert.deepEqual(calculateOperatorCost(tables, snapshot, request).total, { materials: {}, lmd: 0, exp: 0 });
    snapshot.operators[0]!.elite = 1;
  }
  const request = { name: '合成干员', current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': 3 } }, target: { mastery: { '1': 3 } } };
  snapshot.operators[0]!.elite = 2;
  Object.assign(tables.characters.char_synthetic.skills[0]!.levelUpCostCond[2]!, { unlockCond: null });
  const missing = calculateOperatorCost(tables, snapshot, request);
  assert.equal(missing.total, null); assert.ok(missing.issues.includes('mastery.1.3:prerequisite-unavailable'));
});

test('nonzero module targets retain prerequisite checks when current equals target', () => {
  const tables = costTables(); const snapshot = costSnapshot(); snapshot.operators[0]!.elite = 1; snapshot.operators[0]!.level = 1;
  const request = { name: '合成干员', current: { source: 'user-confirmed', modules: { module_synthetic: 3 } }, target: { modules: { module_synthetic: 3 } } };
  const unmet = calculateOperatorCost(tables, snapshot, request);
  assert.equal(unmet.total, null); assert.ok(unmet.issues.includes('module.module_synthetic:prerequisite-not-met'));
  snapshot.operators[0]!.elite = 2; snapshot.operators[0]!.level = 2;
  const met = calculateOperatorCost(tables, snapshot, request);
  assert.deepEqual(met.total, { materials: {}, lmd: 0, exp: 0 }); assert.ok(met.uncertainties.includes('module-missions-and-trust-not-verified'));
  Object.assign(tables.modules.equipDict.module_synthetic, { unlockLevel: null });
  const missing = calculateOperatorCost(tables, snapshot, request);
  assert.equal(missing.total, null); assert.ok(missing.issues.includes('module.module_synthetic:prerequisite-unavailable'));
});

test('future promotion does not validate an impossible claimed current mastery or module', () => {
  const tables = costTables(); const snapshot = costSnapshot(); snapshot.operators[0]!.elite = 1; snapshot.operators[0]!.level = 1;
  for (const section of ['mastery', 'modules']) {
    const key = section === 'mastery' ? '1' : 'module_synthetic';
    const result = calculateOperatorCost(tables, snapshot, { name: '合成干员', current: { source: 'user-confirmed', skillLevel: 7, [section]: { [key]: 3 } }, target: { elite: 2, level: 2, [section]: { [key]: 3 } } });
    assert.equal(result.status, 'needs-input'); assert.equal(result.total, null);
    assert.ok(result.issues.some(issue => issue.startsWith(`current.${section}.${key}`) && issue.endsWith(':prerequisite-not-met')));
  }
});

test('current and attained normal skill prerequisites cannot be supplied by a future target', () => {
  const tables = costTables(); const snapshot = costSnapshot();
  Object.assign(tables.characters.char_synthetic.allSkillLvlup[5]!, { unlockCond: { phase: 'PHASE_1', level: 1 } });
  const same = calculateOperatorCost(tables, snapshot, { name: '合成干员', current: { source: 'user-confirmed', skillLevel: 7 }, target: { skillLevel: 7 } });
  assert.equal(same.total, null); assert.ok(same.issues.includes('current.skill.7:prerequisite-not-met'));
  const promotion = calculateOperatorCost(tables, snapshot, { name: '合成干员', current: { source: 'user-confirmed', skillLevel: 7 }, target: { elite: 1, level: 1, skillLevel: 7 } });
  assert.equal(promotion.total, null); assert.ok(promotion.issues.includes('current.skill.7:prerequisite-not-met'));
  snapshot.operators[0]!.elite = 2;
  const mastery = calculateOperatorCost(tables, snapshot, { name: '合成干员', current: { source: 'user-confirmed', skillLevel: 6, mastery: { '1': 1 } }, target: { skillLevel: 7, mastery: { '1': 1 } } });
  assert.equal(mastery.total, null); assert.ok(mastery.issues.includes('current.mastery.1:skill-level-7-required'));
});

test('unknown, conflicting, ambiguous, and incomplete facts never become zero cost', () => {
  const snapshot = costSnapshot(); const tables = costTables();
  for (const request of [
    { name: '合成干员', target: { elite: 2 } },
    { name: '合成干员', target: { elite: 2, level: 2 }, current: { source: 'user-confirmed', elite: 1 } },
    { name: '合成干员', target: {} },
  ]) { const result = calculateOperatorCost(tables, snapshot, request); assert.equal(result.status, 'needs-input'); assert.equal(result.total, null); }
  Object.assign(tables.characters, { char_other: structuredClone(tables.characters.char_synthetic) });
  const ambiguous = calculateOperatorCost(tables, snapshot, { name: '合成干员', target: { elite: 0, level: 2 } });
  assert.equal(ambiguous.status, 'needs-input'); assert.equal(ambiguous.candidates.length, 2);
  const exact = calculateOperatorCost(tables, snapshot, { name: '合成干员', operatorId: 'char_synthetic', target: { elite: 0, level: 2 } });
  assert.deepEqual(exact.total, { materials: {}, lmd: 0, exp: 0 });
});

test('summons and traps sharing an operator name do not enter cultivation candidates', () => {
  const tables = costTables(); const snapshot = costSnapshot();
  Object.assign(tables.characters, { token_synthetic: structuredClone(tables.characters.char_synthetic), trap_synthetic: structuredClone(tables.characters.char_synthetic) });
  const query = { name: '合成干员', target: { elite: 0, level: 3 } };
  const result = calculateOperatorCost(tables, snapshot, query);
  assert.equal(result.status, 'ok'); assert.deepEqual(result.candidates, [{ id: 'char_synthetic', name: '合成干员' }]);
  assert.deepEqual(result.total, { materials: {}, lmd: 2, exp: 20 });
  for (const operatorId of ['token_synthetic', 'trap_synthetic']) {
    const selected = calculateOperatorCost(tables, snapshot, { ...query, operatorId });
    assert.ok(selected.issues.includes('operator:not-found')); assert.equal(selected.total, null);
  }
  Object.assign(tables.patches, { patchChars: { char_synthetic_form: structuredClone(tables.characters.char_synthetic) } });
  const ambiguous = calculateOperatorCost(tables, snapshot, query);
  assert.equal(ambiguous.status, 'needs-input'); assert.equal(ambiguous.candidates.length, 2);
});

test('no-craft subtracts only known inventory, while cross-check differences never alter primary cost', () => {
  const tables = costTables(); tables.crossCultivate.synthetic.evolve[0]!['4001'] = 999;
  const snapshot = costSnapshot(); snapshot.items = {} as typeof snapshot.items;
  const result = calculateOperatorCost(tables, snapshot, { name: '合成干员', target: { elite: 1, level: 1 }, mode: 'no-craft' });
  assert.deepEqual(result.total, { materials: { mat: 2 }, lmd: 102, exp: 20 });
  assert.deepEqual(result.inventory?.materials.mat, { required: 2, available: null, deficit: null });
  assert.deepEqual(result.inventory?.lmd, { required: 102, available: 150, deficit: 0 });
  assert.equal(result.inventory?.exp.available, null);
  assert.equal(result.crossCheck.status, 'different'); assert.ok(result.crossCheck.differences.length > 0);
});

test('each missing primary step remains unknown even when the cross-check has a cost', () => {
  const tables = costTables(); const snapshot = costSnapshot(); snapshot.operators[0]!.elite = 2; snapshot.operators[0]!.level = 2;
  const conditions: unknown[] = tables.characters.char_synthetic.skills[0]!.levelUpCostCond;
  conditions[1] = { unlockCond: { phase: 'PHASE_2', level: 1 } };
  const result = calculateOperatorCost(tables, snapshot, { name: '合成干员', current: { source: 'user-confirmed', skillLevel: 7, mastery: { '1': 0 } }, target: { mastery: { '1': 3 } } });
  assert.equal(result.status, 'needs-input'); assert.equal(result.total, null);
  assert.ok(result.issues.includes('mastery.1.2:cost-unavailable'));
  assert.equal(result.steps.find(s => s.to === 'S1 M3')?.cost.materials.mat, 3);
});

test('skill increments and invalid prerequisite, range, decreasing and supplement facts are explicit', () => {
  const snapshot = costSnapshot(); const tables = costTables();
  const result = calculateOperatorCost(tables, snapshot, { name: '合成干员', current: { source: 'user-confirmed', skillLevel: 5 }, target: { skillLevel: 7 } });
  assert.deepEqual(result.total, { materials: { mat: 2 }, lmd: 0, exp: 0 }); assert.equal(result.steps.length, 2);
  for (const request of [
    { target: { elite: 0, level: 1 } }, { target: { elite: 2, level: 4 } },
    { current: { source: 'user-confirmed', skillLevel: 7, modules: { module_synthetic: 0 } }, target: { modules: { module_synthetic: 1 } } },
    { current: { source: 'user-confirmed', skillLevel: 8 }, target: { elite: 0, level: 2 } },
    { current: { skillLevel: 5 }, target: { skillLevel: 7 } },
  ]) { const invalid = calculateOperatorCost(tables, snapshot, { name: '合成干员', ...request }); assert.equal(invalid.status, 'needs-input', JSON.stringify(request)); assert.equal(invalid.total, null); }
});

test('report copies only whitelisted snapshot metadata and never raw unknown fields', () => {
  const snapshot = costSnapshot();
  Object.assign(snapshot, { credentials: '<synthetic-private-secret>', sourceTimes: { operators: '<synthetic-private-secret>', inventory: null, token: '<synthetic-private-secret>' }, coverage: { operators: { status: 'complete', issues: ['<synthetic-private-secret>'], token: '<synthetic-private-secret>' }, inventory: { status: 'partial' } } });
  const result = calculateOperatorCost(costTables(), snapshot, { name: '合成干员', target: { elite: 0, level: 2 } });
  assert.ok(!JSON.stringify(result).includes('synthetic-private-secret'));
  assert.ok(!formatOperatorCostMarkdown(result).includes('synthetic-private-secret'));
});

function syntheticNetwork(failedKey?: string): typeof fetch {
  const tables = costTables();
  return async (input) => {
    const entry = Object.entries(operatorCostSources).find(([, source]) => String(input) === `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`);
    assert.ok(entry, 'only fixed public sources may be requested');
    const [key] = entry; if (key === failedKey) return new Response('', { status: 503 });
    return new Response(JSON.stringify(tables[key as keyof typeof tables]));
  };
}

test('public source loader records immutable versions and byte hashes; secondary cannot rescue primary failure', async () => {
  const loaded = await loadOperatorCostTables(syntheticNetwork());
  assert.equal(loaded.sources?.length, 7);
  const source = loaded.sources!.find(s => s.file.endsWith('character_table.json'))!;
  assert.equal(source.sha256, createHash('sha256').update(JSON.stringify(costTables().characters)).digest('hex'));
  assert.match(source.commit, /^[a-f0-9]{40}$/); assert.ok(Number.isFinite(Date.parse(source.readAt)));
  const missingCross = await loadOperatorCostTables(syntheticNetwork('crossCultivate'));
  assert.equal(calculateOperatorCost(missingCross, costSnapshot(), { name: '合成干员', target: { elite: 1, level: 1 } }).crossCheck.status, 'unavailable');
  await assert.rejects(loadOperatorCostTables(syntheticNetwork('constants')), /cost-source-unavailable:constants/);
});

test('public query and CLI use a real temporary snapshot, remain read-only, and render the same result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maa-cost-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const privateDirectory = join(root, 'private'); await mkdir(home); await mkdir(privateDirectory);
  await writeFile(join(home, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory }));
  const snapshotFile = join(privateDirectory, 'account-snapshot.json'); const before = JSON.stringify(costSnapshot()); await writeFile(snapshotFile, before);
  const request = { name: '合成干员', target: { elite: 2, level: 2 }, mode: 'no-craft' };
  const direct = await queryOperatorCost(request, { home, fetcher: syntheticNetwork() });
  const script = fileURLToPath(new URL('../skills/maa-core/scripts/operator-cost.ts', import.meta.url));
  const network = new URL('./fixtures/cost-network.mjs', import.meta.url).href;
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, MAA_SKILLS_HOME: home };
  const run = (format: string) => spawnSync(process.execPath, ['--import', network, script, 'query'], { cwd: root, input: JSON.stringify({ ...request, format }), encoding: 'utf8', env });
  const json = run('json'); assert.equal(json.status, 0, json.stderr); const cli = JSON.parse(json.stdout);
  assert.deepEqual(cli.total, direct.total); assert.deepEqual(cli.inventory, direct.inventory);
  const markdown = run('markdown'); assert.equal(markdown.status, 0, markdown.stderr);
  const withoutReadTimes = (value: string) => value.replace(/读取 \d{4}-[^\s]+/g, '读取 <actual-time>');
  assert.equal(withoutReadTimes(markdown.stdout.trim()), withoutReadTimes(formatOperatorCostMarkdown(cli).trim()));
  assert.equal(await readFile(snapshotFile, 'utf8'), before); assert.deepEqual(await readdir(privateDirectory), ['account-snapshot.json']);
  assert.deepEqual(await readdir(home), ['config.json']);
});

test('the public cost CLI executes through a real Windows development directory junction', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'maa-cost-junction-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), privateDirectory = join(root, 'private'); await mkdir(home); await mkdir(privateDirectory);
  await writeFile(join(home, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory }));
  await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(costSnapshot()));
  await symlink(resolve('skills/maa-core'), join(root, 'maa-core'), 'junction');
  const run = spawnSync(process.execPath, ['--import', new URL('./fixtures/cost-network.mjs', import.meta.url).href,
    join(root, 'maa-core/scripts/operator-cost.ts'), 'query'], {
    cwd: root, input: JSON.stringify({ name: '合成干员', target: { elite: 1, level: 1 } }), encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, MAA_SKILLS_HOME: home },
  });
  assert.equal(run.status, 0, run.stderr); assert.ok(run.stdout.trim(), 'successful CLI execution must produce a result');
  assert.deepEqual(JSON.parse(run.stdout).total, { materials: { mat: 2 }, lmd: 102, exp: 20 });
  assert.deepEqual(await readdir(privateDirectory), ['account-snapshot.json']);
});
