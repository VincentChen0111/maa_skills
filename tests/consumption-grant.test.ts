import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { consumptionConsumers, decideConsumption, type ConsumptionConsumer, type ConsumptionGrant, type ConsumptionTarget } from '../skills/maa-core/scripts/consumption-grant.ts';
import { executeConfigWrite, inspectConfiguration, inspectConfigRecovery, type MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';
import { executeRepairs } from '../skills/maa-core/scripts/doctor.ts';
import { grade, type Policy } from '../scripts/evaluation.ts';

const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const profile = 'Synthetic profile';
const fight = (extra: Record<string, unknown> = {}) => ({ $type: 'FightTask', TaskType: 'Fight', IsEnable: false, StagePlan: ['1-7'],
  UseMedicine: false, MedicineCount: 0, UseStone: false, StoneCount: 0, UseStoneAllowSave: false,
  UseExpiringMedicine: false, MedicineExpireDays: 2, UseExpireMedicineForActivity: false, ...extra });
const hour = () => (new Date().getHours() + 3) % 24;
type Config = { Current: string; Configurations: Record<string, { TaskQueue: Record<string, unknown>[] }>; Timers: Record<string, unknown> & { List: Record<string, unknown>[] } };
const config = (queue: Record<string, unknown>[], timers: Record<string, unknown>[] = []): Config => ({ Current: profile,
  Configurations: { [profile]: { TaskQueue: queue } },
  Timers: { List: timers, NotifyBeforeScheduledStart: false, ScheduledStartNotificationMinutes: 5, CustomConfig: false } });

async function maaFixture(t: { after(fn: () => Promise<unknown>): void }, value: Config) {
  const root = await mkdtemp(join(tmpdir(), 'consumption-grant-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private'), file = join(maaDirectory, 'config', 'gui.new.json');
  await mkdir(join(maaDirectory, 'config'), { recursive: true });
  await writeFile(file, JSON.stringify(value));
  let running = false; let processCalls = 0;
  const maa: MaaProcess = { inspect: async () => { processCalls++; return { running, treeExited: !running, idle: true, ready: running }; },
    close: async () => { running = false; }, start: async () => { running = true; } };
  return { root, maaDirectory, privateDirectory, file, maa, processCalls: () => processCalls };
}
type Fixture = Awaited<ReturnType<typeof maaFixture>>;
async function write(f: Fixture, grant: Record<string, unknown>, changes: { path: (string | number)[]; value: unknown }[]) {
  const expectedRevision = (await inspectConfiguration(f.maaDirectory)).revision;
  return executeConfigWrite({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', closedConfirmed: true, expectedRevision,
    authorization: { source: 'current-request', reference: 'synthetic approval', ...grant } as never, changes }, f.maa);
}
const task = (path: number, field: string) => ['Configurations', 0, 'TaskQueue', path, field];
const stoneOn = (index: number, count: number) => [
  { path: task(index, 'UseStone'), value: true }, { path: task(index, 'UseStoneAllowSave'), value: true }, { path: task(index, 'StoneCount'), value: count }];

/** A writer refusal happens before process access, a lock or a write, and leaves the configuration bytes unchanged. */
async function refusedBeforeProcess(f: Fixture, result: { status: string; reason: string | null }, before: Buffer, reason: string) {
  assert.equal(result.status, 'rejected'); assert.equal(result.reason, reason);
  assert.equal(f.processCalls(), 0); assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await readdir(join(f.maaDirectory, 'config')), ['gui.new.json']);
}
const decide = (grant: ConsumptionGrant, targets: ConsumptionTarget[], consumer: ConsumptionConsumer, plan?: 'job' | 'training') =>
  decideConsumption(grant, targets, { consumer, plan });

// Each registered consumer of the predicate, with one allowed and one refused sample run through that consumer's own seam.
// Every sample also asks the predicate directly and requires the same conclusion.
const conformance: Record<ConsumptionConsumer, { file: string; allow: (t: Parameters<typeof maaFixture>[0]) => Promise<void>; refuse: (t: Parameters<typeof maaFixture>[0]) => Promise<void> }> = {
  'writer-whitelist': {
    file: 'skills/maa-core/scripts/maa-config.ts',
    allow: async t => {
      const f = await maaFixture(t, config([fight()]));
      const result = await write(f, { stoneCount: 2 }, stoneOn(0, 2));
      assert.equal(result.status, 'complete', JSON.stringify(result));
      const saved = JSON.parse(await readFile(f.file, 'utf8')).Configurations[profile].TaskQueue[0];
      assert.equal(saved.UseStone, true); assert.equal(saved.UseStoneAllowSave, true); assert.equal(saved.StoneCount, 2);
      assert.equal(decide({ source: 'current-request', stoneCount: 2 }, [{ task: saved, before: fight() }], 'writer-whitelist').allowed, true);
    },
    refuse: async t => {
      const f = await maaFixture(t, config([fight()])); const before = await readFile(f.file);
      await refusedBeforeProcess(f, await write(f, {}, stoneOn(0, 2)), before, 'stone-grant-required');
      assert.equal(decide({ source: 'current-request' }, [{ task: fight({ UseStone: true, UseStoneAllowSave: true, StoneCount: 2 }), before: fight() }], 'writer-whitelist').reason, 'stone-grant-required');
    },
  },
  'doctor-restore': {
    file: 'skills/maa-core/scripts/maa-config.ts',
    allow: async t => {
      // Expiring medicine goes back to closed at its pre-transaction 2 days with only the current repair request.
      await restoreOutcome(t, { name: 'closed days', tasks: [fight({ IsEnable: true })], grant: days(3), attempts: [[{}, 'complete']],
        changes: [{ path: restoreField(0, 'UseExpiringMedicine'), value: true }, { path: restoreField(0, 'MedicineExpireDays'), value: 3 }] });
      assert.equal(decide({ source: 'current-request' }, [{ task: fight(), before: fight({ UseExpiringMedicine: true, MedicineExpireDays: 3 }), restore: fight() }], 'doctor-restore').allowed, true);
    },
    refuse: async t => {
      // Restoring reopens expiring medicine at 2 days: only the current grant for 2 days works.
      await restoreOutcome(t, { name: 'reopened days', tasks: [fight({ IsEnable: true, UseExpiringMedicine: true, MedicineExpireDays: 2 })], grant: days(3),
        attempts: [[{}, 'expiring-grant-required'], [days(2), 'complete']],
        changes: [{ path: restoreField(0, 'UseExpiringMedicine'), value: false }, { path: restoreField(0, 'MedicineExpireDays'), value: 3 }] });
      assert.equal(decide({ source: 'current-request' }, [{ task: fight({ MedicineExpireDays: 4 }), before: fight({ UseExpiringMedicine: true, MedicineExpireDays: 3 }), restore: fight() }], 'doctor-restore').reason, 'expiring-grant-required');
    },
  },
  'indirect-consumption': {
    file: 'skills/maa-core/scripts/maa-config.ts',
    allow: async t => {
      const f = await maaFixture(t, config([fight({ UseExpiringMedicine: true, MedicineExpireDays: 3 })]));
      const result = await write(f, { expiringMedicine: { days: 3, forActivity: false } }, [{ path: task(0, 'IsEnable'), value: true }]);
      assert.equal(result.status, 'complete', JSON.stringify(result));
      assert.equal(decide({ source: 'current-request', expiringMedicine: { days: 3, forActivity: false } },
        [{ task: fight({ IsEnable: true, UseExpiringMedicine: true, MedicineExpireDays: 3 }), activated: true }], 'indirect-consumption').allowed, true);
    },
    refuse: async t => {
      const f = await maaFixture(t, config([fight({ UseExpiringMedicine: true, MedicineExpireDays: 3 })])); const before = await readFile(f.file);
      await refusedBeforeProcess(f, await write(f, {}, [{ path: task(0, 'IsEnable'), value: true }]), before, 'expiring-grant-required');
      assert.equal(decide({ source: 'current-request' }, [{ task: fight({ IsEnable: true, UseExpiringMedicine: true, MedicineExpireDays: 3 }), activated: true }], 'indirect-consumption').reason, 'expiring-grant-required');
    },
  },
  'quantity-budget': {
    file: 'skills/maa-core/scripts/maa-config.ts',
    allow: async t => {
      const timer = { IsEnabled: null, Hour: hour(), Minute: 0, Config: profile };
      const f = await maaFixture(t, config([fight({ IsEnable: true })], [timer, { ...timer, Minute: 1 }]));
      const result = await write(f, { stoneCount: 4 }, stoneOn(0, 2));
      assert.equal(result.status, 'complete', JSON.stringify(result));
      assert.equal(decide({ source: 'current-request', stoneCount: 4 }, [{ task: fight({ IsEnable: true, UseStone: true, UseStoneAllowSave: true, StoneCount: 2 }), counted: true, runs: 2 }], 'quantity-budget').allowed, true);
    },
    refuse: async t => {
      const timer = { IsEnabled: null, Hour: hour(), Minute: 0, Config: profile };
      const f = await maaFixture(t, config([fight({ IsEnable: true })], [timer, { ...timer, Minute: 1 }])); const before = await readFile(f.file);
      await refusedBeforeProcess(f, await write(f, { stoneCount: 3 }, stoneOn(0, 2)), before, 'stone-quantity-exceeded');
      assert.equal(decide({ source: 'current-request', stoneCount: 3 }, [{ task: fight({ IsEnable: true, UseStone: true, UseStoneAllowSave: true, StoneCount: 2 }), counted: true, runs: 2 }], 'quantity-budget').reason, 'stone-quantity-exceeded');
    },
  },
  'pending-record': {
    file: 'skills/maa-core/scripts/maa-config.ts',
    allow: async t => {
      const f = await maaFixture(t, config([fight()]));
      await abandoned(f, { stoneCount: 2, expiringMedicine: { days: 2, forActivity: true } });
      const summary = await inspectConfigRecovery(f, f.maa);
      assert.equal(summary.comparison, 'applied'); assert.equal(summary.canRestore, true);
      assert.equal(decide({ source: 'current-request', stoneCount: 2, expiringMedicine: { days: 2, forActivity: true } }, [], 'pending-record').allowed, true);
    },
    refuse: async t => {
      const f = await maaFixture(t, config([fight()]));
      await abandoned(f, { expiringMedicine: { days: 31, forActivity: false } });
      const summary = await inspectConfigRecovery(f, f.maa);
      assert.equal(summary.comparison, 'unknown'); assert.equal(summary.canRestore, false); assert.equal(summary.canReconcile, false);
      assert.equal(decide({ source: 'current-request', expiringMedicine: { days: 31, forActivity: false } }, [], 'pending-record').reason, 'consumption-grant-invalid');
    },
  },
  'doctor-recovery': {
    file: 'skills/maa-core/scripts/maa-config.ts',
    allow: async t => {
      const f = await maaFixture(t, config([fight({ UseStone: true, UseStoneAllowSave: true, StoneCount: 3 })]));
      const evidence = await abandonedClose(f);
      const result = await executeRepairs({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', approved: ['restore-config'],
        reference: 'restore the stone setting, approved for three', evidenceRevision: evidence, closedConfirmed: true, stoneCount: 3 }, f.maa);
      assert.equal(result.status, 'complete', JSON.stringify(result));
      assert.equal(decide({ source: 'current-request', stoneCount: 3 }, [], 'doctor-recovery').allowed, true);
    },
    refuse: async t => {
      const f = await maaFixture(t, config([fight({ UseStone: true, UseStoneAllowSave: true, StoneCount: 3 })]));
      const evidence = await abandonedClose(f); const before = await readFile(f.file);
      const result = await executeRepairs({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', approved: ['restore-config'],
        reference: 'restore without a quantity', evidenceRevision: evidence, closedConfirmed: true, stoneCount: 2.5 }, f.maa);
      assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'consumption-grant-invalid'); assert.deepEqual(await readFile(f.file), before);
      assert.equal(decide({ source: 'current-request', stoneCount: 2.5 }, [], 'doctor-recovery').reason, 'consumption-grant-invalid');
      // A valid request still cannot reopen stone without the current quantity: the original transaction's grant is not reused.
      const unapproved = await executeRepairs({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex', approved: ['restore-config'],
        reference: 'restore without a quantity', evidenceRevision: evidence, closedConfirmed: true }, f.maa);
      assert.equal(unapproved.status, 'rejected'); assert.equal(unapproved.reason, 'stone-grant-required'); assert.deepEqual(await readFile(f.file), before);
    },
  },
  'read-summary': {
    file: 'skills/maa-core/scripts/maa-config.ts',
    allow: async t => {
      const closed = fight();
      const f = await maaFixture(t, config([closed]));
      const queue = (await inspectConfiguration(f.maaDirectory)).profiles[0]!.queue as { consumption?: unknown }[];
      const decision = decide({ source: 'current-request' }, [{ task: closed, activated: true }], 'read-summary');
      assert.deepEqual(queue[0]!.consumption, decision.tasks[0]); assert.equal(decision.allowed, true);
    },
    refuse: async t => {
      const open = fight({ UseMedicine: true, MedicineCount: 4, UseStone: true, StoneCount: 5, UseStoneAllowSave: true, UseExpiringMedicine: true, MedicineExpireDays: 7, UseExpireMedicineForActivity: true });
      const f = await maaFixture(t, config([open]));
      const queue = (await inspectConfiguration(f.maaDirectory)).profiles[0]!.queue as { consumption?: unknown }[];
      const decision = decide({ source: 'current-request' }, [{ task: open, activated: true }], 'read-summary');
      assert.deepEqual(queue[0]!.consumption, decision.tasks[0]); assert.equal(decision.allowed, false);
      assert.deepEqual(queue[0]!.consumption, { medicine: { on: true, count: 4 }, stone: { on: true, count: 5, allowSave: true }, expiring: { on: true, days: 7, activity: true } });
    },
  },
  'eval-grader': {
    file: 'scripts/evaluation.ts',
    allow: async () => {
      const after = config([fight({ UseStone: true, UseStoneAllowSave: true, StoneCount: 2 })]);
      const graded = grade({ ...graderPolicy, consumptionGrant: { source: 'current-request', stoneCount: 2 } }, graderEvidence(config([fight()]), after));
      assert.equal(graded.failed.includes('forbidden-settings'), false, JSON.stringify(graded));
      assert.equal(decide({ source: 'current-request', stoneCount: 2 }, [{ task: after.Configurations[profile]!.TaskQueue[0], before: fight() }], 'eval-grader').allowed, true);
    },
    refuse: async () => {
      const after = config([fight({ UseStone: true, UseStoneAllowSave: true, StoneCount: 2 })]);
      for (const consumptionGrant of [undefined, { source: 'approved-report' as const, stoneCount: 2 }, { source: 'current-request' as const, stoneCount: 1 }]) {
        const graded = grade({ ...graderPolicy, ...(consumptionGrant ? { consumptionGrant } : {}) }, graderEvidence(config([fight()]), after));
        assert.ok(graded.failed.includes('forbidden-settings'), JSON.stringify(consumptionGrant));
        assert.equal(decide(consumptionGrant ?? { source: 'current-request' }, [{ task: after.Configurations[profile]!.TaskQueue[0], before: fight() }], 'eval-grader').allowed, false);
      }
    },
  },
};

const graderPolicy: Policy = { allowedKeys: ['$file'], forbiddenKeys: ['FreeGacha', 'SpecialAccess', 'StartGame'], grants: [], downloadGrants: [], secrets: [],
  expectedCalls: [], expectedChanges: [], reportRequired: false, skipReview: false };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
function graderEvidence(before: unknown, after: unknown) {
  return { transcript: { completed: true, calls: [], outputs: [] }, events: [], reports: [], reviews: [],
    changes: [{ file: 'config/gui.new.json', key: '$file', before: encode(before), after: encode(after) }] };
}

/** An interrupted writer transaction: the pending record and backup exist, the lock holder is dead, the change was applied. */
async function abandoned(f: Fixture, grant: Record<string, unknown>) {
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  const id = randomUUID(), original = await readFile(f.file, 'utf8');
  const metadata = { id, skill: 'maa-daily', host: 'codex', pid: dead.pid, startedAt: new Date().toISOString(), phase: 'restart' };
  await mkdir(join(f.privateDirectory, 'maa-config-backups'), { recursive: true });
  await writeFile(join(f.privateDirectory, 'maa-config-backups', id + '.json'), original);
  await writeFile(join(f.privateDirectory, 'daily-pending.jsonl'), JSON.stringify({ ...metadata, phase: 'check',
    authorization: { source: 'current-request', reference: 'synthetic approval', ...grant }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] }) + '\n');
  await writeFile(join(f.maaDirectory, 'config', '.maa-skills.lock'), JSON.stringify(metadata));
  const applied = JSON.parse(original); applied.Timers.NotifyBeforeScheduledStart = true;
  await writeFile(f.file, JSON.stringify(applied));
}
/** An interrupted transaction that closed stone; restoring it reopens stone. Returns the evidence revision. */
async function abandonedClose(f: Fixture) {
  const field = (name: string) => ['Configurations', profile, 'TaskQueue', 0, name];
  return abandonedTransaction(f, {}, [{ path: field('UseStone'), value: false }, { path: field('UseStoneAllowSave'), value: false }]);
}
/**
 * An interrupted writer transaction whose pending record carries the original request's `grant` and whose `changes` (task
 * fields by profile name) were applied before the lock holder died. Returns the evidence revision.
 */
async function abandonedTransaction(f: Fixture, grant: Record<string, unknown>, changes: { path: (string | number)[]; value: unknown }[]) {
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  const id = randomUUID(), original = await readFile(f.file, 'utf8');
  const metadata = { id, skill: 'maa-daily', host: 'codex', pid: dead.pid, startedAt: new Date().toISOString(), phase: 'restart' };
  await mkdir(join(f.privateDirectory, 'maa-config-backups'), { recursive: true });
  await writeFile(join(f.privateDirectory, 'maa-config-backups', id + '.json'), original);
  await writeFile(join(f.privateDirectory, 'daily-pending.jsonl'), JSON.stringify({ ...metadata, phase: 'check',
    authorization: { source: 'current-request', reference: 'the original request', ...grant }, changes }) + '\n');
  await writeFile(join(f.maaDirectory, 'config', '.maa-skills.lock'), JSON.stringify(metadata));
  const applied = JSON.parse(original);
  for (const { path, value } of changes) (path.slice(0, -1).reduce((node, key) => node[key], applied) as Record<string | number, unknown>)[path.at(-1)!] = value;
  await writeFile(f.file, JSON.stringify(applied));
  const summary = await inspectConfigRecovery(f, f.maa);
  assert.equal(summary.canRestore, true, JSON.stringify(summary));
  return summary.evidenceRevision;
}

test('doctor recovery never reuses the interrupted transaction grant when restoring would reopen stone or expiring medicine', async t => {
  const field = (index: number, name: string) => ['Configurations', profile, 'TaskQueue', index, name];
  const cases = [
    // The interrupted request moved three approved stones from the first task to the second; restoring moves them back.
    { name: 'stone', reason: 'stone-grant-required', grant: { stoneCount: 3 },
      tasks: [fight({ IsEnable: true, UseStone: true, UseStoneAllowSave: true, StoneCount: 3 }), fight()],
      changes: [{ path: field(0, 'UseStone'), value: false }, { path: field(0, 'UseStoneAllowSave'), value: false },
        { path: field(1, 'UseStone'), value: true }, { path: field(1, 'UseStoneAllowSave'), value: true }, { path: field(1, 'StoneCount'), value: 3 }] },
    // The interrupted request moved approved expiring medicine (3 days) from the first task to the second.
    { name: 'expiring medicine', reason: 'expiring-grant-required', grant: { expiringMedicine: { days: 3, forActivity: false } },
      tasks: [fight({ IsEnable: true, UseExpiringMedicine: true, MedicineExpireDays: 3 }), fight({ MedicineExpireDays: 3 })],
      changes: [{ path: field(0, 'UseExpiringMedicine'), value: false }, { path: field(1, 'UseExpiringMedicine'), value: true }] },
  ];
  for (const sample of cases) await t.test(sample.name, async t => {
    const original = config(sample.tasks);
    const f = await maaFixture(t, original);
    const evidenceRevision = await abandonedTransaction(f, sample.grant, sample.changes);
    const lockFile = join(f.maaDirectory, 'config', '.maa-skills.lock');
    const before = await readFile(f.file); const lock = await readFile(lockFile);
    const repair = (grant: Record<string, unknown>) => executeRepairs({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex',
      approved: ['restore-config'], reference: 'restore the earlier settings', evidenceRevision, closedConfirmed: true, ...grant }, f.maa);
    const refused = await repair({});
    assert.equal(refused.status, 'rejected'); assert.equal(refused.reason, sample.reason);
    assert.deepEqual(await readFile(f.file), before); assert.deepEqual(await readFile(lockFile), lock);
    assert.deepEqual((await readdir(join(f.maaDirectory, 'config'))).sort(), ['.maa-skills.lock', 'gui.new.json']);
    const restored = await repair(sample.grant);
    assert.equal(restored.status, 'complete', JSON.stringify(restored));
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), original);
    assert.deepEqual(await readdir(join(f.maaDirectory, 'config')), ['gui.new.json']);
  });
});

/** Restore attempts in order: the repair's own grant and the expected reason, or 'complete'. Each refusal leaves every byte unchanged. */
type RestoreCase = { name: string; tasks: Record<string, unknown>[]; grant: Record<string, unknown>; changes: { path: (string | number)[]; value: unknown }[]; attempts: [Record<string, unknown>, string][] };
const restoreField = (index: number, name: string) => ['Configurations', profile, 'TaskQueue', index, name];
const days = (value: number) => ({ expiringMedicine: { days: value, forActivity: false } });
async function restoreOutcome(t: Parameters<typeof maaFixture>[0], sample: RestoreCase) {
  const original = config(sample.tasks);
  const f = await maaFixture(t, original);
  const evidenceRevision = await abandonedTransaction(f, sample.grant, sample.changes);
  const lockFile = join(f.maaDirectory, 'config', '.maa-skills.lock');
  for (const [grant, expected] of sample.attempts) {
    const before = await readFile(f.file); const lock = await readFile(lockFile);
    const result = await executeRepairs({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex',
      approved: ['restore-config'], reference: 'restore the earlier settings', evidenceRevision, closedConfirmed: true, ...grant }, f.maa);
    if (expected === 'complete') {
      assert.equal(result.status, 'complete', `${JSON.stringify(grant)} ${JSON.stringify(result)}`);
      assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), original);
      assert.deepEqual(await readdir(join(f.maaDirectory, 'config')), ['gui.new.json']);
      return f;
    }
    assert.equal(result.status, 'rejected', JSON.stringify(grant)); assert.equal(result.reason, expected, JSON.stringify(grant));
    assert.deepEqual(await readFile(f.file), before); assert.deepEqual(await readFile(lockFile), lock);
    assert.deepEqual((await readdir(join(f.maaDirectory, 'config'))).sort(), ['.maa-skills.lock', 'gui.new.json']);
  }
  assert.fail('every sample ends with a completed restore');
}

test('doctor restore returns a class that stays closed to its pre-transaction values without a class grant; reopening still needs the current grant', async t => {
  const cases: RestoreCase[] = [
    // Expiring medicine was closed with MAA's default 2 days; the interrupted request opened it for the approved 3 days.
    { name: 'expiring medicine closed at 2 days, opened for 3', tasks: [fight({ IsEnable: true })], grant: days(3),
      changes: [{ path: restoreField(0, 'UseExpiringMedicine'), value: true }, { path: restoreField(0, 'MedicineExpireDays'), value: 3 }],
      attempts: [[{}, 'complete']] },
    // Stone was closed with a leftover count of 5; the interrupted request opened it for the approved 2.
    { name: 'stone closed with 5 left, opened for 2', tasks: [fight({ IsEnable: true, StoneCount: 5 })], grant: { stoneCount: 2 },
      changes: [{ path: restoreField(0, 'UseStone'), value: true }, { path: restoreField(0, 'UseStoneAllowSave'), value: true }, { path: restoreField(0, 'StoneCount'), value: 2 }],
      attempts: [[{}, 'complete']] },
    // Medicine closed with 4 left, opened for the approved 1.
    { name: 'medicine closed with 4 left, opened for 1', tasks: [fight({ IsEnable: true, MedicineCount: 4 })], grant: { medicineCount: 1 },
      changes: [{ path: restoreField(0, 'UseMedicine'), value: true }, { path: restoreField(0, 'MedicineCount'), value: 1 }],
      attempts: [[{}, 'complete']] },
    // One restore closes the first task back at 2 days and reopens the second task's own 5 days: only the reopening needs a grant.
    { name: 'closed days go back while another task reopens', tasks: [fight({ IsEnable: true }), fight({ UseExpiringMedicine: true, MedicineExpireDays: 5 })], grant: days(3),
      changes: [{ path: restoreField(0, 'UseExpiringMedicine'), value: true }, { path: restoreField(0, 'MedicineExpireDays'), value: 3 }, { path: restoreField(1, 'UseExpiringMedicine'), value: false }],
      attempts: [[{}, 'expiring-grant-required'], [days(3), 'expiring-days-mismatch'], [days(5), 'complete']] },
    // The same restores when the backup had the class open: restoring reopens it, so only the current grant for the backup's value works.
    { name: 'expiring medicine open at 2 days, closed at 3', tasks: [fight({ IsEnable: true, UseExpiringMedicine: true, MedicineExpireDays: 2 })], grant: days(3),
      changes: [{ path: restoreField(0, 'UseExpiringMedicine'), value: false }, { path: restoreField(0, 'MedicineExpireDays'), value: 3 }],
      attempts: [[{}, 'expiring-grant-required'], [days(3), 'expiring-days-mismatch'], [days(2), 'complete']] },
    { name: 'stone open with 5, closed at 2', tasks: [fight({ IsEnable: true, UseStone: true, UseStoneAllowSave: true, StoneCount: 5 })], grant: { stoneCount: 2 },
      changes: [{ path: restoreField(0, 'UseStone'), value: false }, { path: restoreField(0, 'UseStoneAllowSave'), value: false }, { path: restoreField(0, 'StoneCount'), value: 2 }],
      attempts: [[{}, 'stone-grant-required'], [{ stoneCount: 2 }, 'stone-quantity-exceeded'], [{ stoneCount: 5 }, 'complete']] },
  ];
  for (const sample of cases) await t.test(sample.name, async t => { await restoreOutcome(t, sample); });
});

test('an interrupted restore that took a closed class back without a grant can itself be reconciled', async t => {
  const f = await maaFixture(t, config([fight({ IsEnable: true })]));
  const original = await readFile(f.file, 'utf8');
  const evidenceRevision = await abandonedTransaction(f, days(3),
    [{ path: restoreField(0, 'UseExpiringMedicine'), value: true }, { path: restoreField(0, 'MedicineExpireDays'), value: 3 }]);
  const backups = join(f.privateDirectory, 'maa-config-backups'); const past = new Date(Date.now() - 60000);
  for (const file of await readdir(backups)) await utimes(join(backups, file), past, past);
  const start = f.maa.start;
  f.maa.start = async () => { throw new Error('synthetic restart failure'); };
  const interrupted = await executeRepairs({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex',
    approved: ['restore-config'], reference: 'restore the earlier settings', evidenceRevision, closedConfirmed: true }, f.maa);
  assert.equal(interrupted.status, 'unknown', JSON.stringify(interrupted));
  assert.equal(await readFile(f.file, 'utf8') === original, false, 'the restore wrote its formatted configuration before the restart');
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), JSON.parse(original));
  // The doctor process that held the retained lock has exited.
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  const lockFile = join(f.maaDirectory, 'config', '.maa-skills.lock'); const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  assert.equal(lock.skill, 'maa-doctor');
  await writeFile(lockFile, JSON.stringify({ ...lock, pid: dead }));
  const pendingFile = join(f.privateDirectory, 'daily-pending.jsonl');
  const lines = (await readFile(pendingFile, 'utf8')).trim().split('\n');
  lines[lines.length - 1] = JSON.stringify({ ...JSON.parse(lines.at(-1)!), pid: dead });
  await writeFile(pendingFile, lines.join('\n') + '\n');
  const closed = await inspectConfigRecovery(f, f.maa);
  assert.equal(closed.comparison, 'applied', JSON.stringify(closed)); assert.equal(closed.process, 'closed'); assert.equal(closed.canRestore, true);
  f.maa.start = start; await f.maa.start();
  const ready = await inspectConfigRecovery(f, f.maa);
  assert.equal(ready.canReconcile, true, JSON.stringify(ready));
  const reconciled = await executeRepairs({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, host: 'codex',
    approved: ['reconcile-lock'], reference: 'keep the restored settings', evidenceRevision: ready.evidenceRevision }, f.maa);
  assert.equal(reconciled.status, 'complete', JSON.stringify(reconciled));
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), JSON.parse(original));
  assert.deepEqual(await readdir(join(f.maaDirectory, 'config')), ['gui.new.json']);
});

test('an ordinary write of the pre-transaction values gets no restore allowance', async t => {
  const cases = [
    { name: 'expiring medicine', task: fight({ IsEnable: true, UseExpiringMedicine: true, MedicineExpireDays: 3 }), reason: 'expiring-grant-required',
      changes: [{ path: task(0, 'UseExpiringMedicine'), value: false }, { path: task(0, 'MedicineExpireDays'), value: 2 }] },
    { name: 'stone', task: fight({ IsEnable: true, UseStone: true, UseStoneAllowSave: true, StoneCount: 2 }), reason: 'stone-grant-required',
      changes: [{ path: task(0, 'UseStone'), value: false }, { path: task(0, 'UseStoneAllowSave'), value: false }, { path: task(0, 'StoneCount'), value: 5 }] },
  ];
  for (const sample of cases) await t.test(sample.name, async t => {
    const f = await maaFixture(t, config([sample.task])); const before = await readFile(f.file);
    await refusedBeforeProcess(f, await write(f, {}, sample.changes), before, sample.reason);
  });
});

test('the restore allowance needs the doctor-restore consumer, values equal to the backup task and a class that ends closed', () => {
  const current = { source: 'current-request' as const };
  const opened = fight({ UseExpiringMedicine: true, MedicineExpireDays: 3 });
  const stoneOpened = fight({ UseStone: true, UseStoneAllowSave: true, StoneCount: 2 });
  // Allowed: closed again, every changed value equal to the backup task's.
  assert.equal(decide(current, [{ task: fight(), before: opened, restore: fight() }], 'doctor-restore').allowed, true);
  assert.equal(decide(current, [{ task: fight({ StoneCount: 5 }), before: stoneOpened, restore: fight({ StoneCount: 5 }) }], 'doctor-restore').allowed, true);
  // A value that is not the backup's, while the class stays closed.
  assert.equal(decide(current, [{ task: fight({ MedicineExpireDays: 4 }), before: opened, restore: fight() }], 'doctor-restore').reason, 'expiring-grant-required');
  assert.equal(decide(current, [{ task: fight({ StoneCount: 6 }), before: stoneOpened, restore: fight({ StoneCount: 5 }) }], 'doctor-restore').reason, 'stone-grant-required');
  // The backup task is not a Fight task.
  assert.equal(decide(current, [{ task: fight({ StoneCount: 5 }), before: stoneOpened, restore: { StoneCount: 5 } }], 'doctor-restore').reason, 'stone-grant-required');
  // The class ends open: the backup's values reopen it.
  const reopened = fight({ UseExpiringMedicine: true, MedicineExpireDays: 2 });
  assert.equal(decide(current, [{ task: reopened, before: fight({ MedicineExpireDays: 3 }), restore: reopened }], 'doctor-restore').reason, 'expiring-grant-required');
  // Not a current request.
  assert.equal(decide({ source: 'approved-report' }, [{ task: fight(), before: opened, restore: fight() }], 'doctor-restore').reason, 'current-request-required');
  // Every other consumer refuses a target that carries a backup task.
  for (const consumer of consumptionConsumers.filter(item => item !== 'doctor-restore')) {
    assert.equal(decide(current, [{ task: fight(), before: opened, restore: fight() }], consumer).reason, 'consumption-grant-invalid', consumer);
  }
});

async function codeFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await codeFiles(path)); else if (/\.(?:ts|mjs)$/.test(entry.name)) result.push(path);
  }
  return result;
}

test('every producer and consumer of the consumption predicate is registered, labelled once and has an allow and a refuse sample', async () => {
  const sites: Record<string, string> = {}; const unlabelled: string[] = [];
  for (const directory of ['skills', 'scripts', 'eval']) for (const path of await codeFiles(join(repository, directory))) {
    const file = relative(repository, path).replaceAll('\\', '/');
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (!/\bdecideConsumption\(/.test(line) || /function decideConsumption\(/.test(line)) continue;
      const label = line.match(/\bdecideConsumption\(.*consumer: '([a-z-]+)'/)?.[1];
      if (!label) { unlabelled.push(file); continue; }
      assert.equal(sites[label], undefined, `${label} has one call site`);
      sites[label] = file;
    }
  }
  assert.deepEqual(unlabelled, [], 'every call names its consumer on the same line');
  assert.deepEqual(Object.keys(sites).sort(), [...consumptionConsumers].sort(), 'the registry lists exactly the call sites in the code');
  assert.deepEqual(Object.keys(conformance).sort(), [...consumptionConsumers].sort(), 'every registered consumer has samples');
  for (const [label, sample] of Object.entries(conformance)) assert.equal(sites[label], sample.file, `${label} is called from its registered file`);
});

for (const [consumer, sample] of Object.entries(conformance)) {
  test(`${consumer} allows what the predicate allows`, async t => { await sample.allow(t); });
  test(`${consumer} refuses what the predicate refuses`, async t => { await sample.refuse(t); });
}

/**
 * Every caller of the unified writer's entries (merge of 27 with 10, 17, 23 and 25, 2026-11-14). None calls the predicate
 * itself: each write reaches it inside the writer (`writer-whitelist`, `indirect-consumption` and `quantity-budget` above; doctor's
 * recovery also `doctor-recovery` and `doctor-restore`). `plan` is the plan its authorization carries, which decides what grant
 * the predicate lets through: none for a base plan, only expiring medicine for a job or training plan, none for setup. Each row
 * names the tests that show, through that caller's own route, that it activates nothing without a grant and that a grant the
 * predicate refuses for its plan is refused.
 */
const writerCallers: Record<string, { plan: 'request' | 'job' | 'training' | 'base' | 'setup' | 'recovery'; evidence: [file: string, title: string][] }> = {
  'skills/maa-core/scripts/maa-config.ts': { plan: 'request', evidence: [
    ['tests/base-apply.test.ts', 'the base grant is only reachable through base-apply: the writer CLI refuses it and a forged grant is rejected'],
    ['tests/stage-run-alternates.test.ts', 'the unified writer accepts only the continuation list of approved jobs; the generic write CLI refuses any continuation']] },
  'skills/maa-core/scripts/stage-jobs.ts': { plan: 'job', evidence: [
    ['tests/training-integration.test.ts', 'a job plan write enables nothing: open Fight consumption is left byte for byte, with or without an expiring grant']] },
  'skills/maa-core/scripts/stage-run.ts': { plan: 'job', evidence: [
    ['tests/stage-run-alternates.test.ts', 'an alternate switch never activates a consuming task, and no quantity grant can ride along its job plan']] },
  'skills/maa-core/scripts/training-plan.ts': { plan: 'training', evidence: [
    ['tests/training-integration.test.ts', 'a training timer write that reaches open expiring medicine needs the current expiring grant, and open stone refuses it']] },
  'skills/maa-core/scripts/base-apply.ts': { plan: 'base', evidence: [
    ['tests/base-apply.test.ts', 'a base plan carries no consumption grant: medicine, stone or expiring medicine alongside it is refused by the consumption predicate'],
    ['tests/base-apply.test.ts', 'a base apply never activates a consuming task: an enabled Fight task with medicine, stone and expiring medicine on is left alone']] },
  'skills/maa-core/scripts/setup.ts': { plan: 'setup', evidence: [
    ['tests/setup-integration.test.ts', 'setup rejects complete job, training and medicine grants in request or context without creating a transaction']] },
  'skills/maa-core/scripts/doctor.ts': { plan: 'recovery', evidence: [
    ['tests/consumption-grant.test.ts', 'doctor recovery never reuses the interrupted transaction grant when restoring would reopen stone or expiring medicine'],
    ['tests/doctor.test.ts', 'the pending-record table accepts the version stamp with all three consumption grants, and nothing else new']] },
};

test('every caller of the unified writer is registered with its plan and with tests through its own route', async () => {
  const callers = new Set<string>();
  for (const directory of ['skills', 'scripts', 'eval']) for (const path of await codeFiles(join(repository, directory))) {
    const text = await readFile(path, 'utf8');
    if (text.split('\n').some(line => /\b(?:executeConfigWrite|executeSetupConfigWrite|executeConfigRecovery)\(/.test(line) && !/\bfunction\s+execute/.test(line))) {
      callers.add(relative(repository, path).replaceAll('\\', '/'));
    }
  }
  assert.deepEqual([...callers].sort(), Object.keys(writerCallers).sort(), 'the registry lists exactly the files that call the writer');
  for (const [caller, { evidence }] of Object.entries(writerCallers)) for (const [file, title] of evidence) {
    assert.ok((await readFile(join(repository, file), 'utf8')).includes(`test('${title}'`), `${caller}: ${file} has the test «${title}»`);
  }
});

test('scenario forbidden-key lists name only settings no grant can open, and every declared grant is one the predicate accepts', async () => {
  const { scenarioCatalog } = await import('../scripts/eval-scenarios.ts');
  const { consumptionFields } = await import('../skills/maa-core/scripts/consumption-grant.ts');
  const governed = [...Object.keys(consumptionFields), 'stone'];
  for (const entry of scenarioCatalog()) {
    if (typeof entry.definition === 'string') continue;
    const { id, policy } = entry.definition as unknown as { id: string; policy: Policy };
    assert.deepEqual(policy.forbiddenKeys.filter(key => governed.includes(key)), [], `${id} leaves consumption to the predicate`);
    if (policy.consumptionGrant) assert.equal(decide(policy.consumptionGrant, [], 'eval-grader').allowed, true, id);
  }
});
