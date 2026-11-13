// The layer below the guard goes first, so an attempt the guard lets through is recorded there and fails without
// leaving this machine or starting a program; the guard itself is imported second and wraps it.
import './fixtures/guard-backstop.mjs';
import './fixtures/offline-network.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readBilibiliVideo } from '../skills/maa-core/scripts/bilibili.ts';

type Refusal = { via: string; target: string };
const guard = (globalThis as unknown as { __maaOfflineNetworkGuard: { refused: Refusal[] } }).__maaOfflineNetworkGuard;
const backstop = (globalThis as unknown as { __maaGuardBackstop: string[] }).__maaGuardBackstop;
/** Every ChildProcess this process creates, by any route, including one that bypasses the exported functions. */
const started: unknown[] = [];
channel('child_process').subscribe((message) => started.push(message));
const refused = (error: unknown) => error instanceof Error && error.message === 'offline-test-real-network';

test('the test guard refuses to start PowerShell through every child_process entry point; other programs still reach the layer below', async () => {
  // The research transport's own path on Windows; elsewhere the same file name under a stand-in folder.
  const windowsShell = join(process.env.SystemRoot ?? 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const programFilesShell = join(process.env.ProgramFiles ?? 'Program Files', 'PowerShell', '7', 'pwsh.exe');
  const before = guard.refused.length;
  const attempts: [string, () => unknown][] = [
    ['spawn, Windows PowerShell by full path', () => spawn(windowsShell, ['-NoProfile', '-NonInteractive', '-Command', 'exit'])],
    ['spawn, PowerShell 7 by name', () => spawn('pwsh', ['-Command', 'exit'])],
    ['spawnSync, any letter case', () => spawnSync('PowerShell.EXE', ['-Command', 'exit'])],
    ['execFile', () => execFile('pwsh.exe', ['-Command', 'exit'], () => undefined)],
    ['execFileSync', () => execFileSync(windowsShell, ['-Command', 'exit'])],
    ['exec', () => exec('powershell -NoProfile -Command exit', () => undefined)],
    ['execSync, quoted path with spaces', () => execSync(`"${programFilesShell}" -Command exit`)],
    ['spawn with a shell', () => spawn('echo ok && pwsh -Command exit', { shell: true })],
    ['spawn of cmd running PowerShell', () => spawn('cmd.exe', ['/d', '/s', '/c', 'powershell -Command exit'])],
    ['fork with PowerShell as the runtime', () => fork('probe.mjs', [], { execPath: 'pwsh' })],
    ['the module object', () => childProcess.spawnSync('pwsh', ['-Command', 'exit'])],
  ];
  for (const [name, attempt] of attempts) assert.throws(attempt, refused, name);
  await assert.rejects(async () => promisify(exec)('pwsh -Command exit'), refused, 'promisified exec');
  assert.equal(typeof (exec as unknown as Record<symbol, unknown>)[promisify.custom], 'function', 'promisified exec still resolves to stdout and stderr');
  assert.deepEqual([...new Set(guard.refused.slice(before).map((item) => item.via))].sort(),
    ['child_process.exec', 'child_process.execFile', 'child_process.execFileSync', 'child_process.execSync', 'child_process.fork', 'child_process.spawn', 'child_process.spawnSync']);
  assert.ok(guard.refused.slice(before).every((item) => /^(powershell|pwsh)(\.exe)?$/i.test(item.target)));
  assert.deepEqual([backstop, started], [[], []], 'nothing got past the guard and no process was created');

  // Not over-blocking: a program that is not PowerShell passes the guard and reaches the layer below.
  assert.throws(() => spawnSync(process.execPath, ['-e', '0']), /guard-backstop-reached/);
  assert.equal(backstop.length, 1);
  assert.match(backstop.splice(0)[0]!, /^child_process\.spawnSync node(\.exe)?$/i);
});

test('readBilibiliVideo without a transport fails under the guard and starts nothing: the Windows PowerShell transport, or the socket elsewhere, is refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = guard.refused.length;
  started.length = 0;
  const result = await readBilibiliVideo({ video: 'BV1Sy4y1x7Kt' }, { privateDirectory: join(root, 'private') });
  const windows = process.platform === 'win32';
  // The reader turns any transport error into a transport code, so the guard's own record shows what stopped it.
  assert.deepEqual([result.status, result.pages[0]?.outcome], ['network-failed', 'network-failed']);
  assert.match(result.pages[0]?.reason ?? '', /^transport-(failed|unavailable)$/);
  const refusals = guard.refused.slice(before);
  if (windows) assert.deepEqual(refusals, [{ via: 'child_process.spawn', target: 'powershell.exe' }]);
  else assert.ok(refusals.length > 0 && refusals.every((item) => item.via === 'connect' && item.target === 'api.bilibili.com'), JSON.stringify(refusals));
  assert.deepEqual([backstop, started], [[], []], 'the guard stopped it: nothing reached the layer below and no process was created');
});
