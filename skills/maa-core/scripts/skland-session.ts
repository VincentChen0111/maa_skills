import { createHash, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { CredentialError, readCredential, recordCredentialOutcome } from './credentials.ts';
import type { Protector } from './credential-protection.ts';

/**
 * The one owner of the Skland session for both readers that use the user's own Skland credential: the
 * account snapshot (ticket 12) and the community post reader (ticket 19). It reads the saved token,
 * exchanges it, signs requests, refreshes in memory and records what an actual read showed for the saved
 * revision. Only GET data requests are signed; the two exchange steps are the only POSTs. The token, grant
 * code, cred and signing key never leave this process: errors carry fixed codes only, never a URL, header
 * or reply. Endpoints and signing were checked against public MIT projects; see docs/skland-account-sources.md.
 */
export type SklandFetch = (url: string, init: RequestInit) => Promise<Response>;
export type SklandIssue = 'network-failed' | 'service-error' | 'signature-rejected' | 'response-invalid' | 'credential-rejected' | 'binding-missing' | 'binding-ambiguous';
export type CredentialReport = 'usable' | 'expired' | 'unreadable' | 'unset' | 'unchanged';
export type CredentialFailure = 'credential-unset' | 'credential-unreadable' | 'windows-required' | 'protection-failed';

export const sklandOrigin = 'https://zonai.skland.com';
const grantUrl = 'https://as.hypergryph.com/user/oauth2/v2/grant';
const auth = { appCode: '4ca99fa6b56cc2ba', cred: '/api/v1/user/auth/generate_cred_by_code', refresh: '/api/v1/auth/refresh' } as const;
export const sklandRequestTimeoutMs = 20_000;
export const sklandMaximumResponseBytes = 16 * 1024 * 1024;

export class SklandReadFailure extends Error {
  readonly issue: SklandIssue;
  constructor(issue: SklandIssue) { super(issue); this.issue = issue; }
}
export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function object(value: unknown): Record<string, unknown> { if (!isObject(value)) throw new Error('object-required'); return value; }

async function bodyText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > sklandMaximumResponseBytes) throw new SklandReadFailure('response-invalid');
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > sklandMaximumResponseBytes) { await reader.cancel().catch(() => undefined); throw new SklandReadFailure('response-invalid'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** One request: fixed host, no redirects, bounded time and size. Errors carry only a fixed code, never the URL or the reply. */
async function call(fetcher: SklandFetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response; let text: string;
  try {
    response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(sklandRequestTimeoutMs) });
    text = await bodyText(response);
  } catch (error) { throw error instanceof SklandReadFailure ? error : new SklandReadFailure('network-failed'); }
  if (response.status === 429 || response.status >= 500) throw new SklandReadFailure('service-error');
  try { return object(JSON.parse(text.replace(/^﻿/, ''))); }
  catch { throw new SklandReadFailure(response.ok ? 'response-invalid' : 'service-error'); }
}
const json = { 'Content-Type': 'application/json' };
const status = (value: unknown) => Number.isSafeInteger(value) ? value as number : undefined;

/**
 * Session with the two-level refresh: a 10000 reply refreshes the signing key once with the cred; a 10002
 * reply, or a refresh that is refused or does not help, exchanges the saved token again once. Only a grant
 * the service explicitly refuses rejects the credential. Every data request follows a grant that accepted
 * the token in this same read, so 10000/10002 after both levels is a signature, clock or header problem.
 */
export class SklandSession {
  private cred = ''; private key = ''; private refreshed = false; private exchangedAgain = false;
  private readonly fetcher: SklandFetch; private readonly userToken: string; private readonly clock: () => number;
  constructor(fetcher: SklandFetch, userToken: string, clock: () => number) { this.fetcher = fetcher; this.userToken = userToken; this.clock = clock; }
  async start() { await this.exchange(); }
  private async exchange() {
    const grant = await call(this.fetcher, grantUrl, { method: 'POST', headers: json, body: JSON.stringify({ appCode: auth.appCode, ['token']: this.userToken, type: 0 }) });
    const code = isObject(grant.data) ? grant.data.code : undefined;
    if (grant.status !== 0 || typeof code !== 'string' || !code) throw new SklandReadFailure(status(grant.status) !== undefined && grant.status !== 0 ? 'credential-rejected' : 'response-invalid');
    const issued = await call(this.fetcher, sklandOrigin + auth.cred, { method: 'POST', headers: json, body: JSON.stringify({ code, kind: 1 }) });
    const data = isObject(issued.data) ? issued.data : {};
    if (issued.code !== 0 || typeof data.cred !== 'string' || !data.cred || typeof data['token'] !== 'string' || !data['token']) {
      throw new SklandReadFailure(status(issued.code) !== undefined && issued.code !== 0 ? 'service-error' : 'response-invalid');
    }
    this.cred = data.cred; this.key = data['token'] as string;
  }
  private async refreshKey(): Promise<boolean> {
    const reply = await call(this.fetcher, sklandOrigin + auth.refresh, { method: 'GET', headers: { cred: this.cred } });
    const data = isObject(reply.data) ? reply.data : {};
    if (reply.code === 0 && typeof data['token'] === 'string' && data['token']) { this.key = data['token'] as string; return true; }
    if (status(reply.code) === undefined) throw new SklandReadFailure('response-invalid');
    return false;
  }
  private signed(path: string, query: string): Record<string, string> {
    const header = { platform: '', timestamp: String(Math.floor(this.clock() / 1000) - 1), dId: '', vName: '' };
    const hex = createHmac('sha256', this.key).update(`${path}${query}${header.timestamp}${JSON.stringify(header)}`).digest('hex');
    return { cred: this.cred, sign: createHash('md5').update(hex).digest('hex'), ...header };
  }
  /**
   * One signed GET with the two-level refresh. Returns the reply envelope whatever its code, except 10000 and
   * 10002, which this session answers itself; the caller decides what the other codes mean.
   */
  async reply(path: string, query = ''): Promise<Record<string, unknown>> {
    for (;;) {
      const reply = await call(this.fetcher, `${sklandOrigin}${path}${query ? `?${query}` : ''}`, { method: 'GET', headers: this.signed(path, query) });
      if (reply.code !== 10000 && reply.code !== 10002) return reply;
      if (reply.code === 10000 && !this.refreshed && !this.exchangedAgain) { this.refreshed = true; if (await this.refreshKey()) continue; }
      if (this.exchangedAgain) throw new SklandReadFailure('signature-rejected');
      this.exchangedAgain = true; await this.exchange();
    }
  }
  /** A signed GET whose reply must be code 0 with an object `data`; any other code is a service error. */
  async get(path: string, query = ''): Promise<Record<string, unknown>> {
    const reply = await this.reply(path, query);
    if (reply.code === 0) { if (!isObject(reply.data)) throw new SklandReadFailure('response-invalid'); return reply.data; }
    throw new SklandReadFailure(status(reply.code) !== undefined ? 'service-error' : 'response-invalid');
  }
}

/** What an actual read showed for the saved revision; `report` is what this read changed. */
export class SklandCredential {
  report: CredentialReport = 'unchanged';
  private readonly privateDirectory: string; private readonly revision: string;
  constructor(privateDirectory: string, revision: string) { this.privateDirectory = privateDirectory; this.revision = revision; }
  async record(outcome: 'usable' | 'expired') {
    if (await recordCredentialOutcome('skland', this.revision, outcome, { privateDirectory: this.privateDirectory }).catch(() => false)) this.report = outcome;
  }
}

export type SklandOpen = { status: 'ready'; session: SklandSession; credential: SklandCredential } | { status: CredentialFailure; credential: CredentialReport };
/**
 * Reads the saved token and prepares a session; nothing is sent yet. An unset or unreadable credential, or a
 * protection failure, is returned as a status without any request.
 */
export async function openSklandSession(options: { privateDirectory: string; fetcher?: SklandFetch; protector?: Protector; now?: () => Date }): Promise<SklandOpen> {
  const privateDirectory = resolve(options.privateDirectory);
  let saved: { revision: string; values: Record<string, string> };
  try { saved = await readCredential('skland', { privateDirectory, ...(options.protector ? { protector: options.protector } : {}) }); }
  catch (error) {
    const code = error instanceof CredentialError ? error.message : 'protection-failed';
    if (code === 'credential-unset') return { status: 'credential-unset', credential: 'unset' };
    if (code === 'credential-unreadable') return { status: 'credential-unreadable', credential: 'unreadable' };
    return { status: code === 'windows-required' ? 'windows-required' : 'protection-failed', credential: 'unchanged' };
  }
  const now = options.now ?? (() => new Date(Date.now()));
  return { status: 'ready', credential: new SklandCredential(privateDirectory, saved.revision),
    session: new SklandSession(options.fetcher ?? ((url, init) => fetch(url, init)), saved.values['token'] ?? '', () => now().getTime()) };
}
