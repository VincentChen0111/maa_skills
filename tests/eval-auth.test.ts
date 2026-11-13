import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authPreflight, childEnvironment, defaultLoginDirectory, isReadProtectionPass, loginDirectoryRefusal, readProtectionCheck } from '../scripts/eval-auth.ts';
import { credentialVariables } from '../scripts/eval-host.ts';
import { createFixture } from '../scripts/eval-fixture.ts';
import { runScenario } from '../scripts/eval-run.ts';
import { coreScenarios } from '../eval/maa-core/scenarios.ts';

const double = fileURLToPath(new URL('../eval/host-double.mjs', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url));
// Never consult the maintainer's real settings or daily host directories: the whole file runs against a synthetic home.
const root = await mkdtemp(join(tmpdir(), 'maa-auth-test-'));
const home = join(root, 'home'); const settings = join(root, 'settings'); const privateDirectory = join(root, 'private');
await mkdir(home); await mkdir(settings);
await writeFile(join(settings, 'config.json'), JSON.stringify({ privateDirectory }));
Object.assign(process.env, { USERPROFILE: home, HOME: home, MAA_SKILLS_HOME: settings });
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
let counter = 0;
const script = async (value: Record<string, unknown>) => { const file = join(root, `script-${counter++}.json`); await writeFile(file, JSON.stringify(value)); return file; };
const login = async () => { const directory = join(root, `login-${counter++}`); await mkdir(directory); await writeFile(join(directory, 'synthetic-login.json'), '{"synthetic":true}'); return directory; };

test('login directories are refused inside the repository, a temporary fixture, the private or settings directory, the daily host directories or each other', async () => {
  assert.equal(homedir(), home);
  assert.equal(await loginDirectoryRefusal(join(repository, 'login')), 'inside-repository');
  assert.equal(await loginDirectoryRefusal(join(privateDirectory, 'login')), 'overlaps-private-directory');
  assert.equal(await loginDirectoryRefusal(root), 'overlaps-private-directory', 'a parent of the private directory mixes them too');
  assert.equal(await loginDirectoryRefusal(join(settings, 'login')), 'overlaps-settings-directory');
  assert.equal(await loginDirectoryRefusal(join(home, '.claude')), 'daily-host-directory');
  assert.equal(await loginDirectoryRefusal(join(home, '.codex', 'nested')), 'daily-host-directory');
  assert.equal(await loginDirectoryRefusal(join(root, 'fixture', 'home', 'login'), { fixtureRoot: join(root, 'fixture') }), 'overlaps-temporary-fixture');
  assert.equal(await loginDirectoryRefusal(join(root, 'eval', 'a'), { otherLoginDirectory: join(root, 'eval', 'a', 'b') }), 'overlaps-other-login-directory');
  assert.equal(await loginDirectoryRefusal('relative/login'), 'not-absolute');
  assert.equal(await loginDirectoryRefusal(join(root, "it's")), 'unsupported-character');
  assert.equal(await loginDirectoryRefusal(join(root, 'eval', 'claude-config')), undefined);
  assert.ok(defaultLoginDirectory('claude').startsWith(home)); assert.equal(await loginDirectoryRefusal(defaultLoginDirectory('codex')), undefined);
  await writeFile(join(settings, 'config.json'), '{"privateDirectory": 3}');
  assert.equal(await loginDirectoryRefusal(join(root, 'eval', 'claude-config')), 'settings-unreadable', 'an unreadable product setting fails closed');
  await writeFile(join(settings, 'config.json'), JSON.stringify({ privateDirectory }));
});

test('plan login strips every API key even when MAA_EVAL keys are set; API-key mode forwards only the explicit key', async (t) => {
  Object.assign(process.env, { MAA_EVAL_ANTHROPIC_API_KEY: 'synthetic-eval-key', ANTHROPIC_API_KEY: 'synthetic-daily-key', MAA_EVAL_OPENAI_API_KEY: 'synthetic-eval-key', OPENAI_API_KEY: 'synthetic-daily-key' });
  t.after(() => { for (const name of ['MAA_EVAL_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'MAA_EVAL_OPENAI_API_KEY', 'OPENAI_API_KEY']) delete process.env[name]; });
  const fixture = await createFixture(); t.after(() => fixture.dispose());
  for (const host of ['claude', 'codex'] as const) {
    assert.deepEqual(credentialVariables(childEnvironment(fixture, host, 'plan', join(root, 'login')), host), []);
    assert.deepEqual(credentialVariables(childEnvironment(fixture, host, 'api-key'), host), [host === 'claude' ? 'ANTHROPIC_API_KEY' : 'CODEX_API_KEY']);
  }
  assert.deepEqual(credentialVariables({ ANTHROPIC_AUTH_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', MAA_EVAL_ANTHROPIC_API_KEY: 'x', PATH: 'x' }, 'claude'),
    ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MAA_EVAL_ANTHROPIC_API_KEY']);
  // A real plan-login run through the double: the host sees its dedicated directory and no key of any kind.
  const directory = await login();
  const environment = join(root, 'environment.jsonl');
  const check = await readProtectionCheck({ host: 'claude', model: 'm', executable: process.execPath, executableArgs: [double, await script({ host: 'claude',
    steps: [{ fileRead: '{{sentinel}}', deny: true }, { shellRead: '{{sentinel}}', deny: true }] })], loginDirectory: directory });
  assert.equal(check.status, 'pass');
  const run = await script({ host: 'claude', environment, steps: [] });
  await runScenario({ host: 'claude', model: 'm', scenario: coreScenarios[2]!, skillDirectory: fileURLToPath(new URL('../skills/maa-core', import.meta.url)),
    executable: process.execPath, executableArgs: [double, run], auth: { mode: 'plan', readProtection: check.pass! }, artifactParent: join(root, 'records') });
  const seen = JSON.parse((await readFile(environment, 'utf8')).trim());
  assert.equal(seen.configDirectory, directory);
  assert.ok(!seen.names.some((name: string) => /API_KEY|AUTH_TOKEN|OAUTH|^MAA_EVAL_/i.test(name)), seen.names.join(','));
});

test('the auth preflight reports each category, keeps status output in memory and never records the login path', async () => {
  const directory = await login();
  const run = async (host: 'claude' | 'codex', value: Record<string, unknown>, extra: { auth?: 'plan' | 'api-key'; loginDirectory?: string } = {}) => {
    const journal = join(root, `journal-${counter++}.jsonl`);
    const result = await authPreflight({ host, model: 'fixed-model', auth: extra.auth ?? 'plan', executable: process.execPath, executableArgs: [double, await script({ host, journal, ...value })],
      loginDirectory: extra.loginDirectory ?? directory });
    assert.ok(!JSON.stringify(result).includes(directory) && !JSON.stringify(result).includes('synthetic-account@example.invalid'));
    let started = 0; try { started = (await readFile(journal, 'utf8')).trim().split('\n').length; } catch { /* never started */ }
    return { ...result, started };
  };
  const plan = { authStatus: { loggedIn: true, authMethod: 'claude.ai' } };
  assert.equal((await authPreflight({ host: 'claude', model: 'm', auth: 'plan', executable: 'maa-synthetic-absent-cli', loginDirectory: directory })).category, 'host-unavailable');
  assert.equal((await run('claude', plan, { loginDirectory: join(root, 'never-created') })).category, 'not-logged-in');
  assert.equal((await run('claude', { authStatus: { loggedIn: false } })).category, 'not-logged-in');
  const key = await run('claude', { authStatus: { loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' } });
  assert.equal(key.category, 'api-key-in-environment'); assert.equal(key.started, 0, 'no model request after a failed status check');
  assert.equal((await run('claude', { authStatus: { loggedIn: true, authMethod: 'oauth_token' } })).detail, 'non-plan-credential');
  assert.equal((await run('claude', { authStatus: { loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: '2000-01-01T00:00:00.000Z' } })).category, 'login-expired');
  for (const [failure, category] of [['login-expired', 'login-expired'], ['not-logged-in', 'not-logged-in'], ['quota', 'quota-exhausted'], ['network', 'network-unavailable']]) {
    const result = await run('claude', { ...plan, failure });
    assert.equal(result.category, category, failure); assert.equal(result.minimalRequest, 'fail');
  }
  const passed = await run('claude', { ...plan, model: 'claude-synthetic-reported' });
  assert.equal(passed.status, 'pass'); assert.equal(passed.minimalRequest, 'pass'); assert.equal(passed.statusCommand, 'plan-login'); assert.deepEqual(passed.reportedModel, ['claude-synthetic-reported']);
  const tooled = await run('claude', { ...plan, init: { tools: ['Read'] } });
  assert.equal(tooled.detail, 'tools-offered');
  assert.equal((await run('codex', { authStatus: 'Not logged in' })).category, 'not-logged-in');
  assert.equal((await run('codex', { authStatus: 'API key configured - sk-synthetic***' })).category, 'api-key-in-environment');
  const codex = await run('codex', { authStatus: 'Logged in using ChatGPT' });
  assert.equal(codex.status, 'pass'); assert.equal(codex.minimalRequest, 'not-supported'); assert.equal(codex.started, 0, 'Codex sends no tool-less request');
  assert.equal((await run('claude', {}, { auth: 'api-key' })).category, 'api-key-missing');
  process.env.MAA_EVAL_ANTHROPIC_API_KEY = 'synthetic-eval-key';
  try { assert.equal((await run('claude', { failure: 'api-key-rejected' }, { auth: 'api-key' })).category, 'api-key-rejected'); }
  finally { delete process.env.MAA_EVAL_ANTHROPIC_API_KEY; }
});

test('the read-protection check needs every required attempt denied, keeps the value out of output and always removes its sentinel', async () => {
  const cases: [string, 'claude' | 'codex', Record<string, unknown>, string | undefined][] = [
    ['claude both denied', 'claude', { steps: [{ fileRead: '{{sentinel}}', deny: true }, { shellRead: '{{sentinel}}', deny: true }] }, undefined],
    ['claude file tool reads it', 'claude', { steps: [{ fileRead: '{{sentinel}}' }, { shellRead: '{{sentinel}}', deny: true }] }, 'read-protection-failed'],
    ['claude command reads it', 'claude', { steps: [{ fileRead: '{{sentinel}}', deny: true }, { shellRead: '{{sentinel}}' }] }, 'read-protection-failed'],
    ['claude skips the command', 'claude', { steps: [{ fileRead: '{{sentinel}}', deny: true }] }, 'read-protection-failed'],
    ['claude answers without tools', 'claude', { steps: [] }, 'read-protection-failed'],
    ['claude login expired', 'claude', { steps: [], failure: 'login-expired' }, 'login-expired'],
    ['codex command denied', 'codex', { steps: [{ shellRead: '{{sentinel}}', deny: true }] }, undefined],
    ['codex command reads it', 'codex', { steps: [{ shellRead: '{{sentinel}}' }] }, 'read-protection-failed'],
    ['codex quota', 'codex', { steps: [], failure: 'quota' }, 'quota-exhausted'],
  ];
  for (const [name, host, value, category] of cases) {
    const directory = await login();
    const artifacts = join(root, `artifacts-${counter++}`); await mkdir(artifacts);
    const result = await readProtectionCheck({ host, model: 'm', executable: process.execPath, executableArgs: [double, await script({ host, ...value })], loginDirectory: directory, artifactDirectory: artifacts });
    assert.equal(result.status, category ? 'fail' : 'pass', name);
    if (category) assert.equal(result.category, category, name);
    assert.equal(result.sentinelRemoved, true, name);
    assert.deepEqual(await readdir(directory), ['synthetic-login.json'], `${name}: nothing but the login remains`);
    assert.equal(isReadProtectionPass(result.pass, host), !category, name);
    if (host === 'codex') assert.equal(result.fileToolAttempt, 'not-applicable');
    for (const file of await readdir(artifacts)) {
      const saved = await readFile(join(artifacts, file), 'utf8');
      assert.ok(!saved.includes(directory) && !saved.includes(directory.replaceAll('\\', '\\\\')) && !/maa-eval-sentinel-value-[0-9a-f]/.test(saved), `${name}: ${file}`);
    }
  }
});

test('the daily host directories are never the host configuration, never copied and never echoed into records', async () => {
  const marker = 'synthetic-daily-credential-marker';
  for (const [directory, file] of [['.claude', '.credentials.json'], ['.codex', 'auth.json']] as const) {
    await mkdir(join(home, directory), { recursive: true }); await writeFile(join(home, directory, file), JSON.stringify({ marker }));
  }
  const before = await Promise.all([readFile(join(home, '.claude/.credentials.json'), 'utf8'), readFile(join(home, '.codex/auth.json'), 'utf8')]);
  for (const host of ['claude', 'codex'] as const) {
    const directory = await login();
    const environment = join(root, `daily-${host}.jsonl`);
    const check = await readProtectionCheck({ host, model: 'm', executable: process.execPath, loginDirectory: directory,
      executableArgs: [double, await script({ host, environment, steps: [{ fileRead: '{{sentinel}}', deny: true }, { shellRead: '{{sentinel}}', deny: true }] })] });
    const run = await runScenario({ host, model: 'm', scenario: coreScenarios[2]!, skillDirectory: fileURLToPath(new URL('../skills/maa-core', import.meta.url)),
      executable: process.execPath, executableArgs: [double, await script({ host, environment, steps: [] })], auth: { mode: 'plan', readProtection: check.pass! }, artifactParent: join(root, 'records') });
    for (const line of (await readFile(environment, 'utf8')).trim().split('\n')) assert.equal(JSON.parse(line).configDirectory, directory, 'the host only ever sees its dedicated directory');
    for (const file of await readdir(run.artifactDirectory)) assert.ok(!(await readFile(join(run.artifactDirectory, file), 'utf8')).includes(marker));
    assert.deepEqual(await readdir(directory), ['synthetic-login.json'], 'nothing was copied into the login directory');
  }
  assert.deepEqual(await Promise.all([readFile(join(home, '.claude/.credentials.json'), 'utf8'), readFile(join(home, '.codex/auth.json'), 'utf8')]), before);
});
