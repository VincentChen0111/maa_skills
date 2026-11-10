import { mkdir, readFile, open, rename, unlink, realpath, stat, link } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export type Settings = { language: string | null; languageAsked: boolean; privateDirectory: string; maaDirectory: string | null; server: 'CN' };
export type SettingsPatch = Partial<Settings>;
export function settingsHome(): string {
  return resolve(process.env.MAA_SKILLS_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.maa-skills'));
}

/** Rejected before anything is written, so the caller can correct the input and retry. */
class InputError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InputError('object-required');
  return value as Record<string, unknown>;
}
function locale(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new InputError('language-required');
  let result: string[];
  try { result = Intl.getCanonicalLocales(value); } catch { throw new InputError('language-required'); }
  if (!result[0]) throw new InputError('language-required');
  return result[0];
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new InputError('absolute-path-required');
  return resolve(value);
}
function patch(value: unknown): SettingsPatch {
  const input = record(value);
  const result: SettingsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'language': result.language = value === null ? null : locale(value); break;
      case 'languageAsked': if (typeof value !== 'boolean') throw new InputError('boolean-required'); result.languageAsked = value; break;
      case 'privateDirectory': result.privateDirectory = path(value); break;
      case 'maaDirectory': result.maaDirectory = value === null ? null : path(value); break;
      case 'server': if (value !== 'CN') throw new InputError('unsupported-server'); result.server = 'CN'; break;
      default: throw new InputError('unsupported-setting');
    }
  }
  return result;
}

export async function readSettings(home = settingsHome()): Promise<Settings> {
  const defaults: Settings = { language: null, languageAsked: false, privateDirectory: resolve(home), maaDirectory: null, server: 'CN' };
  try { return { ...defaults, ...patch(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults;
    throw error instanceof InputError ? new Error('settings-unreadable') : error;
  }
}

const staleLockMs = 30_000;
/**
 * A writer that died cannot leave settings half-written: config.json is replaced by rename and an
 * entry is a single append. Its lock therefore needs no reconciliation, unlike the MAA write lock.
 */
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const contended = (error: unknown) => ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');
const identity = (file: { ino: number; birthtimeMs: number }) => `${file.ino}:${file.birthtimeMs}`;

/** Identifies the lock file when its writer is gone; undefined while a writer may still hold it or once it has disappeared. */
async function staleLock(lockFile: string): Promise<string | undefined> {
  try {
    const file = await stat(lockFile);
    let holder: Record<string, unknown> = {};
    try { holder = record(JSON.parse(await readFile(lockFile, 'utf8'))); } catch { /* holder not recorded yet, or cut short */ }
    const started = typeof holder.startedAt === 'string' ? Date.parse(holder.startedAt) : Number.NaN;
    if (Date.now() - (Number.isNaN(started) ? file.mtimeMs : started) > staleLockMs) return identity(file);
    const pid = holder.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
    try { process.kill(pid, 0); return undefined; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? identity(file) : undefined; }
  } catch (error) { if (missing(error)) return undefined; throw error; }
}

/**
 * Removes only the file that was judged stale. Renaming it aside has a single winner; a writer that
 * finds it moved a different, live lock puts that lock back. Returns whether the stale file is gone.
 */
async function removeStaleLock(lockFile: string, judged: string): Promise<boolean> {
  const aside = `${lockFile}.${randomUUID()}.stale`;
  // Windows renames by handle, so a competing writer can move or still hold the same file: that is a lost race, not a failure.
  try {
    await rename(lockFile, aside);
    const same = identity(await stat(aside)) === judged;
    if (!same) await link(aside, lockFile).catch(() => undefined);
    await unlink(aside);
    return same;
  } catch (error) { if (missing(error) || contended(error)) return false; throw error; }
}

async function withSettingsWrite<T>(home: string, action: () => Promise<T>): Promise<T> {
  await mkdir(home, { recursive: true });
  const lockFile = join(home, '.preferences.lock');
  const acquire = async () => {
    // On Windows a lock that is being deleted answers EPERM for a moment; a lasting EPERM is a real permission problem.
    for (let attempt = 0; ; attempt += 1) {
      try { return await open(lockFile, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
        if (!contended(error) || attempt === 5) throw error;
        await new Promise((resume) => setTimeout(resume, 20));
      }
    }
  };
  let handle = await acquire();
  if (!handle) {
    const judged = await staleLock(lockFile);
    if (judged !== undefined && await removeStaleLock(lockFile, judged)) handle = await acquire();
  }
  if (!handle) throw new Error('preferences-busy');
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally {
    await handle.close();
    // A writer judging an older lock may hold this one aside for an instant; it puts it back or drops it, and a leftover is taken over later.
    try { await unlink(lockFile); } catch (error) { if (!missing(error)) throw error; }
  }
}

export async function updateSettings(value: unknown, home = settingsHome()): Promise<Settings> {
  const changes = patch(value);
  return withSettingsWrite(home, async () => {
  const previous = await readSettings(home);
  const next: Settings = { ...previous, ...changes };
  if (typeof changes.language === 'string') next.languageAsked = true;
  await mkdir(home, { recursive: true });
  const temporary = join(home, `.config-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, join(home, 'config.json'));
  } finally {
    try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return next;
  });
}

export function startup(settings: Settings, currentLanguage: string) {
  return { language: settings.language ?? locale(currentLanguage), languageAsked: settings.languageAsked,
    needsLanguagePrompt: settings.language === null, hasMaaDirectory: settings.maaDirectory !== null, server: settings.server };
}

export async function appendPreference(value: unknown, home = settingsHome()): Promise<void> {
  const input = record(value);
  if (Object.keys(input).some((key) => !['date', 'source', 'text'].includes(key)) ||
    typeof input.source !== 'string' || !input.source.trim() || typeof input.text !== 'string' || !input.text.trim()) throw new InputError('invalid-preference');
  const date = input.date ?? new Date().toISOString();
  if (typeof date !== 'string' || Number.isNaN(Date.parse(date)) || new Date(date).toISOString() !== date) throw new InputError('invalid-date');
  await withSettingsWrite(home, async () => {
  const settings = await readSettings(home);
  await mkdir(settings.privateDirectory, { recursive: true });
  const handle = await open(join(settings.privateDirectory, 'preferences.jsonl'), 'a', 0o600);
  try { await handle.writeFile(`${JSON.stringify({ date, source: input.source, text: input.text })}\n`); await handle.sync(); }
  finally { await handle.close(); }
  });
}

const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && await realpath(fileURLToPath(import.meta.url)) === entryPath) {
  try {
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    let parsed: unknown;
    try { parsed = JSON.parse(raw || '{}'); } catch { throw new InputError('json-required'); }
    const input = record(parsed);
    if (process.argv[2] === 'read') console.log(JSON.stringify({ ok: true, ...startup(await readSettings(), String(input.currentLanguage ?? 'zh-CN')) }));
    else if (process.argv[2] === 'set') {
      const settings = await updateSettings(input);
      console.log(JSON.stringify({ ok: true, changed: Object.keys(input), ...startup(settings, 'zh-CN') }));
    } else if (process.argv[2] === 'append') { await appendPreference(input); console.log(JSON.stringify({ ok: true, appended: true })); }
    else throw new InputError('unknown-action');
  } catch (error) {
    const code = error instanceof InputError ? 'invalid-input'
      : error instanceof Error && error.message === 'preferences-busy' ? 'preferences-busy' : 'preferences-check-required';
    console.error(JSON.stringify({ ok: false, error: code }));
    process.exitCode = 1;
  }
}
