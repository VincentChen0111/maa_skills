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
import { readSklandAccount, sklandSnapshot, compareAccountSnapshots, runSklandRead, sklandVerdicts, type SklandFetch, type SnapshotDomain } from '../skills/maa-core/scripts/skland-account.ts';
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
  assert.equal(missing.base, null); assert.deepEqual(missing.coverage.base, { status: 'invalid', issues: ['not-returned'] }, 'a code-0 reply without the base is an invalid reply');
  const unbuilt: Record<string, unknown> = sklandInfo(); for (const key of ['meeting', 'hire', 'training']) delete (unbuilt.building as Record<string, unknown>)[key];
  assert.equal(sklandSnapshot({ info: unbuilt, cultivate: sklandCultivate() }, readAt).coverage.base.status, 'complete', 'optional rooms may be absent when not built');
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

test('the two-level refresh follows the verified order; only an explicit grant refusal records expiry', async (t) => {
  const cases: [Record<string, unknown[]>, string[], string, string][] = [
    [{ binding: [{ code: 10000 }, 'ok'] }, ['grant', 'cred', 'binding', 'refresh', 'binding', 'info', 'cultivate'], 'ok', 'usable'],
    [{ binding: [{ code: 10002 }, 'ok'] }, ['grant', 'cred', 'binding', 'grant', 'cred', 'binding', 'info', 'cultivate'], 'ok', 'usable'],
    [{ info: [{ code: 10000 }, { code: 10002 }, 'ok'] }, ['grant', 'cred', 'binding', 'info', 'refresh', 'info', 'grant', 'cred', 'info', 'cultivate'], 'ok', 'usable'],
    // The grant endpoint accepted the token again in this read, so a persisting 10000/10002 is a signature or header problem.
    [{ binding: [{ code: 10000 }], refresh: [{ code: 10002 }] }, ['grant', 'cred', 'binding', 'refresh', 'grant', 'cred', 'binding'], 'signature-rejected', 'unverified'],
    [{ binding: [{ code: 10002 }, { code: 10000 }] }, ['grant', 'cred', 'binding', 'grant', 'cred', 'binding'], 'signature-rejected', 'unverified'],
    [{ binding: [{ code: 10000 }, { code: 10000 }, { code: 10000 }] }, ['grant', 'cred', 'binding', 'refresh', 'binding', 'grant', 'cred', 'binding'], 'signature-rejected', 'unverified'],
    [{ binding: [{ code: 10002 }], grant: ['ok', { status: 3 }] }, ['grant', 'cred', 'binding', 'grant'], 'credential-expired', 'expired'],
  ];
  for (const [steps, expected, status, saved] of cases) {
    const f = await fixture(t);
    const { double, result } = read(f, { steps });
    const outcome = await result;
    assert.deepEqual(kinds(double.trace), expected, JSON.stringify(steps));
    assert.equal(outcome.status, status, JSON.stringify(steps));
    assert.equal(await state(f), saved, JSON.stringify(steps));
    for (const entry of double.trace.filter(item => item.kind === 'refresh')) assert.equal(entry.credMatches, true);
  }
});

test('a reader clock ten minutes off is reported as a signature problem and never marks the valid token expired', async (t) => {
  const f = await fixture(t);
  const double = doubles.createSklandDouble();
  const outcome = await readSklandAccount({ privateDirectory: f.privateDirectory, fetcher: double.fetch, protector, now: () => new Date(Date.now() - 600_000) });
  assert.deepEqual(kinds(double.trace), ['grant', 'cred', 'binding', 'refresh', 'binding', 'grant', 'cred', 'binding']);
  assert.ok(double.trace.filter(entry => entry.kind === 'binding').every(entry => entry.signed === false), 'the double saw stale signatures');
  assert.equal(outcome.status, 'signature-rejected'); assert.equal(outcome.credential, 'unchanged'); assert.equal(outcome.snapshot, null);
  assert.equal(await state(f), 'unverified', 'the token the grant endpoint accepted stays as it was');
});

test('network failures, refusals the service does not tie to the credential and broken responses are reported without marking expiry', async (t) => {
  for (const [steps, status] of [
    [{ grant: ['network'] }, 'network-failed'], [{ binding: ['network'] }, 'network-failed'], [{ grant: [{ http: 503 }] }, 'service-error'],
    [{ grant: [{ http: 429 }] }, 'service-error'], [{ cred: [{ code: 10001 }] }, 'service-error'], [{ binding: [{ code: 10001 }] }, 'service-error'],
    [{ info: [{ code: 50000 }] }, 'service-error'], [{ binding: ['not-json'] }, 'response-invalid'], [{ info: [{ data: { chars: 'broken' } }] }, 'response-invalid'],
    [{ info: [{ data: { status: {}, charList: [], buildingInfo: {} } }] }, 'response-invalid'],
  ] as [Record<string, unknown[]>, string][]) {
    const f = await fixture(t);
    const { double, result } = read(f, { steps });
    const outcome = await result;
    assert.equal(outcome.status, status, JSON.stringify(steps));
    assert.equal(outcome.snapshot, null, 'player info without the checked operator structure is not a usable read');
    assert.notEqual(await state(f), 'expired', `${JSON.stringify(steps)} must not mark the credential expired`);
    assert.equal(double.trace.filter(item => item.kind === 'refresh').length, 0, 'no refresh without an authorization signal');
  }
});

test('a failed cultivation request leaves inventory unavailable with its reason in the read result', async (t) => {
  for (const [step, issue] of [['network', 'network-failed'], [{ code: 10001 }, 'service-error'], [{ code: 10000 }, 'signature-rejected'],
    [{ data: { items: 'x' } }, 'invalid-cultivate']] as const) {
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
    [{ binding: [{ code: 10001 }] }, 'service-error', 'retry-later'], [{ binding: [{ code: 10000 }] }, 'signature-rejected', 'check-system-time'],
    // The reviewer's format change: code 0, but player info and cultivation no longer have the checked structure.
    [{ info: [{ data: { status: {}, charList: [], buildingInfo: {} } }], cultivate: [{ data: { itemList: [] } }] }, 'response-invalid', 'report-issue'],
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

test('the import CLI wires the read verdict: a read with a domain not read never replaces the existing snapshot; only a first snapshot may be partial', async (t) => {
  const noBuilding: Record<string, unknown> = sklandInfo(); delete noBuilding.building;
  const partialReads: [Record<string, unknown[]>, string, string, string][] = [
    [{ cultivate: ['network'] }, 'inventory', 'network-failed', 'retry-later'], [{ info: [{ data: noBuilding }] }, 'base', 'not-returned', 'report-issue'],
    [{ cultivate: [{ data: { ...sklandCultivate(), items: [] } }] }, 'inventory', 'empty-response', 'report-issue'],
  ];
  const f = await fixture(t);
  assert.equal(runCli(f, 'import', {}).code, 0);
  const file = join(f.privateDirectory, 'account-snapshot-skland.json');
  const earlier = await readFile(file, 'utf8');
  for (const [steps, domain, reason, repair] of partialReads) {
    const partial = runCli(f, 'import', {}, { steps });
    assert.equal(partial.code, 0, partial.stderr);
    const output = JSON.parse(partial.stdout);
    assert.equal(output.ok, true); assert.equal(output.saved, false); assert.deepEqual(output.failedDomains, [domain]); assert.equal(output.repair, repair);
    assert.ok(output.coverage[domain].issues.includes(reason), JSON.stringify(output.coverage[domain]));
    assert.match(output.summary, /已有的森空岛快照保持不变/);
    assert.equal(await readFile(file, 'utf8'), earlier, `${JSON.stringify(steps)} must not replace the existing snapshot`);
  }
  const fresh = await fixture(t);
  const first = runCli(fresh, 'import', {}, { steps: partialReads[0]![0] });
  assert.equal(first.code, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.saved, true); assert.deepEqual(output.failedDomains, ['inventory']);
  const saved = JSON.parse(await readFile(join(fresh.privateDirectory, 'account-snapshot-skland.json'), 'utf8')) as AccountSnapshot;
  assert.deepEqual(saved.coverage.inventory, { status: 'unavailable', issues: ['network-failed'] });
  assert.deepEqual(saved.items, {}); assert.equal(saved.lmd, null); assert.equal(saved.operators.length, 2);
  assert.match(output.summary, /这是第一份森空岛快照/);
});

// Conformance: every producer path of each domain against every consumer of the one read verdict.
test('conformance: every producer of operators, inventory and base against every consumer of the read verdict', async (t) => {
  type Steps = Record<string, unknown[]>;
  const info = (change: (value: Record<string, any>) => void): Steps => { const value: Record<string, any> = sklandInfo(); change(value); return { info: [{ data: value }] }; };
  const cultivate = (change: (value: Record<string, any>) => void): Steps => { const value: Record<string, any> = sklandCultivate(); change(value); return { cultivate: [{ data: value }] }; };
  type Expected = { error: string; repair: string } | { failed: SnapshotDomain[]; repair: string | undefined; first: Partial<Record<SnapshotDomain, string>> };
  const infoRequest: [string, Steps, Expected][] = [
    ['request failure', { info: ['network'] }, { error: 'network-failed', repair: 'retry-later' }],
    ['non-zero code', { info: [{ code: 10001 }] }, { error: 'service-error', repair: 'retry-later' }],
    ['429', { info: [{ http: 429 }] }, { error: 'service-error', repair: 'retry-later' }],
  ];
  const producers: [string, Steps, Expected][] = [
    ...infoRequest.map(([name, steps, expected]) => [`operators: ${name}`, steps, expected] as [string, Steps, Expected]),
    ['operators: invalid structure', info(v => { v.chars = 'broken'; }), { error: 'response-invalid', repair: 'report-issue' }],
    ['operators: field renamed one level down', info(v => { for (const op of v.chars) { op.evolve = op.evolvePhase; delete op.evolvePhase; } }),
      { failed: ['operators'], repair: 'report-issue', first: { operators: 'partial' } }],
    ['operators: domain missing', info(v => { v.charList = v.chars; delete v.chars; }), { error: 'response-invalid', repair: 'report-issue' }],
    ['operators: empty list (repro emptyChars)', info(v => { v.chars = []; }), { error: 'response-invalid', repair: 'report-issue' }],
    ['inventory: request failure', { cultivate: ['network'] }, { failed: ['inventory'], repair: 'retry-later', first: { inventory: 'unavailable' } }],
    ['inventory: non-zero code', { cultivate: [{ code: 10001 }] }, { failed: ['inventory'], repair: 'retry-later', first: { inventory: 'unavailable' } }],
    ['inventory: 429', { cultivate: [{ http: 429 }] }, { failed: ['inventory'], repair: 'retry-later', first: { inventory: 'unavailable' } }],
    ['inventory: invalid structure', cultivate(v => { v.items = 'x'; }), { failed: ['inventory'], repair: 'report-issue', first: { inventory: 'invalid' } }],
    ['inventory: field renamed one level down', cultivate(v => { v.items = v.items.map((item: Record<string, unknown>) => ({ id: item.id, amount: item.count })); }),
      { failed: ['inventory'], repair: 'report-issue', first: { inventory: 'invalid' } }],
    ['inventory: domain missing', cultivate(v => { v.itemList = v.items; delete v.items; }), { failed: ['inventory'], repair: 'report-issue', first: { inventory: 'invalid' } }],
    ['inventory: empty list (repro emptyItems)', cultivate(v => { v.items = []; }), { failed: ['inventory'], repair: 'report-issue', first: { inventory: 'invalid' } }],
    // The base comes from the same player info request as the operators.
    ...infoRequest.map(([name, steps, expected]) => [`base: ${name}`, steps, expected] as [string, Steps, Expected]),
    ['base: invalid structure', info(v => { v.building = []; }), { failed: ['base'], repair: 'report-issue', first: { base: 'invalid' } }],
    ['base: field renamed one level down', info(v => { v.building.manufactureRooms = v.building.manufactures; delete v.building.manufactures; }),
      { failed: ['base'], repair: 'report-issue', first: { base: 'partial' } }],
    ['base: domain missing (repro buildingRenamed)', info(v => { v.buildingInfo = v.building; delete v.building; }), { failed: ['base'], repair: 'report-issue', first: { base: 'invalid' } }],
    ['base: empty (repro buildingRoomsRenamed)', info(v => { v.building = { controlRoom: {}, powerRooms: [] }; }), { failed: ['base'], repair: 'report-issue', first: { base: 'invalid' } }],
    ['two domains: report-issue outranks retry-later', { ...info(v => { delete v.building; }), cultivate: ['network'] },
      { failed: ['inventory', 'base'], repair: 'report-issue', first: { inventory: 'unavailable', base: 'invalid' } }],
    ['normal', {}, { failed: [], repair: undefined, first: {} }],
  ];
  // The clock also signs requests, so each run only shifts it by whole seconds to get distinct read times.
  const shift = { '2026-11-13T01:00:00.000Z': 0, '2026-11-13T02:00:00.000Z': 2000, '2026-11-13T03:00:00.000Z': 4000 } as Record<string, number>;
  const run = async (f: { privateDirectory: string }, steps: Steps, at: string) => runSklandRead('import', { privateDirectory: f.privateDirectory, language: 'zh-CN',
    fetcher: doubles.createSklandDouble({ steps }).fetch, protector, now: () => new Date(Date.now() + shift[at]!) });
  for (const [name, steps, expected] of producers) {
    // Consumers with an existing snapshot: the keep/replace decision under the lock, saved, failedDomains, repair, summary.
    const f = await fixture(t);
    const file = join(f.privateDirectory, 'account-snapshot-skland.json');
    assert.equal((await run(f, {}, '2026-11-13T01:00:00.000Z')).body.saved, true, name);
    const before = await readFile(file);
    const kept = await run(f, steps, '2026-11-13T02:00:00.000Z');
    const notRead = 'error' in expected || expected.failed.length > 0;
    assert.equal((await readFile(file)).equals(before), notRead, `${name}: existing snapshot bytes ${notRead ? 'unchanged' : 'replaced'}`);
    assert.equal(kept.body.repair, expected.repair, `${name}: repair`);
    if ('error' in expected) {
      assert.equal(kept.exitCode, 1, name); assert.equal(kept.body.error, expected.error, name); assert.equal(kept.body.saved, false, name);
      assert.match(kept.summary, /没有读到新的账号数据/, name);
    } else {
      assert.equal(kept.exitCode, 0, name); assert.equal(kept.body.saved, !notRead, `${name}: saved`); assert.deepEqual(kept.body.failedDomains, expected.failed, `${name}: failedDomains`);
      if (notRead) assert.match(kept.summary, /已有的森空岛快照保持不变/, name); else assert.doesNotMatch(kept.summary, /不完整/, name);
    }
    // Consumer without an existing snapshot: only a first snapshot may be partial, with coverage from the same verdict.
    const fresh = await fixture(t);
    const freshFile = join(fresh.privateDirectory, 'account-snapshot-skland.json');
    const first = await run(fresh, steps, '2026-11-13T03:00:00.000Z');
    if ('error' in expected) { await assert.rejects(readFile(freshFile), `${name}: nothing written`); continue; }
    assert.equal(first.body.saved, true, name);
    const saved = JSON.parse(await readFile(freshFile, 'utf8')) as AccountSnapshot;
    assert.deepEqual(saved.coverage, first.body.coverage, `${name}: written coverage is the reported coverage`);
    for (const domain of ['operators', 'inventory', 'base'] as const) {
      const verdict = sklandVerdicts(saved).find(item => item.domain === domain)!;
      assert.equal(verdict.read, !expected.failed.includes(domain), `${name}: ${domain} verdict over the written snapshot`);
      assert.equal(saved.coverage[domain].status, expected.first[domain] ?? 'complete', `${name}: ${domain} written status`);
      if (!verdict.usable) assert.deepEqual(domain === 'operators' ? saved.operators : domain === 'inventory' ? saved.items : saved.base, domain === 'operators' ? [] : domain === 'inventory' ? {} : null);
    }
    if (expected.failed.length) assert.match(first.summary, /这是第一份森空岛快照/, name);
  }
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
