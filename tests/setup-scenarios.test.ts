import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { setupScenarios } from '../eval/maa-setup/scenarios.ts';
import { runSetupSmoke } from '../scripts/setup-smoke.ts';

test('setup scenarios observe installed check and preference CLI behavior in both native layouts', async (t) => {
  for (const host of ['.agents', '.claude']) for (const scenario of setupScenarios) await t.test(`${host} ${scenario.id}`, async t => {
    const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-setup', import.meta.url)),
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => fixture.dispose());
    const calls: [string, string, unknown][] = [['preferences.ts', 'read', { currentLanguage: 'zh-CN' }], ['setup.ts', 'check', {}]];
    if (scenario.id === 'setup-first-preferences') calls.push(['preferences.ts', 'set', { language: 'en' }], ['preferences.ts', 'read', { currentLanguage: 'zh-CN' }]);
    const outputs: string[] = [];
    for (const [script, action, input] of calls) {
      const result = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', script), action, ...(script === 'setup.ts' ? ['--json'] : [])],
        { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, script === 'setup.ts' && (scenario.id === 'setup-missing-program' || process.platform !== 'win32') ? 1 : 0, result.stdout + result.stderr);
      outputs.push(result.stdout);
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs });
    const actual = grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence);
    assert.equal(actual.status, 'pass', JSON.stringify(actual));
  });
});

test('installed setup CLI applies a selected synthetic connection through the real writer in both layouts', { skip: process.platform !== 'win32' }, async t => {
  for (const host of ['.agents', '.claude']) await t.test(host, async t => {
    const sample = setupScenarios[0]!;
    const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-setup', import.meta.url)),
      companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) },
      jsonInputs: { ...sample.jsonInputs, 'synthetic-adb.exe': { synthetic: true } }, jsonFiles: sample.jsonFiles });
    t.after(() => fixture.dispose());
    const core = join(fixture.workspace, host, 'skills/maa-core');
    const loader = new URL('./fixtures/setup-boundary.mjs', import.meta.url).href;
    const env = { ...fixture.env, MAA_SETUP_TEST_CORE: core, MAA_SETUP_TEST_WORKSPACE: fixture.workspace };
    const run = (action: string, input: unknown) => {
      const result = spawnSync(process.execPath, ['--import', loader, join(core, 'scripts/setup.ts'), action, '--json'],
        { cwd: fixture.workspace, env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
      assert.ok(result.stdout.trim(), result.stderr); return { code: result.status, value: JSON.parse(result.stdout) };
    };
    const context = { adbPaths: [join(fixture.workspace, 'synthetic-adb.exe')], addresses: ['127.0.0.1:5555'] };
    const found = run('discover', context); assert.equal(found.code, 0); assert.equal(found.value.candidates.length, 1);
    const selection = { ...context, discoveryRevision: found.value.discoveryRevision, candidate: found.value.candidates[0].id };
    assert.equal(run('test', selection).value.status, 'connected');
    const request = { ...selection, host: host === '.claude' ? 'claude' : 'codex', reference: 'synthetic native installation request' };
    const refused = run('apply', request); assert.equal(refused.code, 1); assert.equal(refused.value.reason, 'closed-confirmation-required');
    assert.equal(run('apply', { ...request, closedConfirmed: true }).value.status, 'complete');
    const config = JSON.parse(await readFile(join(fixture.workspace, 'config/gui.new.json'), 'utf8'));
    assert.deepEqual(config.Configurations['Synthetic profile'].Gui.ConnectSettings, {
      AdbPath: context.adbPaths[0], Address: '127.0.0.1:5555', AddressHistory: [], AutoDetect: false, AlwaysAutoDetect: false,
    });
    assert.equal((await readdir(join(fixture.workspace, 'private/maa-config-backups'))).length, 1);
    const again = run('discover', context);
    assert.equal(run('apply', { ...request, discoveryRevision: again.value.discoveryRevision }).value.status, 'unchanged');
    assert.equal(run('prepare', {}).code, 0);
    const commands = (await readFile(join(fixture.workspace, '.setup-boundary.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(commands.filter(item => item.kind === 'maa-start').length, 1);
    assert.equal(commands.filter(item => item.kind === 'adb').every(item => ['devices', 'connect', '-s'].includes(item.args[0])), true);
  });
});

test('the public native smoke validates first settings and connection writes without changing the installation', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-setup', import.meta.url)),
    companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) } });
  t.after(() => fixture.dispose());
  const result = await runSetupSmoke(join(fixture.workspace, '.agents/skills/maa-core'), 'claude');
  assert.equal(result.status, 'pass'); assert.equal(result.realDevice, false); assert.equal(result.transactionHost, 'claude');
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  assert.deepEqual(evidence.changes, []);
});
