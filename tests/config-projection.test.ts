// Ticket 30: the conformance test for the one approval projection (recurrence-rule shape). It enumerates, from the code's
// own exported tables, every field the writer may write and every field its decisions read, and requires each to be in
// the projection; traces the consumption predicate's reads against its table; shows that changing an excluded field
// changes no decision; and finds every writer entry point that computes or compares a revision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { excludedBy, projectConfig, projectionExclusions, projectionRevision, wholeConfigFingerprint, type FieldPattern } from '../skills/maa-core/scripts/config-projection.ts';
import { checkMaintenanceWindow, inspectConfiguration, inspectManagedFields, previewConfigWrite, taskDecisionFields, timerDecisionFields, writerDependencies, writerFields,
  type WriteRequest } from '../skills/maa-core/scripts/maa-config.ts';
import { consumptionConsumers, consumptionDecisionFields, decideConsumption, type ConsumptionConsumer } from '../skills/maa-core/scripts/consumption-grant.ts';
import { connectionDecisionFields, discoverSetupConnections } from '../skills/maa-core/scripts/setup-connection.ts';
import './fixtures/maa-version-guard.ts';

const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const task = (field: string): FieldPattern => ['Configurations', '*', 'TaskQueue', '#', field];
/** Everything the writer writes or its decisions read, from the exported tables only. */
const enumerated: { source: string; field: FieldPattern }[] = [
  ...writerFields.map(field => ({ source: 'writer whitelist (maa-config.ts writerFields)', field })),
  ...taskDecisionFields.map(field => ({ source: 'task identity and enable state (maa-config.ts taskDecisionFields)', field: task(field) })),
  ...Object.values(consumptionDecisionFields).flat().map(field => ({ source: 'consumption predicate (consumption-grant.ts consumptionDecisionFields)', field: task(field) })),
  ...timerDecisionFields.map(field => ({ source: 'timer target and maintenance window (maa-config.ts timerDecisionFields)', field })),
  ...writerDependencies.map(field => ({ source: 'objects bound across shutdown (maa-config.ts writerDependencies)', field })),
  ...connectionDecisionFields.map(field => ({ source: "setup's dedicated entry (setup-connection.ts connectionDecisionFields)", field })),
];
const misses = (exclusions: readonly FieldPattern[]) => enumerated.filter(({ field }) => excludedBy(field, exclusions)).map(({ source, field }) => `${source}: ${field.join('.')}`);

test('every field the writer writes or its decisions read is in the approval projection', () => {
  assert.ok(enumerated.length > 40, 'the tables are enumerated');
  assert.deepEqual(misses(projectionExclusions), []);
  // The tables carry 27's grant keys, 23's base-plan keys, 24's training keys and setup's connection fields.
  for (const field of ['UseStone', 'StoneCount', 'UseStoneAllowSave', 'UseExpiringMedicine', 'MedicineExpireDays', 'UseExpireMedicineForActivity', 'CustomFileType', 'Filename', 'PlanSelect', 'Plans', 'RoomList']) {
    assert.ok(writerFields.some(pattern => pattern.join('.') === task(field).join('.')), field);
  }
  assert.ok(writerFields.some(pattern => pattern.join('.') === 'Configurations.*.Gui.ConnectSettings.Address'));
});

test('dropping any enumerated field from the projection makes the conformance check fail', () => {
  // Shown red once by editing the exclusion list (docs/daily-verification.md, 「30 配置写入器加固」); kept here for every field.
  for (const { source, field } of enumerated) assert.ok(misses([...projectionExclusions, field]).includes(`${source}: ${field.join('.')}`), field.join('.'));
});

// ---- the projection function itself --------------------------------------------------------------------------------
const profile = 'Synthetic profile';
const hour = (new Date().getHours() + 3) % 24;
const rich = () => ({
  Current: profile, ConfigVersion: 1,
  Configurations: {
    [profile]: {
      TaskQueue: [
        { $type: 'FightTask', TaskType: 'Fight', IsEnable: true, StagePlan: ['1-7'], UseMedicine: false, MedicineCount: 0, UseStone: false, StoneCount: 0, UseStoneAllowSave: false,
          UseExpiringMedicine: false, MedicineExpireDays: 2, UseExpireMedicineForActivity: false },
        { $type: 'MallTask', TaskType: 'Mall', IsEnable: true, CreditFightLastTime: '2026/11/13 04:00:00', VisitFriendsLastTime: '2026/11/13 04:00:00' },
        { $type: 'InfrastTask', TaskType: 'Infrast', IsEnable: true, Mode: 10000, Filename: '', PlanSelect: 0, CustomFileType: 'Default', RoomList: [{ Room: 'Training', IsEnabled: true }] },
        { $type: 'OperProgressTask', TaskType: 'OperProgress', IsEnable: false, Plans: [] },
        { $type: 'AwardTask', TaskType: 'Award', IsEnable: false, FreeGacha: false, SpecialAccess: false },
      ],
      TaskSelectedIndex: 0,
      Copilot: { TaskList: [], EnableUserAdditional: false },
      Gui: { ConnectSettings: { Address: '127.0.0.1:16384', AdbPath: '', AutoDetect: false, AlwaysAutoDetect: false, AddressHistory: [] },
        RuntimeSettings: { ClientType: 'Official' }, StartUpSettings: { EmulatorPath: '' } },
    },
  },
  Timers: { List: [{ IsEnabled: true, Hour: hour, Minute: 0, Config: profile }, { IsEnabled: false, Hour: hour, Minute: 30, Config: profile }],
    CustomConfig: false, ForceScheduledStart: false, ShowWindowBeforeForceScheduledStart: false, NotifyBeforeScheduledStart: false, ScheduledStartNotificationMinutes: 5 },
  Update: { Name: '', UpdatePackage: '', IsFirstBoot: false },
  AnnouncementInfo: { DoNotShowAgain: true },
  Gui: { WindowPlacement: { Left: 1 }, HotKeys: { ShowGui: { Key: 'S' } } },
});
type Json = Record<string | number, unknown>;
/** One concrete instance of a pattern in `rich()`: the profile for `*`, index 1 (the Mall task, or a timer) or 0 for `#`. */
const instance = (pattern: FieldPattern) => pattern.map((part, index) => part === '*' ? profile : part === '#' ? (pattern[index - 1] === 'TaskQueue' && /Time$/.test(pattern.at(-1)!) ? 1 : 0) : part);
function set(root: Json, path: (string | number)[], value: unknown) {
  let target = root;
  for (const key of path.slice(0, -1)) target = target[key] as Json;
  target[path.at(-1)!] = value;
}

test('the projection function keeps every enumerated field and drops exactly the excluded ones', () => {
  const base = rich();
  for (const { field } of enumerated) {
    const changed = rich(); set(changed as Json, instance(field), { synthetic: 'changed' });
    assert.notEqual(projectionRevision(changed), projectionRevision(base), `${field.join('.')} is in the projection`);
  }
  for (const exclusion of projectionExclusions) {
    const changed = rich(); set(changed as Json, instance(exclusion), { synthetic: 'changed' });
    assert.equal(projectionRevision(changed), projectionRevision(base), `${exclusion.join('.')} is outside the projection`);
    assert.notEqual(wholeConfigFingerprint(changed), wholeConfigFingerprint(base), `${exclusion.join('.')} is in the whole fingerprint`);
    const removed = rich(); const path = instance(exclusion); let target = removed as Json;
    for (const key of path.slice(0, -1)) target = target[key] as Json;
    delete target[path.at(-1)!];
    assert.equal(projectionRevision(removed), projectionRevision(base), `${exclusion.join('.')} may also be absent`);
  }
  // Raw JSON differences inside the projection still count: an omitted key and an explicit null differ.
  const omitted = rich(); delete (omitted.Timers.List[0] as Record<string, unknown>).IsEnabled;
  const explicit = rich(); (explicit.Timers.List[0] as Record<string, unknown>).IsEnabled = null;
  assert.notEqual(projectionRevision(omitted), projectionRevision(explicit));
  // Key order and everything else outside the exclusions is kept as it is.
  assert.deepEqual(Object.keys(projectConfig(base) as Json), ['Current', 'ConfigVersion', 'Configurations', 'Timers', 'Update', 'AnnouncementInfo', 'Gui']);
  assert.deepEqual((projectConfig(base) as ReturnType<typeof rich>).Gui, {});
});

// ---- the consumption predicate reads only its table ----------------------------------------------------------------
test('the consumption predicate reads no task field outside its exported table', () => {
  const read = new Set<string>();
  const traced = (value: Record<string, unknown>) => new Proxy(value, { get(target, key, receiver) { if (typeof key === 'string') read.add(key); return Reflect.get(target, key, receiver); } });
  const fight = (extra: Record<string, unknown> = {}) => ({ ...rich().Configurations[profile].TaskQueue[0], ...extra });
  const award = (extra: Record<string, unknown> = {}) => ({ ...rich().Configurations[profile].TaskQueue[4], ...extra });
  const open = { UseMedicine: true, MedicineCount: 2, UseStone: true, StoneCount: 1, UseStoneAllowSave: true, UseExpiringMedicine: true, MedicineExpireDays: 3, UseExpireMedicineForActivity: true };
  const grants = [{ source: 'current-request' }, { source: 'current-request', medicineCount: 5, stoneCount: 5, expiringMedicine: { days: 3, forActivity: true } }, { source: 'approved-report' }];
  for (const consumer of consumptionConsumers as readonly ConsumptionConsumer[]) for (const grant of grants) for (const plan of [undefined, 'job', 'training'] as const) {
    for (const [taskValue, before] of [[fight(), fight(open)], [fight(open), fight()], [fight(open), undefined], [award({ FreeGacha: true }), award()], [rich().Configurations[profile].TaskQueue[1], undefined]] as const) {
      for (const shape of [{}, { activated: true }, { counted: true, runs: 2, recurring: true }]) {
        decideConsumption(grant, [{ task: traced({ ...taskValue }), ...(before ? { before: traced({ ...before }) } : {}),
          ...(consumer === 'doctor-restore' && before ? { restore: traced({ ...before }) } : {}), ...shape }], { consumer, plan });
      }
    }
  }
  const table = new Set<string>(Object.values(consumptionDecisionFields).flat());
  assert.deepEqual([...read].filter(key => !table.has(key)).sort(), []);
  assert.deepEqual([...table].filter(key => !read.has(key)).sort(), [], 'every table field is actually read');
});

// ---- an excluded field changes no decision ---------------------------------------------------------------------------
async function decisions(t: { after(fn: () => Promise<unknown>): void }, value: ReturnType<typeof rich>, adbPath: string) {
  const root = await mkdtemp(join(tmpdir(), 'config-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private');
  await mkdir(join(maaDirectory, 'config'), { recursive: true });
  await writeFile(join(maaDirectory, 'config', 'gui.new.json'), JSON.stringify(value, null, 2));
  const summary = await inspectConfiguration(maaDirectory);
  const request = (changes: WriteRequest['changes'], grant: Record<string, unknown> = {}): WriteRequest => ({ maaDirectory, privateDirectory, host: 'codex', expectedRevision: summary.revision,
    authorization: { source: 'current-request', reference: 'synthetic approval', ...grant }, changes });
  const field = (index: number, name: string, fieldValue: unknown) => ({ path: ['Configurations', 0, 'TaskQueue', index, name], value: fieldValue });
  const previews = [];
  for (const sample of [request([{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }]), request([{ path: ['Configurations', 0, 'TaskQueue'], value: [1, 0, 2, 3, 4] }]),
    request([field(4, 'IsEnable', true)]), request([{ path: ['Timers', 'List', 1, 'IsEnabled'], value: true }, { path: ['Timers', 'List', 1, 'Config'], value: 0 }]),
    request([field(0, 'UseMedicine', true), field(0, 'MedicineCount', 2)], { medicineCount: 2 }), request([field(0, 'UseStone', true)])]) {
    previews.push(await previewConfigWrite(sample));
  }
  const now = new Date();
  const discovery = await discoverSetupConnections({ home: join(root, 'home'), maaDirectory, adbPaths: [adbPath], addresses: ['127.0.0.1:16384'] },
    { run: async () => ({ exitCode: 0, stdout: 'List of devices attached\n127.0.0.1:16384\tdevice\n' }) });
  return { summary, previews, managed: inspectManagedFields(value), window: checkMaintenanceWindow(value, now, new Date(now.getTime() + 120000)), discovery };
}

test('changing a field outside the projection changes no decision of the writer, the read summary or setup discovery', async (t) => {
  const shared = await mkdtemp(join(tmpdir(), 'config-projection-adb-'));
  t.after(() => rm(shared, { recursive: true, force: true }));
  const adbPath = join(shared, 'adb.exe'); await writeFile(adbPath, 'synthetic adb placeholder');
  const base = await decisions(t, rich(), adbPath);
  assert.equal(base.previews[0]!.status, 'ready'); assert.equal(base.previews[5]!.reason, 'stone-grant-required');
  assert.equal(base.discovery.candidates.length, 1);
  for (const exclusion of projectionExclusions) await t.test(exclusion.join('.'), async (t) => {
    const changed = rich(); set(changed as Json, instance(exclusion), { synthetic: 'changed' });
    assert.deepEqual(await decisions(t, changed, adbPath), base);
  });
});

test('no shipped skill code names a field outside the projection', async () => {
  // The shipped scripts (skills/) are what reads and writes MAA's configuration; the eval harness under scripts/ and eval/
  // names the window placement only to simulate MAA's own write (ticket 30's drift scenarios).
  // A field is searched as a property access or a quoted key: by its own key, or by its parent's when the key is a
  // generic word (`Update.Name`).
  const names = [...new Set(projectionExclusions.map(exclusion => exclusion.at(-1)!.length > 6 ? exclusion.at(-1)! : exclusion.at(-2)!))];
  const found: string[] = [];
  for (const file of await codeFiles(join(repository, 'skills'))) {
    if (file.endsWith('config-projection.ts')) continue;
    const text = await readFile(file, 'utf8');
    for (const name of names) if (new RegExp(`\\.${name}\\b|['"\`]${name}['"\`]`).test(text)) found.push(`${relative(repository, file)}: ${name}`);
  }
  assert.deepEqual(found, []);
});

// ---- every revision a writer entry computes or compares is the projection ----------------------------------------
async function codeFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await codeFiles(path)); else if (/\.(?:ts|mjs)$/.test(entry.name)) result.push(path);
  }
  return result;
}

test('every writer entry that computes or compares a configuration revision uses the one projection function', async () => {
  const lines: { file: string; line: string }[] = [];
  for (const file of await codeFiles(join(repository, 'skills'))) {
    const name = relative(repository, file).replaceAll('\\', '/');
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) lines.push({ file: name, line });
  }
  const at = (pattern: RegExp) => lines.filter(({ line }) => pattern.test(line));
  // Only config-projection.ts hashes a parsed configuration.
  const configHash = /createHash\(['"]sha256['"]\)\.update\(JSON\.stringify\((?:projectConfig\()?(?:config|original|current|backup|expected|stoppedConfiguration|[a-z.]*\.config)\)|\bhash\(\[?(?:found\.)?current\.config\b/;
  assert.deepEqual(at(configHash).map(({ file }) => file), ['skills/maa-core/scripts/config-projection.ts', 'skills/maa-core/scripts/config-projection.ts']);
  assert.deepEqual(at(/\bfunction (?:revision|projectionRevision|wholeConfigFingerprint)\b/).map(({ file }) => file),
    ['skills/maa-core/scripts/config-projection.ts', 'skills/maa-core/scripts/config-projection.ts']);
  // The read summary's revision and setup's revisions are the projection.
  assert.equal(at(/^\s*revision: /).filter(({ file }) => file.endsWith('maa-config.ts')).map(({ line }) => line.trim()).join(), 'revision: projectionRevision(config),');
  assert.equal(at(/const discoveryRevision = /).map(({ line }) => line.trim()).join(), 'const discoveryRevision = hash([projectionRevision(current.config), candidates.map(({ id }) => id)]);');
  // Every comparison against an expected revision compares it with the projection, directly or through the read summary.
  const comparisons = at(/expectedRevision\s*[!=]==|[!=]==\s*[\w.]*expectedRevision/).filter(({ line }) => !/\[a-f0-9\]\{64\}/.test(line) && !/typeof [\w.]*expectedRevision !== 'string'/.test(line));
  assert.ok(comparisons.length >= 3, comparisons.map(({ file }) => file).join());
  for (const { file, line } of comparisons) assert.match(line, /projectionRevision\(|inspectConfiguration\(/, `${file}: ${line.trim()}`);
  // Every producer of an expected revision passes the caller's, or takes the projection or the read summary's.
  const producers = at(/expectedRevision(?::| = )/).filter(({ line }) => !/expectedRevision: string|expectedRevision\?: string/.test(line));
  for (const { file, line } of producers) assert.match(line, /expectedRevision(?::| =) (?:input\.expectedRevision|request\.expectedRevision|projectionRevision\(|\(await inspectConfiguration\()/, `${file}: ${line.trim()}`);
  const routes = new Set(producers.map(({ file }) => file));
  for (const file of ['base-apply.ts', 'stage-run.ts', 'stage-jobs.ts', 'training-plan.ts', 'setup-connection.ts', 'maa-config.ts']) assert.ok([...routes].some(route => route.endsWith(file)), file);
  // Doctor's exact comparison uses the whole fingerprint, once, and nothing else does.
  assert.deepEqual(at(/wholeConfigFingerprint\(/).map(({ file, line }) => [file, /projectionRevision/.test(line)]),
    [['skills/maa-core/scripts/config-projection.ts', false], ['skills/maa-core/scripts/maa-config.ts', false]]);
});
