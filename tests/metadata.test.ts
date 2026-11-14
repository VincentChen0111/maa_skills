import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectMetadata } from '../scripts/metadata.ts';

const lock = (version: string) => JSON.stringify({ name: 'maa-skills', version, lockfileVersion: 3, packages: { '': { name: 'maa-skills', version } } });

test('metadata checker catches broken local links and plugin version drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude-plugin'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0-dev.0' }));
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'maa-skills', version: '0.1.0-dev.0' }));
  await writeFile(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'maa-skills', owner: { name: 'example' }, plugins: [{ name: 'maa-skills', source: './' }] }));
  await mkdir(join(root, 'skills/maa-core'), { recursive: true });
  await writeFile(join(root, 'skills/maa-core/package.json'), JSON.stringify({ type: 'module', private: true, version: '0.1.0-dev.0' }));
  await writeFile(join(root, 'package-lock.json'), lock('0.1.0-dev.0'));
  await writeFile(join(root, 'README.md'), '[missing](missing.md)');
  assert.ok((await inspectMetadata(root)).some((error) => error.includes('broken-link')));
  await writeFile(join(root, 'README.md'), '[package](package.json)');
  assert.deepEqual(await inspectMetadata(root), []);
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'maa-skills', version: '0.2.0' }));
  assert.ok((await inspectMetadata(root)).some((error) => error.includes('version-mismatch')));
});

test('the everyday gate also compares the lockfile and any marketplace version, through the one release-check owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude-plugin')); await mkdir(join(root, 'skills/maa-core'), { recursive: true });
  const version = '0.1.0-dev.0';
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }));
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'maa-skills', version }));
  await writeFile(join(root, 'skills/maa-core/package.json'), JSON.stringify({ type: 'module', private: true, version }));
  const market = (entry: object) => JSON.stringify({ name: 'maa-skills', owner: { name: 'example' }, plugins: [{ name: 'maa-skills', source: './', ...entry }] });
  await writeFile(join(root, '.claude-plugin/marketplace.json'), market({}));
  await writeFile(join(root, 'package-lock.json'), lock(version));
  assert.deepEqual(await inspectMetadata(root), []);
  await writeFile(join(root, 'package-lock.json'), lock('0.0.9'));
  assert.deepEqual(await inspectMetadata(root), ['package-lock: version-mismatch', 'package-lock: root-package-version-mismatch']);
  await rm(join(root, 'package-lock.json'));
  assert.deepEqual(await inspectMetadata(root), ['package-lock: missing']);
  await writeFile(join(root, 'package-lock.json'), lock(version));
  await writeFile(join(root, '.claude-plugin/marketplace.json'), market({ version: '0.2.0' }));
  assert.deepEqual(await inspectMetadata(root), ['marketplace: version-mismatch']);
});

test('the installed maa-core carries the plugin version that doctor reports as the skill version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude-plugin')); await mkdir(join(root, 'skills/maa-core'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0-dev.0' }));
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'maa-skills', version: '0.1.0-dev.0' }));
  await writeFile(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'maa-skills', owner: { name: 'example' }, plugins: [{ name: 'maa-skills', source: './' }] }));
  await writeFile(join(root, 'package-lock.json'), lock('0.1.0-dev.0'));
  await writeFile(join(root, 'skills/maa-core/package.json'), JSON.stringify({ type: 'module', private: true, version: '0.0.9' }));
  assert.deepEqual(await inspectMetadata(root), ['maa-core: version-mismatch']);
  await writeFile(join(root, 'skills/maa-core/package.json'), JSON.stringify({ type: 'module', private: true }));
  assert.deepEqual(await inspectMetadata(root), ['maa-core: version-mismatch']);
  const repository = await inspectMetadata(join(import.meta.dirname, '..'));
  assert.equal(repository.includes('maa-core: version-mismatch'), false);
});
