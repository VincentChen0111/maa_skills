import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectPrivacy } from '../scripts/privacy.ts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('privacy check blocks private paths without returning their contents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privatePath = ['C:', 'Users', 'synthetic-player', 'private.json'].join('\\');
  await writeFile(join(root, 'sample.md'), `private file: ${privatePath}`);
  const findings = await inspectPrivacy(root);
  assert.deepEqual(findings, [{ file: 'sample.md', line: 1, rule: 'private-path' }]);
  assert.ok(!JSON.stringify(findings).includes('synthetic-player'));
});

test('privacy scans tracked ignored files but ignores untracked build artifacts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
  await writeFile(join(root, '.gitignore'), '.tmp/\n');
  await mkdir(join(root, '.tmp'));
  await writeFile(join(root, '.tmp', 'sample.txt'), ['PRIVATE', 'ACCOUNT', 'MARKER'].join('_'));
  assert.deepEqual(await inspectPrivacy(root), []);
  assert.equal(spawnSync('git', ['-C', root, 'add', '-f', '.tmp/sample.txt']).status, 0);
  assert.equal((await inspectPrivacy(root))[0]?.rule, 'account-marker');
});

test('privacy CLI blocks credentials and account markers but accepts public guidance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = fileURLToPath(new URL('../scripts/privacy.ts', import.meta.url));
  const secret = ['synthetic', 'secret', 'value'].join('-');
  for (const key of ['token', 'Cookie', 'password', 'uid', 'accountId']) {
    await writeFile(join(root, 'sample.json'), JSON.stringify({ [key]: secret }));
    const result = spawnSync(process.execPath, [command, root], { encoding: 'utf8' });
    assert.equal(result.status, 1, key);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  }
  await writeFile(join(root, 'sample.json'), ['PRIVATE', 'ACCOUNT', 'MARKER'].join('_'));
  assert.equal((await inspectPrivacy(root))[0]?.rule, 'account-marker');
  await writeFile(join(root, 'sample.json'), 'Use %USERPROFILE%/.maa-skills; never print tokens. Example: token=<redacted> https://github.com/example/repo');
  assert.deepEqual(await inspectPrivacy(root), []);
});

test('public redaction and TypeScript declarations pass without hiding assigned secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const content of ['Authorization: Bearer <redacted>', '`Authorization: Bearer <redacted>`', 'const token: string = getToken();', 'token: string;', 'const token = process.env.TEST_TOKEN;', 'token=${TEST_VALUE}']) {
    await writeFile(join(root, 'sample.txt'), content);
    assert.deepEqual(await inspectPrivacy(root), [], content);
  }
  const secret = ['synthetic', 'credential'].join('-');
  for (const content of [`const token: string = '${secret}';`, `Authorization: Bearer ${secret}`, `token=${secret}`]) {
    await writeFile(join(root, 'sample.txt'), content);
    assert.equal((await inspectPrivacy(root))[0]?.rule, 'credential');
  }
  for (const suffix of ['!', ':tail', '@x/y', '(punctuation)']) {
    await writeFile(join(root, 'sample.txt'), `password=${secret}${suffix}`);
    assert.equal((await inspectPrivacy(root))[0]?.rule, 'credential', suffix);
  }
});
