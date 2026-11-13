import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readSettings, settingsHome } from './preferences.ts';
import { windowsProtector, type Protector } from './credential-protection.ts';
import type { CheckResult } from './doctor.ts';

/**
 * Credentials the user enters in a local script for NGA, the Skland account and experimental Bilibili.
 * The only writer of a saved value is the user-run `input` flow; readers decrypt in memory; checks
 * read metadata only and never decrypt, contact a network service or print a value.
 */
export const credentialServices = ['nga', 'skland', 'bilibili'] as const;
export type CredentialService = typeof credentialServices[number];
export type CredentialState = 'unset' | 'unverified' | 'usable' | 'expired' | 'unreadable' | 'unknown';
export type CredentialOutcome = 'usable' | 'expired' | 'unreadable';
export type CredentialStatus = { service: CredentialService; state: CredentialState; experimental: boolean;
  savedAt: string | null; lastResultAt: string | null; expiresAt: string | null };
export type CredentialCheck = CheckResult & { message: string };

type ServiceDefinition = { fields: readonly string[]; kind: 'opaque' | 'cookie'; experimental: boolean; label: string; purpose: string; value: string };
const services: Record<CredentialService, ServiceDefinition> = {
  nga: { fields: ['cookie'], kind: 'cookie', experimental: false, label: 'NGA', purpose: 'NGA research', value: 'Cookie header value' },
  skland: { fields: ['token'], kind: 'opaque', experimental: false, label: 'Skland account',
    purpose: 'reading your own account data from Skland (public Skland community pages never use it)', value: 'token' },
  bilibili: { fields: ['sessdata'], kind: 'opaque', experimental: true, label: 'Bilibili (experimental)', purpose: 'experimental Bilibili research', value: 'SESSDATA value' },
};
const protection = 'windows-dpapi-current-user';
const maximumValueLength = 8192;
const maximumRecordBytes = 65536;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fixed, value-free failure codes. */
export class CredentialError extends Error {}

const isService = (value: unknown): value is CredentialService => credentialServices.includes(value as CredentialService);
const entropy = (service: CredentialService, revision: string) => `maa-skills/credentials/v1/${service}/${revision}`;
const directory = (privateDirectory: string) => join(privateDirectory, 'credentials');
const recordFile = (privateDirectory: string, service: CredentialService) => join(directory(privateDirectory), `${service}.json`);
const statusFile = (privateDirectory: string, service: CredentialService) => join(directory(privateDirectory), `${service}.status.json`);
function utc(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Reads a small JSON file; undefined when it does not exist. Other problems throw. */
async function readJson(path: string): Promise<unknown> {
  let handle;
  try { handle = await open(path, 'r'); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumRecordBytes) throw new CredentialError('record-invalid');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

async function writeAtomic(path: string, name: string, content: string) {
  await mkdir(path, { recursive: true });
  const temporary = join(path, `.${name}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(path, name));
  } finally { await unlink(temporary).catch(() => undefined); }
}

type SavedRecord = { revision: string; savedAt: string; ciphertext: Buffer };
function validRecord(service: CredentialService, value: unknown): SavedRecord | undefined {
  const record = object(value);
  if (!record || record.schemaVersion !== 1 || record.service !== service || typeof record.revision !== 'string' || !uuid.test(record.revision)
    || !utc(record.savedAt) || record.protection !== protection || !isDeepStrictEqual(record.fields, services[service].fields)
    || typeof record.ciphertext !== 'string' || !record.ciphertext || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.ciphertext)) return undefined;
  return { revision: record.revision, savedAt: record.savedAt, ciphertext: Buffer.from(record.ciphertext, 'base64') };
}
type SavedStatus = { revision: string; outcome: CredentialOutcome; at: string; expiresAt: string | null };
function validStatus(value: unknown): SavedStatus | undefined {
  const status = object(value);
  if (!status || status.schemaVersion !== 1 || typeof status.revision !== 'string' || !uuid.test(status.revision)
    || !['usable', 'expired', 'unreadable'].includes(status.outcome as string) || !utc(status.at)
    || status.expiresAt !== undefined && status.expiresAt !== null && !utc(status.expiresAt)) return undefined;
  return { revision: status.revision, outcome: status.outcome as CredentialOutcome, at: status.at, expiresAt: (status.expiresAt as string | null | undefined) ?? null };
}

async function inspectOne(privateDirectory: string | null, service: CredentialService, now: Date): Promise<CredentialStatus> {
  const base = { service, experimental: services[service].experimental, savedAt: null, lastResultAt: null, expiresAt: null };
  if (privateDirectory === null) return { ...base, state: 'unknown' };
  let record: SavedRecord | undefined;
  try {
    const value = await readJson(recordFile(privateDirectory, service));
    if (value === undefined) return { ...base, state: 'unset' };
    record = validRecord(service, value);
  } catch { /* An unreadable record is reported as such, never as unset. */ }
  if (!record) return { ...base, state: 'unreadable' };
  let status: SavedStatus | undefined;
  try { status = validStatus(await readJson(statusFile(privateDirectory, service))); } catch { /* A damaged result only loses verification. */ }
  const saved = { ...base, savedAt: record.savedAt };
  // A result recorded for an earlier saved value says nothing about the current one.
  if (!status || status.revision !== record.revision) return { ...saved, state: 'unverified' };
  const known = { ...saved, lastResultAt: status.at, expiresAt: status.expiresAt };
  if (status.outcome === 'usable' && status.expiresAt !== null && Date.parse(status.expiresAt) <= now.getTime()) return { ...known, state: 'expired' };
  return { ...known, state: status.outcome };
}

const command = (service: CredentialService) => `node <maa-core>/scripts/credentials.ts input ${service}`;
/** The check entry for one service and state; it carries no value, time or location. */
export function credentialCheck(service: CredentialService, state: CredentialState): CredentialCheck {
  const { label, purpose, value } = services[service];
  const run = `run "${command(service)}" yourself in your own terminal`;
  const never = 'Never paste the value into the conversation; the skill never signs in for you.';
  const results: Record<CredentialState, [CheckResult['status'], string, string, string]> = {
    unset: ['normal', `The ${label} credential is not set. It is optional and only needed for ${purpose}.`, 'enter-credential',
      `Only if you want ${purpose}: ${run} and follow its prompts. ${never}`],
    unverified: ['warning', `The ${label} credential is saved, but no actual read has confirmed it yet; it is not known to be valid.`, 'verify-by-use',
      `Nothing to repair now: the next actual read confirms it. If that read reports it expired, ${run} again. ${never}`],
    usable: ['normal', `The most recent actual read with the saved ${label} credential succeeded; it can still expire before the next read.`, 'replace-credential',
      `No action is needed. To replace it, ${run}. ${never}`],
    expired: ['error', `The saved ${label} credential is known to be expired or rejected.`, 'reenter-credential',
      `${run[0]!.toUpperCase()}${run.slice(1)} and paste a new ${value} you obtained yourself. ${never}`],
    unreadable: ['error', `The saved ${label} credential cannot be read on this Windows account or its record is damaged, so it is unusable.`, 'reenter-credential',
      `${run[0]!.toUpperCase()}${run.slice(1)} and paste a new ${value} you obtained yourself. ${never}`],
    unknown: ['warning', `The private directory is unknown until the settings are repaired, so the ${label} credential was not checked.`, 'inspect-settings',
      'Repair the settings file first, as its own check describes; credentials are checked afterwards.'],
  };
  const [result, message, repair, description] = results[state];
  return { id: `credential-${service}`, status: result, reason: `credential-${state}`, message, repair: { id: repair, executor: 'user', description } };
}

/**
 * Shared setup/doctor credential check. Read-only: it never decrypts, never calls a network service
 * and never creates directories. `privateDirectory` is null when the settings cannot be read.
 */
export async function inspectCredentials(privateDirectory: string | null, now = new Date()) {
  const credentials: CredentialStatus[] = [];
  for (const service of credentialServices) credentials.push(await inspectOne(privateDirectory === null ? null : resolve(privateDirectory), service, now));
  return { credentials, checks: credentials.map(item => credentialCheck(item.service, item.state)) };
}

/** Repairs the credential checks offer; only the user performs them, so doctor cannot execute them. */
export const userCredentialRepairs = ['enter-credential', 'verify-by-use', 'replace-credential', 'reenter-credential'] as const;

/** Normalizes one entered value; throws CredentialError('value-invalid') without echoing it. */
export function normalizeCredentialValue(service: CredentialService, raw: string): string {
  let value = raw.trim();
  if (services[service].kind === 'cookie') value = value.replace(/^cookie:\s*/i, '');
  else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  const pattern = services[service].kind === 'cookie' ? /^[\x20-\x7e]+$/ : /^[\x21-\x7e]+$/;
  if (!value || value.length > maximumValueLength || !pattern.test(value) || services[service].kind === 'cookie' && !value.includes('=')) throw new CredentialError('value-invalid');
  return value;
}

/**
 * Saves a new value for the user-run input flow. The previous record stays in place until the new
 * one is complete; a new revision is never reported usable before an actual read confirms it.
 */
export async function saveCredential(service: CredentialService, value: string, options: { privateDirectory: string; protector?: Protector; now?: Date }) {
  if (!isService(service)) throw new CredentialError('service-invalid');
  const normalized = normalizeCredentialValue(service, value);
  const revision = randomUUID();
  const [field] = services[service].fields;
  const ciphertext = await (options.protector ?? windowsProtector).protect(Buffer.from(JSON.stringify({ [field!]: normalized }), 'utf8'), entropy(service, revision));
  const record = { schemaVersion: 1, service, revision, savedAt: (options.now ?? new Date()).toISOString(), protection, fields: services[service].fields, ciphertext: ciphertext.toString('base64') };
  await writeAtomic(directory(resolve(options.privateDirectory)), `${service}.json`, `${JSON.stringify(record, null, 2)}\n`);
  return { revision };
}

/**
 * For readers (Skland snapshot, NGA and Bilibili research): decrypts the current value in memory.
 * Never log, print or persist the returned values. A record this Windows account cannot decrypt is
 * recorded as unreadable so the shared check asks the user to enter it again.
 */
export async function readCredential(service: CredentialService, options: { privateDirectory: string; protector?: Protector }) {
  if (!isService(service)) throw new CredentialError('service-invalid');
  const privateDirectory = resolve(options.privateDirectory);
  let record: SavedRecord | undefined;
  let raw: unknown;
  try { raw = await readJson(recordFile(privateDirectory, service)); } catch { throw new CredentialError('credential-unreadable'); }
  if (raw === undefined) throw new CredentialError('credential-unset');
  record = validRecord(service, raw);
  if (!record) throw new CredentialError('credential-unreadable');
  let plain: Buffer;
  try { plain = await (options.protector ?? windowsProtector).unprotect(record.ciphertext, entropy(service, record.revision)); }
  catch (error) {
    if (error instanceof Error && error.message === 'protection-unreadable') {
      await recordCredentialOutcome(service, record.revision, 'unreadable', { privateDirectory }).catch(() => false);
      throw new CredentialError('credential-unreadable');
    }
    throw new CredentialError(error instanceof Error && error.message === 'windows-required' ? 'windows-required' : 'protection-failed');
  }
  let values: Record<string, string>;
  try {
    const parsed = object(JSON.parse(plain.toString('utf8')));
    if (!parsed || !isDeepStrictEqual(Object.keys(parsed), [...services[service].fields]) || Object.values(parsed).some(item => typeof item !== 'string' || !item)) throw new Error('fields');
    values = parsed as Record<string, string>;
  } catch { throw new CredentialError('credential-unreadable'); }
  return { revision: record.revision, values };
}

/**
 * For readers: records what an actual read showed for the given saved revision. A result for a value
 * that has since been replaced is ignored (returns false), so it cannot mark the new value usable.
 */
export async function recordCredentialOutcome(service: CredentialService, revision: string, outcome: CredentialOutcome,
  options: { privateDirectory: string; at?: Date; expiresAt?: string | null }) {
  if (!isService(service) || typeof revision !== 'string' || !uuid.test(revision) || !['usable', 'expired', 'unreadable'].includes(outcome)
    || options.expiresAt !== undefined && options.expiresAt !== null && !utc(options.expiresAt)) throw new CredentialError('outcome-invalid');
  const privateDirectory = resolve(options.privateDirectory);
  let current: SavedRecord | undefined;
  try { current = validRecord(service, await readJson(recordFile(privateDirectory, service))); } catch { return false; }
  if (!current || current.revision !== revision) return false;
  const status = { schemaVersion: 1, revision, outcome, at: (options.at ?? new Date()).toISOString(), ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}) };
  await writeAtomic(directory(privateDirectory), `${service}.status.json`, `${JSON.stringify(status, null, 2)}\n`);
  return true;
}

// ---- user-run input flow -------------------------------------------------------------------------

type Language = 'zh' | 'en';
const text = {
  zh: {
    nga: ['NGA 凭据（Cookie）设置', '只用于只读检索 NGA 帖子：不发帖、不回复，也不会替你登录。',
      '请在你自己已登录 NGA 的浏览器里复制 Cookie 请求头的值。不要把它发到对话里，也不要交给任何人。', '失效后重新运行本脚本，输入新的值即可。'],
    skland: ['森空岛账号凭据（token）设置', '粘贴前请了解：',
      '1. 截至 2026-11-13，没有找到鹰角网络对第三方调用森空岛接口的公开表态。是否使用，由你自己决定。',
      '2. 这个 token 只用来读取账号数据（干员、仓库、基建等），不用于任何写入、签到或修改。',
      'token 由你自己取得；本脚本只接收你粘贴的 token，不会替你登录。不要把它发到对话里，也不要交给任何人。',
      '森空岛社区公开内容的调研不会使用这个 token。token 过期后，重新运行本脚本粘贴新的 token。'],
    bilibili: ['B 站凭据（SESSDATA）设置——实验性功能', 'B 站相关功能是实验性的，随时可能失效，请不要依赖它。',
      '只用于只读调研：不发评论、不点赞，也不会替你登录。',
      '请在你自己已登录 B 站的浏览器里复制名为 SESSDATA 的 Cookie 值。不要把它发到对话里，也不要交给任何人。', '失效后重新运行本脚本，输入新的值即可。'],
    field: { nga: 'Cookie', skland: 'token', bilibili: 'SESSDATA' } as Record<CredentialService, string>,
    proceed: '继续吗？输入 y 后回车继续，其他输入取消（输入不会显示）：',
    paste: (name: string) => `请粘贴 ${name}，然后回车（输入不会显示）：`,
    saved: '已保存，按 Windows 当前用户加密。状态：尚未验证——要等第一次实际读取才知道是否可用。',
    unchanged: '原有设置保持不变。',
    reasons: {
      cancelled: '已取消。', 'value-invalid': '输入的格式不对（为空、过长或含有不允许的字符），没有保存。',
      'terminal-required': '请在你自己的终端窗口里直接运行这条命令，按提示输入；agent 不能代你运行或输入。',
      'set-preferences-first': '还没有保存初始设置。请先用 maa-setup 完成语言和私有目录的设置。',
      'settings-unreadable': '设置文件无法读取，先按 maa-setup 的检查修复设置。',
      'windows-required': '凭据只能在 Windows 上按当前用户加密保存。', 'protection-failed': 'Windows 加密没有完成，没有保存。',
      'request-invalid': '用法：node credentials.ts input <nga|skland|bilibili> [--language <标签>]', 'input-too-large': '输入过长，没有保存。',
      unexpected: '保存没有完成。',
    } as Record<string, string>,
  },
  en: {
    nga: ['NGA credential (Cookie)', 'Used only for read-only NGA searches: it never posts or replies and never signs in for you.',
      'Copy the value of the Cookie request header from your own browser where you are signed in to NGA. Do not paste it into a chat or give it to anyone.',
      'When it stops working, run this script again and enter a new value.'],
    skland: ['Skland account credential (token)', 'Before you paste, please note:',
      '1. As of 2026-11-13, we found no public statement from Hypergryph about third parties calling the Skland API. Whether to use it is your decision.',
      '2. This token is used only to read your account data (operators, depot, base); it is never used to write, check in or change anything.',
      'You obtain the token yourself; this script only accepts the token you paste and never signs in for you. Do not paste it into a chat or give it to anyone.',
      'Research on public Skland community pages never uses this token. When the token expires, run this script again and paste a new one.'],
    bilibili: ['Bilibili credential (SESSDATA) - experimental', 'Bilibili features are experimental and may stop working at any time; do not rely on them.',
      'Used only for read-only research: it never comments or likes and never signs in for you.',
      'Copy the value of the cookie named SESSDATA from your own browser where you are signed in to Bilibili. Do not paste it into a chat or give it to anyone.',
      'When it stops working, run this script again and enter a new value.'],
    field: { nga: 'Cookie', skland: 'token', bilibili: 'SESSDATA' } as Record<CredentialService, string>,
    proceed: 'Continue? Type y and press Enter to continue; anything else cancels (input is hidden): ',
    paste: (name: string) => `Paste the ${name}, then press Enter (input is hidden): `,
    saved: 'Saved, encrypted for the current Windows user. Status: not yet verified - the first actual read will show whether it works.',
    unchanged: 'The existing setting is unchanged.',
    reasons: {
      cancelled: 'Cancelled.', 'value-invalid': 'The value has the wrong format (empty, too long or containing characters that are not allowed); nothing was saved.',
      'terminal-required': 'Run this command yourself in your own terminal window and answer its prompts; an agent cannot run it or type for you.',
      'set-preferences-first': 'Initial settings have not been saved yet. Finish the language and private directory setup with maa-setup first.',
      'settings-unreadable': 'The settings file cannot be read; repair it as the maa-setup check describes first.',
      'windows-required': 'Credentials can only be saved with Windows per-user encryption.', 'protection-failed': 'Windows encryption did not complete; nothing was saved.',
      'request-invalid': 'Usage: node credentials.ts input <nga|skland|bilibili> [--language <tag>]', 'input-too-large': 'The input is too long; nothing was saved.',
      unexpected: 'Saving did not complete.',
    } as Record<string, string>,
  },
};

type Terminal = { write(line: string): void; read(): Promise<string | null> };

function languageOf(tag: string | null | undefined): Language {
  return typeof tag === 'string' && /^zh\b/i.test(tag) ? 'zh' : 'en';
}

async function stdinTerminal(): Promise<Terminal> {
  let input = '';
  for await (const chunk of process.stdin) { input += String(chunk); if (Buffer.byteLength(input) > 65536) throw new CredentialError('input-too-large'); }
  const lines = input.split(/\r?\n/);
  // Answers are never echoed; only the line break the user's Enter would have produced.
  return { write: text => process.stdout.write(text), read: async () => { process.stdout.write('\n'); return lines.length ? lines.shift()! : null; } };
}

export type TerminalLine = { value: string; skipLineFeed: boolean };
/**
 * Applies raw terminal input to the answer being read. `result` is the finished answer (null when
 * cancelled with Ctrl+C, Ctrl+D or Ctrl+Z); `rest` is input after Enter, kept for the next prompt.
 * Enter is CR in a Windows console; an LF arriving right after it is not a second, empty answer.
 */
export function applyTerminalInput(line: TerminalLine, chunk: string): { line: TerminalLine; result?: string | null; rest: string } {
  let { value, skipLineFeed } = line;
  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index]!;
    if (skipLineFeed) { skipLineFeed = false; if (char === '\n') continue; }
    if (char === '\r' || char === '\n') return { line: { value: '', skipLineFeed: char === '\r' }, result: value, rest: chunk.slice(index + 1) };
    if (char === '\u0003' || char === '\u0004' || char === '\u001a') return { line: { value: '', skipLineFeed: false }, result: null, rest: '' };
    if (char === '\u001b') {
      if (chunk[index + 1] === '[' || chunk[index + 1] === 'O') { index += 2; while (index < chunk.length && !/[@-~]/.test(chunk[index]!)) index += 1; }
      continue;
    }
    if (char === '\b' || char === '\u007f') { value = Array.from(value).slice(0, -1).join(''); continue; }
    if (char >= ' ' && value.length <= maximumValueLength * 2) value += char;
  }
  return { line: { value, skipLineFeed }, rest: '' };
}

/** Raw-mode reading: nothing typed or pasted is echoed. */
function ttyTerminal(): Terminal {
  let pending = ''; let line: TerminalLine = { value: '', skipLineFeed: false };
  const read = () => new Promise<string | null>((resolveRead) => {
    const input = process.stdin;
    const feed = (chunk: string) => {
      const step = applyTerminalInput(line, chunk);
      line = step.line;
      if (step.result === undefined) return;
      pending = step.rest;
      input.off('data', feed); input.setRawMode(false); input.pause(); process.stdout.write('\n'); resolveRead(step.result);
    };
    input.setEncoding('utf8'); input.setRawMode(true); input.resume(); input.on('data', feed);
    if (pending) { const queued = pending; pending = ''; feed(queued); }
  });
  return { write: text => process.stdout.write(text), read };
}

/** The interactive flow. Every non-zero result leaves the saved record and its status untouched. */
async function runInput(service: CredentialService, terminal: Terminal, language: Language, privateDirectory: string) {
  const words = text[language];
  for (const line of words[service]) terminal.write(`${line}\n`);
  terminal.write(words.proceed);
  const answer = await terminal.read();
  if (answer === null || !['y', 'yes'].includes(answer.trim().toLowerCase())) throw new CredentialError('cancelled');
  terminal.write(words.paste(words.field[service]));
  const value = await terminal.read();
  if (value === null || !value.trim()) throw new CredentialError('cancelled');
  await saveCredential(service, value, { privateDirectory });
  terminal.write(`${words.saved}\n`);
}

const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  const args = process.argv.slice(2);
  if (args[0] === 'check') {
    try {
      if (args.length > 2 || args.length === 2 && args[1] !== '--json') throw new CredentialError('request-invalid');
      let privateDirectory: string | null = null;
      try { privateDirectory = (await readSettings()).privateDirectory; } catch { /* Unreadable settings leave the location unknown. */ }
      const result = await inspectCredentials(privateDirectory);
      const value = { checkedAt: new Date().toISOString(), exitCode: result.checks.some(item => item.status === 'error') ? 1 : 0, ...result };
      console.log(args[1] === '--json' ? JSON.stringify(value) : JSON.stringify(value, null, 2));
      process.exitCode = value.exitCode;
    } catch (error) {
      const reason = error instanceof CredentialError && error.message === 'request-invalid' ? 'request-invalid' : 'credential-check-required';
      console.log(JSON.stringify({ status: reason === 'request-invalid' ? 'rejected' : 'unexpected-failure', reason }));
      process.exitCode = reason === 'request-invalid' ? 1 : 2;
    }
  } else {
    let language: Language = languageOf(Intl.DateTimeFormat().resolvedOptions().locale);
    let reason = 'unexpected';
    try {
      const service = args[1];
      const flags = args.slice(2);
      let fromStdin = false; let requested: string | undefined;
      for (let index = 0; index < flags.length; index += 1) {
        if (flags[index] === '--stdin' && !fromStdin) fromStdin = true;
        else if (flags[index] === '--language' && requested === undefined && flags[index + 1]) { requested = flags[index + 1]; index += 1; }
        else throw new CredentialError('request-invalid');
      }
      if (requested !== undefined) {
        try { language = languageOf(Intl.getCanonicalLocales(requested)[0]); } catch { throw new CredentialError('request-invalid'); }
      }
      if (args[0] !== 'input' || !isService(service)) throw new CredentialError('request-invalid');
      const home = settingsHome();
      try { if (!(await stat(join(home, 'config.json'))).isFile()) throw new Error('missing'); }
      catch { throw new CredentialError('set-preferences-first'); }
      let settings;
      try { settings = await readSettings(home); } catch { throw new CredentialError('settings-unreadable'); }
      if (requested === undefined && settings.language) language = languageOf(settings.language);
      if (!fromStdin && !process.stdin.isTTY) throw new CredentialError('terminal-required');
      await runInput(service, fromStdin ? await stdinTerminal() : ttyTerminal(), language, settings.privateDirectory);
      process.exitCode = 0;
    } catch (error) {
      if (error instanceof CredentialError) reason = error.message;
      else if (error instanceof Error && ['windows-required', 'protection-failed'].includes(error.message)) reason = error.message;
      const words = text[language];
      const message = words.reasons[reason] ?? words.reasons.unexpected!;
      process.stderr.write(`${message}${reason === 'request-invalid' ? '' : ` ${words.unchanged}`}\n`);
      process.exitCode = reason === 'unexpected' ? 2 : 1;
    }
  }
}
