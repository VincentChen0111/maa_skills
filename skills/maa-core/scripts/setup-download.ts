import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { readSettings, settingsHome } from './preferences.ts';

/**
 * Program downloads for maa-setup. Every download needs a plan shown to the user and a confirmation of
 * that one plan; a plan is used at most once. Only the network (fetch) and the archive tool are system
 * boundaries; tests replace them. Nothing here writes settings or MAA configuration.
 */
export type Program = 'maa' | 'node' | 'adb' | 'emulator';
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export interface ArchiveBoundary { extract(archive: string, target: string): Promise<{ exitCode: number; timedOut?: boolean }> }
export type DownloadContext = { home?: string; arch?: string; fetch?: Fetcher; inactivityMs?: number; archive?: ArchiveBoundary };
export type Checksum = { algorithm: 'sha256' | 'sha1'; value: string };
export type Step = { id: string; executor: 'skill' | 'user'; description: string };
type Release = { program: Program; vendor: string | null; fileName: string; version: string; versionSource: string; url: string;
  officialPage: string; publisher: string; size: number | null; checksum: Checksum | null; terms: string | null };

const githubAssetHosts = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
/** Official release locations; see docs/setup-sources.md for how each was verified. */
export const officialSources = {
  maa: { publisher: 'MaaAssistantArknights', officialPage: 'https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases',
    index: 'https://api.github.com/repos/MaaAssistantArknights/MaaAssistantArknights/releases/latest', indexHosts: ['api.github.com'],
    downloadPrefix: 'https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases/download/', hosts: githubAssetHosts },
  node: { publisher: 'Node.js', officialPage: 'https://nodejs.org/en/download', index: 'https://nodejs.org/dist/index.json', indexHosts: ['nodejs.org'],
    downloadPrefix: 'https://nodejs.org/dist/', hosts: ['nodejs.org'] },
  adb: { publisher: 'Google (Android SDK Platform-Tools)', officialPage: 'https://developer.android.com/tools/releases/platform-tools',
    index: 'https://dl.google.com/android/repository/repository2-1.xml', indexHosts: ['dl.google.com'],
    downloadPrefix: 'https://dl.google.com/android/repository/', hosts: ['dl.google.com'], terms: 'https://developer.android.com/studio/terms' },
} as const;
/**
 * One recorded official download chain, verified read-only (HEAD, no redirect following) and listed in
 * docs/setup-sources.md: the start address the vendor's official page uses, then the host of every redirect hop
 * in order, the last one serving the file. An empty `hops` means the start address serves the file itself.
 */
export type DownloadChain = { start: string; hops: string[] };
/**
 * The single source of truth for emulator downloads: fully supported emulators from MAA's Windows emulator page.
 * Every plan, HEAD and download hop is checked only against this table: the vendor's official site `domains`
 * (subdomains included) and the exact hosts of its recorded `chains` (no subdomains).
 */
export const emulatorVendors: Record<string, { name: string; officialPage: string; domains: string[]; chains: DownloadChain[] }> = {
  mumu: { name: 'MuMu 模拟器', officialPage: 'https://mumu.163.com/', domains: ['mumu.163.com'],
    chains: [{ start: 'https://mumu.nie.netease.com/api/dl/win', hops: ['a11.gdl.netease.com'] }] },
  ldplayer: { name: '雷电模拟器', officialPage: 'https://www.ldmnq.com/', domains: ['ldmnq.com'],
    chains: [{ start: 'https://lddl01.ldmnq.com/downloader/ldplayerinst14.exe', hops: [] }, { start: 'https://lddl01.ldmnq.com/downloader/ldplayerinst9.exe?n=ldplayer9_ld_412572_ld.exe', hops: [] }] },
  'bluestacks-cn': { name: '蓝叠模拟器 5', officialPage: 'https://www.bluestacks.cn/', domains: ['bluestacks.cn'],
    chains: [{ start: 'https://aliosscdn1.bluestacks.cn/BSLive/BlueStacksMicroInstaller.exe', hops: [] }] },
  bluestacks: { name: '蓝叠模拟器 5 国际版', officialPage: 'https://www.bluestacks.com/tw/index.html', domains: ['bluestacks.com'],
    chains: [{ start: 'https://cloud.bluestacks.com/api/getdownloadnow?platform=win', hops: ['ak-build.bluestacks.com'] }] },
  nox: { name: '夜神模拟器', officialPage: 'https://www.yeshen.com/', domains: ['yeshen.com'],
    chains: ['win_64?formal', 'win_64_9?formal'].map(path => ({ start: `https://www.yeshen.com/cn/download/fullPackage/${path}`, hops: ['res06.bignox.com'] }))
      .concat({ start: 'https://www.yeshen.com/cn/download/fullPackage?formal', hops: ['res06.bignox.com'] }) },
  memu: { name: '逍遥模拟器', officialPage: 'https://www.xyaz.cn/', domains: ['xyaz.cn'],
    chains: [{ start: 'https://www.xyaz.cn/download.php?file_name=XYAZ-Installer', hops: ['download.microvirt.com'] }] },
};
/** Exact hosts a vendor's downloads may touch besides its official site domains: start and hop hosts of its chains. */
export function vendorHosts(vendor: { chains: DownloadChain[] }) {
  return [...new Set(vendor.chains.flatMap(chain => [new URL(chain.start).hostname, ...chain.hops]))];
}

// Limits registered in docs/spec.md (默认值及其来源, 08 rows).
const indexLimit = 8 * 1024 * 1024;
const requestTimeoutMs = 30_000; // each index read and each HEAD request
const extractTimeoutMs = 600_000;
const referenceLimit = 2000;
const urlLimit = 2048;
const unknownSizeLimit = 4 * 1024 * 1024 * 1024;
const maxRedirects = 5;
const userAgent = 'maa-skills-setup';
/** Reasons that may be shown to the user; everything else is reported as an unexpected failure. */
export class DownloadError extends Error {}
const fail = (reason: string): never => { throw new DownloadError(reason); };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('source-response-invalid');
  return value as Record<string, unknown>;
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
function architecture(value: string = process.arch) { return value === 'arm64' ? 'arm64' : value === 'x64' ? 'x64' : fail('architecture-unsupported'); }
function allowedHost(url: URL, hosts: readonly string[], domains: readonly string[] = []) {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443')
    && (hosts.includes(host) || domains.some(domain => host === domain || host.endsWith(`.${domain}`)));
}
function parseUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > urlLimit) return fail('unofficial-source');
  try { return new URL(value); } catch { return fail('unofficial-source'); }
}

/** Follows at most five redirects itself so that every hop is checked against the official hosts. */
async function request(fetcher: Fetcher, start: string, method: 'GET' | 'HEAD', allowed: (url: URL) => boolean, signal: AbortSignal, accept?: string) {
  let current = start;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!allowed(new URL(current))) fail('unofficial-source');
    let response: Response;
    try { response = await fetcher(current, { method, redirect: 'manual', signal, headers: { 'User-Agent': userAgent, ...(accept ? { Accept: accept } : {}) } }); }
    catch { return fail('source-unavailable'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) fail('source-response-invalid');
      try { current = new URL(location!, current).href; } catch { fail('unofficial-source'); }
      continue;
    }
    return { response, url: current };
  }
  return fail('too-many-redirects');
}
async function text(fetcher: Fetcher, url: string, hosts: readonly string[], accept?: string) {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  const { response } = await request(fetcher, url, 'GET', candidate => allowedHost(candidate, hosts), signal, accept);
  if (response.status !== 200 || !response.body) { await response.body?.cancel().catch(() => undefined); return fail('source-unavailable'); }
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength; if (total > indexLimit) fail('source-response-invalid');
      chunks.push(chunk);
    }
  } catch (error) { if (error instanceof DownloadError) throw error; fail('source-unavailable'); }
  return Buffer.concat(chunks).toString('utf8');
}
function contentLength(response: Response) {
  const value = response.headers.get('content-length');
  return value !== null && /^\d{1,15}$/.test(value) && Number(value) > 0 ? Number(value) : null;
}
function semver(value: string) { return value.replace(/^v/, '').split('.').map(Number); }
function newer(a: string, b: string) {
  const [x, y] = [semver(a), semver(b)];
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index]! > y[index]!;
  return false;
}

async function resolveMaa(fetcher: Fetcher, arch: string): Promise<Release> {
  const source = officialSources.maa;
  let data: Record<string, unknown>;
  try { data = object(JSON.parse(await text(fetcher, source.index, source.indexHosts, 'application/vnd.github+json'))); }
  catch (error) { if (error instanceof DownloadError) throw error; return fail('source-response-invalid'); }
  const tag = data.tag_name;
  if (data.draft !== false || data.prerelease !== false || typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag) || !Array.isArray(data.assets)) fail('source-response-invalid');
  const fileName = `MAA-${tag}-win-${arch}.zip`;
  const asset = (data.assets as unknown[]).map(object).find(item => item.name === fileName);
  if (!asset) return fail('release-file-missing');
  const url = `${source.downloadPrefix}${tag}/${fileName}`;
  if (asset.browser_download_url !== url) fail('unofficial-source');
  const digest = typeof asset.digest === 'string' ? /^sha256:([a-f0-9]{64})$/.exec(asset.digest)?.[1] : undefined;
  return { program: 'maa', vendor: null, fileName, version: (tag as string).slice(1), versionSource: 'github-latest-release', url, officialPage: source.officialPage,
    publisher: source.publisher, size: Number.isSafeInteger(asset.size) && (asset.size as number) > 0 ? asset.size as number : null,
    checksum: digest ? { algorithm: 'sha256', value: digest } : null, terms: null };
}

async function resolveNode(fetcher: Fetcher, arch: string): Promise<Release> {
  const source = officialSources.node;
  let list: unknown;
  try { list = JSON.parse(await text(fetcher, source.index, source.indexHosts)); }
  catch (error) { if (error instanceof DownloadError) throw error; return fail('source-response-invalid'); }
  if (!Array.isArray(list)) return fail('source-response-invalid');
  let version: string | undefined;
  for (const entry of list) {
    const value = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).version : undefined;
    if (typeof value === 'string' && /^v24\.\d{1,4}\.\d{1,4}$/.test(value) && (!version || newer(value, version))) version = value;
  }
  if (!version) return fail('release-file-missing');
  const fileName = `node-${version}-${arch}.msi`;
  const url = `${source.downloadPrefix}${version}/${fileName}`;
  const sums = await text(fetcher, `${source.downloadPrefix}${version}/SHASUMS256.txt`, source.hosts);
  const line = sums.split(/\r?\n/).map(item => /^([a-f0-9]{64}) {2}(\S+)$/.exec(item)).find(match => match?.[2] === fileName);
  if (!line) return fail('release-file-missing');
  const { response } = await request(fetcher, url, 'HEAD', candidate => allowedHost(candidate, source.hosts), AbortSignal.timeout(requestTimeoutMs));
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 404) fail('release-file-missing');
  return { program: 'node', vendor: null, fileName, version: version.slice(1), versionSource: 'nodejs-dist-index', url, officialPage: source.officialPage,
    publisher: source.publisher, size: response.ok ? contentLength(response) : null, checksum: { algorithm: 'sha256', value: line[1]! }, terms: null };
}

async function resolveAdb(fetcher: Fetcher): Promise<Release> {
  const source = officialSources.adb;
  const xml = await text(fetcher, source.index, source.indexHosts);
  // Narrow extraction from Google's SDK repository index; any ambiguity fails closed.
  const stable = (xml.match(/<remotePackage\s+path="platform-tools">[\s\S]*?<\/remotePackage>/g) ?? [])
    .filter(block => /<channelRef\s+ref="channel-0"\s*\/>/.test(block));
  if (stable.length !== 1) return fail('source-response-invalid');
  const block = stable[0]!;
  const revision = /<revision>\s*<major>(\d{1,4})<\/major>\s*(?:<minor>(\d{1,4})<\/minor>\s*)?(?:<micro>(\d{1,4})<\/micro>\s*)?/.exec(block);
  const archives = (block.match(/<archive>[\s\S]*?<\/archive>/g) ?? []).filter(item => /<host-os>\s*windows\s*<\/host-os>/.test(item));
  if (!revision || archives.length !== 1) return fail('source-response-invalid');
  const archive = archives[0]!;
  const size = /<size>(\d{1,15})<\/size>/.exec(archive)?.[1];
  const checksum = /<checksum(?:\s+type="sha1")?>([a-f0-9]{40})<\/checksum>/.exec(archive)?.[1];
  const fileName = /<url>(platform-tools_r\d{1,4}(?:\.\d{1,4}){0,2}-win(?:dows)?\.zip)<\/url>/.exec(archive)?.[1];
  if (!fileName) return fail('source-response-invalid');
  return { program: 'adb', vendor: null, fileName, version: [revision[1], revision[2] ?? '0', revision[3] ?? '0'].join('.'), versionSource: 'android-sdk-repository-stable',
    url: `${source.downloadPrefix}${fileName}`, officialPage: source.officialPage, publisher: source.publisher, size: size && Number(size) > 0 ? Number(size) : null,
    checksum: checksum ? { algorithm: 'sha1', value: checksum } : null, terms: source.terms };
}

function dispositionName(header: string | null) {
  if (!header) return undefined;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) try { return decodeURIComponent(encoded.trim()); } catch { return undefined; }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim();
}
const safeFileName = (value: string | undefined) => value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._()+-]{0,127}\.(?:exe|msi|zip)$/i.test(value) ? value : undefined;

async function resolveEmulator(fetcher: Fetcher, vendorId: unknown, link: unknown, version: unknown): Promise<Release> {
  if (typeof vendorId !== 'string' || !Object.hasOwn(emulatorVendors, vendorId)) return fail('emulator-vendor-unsupported');
  const vendor = emulatorVendors[vendorId]!;
  const url = parseUrl(link);
  if (!allowedHost(url, vendorHosts(vendor), vendor.domains)) fail('unofficial-source');
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(version)) fail('version-required');
  const { response, url: final } = await request(fetcher, url.href, 'HEAD', candidate => allowedHost(candidate, vendorHosts(vendor), vendor.domains), AbortSignal.timeout(requestTimeoutMs));
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 404) fail('release-file-missing');
  let fromPath: string | undefined;
  try { fromPath = decodeURIComponent(new URL(final).pathname.split('/').pop() ?? ''); } catch { fromPath = undefined; }
  // The final path name comes first: it is part of the official address and stays the same between the plan and the
  // download, while some vendors (MuMu) put a fresh random name in Content-Disposition on every request.
  const fileName = safeFileName(fromPath) ?? safeFileName(response.ok ? dispositionName(response.headers.get('content-disposition')) : undefined);
  if (!fileName) return fail('file-name-unknown');
  return { program: 'emulator', vendor: vendorId, fileName, version: version as string, versionSource: 'official-page-stated', url: url.href,
    officialPage: vendor.officialPage, publisher: vendor.name, size: response.ok ? contentLength(response) : null, checksum: null, terms: null };
}

async function resolve_(request: Record<string, unknown>, context: DownloadContext): Promise<Release> {
  const fetcher = context.fetch ?? globalThis.fetch;
  switch (request.program) {
    case 'maa': return resolveMaa(fetcher, architecture(context.arch));
    case 'node': return resolveNode(fetcher, architecture(context.arch));
    case 'adb': return resolveAdb(fetcher);
    case 'emulator': return resolveEmulator(fetcher, request.vendor, request.url, request.version);
    default: return fail('program-unsupported');
  }
}
const fingerprint = (planId: string, release: Release) => sha256(JSON.stringify([planId, release.program, release.vendor, release.fileName, release.version,
  release.url, release.size, release.checksum, release.terms]));

const stepText: Record<string, string> = {
  'accept-terms': 'Read the Android SDK License Agreement and accept it yourself before this download; the skill never accepts terms for you.',
  download: 'Download this one file from the official source after you confirm this plan.',
  verify: 'Check the downloaded size and the official checksum when one is published; a mismatch keeps nothing.',
  'extract-maa': 'Extract the archive into an empty folder you choose, outside folders that need administrator rights, such as a drive root or Program Files.',
  'maa-dependencies': 'Run DependencySetup_依赖库安装.bat in the MAA folder as administrator to install the Visual C++ runtime.',
  'maa-first-run': 'Start MAA.exe and finish its first-run setup in the MAA window, selecting the CN Official or Bilibili client.',
  'save-maa-directory': 'Save the MAA folder through the preferences script; settings are not written by the download.',
  'extract-adb': 'Extract the archive into an empty folder you choose; the MAA folder\'s adb subfolder is found automatically.',
  'connect-adb': 'Discover and test the connection with this adb, then save it through setup apply after your closed-MAA confirmation.',
  'run-node-installer': 'Run the Node installer yourself, accept its license and finish the wizard; it may ask for administrator rights.',
  'reopen-terminal': 'Open a new terminal or restart the agent so that the new node is on PATH.',
  'run-emulator-installer': 'Run the emulator installer yourself and accept its terms in the installer window.',
  'emulator-first-run': 'Start the emulator and enable its adb connection setting if the vendor requires it.',
  'game-client': 'Install the CN game client in the emulator and log in yourself; the skill never enters a game account or operates the device.',
  recheck: 'Recheck Node, MAA, adb and the connection, then update the environment record.',
};
const programSteps: Record<Program, [string, Step['executor']][]> = {
  maa: [['download', 'skill'], ['verify', 'skill'], ['extract-maa', 'skill'], ['maa-dependencies', 'user'], ['maa-first-run', 'user'], ['save-maa-directory', 'skill'], ['recheck', 'skill']],
  node: [['download', 'skill'], ['verify', 'skill'], ['run-node-installer', 'user'], ['reopen-terminal', 'user'], ['recheck', 'skill']],
  adb: [['accept-terms', 'user'], ['download', 'skill'], ['verify', 'skill'], ['extract-adb', 'skill'], ['connect-adb', 'skill'], ['recheck', 'skill']],
  emulator: [['download', 'skill'], ['run-emulator-installer', 'user'], ['emulator-first-run', 'user'], ['game-client', 'user'], ['connect-adb', 'skill'], ['recheck', 'skill']],
};
export const stepsFor = (program: Program): Step[] => programSteps[program].map(([id, executor]) => ({ id, executor, description: stepText[id]! }));
const remainingSteps = (program: Program, after: string) => { const steps = stepsFor(program); return steps.slice(steps.findIndex(step => step.id === after) + 1); };
/** Steps still open once a download is verified, or once its archive is extracted. */
function nextSteps(program: Program, state: 'downloaded' | 'extracted') {
  return remainingSteps(program, state === 'extracted' ? (program === 'maa' ? 'extract-maa' : 'extract-adb') : program === 'emulator' ? 'download' : 'verify');
}

function planView(release: Release, planId: string) {
  return { planId, fingerprint: fingerprint(planId, release), program: release.program, vendor: release.vendor, fileName: release.fileName, version: release.version,
    versionSource: release.versionSource, publisher: release.publisher, officialPage: release.officialPage, source: release.url, size: release.size,
    sizeKnown: release.size !== null, checksum: release.checksum, terms: release.terms ? { url: release.terms, acceptanceRequired: true } : null,
    steps: stepsFor(release.program) };
}

type DownloadRecord = { schemaVersion: 1; planId: string; program: Program; vendor: string | null; fileName: string; version: string; versionSource?: string; source: string; officialPage?: string;
  size: number | null; checksum: Checksum | null; confirmation: { reference: string; termsAccepted: boolean }; status: 'downloading' | 'downloaded' | 'failed';
  reason?: string; pid: number; startedAt: string; finishedAt?: string; bytes?: number; sha256?: string;
  install?: { status: 'extracted' | 'failed'; reason?: string; target?: string; at: string } };
const planPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function locations(context: DownloadContext) {
  const home = resolve(context.home ?? settingsHome());
  try { if (!(await stat(join(home, 'config.json'))).isFile()) fail('set-preferences-first'); }
  catch (error) { if (error instanceof DownloadError) throw error; fail('set-preferences-first'); }
  const settings = await readSettings(home);
  const downloads = join(settings.privateDirectory, 'downloads');
  return { settings, downloads, records: join(downloads, 'records') };
}
/** Only well-formed records are used; a file name can never point outside the downloads folder. */
async function readRecord(file: string, planId: string): Promise<DownloadRecord | undefined> {
  let value: DownloadRecord;
  try { value = JSON.parse(await readFile(file, 'utf8')) as DownloadRecord; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
  return value && typeof value === 'object' && value.schemaVersion === 1 && value.planId === planId && ['maa', 'node', 'adb', 'emulator'].includes(value.program)
    && typeof value.fileName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._()+-]{0,127}$/.test(value.fileName) ? value : undefined;
}
async function exists(file: string) { try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function saveRecord(records: string, record: DownloadRecord) {
  const temporary = join(records, `.${record.planId}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(records, `${record.planId}.json`));
}
async function digest(file: string, algorithm: 'sha256' | 'sha1') {
  const hash = createHash(algorithm); let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).byteLength; }
  return { value: hash.digest('hex'), bytes };
}
/** Re-verifies the file on disk; the record alone never proves a download. */
async function verifiedFile(downloads: string, record: DownloadRecord) {
  if (record.status !== 'downloaded' || !record.sha256) return false;
  try {
    const actual = await digest(join(downloads, record.fileName), 'sha256');
    return actual.value === record.sha256 && actual.bytes === record.bytes;
  } catch { return false; }
}
function alive(pid: number) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
async function allRecords(records: string) {
  let names: string[];
  try { names = await readdir(records); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result: DownloadRecord[] = [];
  for (const name of names.filter(item => /^[0-9a-f-]{36}\.json$/.test(item)).sort()) {
    const record = await readRecord(join(records, name), name.slice(0, -5));
    if (record) result.push(record);
  }
  return result;
}

/** Read-only except for network reads of official release indexes. A plan writes nothing. */
export async function planDownload(input: unknown, context: DownloadContext = {}) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : fail('request-invalid');
  if (Object.keys(body).some(key => !['program', 'vendor', 'url', 'version'].includes(key))
    || body.program !== 'emulator' && ['vendor', 'url', 'version'].some(key => body[key] !== undefined)) fail('request-invalid');
  const { downloads, records } = await locations(context);
  const release = await resolve_(body, context);
  for (const record of await allRecords(records)) {
    if (record.program === release.program && record.fileName === release.fileName && record.version === release.version && record.source === release.url
      && await verifiedFile(downloads, record)) {
      return { status: 'already-downloaded', planId: record.planId, program: record.program, fileName: record.fileName, version: record.version,
        install: record.install?.status ?? null, next: nextSteps(release.program, record.install?.status === 'extracted' ? 'extracted' : 'downloaded') };
    }
  }
  return { status: 'planned', ...planView(release, randomUUID()), confirmation: 'required-for-this-plan-only' };
}

/** Downloads exactly one confirmed plan. The plan identifier is consumed before any byte is requested. */
export async function executeDownload(input: unknown, context: DownloadContext = {}) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : fail('request-invalid');
  if (Object.keys(body).some(key => !['program', 'planId', 'fingerprint', 'reference', 'termsAccepted', 'vendor', 'url', 'version'].includes(key))
    || typeof body.planId !== 'string' || !planPattern.test(body.planId) || typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint)
    || body.termsAccepted !== undefined && typeof body.termsAccepted !== 'boolean'
    || body.program !== 'emulator' && ['vendor', 'url', 'version'].some(key => body[key] !== undefined)) fail('request-invalid');
  if (typeof body.reference !== 'string' || !body.reference.trim() || body.reference.length > referenceLimit) return { status: 'rejected', reason: 'confirmation-required' };
  const planId = body.planId as string;
  const { downloads, records } = await locations(context);
  if (await exists(join(records, `${planId}.json`))) return { status: 'rejected', reason: 'plan-already-used' };
  const release = await resolve_(body, context);
  if (fingerprint(planId, release) !== body.fingerprint) return { status: 'rejected', reason: 'plan-changed' };
  if (release.terms && body.termsAccepted !== true) return { status: 'rejected', reason: 'terms-acceptance-required' };
  await mkdir(records, { recursive: true });
  // A download whose process is gone can never finish; its partial file is only reclaimed space. Its record stays as evidence.
  for (const stale of await allRecords(records)) if (stale.status === 'downloading' && !alive(stale.pid)) await rm(join(downloads, `.${stale.planId}.partial`), { force: true });
  const record: DownloadRecord = { schemaVersion: 1, planId, program: release.program, vendor: release.vendor, fileName: release.fileName, version: release.version,
    versionSource: release.versionSource, source: release.url, officialPage: release.officialPage, size: release.size, checksum: release.checksum, confirmation: { reference: body.reference.trim(), termsAccepted: body.termsAccepted === true },
    status: 'downloading', pid: process.pid, startedAt: new Date().toISOString() };
  // Exclusive creation is the single use of this plan: a second request for the same plan cannot pass.
  try { await writeFile(join(records, `${planId}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'rejected', reason: 'plan-already-used' }; throw error; }
  const partial = join(downloads, `.${planId}.partial`);
  try {
    const result = await transfer(release, partial, context);
    await rename(partial, join(downloads, release.fileName));
    await saveRecord(records, { ...record, status: 'downloaded', finishedAt: new Date().toISOString(), bytes: result.bytes, sha256: result.sha256 });
    return { status: 'downloaded', planId, program: release.program, fileName: release.fileName, version: release.version, size: result.bytes,
      checksumVerified: release.checksum !== null, next: nextSteps(release.program, 'downloaded') };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    const reason = error instanceof DownloadError ? error.message : 'download-failed';
    await saveRecord(records, { ...record, status: 'failed', reason, finishedAt: new Date().toISOString() });
    return { status: 'failed', reason, planId, program: release.program, fileName: release.fileName };
  }
}

async function transfer(release: Release, partial: string, context: DownloadContext) {
  const fetcher = context.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const inactivity = context.inactivityMs ?? 60_000;
  let timer = setTimeout(() => controller.abort(), inactivity);
  const hosts = release.program === 'emulator' ? vendorHosts(emulatorVendors[release.vendor!]!) : officialSources[release.program].hosts;
  const domains = release.program === 'emulator' ? emulatorVendors[release.vendor!]!.domains : [];
  try {
    const { response } = await request(fetcher, release.url, 'GET', url => allowedHost(url, hosts, domains), controller.signal);
    if (response.status !== 200 || !response.body) { await response.body?.cancel().catch(() => undefined); fail('source-unavailable'); }
    const announced = contentLength(response);
    if (release.size !== null && announced !== null && announced !== release.size) { await response.body!.cancel().catch(() => undefined); fail('size-mismatch'); }
    const limit = release.size ?? unknownSizeLimit;
    const sha = createHash('sha256'); const expected = release.checksum?.algorithm === 'sha1' ? createHash('sha1') : undefined;
    const handle = await open(partial, 'wx', 0o600); let bytes = 0;
    try {
      const reader = response.body!.getReader();
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); } catch { return fail('download-interrupted'); }
        if (chunk.done) break;
        clearTimeout(timer); timer = setTimeout(() => controller.abort(), inactivity);
        bytes += chunk.value.byteLength;
        if (bytes > limit) { await reader.cancel().catch(() => undefined); fail('size-mismatch'); }
        sha.update(chunk.value); expected?.update(chunk.value);
        await handle.write(chunk.value);
      }
    } finally { await handle.close(); }
    if (release.size !== null && bytes !== release.size) fail('size-mismatch');
    const sha256Value = sha.digest('hex');
    const actual = release.checksum?.algorithm === 'sha1' ? expected!.digest('hex') : sha256Value;
    if (release.checksum && actual !== release.checksum.value) fail('checksum-mismatch');
    return { bytes, sha256: sha256Value };
  } finally { clearTimeout(timer); }
}

/** Fresh status: files are re-hashed, and a download whose process is gone is reported as interrupted. */
export async function downloadStatus(context: DownloadContext = {}) {
  const { downloads, records } = await locations(context);
  const items = [];
  for (const record of await allRecords(records)) {
    let status: string = record.status;
    if (record.status === 'downloading') status = alive(record.pid) ? 'in-progress' : 'interrupted';
    else if (record.status === 'downloaded' && !await verifiedFile(downloads, record)) status = 'download-invalid';
    let install: string | null = record.install?.status ?? null;
    if (install === 'extracted' && !(record.install?.target && await present(record.install.target, record.program))) install = 'extract-missing';
    items.push({ planId: record.planId, program: record.program, vendor: record.vendor, fileName: record.fileName, version: record.version, status,
      ...(record.reason ? { reason: record.reason } : {}), install });
  }
  return { items };
}

const expectedExecutable: Partial<Record<Program, string>> = { maa: 'MAA.exe', adb: 'platform-tools/adb.exe' };
async function present(target: string, program: Program) {
  const executable = expectedExecutable[program];
  if (!executable) return false;
  try { return (await stat(join(target, executable))).isFile(); } catch { return false; }
}
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || !!path && !path.startsWith('..') && !isAbsolute(path);
};
const systemArchive: ArchiveBoundary = { extract: async (archive, target) => new Promise(resolveResult => {
  if (process.platform !== 'win32' || !process.env.SystemRoot) { resolveResult({ exitCode: 1 }); return; }
  // Windows' bsdtar refuses absolute and '..' entry paths by default.
  execFile(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archive, '-C', target], { windowsHide: true, timeout: extractTimeoutMs, maxBuffer: 1024 * 1024 },
    error => resolveResult({ exitCode: error ? 1 : 0, timedOut: error?.killed === true }));
}) };

/** Performs only the skill's own install step (archive extraction); installers and first runs stay with the user. */
export async function installDownload(input: unknown, context: DownloadContext = {}) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : fail('request-invalid');
  if (Object.keys(body).some(key => !['planId', 'target'].includes(key)) || typeof body.planId !== 'string' || !planPattern.test(body.planId)
    || body.target !== undefined && (typeof body.target !== 'string' || !isAbsolute(body.target) || body.target.length > 32767)) fail('request-invalid');
  const { settings, downloads, records } = await locations(context);
  const record = await readRecord(join(records, `${body.planId}.json`), body.planId as string);
  if (!record) return { status: 'rejected', reason: 'download-unknown' };
  if (!await verifiedFile(downloads, record)) return { status: 'rejected', reason: 'download-not-verified' };
  if (record.program === 'node' || record.program === 'emulator') {
    return { status: 'user-steps', program: record.program, fileName: record.fileName, steps: nextSteps(record.program, 'downloaded') };
  }
  if (record.install?.status === 'extracted' && record.install.target && await present(record.install.target, record.program)) {
    return { status: 'already-extracted', program: record.program, steps: nextSteps(record.program, 'extracted') };
  }
  if (typeof body.target !== 'string') return { status: 'rejected', reason: 'target-required' };
  const target = resolve(body.target);
  const elevated = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432, process.env.SystemRoot].filter((item): item is string => !!item);
  if (parse(target).root === target || elevated.some(item => inside(resolve(item), target))) {
    return { status: 'rejected', reason: 'target-requires-elevation' };
  }
  if (inside(resolve(settings.privateDirectory), target) || inside(target, resolve(settings.privateDirectory))) return { status: 'rejected', reason: 'target-overlaps-private-directory' };
  let created = false;
  try {
    const entries = await readdir(target);
    if (entries.length) return { status: 'rejected', reason: 'target-not-empty' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return { status: 'rejected', reason: 'target-not-empty' };
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(target, { recursive: true }); created = true;
  }
  const archive = context.archive ?? systemArchive;
  let result: { exitCode: number; timedOut?: boolean };
  try { result = await archive.extract(join(downloads, record.fileName), target); } catch { result = { exitCode: 1 }; }
  const at = new Date().toISOString();
  if (result.exitCode !== 0 || !await present(target, record.program)) {
    // The target was absent or empty before this step, so everything in it came from this extraction.
    if (created) await rm(target, { recursive: true, force: true });
    else for (const entry of await readdir(target)) await rm(join(target, entry), { recursive: true, force: true });
    const reason = result.timedOut ? 'extract-timeout' : 'extract-failed';
    await saveRecord(records, { ...record, install: { status: 'failed', reason, at } });
    return { status: 'failed', reason, program: record.program };
  }
  await saveRecord(records, { ...record, install: { status: 'extracted', target, at } });
  return { status: 'extracted', program: record.program, steps: nextSteps(record.program, 'extracted') };
}
