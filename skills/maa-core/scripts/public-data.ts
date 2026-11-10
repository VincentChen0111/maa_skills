import { createHash } from 'node:crypto';

export type PublicJsonSource = { repository: string; commit: string; file: string };
export type PublicJsonResult = { value: unknown; source: PublicJsonSource & { url: string; sha256: string; bytes: number; readAt: string } };
const maximumBytes = 64 * 1024 * 1024;

/** Read data at an immutable public GitHub revision; never execute or persist it. */
export async function readPublicJson(source: PublicJsonSource, fetcher: typeof fetch = fetch): Promise<PublicJsonResult> {
  if (!source || typeof source.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source.repository)
    || typeof source.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(source.commit)
    || typeof source.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/.test(source.file)
    || source.file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('public-data-input-invalid');
  const pinned = { repository: source.repository, commit: source.commit.toLowerCase(), file: source.file };
  const url = `https://raw.githubusercontent.com/${pinned.repository}/${pinned.commit}/${pinned.file}`;
  let response: Response;
  try { response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } }); }
  catch { throw new Error('public-data-network-failed'); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('public-data-http-failed'); }
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maximumBytes) { await response.body?.cancel().catch(() => {}); throw new Error('public-data-too-large'); }
  const chunks: Uint8Array[] = []; let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('public-data-json-invalid');
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); } catch { throw new Error('public-data-network-failed'); }
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) { await reader.cancel().catch(() => {}); throw new Error('public-data-too-large'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks, bytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new Error('public-data-json-invalid'); }
  return { value, source: { ...pinned, url, sha256: createHash('sha256').update(body).digest('hex'), bytes, readAt: new Date().toISOString() } };
}
