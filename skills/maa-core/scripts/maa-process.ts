import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { MaaProcess, MaaState } from './maa-config.ts';

export type ProcessIdentity = {
  pid: number; parentPid: number; name: string; executable: string | null; startedAt: number;
};
/** System boundary for observing and requesting actions from the MAA process. */
export interface ProcessControl {
  list(signal?: AbortSignal): Promise<ProcessIdentity[]>;
  close(process: ProcessIdentity, signal?: AbortSignal): Promise<boolean>;
  launch(executable: string, args: string[], cwd: string, signal?: AbortSignal): Promise<void>;
}
export type ProcessOptions = { processControl?: ProcessControl; closeTimeoutMs?: number; startTimeoutMs?: number; pollMs?: number };
const identityKey = (item: ProcessIdentity) => `${item.pid}:${item.startedAt}`;
const pathKey = (path: string) => resolve(path).replaceAll('\\', '/').toLowerCase();

function windowsProcessControl(): ProcessControl {
  if (process.platform !== 'win32') throw new Error('maa-process-platform-unavailable');
  if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) throw new Error('maa-process-platform-unavailable');
  const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = (body: string, data: unknown, signal?: AbortSignal): Promise<unknown> => new Promise((resolveResult, reject) => {
    const script = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $request = $env:MAA_PROCESS_REQUEST | ConvertFrom-Json; " + body;
    let result: unknown; let failed = false;
    // An aborted helper is killed and reaped before returning; it cannot later issue another action.
    const child = execFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, signal,
      env: { ...process.env, MAA_PROCESS_REQUEST: JSON.stringify(data), PSModuleAnalysisCachePath: join(tmpdir(), `maa-process-${process.pid}.cache`) },
    }, (error, stdout) => {
      failed = Boolean(error);
      if (!failed) { try { result = JSON.parse(stdout); } catch { failed = true; } }
    });
    child.on('error', () => { failed = true; });
    child.on('close', () => failed ? reject(new Error('maa-process-command-failed')) : resolveResult(result));
  });
  return {
    list: async (signal) => {
      const value = await run(`$items = @(Get-CimInstance Win32_Process | ForEach-Object {
        $created = if ($null -eq $_.CreationDate) { -1 } else { ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() };
        @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = [string]$_.Name; executable = $_.ExecutablePath; startedAt = $created }
      }); ConvertTo-Json -InputObject $items -Compress`, {}, signal);
      if (!Array.isArray(value)) throw new Error('maa-process-observation-invalid');
      return value as ProcessIdentity[];
    },
    close: async (identity, signal) => {
      const result = await run(`$p = Get-Process -Id $request.pid -ErrorAction SilentlyContinue;
        if ($null -eq $p) { $true | ConvertTo-Json; exit };
        $started = ([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
        if ($started -ne $request.startedAt -or -not [string]::Equals($p.Path, $request.executable, [StringComparison]::OrdinalIgnoreCase)) { throw 'identity-changed' };
        $p.CloseMainWindow() | ConvertTo-Json`, identity, signal);
      return result === true;
    },
    launch: async (executable, args, cwd, signal) => {
      await run(`$p = Start-Process -FilePath $request.executable -ArgumentList $request.args -WorkingDirectory $request.cwd -WindowStyle Hidden -PassThru;
        @{ launched = $true; pid = $p.Id } | ConvertTo-Json -Compress`, { executable, args, cwd }, signal);
    },
  };
}

async function sessionState(directory: string, root: ProcessIdentity): Promise<{ ready: boolean; idle: boolean }> {
  let text: string;
  try { text = await readFile(join(directory, 'debug', 'gui.log'), 'utf8'); }
  catch { return { ready: false, idle: false }; }
  let session = false; let ready = false; let idle = true; let stopping = false; let interruptDepth = 0; let broken = false;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3})\]\[[A-Z]{3}\]\[(\w+)\]\s+<\d+> (.*)$/.exec(line);
    if (!match) continue;
    const time = new Date(match[1]!.replace(' ', 'T')).getTime();
    if (time < root.startedAt) continue;
    const [name, message] = [match[2], match[3]!];
    if (time > Date.now()) {
      // A current-session transition with an unconfirmed time cannot preserve an older safe state.
      if (session && (name === 'RunningState' || name === 'Bootstrapper' || name === 'AsstProxy')) broken = true;
      continue;
    }
    if (name === 'Bootstrapper' && message === 'MaaAssistantArknights GUI started') { session = true; ready = false; idle = true; stopping = false; interruptDepth = 0; broken = false; }
    if (!session) continue;
    if (name === 'Bootstrapper' && message === 'MaaAssistantArknights GUI exited') { session = false; ready = false; }
    if (name === 'AsstProxy' && /^(Resource loading failed,|Skip core init:|Skip startup auto-run: restart required|Skip startup auto-run due to broken resource)/.test(message)) broken = true;
    if (name === 'RunningState') {
      const state = /^Idle: (True|False) to (True|False) \(called from \w+\)$/.exec(message);
      if (state) { idle = state[2] === 'True'; if (idle) stopping = false; }
      const init = /^Init: (True|False) to (True|False) \(called from \w+\)$/.exec(message);
      if (init) ready = init[2] === 'True';
      const stop = /^Stopping: (True|False) to (True|False) \(called from \w+\)$/.exec(message);
      if (stop) stopping = stop[2] === 'True';
      const interrupt = /^InterruptLock: depth=(\d+) \(called from \w+\)$/.exec(message);
      if (interrupt) interruptDepth = Number(interrupt[1]);
    }
  }
  return { ready: session && ready && !broken, idle: session && ready && !broken && idle && !stopping && interruptDepth === 0 };
}

export function createMaaProcess(maaDirectory: string, options: ProcessOptions = {}): MaaProcess {
  if (!isAbsolute(maaDirectory)) throw new Error('maa-directory-invalid');
  const control = options.processControl ?? windowsProcessControl();
  const target = join(maaDirectory, 'MAA.exe');
  const closeTimeoutMs = options.closeTimeoutMs ?? 30_000;
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 250;
  if (!Number.isInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 30_000
    || !Number.isInteger(startTimeoutMs) || startTimeoutMs < 1 || startTimeoutMs > 60_000
    || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw new Error('maa-process-options-invalid');
  const tracked = new Map<string, ProcessIdentity>();
  const snapshot = async (signal?: AbortSignal) => {
    const canonical = pathKey(await realpath(target));
    const all = await control.list(signal);
    if (all.some(item => !Number.isInteger(item.pid) || item.pid < 0 || !Number.isInteger(item.parentPid) || item.parentPid < 0
      || !Number.isFinite(item.startedAt) || typeof item.name !== 'string' || (item.executable !== null && typeof item.executable !== 'string'))) throw new Error('maa-process-observation-invalid');
    if (all.some(item => item.name.toLowerCase() === 'maa.exe' && !item.executable)) throw new Error('maa-process-path-unavailable');
    const roots: ProcessIdentity[] = [];
    for (const item of all) {
      if (item.name.toLowerCase() !== 'maa.exe') continue;
      let executable: string;
      try { executable = pathKey(await realpath(item.executable!)); }
      catch { throw new Error('maa-process-path-unavailable'); }
      if (executable === canonical) {
        if (item.pid === 0 || item.startedAt <= 0) throw new Error('maa-process-observation-invalid');
        roots.push(item);
      }
    }
    for (const root of roots) tracked.set(identityKey(root), root);
    let added = true;
    while (added) {
      added = false;
      for (const item of all) {
        if (tracked.has(identityKey(item))) continue;
        const currentParent = all.find(p => p.pid === item.parentPid);
        const parents = [...tracked.values()].filter(p => p.pid === item.parentPid && (!currentParent || identityKey(currentParent) === identityKey(p)));
        if (parents.length && item.startedAt <= 0) throw new Error('maa-process-observation-invalid');
        if (parents.some(p => item.startedAt >= p.startedAt)) {
          tracked.set(identityKey(item), item); added = true;
        }
      }
    }
    const live = all.filter(item => tracked.has(identityKey(item)));
    return { roots, live };
  };
  const inspectState = async (signal?: AbortSignal): Promise<MaaState> => {
    const { roots, live } = await snapshot(signal);
    const state = roots.length === 1 ? await sessionState(maaDirectory, roots[0]!) : { ready: false, idle: false };
    return { running: roots.length > 0, treeExited: live.length === 0, ...state };
  };
  return {
    inspect: async () => { try { return await inspectState(); } catch (error) { throw safeError(error); } },
    close: async () => {
      const deadline = Date.now() + closeTimeoutMs;
      const signal = AbortSignal.timeout(closeTimeoutMs);
      try {
        const { roots } = await snapshot(signal);
        if (roots.length > 1 || (roots.length === 1 && !(await sessionState(maaDirectory, roots[0]!)).idle)) throw new Error('maa-not-idle');
        for (const root of roots) {
          signal.throwIfAborted();
          if (!(await control.close(root, signal))) throw new Error('maa-close-refused');
        }
        while (!(await inspectState(signal)).treeExited) {
          if (Date.now() >= deadline) throw new Error('maa-close-timeout');
          await delay(Math.min(pollMs, deadline - Date.now()), undefined, { signal });
        }
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) throw new Error('maa-close-timeout');
        throw safeError(error);
      }
    },
    start: async () => {
      const deadline = Date.now() + startTimeoutMs;
      const signal = AbortSignal.timeout(startTimeoutMs);
      try {
        if (!(await inspectState(signal)).treeExited) throw new Error('maa-already-running');
        signal.throwIfAborted();
        await control.launch(target, ['--skip-startup-auto-run'], maaDirectory, signal);
        while (!(await inspectState(signal)).ready) {
          if (Date.now() >= deadline) throw new Error('maa-start-timeout');
          await delay(Math.min(pollMs, deadline - Date.now()), undefined, { signal });
        }
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) throw new Error('maa-start-timeout');
        throw safeError(error);
      }
    },
  };
}

function safeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : '';
  return new Error(new Set(['maa-process-path-unavailable', 'maa-process-observation-invalid', 'maa-process-command-failed', 'maa-close-refused', 'maa-close-timeout', 'maa-start-timeout', 'maa-already-running', 'maa-not-idle']).has(message)
    ? message : 'maa-process-observation-failed');
}
