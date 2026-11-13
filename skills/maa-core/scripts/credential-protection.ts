import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Windows per-user protection boundary (DPAPI, CurrentUser scope) for saved credentials.
 * Plaintext and ciphertext pass only through the child's standard streams as base64, never through
 * its command line or environment. Errors carry a fixed code, never the data or the shell output.
 */
export type Protector = { protect(plain: Buffer, entropy: string): Promise<Buffer>; unprotect(cipher: Buffer, entropy: string): Promise<Buffer> };

const script = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Security
  $data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  $entropy = [Text.Encoding]::UTF8.GetBytes($env:MAA_SKILLS_PROTECTION_ENTROPY)
  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($env:MAA_SKILLS_PROTECTION_ACTION -eq 'protect') { $result = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope) }
  elseif ($env:MAA_SKILLS_PROTECTION_ACTION -eq 'unprotect') { $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope) }
  else { exit 4 }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch {
  $e = $_.Exception
  while ($e) { if ($e -is [Security.Cryptography.CryptographicException]) { exit 3 }; $e = $e.InnerException }
  exit 4
}`;
const maximumOutput = 1024 * 1024;

function run(action: 'protect' | 'unprotect', input: Buffer, entropy: string): Promise<Buffer> {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return Promise.reject(new Error('windows-required'));
  const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise((resolve, reject) => {
    let settled = false; let output = '';
    const finish = (error: Error | undefined, value?: Buffer) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value!); };
    let child;
    try {
      child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: { ...process.env, MAA_SKILLS_PROTECTION_ACTION: action, MAA_SKILLS_PROTECTION_ENTROPY: entropy }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { finish(new Error('protection-failed')); return; }
    const timer = setTimeout(() => { child.kill(); finish(new Error('protection-failed')); }, 30_000);
    child.on('error', () => finish(new Error('protection-failed')));
    child.stdout.setEncoding('ascii');
    child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > maximumOutput) { child.kill(); finish(new Error('protection-failed')); } });
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => {
      if (code === 3) { finish(new Error('protection-unreadable')); return; }
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) { finish(new Error('protection-failed')); return; }
      finish(undefined, Buffer.from(output, 'base64'));
    });
    child.stdin.end(input.toString('base64'));
  });
}

export const windowsProtector: Protector = {
  protect: (plain, entropy) => run('protect', plain, entropy),
  unprotect: (cipher, entropy) => run('unprotect', cipher, entropy),
};
