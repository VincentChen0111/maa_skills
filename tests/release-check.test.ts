import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectVersions, inspectTag, directoryReader, changelogPath, releaseNotesPath } from '../scripts/release-check.ts';
import { recordPath, releaseNotes, type RecordFile } from '../scripts/maa-version-check.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const record: RecordFile = { schemaVersion: 2, recordVersion: 2, sourceVerified: ['6.22.0'], deviceVerified: [] };

/** A synthetic repository whose every version-bearing file agrees on `version`. */
async function writeRelease(root: string, version: string, options: { status?: 'draft' | 'released'; notesRecord?: typeof record } = {}) {
  const target = version.replace(/-.*$/, '');
  const released = (options.status ?? (version.includes('-') ? 'draft' : 'released')) === 'released';
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await mkdir(join(root, 'skills/maa-core/references'), { recursive: true });
  await mkdir(join(root, 'docs/releases'), { recursive: true });
  await writeFile(join(root, 'package.json'), json({ name: 'maa-skills', version }));
  await writeFile(join(root, 'package-lock.json'), json({ name: 'maa-skills', version, lockfileVersion: 3, packages: { '': { name: 'maa-skills', version } } }));
  await writeFile(join(root, '.claude-plugin/plugin.json'), json({ name: 'maa-skills', version }));
  await writeFile(join(root, '.claude-plugin/marketplace.json'), json({ name: 'maa-skills', owner: { name: 'example' }, plugins: [{ name: 'maa-skills', source: './' }] }));
  await writeFile(join(root, 'skills/maa-core/package.json'), json({ type: 'module', private: true, version }));
  await writeFile(join(root, 'skills/maa-core/references/verified-versions.json'), json(record));
  await writeFile(join(root, changelogPath), `# 更新记录\n\n## ${target} - ${released ? '2026-11-20' : '未发布'}\n\n- 首个版本。\n\n## 0.0.9 - 2026-01-01\n\n- 更早的条目。\n`);
  await writeFile(join(root, releaseNotesPath(target)), `# v${target} 发布说明\n\n版本：${target}\n状态：${released ? '已发布' : '草稿'}\n\n${releaseNotes(options.notesRecord ?? record)}`);
}
const temporary = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
const edit = async (root: string, file: string, change: (text: string) => string) => writeFile(join(root, file), change(await readFile(join(root, file), 'utf8')));

test('pre-release mode: every manifest, the changelog head and the draft notes agree; each drift is named by a static code', async (t) => {
  const root = await temporary(t);
  await writeRelease(root, '0.1.0-dev.0');
  const clean = await inspectVersions(directoryReader(root));
  assert.deepEqual(clean, { version: '0.1.0-dev.0', target: '0.1.0', mode: 'pre-release', errors: [] });

  const drifts: [string, (text: string) => string, string][] = [
    ['package-lock.json', (text) => text.replace('"version": "0.1.0-dev.0",\n  "lockfileVersion"', '"version": "0.1.0",\n  "lockfileVersion"'), 'package-lock: version-mismatch'],
    ['package-lock.json', (text) => text.replace(/("": \{\s*"name": "maa-skills",\s*"version": )"0\.1\.0-dev\.0"/, '$1"0.0.1"'), 'package-lock: root-package-version-mismatch'],
    ['.claude-plugin/plugin.json', (text) => text.replace('0.1.0-dev.0', '0.2.0'), 'plugin: version-mismatch'],
    ['.claude-plugin/marketplace.json', (text) => text.replace('"source": "./"', '"source": "./", "version": "0.2.0"'), 'marketplace: version-mismatch'],
    ['.claude-plugin/marketplace.json', (text) => text.replace('"owner"', '"metadata": { "version": "0.2.0" }, "owner"'), 'marketplace: version-mismatch'],
    ['skills/maa-core/package.json', (text) => text.replace('0.1.0-dev.0', '0.0.9'), 'maa-core: version-mismatch'],
    [changelogPath, (text) => text.replace('## 0.1.0 - 未发布', '## 0.2.0 - 未发布'), 'changelog: version-mismatch'],
    [changelogPath, (text) => text.replace('## 0.1.0 - 未发布', '## 0.1.0 - 2026-11-20'), 'changelog: status-mismatch'],
    [changelogPath, (text) => text.replace('## 0.1.0 - 未发布', '## 下一版'), 'changelog: latest-entry-invalid'],
    [releaseNotesPath('0.1.0'), (text) => text.replace('版本：0.1.0', '版本：0.1.1'), 'release-notes: version-mismatch'],
    [releaseNotesPath('0.1.0'), (text) => text.replace('状态：草稿', '状态：已发布'), 'release-notes: status-mismatch'],
  ];
  for (const [file, change, code] of drifts) {
    const before = await readFile(join(root, file), 'utf8');
    await edit(root, file, change);
    assert.notEqual(await readFile(join(root, file), 'utf8'), before, `${code}: the synthetic edit applied`);
    assert.deepEqual((await inspectVersions(directoryReader(root))).errors, [code], file);
    await writeFile(join(root, file), before);
  }
  await rm(join(root, releaseNotesPath('0.1.0')));
  assert.deepEqual((await inspectVersions(directoryReader(root))).errors, ['release-notes: missing']);
  await rm(join(root, changelogPath));
  assert.deepEqual((await inspectVersions(directoryReader(root))).errors, ['changelog: missing', 'release-notes: missing']);
  await writeRelease(root, '0.1.0-dev.0');
  // Release mode refuses a pre-release version outright: the version string, not a flag in a file, decides the mode.
  assert.deepEqual((await inspectVersions(directoryReader(root), { release: true })).errors, ['version: pre-release']);
  await edit(root, 'package.json', (text) => text.replace('0.1.0-dev.0', '0.1'));
  assert.deepEqual((await inspectVersions(directoryReader(root))).errors, ['package: invalid-version']);
});

test('release mode: a stable version needs a dated changelog head, published notes and the current MAA verification lines', async (t) => {
  const root = await temporary(t);
  await writeRelease(root, '0.1.0');
  assert.deepEqual(await inspectVersions(directoryReader(root), { release: true }), { version: '0.1.0', target: '0.1.0', mode: 'release', errors: [] });
  await edit(root, changelogPath, (text) => text.replace('## 0.1.0 - 2026-11-20', '## 0.1.0 - 未发布'));
  assert.deepEqual((await inspectVersions(directoryReader(root), { release: true })).errors, ['changelog: status-mismatch']);
  await writeRelease(root, '0.1.0');
  await edit(root, releaseNotesPath('0.1.0'), (text) => text.replace('状态：已发布', '状态：草稿'));
  assert.deepEqual((await inspectVersions(directoryReader(root), { release: true })).errors, ['release-notes: status-mismatch']);
  // Notes written before the record gained a version are stale at release time. The everyday gate does not ask for this:
  // ticket 25's daily Action changes only the registry and the record, and must not fail on an old release's notes.
  await writeRelease(root, '0.1.0', { notesRecord: { ...record, sourceVerified: [] } });
  assert.deepEqual((await inspectVersions(directoryReader(root), { release: true })).errors, ['release-notes: maa-versions-stale']);
  assert.deepEqual((await inspectVersions(directoryReader(root))).errors, []);
  await rm(join(root, 'skills/maa-core/references/verified-versions.json'));
  assert.deepEqual((await inspectVersions(directoryReader(root), { release: true })).errors, ['release-notes: maa-record-unreadable']);
});

/** Git in a synthetic repository with an empty global configuration, so the caller's signing or hooks settings do not apply. */
const gitIn = (root: string, globalConfig: string) => (...args: string[]) => {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=release-test', '-c', 'user.email=release-test@example.invalid', ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig } });
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
};

test('tag mode: the tag is v plus the version read from the tagged commit, and it points at the release commit', async (t) => {
  const base = await temporary(t);
  const root = join(base, 'repo');
  await mkdir(root);
  await writeFile(join(base, 'gitconfig'), '');
  const git = gitIn(root, join(base, 'gitconfig'));
  git('init', '--quiet');
  await writeRelease(root, '0.1.0');
  git('add', '.');
  git('commit', '--quiet', '-m', 'release');
  const release = git('rev-parse', 'HEAD');
  git('tag', 'v0.1.0');
  assert.deepEqual(await inspectTag(root, 'v0.1.0'), { version: '0.1.0', errors: [] });

  git('tag', 'v0.1.1');
  assert.deepEqual((await inspectTag(root, 'v0.1.1')).errors, ['tag: name-mismatch']);
  assert.deepEqual((await inspectTag(root, 'v9.9.9')).errors, ['tag: missing']);
  assert.deepEqual((await inspectTag(root, '--upload-pack=x')).errors, ['tag: invalid-name']);

  // A later commit is the release candidate now: the old tag does not point at it. The working tree is never read.
  await writeFile(join(root, 'README.md'), 'later\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'later');
  assert.deepEqual((await inspectTag(root, 'v0.1.0')).errors, ['tag: commit-mismatch']);
  assert.deepEqual((await inspectTag(root, 'v0.1.0', release)).errors, []);
  await writeFile(join(root, 'package.json'), '{ "version": "9.9.9" }');
  assert.deepEqual((await inspectTag(root, 'v0.1.0', release)).errors, [], 'an uncommitted edit does not change what the tag carries');
  assert.deepEqual((await inspectTag(root, 'v0.1.0', 'no-such-commit')).errors, ['tag: release-commit-missing']);

  // A tag on a pre-release commit fails the release-mode version check of that commit.
  await writeRelease(root, '0.2.0-dev.0');
  git('add', '.');
  git('commit', '--quiet', '-m', 'dev');
  git('tag', 'v0.2.0-dev.0');
  assert.deepEqual((await inspectTag(root, 'v0.2.0-dev.0')).errors, ['version: pre-release']);
});

test('the CLI prints static codes and its exit status follows them', async (t) => {
  const root = await temporary(t);
  await writeRelease(root, '0.1.0-dev.0');
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repository, 'scripts/release-check.ts'), ...args], { encoding: 'utf8' });
  const clean = run('versions', root);
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(JSON.parse(clean.stdout), { ok: true, version: '0.1.0-dev.0', target: '0.1.0', mode: 'pre-release', errors: [] });
  const release = run('versions', '--release', root);
  assert.equal(release.status, 1);
  assert.deepEqual(JSON.parse(release.stdout).errors, ['version: pre-release']);
  assert.ok(!release.stdout.includes(root), 'no checked path is printed');
  assert.equal(run('unknown').status, 2);
});

/**
 * What every PR's offline gate asserts about a repository (this file runs in it): no error without `--release`, in the mode the
 * version's own pre-release suffix names (read from package.json here, not from the report), so the release commit passes too.
 */
async function assertGateConsistent(root: string) {
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version as string;
  const report = await inspectVersions(directoryReader(root));
  assert.deepEqual(report.errors, []);
  assert.equal(report.mode, /^\d+\.\d+\.\d+-/.test(version) ? 'pre-release' : 'release');
  return report;
}

test('the repository is consistent in the mode its own version names: drafts while the version carries a pre-release suffix', async () => {
  await assertGateConsistent(repository);
});

/**
 * The release commit, made from this repository's own files by the release edits: the version without its pre-release suffix
 * in every manifest, a date on the changelog head, notes marked 已发布 whose two MAA lines are regenerated from the packaged
 * record (the release step refreshes them; the everyday gate never compares them, so a record-only PR cannot fail here).
 */
async function releaseShaped(root: string): Promise<string> {
  const version = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version as string;
  const target = version.replace(/-.*$/, '');
  const files = ['package.json', 'package-lock.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'skills/maa-core/package.json',
    recordPath, changelogPath, releaseNotesPath(target)];
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), await readFile(join(repository, file)));
  }
  const json = (file: string, change: (value: any) => void) => edit(root, file, (text) => {
    const value = JSON.parse(text); change(value); return JSON.stringify(value, null, 2) + '\n';
  });
  await json('package.json', (value) => { value.version = target; });
  await json('package-lock.json', (value) => { value.version = target; value.packages[''].version = target; });
  await json('.claude-plugin/plugin.json', (value) => { value.version = target; });
  await json('skills/maa-core/package.json', (value) => { value.version = target; });
  await json('.claude-plugin/marketplace.json', (value) => {
    if (value.metadata?.version !== undefined) value.metadata.version = target;
    for (const entry of value.plugins ?? []) if (entry.version !== undefined) entry.version = target;
  });
  await edit(root, changelogPath, (text) => text.replace(/^(## \[?v?[0-9A-Za-z.-]+\]? - )未发布[ \t]*$/m, (_, head: string) => `${head}2026-11-20`));
  const [source, device] = releaseNotes(JSON.parse(await readFile(join(root, recordPath), 'utf8')) as RecordFile).trimEnd().split('\n');
  await edit(root, releaseNotesPath(target), (text) => {
    assert.match(text, /^MAA 源码已核：/m, 'the draft notes carry the source-verified line');
    assert.match(text, /^MAA 实机已核：/m, 'the draft notes carry the device-verified line');
    return text.replace(/^状态：草稿[ \t]*$/m, '状态：已发布').replace(/^MAA 源码已核：.*$/m, () => source!).replace(/^MAA 实机已核：.*$/m, () => device!);
  });
  return target;
}

test('the release commit made from this repository passes the same gate assertion and the --release check', async (t) => {
  const root = await temporary(t);
  const target = await releaseShaped(root);
  const report = await assertGateConsistent(root);
  assert.deepEqual(report, { version: target, target, mode: 'release', errors: [] });
  const cli = spawnSync(process.execPath, [join(repository, 'scripts/release-check.ts'), 'versions', '--release', root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout);
  assert.deepEqual(JSON.parse(cli.stdout), { ok: true, version: target, target, mode: 'release', errors: [] });
});
