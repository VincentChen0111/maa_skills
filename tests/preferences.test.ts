import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSettings, readSettings } from '../skills/maa-help/scripts/preferences.ts';

const command = fileURLToPath(new URL('../skills/maa-help/scripts/preferences.ts', import.meta.url));

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
