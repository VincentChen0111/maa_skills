import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { libraryCheck, type CheckResult, type LibraryCheck } from './checks.ts';
import type { RecoveryInspection } from './maa-config.ts';
import { compareMaaVersions } from './maa-version.ts';

/**
 * Read-only doctor checks that have no other owner: MAA remote control, the private records, and the
 * skill installation (version and directory links). None of them writes, decrypts or prints a value.
 * The configuration and write-lock rows are the one producer doctor and the setup recheck share.
 */

/**
 * The `configuration` and `write-lock` rows from one `inspectConfigRecovery` result (owned by the configuration writer).
 * `configuration` is the writers' own read (`inspectConfiguration`), stricter than the installation group's `maa` row.
 * `write-lock`: no lock is normal, a live holder a warning, a stale or unknown lock an error (the next write is refused until
 * it is reconciled), with the reconcile or restore repair only when the evidence proves it.
 */
export function configurationCheck(recovery: Pick<RecoveryInspection, 'configuration'>): CheckResult {
  return recovery.configuration === 'valid'
    ? { id: 'configuration', status: 'normal', reason: 'Configuration is readable.', repair: { id: 'inspect-configuration', executor: 'user', description: 'Inspect the configuration in MAA if the symptom persists.' } }
    : { id: 'configuration', status: 'error', reason: 'Configuration cannot be parsed.', repair: { id: 'manual-configuration', executor: 'user', description: 'Inspect the configuration and retained backups manually.' } };
}
export function writeLockCheck(recovery: Pick<RecoveryInspection, 'lock' | 'canReconcile' | 'canRestore'>): CheckResult {
  const lock = recovery.lock;
  return { id: 'write-lock', status: lock === 'none' ? 'normal' : lock === 'active' ? 'warning' : 'error',
    reason: lock === 'none' ? 'No write lock is present.' : lock === 'active' ? 'The lock holder is still alive.' : 'The previous write result requires reconciliation.',
    repair: { id: recovery.canReconcile ? 'reconcile-lock' : recovery.canRestore ? 'restore-config' : 'manual-lock',
      executor: recovery.canReconcile || recovery.canRestore ? 'skill' : 'user',
      description: recovery.canReconcile ? 'Approve reconciliation of this evidence and release the retained lock.' : recovery.canRestore ? 'Approve restoring only the recorded changed fields through the configuration writer.' : 'Preserve the evidence; wait for the writer or inspect MAA manually.',
      ...(recovery.canReconcile || recovery.canRestore ? { channel: 'doctor.ts repair' } : {}) } };
}

/**
 * Fixed MAA v6.21.4 (docs/doctor-sources.md): each configuration's `Gui.RemoteControl` holds
 * `RemoteControlGetTaskEndpointUri`; MAA stores a non-empty value encrypted and polls only when the
 * decrypted value is a non-blank http(s) address. A stored non-blank value is therefore reported as
 * configured without decrypting it; an empty or missing one as not configured.
 */
export function remoteControlCheck(config: unknown): LibraryCheck {
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('configuration-invalid');
    const profiles = (config as Record<string, unknown>).Configurations;
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) throw new Error('configuration-invalid');
    const configured = Object.values(profiles).some(profile => {
      const gui = profile && typeof profile === 'object' ? (profile as Record<string, unknown>).Gui : undefined;
      const remote = gui && typeof gui === 'object' ? (gui as Record<string, unknown>).RemoteControl : undefined;
      const endpoint = remote && typeof remote === 'object' ? (remote as Record<string, unknown>).RemoteControlGetTaskEndpointUri : undefined;
      return endpoint !== undefined && endpoint !== null && (typeof endpoint !== 'string' || endpoint.trim() !== '');
    });
    return configured ? libraryCheck('remote-control', 'warning', 'remote-control-configured', 'review-remote-control-in-maa')
      : libraryCheck('remote-control', 'normal', 'remote-control-unconfigured', 'no-remote-control-action');
  } catch { return libraryCheck('remote-control', 'warning', 'remote-control-unknown', 'inspect-maa-configuration'); }
}

/** The records this project keeps at the top of the private directory; other owners check their own subdirectories. */
const privateRecords = ['account-snapshot.json', 'daily-pending.jsonl', 'daily-runs.jsonl', 'doctor-analysis-latest.json', 'doctor-latest.json', 'preferences.jsonl', 'setup-environment.json'];
const maximumRecordBytes = 64 * 1024 * 1024;
export async function privateFilesCheck(privateDirectory: string | null): Promise<LibraryCheck> {
  let names: string[];
  try { if (privateDirectory === null) throw new Error('unknown'); names = await readdir(privateDirectory); }
  catch { return libraryCheck('private-files', 'warning', 'private-files-unverified', 'prepare-private-directory'); }
  const damaged: string[] = [];
  for (const name of privateRecords.filter(item => names.includes(item))) {
    try {
      const file = join(privateDirectory, name);
      if ((await stat(file)).size > maximumRecordBytes) { damaged.push(`${name}:too-large`); continue; }
      const text = (await readFile(file, 'utf8')).replace(/^﻿/, '');
      if (name.endsWith('.jsonl')) { for (const line of text.split(/\r?\n/)) if (line.trim()) JSON.parse(line); }
      else JSON.parse(text);
    } catch { damaged.push(name); }
  }
  const temporary = names.filter(name => name.endsWith('.tmp')).length;
  const details = [...damaged, ...(temporary ? [`temporary-files:${temporary}`] : [])];
  if (damaged.length) return libraryCheck('private-files', 'error', 'private-files-damaged', 'inspect-private-files', details);
  if (temporary) return libraryCheck('private-files', 'warning', 'private-files-temporary', 'inspect-private-files', details);
  return libraryCheck('private-files', 'normal', 'private-files-readable', 'no-private-file-action');
}

export type ReleaseResult = { state: 'found'; version: string } | { state: 'none' } | { state: 'failed' };
export type ReleaseLookup = () => Promise<ReleaseResult>;
export const latestReleaseUrl = 'https://api.github.com/repos/VincentChen0111/maa_skills/releases/latest';
const semver = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Read-only network lookup of the latest published (non-draft, non-prerelease) release tag; any failure is unknown. */
export function githubReleaseLookup(fetcher: typeof fetch = fetch): ReleaseLookup {
  return async () => {
    try {
      const response = await fetcher(latestReleaseUrl, { redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'maa-skills-doctor' } });
      if (response.status === 404) { await response.body?.cancel().catch(() => {}); return { state: 'none' }; }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return { state: 'failed' }; }
      const text = await response.text();
      if (Buffer.byteLength(text) > 1024 * 1024) return { state: 'failed' };
      const tag = (JSON.parse(text) as Record<string, unknown>)?.tag_name;
      return typeof tag === 'string' && semver.test(tag) ? { state: 'found', version: tag.replace(/^v/, '') } : { state: 'failed' };
    } catch { return { state: 'failed' }; }
  };
}

/** SemVer 2.0 precedence, one implementation shared with the MAA version seam. */
export const compareVersions = compareMaaVersions;

const packageSkills = ['maa-account', 'maa-core', 'maa-daily', 'maa-doctor', 'maa-help', 'maa-setup'];
export type SkillLink = { name: string; kind: 'directory' | 'link' | 'other'; state: 'ok' | 'broken' | 'no-skill-file' };
export type SkillEvidence = { version: { installed: string | null; latest: string | null; lookup: 'not-requested' | ReleaseResult['state'] }; links: SkillLink[] };

/** `skillsRoot` is the directory holding maa-core as the host invoked it (not resolved through links). */
export async function skillInstallationChecks(skillsRoot: string, releases?: ReleaseLookup): Promise<{ checks: LibraryCheck[]; skills: SkillEvidence }> {
  let installed: string | null = null;
  try {
    const value = (JSON.parse(await readFile(join(skillsRoot, 'maa-core', 'package.json'), 'utf8')) as Record<string, unknown>)?.version;
    if (typeof value === 'string' && semver.test(value)) installed = value;
  } catch { /* An unreadable version stays unknown. */ }
  const release: ReleaseResult | null = releases ? await releases() : null;
  const version: SkillEvidence['version'] = { installed, latest: release?.state === 'found' ? release.version : null, lookup: release ? release.state : 'not-requested' };
  let versionCheck: LibraryCheck;
  if (installed === null) versionCheck = libraryCheck('skill-version', 'warning', 'skill-version-unknown', 'update-skill-through-host');
  else if (!release) versionCheck = libraryCheck('skill-version', 'normal', 'skill-update-not-checked', 'check-skill-update');
  else if (release.state === 'failed') versionCheck = libraryCheck('skill-version', 'warning', 'skill-update-unknown', 'check-skill-update');
  else if (release.state === 'none') versionCheck = libraryCheck('skill-version', 'normal', 'skill-release-none', 'no-update-needed');
  else versionCheck = compareVersions(release.version, installed) > 0 ? libraryCheck('skill-version', 'warning', 'skill-update-available', 'update-skill-through-host')
    : libraryCheck('skill-version', 'normal', 'skill-up-to-date', 'no-update-needed');

  const links: SkillLink[] = [];
  let entries: string[] | null = null;
  try { entries = await readdir(skillsRoot); } catch { /* The root itself is unknown. */ }
  for (const name of packageSkills.filter(item => entries?.includes(item))) {
    const path = join(skillsRoot, name);
    let kind: SkillLink['kind'] = 'other', state: SkillLink['state'] = 'no-skill-file';
    try {
      const entry = await lstat(path);
      kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'other';
      let target;
      try { target = await stat(path); } catch { state = 'broken'; }
      if (target?.isDirectory()) { try { if ((await stat(join(path, 'SKILL.md'))).isFile()) state = 'ok'; } catch { /* Missing entry file. */ } }
      else if (kind === 'link' && target) state = 'broken';
    } catch { state = 'broken'; }
    links.push({ name, kind, state });
  }
  const failing = links.filter(item => item.state !== 'ok').map(item => item.name);
  const linkCheck = entries === null ? libraryCheck('skill-links', 'warning', 'skill-root-unknown', 'repair-skill-link')
    : links.some(item => item.state === 'broken') ? libraryCheck('skill-links', 'error', 'skill-link-broken', 'repair-skill-link', failing)
    : failing.length ? libraryCheck('skill-links', 'error', 'skill-entry-missing', 'repair-skill-link', failing)
    : libraryCheck('skill-links', 'normal', 'skill-links-intact', 'no-link-repair-needed');
  return { checks: [versionCheck, linkCheck], skills: { version, links } };
}
