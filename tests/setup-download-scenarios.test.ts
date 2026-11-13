import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { createFixture, collectEvidence, type Fixture } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { setupDownloadScenarios, setupDownloadRoutes, setupScenarios } from '../eval/maa-setup/scenarios.ts';

const skillDirectory = fileURLToPath(new URL('../skills/maa-setup', import.meta.url));
const companionSkills = { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) };
const scenario = (id: string) => setupDownloadScenarios.find(item => item.id === id)!;
async function open(t: { after: (fn: () => Promise<unknown>) => void }, id: string) {
  const definition = scenario(id);
  const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: definition.jsonInputs, jsonFiles: definition.jsonFiles,
    ...(definition.networkFixtures ? { networkFixtures: definition.networkFixtures } : {}) });
  t.after(() => fixture.dispose());
  return { definition, fixture };
}
function cli(fixture: Fixture, host: string, script: string, action: string, input: unknown) {
  const result = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts', script), action, ...(script === 'setup.ts' ? ['--json'] : [])],
    { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
  assert.ok(result.stdout.trim(), result.stderr);
  return { code: result.status, value: JSON.parse(result.stdout.trim().split('\n').at(-1)!), stdout: result.stdout };
}

test('download scenarios pass for a compliant run in both layouts: plans are shown, nothing is downloaded or written', async t => {
  for (const host of ['.agents', '.claude']) for (const definition of setupDownloadScenarios) await t.test(`${host} ${definition.id}`, async t => {
    const { fixture } = await open(t, definition.id);
    const outputs = [cli(fixture, host, 'preferences.ts', 'read', { currentLanguage: 'zh-CN' }).stdout];
    const check = cli(fixture, host, 'setup.ts', 'check', {}); assert.equal(check.code, 1); outputs.push(check.stdout);
    const expected = definition.policy.expectedInvocations!.map(item => item.action);
    if (expected.includes('plan')) {
      const plan = cli(fixture, host, 'setup.ts', 'plan', { program: 'maa' }); outputs.push(plan.stdout);
      if (process.platform === 'win32') {
        assert.equal(plan.value.status, 'planned'); assert.equal(plan.value.version, '9.1.0'); assert.equal(plan.value.sizeKnown, true);
        assert.match(plan.value.source, /^https:\/\/github\.com\/MaaAssistantArknights\/MaaAssistantArknights\/releases\/download\/v9\.1\.0\//);
      } else assert.equal(plan.value.reason, 'windows-required');
    }
    if (expected.includes('downloads')) {
      const status = cli(fixture, host, 'setup.ts', 'downloads', {}); outputs.push(status.stdout);
      assert.deepEqual(status.value.items.map((item: { status: string }) => item.status), ['interrupted']);
    }
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs });
    assert.deepEqual(evidence.changes, []);
    assert.equal(evidence.events.filter(event => event.kind === 'download').length, 0);
    const actual = grade({ ...definition.policy, secrets: fixture.policy.secrets }, evidence);
    assert.equal(actual.status, 'pass', JSON.stringify(actual));
  });
});

test('a run that downloads without a confirmation of the shown plan fails the download and authorization rules', { skip: process.platform !== 'win32' }, async t => {
  for (const id of ['setup-download-install-request-is-not-consent', 'setup-download-old-approval']) await t.test(id, async t => {
    const { definition, fixture } = await open(t, id);
    const outputs = [cli(fixture, '.agents', 'preferences.ts', 'read', { currentLanguage: 'zh-CN' }).stdout, cli(fixture, '.agents', 'setup.ts', 'check', {}).stdout];
    const plan = cli(fixture, '.agents', 'setup.ts', 'plan', { program: 'maa' }); outputs.push(plan.stdout);
    const download = cli(fixture, '.agents', 'setup.ts', 'download', { program: 'maa', planId: plan.value.planId, fingerprint: plan.value.fingerprint,
      reference: 'the install request' });
    assert.equal(download.value.status, 'downloaded', 'the script cannot see the conversation; the scenario grader catches this');
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [...outputs, download.stdout] });
    const actual = grade({ ...definition.policy, secrets: fixture.policy.secrets }, evidence);
    assert.equal(actual.status, 'fail');
    assert.ok(actual.failed.includes('download-confirmation') && actual.failed.includes('authorization'), JSON.stringify(actual));
  });
});

test('installed CLI downloads only a confirmed plan through the network double and never reuses it', { skip: process.platform !== 'win32' }, async t => {
  for (const host of ['.agents', '.claude']) await t.test(host, async t => {
    const { fixture } = await open(t, 'setup-download-declined');
    const plan = cli(fixture, host, 'setup.ts', 'plan', { program: 'maa' }); assert.equal(plan.code, 0);
    const base = { program: 'maa', planId: plan.value.planId, fingerprint: plan.value.fingerprint };
    const unconfirmed = cli(fixture, host, 'setup.ts', 'download', base);
    assert.deepEqual([unconfirmed.code, unconfirmed.value.reason], [1, 'confirmation-required']);
    const injected = cli(fixture, host, 'setup.ts', 'download', { ...base, reference: 'yes', target: join(fixture.workspace, 'synthetic') });
    assert.deepEqual([injected.code, injected.value.reason], [1, 'request-invalid']);
    const events = async () => (await readFile(join(fixture.workspace, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal((await events()).filter(event => event.kind === 'download').length, 0);
    const done = cli(fixture, host, 'setup.ts', 'download', { ...base, reference: '确认下载 MAA-v9.1.0-win-x64.zip' });
    assert.equal(done.code, 0, done.stdout); assert.equal(done.value.status, 'downloaded');
    const fileName = Object.keys(setupDownloadRoutes).find(url => url.endsWith(done.value.fileName))!;
    assert.deepEqual((await events()).filter(event => event.kind === 'download').map(event => event.url), [fileName]);
    assert.equal(cli(fixture, host, 'setup.ts', 'download', { ...base, reference: '确认下载 MAA-v9.1.0-win-x64.zip' }).value.reason, 'plan-already-used');
    assert.equal((await events()).filter(event => event.kind === 'download').length, 1);
    const status = cli(fixture, host, 'setup.ts', 'downloads', {});
    assert.deepEqual(status.value.items.map((item: { status: string }) => item.status), ['downloaded']);
    assert.ok((await readdir(join(fixture.workspace, 'private/downloads'))).includes(done.value.fileName));
    assert.doesNotMatch(plan.stdout + done.stdout + status.stdout, /maa-evaluation-|确认下载/);
    const replan = cli(fixture, host, 'setup.ts', 'plan', { program: 'maa' });
    assert.equal(replan.value.status, 'already-downloaded');
    const unofficial = cli(fixture, host, 'setup.ts', 'plan', { program: 'emulator', vendor: 'mumu', url: 'https://mumu.example.invalid/setup.exe', version: '4.0' });
    assert.deepEqual([unofficial.code, unofficial.value.reason], [1, 'unofficial-source']);
  });
});

test('installed CLI recheck after a real connection write finds the chosen candidate afresh and reports complete', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await createFixture({ skillDirectory, companionSkills, jsonFiles: ['private/config.json', 'config/gui.new.json'],
    jsonInputs: { ...setupScenarios[0]!.jsonInputs, 'synthetic-adb.exe': { synthetic: true } } });
  t.after(() => fixture.dispose());
  const core = join(fixture.workspace, '.claude/skills/maa-core');
  const env = { ...fixture.env, MAA_SETUP_TEST_CORE: core, MAA_SETUP_TEST_WORKSPACE: fixture.workspace };
  const run = (action: string, input: unknown) => {
    const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/setup-boundary.mjs', import.meta.url).href, join(core, 'scripts/setup.ts'), action, '--json'],
      { cwd: fixture.workspace, env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
    assert.ok(result.stdout.trim(), result.stderr); return { code: result.status, value: JSON.parse(result.stdout) };
  };
  const context = { adbPaths: [join(fixture.workspace, 'synthetic-adb.exe')], addresses: ['127.0.0.1:5555'] };
  assert.equal(run('prepare', {}).code, 0);
  const found = run('discover', context); const candidate = found.value.candidates[0].id;
  assert.equal(run('test', { ...context, discoveryRevision: found.value.discoveryRevision, candidate }).value.status, 'connected');
  const applied = run('apply', { ...context, discoveryRevision: found.value.discoveryRevision, candidate, host: 'claude', reference: 'synthetic connection request', closedConfirmed: true });
  assert.equal(applied.value.status, 'complete');
  const stale = run('recheck', { ...context, discoveryRevision: found.value.discoveryRevision, candidate });
  assert.deepEqual([stale.code, stale.value.reason], [1, 'request-invalid'], 'a discovery revision is not accepted by recheck');
  const recheck = run('recheck', { ...context, candidate });
  assert.equal(recheck.code, 0, JSON.stringify(recheck.value));
  assert.deepEqual([recheck.value.connection.status, recheck.value.complete, recheck.value.pending], ['connected', true, []]);
  const saved = JSON.parse(await readFile(join(fixture.workspace, 'private/setup-environment.json'), 'utf8'));
  assert.deepEqual([saved.complete, saved.connection.status], [true, 'connected']);
});
