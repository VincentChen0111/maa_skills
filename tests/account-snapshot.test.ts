import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseMaaSnapshot, importMaaSnapshot, inspectMaaSnapshot, formatAccountSummary } from '../skills/maa-core/scripts/account-snapshot.ts';

const readAt = '2026-11-11T00:00:00.000Z';
const callbacks = [
  { taskchain: 'Depot', what: 'DepotInfo', details: { done: true, data: { '30012': 17, '4001': 1200 } } },
  { taskchain: 'OperBox', what: 'OperBoxInfo', details: { done: true, own_opers: [
    { id: 'char_001_synthetic', name: '合成干员', own: true, rarity: 5, elite: 2, level: 40, potential: 1 },
  ] } },
];

test('completed MAA recognition preserves known facts and explicit unavailable fields', () => {
  const snapshot = parseMaaSnapshot(JSON.stringify(callbacks), readAt);
  assert.equal(snapshot.source, 'maa');
  assert.equal(snapshot.readAt, readAt);
  assert.deepEqual(snapshot.items, { '30012': 17, '4001': 1200 });
  assert.equal(snapshot.lmd, 1200);
  assert.deepEqual(snapshot.operators, [{ id: 'char_001_synthetic', name: '合成干员', rarity: 5,
    elite: 2, level: 40, potential: 1, skillLevel: null, mastery: null, modules: null }]);
  assert.equal(snapshot.coverage.operators.status, 'complete');
  assert.equal(snapshot.coverage.inventory.status, 'complete');
  assert.equal(snapshot.base, null);
  assert.equal(snapshot.coverage.base.status, 'unavailable');
});

test('latest unfinished recognition supersedes old completion and missing fields stay unknown', () => {
  const input = [...callbacks,
    { taskchain: 'Depot', what: 'DepotInfo', details: { done: false, data: { '30012': 4 } } },
    { taskchain: 'OperBox', what: 'OperBoxInfo', details: { done: true, own_opers: [
      { id: 'char_002_synthetic', name: '缺失练度', own: true, level: 20 },
    ] } },
  ];
  const snapshot = parseMaaSnapshot(JSON.stringify(input), readAt);
  assert.equal(snapshot.coverage.inventory.status, 'pending');
  assert.deepEqual(snapshot.items, {});
  assert.equal(snapshot.lmd, null);
  assert.equal(snapshot.coverage.operators.status, 'partial');
  assert.equal(snapshot.operators[0]?.elite, null);
  assert.equal(snapshot.operators[0]?.level, 20);
  assert.ok(snapshot.coverage.operators.issues.includes('missing-elite'));
  const missing = parseMaaSnapshot('[]', readAt);
  assert.equal(missing.coverage.inventory.status, 'missing');
  assert.equal(missing.coverage.operators.status, 'missing');
});

test('invalid recognition is reported without exposing raw callbacks or accepting duplicate facts', () => {
  const malformed = parseMaaSnapshot('{broken-synthetic-credential', readAt);
  assert.equal(malformed.coverage.inventory.status, 'invalid');
  assert.equal(malformed.coverage.operators.status, 'invalid');
  assert.ok(!JSON.stringify(malformed).includes('synthetic-credential'));
  const bad = structuredClone(callbacks);
  bad[0]!.details.data = { '30012': -1 } as typeof bad[0]['details']['data'];
  const snapshot = parseMaaSnapshot(JSON.stringify(bad), readAt);
  assert.equal(snapshot.coverage.inventory.status, 'invalid');
  assert.deepEqual(snapshot.items, {});
  assert.equal(snapshot.coverage.operators.status, 'complete');
  const duplicate = structuredClone(callbacks[1]!);
  duplicate.details.own_opers!.push(duplicate.details.own_opers![0]!);
  const dup = parseMaaSnapshot(JSON.stringify([duplicate]), readAt);
  assert.equal(dup.coverage.operators.status, 'invalid');
  assert.deepEqual(dup.operators, []);
});

test('GUI data files retain their original scan times and reject other account sources', () => {
  const snapshot = parseMaaSnapshot(JSON.stringify({
    depot: { done: true, data: { '30012': 9 }, syncTime: '2026-11-10T18:30:00+08:00' },
    operBox: { done: true, source: 'local', own_opers: callbacks[1]!.details.own_opers, syncTime: '2026-11-10T10:00:00Z' },
  }), readAt);
  assert.equal(snapshot.items['30012'], 9);
  assert.equal(snapshot.lmd, null);
  assert.equal(snapshot.sourceTimes.inventory, '2026-11-10T10:30:00.000Z');
  assert.equal(snapshot.sourceTimes.operators, '2026-11-10T10:00:00.000Z');
  assert.equal(snapshot.readAt, readAt);
  const wrong = parseMaaSnapshot(JSON.stringify({ operBox: { done: true, source: 'yituliu', own_opers: callbacks[1]!.details.own_opers } }), readAt);
  assert.equal(wrong.coverage.operators.status, 'invalid');
  assert.deepEqual(wrong.operators, []);
});


test('import CLI writes only a snapshot to the configured private directory and prints a safe localized summary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-account-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const privateDirectory = join(root, 'private');
  await mkdir(home); await mkdir(privateDirectory);
  const config = { language: 'en', privateDirectory };
  await writeFile(join(home, 'config.json'), JSON.stringify(config));
  const inputFile = join(root, 'callbacks.json');
  const raw = JSON.stringify([...callbacks, { credentials: 'synthetic-account-secret', accountId: '<synthetic-id>' }]);
  await writeFile(inputFile, raw);
  const before = Date.now();
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../skills/maa-core/scripts/account-snapshot.ts', import.meta.url)), 'import'], {
    input: JSON.stringify({ callbackFile: inputFile, format: 'markdown' }), encoding: 'utf8',
    env: { ...process.env, HOME: root, USERPROFILE: root, MAA_SKILLS_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(await readFile(join(privateDirectory, 'account-snapshot.json'), 'utf8'));
  assert.ok(Date.parse(snapshot.readAt) >= before && Date.parse(snapshot.readAt) <= Date.now());
  assert.deepEqual(snapshot.items, { '30012': 17, '4001': 1200 });
  assert.match(result.stdout, /MAA account snapshot/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-account-secret|synthetic-id|char_001|合成干员/);
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-account-secret|synthetic-id/);
  assert.deepEqual(await readdir(privateDirectory), ['account-snapshot.json']);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), config);
  assert.equal(await readFile(inputFile, 'utf8'), raw);
});

test('empty completed recognitions remain partial instead of certifying an empty account', () => {
  const snapshot = parseMaaSnapshot(JSON.stringify([
    { taskchain: 'Depot', what: 'DepotInfo', details: { done: true, data: {} } },
    { taskchain: 'OperBox', what: 'OperBoxInfo', details: { done: true, own_opers: [] } },
  ]), readAt);
  assert.equal(snapshot.coverage.inventory.status, 'partial');
  assert.equal(snapshot.coverage.operators.status, 'partial');
  assert.equal(snapshot.lmd, null);
});

test('a later recognition error prevents an old completed callback from being presented as current', () => {
  const snapshot = parseMaaSnapshot(JSON.stringify([...callbacks,
    { taskchain: 'Depot', what: 'DepotTemplateLoadError', details: { item_ids: ['synthetic-error'] } },
  ]), readAt);
  assert.equal(snapshot.coverage.inventory.status, 'invalid');
  assert.deepEqual(snapshot.items, {});
  assert.equal(snapshot.coverage.operators.status, 'complete');
});


test('occupied and failed atomic writes preserve the previous private snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-account-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'source.json');
  await writeFile(input, JSON.stringify(callbacks));
  const target = join(root, 'account-snapshot.json');
  await writeFile(target, 'previous-snapshot');
  const lock = join(root, '.account-snapshot.lock');
  await writeFile(lock, 'previous-owner-evidence');
  await assert.rejects(importMaaSnapshot({ callbackFile: input }, root), /EEXIST/);
  assert.equal(await readFile(lock, 'utf8'), 'previous-owner-evidence');
  assert.equal(await readFile(target, 'utf8'), 'previous-snapshot');
  await rm(lock);
  if (process.platform === 'win32') {
    await chmod(target, 0o444);
    try {
      await assert.rejects(importMaaSnapshot({ callbackFile: input }, root), /EPERM|EACCES/);
      assert.equal(await readFile(target, 'utf8'), 'previous-snapshot');
      assert.deepEqual((await readdir(root)).sort(), ['account-snapshot.json', 'source.json']);
    } finally { await chmod(target, 0o600); }
  }
});


test('configured MAA data is read without modifying it and missing source files stay missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-account-configured-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const maa = join(root, 'maa'); await mkdir(join(maa, 'data'), { recursive: true });
  const raw = JSON.stringify({ done: true, data: { '30012': 3 }, syncTime: '2026-11-10T18:30:00+08:00' });
  await writeFile(join(maa, 'data/DepotData.json'), raw);
  await writeFile(join(root, 'config.json'), JSON.stringify({ maaDirectory: maa }));
  const snapshot = await inspectMaaSnapshot({}, root);
  assert.deepEqual(snapshot.items, { '30012': 3 });
  assert.equal(snapshot.coverage.operators.status, 'missing');
  assert.equal(await readFile(join(maa, 'data/DepotData.json'), 'utf8'), raw);
  assert.deepEqual((await readdir(root)).sort(), ['config.json', 'maa']);
});


test('Markdown reports original scan time separately from the later read time', () => {
  const snapshot = parseMaaSnapshot(JSON.stringify({ depot: { done: true, data: { '30012': 9 }, syncTime: '2026-11-10T10:30:00Z' } }), readAt);
  const markdown = formatAccountSummary(snapshot, 'en');
  assert.match(markdown, /2026-11-10T10:30:00.000Z/);
  assert.match(markdown, /2026-11-11T00:00:00.000Z/);
});

