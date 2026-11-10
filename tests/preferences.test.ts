import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, mkdir, writeFile, chmod, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSettings, readSettings } from '../skills/maa-core/scripts/preferences.ts';

const command = fileURLToPath(new URL('../skills/maa-core/scripts/preferences.ts', import.meta.url));

test('preferences CLI persists language atomically while preserving unrelated settings', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'maa-preferences-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configHome = join(home, 'settings');
  const invoke = (action: string, input: unknown = {}) => spawnSync(process.execPath, [command, action], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, MAA_SKILLS_HOME: configHome },
  });
  const initial = invoke('read', { currentLanguage: 'zh-CN' });
  assert.equal(initial.status, 0, initial.stderr);
  assert.deepEqual(JSON.parse(initial.stdout), { ok: true, language: 'zh-CN', languageAsked: false, needsLanguagePrompt: true, hasMaaDirectory: false, server: 'CN' });
  assert.equal(invoke('set', { languageAsked: true }).status, 0);
  const askedWithoutChoice = JSON.parse(invoke('read', { currentLanguage: 'zh-CN' }).stdout);
  assert.equal(askedWithoutChoice.languageAsked, true);
  assert.equal(askedWithoutChoice.needsLanguagePrompt, true, 'an unset language still needs the availability hint, while setup can avoid asking twice');
  assert.equal(invoke('set', { language: 'en', maaDirectory: join(home, 'sample-maa') }).status, 0);
  const saved = JSON.parse(await readFile(join(configHome, 'config.json'), 'utf8'));
  assert.equal(saved.language, 'en');
  assert.equal(saved.languageAsked, true);
  assert.equal(saved.privateDirectory, configHome);
  assert.equal(saved.server, 'CN');
  assert.equal(JSON.parse(invoke('read', { currentLanguage: 'zh-CN' }).stdout).language, 'en');
  assert.equal(invoke('set', { privateDirectory: join(home, 'private') }).status, 0);
  const changed = JSON.parse(await readFile(join(configHome, 'config.json'), 'utf8'));
  assert.equal(changed.maaDirectory, saved.maaDirectory);
  assert.equal(changed.language, 'en');
  const before = await readFile(join(configHome, 'config.json'));
  assert.equal(invoke('set', { queue: ['1-7'] }).status, 1);
  assert.deepEqual(await readFile(join(configHome, 'config.json')), before);
  assert.deepEqual(await readdir(configHome), ['config.json']);
});

test('concurrent successful preference patches cannot silently overwrite each other', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'maa-preferences-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await updateSettings({ languageAsked: true }, home);
  const patches = [{ language: 'en' }, { maaDirectory: join(home, 'sample-maa') }];
  const results = await Promise.allSettled(patches.map((patch) => updateSettings(patch, home)));
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      assert.match(String(result.reason), /preferences-busy/);
      await updateSettings(patches[index], home);
    }
  }
  const settings = await readSettings(home);
  assert.equal(settings.language, 'en');
  assert.equal(settings.maaDirectory, join(home, 'sample-maa'));
});

test('Windows replacement failure preserves the old settings and removes temporary files', { skip: process.platform !== 'win32' }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'maa-preferences-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await updateSettings({ language: 'en' }, home);
  const file = join(home, 'config.json');
  const before = await readFile(file);
  await chmod(file, 0o444);
  try {
    await assert.rejects(updateSettings({ language: 'zh-CN' }, home), /EPERM|EACCES/);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(home), ['config.json']);
  } finally { await chmod(file, 0o600); }
});

test('preferences append dated original text without changing earlier entries or MAA files', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'maa-preferences-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configHome = join(home, 'settings');
  const privateDirectory = join(home, 'private');
  const maaDirectory = join(home, 'maa');
  await mkdir(maaDirectory);
  await writeFile(join(maaDirectory, 'gui.json'), 'synthetic-MAA-unchanged');
  const invoke = (action: string, input: unknown) => spawnSync(process.execPath, [command, action], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, MAA_SKILLS_HOME: configHome },
  });
  assert.equal(invoke('set', { privateDirectory, maaDirectory }).status, 0);
  const first = { date: '2026-11-10T06:00:00.000Z', source: 'synthetic-chat-1', text: '  以后用英文\n原话保留。  ' };
  assert.equal(invoke('append', first).status, 0);
  const previous = await readFile(join(privateDirectory, 'preferences.jsonl'), 'utf8');
  const second = { date: '2026-11-10T06:01:00.000Z', source: 'synthetic-chat-2', text: '今天只改语言。' };
  const result = invoke('append', second);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(second.text));
  const current = await readFile(join(privateDirectory, 'preferences.jsonl'), 'utf8');
  assert.ok(current.startsWith(previous));
  assert.deepEqual(current.trimEnd().split('\n').map((line) => JSON.parse(line)), [first, second]);
  assert.equal(invoke('append', { ...second, filename: 'account.json' }).status, 1);
  assert.equal(await readFile(join(privateDirectory, 'preferences.jsonl'), 'utf8'), current);
  assert.deepEqual(await readdir(privateDirectory), ['preferences.jsonl']);
  assert.equal(await readFile(join(maaDirectory, 'gui.json'), 'utf8'), 'synthetic-MAA-unchanged');
});

const cli = (home: string, action: string, input: unknown) => spawnSync(process.execPath, [command, action], {
  input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, MAA_SKILLS_HOME: home },
});
const lockOf = (home: string) => join(home, '.preferences.lock');

test('a preferences lock left behind by an exited or long-gone writer is taken over', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'maa-preferences-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const exited = spawnSync(process.execPath, ['-e', '']).pid;
  const minuteAgo = new Date(Date.now() - 60_000);
  // Exited holder; live PID that cannot still be writing (PID reuse); crash before the holder was recorded.
  await writeFile(lockOf(home), JSON.stringify({ pid: exited, startedAt: new Date().toISOString() }));
  const first = cli(home, 'set', { language: 'en' });
  assert.equal(first.status, 0, first.stderr);
  await writeFile(lockOf(home), JSON.stringify({ pid: process.pid, startedAt: minuteAgo.toISOString() }));
  const second = cli(home, 'set', { languageAsked: true });
  assert.equal(second.status, 0, second.stderr);
  await writeFile(lockOf(home), '');
  await utimes(lockOf(home), minuteAgo, minuteAgo);
  const third = cli(home, 'append', { text: '以后用英文', source: 'synthetic-stale-lock' });
  assert.equal(third.status, 0, third.stderr);
  assert.equal((await readSettings(home)).language, 'en');
  assert.deepEqual((await readdir(home)).sort(), ['config.json', 'preferences.jsonl']);
});

test('a preferences lock held by a running writer is left alone', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'maa-preferences-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const held of [JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), '']) {
    await writeFile(lockOf(home), held);
    const result = cli(home, 'set', { language: 'en' });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: 'preferences-busy' });
    assert.equal(await readFile(lockOf(home), 'utf8'), held);
    assert.deepEqual(await readdir(home), ['.preferences.lock']);
  }
});

test('rejected input is reported as not written, apart from failures that need a readback', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'maa-preferences-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [action, input] of [['set', { language: '' }], ['set', { language: 'not a tag' }], ['set', { queue: ['1-7'] }], ['append', { text: 'x', source: 'synthetic', date: 'yesterday' }], ['append', { text: '', source: 'synthetic' }], ['erase', {}]] as const) {
    const result = cli(home, action, input);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: 'invalid-input' });
  }
  assert.deepEqual(await readdir(home), []);
  await writeFile(join(home, 'config.json'), '{"language":');
  const unreadable = cli(home, 'set', { language: 'en' });
  assert.equal(unreadable.status, 1);
  assert.deepEqual(JSON.parse(unreadable.stderr), { ok: false, error: 'preferences-check-required' });
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), '{"language":');
});

test('writers racing to take over a stale lock never lose a reported change', async (t) => {
  const run = (home: string, input: unknown) => new Promise<{ status: number | null; stderr: string }>((done) => {
    const child = spawn(process.execPath, [command, 'set'], { env: { ...process.env, HOME: home, USERPROFILE: home, MAA_SKILLS_HOME: home } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => done({ status, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
  const exited = spawnSync(process.execPath, ['-e', '']).pid;
  for (let trial = 0; trial < 20; trial += 1) {
    const home = await mkdtemp(join(tmpdir(), 'maa-preferences-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    await writeFile(lockOf(home), JSON.stringify({ pid: exited, startedAt: new Date().toISOString() }));
    const patches = [{ language: 'en' }, { maaDirectory: join(home, 'sample-maa') }];
    const results = await Promise.all(patches.map((patch) => run(home, patch)));
    for (const [index, result] of results.entries()) {
      if (result.status === 0) continue;
      assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: 'preferences-busy' }, `trial ${trial}`);
      assert.equal(cli(home, 'set', patches[index]).status, 0);
    }
    const settings = await readSettings(home);
    assert.equal(settings.language, 'en', `trial ${trial}`);
    assert.equal(settings.maaDirectory, join(home, 'sample-maa'), `trial ${trial}`);
    assert.deepEqual((await readdir(home)).sort(), ['config.json']);
  }
});
