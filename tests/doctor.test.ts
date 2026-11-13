import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { runChecks, executeRepairs } from '../skills/maa-core/scripts/doctor.ts';
import { type MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';
import { readVerificationRecord } from '../skills/maa-core/scripts/maa-version.ts';
import { versionDoublePreload } from './fixtures/maa-version-guard.ts';

const windows = process.platform === 'win32';
// MAA.exe metadata and adb are system boundaries; the other checks read the real temporary directories.
const quiet = { versionReader: async () => null, adb: { run: async () => { throw new Error('adb must not run'); } } };

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'maa-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const maaDirectory = join(root, 'maa'); const privateDirectory = join(root, 'private'); const home = join(root, 'settings');
  await mkdir(join(maaDirectory, 'config'), { recursive: true });
  await writeFile(join(maaDirectory, 'MAA.exe'), 'synthetic executable placeholder'); await mkdir(privateDirectory);
  await updateSettings({ language: 'zh-CN', privateDirectory, maaDirectory }, home);
  const config = { Current: 'Synthetic private profile', Configurations: { 'Synthetic private profile': { TaskQueue: [], Gui: { RuntimeSettings: { ClientType: 'Official' } } } },
    Timers: { List: [], NotifyBeforeScheduledStart: false, ScheduledStartNotificationMinutes: 5 }, PrivateExample: 'synthetic-hidden-value' };
  const file = join(maaDirectory, 'config/gui.new.json');
  await writeFile(file, JSON.stringify(config));
  const actions: string[] = []; let running = true;
  const maa: MaaProcess = { inspect: async () => ({ running, ready: running, treeExited: !running, idle: true }),
    close: async () => { actions.push('close'); running = false; }, start: async () => { actions.push('start'); running = true; }, version: quiet.versionReader };
  return { root, home, maaDirectory, privateDirectory, config, file, maa, actions, setRunning: (value: boolean) => { running = value; } };
}

test('shared checks report configuration and lock status without changing either file', async (t) => {
  const f = await fixture(t); const original = await readFile(f.file);
  const result = await runChecks(f, f.maa, quiet);
  assert.equal(result.exitCode, windows ? 0 : 1);
  assert.deepEqual(result.checks.map(item => [item.id, item.status]), [['platform', windows ? 'normal' : 'error'], ['maa', 'normal'], ['server', 'normal'], ['node', 'normal'],
    ['settings', 'normal'], ['private-directory', 'normal'], ['version', 'warning'], ['connection', 'warning'], ['configuration', 'normal'], ['configuration-fields', 'normal'],
    ['remote-control', 'normal'], ['write-lock', 'normal'], ['credential-nga', 'normal'], ['credential-skland', 'normal'], ['credential-bilibili', 'normal'],
    ['private-files', 'normal'], ['skill-version', 'normal'], ['skill-links', 'normal']]);
  for (const item of result.checks) { assert.ok(item.reason); assert.ok(item.repair.id); assert.ok(['skill', 'user'].includes(item.repair.executor)); }
  assert.deepEqual(await readFile(f.file), original);
  assert.deepEqual(await readdir(join(f.maaDirectory, 'config')), ['gui.new.json']);
  assert.deepEqual(f.actions, []);
  const record = JSON.parse(await readFile(join(f.privateDirectory, 'doctor-latest.json'), 'utf8'));
  assert.deepEqual(record, result); assert.ok(Number.isFinite(Date.parse(record.checkedAt)));
  assert.doesNotMatch(JSON.stringify(result), /Synthetic private profile|synthetic-hidden-value|maa-doctor-/);
});

test('only explicitly named current evidence can release a reconciled lock, with an archive and no replay', async (t) => {
  const f = await fixture(t); const retained = await abandoned(f); const original = await readFile(f.file);
  const checked = await runChecks(f, f.maa, quiet);
  for (const approved of [[], ['all'], ['manual-lock'], ['reconcile-lock', 'restore-config']]) {
    const rejected = await executeRepairs({ ...f, host: 'codex', evidenceRevision: checked.recovery.evidenceRevision, approved, reference: 'synthetic named approval' }, f.maa);
    assert.equal(rejected.status, 'rejected'); assert.deepEqual(await readFile(f.file), original); assert.ok(await readFile(retained.lockFile));
  }
  const result = await executeRepairs({ ...f, host: 'codex', evidenceRevision: checked.recovery.evidenceRevision, approved: ['reconcile-lock'], reference: 'synthetic reconcile approval' }, f.maa);
  assert.equal(result.status, 'complete'); assert.deepEqual(f.actions, []); assert.deepEqual(await readFile(f.file), original);
  assert.equal((await readdir(join(f.maaDirectory, 'config'))).includes('.maa-skills.lock'), false);
  assert.ok((await readdir(join(f.privateDirectory, 'maa-config-reconciliations'))).length);
});

test('a changed evidence revision or unverified result retains its lock', async (t) => {
  for (const mode of ['revision', 'unknown', 'closed-applied']) await t.test(mode, async (t) => {
    const f = await fixture(t); const retained = await abandoned(f); const checked = await runChecks(f, f.maa, quiet);
    if (mode === 'revision') await writeFile(f.file, JSON.stringify({ ...f.config, changedExternally: true }));
    if (mode === 'unknown') await rm(join(f.privateDirectory, 'daily-pending.jsonl'));
    if (mode === 'closed-applied') f.setRunning(false);
    const before = await readFile(f.file); const lock = await readFile(retained.lockFile);
    const result = await executeRepairs({ ...f, host: 'codex', evidenceRevision: checked.recovery.evidenceRevision, approved: ['reconcile-lock'], reference: 'synthetic approval' }, f.maa);
    assert.equal(result.status, 'rejected'); assert.deepEqual(await readFile(f.file), before); assert.deepEqual(await readFile(retained.lockFile), lock); assert.deepEqual(f.actions, []);
  });
});

test('approved restoration changes only recorded fields through the writer and retains unknown results', async (t) => {
  for (const mode of ['complete', 'closed-unconfirmed', 'closed-confirmed', 'restart-failure', 'timer-window', 'not-idle']) await t.test(mode, async (t) => {
    const f = await fixture(t);
    if (mode === 'timer-window') Object.assign(f.config.Timers, { List: [{ IsEnabled: true, Hour: new Date().getHours(), Minute: new Date().getMinutes(), Config: 'Synthetic private profile' }] });
    const retained = await abandoned(f); const before = await readFile(f.file);
    if (mode.startsWith('closed-')) f.setRunning(false);
    if (mode === 'restart-failure') f.maa.start = async () => { throw new Error('synthetic MAA failure'); };
    if (mode === 'not-idle') f.maa.inspect = async () => ({ running: true, treeExited: false, ready: true, idle: false });
    const checked = await runChecks(f, f.maa, quiet);
    const result = await executeRepairs({ ...f, host: 'codex', approved: ['restore-config'], reference: 'restore the reminder only',
      evidenceRevision: checked.recovery.evidenceRevision, closedConfirmed: mode === 'closed-confirmed' }, f.maa);
    if (['complete', 'closed-confirmed'].includes(mode)) {
      assert.equal(result.status, 'complete'); assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), f.config);
      assert.equal((await readdir(join(f.maaDirectory, 'config'))).includes('.maa-skills.lock'), false);
      const backups = await readdir(join(f.privateDirectory, 'maa-config-backups'));
      assert.equal(backups.length, 2); assert.deepEqual(await readFile(join(f.privateDirectory, 'maa-config-backups', backups.find(file => file !== retained.id + '.json')!)), before);
      assert.match(await readFile(join(f.privateDirectory, 'daily-runs.jsonl'), 'utf8'), /"skill":"maa-doctor".*"status":"complete"/);
    } else {
      assert.equal(result.status, mode === 'restart-failure' ? 'unknown' : 'rejected'); assert.ok(await readFile(retained.lockFile));
      if (mode !== 'restart-failure') { assert.deepEqual(await readFile(f.file), before); assert.deepEqual(f.actions, []); }
    }
  });
});

test('doctor CLI provides human and JSON reports with 0/1/2 exit codes and refuses broad repair approval', async (t) => {
  const f = await fixture(t); const settingsHome = f.home;
  const env = { ...process.env, MAA_SKILLS_HOME: settingsHome, USERPROFILE: f.root, HOME: f.root };
  const cli = fileURLToPath(new URL('../skills/maa-core/scripts/doctor.ts', import.meta.url));
  const invoke = (args: string[], input: unknown = {}) => spawnSync(process.execPath, ['--import', versionDoublePreload, cli, ...args], { env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
  const healthy = invoke(['check', '--json']); assert.equal(healthy.status, windows ? 0 : 1, healthy.stdout); assert.equal(JSON.parse(healthy.stdout).exitCode, windows ? 0 : 1);
  const human = invoke(['check']); assert.equal(human.status, windows ? 0 : 1); assert.match(human.stdout, /configuration/); assert.match(human.stdout, /正常|normal/);
  const invalid = invoke(['repair', '--json'], { approved: ['all'], host: 'codex', reference: 'all' }); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).status, 'rejected');
  await writeFile(f.file, '{');
  const corrupt = invoke(['check', '--json']); assert.equal(corrupt.status, 1); assert.equal(JSON.parse(corrupt.stdout).checks.find((item: { id: string }) => item.id === 'configuration').status, 'error');
  await rm(f.privateDirectory, { recursive: true }); await writeFile(f.privateDirectory, 'synthetic blocked directory');
  const failed = invoke(['check', '--json']); assert.equal(failed.status, 2); assert.equal(JSON.parse(failed.stdout).status, 'unexpected-failure');
  assert.doesNotMatch(healthy.stdout + human.stdout + corrupt.stdout + failed.stdout, /Synthetic private profile|synthetic-hidden-value|maa-doctor-/);
});

test('unsupported transaction evidence and prohibited recovery settings cannot authorize a repair', async (t) => {
  for (const mode of ['future-manifest', 'future-authorization', 'forbidden-setting', 'different-config', 'wrong-owner', 'newer-backup', 'ambiguous-backup']) await t.test(mode, async (t) => {
    const f = await fixture(t); const retained = await abandoned(f);
    const pendingFile = join(f.privateDirectory, 'daily-pending.jsonl');
    const pending = JSON.parse((await readFile(pendingFile, 'utf8')).trim());
    if (mode === 'future-manifest') pending.trainingPlan = { file: 'synthetic-unverified-asset.json' };
    if (mode === 'future-authorization') pending.authorization.jobPlan = { file: 'synthetic-unverified-job.json' };
    if (mode === 'forbidden-setting') pending.changes = [{ path: ['Configurations', 'Synthetic private profile', 'Gui', 'StartGame'], value: true }];
    if (mode === 'different-config') await writeFile(f.file, JSON.stringify({ ...f.config, unrelatedChange: true }));
    if (mode === 'wrong-owner') pending.pid = process.pid;
    if (mode === 'newer-backup') await writeFile(join(f.privateDirectory, 'maa-config-backups', randomUUID() + '.json'), JSON.stringify(f.config));
    if (mode === 'ambiguous-backup') {
      const other = join(f.privateDirectory, 'maa-config-backups', '00000000-0000-4000-8000-000000000000.json');
      await writeFile(other, JSON.stringify(f.config)); const time = new Date('2026-01-01T00:00:00.000Z');
      await utimes(other, time, time); await utimes(join(f.privateDirectory, 'maa-config-backups', retained.id + '.json'), time, time);
    }
    await writeFile(pendingFile, JSON.stringify(pending) + '\n');
    const original = await readFile(f.file); const lock = await readFile(retained.lockFile);
    const checked = await runChecks(f, f.maa, quiet);
    assert.equal(checked.recovery.canReconcile, false); assert.equal(checked.recovery.canRestore, false);
    const result = await executeRepairs({ ...f, host: 'codex', approved: ['restore-config'], reference: 'synthetic approval', evidenceRevision: checked.recovery.evidenceRevision }, f.maa);
    assert.equal(result.status, 'rejected'); assert.deepEqual(await readFile(f.file), original); assert.deepEqual(await readFile(retained.lockFile), lock);
  });
});

test('parallel approved restorations perform one transaction and reject the competing recovery', async (t) => {
  const f = await fixture(t); await abandoned(f);
  const checked = await runChecks(f, f.maa, quiet);
  const request = { ...f, host: 'codex' as const, approved: ['restore-config'], reference: 'synthetic restore approval', evidenceRevision: checked.recovery.evidenceRevision };
  const results = await Promise.all([executeRepairs(request, f.maa), executeRepairs(request, f.maa)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['complete', 'rejected']);
  assert.deepEqual(f.actions, ['close', 'start']);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), f.config);
});

test('unknown or malformed transaction metadata never permits either recovery action', async (t) => {
  const cases: { target: 'lock' | 'pending' | 'authorization' | 'change'; key: string; value?: unknown; omit?: boolean; name?: string }[] = [
    { target: 'lock', key: 'jobPlan', value: { file: 'synthetic-unverified-resource.json' } },
    { target: 'change', key: 'trainingPlan', value: { file: 'synthetic-unverified-resource.json' } },
    { target: 'pending', key: 'authorization', value: {} },
    ...['id', 'skill', 'host', 'pid', 'startedAt', 'phase'].map(key => ({ target: 'lock' as const, key, omit: true })),
    { target: 'lock', key: 'id', value: 'not-an-operation' },
    { target: 'lock', key: 'skill', value: 'future-writer' },
    { target: 'lock', key: 'host', value: ['codex'] },
    { target: 'lock', key: 'pid', value: -1 },
    { target: 'lock', key: 'startedAt', value: '2026-01-01' },
    { target: 'lock', key: 'phase', value: 'future-phase' },
    ...['id', 'skill', 'host', 'pid', 'startedAt', 'phase', 'authorization', 'changes'].map(key => ({ target: 'pending' as const, key, omit: true })),
    { target: 'pending', key: 'phase', value: 'restart' },
    { target: 'pending', key: 'changes', value: [] },
    { target: 'authorization', key: 'source', value: 'historical-preference' },
    { target: 'authorization', key: 'source', omit: true },
    { target: 'authorization', key: 'reference', omit: true },
    { target: 'authorization', key: 'reference', value: '   ' },
    { target: 'authorization', key: 'reference', value: { text: 'synthetic approval' } },
    { target: 'authorization', key: 'medicineCount', value: -1 },
    { target: 'authorization', key: 'medicineCount', value: 1.5 },
    { target: 'authorization', key: 'medicineCount', value: 2147483648 },
    { target: 'authorization', key: 'medicineCount', value: '1' },
    { target: 'change', key: 'path', omit: true },
    { target: 'change', key: 'value', omit: true },
    { target: 'change', key: 'path', value: ['Timers', { name: 'NotifyBeforeScheduledStart' }] },
    { target: 'change', key: 'path', value: [] },
  ];
  for (const sample of cases) await t.test(`${sample.target}.${sample.key} ${sample.omit ? 'missing' : JSON.stringify(sample.value)}`, async (t) => {
    const f = await fixture(t); const retained = await abandoned(f);
    const lock = JSON.parse(await readFile(retained.lockFile, 'utf8'));
    const pendingFile = join(f.privateDirectory, 'daily-pending.jsonl');
    const pending = JSON.parse((await readFile(pendingFile, 'utf8')).trim());
    const target = sample.target === 'lock' ? lock : sample.target === 'pending' ? pending : sample.target === 'change' ? pending.changes[0] : pending['authorization'];
    if (sample.omit) delete target[sample.key]; else target[sample.key] = sample.value;
    await writeFile(retained.lockFile, JSON.stringify(lock)); await writeFile(pendingFile, JSON.stringify(pending) + '\n');
    const original = await readFile(f.file); const lockBytes = await readFile(retained.lockFile); const pendingBytes = await readFile(pendingFile);
    const checked = await runChecks(f, f.maa, quiet);
    assert.equal(checked.recovery.comparison, 'unknown');
    assert.equal(checked.recovery.canReconcile, false); assert.equal(checked.recovery.canRestore, false);
    for (const action of ['reconcile-lock', 'restore-config']) {
      const result = await executeRepairs({ ...f, host: 'codex', approved: [action], reference: 'synthetic current approval', evidenceRevision: checked.recovery.evidenceRevision }, f.maa);
      assert.equal(result.status, 'rejected'); assert.deepEqual(await readFile(retained.lockFile), lockBytes);
      assert.deepEqual(await readFile(f.file), original); assert.deepEqual(await readFile(pendingFile), pendingBytes);
    }
    assert.deepEqual(f.actions, []);
  });
});

test('transaction schema checks preserve unrelated MAA configuration fields during valid recovery', async (t) => {
  for (const action of ['reconcile-lock', 'restore-config']) await t.test(action, async (t) => {
    const f = await fixture(t);
    Object.assign(f.config, { jobPlan: { file: 'synthetic-maa-owned-value.json' }, trainingPlan: { future: true }, authorization: {} });
    await abandoned(f);
    const checked = await runChecks(f, f.maa, quiet);
    assert.equal(checked.recovery.canReconcile, true); assert.equal(checked.recovery.canRestore, true);
    const result = await executeRepairs({ ...f, host: 'codex', approved: [action], reference: 'synthetic approval', evidenceRevision: checked.recovery.evidenceRevision }, f.maa);
    assert.equal(result.status, 'complete');
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), action === 'restore-config' ? f.config : { ...f.config, Timers: { ...f.config.Timers, NotifyBeforeScheduledStart: true } });
  });
});

test('evidence changed during final reconciliation is retained rather than cleared', async (t) => {
  const f = await fixture(t); const retained = await abandoned(f); const checked = await runChecks(f, f.maa, quiet);
  let calls = 0; const originalInspect = f.maa.inspect;
  f.maa.inspect = async () => {
    calls++;
    if (calls === 2) await writeFile(retained.lockFile, JSON.stringify({ ...retained.metadata, id: randomUUID() }));
    return originalInspect();
  };
  const result = await executeRepairs({ ...f, host: 'codex', approved: ['reconcile-lock'], reference: 'synthetic approval', evidenceRevision: checked.recovery.evidenceRevision }, f.maa);
  assert.notEqual(result.status, 'complete'); assert.ok(await readFile(retained.lockFile)); assert.deepEqual(f.actions, []);
});

async function abandoned(f: Awaited<ReturnType<typeof fixture>>, applied = true) {
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(dead.status, 0);
  const id = randomUUID();
  const metadata = { id, skill: 'maa-daily', host: 'codex', pid: dead.pid, startedAt: new Date().toISOString(), phase: 'restart' };
  await mkdir(join(f.privateDirectory, 'maa-config-backups'), { recursive: true });
  await writeFile(join(f.privateDirectory, 'maa-config-backups', id + '.json'), JSON.stringify(f.config));
  await writeFile(join(f.privateDirectory, 'daily-pending.jsonl'), JSON.stringify({ ...metadata, phase: 'check', authorization: { source: 'current-request', reference: 'synthetic approved reminder' },
    changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] }) + '\n');
  const lockFile = join(f.maaDirectory, 'config/.maa-skills.lock');
  await writeFile(lockFile, JSON.stringify(metadata));
  if (applied) await writeFile(f.file, JSON.stringify({ ...f.config, Timers: { ...f.config.Timers, NotifyBeforeScheduledStart: true } }));
  return { id, metadata, lockFile };
}

test('recovery reports a changed MAA or record version since the pending record was written, without refusing', async (t) => {
  const recordVersion = (await readVerificationRecord()).recordVersion;
  for (const mode of ['changed', 'same', 'unrecorded', 'malformed']) await t.test(mode, async (t) => {
    const f = await fixture(t); const retained = await abandoned(f);
    const pendingFile = join(f.privateDirectory, 'daily-pending.jsonl');
    const pending = JSON.parse((await readFile(pendingFile, 'utf8')).trim());
    if (mode !== 'unrecorded') pending.versions = mode === 'malformed' ? { maaVersion: 'latest', recordVersion } : { maaVersion: mode === 'changed' ? '6.21.4' : '6.22.0', recordVersion };
    await writeFile(pendingFile, JSON.stringify(pending) + '\n');
    f.maa.version = async () => '6.22.0';
    const checked = await runChecks(f, f.maa, quiet);
    if (mode === 'malformed') { assert.equal(checked.recovery.canReconcile, false); assert.equal(checked.recovery.versions, null); return; }
    const current = { maaVersion: '6.22.0', recordVersion };
    assert.deepEqual(checked.recovery.versions, mode === 'unrecorded' ? { state: 'unrecorded', recorded: null, current, changed: [] }
      : { state: mode, recorded: pending.versions, current, changed: mode === 'changed' ? ['maaVersion'] : [] });
    const result = await executeRepairs({ ...f, host: 'codex', evidenceRevision: checked.recovery.evidenceRevision, approved: ['reconcile-lock'], reference: 'synthetic reconcile approval' }, f.maa);
    assert.deepEqual([result.status, (result as { versions?: unknown }).versions], ['complete', checked.recovery.versions]);
    assert.ok(retained.id);
  });
});

test('a restoration writes the current version stamp into its own pending record', async (t) => {
  const f = await fixture(t); await abandoned(f);
  f.maa.version = async () => '6.22.0';
  const checked = await runChecks(f, f.maa, quiet);
  const result = await executeRepairs({ ...f, host: 'codex', approved: ['restore-config'], reference: 'restore the reminder only', evidenceRevision: checked.recovery.evidenceRevision }, f.maa);
  assert.equal(result.status, 'complete');
  const lines = (await readFile(join(f.privateDirectory, 'daily-pending.jsonl'), 'utf8')).trim().split('\n');
  assert.deepEqual(JSON.parse(lines.at(-1)!).versions, { maaVersion: '6.22.0', recordVersion: (await readVerificationRecord()).recordVersion });
});

test('diagnosis distinguishes live, stale applied, stale unchanged and unprovable locks with redacted evidence', async (t) => {
  for (const mode of ['active', 'applied', 'unchanged', 'missing-backup', 'corrupt', 'closed', 'malformed']) await t.test(mode, async (t) => {
    const f = await fixture(t); const retained = await abandoned(f, mode !== 'unchanged');
    if (mode === 'active') await writeFile(retained.lockFile, JSON.stringify({ ...retained.metadata, pid: process.pid }));
    if (mode === 'missing-backup') await rm(join(f.privateDirectory, 'maa-config-backups'), { recursive: true });
    if (mode === 'corrupt') await writeFile(f.file, '{');
    if (mode === 'closed') f.setRunning(false);
    if (mode === 'malformed') await writeFile(retained.lockFile, '{');
    const before = await readFile(f.file); const lock = await readFile(retained.lockFile);
    const result = await runChecks(f, f.maa, quiet);
    assert.equal(result.exitCode, windows && mode === 'active' ? 0 : 1);
    assert.equal(result.recovery.lock, mode === 'active' ? 'active' : mode === 'malformed' ? 'unknown' : 'stale');
    assert.equal(result.recovery.comparison, ['applied', 'closed'].includes(mode) ? 'applied' : mode === 'unchanged' ? 'unchanged' : 'unknown');
    assert.equal(result.recovery.canReconcile, ['applied', 'unchanged'].includes(mode));
    assert.equal(result.recovery.canRestore, ['applied', 'closed'].includes(mode));
    assert.deepEqual(await readFile(f.file), before); assert.deepEqual(await readFile(retained.lockFile), lock);
    assert.deepEqual(f.actions, []);
    assert.doesNotMatch(JSON.stringify(result), /Synthetic private profile|synthetic-hidden-value|maa-doctor-/);
  });
});
