import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import type { CheckStatus } from './checks.ts';

/**
 * The one MAA version seam shared by setup and doctor (ticket 25 extends it):
 * - `readMaaVersion` reads MAA.exe's Windows ProductVersion without launching MAA (07's method, unchanged);
 * - `readVerificationRecord` reads the packaged record of source- and device-verified versions;
 * - `assessMaaVersion` turns both into one check state. An unverified or unknown version only warns.
 * Ticket 25 replaces the packaged record with its generated record and adds the newer-verified-release
 * reminder here, so both callers change together.
 */
export type MaaVersionReader = (maaDirectory: string) => Promise<string | null>;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;

export const readMaaVersion: MaaVersionReader = async directory => {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return null;
  const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const code = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Diagnostics.FileVersionInfo]::GetVersionInfo($env:MAA_SETUP_BINARY).ProductVersion";
  return new Promise(resolveResult => execFile(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { env: { ...process.env, MAA_SETUP_BINARY: join(directory, 'MAA.exe') }, windowsHide: true, timeout: 5000, maxBuffer: 4096 },
    (error, stdout) => { const version = stdout.trim(); resolveResult(!error && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ? version.replace(/^v/, '') : null); }));
};

export type VerificationRecord = { available: boolean; sourceVerified: string[]; deviceVerified: string[] };
export async function readVerificationRecord(file: URL = new URL('../references/verified-versions.json', import.meta.url)): Promise<VerificationRecord> {
  try {
    const record: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('versions-invalid');
    const { schemaVersion, sourceVerified, deviceVerified } = record as Record<string, unknown>;
    if (schemaVersion !== 1 || !Array.isArray(sourceVerified) || !Array.isArray(deviceVerified)
      || [...sourceVerified, ...deviceVerified].some(value => typeof value !== 'string')) throw new Error('versions-invalid');
    return { available: true, sourceVerified: sourceVerified as string[], deviceVerified: deviceVerified as string[] };
  } catch { return { available: false, sourceVerified: [], deviceVerified: [] }; }
}

export type MaaVersionEvidence = { installed: string | null; recordAvailable: boolean; recordEmpty: boolean; sourceVerified: boolean; deviceVerified: boolean };
export type MaaVersionAssessment = { status: CheckStatus; reason: string; evidence: MaaVersionEvidence };

/** Order: unreadable record, empty record, unknown version, partly verified, verified. Only the last is normal. */
export function assessMaaVersion(installed: string | null, record: VerificationRecord): MaaVersionAssessment {
  const version = installed !== null && versionPattern.test(installed) ? installed : null;
  const recordEmpty = record.available && !record.sourceVerified.length && !record.deviceVerified.length;
  const sourceVerified = version !== null && record.sourceVerified.includes(version);
  const deviceVerified = version !== null && record.deviceVerified.includes(version);
  const reason = !record.available ? 'verification-record-unavailable' : recordEmpty ? 'verification-record-empty' : version === null ? 'maa-version-unknown'
    : sourceVerified && deviceVerified ? 'maa-version-verified' : 'maa-version-not-fully-verified';
  return { status: reason === 'maa-version-verified' ? 'normal' : 'warning', reason,
    evidence: { installed: version, recordAvailable: record.available, recordEmpty, sourceVerified, deviceVerified } };
}
