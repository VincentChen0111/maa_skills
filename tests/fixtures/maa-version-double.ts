import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { execFile as ExecFile } from 'node:child_process';

/**
 * Test-only double for the MAA.exe metadata boundary (ticket 25). `readMaaVersion` (maa-version.ts) starts PowerShell
 * with the MAA.exe to read in `MAA_SETUP_BINARY`; that exact call is answered here without starting anything, with the
 * empty output the real reader gets from the synthetic placeholder MAA.exe the tests write, so the version reads as
 * unknown just as before. Every other `execFile` call goes to the real implementation.
 * Preload it into a CLI child with `--import`; in-process, maa-version-guard.ts records each read through it.
 */
const childProcess = createRequire(import.meta.url)('node:child_process') as { execFile: typeof ExecFile };
const real = childProcess.execFile as unknown as (...values: unknown[]) => unknown;
const listeners: ((binary: string) => void)[] = [];
export function onVersionRead(listener: (binary: string) => void) { listeners.push(listener); }

function versionReadOf(file: unknown, options: unknown): string | undefined {
  if (typeof file !== 'string' || !/powershell\.exe$/i.test(file) || !options || typeof options !== 'object') return undefined;
  const binary = (options as { env?: Record<string, unknown> }).env?.MAA_SETUP_BINARY;
  return typeof binary === 'string' ? binary : undefined;
}
childProcess.execFile = function execFile(this: unknown, ...values: unknown[]) {
  const binary = versionReadOf(values[0], values[2]), callback = values[3];
  if (binary === undefined || typeof callback !== 'function') return real.apply(this, values);
  for (const listener of listeners) listener(binary);
  queueMicrotask(() => callback(null, '', ''));
  return undefined;
} as unknown as typeof ExecFile;
syncBuiltinESMExports();
