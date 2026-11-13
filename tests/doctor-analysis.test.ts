import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { runAnalysis as analyzeRun } from '../skills/maa-core/scripts/doctor.ts';
import { parseCallbacks, safeToken } from '../skills/maa-core/scripts/maa-log.ts';
import type { MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';
import { versionDoublePreload } from './fixtures/maa-version-guard.ts';

const profile = 'Synthetic private profile';
// A synthetic Windows user directory, assembled so the repository privacy scan does not read it as a real path.
const userDirectory = ['C:', 'Users', 'SyntheticUser'].join('\\');
// Assertions read the JSON shape directly; the result union is checked by the assertions themselves.
const runAnalysis = async (...args: Parameters<typeof analyzeRun>): Promise<any> => analyzeRun(...args);
let clock = 0;
const at = () => `2026-11-13 08:${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock++ % 60).padStart(2, '0')}.000`;
const callback = (message: string, detail: Record<string, unknown> = {}) => `[${at()}][INF][Px4242][Tx17] Assistant::append_callback | ${message} ${JSON.stringify({ uuid: 'synthetic-device-uuid-marker', ...detail })}`;
const noise = (text: string) => `[${at()}][TRC][Px4242][Tx17] ${text}`;
const chain = (name: string, taskid: number, end: 'TaskChainCompleted' | 'TaskChainError' | 'TaskChainStopped', before: string[] = []) =>
  [callback('TaskChainStart', { taskchain: name, taskid }), ...before, callback(end, { taskchain: name, taskid })];

async function fixture(t: { after(fn: () => Promise<unknown>): void }, lines: string[], adbPath = 'adb/synthetic-adb.exe') {
  const root = await mkdtemp(join(tmpdir(), 'maa-doctor-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private');
  await mkdir(join(maaDirectory, 'config'), { recursive: true }); await mkdir(join(maaDirectory, 'debug/interface'), { recursive: true }); await mkdir(privateDirectory);
  await writeFile(join(maaDirectory, 'config/gui.new.json'), JSON.stringify({ Current: profile, Configurations: { [profile]: { TaskQueue: [], Gui: { RuntimeSettings: { ClientType: 'Official' },
    ConnectSettings: { AdbPath: adbPath, Address: '127.0.0.1:16384' } } } } }));
  await mkdir(join(maaDirectory, 'adb')); await writeFile(join(maaDirectory, 'adb/synthetic-adb.exe'), 'synthetic');
  await writeFile(join(maaDirectory, 'MAA.exe'), 'synthetic executable placeholder');
  await writeFile(join(maaDirectory, 'debug/asst.log'), lines.join('\r\n') + '\r\n');
  await updateSettings({ language: 'en', privateDirectory, maaDirectory }, home);
  const maa: MaaProcess = { inspect: async () => ({ running: true, ready: true, treeExited: false, idle: true }),
    close: async () => { throw new Error('unexpected close'); }, start: async () => { throw new Error('unexpected start'); } };
  return { root, home, maaDirectory, privateDirectory, maa, context: { home, maaDirectory, privateDirectory } };
}
const boundaries = { versionReader: async () => '6.21.4', adb: { run: async () => ({ exitCode: 0, stdout: 'List of devices attached\n' }) } };

test('callback lines are parsed structurally; text that merely mentions a callback name is ignored', () => {
  const parsed = parseCallbacks([callback('ConnectionInfo', { what: 'Connected', why: '' }), noise('Assistant::append_callback | not a callback line'),
    noise('error text mentions TaskChainError and 任务出错'), 'garbage', callback('AllTasksCompleted', { taskchain: 'Fight', taskid: 1 })].join('\n'));
  assert.deepEqual(parsed.map(item => [item.message, item.detail?.what ?? null]), [['ConnectionInfo', 'Connected'], ['AllTasksCompleted', null]]);
  assert.match(parsed[0]!.at!, /^2026-11-13 08:[0-9]{2}:[0-9]{2}\.000$/);
});

test('structured callbacks decide the outcome; a zero process exit code and a completion marker never override an error', async (t) => {
  const cases: [string, string[], string][] = [
    ['completion after a chain error', [...chain('Fight', 1, 'TaskChainError'), ...chain('Infrast', 2, 'TaskChainCompleted'), callback('AllTasksCompleted', { taskchain: 'Infrast', taskid: 2 })], 'failed'],
    ['no terminal callback', [callback('ConnectionInfo', { what: 'Connected' }), callback('TaskChainStart', { taskchain: 'Fight', taskid: 1 })], 'unknown'],
    ['completed', [...chain('Fight', 1, 'TaskChainCompleted'), callback('AllTasksCompleted', { taskchain: 'Fight', taskid: 1 })], 'completed'],
    ['stopped', [...chain('Fight', 1, 'TaskChainStopped')], 'stopped'],
    ['keyword noise only', [...chain('Fight', 1, 'TaskChainCompleted', [noise('TaskChainError SubTaskError 任务出错')]), callback('AllTasksCompleted', { taskchain: 'Fight', taskid: 1 })], 'completed'],
    ['no callbacks', [noise('started')], 'unknown'],
  ];
  for (const [name, lines, outcome] of cases) await t.test(name, async (t) => {
    const f = await fixture(t, lines);
    const result = await runAnalysis(f.context, { processExitCode: 0 }, f.maa, boundaries);
    assert.equal(result.outcome, outcome);
    assert.equal(result.processExit, 'not-evidence');
    if (outcome === 'unknown') { assert.equal(result.replay, 'forbidden'); assert.deepEqual(result.nextSteps, ['verify-current-state']); }
    if (outcome === 'stopped') { assert.equal(result.replay, 'ask-user'); assert.deepEqual(result.nextSteps, ['verify-current-state']); }
    if (outcome === 'completed' || outcome === 'stopped') assert.equal(result.referral.state, 'not-applicable');
  });
});

test('evidence tokens keep MAA task names but drop identifier-like, address-like and path-like values', () => {
  assert.equal(safeToken('ReturnToTerminalAndCheckProductionAgain', /^[A-Za-z][A-Za-z0-9@_.-]{0,79}$/), 'ReturnToTerminalAndCheckProductionAgain');
  assert.equal(safeToken('Sarkaz@Roguelike@StageCombatDps2', /^[A-Za-z][A-Za-z0-9@_.-]{0,79}$/), 'Sarkaz@Roguelike@StageCombatDps2');
  for (const value of ['ABCDEF0123456789ABCDEF0123', 'abc123def456ghi789jkl012mno', 'emulator-5554', userDirectory, '127.0.0.1:16384', 'synthetic@example.invalid'])
    assert.equal(safeToken(value, /^.{1,80}$/), null, value);
});

test('only the latest run is analysed unless an earlier run is named', async (t) => {
  const f = await fixture(t, [...chain('Fight', 1, 'TaskChainCompleted'), callback('AllTasksCompleted', { taskchain: 'Fight', taskid: 1 }),
    callback('ConnectionInfo', { what: 'ConnectFailed', why: 'synthetic' })]);
  const latest = await runAnalysis(f.context, {}, f.maa, boundaries);
  assert.deepEqual([latest.outcome, latest.classification?.category, latest.taskchains], ['failed', 'connection', []]);
  const earlier = await runAnalysis(f.context, { run: 2 }, f.maa, boundaries);
  assert.deepEqual([earlier.outcome, earlier.classification, earlier.taskchains], ['completed', null, ['Fight']]);
  const beyond = await runAnalysis(f.context, { run: 3 }, f.maa, boundaries);
  assert.deepEqual([beyond.outcome, beyond.missingEvidence.includes('earlier-run-not-in-log')], ['unknown', true]);
  const transient = await fixture(t, [callback('ConnectionInfo', { what: 'ConnectFailed', why: 'synthetic' }), callback('ConnectionInfo', { what: 'Connected' }),
    ...chain('Fight', 1, 'TaskChainCompleted'), callback('AllTasksCompleted', { taskchain: 'Fight', taskid: 1 })]);
  assert.equal((await runAnalysis(transient.context, {}, transient.maa, boundaries)).outcome, 'completed', 'a connection failure followed by a connection is not the run result');
});

test('environment failures report cause, evidence and current state; the model chooses the next step and nothing hands off by count', async (t) => {
  const cases: [string, string[], string, string][] = [
    ['disconnect', [callback('TaskChainStart', { taskchain: 'Fight', taskid: 1 }), callback('ConnectionInfo', { what: 'Disconnect', why: 'synthetic' }), callback('TaskChainError', { taskchain: 'Fight', taskid: 1 }), callback('AllTasksCompleted', { taskchain: 'Fight', taskid: 1 })], 'connection', 'ConnectionInfo.Disconnect'],
    ['resolution', [callback('ConnectionInfo', { what: 'UnsupportedResolution', why: 'synthetic' })], 'recognition-environment', 'ConnectionInfo.UnsupportedResolution'],
    ['out of memory', [callback('TaskChainStart', { taskchain: 'Fight', taskid: 1 }), callback('TaskChainError', { taskchain: 'Fight', taskid: 1, details: { error: 'OutOfMemory' } }), callback('TaskChainStopped', { taskchain: 'Fight', taskid: 1 })], 'maa-process', 'TaskChainError.OutOfMemory'],
  ];
  for (const [name, lines, category, cause] of cases) await t.test(name, async (t) => {
    const repeated = [...lines, ...lines, ...lines];
    const f = await fixture(t, repeated);
    const result = await runAnalysis(f.context, {}, f.maa, boundaries);
    assert.equal(result.outcome, 'failed');
    assert.deepEqual([result.classification.category, result.classification.environment, result.classification.cause], [category, true, cause]);
    assert.deepEqual(result.nextSteps, ['verify-current-state', 'retry-within-approval', 'next-approved-alternative', 'stop-and-tell-user']);
    assert.equal(result.decidedBy, 'model');
    assert.equal(result.referral.state, 'not-applicable');
    // adb does not list a network address nobody has connected to; that is reported as such, never as "emulator off".
    assert.deepEqual(result.currentState, { connection: 'device-not-connected', maa: 'running' });
    assert.ok(result.evidence.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /handoff|attempt|count|emulator-off|not-running-emulator/i);
  });
});

test('the current-state connection check never runs a configured program that is not adb', async (t) => {
  const f = await fixture(t, [callback('ConnectionInfo', { what: 'Disconnect', why: 'synthetic' })], 'MAA.exe');
  const calls: string[] = [];
  const result = await runAnalysis(f.context, {}, f.maa, { ...boundaries, adb: { run: async (executable: string) => { calls.push(executable); return { exitCode: 0, stdout: '' }; } } });
  assert.deepEqual(calls, []);
  assert.equal(result.currentState.connection, 'adb-path-unrecognized');
});

test('recognition failures are referred only after resolution, connection and an obscured screen are ruled out', async (t) => {
  const failing = [callback('ConnectionInfo', { what: 'Connected' }), callback('TaskChainStart', { taskchain: 'Fight', taskid: 3 }),
    noise(`Save image "${userDirectory}\\MAA\\debug\\interface\\2026.11.13-08.00.05_StartButton2.png"`),
    callback('SubTaskError', { subtask: 'ProcessTask', class: 'asst::ProcessTask', taskchain: 'Fight', taskid: 3, details: { task: 'StartButton2' } }),
    callback('TaskChainError', { taskchain: 'Fight', taskid: 3 }), callback('AllTasksCompleted', { taskchain: 'Fight', taskid: 3 })];
  const f = await fixture(t, failing);
  await writeFile(join(f.maaDirectory, 'debug/interface/2026.11.13-08.00.05_StartButton2.png'), 'synthetic image');
  const pending = await runAnalysis(f.context, {}, f.maa, boundaries);
  assert.deepEqual([pending.classification.category, pending.classification.environment], ['recognition', false]);
  assert.deepEqual(pending.localChecks, [{ id: 'resolution', state: 'ruled-out' }, { id: 'connection', state: 'ruled-out' }, { id: 'interface-obscured', state: 'needs-user-confirmation' }]);
  assert.deepEqual(pending.referral, { state: 'pending', remaining: ['interface-obscured'] });
  assert.deepEqual(pending.screenshots, ['debug/interface/2026.11.13-08.00.05_StartButton2.png']);
  const concluded = await runAnalysis(f.context, { conclusion: 'game-update-not-adapted' }, f.maa, boundaries);
  assert.equal(concluded.referral.state, 'pending', 'a model conclusion cannot skip the local recognition checks');
  const ready = await runAnalysis(f.context, { interfaceUnobscured: true }, f.maa, boundaries);
  assert.equal(ready.referral.state, 'ready');
  const summary = ready.referral.summary;
  assert.deepEqual(Object.keys(summary), ['overview', 'keyEvidence', 'rootCause', 'confidence', 'missingEvidence']);
  assert.deepEqual(summary.overview, { outcome: 'failed', category: 'recognition', taskchains: ['Fight'], maaVersion: '6.21.4' });
  assert.equal(summary.keyEvidence.log, 'debug/asst.log');
  assert.ok(summary.keyEvidence.from <= summary.keyEvidence.to);
  assert.deepEqual(summary.keyEvidence.callbacks.map((item: { message: string }) => item.message), ['SubTaskError', 'TaskChainError']);
  assert.deepEqual(summary.keyEvidence.callbacks[0], { at: summary.keyEvidence.callbacks[0].at, message: 'SubTaskError', subtask: 'ProcessTask', taskchain: 'Fight', task: 'StartButton2' });
  assert.deepEqual(summary.keyEvidence.screenshots, ['debug/interface/2026.11.13-08.00.05_StartButton2.png']);
  assert.equal(summary.rootCause.judgement, 'maa-recognition-failure');
  assert.ok(summary.rootCause.chain.length >= 3);
  assert.equal(summary.confidence, 'medium');
  assert.ok(summary.missingEvidence.includes('maa-issue-report-package'));
  assert.deepEqual(ready.referral.entries.map((item: { id: string }) => item.id), ['maa-faq', 'maa-issues', 'maa-issue-report-package']);
  const resolution = await fixture(t, [callback('ConnectionInfo', { what: 'ResolutionChanged', why: 'synthetic' }), ...failing.slice(1)]);
  const environment = await runAnalysis(resolution.context, { interfaceUnobscured: true }, resolution.maa, boundaries);
  assert.deepEqual([environment.classification.category, environment.referral.state], ['recognition-environment', 'not-applicable']);
});

test('an exception inside MAA is referred with high confidence; a model conclusion refers an investigated environment failure with low confidence', async (t) => {
  const f = await fixture(t, [callback('TaskChainStart', { taskchain: 'Infrast', taskid: 4 }), callback('TaskChainError', { taskchain: 'Infrast', taskid: 4, details: { error: 'UnhandledException' } }),
    callback('AllTasksCompleted', { taskchain: 'Infrast', taskid: 4 })]);
  const defect = await runAnalysis(f.context, {}, f.maa, boundaries);
  assert.deepEqual([defect.classification.category, defect.referral.state, defect.referral.summary.confidence, defect.referral.summary.rootCause.judgement], ['maa-defect', 'ready', 'high', 'maa-defect']);
  const g = await fixture(t, [callback('ConnectionInfo', { what: 'ScreencapFailed', why: 'synthetic' })]);
  const compatibility = await runAnalysis(g.context, { conclusion: 'emulator-compatibility' }, g.maa, boundaries);
  assert.deepEqual([compatibility.referral.state, compatibility.referral.summary.rootCause.judgement, compatibility.referral.summary.confidence], ['ready', 'emulator-compatibility', 'low']);
  assert.ok(compatibility.referral.entries.some((item: { id: string }) => item.id === 'maa-connection-guide'));
});

test('the referral summary and latest analysis record never carry credentials, account or device identifiers, addresses, private paths or configuration', async (t) => {
  const markers = ['synthetic-device-uuid-marker', 'SyntheticUser', '16384', '127.0.0.1', 'synthetic-account-marker', 'synthetic-token-marker',
    'ABCDEF0123456789ABCDEF0123', 'synthetic-why-marker', 'Synthetic private profile', 'synthetic-profile-config-marker', 'emulator-5554', 'synthetic@example.invalid'];
  const lines = [
    callback('ConnectionInfo', { what: 'Connected', why: 'synthetic-why-marker', details: { adb: `${userDirectory}\\adb.exe`, address: '127.0.0.1:16384', config: 'synthetic-profile-config-marker' } }),
    callback('ConnectionInfo', { what: 'emulator-5554', why: 'synthetic-token-marker' }),
    callback('TaskChainStart', { taskchain: 'Fight', taskid: 9 }),
    noise(`Save image "${userDirectory}\\MAA\\debug\\interface\\synthetic-account-marker 01.png"`),
    noise(`Save image "${userDirectory}\\MAA\\debug\\drops\\2026.11.13-08.00.09_drops.png"`),
    callback('SubTaskError', { subtask: 'ProcessTask', taskchain: 'Fight', taskid: 9, details: { task: 'ABCDEF0123456789ABCDEF0123', user: 'synthetic-account-marker', mail: 'synthetic@example.invalid' } }),
    callback('SubTaskError', { subtask: 'synthetic-token-marker', taskchain: userDirectory, taskid: 9, details: { task: '127.0.0.1:16384' } }),
    callback('TaskChainError', { taskchain: 'Fight', taskid: 9, details: { error: 'UnhandledException', what: 'synthetic-token-marker' } }),
    callback('AllTasksCompleted', { taskchain: 'Fight', taskid: 9 }),
  ];
  const f = await fixture(t, lines);
  await writeFile(join(f.maaDirectory, 'debug/interface/synthetic-account-marker 01.png'), 'synthetic image');
  await mkdir(join(f.maaDirectory, 'debug/drops')); await writeFile(join(f.maaDirectory, 'debug/drops/2026.11.13-08.00.09_drops.png'), 'synthetic image');
  const result = await runAnalysis(f.context, { interfaceUnobscured: true }, f.maa, boundaries);
  assert.equal(result.referral.state, 'ready');
  assert.deepEqual(result.referral.summary.keyEvidence.screenshots, ['debug/drops/2026.11.13-08.00.09_drops.png']);
  const env = { ...process.env, MAA_SKILLS_HOME: f.home, USERPROFILE: f.root, HOME: f.root };
  const cli = fileURLToPath(new URL('../skills/maa-core/scripts/doctor.ts', import.meta.url));
  const json = spawnSync(process.execPath, ['--import', versionDoublePreload, cli, 'analyze', '--json'], { env, input: JSON.stringify({ interfaceUnobscured: true }), encoding: 'utf8', windowsHide: true });
  const human = spawnSync(process.execPath, ['--import', versionDoublePreload, cli, 'analyze'], { env, input: JSON.stringify({ interfaceUnobscured: true }), encoding: 'utf8', windowsHide: true });
  assert.equal(json.status, 1, json.stdout + json.stderr); assert.equal(human.status, 1); assert.equal(JSON.parse(json.stdout).outcome, 'failed');
  const record = await readFile(join(f.privateDirectory, 'doctor-analysis-latest.json'), 'utf8');
  for (const output of [JSON.stringify(result), json.stdout, human.stdout, record]) for (const marker of markers) assert.ok(!output.includes(marker), `${marker} leaked`);
  assert.doesNotMatch(json.stdout + record, /[A-Za-z]:\\\\|maa-doctor-analysis-/);
});

test('doctor analyze CLI validates its input, keeps 0/1/2 exit codes and records the latest redacted analysis', async (t) => {
  const f = await fixture(t, [...chain('Fight', 1, 'TaskChainCompleted'), callback('AllTasksCompleted', { taskchain: 'Fight', taskid: 1 })]);
  const env = { ...process.env, MAA_SKILLS_HOME: f.home, USERPROFILE: f.root, HOME: f.root };
  const cli = fileURLToPath(new URL('../skills/maa-core/scripts/doctor.ts', import.meta.url));
  const invoke = (input: string) => spawnSync(process.execPath, ['--import', versionDoublePreload, cli, 'analyze', '--json'], { env, input, encoding: 'utf8', windowsHide: true });
  const ok = invoke('{}'); assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(f.privateDirectory, 'doctor-analysis-latest.json'), 'utf8')), JSON.parse(ok.stdout));
  for (const input of ['{"run":0}', '{"run":21}', '{"conclusion":"anything"}', '{"interfaceUnobscured":"yes"}', '{"unknown":true}', '[]', '{']) {
    const rejected = invoke(input); assert.equal(rejected.status, 1, input); assert.equal(JSON.parse(rejected.stdout).status, 'rejected');
  }
  await rm(join(f.maaDirectory, 'debug/asst.log'));
  const missingRun = invoke('{}'); assert.equal(missingRun.status, 1);
  const missing = JSON.parse(missingRun.stdout);
  assert.deepEqual([missing.outcome, missing.missingEvidence.includes('debug/asst.log')], ['unknown', true]);
  await rm(f.privateDirectory, { recursive: true }); await writeFile(f.privateDirectory, 'synthetic blocked directory');
  const failed = invoke('{}'); assert.equal(failed.status, 2); assert.equal(JSON.parse(failed.stdout).status, 'unexpected-failure');
});
