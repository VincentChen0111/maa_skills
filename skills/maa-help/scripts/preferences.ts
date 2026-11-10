import { mkdir, readFile, open, rename, unlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export type Settings = { language: string | null; languageAsked: boolean; privateDirectory: string; maaDirectory: string | null; server: 'CN' };
export type SettingsPatch = Partial<Settings>;
export function settingsHome(): string {
  return resolve(process.env.MAA_SKILLS_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.maa-skills'));
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object-required');
  return value as Record<string, unknown>;
}
function locale(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('language-required');
  const result = Intl.getCanonicalLocales(value);
  if (!result[0]) throw new Error('language-required');
  return result[0];
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('absolute-path-required');
  return resolve(value);
}
function patch(value: unknown): SettingsPatch {
  const input = record(value);
  const result: SettingsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'language': result.language = value === null ? null : locale(value); break;
      case 'languageAsked': if (typeof value !== 'boolean') throw new Error('boolean-required'); result.languageAsked = value; break;
      case 'privateDirectory': result.privateDirectory = path(value); break;
      case 'maaDirectory': result.maaDirectory = value === null ? null : path(value); break;
      case 'server': if (value !== 'CN') throw new Error('unsupported-server'); result.server = 'CN'; break;
      default: throw new Error('unsupported-setting');
    }
  }
  return result;
}

export async function readSettings(home = settingsHome()): Promise<Settings> {
  const defaults: Settings = { language: null, languageAsked: false, privateDirectory: resolve(home), maaDirectory: null, server: 'CN' };
  try { return { ...defaults, ...patch(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults; throw error; }
}

async function withSettingsWrite<T>(home: string, action: () => Promise<T>): Promise<T> {
  await mkdir(home, { recursive: true });
  const lockFile = join(home, '.preferences.lock');
  let handle;
  try { handle = await open(lockFile, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('preferences-busy'); throw error; }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally { await handle.close(); await unlink(lockFile); }
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
    typeof input.source !== 'string' || !input.source.trim() || typeof input.text !== 'string' || !input.text.trim()) throw new Error('invalid-preference');
  const date = input.date ?? new Date().toISOString();
  if (typeof date !== 'string' || new Date(date).toISOString() !== date) throw new Error('invalid-date');
  await withSettingsWrite(home, async () => {
  const settings = await readSettings(home);
  await mkdir(settings.privateDirectory, { recursive: true });
  const handle = await open(join(settings.privateDirectory, 'preferences.jsonl'), 'a', 0o600);
  try { await handle.writeFile(`${JSON.stringify({ date, source: input.source, text: input.text })}\n`); await handle.sync(); }
  finally { await handle.close(); }
  });
}

const entryPath = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const input = record(JSON.parse(raw || '{}'));
    if (process.argv[2] === 'read') console.log(JSON.stringify({ ok: true, ...startup(await readSettings(), String(input.currentLanguage ?? 'zh-CN')) }));
    else if (process.argv[2] === 'set') {
      const settings = await updateSettings(input);
      console.log(JSON.stringify({ ok: true, changed: Object.keys(input), ...startup(settings, 'zh-CN') }));
    } else if (process.argv[2] === 'append') { await appendPreference(input); console.log(JSON.stringify({ ok: true, appended: true })); }
    else throw new Error('unknown-action');
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error && error.message === 'preferences-busy' ? 'preferences-busy' : 'preferences-check-required' }));
    process.exitCode = 1;
  }
}
