import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createMaaProcess, type ProcessControl, type ProcessIdentity } from '../skills/maa-core/scripts/maa-process.ts';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-maa-process.mjs', import.meta.url));
const nativeEnvironmentKeys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR'] as const;
let nativeRuntimeRoot: string | undefined;
const previousNativeEnvironment = new Map<string, string | undefined>();
after(async () => {
  if (!nativeRuntimeRoot) return;
  for (const [key, previous] of previousNativeEnvironment) {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
  await rm(nativeRuntimeRoot, { recursive: true, force: true });
});
before(async () => {
  if (process.platform === 'win32') {
    nativeRuntimeRoot = await mkdtemp(join(tmpdir(), 'maa-native-runtime-'));
    for (const name of ['home', 'appdata', 'localappdata', 'tmp']) await mkdir(join(nativeRuntimeRoot, name));
    const locations = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp' };
    for (const key of nativeEnvironmentKeys) {
      previousNativeEnvironment.set(key, process.env[key]);
      process.env[key] = join(nativeRuntimeRoot, locations[key]);
    }
    // Prepare the OS facility once, separately from the product's unchanged five-second command budget.
    // No product call is retried: a failed preparation or later observation fails this test run.
    const began = performance.now();
    const shell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const preparation = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; $null = Get-CimInstance Win32_Process; Write-Output 'cim-ready'"], {
      cwd: nativeRuntimeRoot, env: { ...process.env, PSModuleAnalysisCachePath: join(tmpdir(), `maa-process-${process.pid}.cache`) },
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    });
    console.log(`Native CIM fixture preparation: ${Math.round(performance.now() - began)} ms; status=${preparation.status}; error=${preparation.error?.message ? 'command-failed' : 'none'}`);
    assert.equal(preparation.status, 0, 'native CIM fixture preparation must succeed without retry');
    assert.equal(preparation.stdout.trim(), 'cim-ready');
  }
}, { timeout: 60_000 });
async function fixture(t: TestContext, mode = 'ready', closeDelay = 0) {
  const root = await mkdtemp(join(tmpdir(), 'maa-process-'));
  const directory = join(root, 'target');
  await mkdir(directory); await writeFile(join(directory, 'MAA.exe'), 'synthetic executable');
  const children: { child: ChildProcess; identity: ProcessIdentity }[] = [];
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  });
  const spawnFake = async (where = directory, parentPid = 0) => {
    await writeFile(join(where, 'MAA.exe'), 'synthetic executable');
    const startedAt = Date.now();
    const child = fork(fake, [where, String(closeDelay), mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, HOME: root, USERPROFILE: root } });
    await once(child, 'message');
    const identity: ProcessIdentity = { pid: child.pid!, parentPid, name: 'MAA.exe', executable: join(where, 'MAA.exe'), startedAt };
    children.push({ child, identity });
    return { child, identity };
  };
  const control: ProcessControl = {
    list: async () => children.filter(({ child }) => child.exitCode === null && child.signalCode === null).map(({ identity }) => identity),
    close: async (identity) => { const found = children.find(entry => entry.identity.pid === identity.pid); found?.child.send('close'); return Boolean(found); },
    launch: async (executable, args, cwd) => { assert.equal(executable, join(directory, 'MAA.exe')); assert.equal(cwd, directory); assert.deepEqual(args, ['--skip-startup-auto-run']); await spawnFake(); },
  };
  return { root, directory, children, control, spawnFake };
}

test('the MAA process adapter observes the selected instance and only requests its normal close', async (t) => {
  const f = await fixture(t);
  const target = await f.spawnFake();
  const otherDirectory = join(f.root, 'other'); await mkdir(otherDirectory);
  const other = await f.spawnFake(otherDirectory);
  const maa = createMaaProcess(f.directory, { processControl: f.control, pollMs: 10 });
  assert.deepEqual(await maa.inspect(), { running: true, treeExited: false, idle: true, ready: true });
  await maa.close();
  assert.equal(target.child.exitCode, 0);
  assert.equal(other.child.exitCode, null);
  assert.deepEqual(await maa.inspect(), { running: false, treeExited: true, idle: false, ready: false });
  await maa.start();
  assert.equal((await maa.inspect()).ready, true);
});

test('a slow descendant prevents the close result until the whole observed process tree exits', async (t) => {
  const f = await fixture(t, 'ready', 20);
  const root = await f.spawnFake();
  const workerDirectory = join(f.root, 'worker'); await mkdir(workerDirectory);
  const worker = await f.spawnFake(workerDirectory, root.identity.pid);
  const maa = createMaaProcess(f.directory, { processControl: f.control, closeTimeoutMs: 1000, pollMs: 10 });
  await maa.inspect();
  const began = Date.now();
  const completed = maa.close();
  const timer = setTimeout(() => worker.child.send('close'), 180);
  t.after(() => clearTimeout(timer));
  await completed;
  assert.ok(Date.now() - began >= 180);
  assert.equal(worker.child.exitCode, 0);
  assert.equal((await maa.inspect()).treeExited, true);
});

test('refused close and unready restart keep the actual process alive and report a bounded failure', async (t) => {
  const f = await fixture(t, 'refuse');
  const child = await f.spawnFake();
  const maa = createMaaProcess(f.directory, { processControl: f.control, closeTimeoutMs: 80, pollMs: 10 });
  await assert.rejects(maa.close(), /^Error: maa-close-timeout$/);
  assert.equal(child.child.exitCode, null);
  assert.equal((await maa.inspect()).treeExited, false);
  const unready = await fixture(t, 'not-ready');
  const second = createMaaProcess(unready.directory, { processControl: unready.control, startTimeoutMs: 80, pollMs: 10 });
  await assert.rejects(second.start(), /^Error: maa-start-timeout$/);
  assert.equal((await second.inspect()).ready, false);
  assert.equal(unready.children[0]!.child.exitCode, null);
});

test('unknown MAA paths prevent empty-filter exit claims', async (t) => {
  const f = await fixture(t);
  const child = await f.spawnFake();
  child.identity.executable = null;
  const maa = createMaaProcess(f.directory, { processControl: f.control });
  await assert.rejects(maa.inspect(), /^Error: maa-process-path-unavailable$/);
  await assert.rejects(maa.close(), /^Error: maa-process-path-unavailable$/);
  assert.equal(child.child.exitCode, null);
});

test('current-session running, stopping, interrupt locks and resource errors prevent an idle claim', async (t) => {
  const f = await fixture(t); const child = await f.spawnFake();
  const maa = createMaaProcess(f.directory, { processControl: f.control });
  const change = async (log: string) => { child.child.send({ log }); await once(child.child, 'message'); return maa.inspect(); };
  assert.equal((await change('Idle: True to False (called from BeginRun)')).idle, false);
  assert.equal((await change('Idle: False to True (called from SetStopped)')).idle, true);
  assert.equal((await change('InterruptLock: depth=1 (called from CheckAfterCompleted)')).idle, false);
  assert.equal((await change('InterruptLock: depth=0 (called from CheckAfterCompleted)')).idle, true);
  assert.equal((await change('Stopping: False to True (called from Stop)')).idle, false);
  assert.equal((await change('Stopping: True to False (called from SetStopped)')).idle, true);
  assert.equal((await change('Init: True to False (called from Uninit)')).ready, false);
});

test('an old session and a resource failure cannot prove the current process is ready', async (t) => {
  const f = await fixture(t, 'not-ready'); const child = await f.spawnFake();
  const maa = createMaaProcess(f.directory, { processControl: f.control });
  const path = join(f.directory, 'debug', 'gui.log');
  await appendFile(path, '[2000-01-01 00:00:00.000][INF][RunningState]           <1> Init: False to True (called from Init)\n');
  assert.equal((await maa.inspect()).ready, false);
  child.child.send({ log: 'Init: False to True (called from Init)' }); await once(child.child, 'message');
  assert.equal((await maa.inspect()).ready, true);
  const now = new Date(); const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  const time = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(),3)}`;
  await appendFile(path, `[${time}][ERR][AsstProxy]              <1> Resource loading failed, loaded: False, handle created: True\n`);
  assert.deepEqual(await maa.inspect(), { running: true, treeExited: false, idle: false, ready: false });
});

test('the native Windows observer handles a nonexistent selected process without launching anything', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const maa = createMaaProcess(f.directory);
  assert.deepEqual(await maa.inspect(), { running: false, treeExited: true, idle: false, ready: false });
});

test('the native process adapter is explicitly unavailable outside Windows', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => createMaaProcess('/synthetic/maa'), /^Error: maa-process-platform-unavailable$/);
});

test('a stopped command cannot wake up later to perform a process action after its deadline', async (t) => {
  const f = await fixture(t);
  let lateAction = false; let aborted = false;
  f.control.launch = async (_file, _args, _cwd, signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { lateAction = true; resolve(); }, 160);
      signal?.addEventListener('abort', () => { clearTimeout(timer); aborted = true; reject(new Error('synthetic-secret-failure')); }, { once: true });
    });
  };
  const maa = createMaaProcess(f.directory, { processControl: f.control, startTimeoutMs: 50, pollMs: 10 });
  await assert.rejects(maa.start(), /^Error: maa-start-timeout$/);
  assert.equal(aborted, true);
  assert.equal(lateAction, false);
});

// Every native observation or request is a fresh PowerShell helper (about 1 s each on an idle desktop, several seconds
// under CPU contention), so this test grants each step the product's own budget instead of a tighter test-only one.
// The test limit is the sum of those bounded steps: compile 15 s, start 60 s, close 30 s twice, configuration read 10 s,
// write 150 s and four single observations of at most 5 s each. See docs/diagnostics/2026-11-13-maa-process-close-timeout.md.
test('Windows launches and normally closes a temporary GUI and completes a CLI configuration transaction', { skip: process.platform !== 'win32', timeout: 315_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "maa-native-'quoted-$()-"));
  const shell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const executable = join(root, 'MAA.exe');
  const source = fileURLToPath(new URL('./fixtures/fake-maa-window.cs', import.meta.url));
  const env = { ...process.env, MAA_TEST_EXE: executable, MAA_TEST_SOURCE: source, PSModuleAnalysisCachePath: join(root, 'powershell.cache') };
  t.after(async () => {
    // Only the synthetic executable under the newly created temporary directory is eligible for test cleanup.
    spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:MAA_TEST_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'], { env, windowsHide: true, stdio: 'ignore', timeout: 5000 });
    await rm(root, { recursive: true, force: true });
  });
  const compile = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:MAA_TEST_SOURCE)) -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly $env:MAA_TEST_EXE -OutputType WindowsApplication -ErrorAction Stop"], { env, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  assert.equal(compile.status, 0, 'synthetic Windows GUI compilation succeeds');
  const maa = createMaaProcess(root, { pollMs: 50 });
  await maa.start();
  assert.deepEqual(await maa.inspect(), { running: true, treeExited: false, idle: true, ready: true });
  await maa.close();
  assert.equal((await maa.inspect()).treeExited, true);

  const configDirectory = join(root, 'config'); await mkdir(configDirectory);
  const settingsDirectory = join(root, 'settings'); const privateDirectory = join(root, 'private');
  await updateSettings({ maaDirectory: root, privateDirectory }, settingsDirectory);
  const configuration = { Current: 'Synthetic', Configurations: { Synthetic: { TaskQueue: [], Gui: { StartUpSettings: { RunDirectly: false } } } }, Timers: { List: [], NotifyBeforeScheduledStart: false }, untouched: 'synthetic-private-value' };
  await writeFile(join(configDirectory, 'gui.new.json'), JSON.stringify(configuration));
  const command = fileURLToPath(new URL('../skills/maa-core/scripts/maa-config.ts', import.meta.url));
  const read = spawnSync(process.execPath, [command, 'read'], { env: { ...env, MAA_SKILLS_HOME: settingsDirectory }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(read.status, 0, read.stdout);
  const expectedRevision = JSON.parse(read.stdout).configuration.revision;
  assert.match(expectedRevision, /^[a-f0-9]{64}$/);
  // Ticket 30: the read-only preview gives the diff fingerprint the write carries; it starts no process.
  const request = { host: 'codex', expectedRevision, closedConfirmed: true, authorization: { source: 'current-request', reference: 'synthetic current request' }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] };
  const preview = spawnSync(process.execPath, [command, 'preview'], { env: { ...env, MAA_SKILLS_HOME: settingsDirectory }, encoding: 'utf8', timeout: 10_000, input: JSON.stringify(request) });
  assert.equal(preview.status, 0, preview.stdout);
  const result = spawnSync(process.execPath, [command, 'write'], { env: { ...env, MAA_SKILLS_HOME: settingsDirectory }, encoding: 'utf8', timeout: 150_000, input: JSON.stringify({ ...request, diffFingerprint: JSON.parse(preview.stdout).diffFingerprint }) });
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(Object.fromEntries(Object.entries(JSON.parse(result.stdout)).filter(([key]) => key !== 'operation')), { ok: true, status: 'complete', phase: 'complete', changedKeys: ['Timers.NotifyBeforeScheduledStart'], reason: null });
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-value|Synthetic|MAA_TEST_EXE/);
  assert.deepEqual(JSON.parse(await readFile(join(configDirectory, 'gui.new.json'), 'utf8')), { ...configuration, Timers: { ...configuration.Timers, NotifyBeforeScheduledStart: true } });
  assert.equal((await readdir(configDirectory)).includes('.maa-skills.lock'), false);
  assert.equal((await maa.inspect()).ready, true);
  await maa.close();
  assert.equal((await maa.inspect()).treeExited, true);
});

test('an executable reported through a directory alias is still the selected MAA process', async (t) => {
  const f = await fixture(t); const child = await f.spawnFake();
  const alias = join(f.root, 'alias');
  await symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  child.identity.executable = join(alias, 'MAA.exe');
  const maa = createMaaProcess(f.directory, { processControl: f.control, pollMs: 10 });
  assert.equal((await maa.inspect()).running, true);
  await maa.close();
  assert.equal(child.child.exitCode, 0);
});

test('a new busy state is checked again before sending a normal close request', async (t) => {
  const f = await fixture(t); const child = await f.spawnFake();
  const maa = createMaaProcess(f.directory, { processControl: f.control });
  assert.equal((await maa.inspect()).idle, true);
  child.child.send({ log: 'Idle: True to False (called from BeginRun)' }); await once(child.child, 'message');
  await assert.rejects(maa.close(), /^Error: maa-not-idle$/);
  assert.equal(child.child.exitCode, null);
});

function stateLine(at: number, component: string, message: string): string {
  const date = new Date(at), pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  return `[${stamp}][INF][${component}] <1> ${message}\n`;
}

test('future state evidence in the current session cannot preserve readiness or permit normal close', async (t) => {
  for (const [component, message] of [
    ['RunningState', 'Idle: True to False (called from BeginRun)'],
    ['RunningState', 'Idle: False to True (called from SetStopped)'],
    ['RunningState', 'Init: False to True (called from Init)'],
    ['Bootstrapper', 'MaaAssistantArknights GUI started'],
    ['AsstProxy', 'Resource loading failed, loaded: False, handle created: True'],
  ]) {
    const f = await fixture(t); const child = await f.spawnFake();
    const maa = createMaaProcess(f.directory, { processControl: f.control });
    assert.equal((await maa.inspect()).idle, true);
    // Real log input from the permitted synthetic MAA boundary; neither Date nor filesystem is mocked.
    await appendFile(join(f.directory, 'debug/gui.log'), stateLine(Date.now() + 60_000, component!, message!));
    await assert.rejects(maa.close(), /^Error: maa-not-idle$/, message);
    assert.equal(child.child.exitCode, null);
    assert.deepEqual(await maa.inspect(), { running: true, treeExited: false, ready: false, idle: false }, message);
  }
});

test('a new observed session can establish current state after an older session contained future evidence', async (t) => {
  const f = await fixture(t); const child = await f.spawnFake();
  const path = join(f.directory, 'debug/gui.log'), current = await readFile(path, 'utf8');
  const old = stateLine(child.identity.startedAt - 10_000, 'Bootstrapper', 'MaaAssistantArknights GUI started')
    + stateLine(Date.now() + 60_000, 'RunningState', 'Idle: True to False (called from BeginRun)');
  await writeFile(path, old + current);
  const maa = createMaaProcess(f.directory, { processControl: f.control });
  assert.deepEqual(await maa.inspect(), { running: true, treeExited: false, ready: true, idle: true });
  await maa.close(); assert.equal(child.child.exitCode, 0);
});

test('a descendant with an unreadable creation time cannot be silently omitted from exit verification', async (t) => {
  const f = await fixture(t); const root = await f.spawnFake();
  const childDirectory = join(f.root, 'worker'); await mkdir(childDirectory);
  const child = await f.spawnFake(childDirectory, root.identity.pid);
  child.identity.startedAt = -1;
  const maa = createMaaProcess(f.directory, { processControl: f.control });
  await assert.rejects(maa.inspect(), /^Error: maa-process-observation-invalid$/);
});

test('an expired observation budget never proceeds to launch', async (t) => {
  const f = await fixture(t); let launched = false;
  f.control.list = async () => { await new Promise(resolve => setTimeout(resolve, 70)); return []; };
  f.control.launch = async () => { launched = true; };
  const maa = createMaaProcess(f.directory, { processControl: f.control, startTimeoutMs: 30, pollMs: 10 });
  await assert.rejects(maa.start(), /^Error: maa-start-timeout$/);
  assert.equal(launched, false);
});
