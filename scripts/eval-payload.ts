import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payloadDirectoryRefusal } from './eval-auth.ts';

/**
 * A payload is the product a batch installs into the hosts: `skills/` and `.claude-plugin/`, in the repository's own layout.
 * By default it is the checkout's own; `--payload <directory>` takes it from a directory made here from another commit, while
 * everything else (scenarios, graders, fixtures, host adapters, redaction, preflights) stays the checkout's. This module makes
 * such a directory (read-only on the repository: `git archive` of the payload paths only), records where it came from and
 * checks it before a batch uses it.
 */
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const payloadPaths = ['skills', '.claude-plugin'] as const;
/** The record written beside the payload paths; it is not part of the payload or its digest. */
export const payloadRecordName = 'maa-skills-payload.json';
export type PayloadSource = { source: 'commit'; commit: string; tree: string; trees: Record<string, string>; digest: string } | { source: 'checkout'; digest: string };

async function regularFiles(root: string, directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await regularFiles(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error('payload-non-regular-file');
  }
  return result;
}
/** SHA-256 over every file of the payload paths present under `root` (relative path and content digest, sorted). */
export async function payloadDigest(root: string): Promise<string> {
  const lines: string[] = [];
  for (const path of payloadPaths) {
    let stats;
    try { stats = await lstat(join(root, path)); } catch { continue; }
    if (!stats.isDirectory()) throw new Error('payload-non-regular-file');
    for (const file of await regularFiles(root, path)) lines.push(`${file}:${digest(await readFile(join(root, file)))}`);
  }
  return digest(lines.sort().join('\n'));
}

/**
 * Git, read-only, with line-ending conversion off: a payload holds the committed bytes, the same on every machine and the
 * same as the archive GitHub serves (a checkout with `core.autocrlf=true` would turn them into CRLF).
 */
function git(repository: string, args: string[]): Buffer | undefined {
  const result = spawnSync('git', ['-C', repository, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { maxBuffer: 1 << 30, windowsHide: true });
  return result.status === 0 && !result.error ? result.stdout : undefined;
}
const gitText = (repository: string, args: string[]) => git(repository, args)?.toString('utf8').trim();

type TarEntry = { type: string; path: string; body: Buffer };
/** The entries of a `git archive --format=tar` stream: ustar headers, the global pax header (the commit id) and pax paths. */
function* tarEntries(archive: Buffer): Generator<TarEntry> {
  let offset = 0; let extended: Record<string, string> = {};
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    const field = (start: number, length: number) => { const raw = header.subarray(start, start + length); const end = raw.indexOf(0); return raw.subarray(0, end < 0 ? length : end).toString('utf8'); };
    const sizeText = field(124, 12).trim();
    if (!/^[0-7]*$/.test(sizeText)) throw new Error('payload-archive-entry');
    const size = parseInt(sizeText || '0', 8);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
    const prefix = field(345, 155);
    const body = archive.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) throw new Error('payload-archive-entry');
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') {
      extended = {};
      for (let position = 0; position < body.length;) {
        const space = body.indexOf(0x20, position); const length = Number(body.subarray(position, space).toString('utf8'));
        if (space < 0 || !Number.isInteger(length) || length <= 0) throw new Error('payload-archive-entry');
        const record = body.subarray(space + 1, position + length - 1).toString('utf8'); const equals = record.indexOf('=');
        extended[record.slice(0, equals)] = record.slice(equals + 1);
        position += length;
      }
      continue;
    }
    const path = extended.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    extended = {};
    yield { type, path, body };
  }
  throw new Error('payload-archive-entry');
}

/**
 * Makes a payload directory from a commit of `repository` (default: this checkout): only the payload paths, every file exactly
 * as committed. `out` must be new (or an existing empty directory), outside the repository and clear of the private, settings,
 * daily host and login directories (the login directory overlap predicate of `scripts/eval-auth.ts`). Nothing in the
 * repository is written. Returns, and records beside the payload, the commit, its tree, the tree of each payload path and the
 * content digest.
 */
export async function materializePayload(options: { commit: string; out: string; repository?: string }): Promise<Extract<PayloadSource, { source: 'commit' }>> {
  const repository = resolve(options.repository ?? repositoryRoot);
  const target = resolve(options.out);
  const refusal = await payloadDirectoryRefusal(target, { repository });
  if (refusal) throw new Error(`payload-directory-refused:${refusal}`);
  let created = false;
  try { if ((await readdir(target)).length) throw new Error('payload-directory-not-empty'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') throw new Error('payload-directory-not-empty');
    if (code !== 'ENOENT') throw error;
    created = true;
  }
  // A revision is never read as an option.
  if (!options.commit || /^-|[\s\0]/.test(options.commit)) throw new Error('payload-commit-unknown');
  const commit = gitText(repository, ['rev-parse', '--verify', '--quiet', `${options.commit}^{commit}`]);
  if (!commit || !/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('payload-commit-unknown');
  const tree = gitText(repository, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
  const listing = gitText(repository, ['ls-tree', commit, '--', ...payloadPaths]);
  if (!tree || listing === undefined) throw new Error('payload-git-failed');
  const trees: Record<string, string> = {};
  for (const line of listing.split('\n').filter(Boolean)) {
    const match = line.match(/^\d+ tree ([0-9a-f]+)\t(.+)$/);
    if (match && (payloadPaths as readonly string[]).includes(match[2]!)) trees[match[2]!] = match[1]!;
  }
  if (!trees.skills) throw new Error('payload-skills-missing');
  const archive = git(repository, ['archive', '--format=tar', commit, '--', ...Object.keys(trees)]);
  if (!archive) throw new Error('payload-git-failed');
  await mkdir(target, { recursive: true });
  try {
    for (const entry of tarEntries(archive)) {
      const path = entry.path.replace(/\/+$/, '');
      const parts = path.split('/');
      if (!(payloadPaths as readonly string[]).includes(parts[0]!) || parts.some((part) => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))) throw new Error('payload-archive-entry');
      // Payload files and the record are the only writes here: committed bytes and commit ids, never a path or host output.
      const file = join(target, ...parts);
      if (entry.type === '5') await mkdir(file, { recursive: true });
      else if (entry.type === '0') { await mkdir(dirname(file), { recursive: true }); await writeFile(file, entry.body, { flag: 'wx' }); }
      else throw new Error('payload-archive-entry');
    }
    const source = { source: 'commit' as const, commit, tree, trees, digest: await payloadDigest(target) };
    const record = join(target, payloadRecordName);
    await writeFile(record, `${JSON.stringify({ kind: 'maa-skills-payload', version: 1, ...source }, null, 2)}\n`, { flag: 'wx' });
    return source;
  } catch (error) {
    // Only what this call wrote: the directory was new or empty.
    if (created) await rm(target, { recursive: true, force: true });
    else for (const name of await readdir(target)) await rm(join(target, name), { recursive: true, force: true });
    throw error;
  }
}

/**
 * The payload a batch installs: the checkout's own (no directory), or a directory `materializePayload` made. Such a directory
 * stands where the checkout stands: it is refused where the login directory overlap predicate refuses it, its record must be
 * there and its content must still have the recorded digest. Static error codes only.
 */
export async function openPayload(directory?: string, context: { loginDirectories?: (string | undefined)[] } = {}): Promise<{ root: string; source: PayloadSource }> {
  if (directory === undefined) return { root: repositoryRoot, source: { source: 'checkout', digest: await payloadDigest(repositoryRoot) } };
  const root = resolve(directory);
  const refusal = await payloadDirectoryRefusal(root, context);
  if (refusal) throw new Error(`payload-directory-refused:${refusal}`);
  let record: Record<string, unknown>;
  try { record = JSON.parse(await readFile(join(root, payloadRecordName), 'utf8')) as Record<string, unknown>; }
  catch (error) { throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'payload-record-missing' : 'payload-record-invalid'); }
  const { kind, version, source, commit, tree, trees, digest: recorded } = record;
  if (kind !== 'maa-skills-payload' || version !== 1 || source !== 'commit' || typeof commit !== 'string' || typeof tree !== 'string' || typeof recorded !== 'string' ||
    !trees || typeof trees !== 'object' || Object.values(trees).some((value) => typeof value !== 'string')) throw new Error('payload-record-invalid');
  try { if (!(await lstat(join(root, 'skills'))).isDirectory()) throw new Error(); } catch { throw new Error('payload-skills-missing'); }
  if (await payloadDigest(root) !== recorded) throw new Error('payload-digest-mismatch');
  return { root, source: { source: 'commit', commit, tree, trees: trees as Record<string, string>, digest: recorded } };
}
