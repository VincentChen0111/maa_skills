import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authPreflight, childEnvironment, defaultLoginDirectory, isReadProtectionPass, loginDirectoryRefusal, payloadDirectoryRefusal, readProtectionCheck } from '../scripts/eval-auth.ts';
import { codexPermissionArguments, credentialVariables } from '../scripts/eval-host.ts';
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
const configurePrivate = (value: string) => writeFile(join(settings, 'config.json'), JSON.stringify({ privateDirectory: value }));
/** The 8.3 short form Windows gives an existing path; undefined where there is none (not Windows, or short names off on the volume). */
function shortForm(path: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const result = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${path}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true });
  const short = result.status === 0 ? result.stdout.trim() : '';
  return short && short.toLowerCase() !== path.toLowerCase() ? short : undefined;
}
const longRoot = realpathSync.native(root); const shortRoot = shortForm(longRoot);

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
  process.env.MAA_EVAL_CODEX_LOGIN_DIR = join(root, 'eval', 'shared');
  assert.equal(await loginDirectoryRefusal(join(root, 'eval', 'shared', 'claude'), { host: 'claude' }), 'overlaps-other-login-directory', 'the other host directory comes from its own variable');
  delete process.env.MAA_EVAL_CODEX_LOGIN_DIR;
  // A batch's payload directory stands where the checkout stands, either way round (payloads: tests/eval-payload.test.ts).
  assert.equal(await loginDirectoryRefusal(join(root, 'payload', 'login'), { payloadDirectory: join(root, 'payload') }), 'overlaps-payload-directory');
  assert.equal(await loginDirectoryRefusal(join(root, 'outer'), { payloadDirectory: join(root, 'outer', 'payload') }), 'overlaps-payload-directory');
  assert.equal(await payloadDirectoryRefusal(join(root, 'eval', 'claude-config', 'payload'), { loginDirectories: [join(root, 'eval', 'claude-config')] }), 'overlaps-login-directory');
  assert.equal(await payloadDirectoryRefusal(join(privateDirectory, 'payload')), 'overlaps-private-directory');
  assert.equal(await payloadDirectoryRefusal(join(repository, 'payload')), 'inside-repository');
  assert.equal(await payloadDirectoryRefusal(join(root, 'payload')), undefined);
  assert.equal(await loginDirectoryRefusal('relative/login'), 'not-absolute');
  assert.equal(await loginDirectoryRefusal(join(root, "it's")), 'unsupported-character');
  assert.equal(await loginDirectoryRefusal(join(root, 'eval', 'claude-config')), undefined);
  assert.ok(defaultLoginDirectory('claude').startsWith(home)); assert.equal(await loginDirectoryRefusal(defaultLoginDirectory('codex')), undefined);
  await writeFile(join(settings, 'config.json'), '{"privateDirectory": 3}');
  assert.equal(await loginDirectoryRefusal(join(root, 'eval', 'claude-config')), 'settings-unreadable', 'an unreadable product setting fails closed');
  await writeFile(join(settings, 'config.json'), JSON.stringify({ privateDirectory }));
});

test('the overlap check compares long forms: through a junction, and for a path that does not exist yet, it still refuses; private is reported before settings', async (t) => {
  t.after(() => configurePrivate(privateDirectory));
  const real = join(root, 'canonical-real-directory'); const link = join(root, 'canonical-link');
  await mkdir(join(real, 'private'), { recursive: true });
  await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  // An existing private directory, and a login directory inside it that does not exist yet, named through the junction.
  await configurePrivate(join(real, 'private'));
  assert.equal(await loginDirectoryRefusal(join(link, 'private', 'login')), 'overlaps-private-directory', 'an absent login directory named through a junction');
  // A private directory that does not exist yet, named through the junction; the login directory is its real parent.
  await configurePrivate(join(link, 'later-private'));
  assert.equal(await loginDirectoryRefusal(real), 'overlaps-private-directory', 'an absent private directory named through a junction');
  // A login directory overlapping both the private and the settings directory is reported as the private one, in any environment.
  await configurePrivate(join(settings, 'private'));
  assert.equal(await loginDirectoryRefusal(settings), 'overlaps-private-directory');
  assert.equal(await loginDirectoryRefusal(root), 'overlaps-private-directory');
});

test('on Windows the overlap check matches 8.3 short names both ways round, as on GitHub\'s runner whose temporary directory is a short name',
  { skip: shortRoot ? false : 'no 8.3 short names here (not Windows, or short names are off on this volume)' }, async (t) => {
    t.after(() => configurePrivate(privateDirectory));
    // The runner's case: the private directory is named in the short form and does not exist; its parent is named in the long form.
    await configurePrivate(join(shortRoot!, 'absent-private'));
    assert.equal(await loginDirectoryRefusal(longRoot), 'overlaps-private-directory', 'long login directory, short absent private directory');
    // The reverse, which would let a login directory inside the private directory through: an existing private directory named
    // in the long form, and a login directory inside it named in the short form that does not exist yet.
    await mkdir(join(longRoot, 'existing-private'), { recursive: true });
    await configurePrivate(join(longRoot, 'existing-private'));
    assert.equal(await loginDirectoryRefusal(join(shortRoot!, 'existing-private', 'login')), 'overlaps-private-directory', 'short absent login directory, long private directory');
    assert.equal(await loginDirectoryRefusal(join(shortRoot!, 'settings', 'login')), 'overlaps-settings-directory');
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
  assert.equal((await run('claude', { authStatus: { loggedIn: true, authMethod: 'api_key' } })).detail, 'api-key-login');
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
  assert.equal((await run('codex', { authStatus: 'API key configured - sk-synthetic***' })).detail, 'api-key-login', 'a key saved in the directory is not the plan login');
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
    // A denial of some other command proves nothing about the allowed one: only the given node form counts as the attempt.
    ['claude substitutes a command outside the allowlist', 'claude', { steps: [{ fileRead: '{{sentinel}}', deny: true }, { shell: ['cat-not-allowlisted', '{{sentinel}}'] }] }, 'read-protection-failed'],
    ['codex substitutes another command', 'codex', { steps: [{ shell: ['cat-not-allowlisted', '{{sentinel}}'] }] }, 'read-protection-failed'],
    // Any other tool touching the sentinel means the host has a reader the check does not cover.
    ['claude uses another tool on it', 'claude', { steps: [{ fileRead: '{{sentinel}}', deny: true }, { shellRead: '{{sentinel}}', deny: true }, { otherTool: '{{sentinel}}' }] }, 'read-protection-failed'],
    ['codex reports a non-command item on it', 'codex', { steps: [{ shellRead: '{{sentinel}}', deny: true }, { otherTool: '{{sentinel}}' }] }, 'read-protection-failed'],
  ];
  for (const [name, host, value, category] of cases) {
    const directory = await login();
    // A sentinel left by an interrupted earlier check is removed by name before the new one is written.
    await writeFile(join(directory, 'maa-eval-sentinel-00000000-0000-4000-8000-000000000000.txt'), 'stale synthetic sentinel');
    const artifacts = join(root, `artifacts-${counter++}`); await mkdir(artifacts);
    const result = await readProtectionCheck({ host, model: 'm', executable: process.execPath, executableArgs: [double, await script({ host, ...value })], loginDirectory: directory, artifactDirectory: artifacts });
    assert.equal(result.status, category ? 'fail' : 'pass', name);
    if (category) assert.equal(result.category, category, name);
    assert.equal(result.sentinelRemoved, true, name);
    assert.deepEqual(await readdir(directory), ['synthetic-login.json'], `${name}: nothing but the login remains`);
    assert.equal(isReadProtectionPass(result.pass, host), !category, name);
    if (host === 'codex') assert.equal(result.fileToolAttempt, 'not-applicable');
    else assert.equal(result.enforcementProbe, undefined, `${name}: Claude's check runs no enforcement probe`);
    for (const file of await readdir(artifacts)) {
      const saved = await readFile(join(artifacts, file), 'utf8');
      assert.ok(!saved.includes(directory) && !saved.includes(directory.replaceAll('\\', '\\\\')) && !/maa-eval-sentinel-value-[0-9a-f]/.test(saved), `${name}: ${file}`);
    }
  }
});

test('Codex read protection first proves enforcement without a model, then passes a model that declines or is denied', async () => {
  type Expected = { status: 'pass' | 'fail'; probe: { sentinel: string; control: string }; commandAttempt: string; modelStarted: boolean; leaked?: boolean; detail?: string };
  const holds = { sentinel: 'denied', control: 'ok' };
  const cases: [string, Record<string, unknown>, Expected][] = [
    ['the probe denies and the model declines', { steps: [] }, { status: 'pass', probe: holds, commandAttempt: 'declined', modelStarted: true }],
    ['the probe denies and the model command is denied', { steps: [{ shellRead: '{{sentinel}}', deny: true }] }, { status: 'pass', probe: holds, commandAttempt: 'denied', modelStarted: true }],
    // A failed probe never starts the model: the login directory has just been shown readable, or not shown unreadable.
    ['the probe reads the sentinel', { sandbox: 'ignore-deny', steps: [] }, { status: 'fail', probe: { sentinel: 'read', control: 'ok' }, commandAttempt: 'not-run', modelStarted: false, detail: 'enforcement-probe-failed' }],
    ['the probe errors', { sandbox: 'silent', steps: [] }, { status: 'fail', probe: { sentinel: 'error', control: 'ok' }, commandAttempt: 'not-run', modelStarted: false, detail: 'enforcement-probe-failed' }],
    ['the control read fails', { sandbox: 'deny-all', steps: [] }, { status: 'fail', probe: { sentinel: 'denied', control: 'failed' }, commandAttempt: 'not-run', modelStarted: false, detail: 'enforcement-probe-failed' }],
    ['the sandbox refuses to start', { sandbox: 'refuse', steps: [] }, { status: 'fail', probe: { sentinel: 'denied', control: 'failed' }, commandAttempt: 'not-run', modelStarted: false, detail: 'enforcement-probe-failed' }],
    ['the model command reads it', { steps: [{ shellRead: '{{sentinel}}' }] }, { status: 'fail', probe: holds, commandAttempt: 'succeeded', modelStarted: true, leaked: true }],
    ['the model leaks the value without a command', { steps: [], leak: true }, { status: 'fail', probe: holds, commandAttempt: 'declined', modelStarted: true, leaked: true, detail: 'sentinel-value-in-output' }],
    ['the stream is cut before the turn completes', { steps: [], failure: 'no-terminal' }, { status: 'fail', probe: holds, commandAttempt: 'missing', modelStarted: true }],
    // Declining means running no command at all; an unrelated command that never names the sentinel is no attempt.
    ['the model runs another command and never reads', { steps: [{ shell: ['node', '-e', '0'] }] }, { status: 'fail', probe: holds, commandAttempt: 'missing', modelStarted: true, detail: 'attempt-missing-or-succeeded' }],
  ];
  for (const [name, value, expected] of cases) {
    const directory = await login();
    await writeFile(join(directory, 'maa-eval-sentinel-00000000-0000-4000-8000-000000000000.txt'), 'stale synthetic sentinel');
    const journal = join(root, `journal-${counter++}.jsonl`); const environment = join(root, `environment-${counter++}.jsonl`);
    const artifacts = join(root, `artifacts-${counter++}`); await mkdir(artifacts);
    const result = await readProtectionCheck({ host: 'codex', model: 'm', executable: process.execPath, executableArgs: [double, await script({ host: 'codex', journal, environment, ...value })],
      loginDirectory: directory, artifactDirectory: artifacts });
    assert.equal(result.status, expected.status, `${name}: ${result.category}/${result.detail}`);
    assert.deepEqual(result.enforcementProbe, expected.probe, name);
    assert.equal(result.commandAttempt, expected.commandAttempt, name);
    assert.equal(result.leaked, expected.leaked ?? false, name);
    if (expected.detail) assert.equal(result.detail, expected.detail, name);
    assert.equal(isReadProtectionPass(result.pass, 'codex'), expected.status === 'pass', name);
    let runs = 0; try { runs = (await readFile(journal, 'utf8')).trim().split('\n').filter((line) => JSON.parse(line).kind === 'run').length; } catch { /* never started */ }
    assert.equal(runs, expected.modelStarted ? 1 : 0, `${name}: model started`);
    // The sentinel is always removed, and nothing but the login remains.
    assert.equal(result.sentinelRemoved, true, name);
    assert.deepEqual(await readdir(directory), ['synthetic-login.json'], name);
    // The probe and the model run share one permission profile, and the probe reads only the sentinel and the workspace control file.
    const invocations = (await readFile(environment, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; configDirectory: string });
    const profile = codexPermissionArguments({ loginDirectory: directory });
    assert.ok(profile.includes(`permissions.maa_eval.filesystem={'${directory}'='deny'}`), name);
    const probes = invocations.filter((call) => call.args[0] === 'sandbox');
    assert.equal(probes.length, 2, name);
    for (const call of probes) {
      assert.deepEqual(call.args.slice(1, call.args.indexOf('--')), profile, `${name}: probe profile`);
      assert.equal(call.configDirectory, directory, name);
    }
    const files = probes.map((call) => call.args.at(-1)!);
    assert.equal(files.filter((file) => file.startsWith(directory)).length, 1, `${name}: one probe read in the login directory`);
    assert.match(files.find((file) => file.startsWith(directory))!, /[\\/]maa-eval-sentinel-[0-9a-f-]+\.txt$/, `${name}: and it is the sentinel`);
    const exec = invocations.filter((call) => call.args[0] === 'exec');
    assert.equal(exec.length, expected.modelStarted ? 1 : 0, name);
    for (const call of exec) {
      assert.ok(call.args.some((_, index) => profile.every((part, offset) => call.args[index + offset] === part)), `${name}: the model runs under the same profile`);
    }
    for (const file of await readdir(artifacts)) assert.ok(!/maa-eval-sentinel-value-[0-9a-f]/.test(await readFile(join(artifacts, file), 'utf8')), `${name}: ${file}`);
  }
});

test('the enforcement probe keeps its own per-read timeout: --timeout-ms changes only the model call', async () => {
  // With the batch's timeout at 1 ms the model call cannot finish, yet both probe reads still complete and the probe holds.
  const directory = await login();
  const result = await readProtectionCheck({ host: 'codex', model: 'm', executable: process.execPath, executableArgs: [double, await script({ host: 'codex', steps: [] })],
    loginDirectory: directory, timeoutMs: 1 });
  assert.deepEqual(result.enforcementProbe, { sentinel: 'denied', control: 'ok' });
  assert.equal(result.status, 'fail', 'the model call itself timed out');
  assert.deepEqual(await readdir(directory), ['synthetic-login.json']);
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
