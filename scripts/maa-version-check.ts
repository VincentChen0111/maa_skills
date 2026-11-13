import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareMaaVersions } from '../skills/maa-core/scripts/maa-version.ts';

/**
 * MAA version tracking (ticket 25, spec 「MAA 版本跟踪」). The registry (docs/maa-dependencies.json) lists every MAA
 * behaviour this repository depends on: the source locations with their Git blob fingerprints, the affected skills and the
 * versions on which each entry was source- and device-verified. Only fingerprints and locations are stored, never MAA code.
 * The packaged verification record is generated from it. `daily` is the GitHub Action entry: it looks at the newest stable
 * release and the newest beta above it, compares fingerprints, and opens a PR (stable, nothing changed) or an issue
 * (stable changed or missing; beta changed). It runs no model, no MAA and touches no account or user configuration.
 */
export const maaRepository = 'MaaAssistantArknights/MaaAssistantArknights';
export const registryPath = 'docs/maa-dependencies.json';
export const recordPath = 'skills/maa-core/references/verified-versions.json';
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
export const notificationLabel = 'maa-version-check';
// Design defaults (spec 「默认值及其来源」, 25): bounded requests and sizes.
export const limits = { requestMs: 20000, sourceBytes: 8 * 1024 * 1024, apiBytes: 4 * 1024 * 1024, entries: 200, sourcesPerEntry: 50, paths: 300, releasesPerPage: 30, notificationPages: 10 };

const stable = /^\d+\.\d+\.\d+$/;
const semver = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
const sha1 = /^[0-9a-f]{40}$/;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const knownSkills = ['maa-account', 'maa-core', 'maa-daily', 'maa-doctor', 'maa-help', 'maa-setup'];

export type SourceLocation = { path: string; blob: string };
export type DependencyEntry = { id: string; behaviour: string; skills: string[]; tickets: string[]; evidence: string[]; sources: SourceLocation[];
  sourceVerified: string[]; deviceVerified: string[]; facts?: Record<string, string[]> };
export type PendingRegistration = { ticket: string; locations: string[]; note: string };
export type Registry = { schemaVersion: 1; repository: string; entries: DependencyEntry[]; pending: PendingRegistration[] };
export type RecordFile = { schemaVersion: 2; recordVersion: number; sourceVerified: string[]; deviceVerified: string[] };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown, test: (item: string) => boolean, min = 0, max = 1000): value is string[] =>
  Array.isArray(value) && value.length >= min && value.length <= max && value.every(item => typeof item === 'string' && test(item)) && new Set(value).size === value.length;
const only = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

function fail(): never { throw new Error('registry-invalid'); }
/** Rejects anything outside the schema; a beta can never appear in a verified list. */
export function validateRegistry(value: unknown): Registry {
  if (!isObject(value) || !only(value, ['schemaVersion', 'repository', 'entries', 'pending']) || value.schemaVersion !== 1 || value.repository !== maaRepository
    || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > limits.entries || !Array.isArray(value.pending)) fail();
  const ids = new Set<string>(), paths = new Set<string>();
  for (const entry of value.entries as unknown[]) {
    if (!isObject(entry) || !only(entry, ['id', 'behaviour', 'skills', 'tickets', 'evidence', 'sources', 'sourceVerified', 'deviceVerified'], ['facts'])
      || typeof entry.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || ids.has(entry.id)
      || typeof entry.behaviour !== 'string' || !entry.behaviour.trim() || !strings(entry.skills, skill => knownSkills.includes(skill), 1)
      || !strings(entry.tickets, ticket => /^\d{2}$/.test(ticket), 1) || !strings(entry.evidence, path => safePath.test(path), 1)
      || !strings(entry.sourceVerified, version => stable.test(version), 1) || !strings(entry.deviceVerified, version => stable.test(version))
      || !Array.isArray(entry.sources) || !entry.sources.length || entry.sources.length > limits.sourcesPerEntry) fail();
    const entryPaths = new Set<string>();
    for (const source of entry.sources as unknown[]) {
      if (!isObject(source) || !only(source, ['path', 'blob']) || typeof source.path !== 'string' || !safePath.test(source.path) || entryPaths.has(source.path)
        || typeof source.blob !== 'string' || !sha1.test(source.blob)) fail();
      entryPaths.add(String((source as SourceLocation).path)); paths.add(String((source as SourceLocation).path));
    }
    if (entry.facts !== undefined && (!isObject(entry.facts) || Object.values(entry.facts).some(list => !strings(list, item => !!item.trim(), 1)))) fail();
    ids.add(entry.id as string);
  }
  if (paths.size > limits.paths) fail();
  for (const item of value.pending as unknown[]) {
    if (!isObject(item) || !only(item, ['ticket', 'locations', 'note']) || typeof item.ticket !== 'string' || !/^\d{2}$/.test(item.ticket)
      || !strings(item.locations, path => safePath.test(path), 1) || typeof item.note !== 'string' || !item.note.trim()) fail();
  }
  return value as Registry;
}

export async function readRegistry(file: string = join(repositoryRoot, registryPath)): Promise<Registry> {
  return validateRegistry(JSON.parse(await readFile(file, 'utf8')));
}
async function readRecord(file: string): Promise<RecordFile> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isObject(value) || !only(value, ['schemaVersion', 'recordVersion', 'sourceVerified', 'deviceVerified']) || value.schemaVersion !== 2
    || !Number.isSafeInteger(value.recordVersion) || Number(value.recordVersion) < 1 || !strings(value.sourceVerified, version => stable.test(version))
    || !strings(value.deviceVerified, version => stable.test(version))) throw new Error('record-invalid');
  return value as RecordFile;
}

/** Git's blob id: SHA-1 of `blob <length>\0` followed by the bytes, the value `git hash-object` prints. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

const sortVersions = (versions: Iterable<string>) => [...new Set(versions)].sort(compareMaaVersions);
const intersect = (lists: string[][]) => sortVersions(lists.reduce((common, list) => common.filter(version => list.includes(version))));

/** A version is listed only when every entry lists it; the record's own version rises only when a list changes. */
export function generateRecord(registry: Registry, previous?: Pick<RecordFile, 'recordVersion' | 'sourceVerified' | 'deviceVerified'>): RecordFile {
  const sourceVerified = intersect(registry.entries.map(entry => entry.sourceVerified));
  const deviceVerified = intersect(registry.entries.map(entry => entry.deviceVerified));
  const same = previous && JSON.stringify([previous.sourceVerified, previous.deviceVerified]) === JSON.stringify([sourceVerified, deviceVerified]);
  return { schemaVersion: 2, recordVersion: !previous ? 1 : same ? previous.recordVersion : previous.recordVersion + 1, sourceVerified, deviceVerified };
}

export function releaseNotes(record: RecordFile): string {
  const list = (versions: string[], none: string) => versions.length ? versions.map(version => `v${version}`).join('、') : none;
  return `MAA 源码已核：${list(record.sourceVerified, '无')}\nMAA 实机已核：${list(record.deviceVerified, '无（没有在真实 MAA、模拟器和游戏上核对过的版本）')}\n`;
}

/** Returns the file bytes, or null when the location does not exist in that version. */
export type SourceReader = (path: string) => Promise<Uint8Array | null>;

export function directorySource(directory: string): SourceReader {
  return async path => {
    const root = await realpath(directory), file = resolve(root, path);
    const inside = relative(root, file);
    if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw new Error('source-path-invalid');
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      if (info.size > limits.sourceBytes) throw new Error('source-too-large');
      return await readFile(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
}

async function boundedBytes(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await response.body?.cancel().catch(() => {}); throw new Error('response-too-large'); }
  const chunks: Uint8Array[] = []; let total = 0;
  if (response.body) for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > max) throw new Error('response-too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Read-only raw file reads at one full commit; the token is never sent to this host. */
export function githubSource(commit: string, fetcher: typeof fetch): SourceReader {
  if (!sha1.test(commit)) throw new Error('commit-invalid');
  return async path => {
    if (!safePath.test(path)) throw new Error('source-path-invalid');
    const response = await fetcher(`https://raw.githubusercontent.com/${maaRepository}/${commit}/${path}`,
      { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(limits.requestMs), headers: { 'User-Agent': 'maa-skills-version-check' } });
    if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('source-unavailable'); }
    return boundedBytes(response, limits.sourceBytes);
  };
}

export type SourceResult = { path: string; state: 'unchanged' | 'changed' | 'missing'; recorded: string; current: string | null };
export type EntryResult = { id: string; behaviour: string; skills: string[]; tickets: string[]; state: SourceResult['state']; sources: SourceResult[] };
export type CheckResult = { outcome: 'unchanged' | 'changed'; entries: EntryResult[] };

/** Whole-file fingerprints: any change to a listed file counts as a change (more issues, never a wrong certification). */
export async function checkSources(registry: Registry, reader: SourceReader): Promise<CheckResult> {
  const cache = new Map<string, Promise<string | null>>();
  const fingerprint = (path: string) => { if (!cache.has(path)) cache.set(path, reader(path).then(bytes => bytes === null ? null : gitBlobSha(bytes))); return cache.get(path)!; };
  const entries: EntryResult[] = [];
  for (const entry of registry.entries) {
    const sources: SourceResult[] = [];
    for (const source of entry.sources) {
      const current = await fingerprint(source.path);
      sources.push({ path: source.path, state: current === null ? 'missing' : current === source.blob ? 'unchanged' : 'changed', recorded: source.blob, current });
    }
    const state = sources.some(item => item.state === 'missing') ? 'missing' : sources.some(item => item.state === 'changed') ? 'changed' : 'unchanged';
    entries.push({ id: entry.id, behaviour: entry.behaviour, skills: entry.skills, tickets: entry.tickets, state, sources });
  }
  return { outcome: entries.every(entry => entry.state === 'unchanged') ? 'unchanged' : 'changed', entries };
}

/** Adds a source-verified stable version to every entry (the PR content after an unchanged check). */
export function addSourceVerified(registry: Registry, version: string): Registry {
  if (!stable.test(version)) throw new Error('version-not-stable');
  return { ...registry, entries: registry.entries.map(entry => ({ ...entry, sourceVerified: sortVersions([...entry.sourceVerified, version]) })) };
}

/** After a person re-verified the named entries on a local source tree: new fingerprints, version added. */
export async function reverifyEntries(registry: Registry, ids: string[], version: string, reader: SourceReader): Promise<Registry> {
  if (!stable.test(version)) throw new Error('version-not-stable');
  if (!ids.length || ids.some(id => !registry.entries.some(entry => entry.id === id))) throw new Error('entry-unknown');
  const entries = [];
  for (const entry of registry.entries) {
    if (!ids.includes(entry.id)) { entries.push(entry); continue; }
    const sources = [];
    for (const source of entry.sources) {
      const bytes = await reader(source.path);
      if (bytes === null) throw new Error('source-missing');
      sources.push({ path: source.path, blob: gitBlobSha(bytes) });
    }
    entries.push({ ...entry, sources, sourceVerified: sortVersions([...entry.sourceVerified, version]) });
  }
  return validateRegistry({ ...registry, entries });
}

type Release = { tag: string; version: string; prerelease: boolean };
export type TargetReport = { version: string; tag: string; commit: string | null; outcome: 'unchanged' | 'changed' | 'already-verified' | 'older-than-record'; entries: EntryResult[] };
export type ActionReport = { kind: 'pull-request' | 'issue'; key: string; title: string; state: 'planned' | 'created' | 'already-notified'; url?: string };
export type DailyReport = { checkedAt: string; stable: TargetReport | null; beta: TargetReport | null; actions: ActionReport[] };
/** `baseCommit` is the commit the registry and record were read from (the Action's checkout); the PR branch starts there. */
export type DailyOptions = { registry: Registry; record: RecordFile; fetcher: typeof fetch; token?: string; publish: boolean; repository?: string; baseCommit?: string; now?: Date };

function api(fetcher: typeof fetch, token: string | undefined) {
  const request = async (method: string, url: string, body?: unknown, accept = 'application/vnd.github+json') => {
    const headers = new Headers({ Accept: accept, 'User-Agent': 'maa-skills-version-check', 'X-GitHub-Api-Version': '2022-11-28' });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(limits.requestMs), headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bytes = await boundedBytes(response, limits.apiBytes);
    return { status: response.status, text: Buffer.from(bytes).toString('utf8') };
  };
  const json = async (method: string, url: string, body?: unknown, ok: number[] = [200, 201]) => {
    const result = await request(method, url, body);
    if (!ok.includes(result.status)) throw new Error('github-request-failed');
    return result.text ? JSON.parse(result.text) as unknown : null;
  };
  return { request, json };
}

function parseReleases(value: unknown): Release[] {
  if (!Array.isArray(value)) throw new Error('release-lookup-failed');
  const releases: Release[] = [];
  for (const item of value) {
    if (!isObject(item) || item.draft === true || typeof item.tag_name !== 'string') continue;
    const match = semver.exec(item.tag_name);
    if (!match) continue;
    // A release is stable only when GitHub marks it so and its version has no pre-release part; anything else is a beta.
    releases.push({ tag: item.tag_name, version: match[1]!, prerelease: item.prerelease !== false || !stable.test(match[1]!) });
  }
  return releases;
}
const newest = (releases: Release[]) => [...releases].sort((a, b) => compareMaaVersions(b.version, a.version))[0] ?? null;

function changeKey(kind: 'stable-change' | 'beta-change', result: { entries: EntryResult[] }): string {
  const rows = result.entries.flatMap(entry => entry.sources.filter(source => source.state !== 'unchanged').map(source => `${entry.id}|${source.path}|${source.current ?? 'missing'}`)).sort();
  return `${kind}:${createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16)}`;
}
const marker = (key: string) => `<!-- ${notificationLabel}:${key} -->`;

function changeBody(target: TargetReport, beta: boolean, key: string): string {
  const affected = target.entries.filter(entry => entry.state !== 'unchanged');
  const skills = [...new Set(affected.flatMap(entry => entry.skills))].sort();
  const lines = [beta
    ? `MAA ${target.tag}（beta，提交 \`${target.commit}\`）里，本仓库依赖的 MAA 源码有变化。这是提前预警：beta 不进入「源码已核」列表，请在正式版发布前核对并更新受影响的 skill。`
    : `MAA ${target.tag}（正式版，提交 \`${target.commit}\`）里，本仓库依赖的 MAA 源码有变化或缺失，所以这个版本没有加入「源码已核」列表。`,
  '', `受影响的 skill：${skills.join('、')}`, '', '| 依赖条目 | 状态 | 行为 | skill | 工单 |', '| --- | --- | --- | --- | --- |',
  ...affected.map(entry => `| \`${entry.id}\` | ${entry.state === 'missing' ? '缺失' : '变化'} | ${entry.behaviour.replaceAll('|', '\\|')} | ${entry.skills.join('、')} | ${entry.tickets.join('、')} |`),
  '', '变化的位置（Git blob 指纹，只比较指纹，不含 MAA 代码）：', '',
  ...affected.flatMap(entry => entry.sources.filter(source => source.state !== 'unchanged').map(source =>
    `- \`${entry.id}\`：\`${source.path}\` ${source.state === 'missing' ? '缺失' : '变化'}，登记 \`${source.recorded}\` → ${source.current ? `\`${source.current}\`` : '无'}`)),
  '', '处理：在这个版本的源码上逐条核对上列行为；核对后用 `node scripts/maa-version-check.ts reverify --source <源码目录> --version <正式版本号> --entry <条目>` 更新指纹和版本，并按需修改 skill。整个文件有任何改动都算变化，宁可多报，不错误认证。',
  '', '本 issue 由每日 MAA 版本核对自动创建，只含版本、提交、依赖条目和指纹，不含任何用户配置。', '', marker(key)];
  return lines.join('\n') + '\n';
}
function verifiedBody(target: TargetReport, record: RecordFile, key: string): string {
  return [`MAA ${target.tag}（正式版，提交 \`${target.commit}\`）里，本仓库全部 ${target.entries.length} 条依赖条目的源码指纹都没有变化。`,
    '', `这个 PR 把 ${target.version} 加进每条依赖条目和随包核实记录的「源码已核」列表，核实记录版本升到 ${record.recordVersion}。`,
    '', '源码相同不等于实机已核：「实机已核」列表不变，需要在真实 MAA、模拟器和游戏上核对后另行登记。合并之后，setup 和 doctor 会提醒仍在旧版本上的用户可以升级；升级由用户自己在 MAA 里完成。',
    '', '本 PR 由每日 MAA 版本核对自动创建，只改 `docs/maa-dependencies.json` 和 `skills/maa-core/references/verified-versions.json`，不含任何用户配置。', '', marker(key)].join('\n') + '\n';
}

/** The Action entry. Network access is the caller's explicit choice; publishing additionally needs a token. */
export async function runDailyCheck(options: DailyOptions): Promise<DailyReport> {
  const { registry, record, fetcher, token, publish } = options;
  const repository = options.repository ?? '';
  if (publish && (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))) throw new Error('publish-requires-token');
  const github = api(fetcher, token);
  let releases: Release[];
  try { releases = parseReleases(await github.json('GET', `https://api.github.com/repos/${maaRepository}/releases?per_page=${limits.releasesPerPage}`)); }
  catch { throw new Error('release-lookup-failed'); }
  const latestStable = newest(releases.filter(release => !release.prerelease));
  const latestBeta = newest(releases.filter(release => release.prerelease && (!latestStable || compareMaaVersions(release.version, latestStable.version) > 0)));
  const resolveCommit = async (tag: string) => {
    const result = await github.request('GET', `https://api.github.com/repos/${maaRepository}/commits/${encodeURIComponent(tag)}`, undefined, 'application/vnd.github.sha');
    const commit = result.text.trim();
    if (result.status !== 200 || !sha1.test(commit)) throw new Error('commit-lookup-failed');
    return commit;
  };
  const check = async (release: Release): Promise<TargetReport> => {
    const commit = await resolveCommit(release.tag);
    const result = await checkSources(registry, githubSource(commit, fetcher));
    return { version: release.version, tag: release.tag, commit, outcome: result.outcome, entries: result.entries };
  };
  const newestVerified = record.sourceVerified.length ? sortVersions(record.sourceVerified).at(-1)! : null;
  let stableReport: TargetReport | null = null;
  if (latestStable) {
    if (record.sourceVerified.includes(latestStable.version)) stableReport = { version: latestStable.version, tag: latestStable.tag, commit: null, outcome: 'already-verified', entries: [] };
    else if (newestVerified && compareMaaVersions(latestStable.version, newestVerified) < 0) stableReport = { version: latestStable.version, tag: latestStable.tag, commit: null, outcome: 'older-than-record', entries: [] };
    else stableReport = await check(latestStable);
  }
  const betaReport = latestBeta ? await check(latestBeta) : null;

  type Candidate = { kind: ActionReport['kind']; key: string; title: string; body: string; version?: string };
  const candidates: Candidate[] = [];
  if (stableReport?.outcome === 'unchanged') {
    const key = `stable-verified:${stableReport.version}`;
    const next = generateRecord(addSourceVerified(registry, stableReport.version), record);
    candidates.push({ kind: 'pull-request', key, title: `MAA ${stableReport.tag} 源码已核：依赖条目指纹全部未变`, body: verifiedBody(stableReport, next, key), version: stableReport.version });
  } else if (stableReport?.outcome === 'changed') {
    const key = changeKey('stable-change', stableReport);
    candidates.push({ kind: 'issue', key, title: `MAA ${stableReport.tag} 的依赖条目有变化，需要核对`, body: changeBody(stableReport, false, key) });
  }
  if (betaReport?.outcome === 'changed') {
    const key = changeKey('beta-change', betaReport);
    candidates.push({ kind: 'issue', key, title: `提前预警：MAA ${betaReport.tag}（beta）的依赖条目有变化`, body: changeBody(betaReport, true, key) });
  }

  const actions: ActionReport[] = [];
  if (candidates.length) {
    const existing = new Set<string>();
    if (repository) {
      const base = `https://api.github.com/repos/${repository}/issues?state=all&labels=${notificationLabel}&per_page=100&page=`;
      for (let page = 1; ; page++) {
        if (page > limits.notificationPages) throw new Error('notification-list-too-long');
        const items = await github.json('GET', base + page);
        if (!Array.isArray(items)) throw new Error('github-request-failed');
        for (const item of items) if (isObject(item) && typeof item.body === 'string') for (const match of item.body.matchAll(new RegExp(`<!-- ${notificationLabel}:([a-z0-9.:-]+) -->`, 'g'))) existing.add(match[1]!);
        if (items.length < 100) break;
      }
    }
    let labelReady = false;
    const ensureLabel = async () => {
      if (labelReady) return;
      const found = await github.request('GET', `https://api.github.com/repos/${repository}/labels/${notificationLabel}`);
      if (found.status === 404) await github.json('POST', `https://api.github.com/repos/${repository}/labels`, { name: notificationLabel, color: 'c5def5', description: 'Daily MAA version check' });
      else if (found.status !== 200) throw new Error('github-request-failed');
      labelReady = true;
    };
    const publishOne = async (candidate: Candidate, action: ActionReport) => {
        await ensureLabel();
        if (candidate.kind === 'issue') {
          const created = await github.json('POST', `https://api.github.com/repos/${repository}/issues`, { title: candidate.title, body: candidate.body, labels: [notificationLabel] }) as Record<string, unknown>;
          action.url = String(created.html_url);
        } else {
          const branch = `${notificationLabel}/v${candidate.version}`;
          const existingBranch = await github.request('GET', `https://api.github.com/repos/${repository}/git/ref/heads/${branch}`);
          if (existingBranch.status === 200) {
            // Only an existing PR (open or closed) counts as notified. A branch without one is left by a run whose PR was refused
            // (for example while Actions may not open PRs) or whose file update failed: it is completed and the PR opened again,
            // and any failure fails the run, so it retries daily until the PR exists.
            const owner = repository.split('/')[0]!;
            const pulls = await github.json('GET', `https://api.github.com/repos/${repository}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=100`);
            if (!Array.isArray(pulls)) throw new Error('github-request-failed');
            const pull = pulls.find((item): item is Record<string, unknown> => isObject(item) && Number.isSafeInteger(item.number));
            if (pull) {
              const labelled = Array.isArray(pull.labels) && pull.labels.some(label => isObject(label) && label.name === notificationLabel);
              if (!labelled) await github.json('POST', `https://api.github.com/repos/${repository}/issues/${pull.number}/labels`, { labels: [notificationLabel] });
              action.state = 'already-notified'; action.url = String(pull.html_url); return;
            }
          } else if (existingBranch.status === 404) {
            let base = options.baseCommit;
            if (base === undefined) {
              const main = await github.json('GET', `https://api.github.com/repos/${repository}/git/ref/heads/main`) as { object?: { sha?: unknown } };
              base = typeof main?.object?.sha === 'string' ? main.object.sha : '';
            }
            if (!sha1.test(base)) throw new Error('github-request-failed');
            await github.json('POST', `https://api.github.com/repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha: base });
          } else throw new Error('github-request-failed');
          const nextRegistry = addSourceVerified(registry, candidate.version!);
          const files = [[registryPath, JSON.stringify(nextRegistry, null, 2) + '\n'], [recordPath, JSON.stringify(generateRecord(nextRegistry, record), null, 2) + '\n']] as const;
          // Each file on the branch must equal what this run commits; only a differing file is written.
          for (const [path, content] of files) {
            const current = await github.json('GET', `https://api.github.com/repos/${repository}/contents/${path}?ref=${encodeURIComponent(branch)}`) as { sha?: unknown };
            if (typeof current?.sha !== 'string') throw new Error('github-request-failed');
            if (current.sha === gitBlobSha(Buffer.from(content))) continue;
            await github.json('PUT', `https://api.github.com/repos/${repository}/contents/${path}`,
              { message: `chore(maa-version): mark MAA ${candidate.version} source-verified`, content: Buffer.from(content).toString('base64'), sha: current.sha, branch });
          }
          const pull = await github.json('POST', `https://api.github.com/repos/${repository}/pulls`, { title: candidate.title, head: branch, base: 'main', body: candidate.body }) as Record<string, unknown>;
          if (!Number.isSafeInteger(pull.number)) throw new Error('github-request-failed');
          await github.json('POST', `https://api.github.com/repos/${repository}/issues/${pull.number}/labels`, { labels: [notificationLabel] });
          action.url = String(pull.html_url);
        }
        action.state = 'created';
    };
    // Each notification is published on its own: a refused PR (for example while Actions may not open PRs) does not hold back
    // an issue, which needs only issue permissions. Any failure still fails the run afterwards, so it is retried the next day.
    let failed = false;
    for (const candidate of candidates) {
      const action: ActionReport = { kind: candidate.kind, key: candidate.key, title: candidate.title, state: 'planned' };
      if (existing.has(candidate.key)) action.state = 'already-notified';
      else if (publish) {
        try { await publishOne(candidate, action); } catch { failed = true; }
      }
      actions.push(action);
    }
    if (failed) throw new Error('github-request-failed');
  }
  return { checkedAt: (options.now ?? new Date()).toISOString(), stable: stableReport, beta: betaReport, actions };
}

async function writeAtomic(file: string, content: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o644);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}

const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  const emit = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const args = process.argv.slice(2), action = args[0] ?? '';
  const option = (name: string) => { const index = args.indexOf(name); return index > 0 ? args[index + 1] : undefined; };
  const values = (name: string) => args.flatMap((arg, index) => arg === name && args[index + 1] ? [args[index + 1]!] : []);
  const safe = new Set(['online-flag-required', 'publish-requires-token', 'usage', 'registry-invalid', 'record-invalid', 'version-not-stable', 'entry-unknown', 'source-missing']);
  try {
    const registryFile = option('--registry') ?? join(repositoryRoot, registryPath), recordFile = option('--record') ?? join(repositoryRoot, recordPath);
    if (action === 'verify') {
      const source = option('--source'); if (!source) throw new Error('usage');
      const result = await checkSources(await readRegistry(registryFile), directorySource(source));
      emit(result); process.exitCode = result.outcome === 'unchanged' ? 0 : 1;
    } else if (action === 'record') {
      const record = generateRecord(await readRegistry(registryFile), await readRecord(recordFile));
      if (args.includes('--write')) await writeAtomic(recordFile, JSON.stringify(record, null, 2) + '\n');
      emit(record);
    } else if (action === 'notes') {
      process.stdout.write(releaseNotes(await readRecord(recordFile)));
    } else if (action === 'reverify') {
      const source = option('--source'), version = option('--version'), ids = values('--entry');
      if (!source || !version) throw new Error('usage');
      const updated = await reverifyEntries(await readRegistry(registryFile), ids, version, directorySource(source));
      const record = generateRecord(updated, await readRecord(recordFile));
      await writeAtomic(registryFile, JSON.stringify(updated, null, 2) + '\n'); await writeAtomic(recordFile, JSON.stringify(record, null, 2) + '\n');
      emit({ status: 'updated', entries: ids, version, record });
    } else if (action === 'daily') {
      if (!args.includes('--online')) throw new Error('online-flag-required');
      const publish = args.includes('--publish'), token = process.env.GITHUB_TOKEN || undefined;
      if (publish && (!token || !process.env.GITHUB_REPOSITORY)) throw new Error('publish-requires-token');
      const report = await runDailyCheck({ registry: await readRegistry(registryFile), record: await readRecord(recordFile), fetcher: fetch, token, publish,
        ...(process.env.GITHUB_REPOSITORY ? { repository: process.env.GITHUB_REPOSITORY } : {}),
        ...(sha1.test(process.env.GITHUB_SHA ?? '') ? { baseCommit: process.env.GITHUB_SHA } : {}) });
      emit(report);
    } else throw new Error('usage');
  } catch (error) {
    // Static reasons only: no request body, header, token or raw error text is printed.
    const reason = error instanceof Error && (safe.has(error.message) || /^[a-z-]+$/.test(error.message) && error.message.endsWith('-failed')) ? error.message : 'check-failed';
    emit({ status: safe.has(reason) ? 'rejected' : 'failed', reason });
    process.exitCode = safe.has(reason) ? 1 : 2;
  }
}
