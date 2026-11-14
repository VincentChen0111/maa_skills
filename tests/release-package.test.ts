import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectPackage, productSkills } from '../scripts/release-check.ts';
import { repositoryFiles } from '../scripts/files.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const permission = 'Permission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software").\n';
const mit = (...owners: string[]) => `MIT License\n\n${owners.map((owner) => `Copyright (c) 2026 ${owner}`).join('\n')}\n\n${permission}`;

/** The six product directories of a synthetic payload, each SKILL.md naming references and scripts the way the real ones do. */
const skillFiles: Record<string, string> = {
  'maa-core/SKILL.md': '---\nname: maa-core\ndescription: 共享脚本\n---\n\n接口见 [偏好](references/preferences.md)。共享入口 `scripts/preferences.ts`。\n',
  'maa-core/references/preferences.md': '运行 `node <maa-core>/scripts/preferences.ts read`；核实记录见 [记录](verified-versions.json)。仓库维护工具 `scripts/maa-version-check.ts` 不随包。\n',
  'maa-core/references/verified-versions.json': '{ "schemaVersion": 2, "recordVersion": 1, "sourceVerified": [], "deviceVerified": [] }\n',
  'maa-core/scripts/preferences.ts': "import { shared } from './shared.ts';\nexport const value = shared;\n",
  'maa-core/scripts/shared.ts': 'export const shared = 1;\n',
  'maa-core/package.json': '{ "type": "module", "private": true, "version": "0.1.0-dev.0" }\n',
  'maa-core/LICENSE': mit('VincentChen0111', 'nhyo'),
  'maa-help/SKILL.md': '---\nname: maa-help\ndescription: 文字帮助\n---\n\n安装见 [宿主](references/hosts.md)。\n',
  'maa-help/references/hosts.md': '两个宿主的安装方式。\n',
  'maa-setup/SKILL.md': '---\nname: maa-setup\ndescription: 接入\n---\n\n运行 `node <本目录>/../maa-core/scripts/preferences.ts read`。\n',
  'maa-account/SKILL.md': '---\nname: maa-account\ndescription: 账号\n---\n\n偏好接口见 [偏好](../maa-core/references/preferences.md)。\n',
  'maa-daily/SKILL.md': '---\nname: maa-daily\ndescription: 日常\n---\n\n先读偏好。\n',
  'maa-doctor/SKILL.md': '---\nname: maa-doctor\ndescription: 诊断\n---\n\n先读偏好。\n',
};
for (const name of productSkills) skillFiles[`${name}/LICENSE`] ??= mit('VincentChen0111');
const rootFiles: Record<string, string> = {
  '.claude-plugin/plugin.json': '{ "name": "maa-skills", "version": "0.1.0-dev.0" }\n',
  '.claude-plugin/marketplace.json': '{ "name": "maa-skills", "owner": { "name": "example" }, "plugins": [{ "name": "maa-skills", "source": "./" }] }\n',
  'LICENSE': mit('VincentChen0111'),
  'THIRD_PARTY_NOTICES.md': `# 第三方声明\n\n\`\`\`text\n${mit('nhyo')}\`\`\`\n`,
  'README.md': '# maa_skills\n',
};
async function write(base: string, files: Record<string, string>, prefix = '') {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(base, prefix, file)), { recursive: true });
    await writeFile(join(base, prefix, file), text);
  }
}
async function payloads(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await mkdtemp(join(tmpdir(), 'maa-package-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const plugin = join(base, 'plugin'), skills = join(base, 'skills');
  await write(plugin, rootFiles);
  await write(plugin, skillFiles, 'skills');
  await write(skills, skillFiles);
  return { base, plugin, skills };
}
const clean = { missing: [], excluded: [], licence: [], privacy: [] };

test('complete payloads pass in both install modes, and the CLI reports static codes', async (t) => {
  const { plugin, skills } = await payloads(t);
  assert.deepEqual(await inspectPackage(plugin, 'plugin'), { ok: true, mode: 'plugin', ...clean });
  // A host's skills directory also holds skills that are not ours; skills mode inspects only the six product directories.
  await write(skills, { '.system/other/SKILL.md': '---\nname: other\n---\n', '.system/other/.env': 'X=1\n', 'stray.txt': 'host file\n' });
  assert.deepEqual(await inspectPackage(skills, 'skills'), { ok: true, mode: 'skills', ...clean });

  const cli = (...args: string[]) => spawnSync(process.execPath, [join(repository, 'scripts/release-check.ts'), 'package', ...args], { encoding: 'utf8' });
  const passed = cli(skills, '--mode', 'skills');
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).ok, true);
  await rm(join(skills, 'maa-help/references/hosts.md'));
  const failed = cli(skills, '--mode', 'skills');
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stdout).missing, [{ code: 'missing-file', path: 'maa-help/references/hosts.md', from: 'maa-help/SKILL.md' }]);
  assert.ok(!failed.stdout.includes(skills), 'no installed path is printed');
  assert.equal(cli(skills).status, 2, 'the mode is required');
});

test('every file a SKILL.md or reference links to, names as a script path or imports is must-include, per mode', async (t) => {
  const { plugin, skills } = await payloads(t);
  for (const [root, mode, prefix] of [[plugin, 'plugin', 'skills/'], [skills, 'skills', '']] as const) {
    await rm(join(root, prefix, 'maa-help/references/hosts.md'));
    await rm(join(root, prefix, 'maa-core/scripts/shared.ts'));
    await rm(join(root, prefix, 'maa-account/LICENSE'));
    await rm(join(root, prefix, 'maa-core/references/verified-versions.json'));
    await writeFile(join(root, prefix, 'maa-setup/SKILL.md'), '运行 `node <本目录>/../maa-core/scripts/setup.ts inspect`，再按 [规格](../../docs/spec.md)。\n');
    const report = await inspectPackage(root, mode);
    assert.equal(report.ok, false);
    const expected = [
      { code: 'missing-file', path: `${prefix}maa-account/LICENSE` },
      { code: 'missing-file', path: `${prefix}maa-core/references/verified-versions.json` },
      { code: 'missing-file', path: `${prefix}maa-core/references/verified-versions.json`, from: `${prefix}maa-core/references/preferences.md` },
      { code: 'missing-file', path: `${prefix}maa-core/scripts/setup.ts`, from: `${prefix}maa-setup/SKILL.md` },
      { code: 'missing-file', path: `${prefix}maa-core/scripts/shared.ts`, from: `${prefix}maa-core/scripts/preferences.ts` },
      { code: 'missing-file', path: `${prefix}maa-help/references/hosts.md`, from: `${prefix}maa-help/SKILL.md` },
      // The link to the repository's docs resolves inside a plugin install (and is absent here); a skill install has no repository.
      mode === 'plugin' ? { code: 'missing-file', path: 'docs/spec.md', from: 'skills/maa-setup/SKILL.md' }
        : { code: 'outside-install', path: '../docs/spec.md', from: 'maa-setup/SKILL.md' },
    ];
    assert.deepEqual(report.missing, expected.sort((a, b) => `${a.path}|${a.from ?? ''}`.localeCompare(`${b.path}|${b.from ?? ''}`)), mode);
  }
  await rm(join(plugin, 'THIRD_PARTY_NOTICES.md'));
  await rm(join(plugin, '.claude-plugin/marketplace.json'));
  const paths = (await inspectPackage(plugin, 'plugin')).missing.map((entry) => entry.path);
  assert.ok(paths.includes('THIRD_PARTY_NOTICES.md') && paths.includes('.claude-plugin/marketplace.json'));
});

test('must-exclude content is named by category in both modes', async (t) => {
  const { plugin, skills } = await payloads(t);
  const planted: Record<string, string> = {
    'node_modules/typescript/package.json': 'node-modules',
    '.tmp/logs/run.log': 'tmp-directory',
    'out/evaluations/batch-20261114/run-1/run.json': 'eval-raw-record',
    'out/host.jsonl': 'eval-raw-record',
    '.maa-skills/config.json': 'private-directory',
    'private/account-snapshot.json': 'account-data',
    'data/OperBoxData.json': 'account-data',
    'private/daily-runs.jsonl': 'private-record',
    'private/credentials/skland.json': 'credential',
    '.env': 'credential',
    'keys/signing.pem': 'credential',
    'config/gui.new.json': 'maa-config',
    'resource/tasks.json': 'maa-resource',
    'MaaCore.dll': 'maa-resource',
    'gamedata/excel/character_table.json': 'game-data',
    'cache/penguin-matrix.json': 'penguin-data',
    'cache/yituliu-stage-value.json': 'yituliu-data',
  };
  for (const [root, mode, prefix] of [[plugin, 'plugin', ''], [skills, 'skills', 'maa-core/']] as const) {
    await write(root, Object.fromEntries(Object.keys(planted).map((file) => [`${prefix}${file}`, '{}\n'])));
    const report = await inspectPackage(root, mode);
    assert.equal(report.ok, false);
    assert.deepEqual(report.excluded, Object.entries(planted).map(([file, code]) => ({ code, path: `${prefix}${file}` })).sort((a, b) => a.path.localeCompare(b.path)), mode);
  }
});

test('licence carriers: each skill directory carries the MIT text, and maa-core also the original copyright lines of adapted code', async (t) => {
  const { plugin, skills } = await payloads(t);
  await writeFile(join(skills, 'maa-core/LICENSE'), mit('VincentChen0111'));
  await writeFile(join(skills, 'maa-daily/LICENSE'), 'MIT License\n\nCopyright (c) 2026 VincentChen0111\n');
  assert.deepEqual((await inspectPackage(skills, 'skills')).licence,
    [{ code: 'licence-incomplete', path: 'maa-core/LICENSE' }, { code: 'licence-incomplete', path: 'maa-daily/LICENSE' }]);
  await writeFile(join(plugin, 'THIRD_PARTY_NOTICES.md'), '# 第三方声明\n');
  await writeFile(join(plugin, 'LICENSE'), 'All rights reserved.\n');
  assert.deepEqual((await inspectPackage(plugin, 'plugin')).licence,
    [{ code: 'licence-incomplete', path: 'LICENSE' }, { code: 'licence-incomplete', path: 'THIRD_PARTY_NOTICES.md' }]);
});

test('installed text is scanned with the repository privacy rules, and findings carry no content', async (t) => {
  const { skills } = await payloads(t);
  const privatePath = ['C:', 'Users', 'synthetic-player', 'maa'].join('\\');
  await writeFile(join(skills, 'maa-help/references/hosts.md'), `第一行\nMAA 在 ${privatePath} 下。\n`);
  const report = await inspectPackage(skills, 'skills');
  assert.deepEqual(report.privacy, [{ file: 'maa-help/references/hosts.md', line: 2, rule: 'private-path' }]);
  assert.ok(!JSON.stringify(report).includes('synthetic-player'));
});

test('the development junction layout is checked through the links, in a temporary location', async (t) => {
  const { base, skills } = await payloads(t);
  const linked = join(base, 'host-skills');
  await mkdir(linked);
  for (const name of productSkills) await symlink(join(skills, name), join(linked, name), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await inspectPackage(linked, 'skills'), { ok: true, mode: 'skills', ...clean });
  await rm(join(skills, 'maa-help/references/hosts.md'));
  assert.deepEqual((await inspectPackage(linked, 'skills')).missing, [{ code: 'missing-file', path: 'maa-help/references/hosts.md', from: 'maa-help/SKILL.md' }]);
});

test("this branch's payload, laid out as each host installs it, passes both lists", async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maa-package-repo-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  // The plugin marketplace installs the repository root; the inventory is what a clone carries (no ignored files).
  for (const file of await repositoryFiles(repository)) {
    await mkdir(dirname(join(base, 'plugin', file)), { recursive: true });
    await copyFile(join(repository, file), join(base, 'plugin', file));
  }
  assert.deepEqual(await inspectPackage(join(base, 'plugin'), 'plugin'), { ok: true, mode: 'plugin', ...clean });
  // skill-installer copies each skills/<name> directory next to the others.
  for (const file of (await repositoryFiles(repository)).filter((path) => path.startsWith('skills/maa-'))) {
    await mkdir(dirname(join(base, 'skills', file.slice('skills/'.length))), { recursive: true });
    await copyFile(join(repository, file), join(base, 'skills', file.slice('skills/'.length)));
  }
  assert.deepEqual(await inspectPackage(join(base, 'skills'), 'skills'), { ok: true, mode: 'skills', ...clean });
  assert.equal(await readFile(join(repository, 'skills/maa-account/LICENSE'), 'utf8'), await readFile(join(repository, 'LICENSE'), 'utf8'));
});
