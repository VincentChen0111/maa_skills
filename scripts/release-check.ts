import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { recordPath, releaseNotes, type RecordFile } from './maa-version-check.ts';
import { inspectText, type PrivacyFinding } from './privacy.ts';

/**
 * Release checks (ticket 26; spec 「发布与维护流程」「仓库与打包」「隐私」). This module is the one owner of:
 * - version consistency: package.json, package-lock.json (root and packages[""]), .claude-plugin/plugin.json,
 *   .claude-plugin/marketplace.json (when it carries a version), skills/maa-core/package.json, the changelog head and the
 *   release notes. `scripts/metadata.ts` runs the manifest part in the everyday offline gate;
 * - the tag check: the tag is `v` + the version read from the tagged commit, and it points at the release commit.
 * The mode comes from the version string itself: a semver pre-release suffix (`0.1.0-dev.0`) is pre-release mode, where the
 * changelog head is the target version marked 未发布 and the notes are a 草稿; a plain `X.Y.Z` is release mode, where the head
 * carries a date and the notes are 已发布. `--release` (and tag mode) additionally refuse a pre-release version and require the
 * notes to carry the current MAA verification lines. Output is static codes only: no file content and no checked path.
 */
export const changelogPath = 'CHANGELOG.md';
export const releaseNotesPath = (target: string) => `docs/releases/v${target}.md`;

const semver = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const changelogHead = /^## \[?v?([0-9A-Za-z.-]+)\]? - (未发布|\d{4}-\d{2}-\d{2})\s*$/;

/** Reads a repository-relative file; null when it does not exist. */
export type ReadText = (path: string) => Promise<string | null>;
export const directoryReader = (root: string): ReadText => async (path) => {
  try { return await readFile(join(root, path), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};
/** Reads files as committed, so an uncommitted edit never changes what a tag carries. */
export const commitReader = (root: string, commit: string): ReadText => async (path) => {
  const result = spawnSync('git', ['-C', root, 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
};

export type VersionMode = 'pre-release' | 'release';
export type VersionReport = { version: string | null; target: string | null; mode: VersionMode | null; errors: string[] };

async function readJson(read: ReadText, path: string): Promise<{ value?: any; error?: 'missing' | 'invalid' }> {
  const text = await read(path);
  if (text === null) return { error: 'missing' };
  try { return { value: JSON.parse(text) }; } catch { return { error: 'invalid' }; }
}

/**
 * The manifest part, run by the everyday gate: every JSON manifest carries the package version. Returns the version or null
 * when package.json itself has none that parses as semver (nothing else is compared then).
 */
export async function inspectManifestVersions(read: ReadText): Promise<{ version: string | null; errors: string[] }> {
  const errors: string[] = [];
  const pkg = await readJson(read, 'package.json');
  if (pkg.error) return { version: null, errors: [`package: ${pkg.error === 'missing' ? 'missing' : 'invalid'}`] };
  const version = pkg.value?.version;
  if (typeof version !== 'string' || !semver.test(version)) return { version: null, errors: ['package: invalid-version'] };
  const lock = await readJson(read, 'package-lock.json');
  if (lock.error) errors.push(`package-lock: ${lock.error}`);
  else {
    if (lock.value?.version !== version) errors.push('package-lock: version-mismatch');
    if (lock.value?.packages?.['']?.version !== version) errors.push('package-lock: root-package-version-mismatch');
  }
  const plugin = await readJson(read, '.claude-plugin/plugin.json');
  if (plugin.error) errors.push(`plugin: ${plugin.error}`);
  else if (plugin.value?.version !== version) errors.push('plugin: version-mismatch');
  const market = await readJson(read, '.claude-plugin/marketplace.json');
  if (market.error) errors.push(`marketplace: ${market.error}`);
  else {
    // The marketplace may omit versions (the plugin manifest then wins); any version it does carry must agree.
    const carried = [market.value?.metadata?.version, ...(Array.isArray(market.value?.plugins) ? market.value.plugins.map((entry: any) => entry?.version) : [])];
    if (carried.some((value) => value !== undefined && value !== version)) errors.push('marketplace: version-mismatch');
  }
  // Installed skill directories carry no plugin manifest; maa-core's package version is what doctor reports.
  const core = await readJson(read, 'skills/maa-core/package.json');
  if (core.error || core.value?.version !== version) errors.push('maa-core: version-mismatch');
  return { version, errors };
}

/** Manifests, the changelog head and the release notes, in the mode the version string decides. */
export async function inspectVersions(read: ReadText, options: { release?: boolean } = {}): Promise<VersionReport> {
  const manifests = await inspectManifestVersions(read);
  if (!manifests.version) return { version: null, target: null, mode: null, errors: manifests.errors };
  const [, target, suffix] = semver.exec(manifests.version)!;
  const mode: VersionMode = suffix ? 'pre-release' : 'release';
  const errors = options.release && mode === 'pre-release' ? ['version: pre-release', ...manifests.errors] : [...manifests.errors];

  const changelog = await read(changelogPath);
  if (changelog === null) errors.push('changelog: missing');
  else {
    const head = changelog.split(/\r?\n/).find((line) => line.startsWith('## '));
    const parsed = head ? changelogHead.exec(head) : null;
    if (!parsed) errors.push('changelog: latest-entry-invalid');
    else {
      if (parsed[1] !== target) errors.push('changelog: version-mismatch');
      if ((parsed[2] === '未发布') !== (mode === 'pre-release')) errors.push('changelog: status-mismatch');
    }
  }

  const notes = await read(releaseNotesPath(target!));
  if (notes === null) errors.push('release-notes: missing');
  else {
    const lines = notes.split(/\r?\n/);
    const field = (name: string) => lines.find((line) => line.startsWith(`${name}：`))?.slice(name.length + 1).trim();
    if (field('版本') !== target) errors.push('release-notes: version-mismatch');
    if (field('状态') !== (mode === 'pre-release' ? '草稿' : '已发布')) errors.push('release-notes: status-mismatch');
    if (options.release && mode === 'release') {
      // The notes name the source- and device-verified MAA versions exactly as the packaged record lists them (spec 「MAA 版本跟踪」).
      const record = await readJson(read, recordPath);
      if (record.error) errors.push('release-notes: maa-record-unreadable');
      else {
        let expected: string[] = [];
        try { expected = releaseNotes(record.value as RecordFile).trimEnd().split('\n'); } catch { errors.push('release-notes: maa-record-unreadable'); }
        if (expected.length && !expected.every((line) => lines.includes(line))) errors.push('release-notes: maa-versions-stale');
      }
    }
  }
  return { version: manifests.version, target: target!, mode, errors };
}

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

/** Tag mode: release-mode versions as committed at the tag, the tag name equals `v` + that version, and it points at `commit`. */
export async function inspectTag(root: string, tag: string, commit = 'HEAD'): Promise<{ version: string | null; errors: string[] }> {
  if (!/^v[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(tag)) return { version: null, errors: ['tag: invalid-name'] };
  const tagged = git(root, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`);
  if (!tagged) return { version: null, errors: ['tag: missing'] };
  const release = /^[0-9A-Za-z][0-9A-Za-z/._^~-]*$/.test(commit) ? git(root, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`) : null;
  if (!release) return { version: null, errors: ['tag: release-commit-missing'] };
  const report = await inspectVersions(commitReader(root, tagged), { release: true });
  const errors = [...report.errors];
  if (report.version && tag !== `v${report.version}`) errors.push('tag: name-mismatch');
  if (tagged !== release) errors.push('tag: commit-mismatch');
  return { version: report.version, errors };
}

/*
 * Packaging lists (spec 「仓库与打包」「隐私」; the lists are written out in docs/release-verification.md 「打包清单」).
 * Two install modes copy the same directories: `plugin` is the Claude Code plugin marketplace, which installs the repository
 * root as the plugin (`.claude-plugin/marketplace.json` source `./`); `skills` is Codex's skill-installer, which copies each
 * `skills/<name>` directory next to the others in the host's skills directory. Skills mode inspects only the six product
 * directories there: the host keeps its own skills beside them.
 */
export type InstallMode = 'plugin' | 'skills';
export const productSkills = ['maa-core', 'maa-help', 'maa-setup', 'maa-account', 'maa-daily', 'maa-doctor'] as const;
/** The project's copyright line, carried by the root LICENSE and every skill directory's LICENSE. */
export const projectCopyright = 'Copyright (c) 2026 VincentChen0111';
/**
 * Original copyright lines of code adapted into maa-core (THIRD_PARTY_NOTICES.md lists each with its commit). The notices file
 * travels only with a plugin install, so maa-core/LICENSE carries these lines for single-directory installs.
 */
export const adaptedCodeCopyrights = ['Copyright (c) 2026 nhyo'];
const mitMarkers = ['MIT License', 'Permission is hereby granted, free of charge'];
/**
 * Repository maintenance tools the skill docs name, with what they are: they live in the repository's scripts/, are not installed
 * with the skills and take no action from the skill, so a mention is not a must-include script. tests/docs-consistency.test.ts
 * reads this same list and requires each to exist in scripts/ and still be named.
 */
export const repositoryTools: Record<string, string> = { 'maa-version-check.ts': 'generates the packaged MAA verification record (ticket 25)' };

/** Fixed must-include files, relative to the installed directory. Referenced files are added by following the payload itself. */
export function mustInclude(mode: InstallMode): string[] {
  const base = mode === 'plugin' ? 'skills/' : '';
  const skills = productSkills.flatMap((name) => [`${base}${name}/SKILL.md`, `${base}${name}/LICENSE`]);
  const core = [`${base}maa-core/package.json`, `${base}maa-core/references/verified-versions.json`];
  const root = mode === 'plugin' ? ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md'] : [];
  return [...root, ...skills, ...core];
}

/** Must-exclude categories, first match wins. `segments` are the lower-cased directory names, `name` the lower-cased file name. */
const excludeRules: [string, (segments: string[], name: string) => boolean][] = [
  ['node-modules', (segments) => segments.includes('node_modules')],
  ['eval-raw-record', (segments, name) => segments.some((segment, index) => segment === 'evaluations' && /^batch-/.test(segments[index + 1] ?? ''))
    || ['host.jsonl', 'run.json', 'evidence.json', 'invocation.json'].includes(name) || /^read-protection-.*\.jsonl$/.test(name)],
  ['tmp-directory', (segments) => segments.includes('.tmp')],
  ['private-directory', (segments) => segments.includes('.maa-skills') || segments.includes('.maa-skills-eval')],
  ['account-data', (_, name) => /^account-snapshot.*\.json$/.test(name) || ['depotdata.json', 'operboxdata.json'].includes(name)],
  ['private-record', (_, name) => ['preferences.jsonl', 'daily-pending.jsonl', 'daily-runs.jsonl', 'setup-environment.json'].includes(name)],
  ['credential', (segments, name) => (segments.includes('credentials') && name.endsWith('.json')) || /^\.env(\..+)?$/.test(name)
    || /\.(pem|key|p12|pfx)$/.test(name) || /^id_(rsa|ecdsa|ed25519)/.test(name) || ['.credentials.json', 'auth.json', 'cookies.txt', '.npmrc', '.netrc'].includes(name)],
  ['maa-config', (_, name) => /^gui(\.new)?\.json/.test(name)],
  ['maa-resource', (segments, name) => segments.includes('resource') || /\.(dll|exe)$/.test(name)],
  ['game-data', (segments, name) => segments.includes('gamedata') || segments.includes('excel') || /_table\.json$/.test(name)
    || ['building_data.json', 'battle_data.json'].includes(name)],
  ['penguin-data', (_, name) => /penguin/.test(name) || /^matrix.*\.json$/.test(name)],
  ['yituliu-data', (_, name) => /yituliu/.test(name)],
];

export type PackageEntry = { code: string; path: string; from?: string };
export type PackageReport = { ok: boolean; mode: InstallMode; missing: PackageEntry[]; excluded: PackageEntry[]; licence: PackageEntry[]; privacy: PrivacyFinding[] };

const slash = (path: string) => path.split('\\').join('/');
const byPath = (a: PackageEntry, b: PackageEntry) => `${a.path}|${a.from ?? ''}`.localeCompare(`${b.path}|${b.from ?? ''}`);

/** Every regular file below `directory`, following junctions (the development layout) and skipping a host's `.git`. */
async function walk(root: string, directory: string, files: string[], seen: Set<string>): Promise<void> {
  const real = await realpath(directory);
  if (seen.has(real)) return;
  seen.add(real);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(directory, entry.name);
    const info = entry.isSymbolicLink() ? await stat(path).catch(() => null) : entry;
    if (!info) continue;
    if (info.isDirectory()) await walk(root, path, files, seen);
    else if (info.isFile()) files.push(slash(relative(root, path)));
  }
}

const exists = async (path: string) => !!(await stat(path).catch(() => null));

/** Targets a markdown file links to or names as a script path, relative to the installed directory (`..` when outside it). */
function markdownTargets(file: string, text: string, skill: string | undefined, base: string): string[] {
  const targets: string[] = [];
  const from = dirname(file);
  for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1]!.split('#')[0]!;
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('<')) continue;
    targets.push(slash(join(from, decodeURIComponent(target))));
  }
  // Script paths: `<maa-core>/scripts/x.ts`, `<本目录>/../maa-core/scripts/x.ts`, and bare `scripts/x.ts` inside maa-core.
  // Every shared script lives in maa-core/scripts; a bare `scripts/...` elsewhere is prose about a repository tool.
  for (const match of text.matchAll(/[^\s`'"()（）]*scripts\/[A-Za-z0-9_.-]+\.(?:ts|mjs|js)\b/g)) {
    const token = match[0];
    const prefix = token.slice(0, token.lastIndexOf('scripts/'));
    const script = token.slice(prefix.length);
    let owner: string | undefined;
    if (prefix.endsWith('maa-core/')) owner = 'maa-core';
    else if (prefix === '' || prefix === './') owner = skill === 'maa-core' ? 'maa-core' : undefined;
    else if (/^<[^<>]+>\/$/.test(prefix)) owner = prefix === '<本目录>/' ? skill : 'maa-core';
    if (owner && !Object.hasOwn(repositoryTools, script.slice('scripts/'.length))) targets.push(`${base}${owner}/${script}`);
  }
  return targets;
}

function importTargets(file: string, text: string): string[] {
  const from = dirname(file);
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map((match) => slash(join(from, match[1]!)));
}

/** Checks an installed directory against the must-include and must-exclude lists of its install mode. Static codes only. */
export async function inspectPackage(directory: string, mode: InstallMode): Promise<PackageReport> {
  const root = await realpath(directory);
  const base = mode === 'plugin' ? 'skills/' : '';
  const files: string[] = [];
  const seen = new Set<string>();
  if (mode === 'plugin') await walk(root, root, files, seen);
  else for (const name of productSkills) if (await exists(join(root, name))) await walk(root, join(root, name), files, seen);
  const present = new Set(files);

  const missing = new Map<string, PackageEntry>();
  const report = (entry: PackageEntry) => missing.set(`${entry.path}|${entry.from ?? ''}`, entry);
  for (const path of mustInclude(mode)) if (!present.has(path)) report({ code: 'missing-file', path });
  // Follow every SKILL.md through the references it links, the script paths it names and the modules those scripts import.
  const queue = productSkills.map((name) => `${base}${name}/SKILL.md`).filter((path) => present.has(path));
  const visited = new Set(queue);
  while (queue.length) {
    const file = queue.shift()!;
    const text = await readFile(join(root, file), 'utf8');
    const skill = file.slice(base.length).split('/')[0];
    const targets = file.endsWith('.md') ? markdownTargets(file, text, skill, base) : /\.(ts|mjs|js)$/.test(file) ? importTargets(file, text) : [];
    for (const target of targets) {
      if (target === '..' || target.startsWith('../') || isAbsolute(target)) { report({ code: 'outside-install', path: target, from: file }); continue; }
      if (present.has(target)) {
        if (!visited.has(target)) { visited.add(target); queue.push(target); }
      } else if (!(await exists(join(root, target)))) report({ code: 'missing-file', path: target, from: file });
    }
  }

  const excluded: PackageEntry[] = [];
  for (const path of files) {
    const parts = path.toLowerCase().split('/');
    const name = parts.pop()!;
    const rule = excludeRules.find(([, matches]) => matches(parts, name));
    if (rule) excluded.push({ code: rule[0], path });
  }

  const licence: PackageEntry[] = [];
  const carries = async (path: string, lines: string[]) => {
    if (!present.has(path)) return; // Reported as missing above.
    const text = await readFile(join(root, path), 'utf8');
    if (!lines.every((line) => text.includes(line))) licence.push({ code: 'licence-incomplete', path });
  };
  if (mode === 'plugin') {
    await carries('LICENSE', [...mitMarkers, projectCopyright]);
    await carries('THIRD_PARTY_NOTICES.md', [...mitMarkers.slice(1), ...adaptedCodeCopyrights]);
  }
  for (const name of productSkills) await carries(`${base}${name}/LICENSE`, [...mitMarkers, projectCopyright, ...(name === 'maa-core' ? adaptedCodeCopyrights : [])]);

  const privacy: PrivacyFinding[] = [];
  for (const path of files) {
    const bytes = await readFile(join(root, path));
    if (bytes.includes(0)) continue; // Binary: the line rules are for text.
    privacy.push(...inspectText(path, bytes.toString('utf8')));
  }

  const result = { missing: [...missing.values()].sort(byPath), excluded: excluded.sort(byPath), licence: licence.sort(byPath), privacy };
  return { ok: Object.values(result).every((list) => list.length === 0), mode, ...result };
}

const usage = `node scripts/release-check.ts versions [--release] [<repository>]
node scripts/release-check.ts tag <tag> [--commit <rev>] [<repository>]
node scripts/release-check.ts package <installed-directory> --mode plugin|skills`;

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift();
  const flag = (name: string) => { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; };
  const option = (name: string) => { const index = args.indexOf(name); if (index < 0) return undefined; const [, value] = args.splice(index, 2); return value; };
  if (command === 'versions') {
    const release = flag('--release');
    const report = await inspectVersions(directoryReader(resolve(args[0] ?? '.')), { release });
    console.log(JSON.stringify({ ok: report.errors.length === 0, ...report }));
    return report.errors.length ? 1 : 0;
  }
  if (command === 'tag') {
    const commit = option('--commit');
    const [tag, root] = args;
    if (!tag) { console.error(usage); return 2; }
    const report = await inspectTag(resolve(root ?? '.'), tag, commit);
    console.log(JSON.stringify({ ok: report.errors.length === 0, ...report }));
    return report.errors.length ? 1 : 0;
  }
  if (command === 'package') {
    const mode = option('--mode');
    const [directory] = args;
    if (!directory || (mode !== 'plugin' && mode !== 'skills')) { console.error(usage); return 2; }
    const report = await inspectPackage(resolve(directory), mode);
    console.log(JSON.stringify(report));
    return report.ok ? 0 : 1;
  }
  console.error(usage);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch {
    console.error('Release check could not complete.');
    process.exitCode = 1;
  }
}
