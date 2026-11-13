import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import type { CheckStatus } from './checks.ts';

/**
 * The one MAA version seam shared by setup, doctor and every plan or pending record maa-core writes:
 * - `readMaaVersion` reads MAA.exe's Windows ProductVersion without launching MAA (07's method, unchanged);
 * - `readVerificationRecord` reads the packaged record generated from the dependency registry
 *   (docs/maa-dependencies.json) by scripts/maa-version-check.ts; the record carries its own version;
 * - `assessMaaVersion` turns both into one check state. An unverified or unknown version only warns, and a
 *   newer source-verified stable release is a reminder the user acts on in MAA; nothing here upgrades MAA;
 * - `readVersionStamp` / `compareVersionStamp` record both versions in a plan and report, never refuse, a difference.
 */
export type MaaVersionReader = (maaDirectory: string) => Promise<string | null>;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
const semver = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const stablePattern = /^\d+\.\d+\.\d+$/;

export const readMaaVersion: MaaVersionReader = async directory => {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return null;
  const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const code = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Diagnostics.FileVersionInfo]::GetVersionInfo($env:MAA_SETUP_BINARY).ProductVersion";
  return new Promise(resolveResult => execFile(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { env: { ...process.env, MAA_SETUP_BINARY: join(directory, 'MAA.exe') }, windowsHide: true, timeout: 5000, maxBuffer: 4096 },
    (error, stdout) => { const version = stdout.trim(); resolveResult(!error && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ? version.replace(/^v/, '') : null); }));
};

/** SemVer 2.0 precedence (a beta sorts before its release); build metadata is ignored. Negative, zero or positive. */
export function compareMaaVersions(left: string, right: string): number {
  const a = semver.exec(left), b = semver.exec(right);
  if (!a || !b) throw new Error('version-invalid');
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return difference;
  }
  if (!a[4] !== !b[4]) return a[4] ? -1 : 1;
  const ap = a[4]?.split('.') ?? [], bp = b[4]?.split('.') ?? [];
  for (let index = 0; index < Math.max(ap.length, bp.length); index++) {
    const x = ap[index], y = bp[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const verificationRecordFile = new URL('../references/verified-versions.json', import.meta.url);
/** `recordVersion` is the record's own version, raised by the generator whenever either list changes. */
export type VerificationRecord = { available: boolean; recordVersion: number | null; sourceVerified: string[]; deviceVerified: string[] };
const unavailable = (): VerificationRecord => ({ available: false, recordVersion: null, sourceVerified: [], deviceVerified: [] });

/** Only stable versions can be listed: a beta never enters either list (spec 「MAA 版本跟踪」). */
export async function readVerificationRecord(file: URL | string = verificationRecordFile): Promise<VerificationRecord> {
  try {
    const record: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('versions-invalid');
    const value = record as Record<string, unknown>;
    const { schemaVersion, recordVersion, sourceVerified, deviceVerified } = value;
    if (Object.keys(value).some(key => !['schemaVersion', 'recordVersion', 'sourceVerified', 'deviceVerified'].includes(key))
      || schemaVersion !== 2 || !Number.isSafeInteger(recordVersion) || Number(recordVersion) < 1 || !Array.isArray(sourceVerified) || !Array.isArray(deviceVerified)
      || [...sourceVerified, ...deviceVerified].some(version => typeof version !== 'string' || !stablePattern.test(version))) throw new Error('versions-invalid');
    return { available: true, recordVersion: recordVersion as number, sourceVerified: sourceVerified as string[], deviceVerified: deviceVerified as string[] };
  } catch { return unavailable(); }
}

export type MaaVersionEvidence = { installed: string | null; recordAvailable: boolean; recordEmpty: boolean; recordVersion: number | null;
  sourceVerified: boolean; deviceVerified: boolean; newerSourceVerified: string | null; newerDeviceVerified: boolean };
export type MaaVersionAssessment = { status: CheckStatus; reason: string; evidence: MaaVersionEvidence };

/**
 * Order: unreadable record, empty record, unknown version, newer source-verified stable release available,
 * partly verified, verified. Only the last is normal; every other state is a warning and nothing is refused.
 */
export function assessMaaVersion(installed: string | null, record: VerificationRecord): MaaVersionAssessment {
  const version = installed !== null && versionPattern.test(installed) && semver.test(installed) ? installed : null;
  const recordEmpty = record.available && !record.sourceVerified.length && !record.deviceVerified.length;
  const sourceVerified = version !== null && record.sourceVerified.includes(version);
  const deviceVerified = version !== null && record.deviceVerified.includes(version);
  const newer = version === null ? [] : record.sourceVerified.filter(item => compareMaaVersions(item, version) > 0).sort(compareMaaVersions);
  const newerSourceVerified = newer.at(-1) ?? null;
  const reason = !record.available ? 'verification-record-unavailable' : recordEmpty ? 'verification-record-empty' : version === null ? 'maa-version-unknown'
    : newerSourceVerified !== null ? 'maa-upgrade-available' : sourceVerified && deviceVerified ? 'maa-version-verified' : 'maa-version-not-fully-verified';
  return { status: reason === 'maa-version-verified' ? 'normal' : 'warning', reason,
    evidence: { installed: version, recordAvailable: record.available, recordEmpty, recordVersion: record.recordVersion, sourceVerified, deviceVerified,
      newerSourceVerified, newerDeviceVerified: newerSourceVerified !== null && record.deviceVerified.includes(newerSourceVerified) } };
}

/** The repair named for a version state: only the upgrade reminder points at an action, and the user performs it in MAA. */
export function versionRepair(reason: string): string { return reason === 'maa-upgrade-available' ? 'upgrade-maa-yourself' : 'read-version-verification'; }

/** Written into plans and pending records when they are generated. */
export type MaaVersionStamp = { maaVersion: string | null; recordVersion: number | null };
async function isFile(path: string) { try { return (await stat(path)).isFile(); } catch { return false; } }

/** Reads MAA.exe only when it exists; an unreadable version or record is recorded as null, never guessed. */
export async function readVersionStamp(maaDirectory: string | null | undefined, reader: MaaVersionReader | undefined = readMaaVersion,
  recordFile: URL | string = verificationRecordFile): Promise<MaaVersionStamp> {
  let maaVersion: string | null = null;
  if (maaDirectory && reader && await isFile(join(maaDirectory, 'MAA.exe'))) {
    try { const value = await reader(maaDirectory); maaVersion = typeof value === 'string' && versionPattern.test(value) ? value : null; } catch { /* Unknown version. */ }
  }
  return { maaVersion, recordVersion: (await readVerificationRecord(recordFile)).recordVersion };
}

export function isVersionStamp(value: unknown): value is MaaVersionStamp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stamp = value as Record<string, unknown>;
  return Object.keys(stamp).length === 2 && (stamp.maaVersion === null || typeof stamp.maaVersion === 'string' && versionPattern.test(stamp.maaVersion))
    && (stamp.recordVersion === null || Number.isSafeInteger(stamp.recordVersion) && Number(stamp.recordVersion) >= 1);
}

/** `changed` when either value differs; `unknown` when a side is unreadable; `unrecorded` for a plan written before stamps existed. */
export type VersionDrift = { state: 'same' | 'changed' | 'unknown' | 'unrecorded'; recorded: MaaVersionStamp | null; current: MaaVersionStamp; changed: ('maaVersion' | 'recordVersion')[] };
export function compareVersionStamp(recorded: unknown, current: MaaVersionStamp): VersionDrift {
  if (!isVersionStamp(recorded)) return { state: 'unrecorded', recorded: null, current, changed: [] };
  const fields = ['maaVersion', 'recordVersion'] as const;
  const changed = fields.filter(field => recorded[field] !== null && current[field] !== null && recorded[field] !== current[field]);
  const unknown = fields.some(field => recorded[field] === null || current[field] === null);
  return { state: changed.length ? 'changed' : unknown ? 'unknown' : 'same', recorded, current, changed: [...changed] };
}
