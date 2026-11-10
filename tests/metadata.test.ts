import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectMetadata } from '../scripts/metadata.ts';

test('metadata checker catches broken local links and plugin version drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude-plugin'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0-dev.0' }));
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'maa-skills', version: '0.1.0-dev.0' }));
  await writeFile(join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'maa-skills', owner: { name: 'example' }, plugins: [{ name: 'maa-skills', source: './' }] }));
  await writeFile(join(root, 'README.md'), '[missing](missing.md)');
  assert.ok((await inspectMetadata(root)).some((error) => error.includes('broken-link')));
  await writeFile(join(root, 'README.md'), '[package](package.json)');
  assert.deepEqual(await inspectMetadata(root), []);
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'maa-skills', version: '0.2.0' }));
  assert.ok((await inspectMetadata(root)).some((error) => error.includes('version-mismatch')));
});
