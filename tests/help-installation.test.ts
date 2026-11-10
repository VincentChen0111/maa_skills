import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, unlink, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { helpScenarios } from '../eval/maa-help/scenarios.ts';

test('both temporary native layouts can execute the single packaged preferences implementation', async (t) => {
  const skillDirectory = fileURLToPath(new URL('../skills/maa-help', import.meta.url));
  const scenario = helpScenarios[0]!;
  for (const host of ['.agents', '.claude']) {
    const fixture = await createFixture({ skillDirectory, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => fixture.dispose());
    const script = join(fixture.workspace, host, 'skills/subject/scripts/preferences.ts');
    const outputs: string[] = [];
    for (const [action, input] of [
      ['read', { currentLanguage: 'zh-CN' }],
      ['set', { language: 'en' }],
      ['append', { date: '2026-11-10T06:00:00.000Z', source: 'synthetic-help-case', text: '以后用英文' }],
    ] as const) {
      const result = spawnSync(process.execPath, [script, action], { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).ok, true, 'successful CLI calls must produce a response');
      outputs.push(result.stdout);
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs });
    const result = grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence);
    assert.equal(result.status, 'pass', JSON.stringify({ result, events: evidence.events }));
  }
});

test('the documented development directory junction executes the preferences CLI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-help-junction-'));
  const installed = join(root, 'skills/maa-help');
  await mkdir(join(root, 'skills'));
  await symlink(fileURLToPath(new URL('../skills/maa-help', import.meta.url)), installed, 'junction');
  t.after(async () => { await unlink(installed); await rm(root, { recursive: true, force: true }); });
  const result = spawnSync(process.execPath, [join(installed, 'scripts/preferences.ts'), 'read'], {
    input: '{"currentLanguage":"en"}', encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root, MAA_SKILLS_HOME: join(root, 'settings') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).language, 'en');
});

test('the exported preferences interface remains importable from standard input', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: "import { readSettings } from './skills/maa-help/scripts/preferences.ts'; console.log(typeof readSettings);",
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'function');
});

test('Windows short-path aliases execute the installed preferences entrypoint', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-help', import.meta.url)) });
  t.after(() => fixture.dispose());
  const alias = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:MAA_TEST_LONG_PATH).ShortPath'], {
    cwd: fixture.workspace,
    env: { ...fixture.env, MAA_TEST_LONG_PATH: fixture.workspace, PSModuleAnalysisCachePath: join(fixture.root, 'home/tmp/powershell-cache') },
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(alias.status, 0, alias.stderr);
  const shortWorkspace = alias.stdout.trim();
  if (shortWorkspace === fixture.workspace) { t.skip('This filesystem does not provide short-path aliases.'); return; }
  const result = spawnSync(process.execPath, [join(shortWorkspace, '.agents/skills/subject/scripts/preferences.ts'), 'read'], {
    cwd: fixture.workspace, env: fixture.env, input: '{"currentLanguage":"en"}', encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).language, 'en');
});

test('help grading rejects expected file changes made without the preferences script', async (t) => {
  const scenario = helpScenarios[0]!;
  const fixture = await createFixture({ jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
  t.after(() => fixture.dispose());
  const configFile = join(fixture.workspace, 'private/config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  await writeFile(configFile, JSON.stringify({ ...config, language: 'en', languageAsked: true }));
  const expected = scenario.policy.expectedChanges.find((change) => change.file === 'private/preferences.jsonl')!;
  await writeFile(join(fixture.workspace, expected.file), Buffer.from(String(expected.value), 'base64'));
  const evidence = await collectEvidence(fixture, { completed: true, calls: [{ tool: 'file_change', input: 'direct edits', succeeded: true }], outputs: [] });
  const result = grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.failed, ['expected-behavior']);
});
