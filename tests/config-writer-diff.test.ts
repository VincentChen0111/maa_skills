// Ticket 30: approvals bind to the projection revision and to the approved diff; the writer edits only changed values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeConfigWrite, inspectConfiguration, previewConfigWrite, type MaaProcess, type WriteRequest } from '../skills/maa-core/scripts/maa-config.ts';
import { buildTrainingChanges } from '../skills/maa-core/scripts/training-config.ts';
import { configFixture, trainingGrant } from './fixtures/training-runtime.ts';
import './fixtures/maa-version-guard.ts';

const profile = 'Synthetic profile';
const fight = { $type: 'FightTask', TaskType: 'Fight', Name: 'Synthetic fight label', IsEnable: false, StagePlan: ['1-7'], UseMedicine: false, MedicineCount: 0,
  UseStone: false, StoneCount: 0, UseStoneAllowSave: false, UseExpiringMedicine: false, MedicineExpireDays: 2, UseExpireMedicineForActivity: false };
const mall = { $type: 'MallTask', TaskType: 'Mall', Name: 'Synthetic mall label', IsEnable: true, CreditFightLastTime: '2026/11/13 04:00:00', VisitFriendsLastTime: '2026/11/13 04:00:00' };
const infrast = { $type: 'InfrastTask', TaskType: 'Infrast', IsEnable: true, Mode: 10000, PlanSelect: 1 };
const config = () => ({
  Current: profile, ConfigVersion: 1,
  Configurations: { [profile]: {
    Gui: { ConnectSettings: { Address: '127.0.0.1:16384', AdbPath: 'synthetic-adb.exe' }, RuntimeSettings: { StartGame: false } },
    TaskQueue: [structuredClone(fight), structuredClone(mall), structuredClone(infrast)], TaskSelectedIndex: 0,
  } },
  Timers: { List: [], NotifyBeforeScheduledStart: false, ScheduledStartNotificationMinutes: 5, CustomConfig: false },
  Update: { Name: '', UpdatePackage: '', IsFirstBoot: false, CheckOnStartup: true },
  AnnouncementInfo: { DoNotShowAgain: true },
  Gui: { WindowPlacement: { Left: 1 }, HotKeys: { ShowGui: { Key: 'S' } }, Localization: 'zh-cn' },
  UnknownSetting: { keep: 'synthetic-secret-token' },
});
type Config = ReturnType<typeof config>;

async function fixture(t: { after(fn: () => Promise<unknown>): void }, value: Config | string = config()) {
  const root = await mkdtemp(join(tmpdir(), 'config-writer-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private'), file = join(maaDirectory, 'config', 'gui.new.json');
  await mkdir(join(maaDirectory, 'config'), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  let running = true; let processCalls = 0;
  const events: string[] = [];
  const maa: MaaProcess & { onClose?: () => Promise<void> } = {
    inspect: async () => { processCalls++; return { running, treeExited: !running, idle: true, ready: running }; },
    close: async () => { events.push('close'); if (maa.onClose) await maa.onClose(); running = false; },
    start: async () => { events.push('start'); running = true; },
    version: async () => null,
  };
  const noProcess: MaaProcess = { inspect: async () => assert.fail('no process access'), close: async () => assert.fail('no close'), start: async () => assert.fail('no start'), version: async () => null };
  return { root, maaDirectory, privateDirectory, file, maa, noProcess, events, processCalls: () => processCalls, running: () => running };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = (f: Fixture, changes: WriteRequest['changes'], extra: Partial<WriteRequest> = {}): Omit<WriteRequest, 'expectedRevision'> =>
  ({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', authorization: { source: 'current-request', reference: 'synthetic approval' }, changes, ...extra });
const enableFight = [{ path: ['Configurations', 0, 'TaskQueue', 0, 'IsEnable'], value: true }];
async function edit(f: Fixture, change: (value: Config) => void) {
  const value = JSON.parse(await readFile(f.file, 'utf8')) as Config; change(value); await writeFile(f.file, JSON.stringify(value, null, 2));
}
async function previewed(f: Fixture, changes: WriteRequest['changes']) {
  const expectedRevision = (await inspectConfiguration(f.maaDirectory)).revision;
  const preview = await previewConfigWrite({ ...request(f, changes), expectedRevision });
  assert.equal(preview.status, 'ready', JSON.stringify(preview));
  return { expectedRevision, preview: preview as Extract<typeof preview, { status: 'ready' }> };
}
async function refusedBeforeProcess(f: Fixture, result: { status: string; reason: string | null }, before: Buffer, reason: string) {
  assert.equal(result.status, 'rejected', JSON.stringify(result)); assert.equal(result.reason, reason);
  assert.equal(f.processCalls(), 0); assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await readdir(join(f.maaDirectory, 'config')), ['gui.new.json']);
  assert.equal(existsSync(join(f.privateDirectory, 'daily-pending.jsonl')), false);
}

test('the preview computes the diff without process access, a lock or a write, and prints only whitelisted summaries', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file);
  const expectedRevision = (await inspectConfiguration(f.maaDirectory)).revision;
  // A reorder and a task field overlap, so a request carries one or the other.
  const changes = [{ path: ['Configurations', 0, 'TaskQueue'], value: [2, 0, 1] }, { path: ['Timers', 'NotifyBeforeScheduledStart'], value: true },
    { path: ['Timers', 'ScheduledStartNotificationMinutes'], value: 5 }];
  const preview = await previewConfigWrite({ ...request(f, changes), expectedRevision });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.reason, null);
  assert.equal(preview.revision, expectedRevision);
  assert.match(preview.diffFingerprint, /^[a-f0-9]{64}$/);
  // A change that writes the value already there is not part of the diff.
  assert.deepEqual(preview.changes, [
    { key: 'Configurations.<profile>.TaskQueue', profile: 0, before: ['Fight', 'Mall', 'Infrast'], after: ['Infrast', 'Fight', 'Mall'] },
    { key: 'Timers.NotifyBeforeScheduledStart', before: false, after: true },
  ]);
  assert.doesNotMatch(JSON.stringify(preview), /Synthetic|127\.0\.0\.1|synthetic-adb|secret|label/);
  assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await readdir(join(f.maaDirectory, 'config')), ['gui.new.json']);
  assert.equal(existsSync(f.privateDirectory), false);
  // The same request previewed again gives the same fingerprint; a different value gives another.
  assert.equal((await previewConfigWrite({ ...request(f, changes), expectedRevision })).diffFingerprint, preview.diffFingerprint);
  const other = await previewConfigWrite({ ...request(f, [{ path: ['Timers', 'ScheduledStartNotificationMinutes'], value: 6 }]), expectedRevision });
  assert.notEqual(other.diffFingerprint, preview.diffFingerprint);
});

test('a preview runs the writer checks: a stale revision, a forbidden field and an unapproved consumption change are refused', async (t) => {
  const f = await fixture(t);
  const expectedRevision = (await inspectConfiguration(f.maaDirectory)).revision;
  assert.equal((await previewConfigWrite({ ...request(f, enableFight), expectedRevision: 'f'.repeat(64) })).reason, 'configuration-changed');
  assert.equal((await previewConfigWrite({ ...request(f, [{ path: ['Gui', 'Localization'], value: 'en-us' }]), expectedRevision })).reason, 'request-invalid');
  const stone = [{ path: ['Configurations', 0, 'TaskQueue', 0, 'UseStone'], value: true }, { path: ['Configurations', 0, 'TaskQueue', 0, 'UseStoneAllowSave'], value: true },
    { path: ['Configurations', 0, 'TaskQueue', 0, 'StoneCount'], value: 2 }];
  const refused = await previewConfigWrite({ ...request(f, stone), expectedRevision });
  assert.equal(refused.status, 'rejected'); assert.equal(refused.reason, 'stone-grant-required');
  assert.equal(existsSync(f.privateDirectory), false);
});

test('a current request without the approved diff fingerprint is refused before process access, a lock or a write', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file);
  const expectedRevision = (await inspectConfiguration(f.maaDirectory)).revision;
  await refusedBeforeProcess(f, await executeConfigWrite({ ...request(f, enableFight), expectedRevision }, f.noProcess), before, 'approved-diff-missing');
  // The predicate's own reason still comes first, so the agent learns which approval is missing.
  const stone = [{ path: ['Configurations', 0, 'TaskQueue', 0, 'UseStone'], value: true }];
  const result = await executeConfigWrite({ ...request(f, stone), expectedRevision }, f.noProcess);
  assert.notEqual(result.reason, 'approved-diff-missing');
  // A plan key without a plan in it does not lift the requirement.
  const placeholder = { ...request(f, enableFight), authorization: { source: 'current-request' as const, reference: 'synthetic approval', jobPlan: null as never } };
  await refusedBeforeProcess(f, await executeConfigWrite({ ...placeholder, expectedRevision }, f.noProcess), before, 'approved-diff-missing');
  // A malformed fingerprint is not a fingerprint.
  await refusedBeforeProcess(f, await executeConfigWrite({ ...request(f, enableFight, { diffFingerprint: 'not-a-fingerprint' }), expectedRevision }, f.noProcess), before, 'request-invalid');
});

test('a fingerprint from a different preview is refused before process access, a lock or a write', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file);
  const { expectedRevision, preview } = await previewed(f, [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }]);
  // The approved diff was the reminder; the request now enables a task with that approval.
  await refusedBeforeProcess(f, await executeConfigWrite({ ...request(f, enableFight, { diffFingerprint: preview.diffFingerprint }), expectedRevision }, f.noProcess), before, 'approved-diff-mismatch');
  // A source other than the current request may carry a fingerprint; when it does, it is checked the same way.
  const report = { ...request(f, enableFight, { diffFingerprint: preview.diffFingerprint }), authorization: { source: 'approved-report' as const, reference: 'synthetic report#1' } };
  await refusedBeforeProcess(f, await executeConfigWrite({ ...report, expectedRevision }, f.noProcess), before, 'approved-diff-mismatch');
});

test('a write whose diff equals the preview completes, reads back and its pending record keeps the approved fingerprint', async (t) => {
  const f = await fixture(t);
  const { expectedRevision, preview } = await previewed(f, enableFight);
  const result = await executeConfigWrite({ ...request(f, enableFight, { diffFingerprint: preview.diffFingerprint }), expectedRevision }, f.maa);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual(result.changedKeys, ['Configurations.<profile>.TaskQueue.0.IsEnable']);
  const saved = JSON.parse(await readFile(f.file, 'utf8')) as Config;
  assert.deepEqual(saved, (() => { const expected = config(); expected.Configurations[profile]!.TaskQueue[0]!.IsEnable = true; return expected; })());
  const pending = JSON.parse((await readFile(join(f.privateDirectory, 'daily-pending.jsonl'), 'utf8')).trim());
  assert.equal(pending.diffFingerprint, preview.diffFingerprint);
  assert.deepEqual(f.events, ['close', 'start']);
});

test('MAA changing only fields outside the projection after the read summary does not make the approval stale', async (t) => {
  const f = await fixture(t);
  const { expectedRevision, preview } = await previewed(f, enableFight);
  // What the pinned MAA writes by itself while running: window placement, hotkeys, update bookkeeping, the announcement flag,
  // the selected task and the credit-fight and visit dates.
  await edit(f, value => {
    value.Gui.WindowPlacement = { Left: 2 }; value.Gui.HotKeys = { ShowGui: { Key: 'T' } };
    Object.assign(value.Update, { Name: 'v6.22.0', UpdatePackage: 'synthetic.zip', IsFirstBoot: true }); value.AnnouncementInfo.DoNotShowAgain = false;
    const current = value.Configurations[profile]!; current.TaskSelectedIndex = 2;
    Object.assign(current.TaskQueue[1]!, { CreditFightLastTime: '2026/11/14 04:00:00', VisitFriendsLastTime: '2026/11/14 04:00:00' });
  });
  assert.equal((await inspectConfiguration(f.maaDirectory)).revision, expectedRevision);
  const result = await executeConfigWrite({ ...request(f, enableFight, { diffFingerprint: preview.diffFingerprint }), expectedRevision }, f.maa);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  const saved = JSON.parse(await readFile(f.file, 'utf8')) as Config;
  assert.equal(saved.Configurations[profile]!.TaskQueue[0]!.IsEnable, true);
  assert.equal(saved.Gui.HotKeys.ShowGui.Key, 'T'); assert.equal(saved.Configurations[profile]!.TaskSelectedIndex, 2);
});

test('any change to a field inside the projection after the read summary is refused as configuration-changed before process access', async (t) => {
  const cases: [string, (value: Config) => void][] = [
    ['another task enable state', value => { value.Configurations[profile]!.TaskQueue[2]!.IsEnable = false; }],
    ['the infrastructure plan MAA rotates', value => { (value.Configurations[profile]!.TaskQueue[2] as typeof infrast).PlanSelect = 2; }],
    ['the stage list MAA refreshes', value => { (value.Configurations[profile]!.TaskQueue[0] as typeof fight).StagePlan = ['']; }],
    ['a consumption setting', value => { (value.Configurations[profile]!.TaskQueue[0] as typeof fight).UseMedicine = true; }],
    ['a task label', value => { (value.Configurations[profile]!.TaskQueue[0] as typeof fight).Name = 'Renamed'; }],
    ['the connection address', value => { value.Configurations[profile]!.Gui.ConnectSettings.Address = '127.0.0.1:5555'; }],
    ['a timer slot', value => { (value.Timers.List as unknown[]).push({ IsEnabled: false, Hour: 1, Minute: 0, Config: profile }); }],
    ['the reminder', value => { value.Timers.ScheduledStartNotificationMinutes = 6; }],
    ['an update preference', value => { value.Update.CheckOnStartup = false; }],
    ['a field no rule names', value => { value.UnknownSetting.keep = 'changed'; }],
    ['a field added', value => { (value as Record<string, unknown>).Added = true; }],
  ];
  for (const [name, change] of cases) await t.test(name, async (t) => {
    const f = await fixture(t);
    const { expectedRevision, preview } = await previewed(f, enableFight);
    await edit(f, change);
    const before = await readFile(f.file);
    await refusedBeforeProcess(f, await executeConfigWrite({ ...request(f, enableFight, { diffFingerprint: preview.diffFingerprint }), expectedRevision }, f.noProcess), before, 'configuration-changed');
  });
});

test('after shutdown the writer recomputes the diff: a value MAA saved on exit refuses the write, keeps its bytes and reopens MAA', async (t) => {
  const f = await fixture(t);
  const { expectedRevision, preview } = await previewed(f, enableFight);
  let closedBytes: Buffer | undefined;
  // The pinned MAA rewrites the whole file from memory when it exits; here its memory had the task already enabled.
  f.maa.onClose = async () => { await edit(f, value => { value.Configurations[profile]!.TaskQueue[0]!.IsEnable = true; }); closedBytes = await readFile(f.file); };
  const result = await executeConfigWrite({ ...request(f, enableFight, { diffFingerprint: preview.diffFingerprint }), expectedRevision }, f.maa);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.reason, 'approved-diff-mismatch');
  assert.notEqual(result.reason, 'configuration-changed');
  assert.deepEqual(result.changedKeys, []);
  assert.deepEqual(await readFile(f.file), closedBytes, 'the writer wrote nothing');
  assert.deepEqual(f.events, ['close', 'start']); assert.equal(f.running(), true);
  assert.deepEqual(await readdir(join(f.maaDirectory, 'config')), ['gui.new.json'], 'no lock or temporary file is left');
  assert.equal(existsSync(join(f.privateDirectory, 'maa-config-backups')), false);
  const runs = (await readFile(join(f.privateDirectory, 'daily-runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(runs.map(run => [run.status, run.reason]), [['rejected', 'approved-diff-mismatch']]);
});

test('the writer replaces only the changed values: every other byte of the file stays as MAA wrote it', async (t) => {
  // BOM, CRLF, four-space indentation, an integer beyond 2^53, float and exponent spellings, escapes, integer-like keys
  // after other keys, the polymorphic discriminator first and a timer whose null one-shot flag MAA omitted.
  const hour = (new Date().getHours() + 3) % 24;
  const closed = '"UseMedicine": false, "UseStone": false, "UseExpiringMedicine": false, "UseExpireMedicineForActivity": false';
  const lines = [
    '{',
    '    "Current": "Synthetic profile",',
    '    "Configurations": {',
    '        "Synthetic profile": {',
    '            "TaskQueue": [',
    `                { "$type": "FightTask", "TaskType": "Fight", "IsEnable": false, ${closed}, "Ratio": 1.0, "Big": 12345678901234567890 },`,
    '                { "$type": "MallTask", "TaskType": "Mall", "IsEnable": true, "Note": "caf\\u00e9 \\/ x", "Scale": 1e3 },',
    '                { "$type": "AwardTask", "TaskType": "Award", "IsEnable": false, "FreeGacha": false, "SpecialAccess": false }',
    '            ],',
    '            "Gui": { "ConnectSettings": { "Address": "127.0.0.1:16384" } }',
    '        },',
    '        "b": {},',
    '        "10": {}',
    '    },',
    '    "Timers": {',
    '        "List": [',
    `            { "Hour": ${hour}, "Minute": 0, "Config": "Synthetic profile" }`,
    '        ],',
    '        "NotifyBeforeScheduledStart": false,',
    '        "ScheduledStartNotificationMinutes": 5,',
    '        "CustomConfig": false',
    '    },',
    '    "Number": -0.000001,',
    '    "Big": 9007199254740993',
    '}',
    '',
  ];
  const bom = String.fromCharCode(0xfeff);
  const original = bom + lines.join('\r\n');
  const f = await fixture(t, original);
  // JavaScript lists the integer-like profile key first, so the summary's profile 1 is "Synthetic profile".
  assert.equal((await inspectConfiguration(f.maaDirectory)).currentProfile, 1);
  const changes = [{ path: ['Configurations', 1, 'TaskQueue', 0, 'IsEnable'], value: true }, { path: ['Configurations', 1, 'TaskQueue'], value: [1, 0, 2] },
    { path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }];
  // Overlapping changes are refused, so the reorder and the enable go in two requests.
  const first = await previewed(f, [changes[0]!, changes[2]!]);
  const done = await executeConfigWrite({ ...request(f, [changes[0]!, changes[2]!], { diffFingerprint: first.preview.diffFingerprint }), expectedRevision: first.expectedRevision }, f.maa);
  assert.equal(done.status, 'complete', JSON.stringify(done));
  const afterFirst = await readFile(f.file, 'utf8');
  assert.equal(afterFirst, original
    .replace('"Fight", "IsEnable": false', '"Fight", "IsEnable": true')
    .replace('"NotifyBeforeScheduledStart": false', '"NotifyBeforeScheduledStart": true'));
  const second = await previewed(f, [changes[1]!]);
  const reordered = await executeConfigWrite({ ...request(f, [changes[1]!], { diffFingerprint: second.preview.diffFingerprint }), expectedRevision: second.expectedRevision }, f.maa);
  assert.equal(reordered.status, 'complete', JSON.stringify(reordered));
  const tasks = afterFirst.split('\r\n').slice(5, 8).map(line => line.trim().replace(/,$/, ''));
  assert.equal(await readFile(f.file, 'utf8'), afterFirst.replace(
    afterFirst.split('\r\n').slice(5, 8).join('\r\n'),
    [`                ${tasks[1]},`, `                ${tasks[0]},`, `                ${tasks[2]}`].join('\r\n')));
  // A timer flag MAA omitted is added after the timer's last field, in the file's own layout.
  const third = await previewed(f, [{ path: ['Timers', 'List', 0, 'IsEnabled'], value: false }]);
  const timer = await executeConfigWrite({ ...request(f, [{ path: ['Timers', 'List', 0, 'IsEnabled'], value: false }], { diffFingerprint: third.preview.diffFingerprint }),
    expectedRevision: third.expectedRevision }, f.maa);
  assert.equal(timer.status, 'complete', JSON.stringify(timer));
  const text = await readFile(f.file, 'utf8');
  assert.ok(text.includes(`{ "Hour": ${hour}, "Minute": 0, "Config": "Synthetic profile", "IsEnabled": false }`));
  assert.ok(text.startsWith(`${bom}{\r\n    "Current"`));
  assert.match(text, /"Big": 12345678901234567890 \}/); assert.match(text, /"Big": 9007199254740993\r\n\}/);
  assert.match(text, /"Ratio": 1\.0,/); assert.match(text, /"Scale": 1e3 \}/); assert.match(text, /"caf\\u00e9 \\\/ x"/);
  assert.match(text, /"b": \{\},\r\n {8}"10": \{\}/);
});

test('a plan-bound write keeps its own change check and, when it carries a diff fingerprint, must match it as well', async (t) => {
  // A training plan derives its own change set (24); its write needs no fingerprint, but one it carries is checked.
  const f = await configFixture(t), grant = trainingGrant();
  const prepared = buildTrainingChanges(f.config, grant, f.privateDirectory);
  const request = { maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex' as const, closedConfirmed: true,
    expectedRevision: (await inspectConfiguration(f.maaDirectory)).revision, authorization: { source: 'current-request' as const, reference: 'synthetic', trainingPlan: grant }, changes: prepared.changes };
  const before = await readFile(f.file);
  const wrong = await executeConfigWrite({ ...request, diffFingerprint: 'a'.repeat(64) }, f.maa);
  assert.equal(wrong.status, 'rejected'); assert.equal(wrong.reason, 'approved-diff-mismatch');
  assert.deepEqual(await readFile(f.file), before);
  assert.equal((await readdir(join(f.maaDirectory, 'config'))).includes('.maa-skills.lock'), false);
  // Changes other than the plan's own are still refused by the plan check, fingerprint or not.
  const extra = [...prepared.changes, { path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }];
  assert.equal((await previewConfigWrite({ ...request, changes: extra })).reason, 'request-invalid');
  const preview = await previewConfigWrite(request);
  assert.equal(preview.status, 'ready');
  const done = await executeConfigWrite({ ...request, diffFingerprint: preview.diffFingerprint! }, f.maa);
  assert.equal(done.status, 'complete', JSON.stringify(done));
});
