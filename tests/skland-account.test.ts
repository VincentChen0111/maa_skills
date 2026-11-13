import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { inspectCredentials, saveCredential } from '../skills/maa-core/scripts/credentials.ts';
import type { Protector } from '../skills/maa-core/scripts/credential-protection.ts';
import { parseMaaSnapshot, type AccountSnapshot } from '../skills/maa-core/scripts/account-snapshot.ts';
import { readSklandAccount, sklandSnapshot, compareAccountSnapshots, type SklandFetch } from '../skills/maa-core/scripts/skland-account.ts';
import { calculateOperatorCost } from '../skills/maa-core/scripts/operator-cost.ts';
import { queryBaseSkills } from '../skills/maa-core/scripts/base-query.ts';
import { sklandSecrets, sklandInfo, sklandCultivate, sklandBinding, sklandBindingEntry } from './fixtures/skland-data.ts';
import { costTables } from './fixtures/cost-data.ts';

type Trace = { kind: string; method: string; host: string; path: string; redirect: string | null; signed?: boolean; query?: string[]; accountMatches?: boolean;
  body?: Record<string, unknown>; credMatches?: boolean }[];
const doubles = await import(new URL('./fixtures/skland-double.mjs', import.meta.url).href) as {
  createSklandDouble(scenario?: { steps?: Record<string, unknown[]> }): { fetch: SklandFetch; trace: Trace } };
const protector = (await import(new URL('./fixtures/credential-protection-double.mjs', import.meta.url).href) as { windowsProtector: Protector }).windowsProtector;
const core = fileURLToPath(new URL('../skills/maa-core', import.meta.url));
const cli = join(core, 'scripts/skland-account.ts');
const readAt = '2026-11-13T08:00:00.000Z';

async function fixture(t: { after(fn: () => Promise<unknown>): void }, credential = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maa-skland-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'settings'), privateDirectory = join(root, 'private'), maaDirectory = join(root, 'maa');
  await mkdir(join(maaDirectory, 'config'), { recursive: true });
  await writeFile(join(maaDirectory, 'config/gui.json'), '{"synthetic":true}\n');
  await updateSettings({ language: 'zh-CN', privateDirectory, maaDirectory }, home);
  if (credential) await saveCredential('skland', sklandSecrets.userValue, { privateDirectory, protector });
  return { root, home, privateDirectory, maaDirectory };
}
const read = (f: { privateDirectory: string }, scenario: { steps?: Record<string, unknown[]> } = {}) => {
  const double = doubles.createSklandDouble(scenario);
  return { double, result: readSklandAccount({ privateDirectory: f.privateDirectory, fetcher: double.fetch, protector }) };
};
const state = async (f: { privateDirectory: string }) => (await inspectCredentials(f.privateDirectory)).credentials.find(item => item.service === 'skland')!.state;
const kinds = (trace: Trace) => trace.map(entry => entry.kind);

async function allFiles(directory: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) for (const [name, bytes] of await allFiles(path)) result.set(name, bytes);
    else result.set(path, await readFile(path));
  }
  return result;
}
const secretValues = () => [sklandSecrets.userValue, sklandSecrets.grantCode, sklandSecrets.cred, sklandSecrets.signKey, sklandSecrets.account,
  sklandSecrets.nickname, sklandSecrets.userId, sklandSecrets.avatarUrl];
async function assertNoSecrets(root: string, ...texts: string[]) {
  for (const value of secretValues()) {
    for (const text of texts) assert.equal(text.includes(value), false, 'output must not contain a token, cookie or account identifier');
    for (const [, bytes] of await allFiles(root)) assert.equal(bytes.includes(value), false, 'no saved file may contain a token or account identifier');
  }
}

function runCli(f: { root: string; home: string }, action: string, input: Record<string, unknown>, scenario: { steps?: Record<string, unknown[]> } = {}) {
  const scenarioFile = join(f.root, `scenario-${Math.random().toString(16).slice(2)}.json`), traceFile = `${scenarioFile}.trace`;
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/credential-boundary.mjs', import.meta.url).href,
    '--import', new URL('./fixtures/skland-network.mjs', import.meta.url).href, cli, action], {
    env: { ...process.env, MAA_SKILLS_HOME: f.home, MAA_CREDENTIAL_TEST_CORE: core, MAA_SKLAND_TEST_SCENARIO: scenarioFile, MAA_SKLAND_TEST_TRACE: traceFile },
    input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', traceFile, scenarioFile };
}

test('a read exchanges the pasted token, signs every data request and only reads binding, player info and cultivation data', async (t) => {
  const f = await fixture(t);
  const { double, result } = read(f);
  const outcome = await result;
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(kinds(double.trace), ['grant', 'cred', 'binding', 'info', 'cultivate']);
  for (const entry of double.trace) {
    assert.equal(entry.redirect, 'error', 'redirects are never followed with a credential');
    assert.ok(entry.kind === 'grant' || entry.kind === 'cred' ? entry.method === 'POST' : entry.method === 'GET', 'only the two exchange steps post');
  }
  assert.deepEqual(double.trace[0]!.body, { appCode: '4ca99fa6b56cc2ba', type: 0, tokenMatches: true });
  assert.deepEqual(double.trace[1]!.body, { kind: 1, codeMatches: true });
  for (const entry of double.trace.slice(2)) assert.equal(entry.signed, true, `${entry.kind} carries a valid signature`);
  for (const entry of double.trace.slice(3)) { assert.deepEqual(entry.query, ['uid']); assert.equal(entry.accountMatches, true); }
  assert.equal(outcome.credential, 'usable');
  assert.equal(await state(f), 'usable', 'the actual read marks this revision usable');
  const snapshot = outcome.snapshot!;
  assert.equal(snapshot.source, 'skland'); assert.equal(snapshot.version, 1);
  assert.ok(Number.isFinite(Date.parse(snapshot.readAt)));
  assert.deepEqual(snapshot.sourceTimes, { operators: null, inventory: null }, 'Skland gives no verified in-game data time');
  assert.equal(snapshot.coverage.operators.status, 'complete'); assert.equal(snapshot.coverage.inventory.status, 'complete');
  assert.equal(snapshot.coverage.base.status, 'complete');
  assert.deepEqual(snapshot.items, { '30012': 17, '4001': 1200, '3301': 0 }); assert.equal(snapshot.lmd, 1200);
  await assertNoSecrets(f.root, JSON.stringify(outcome));
});

test('Skland rarity counted from 0 becomes the snapshot 1-6 scale', () => {
  const snapshot = sklandSnapshot({ info: sklandInfo(), cultivate: sklandCultivate() }, readAt);
  assert.deepEqual(snapshot.operators.map(op => [op.id, op.rarity]), [['char_9001_synth', 6], ['char_9002_synth', 1]]);
  for (const raw of [6, -1, 'TIER_6', 2.5]) {
    const info = sklandInfo(); (info.charInfoMap.char_9001_synth as Record<string, unknown>).rarity = raw;
    const converted = sklandSnapshot({ info, cultivate: sklandCultivate() }, readAt);
    assert.equal(converted.operators[0]!.rarity, null, `${String(raw)} is not a verified zero-based rarity`);
    assert.equal(converted.coverage.operators.status, 'partial'); assert.ok(converted.coverage.operators.issues.includes('invalid-rarity'));
  }
});

test('Skland potential counted from 0 becomes the snapshot 1-6 scale', () => {
  const snapshot = sklandSnapshot({ info: sklandInfo(), cultivate: sklandCultivate() }, readAt);
  assert.deepEqual(snapshot.operators.map(op => [op.id, op.potential]), [['char_9001_synth', 1], ['char_9002_synth', 6]]);
  const info = sklandInfo(); delete (info.chars[0] as Record<string, unknown>).potentialRank;
  const missing = sklandSnapshot({ info, cultivate: sklandCultivate() }, readAt);
  assert.equal(missing.operators[0]!.potential, null, 'a missing potential stays unknown, not 1');
  assert.ok(missing.coverage.operators.issues.includes('missing-potential'));
});

test('skill level, mastery and modules come from Skland when present and stay unknown when absent', () => {
  const snapshot = sklandSnapshot({ info: sklandInfo(), cultivate: sklandCultivate() }, readAt);
  const [first, second] = snapshot.operators;
  assert.deepEqual({ ...first }, { id: 'char_9001_synth', name: '合成干员甲', rarity: 6, elite: 2, level: 60, potential: 1, skillLevel: 7,
    mastery: { 1: 3, 2: 0 }, modules: { uniequip_001_synth1: 1, uniequip_002_synth1: 2, uniequip_003_synth1: 0 } });
  assert.deepEqual({ ...second }, { id: 'char_9002_synth', name: '合成干员乙', rarity: 1, elite: 0, level: 30, potential: 6, skillLevel: 4, mastery: { 1: 0 }, modules: {} });
  const info = sklandInfo();
  for (const key of ['mainSkillLvl', 'skills', 'equip']) delete (info.chars[0] as Record<string, unknown>)[key];
  const absent = sklandSnapshot({ info, cultivate: sklandCultivate() }, readAt);
  assert.equal(absent.operators[0]!.skillLevel, null); assert.equal(absent.operators[0]!.mastery, null); assert.equal(absent.operators[0]!.modules, null);
  assert.equal(absent.coverage.operators.status, 'partial');
  for (const issue of ['missing-skill-level', 'missing-mastery', 'missing-modules']) assert.ok(absent.coverage.operators.issues.includes(issue), issue);
});

test('the three categories without a source are written as no-source and never filled with zero or inferred', () => {
  const snapshot = sklandSnapshot({ info: sklandInfo(), cultivate: sklandCultivate() }, readAt);
  for (const key of ['medicine', 'vouchers', 'stageClears'] as const) assert.deepEqual(snapshot.coverage[key], { status: 'unavailable', issues: ['no-source'] });
  assert.equal(JSON.stringify(snapshot).includes('mainStageProgress'), false, 'stage progress is not turned into per-stage clears');
  assert.equal(snapshot.items['30012'], 17); assert.equal(Object.keys(snapshot.items).length, 3, 'no item is added with zero');
});

test('the base keeps rooms, stationed operators and raw mood with its own time; account fields stay out of the snapshot', () => {
  const snapshot = sklandSnapshot({ info: sklandInfo(), cultivate: sklandCultivate() }, readAt);
  const rooms = snapshot.base!.rooms;
  assert.deepEqual(rooms.map(room => [room.type, room.slotId, room.level, room.operators.length]), [
    ['control', 'slot_control', 5, 0], ['power', 'slot_power_1', 3, 1], ['manufacture', 'slot_manu_1', 3, 1], ['dormitory', 'slot_dorm_1', 5, 0], ['training', 'slot_train', 3, 1]]);
  assert.deepEqual(rooms[2]!.operators[0], { id: 'char_9001_synth', moodRaw: 8_640_000, moodAt: '2025-11-13T00:00:00.000Z' });
  assert.deepEqual(rooms[4]!.operators[0], { id: 'char_9001_synth', role: 'trainee', moodRaw: 7_200_000, moodAt: '2025-11-13T00:00:00.000Z' });
  const text = JSON.stringify(snapshot);
  for (const value of secretValues()) assert.equal(text.includes(value), false);
  for (const key of ['recruit', 'avatar', 'secretary', 'nickName', 'skinId', 'ap', 'mainStageProgress']) assert.equal(text.includes(`"${key}"`), false, key);
  const info = sklandInfo(); delete (info as Record<string, unknown>).building;
  const missing = sklandSnapshot({ info, cultivate: sklandCultivate() }, readAt);
  assert.equal(missing.base, null); assert.deepEqual(missing.coverage.base, { status: 'missing', issues: ['not-returned'] });
});

test('a missing credential stops before any request and never pretends there is new data', async (t) => {
  const f = await fixture(t, false);
  const { double, result } = read(f);
  const outcome = await result;
  assert.equal(outcome.status, 'credential-unset'); assert.equal(outcome.snapshot, null); assert.deepEqual(double.trace, []);
});

test('a token the service refuses to exchange is recorded expired; nothing else is requested', async (t) => {
  const f = await fixture(t);
  const { double, result } = read(f, { steps: { grant: [{ status: 3 }] } });
  const outcome = await result;
  assert.equal(outcome.status, 'credential-expired'); assert.equal(outcome.credential, 'expired'); assert.equal(outcome.snapshot, null);
  assert.deepEqual(kinds(double.trace), ['grant']);
  assert.equal(await state(f), 'expired');
});

test('the two-level refresh follows the verified order and gives up with an expired credential', async (t) => {
  const cases: [Record<string, unknown[]>, string[], string][] = [
    [{ binding: [{ code: 10000 }, 'ok'] }, ['grant', 'cred', 'binding', 'refresh', 'binding', 'info', 'cultivate'], 'ok'],
    [{ binding: [{ code: 10002 }, 'ok'] }, ['grant', 'cred', 'binding', 'grant', 'cred', 'binding', 'info', 'cultivate'], 'ok'],
    [{ info: [{ code: 10000 }, { code: 10002 }, 'ok'] }, ['grant', 'cred', 'binding', 'info', 'refresh', 'info', 'grant', 'cred', 'info', 'cultivate'], 'ok'],
    [{ binding: [{ code: 10000 }], refresh: [{ code: 10002 }] }, ['grant', 'cred', 'binding', 'refresh', 'grant', 'cred', 'binding'], 'credential-expired'],
    [{ binding: [{ code: 10002 }, { code: 10000 }] }, ['grant', 'cred', 'binding', 'grant', 'cred', 'binding'], 'credential-expired'],
    [{ binding: [{ code: 10000 }, { code: 10000 }, { code: 10000 }] }, ['grant', 'cred', 'binding', 'refresh', 'binding', 'grant', 'cred', 'binding'], 'credential-expired'],
    [{ binding: [{ code: 10002 }], grant: ['ok', { status: 3 }] }, ['grant', 'cred', 'binding', 'grant'], 'credential-expired'],
  ];
  for (const [steps, expected, status] of cases) {
    const f = await fixture(t);
    const { double, result } = read(f, { steps });
    const outcome = await result;
    assert.deepEqual(kinds(double.trace), expected, JSON.stringify(steps));
    assert.equal(outcome.status, status, JSON.stringify(steps));
    assert.equal(await state(f), status === 'ok' ? 'usable' : 'expired');
    for (const entry of double.trace.filter(item => item.kind === 'refresh')) assert.equal(entry.credMatches, true);
  }
});

test('network failures, refusals the service does not tie to the credential and broken responses are reported without marking expiry', async (t) => {
  for (const [steps, status] of [
    [{ grant: ['network'] }, 'network-failed'], [{ binding: ['network'] }, 'network-failed'], [{ grant: [{ http: 503 }] }, 'service-error'],
    [{ grant: [{ http: 429 }] }, 'service-error'], [{ cred: [{ code: 10001 }] }, 'service-error'], [{ binding: [{ code: 10001 }] }, 'service-error'],
    [{ info: [{ code: 50000 }] }, 'service-error'], [{ binding: ['not-json'] }, 'response-invalid'], [{ info: [{ data: { chars: 'broken' } }] }, 'ok'],
  ] as [Record<string, unknown[]>, string][]) {
    const f = await fixture(t);
    const { double, result } = read(f, { steps });
    const outcome = await result;
    assert.equal(outcome.status, status, JSON.stringify(steps));
    assert.notEqual(await state(f), 'expired', `${JSON.stringify(steps)} must not mark the credential expired`);
    assert.equal(double.trace.filter(item => item.kind === 'refresh').length, 0, 'no refresh without an authorization signal');
    if (status === 'ok') assert.deepEqual(outcome.snapshot!.coverage.operators, { status: 'invalid', issues: ['invalid-player-info'] });
  }
});

test('an incomplete cultivation read still yields a new snapshot with unknown inventory instead of old data', async (t) => {
  for (const [step, issue] of [['network', 'network-failed'], [{ code: 10001 }, 'service-error'], [{ data: { items: 'x' } }, 'invalid-cultivate']] as const) {
    const f = await fixture(t);
    const { result } = read(f, { steps: { cultivate: [step] } });
    const outcome = await result;
    assert.equal(outcome.status, 'ok');
    assert.deepEqual(outcome.snapshot!.items, {}); assert.equal(outcome.snapshot!.lmd, null);
    assert.equal(outcome.snapshot!.coverage.inventory.issues[0], issue);
    assert.ok(['unavailable', 'invalid'].includes(outcome.snapshot!.coverage.inventory.status));
    assert.equal(outcome.snapshot!.coverage.operators.status, 'complete');
  }
});

test('the bound role is Skland\'s default; none or several without a default stop the read', async (t) => {
  const other = '91000000888';
  for (const [binding, status] of [
    [sklandBinding([]), 'binding-missing'], [sklandBinding([sklandBindingEntry(sklandSecrets.account, false, true)]), 'binding-missing'],
    [sklandBinding([sklandBindingEntry(sklandSecrets.account, false), sklandBindingEntry(other, false)], null), 'binding-ambiguous'],
    [sklandBinding([sklandBindingEntry(other, false), sklandBindingEntry(sklandSecrets.account, true)], null), 'ok'],
    [sklandBinding([sklandBindingEntry(other, false), sklandBindingEntry(sklandSecrets.account, false)]), 'ok'],
    [sklandBinding([sklandBindingEntry(sklandSecrets.account, false)], null), 'ok'],
  ] as const) {
    const f = await fixture(t);
    const { double, result } = read(f, { steps: { binding: [{ data: binding }] } });
    const outcome = await result;
    assert.equal(outcome.status, status, JSON.stringify(binding));
    if (status === 'ok') assert.ok(double.trace.filter(entry => entry.kind === 'info').every(entry => entry.accountMatches));
    else assert.deepEqual(kinds(double.trace), ['grant', 'cred', 'binding']);
  }
});

test('the import CLI saves a separate Skland snapshot, leaves the MAA snapshot and MAA config untouched and prints no secrets', async (t) => {
  const f = await fixture(t);
  const maaSnapshot = '{"synthetic":"maa snapshot"}\n';
  await writeFile(join(f.privateDirectory, 'account-snapshot.json'), maaSnapshot);
  const before = await allFiles(f.maaDirectory);
  const result = runCli(f, 'import', { format: 'json' });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true); assert.equal(output.saved, true); assert.equal(output.source, 'skland'); assert.equal(output.credential, 'usable');
  assert.equal(output.operatorCount, 2); assert.equal(output.itemCount, 3); assert.equal(output.lmd, 1200); assert.equal(output.baseRoomCount, 5);
  assert.deepEqual(output.disclosures, ['no-public-statement-as-of-2026-11-13', 'lag-unmeasured']);
  assert.match(output.summary, /森空岛/); assert.match(output.summary, /截至 2026-11-13/); assert.match(output.summary, /滞后/);
  assert.match(output.summary, /理智药等药剂：无来源/); assert.match(output.summary, /凭证和各类券：无来源/); assert.match(output.summary, /逐关通关状态：无来源/);
  const saved = JSON.parse(await readFile(join(f.privateDirectory, 'account-snapshot-skland.json'), 'utf8')) as AccountSnapshot;
  assert.equal(saved.source, 'skland'); assert.equal(saved.readAt, output.readAt);
  assert.equal(await readFile(join(f.privateDirectory, 'account-snapshot.json'), 'utf8'), maaSnapshot);
  assert.deepEqual(await allFiles(f.maaDirectory), before);
  assert.deepEqual((await readdir(f.privateDirectory)).sort(), ['account-snapshot-skland.json', 'account-snapshot.json', 'credentials']);
  const trace = JSON.parse(await readFile(result.traceFile, 'utf8')) as Trace;
  assert.deepEqual(kinds(trace), ['grant', 'cred', 'binding', 'info', 'cultivate']);
  await updateSettings({ language: 'en' }, f.home);
  const english = runCli(f, 'inspect', { format: 'markdown', currentLanguage: 'en' });
  assert.equal(english.code, 0, english.stderr); assert.match(english.stdout, /Skland/);
  await assertNoSecrets(f.root, result.stdout, result.stderr, english.stdout, english.stderr);
});

test('inspect reads without saving; failures exit non-zero with an actionable code and keep the earlier Skland snapshot unchanged', async (t) => {
  const f = await fixture(t);
  const inspected = runCli(f, 'inspect', {});
  assert.equal(inspected.code, 0, inspected.stderr); assert.equal(JSON.parse(inspected.stdout).saved, false);
  await assert.rejects(readFile(join(f.privateDirectory, 'account-snapshot-skland.json')));
  assert.equal(runCli(f, 'import', {}).code, 0);
  const earlier = await readFile(join(f.privateDirectory, 'account-snapshot-skland.json'), 'utf8');
  for (const [steps, error, repair] of [
    [{ grant: [{ status: 3 }] }, 'credential-expired', 'reenter-credential'], [{ binding: ['network'] }, 'network-failed', 'retry-later'],
    [{ binding: [{ code: 10001 }] }, 'service-error', 'retry-later'],
  ] as [Record<string, unknown[]>, string, string][]) {
    const failed = runCli(f, 'import', {}, { steps });
    assert.equal(failed.code, 1, failed.stdout);
    const output = JSON.parse(failed.stderr);
    assert.equal(output.ok, false); assert.equal(output.saved, false); assert.equal(output.error, error); assert.equal(output.repair, repair);
    assert.match(output.summary, /没有读到新的账号数据/);
    assert.equal(await readFile(join(f.privateDirectory, 'account-snapshot-skland.json'), 'utf8'), earlier, 'the earlier snapshot is kept, not replaced or re-dated');
    await assertNoSecrets(f.root, failed.stdout, failed.stderr);
  }
  const unset = await fixture(t, false);
  const missing = runCli(unset, 'import', {});
  assert.equal(missing.code, 1); const output = JSON.parse(missing.stderr);
  assert.equal(output.error, 'credential-unset'); assert.equal(output.repair, 'enter-credential');
  assert.match(output.summary, /credentials\.ts input skland/); assert.doesNotMatch(output.summary, /密码/);
  assert.deepEqual(JSON.parse(await readFile(missing.traceFile, 'utf8')), []);
});

test('the same synthetic account through MAA and Skland is readable by the same tool, and compare shows conflicts with times without merging', async (t) => {
  const f = await fixture(t);
  const maa = parseMaaSnapshot(JSON.stringify([
    { taskchain: 'Depot', what: 'DepotInfo', details: { done: true, syncTime: '2026-11-12T10:00:00Z', data: { '30012': 15, '4001': 1200 } } },
    { taskchain: 'OperBox', what: 'OperBoxInfo', details: { done: true, syncTime: '2026-11-12T10:00:00Z', own_opers: [
      { id: 'char_9001_synth', name: '合成干员甲', own: true, rarity: 6, elite: 2, level: 55, potential: 1 },
      { id: 'char_9003_synth', name: '合成干员丙', own: true, rarity: 4, elite: 1, level: 10, potential: 2 }] } },
  ]), '2026-11-12T10:05:00.000Z');
  const skland = sklandSnapshot({ info: sklandInfo(), cultivate: sklandCultivate() }, readAt);
  const tables = costTables();
  const catalog = tables.characters as Record<string, Record<string, unknown>>;
  const [id] = Object.keys(catalog).filter(key => key.startsWith('char_'));
  const costs = [maa, skland].map(source => {
    const snapshot = structuredClone(source) as AccountSnapshot;
    snapshot.operators = [{ ...snapshot.operators[0]!, id: id!, name: String(catalog[id!]!.name) }];
    const cost = calculateOperatorCost(tables, snapshot, { name: String(catalog[id!]!.name), target: { mastery: { 1: 3 } } });
    assert.ok(!cost.issues.includes('snapshot:invalid-or-incomplete'), `${source.source} snapshot is accepted by the cost tool`);
    return cost;
  });
  assert.ok(costs[0]!.issues.includes('current.mastery.1:unknown-or-invalid'), 'MAA recognition gives no mastery');
  assert.equal(costs[1]!.currentSources['mastery.1'], 'snapshot', 'the Skland snapshot fills mastery');
  const baseTables = { characters: { char_9001_synth: { name: '合成干员甲' } }, building: { chars: { char_9001_synth: { buffChar: [{ buffData: [
    { buffId: 'synthetic', cond: { phase: 'PHASE_0', level: 1 } }] }] } }, buffs: { synthetic: { buffName: '合成', roomType: 'MANUFACTURE', description: '合成说明' } } } };
  for (const source of [maa, skland]) {
    const base = queryBaseSkills(source, baseTables, { operators: ['合成干员甲'] });
    assert.deepEqual(base.operators.map(op => [op.ownership, op.elite]), [['owned', 2]], `${source.source} snapshot is accepted by the base query`);
  }
  const comparison = compareAccountSnapshots(maa, skland);
  assert.deepEqual(comparison.sides.map(side => [side.source, side.readAt]), [['maa', '2026-11-12T10:05:00.000Z'], ['skland', readAt]]);
  assert.deepEqual(comparison.sides[0]!.sourceTimes, { operators: '2026-11-12T10:00:00.000Z', inventory: '2026-11-12T10:00:00.000Z' });
  assert.equal(comparison.sameAccount, 'unverifiable');
  assert.deepEqual(comparison.operators.differences, [{ id: 'char_9001_synth', name: '合成干员甲', field: 'level', values: [55, 60] }]);
  assert.deepEqual(comparison.operators.onlyIn, { maa: ['char_9003_synth'], skland: ['char_9002_synth'] });
  assert.deepEqual(comparison.items.differences, [{ id: '30012', values: [15, 17] }]);
  assert.deepEqual(comparison.lmd, { values: [1200, 1200], differs: false });
  await writeFile(join(f.privateDirectory, 'account-snapshot.json'), JSON.stringify(maa));
  await writeFile(join(f.privateDirectory, 'account-snapshot-skland.json'), JSON.stringify(skland));
  const before = await allFiles(f.privateDirectory);
  const result = runCli(f, 'compare', { format: 'markdown' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /2026-11-12T10:05:00\.000Z/); assert.match(result.stdout, new RegExp(readAt.replaceAll('.', '\\.')));
  assert.match(result.stdout, /合成干员甲.*level.*55.*60/); assert.match(result.stdout, /不合并/);
  const after = await allFiles(f.privateDirectory);
  for (const [path, bytes] of before) if (!path.includes('scenario-')) assert.deepEqual(after.get(path), bytes, 'compare writes nothing');
  assert.equal(JSON.parse(await readFile(result.traceFile, 'utf8')).length, 0, 'compare makes no network request');
  await rm(join(f.privateDirectory, 'account-snapshot-skland.json'));
  const missing = runCli(f, 'compare', {});
  assert.equal(missing.code, 1);
  assert.deepEqual(JSON.parse(missing.stderr), { ok: false, saved: false, error: 'snapshot-missing', missing: ['skland'] });
});
