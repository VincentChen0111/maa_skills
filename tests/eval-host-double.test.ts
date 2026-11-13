import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../scripts/eval-run.ts';
import { compareRuns } from '../scripts/evaluation.ts';
import { classifyHostRun, hostArguments, pathRedactor } from '../scripts/eval-host.ts';
import { coreScenarios } from '../eval/maa-core/scenarios.ts';

const double = fileURLToPath(new URL('../eval/host-double.mjs', import.meta.url));
const core = fileURLToPath(new URL('../skills/maa-core', import.meta.url));
const scenario = coreScenarios[0]!;
const steps = (host: 'claude' | 'codex') => {
  const script = `${host === 'claude' ? '.claude' : '.agents'}/skills/subject/scripts/preferences.ts`;
  return [{ shell: ['node', script, 'read'], input: { currentLanguage: 'zh-CN' } }, { shell: ['node', script, 'set'], input: { language: 'en' } },
    { shell: ['node', script, 'append'], input: { date: '2026-11-10T06:00:00.000Z', source: 'synthetic-help-case', text: '以后用英文' } }];
};

async function scratch(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'maa-double-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name: string, value: unknown) => { const file = join(root, name); await writeFile(file, JSON.stringify(value)); return file; };
  return { root, write };
}

test('a host double drives runScenario end to end, records reported model and usage, and is marked as a double', async (t) => {
  const { root, write } = await scratch(t);
  for (const host of ['claude', 'codex'] as const) {
    const script = await write(`${host}.json`, { host, steps: steps(host), model: host === 'claude' ? 'claude-synthetic-reported' : undefined });
    const result = await runScenario({ host, model: 'requested-model', scenario, skillDirectory: core, executable: process.execPath, executableArgs: [double, script],
      auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
    assert.equal(result.reason, 'completed');
    assert.equal(result.record.grade.status, 'pass', JSON.stringify(result.record.grade));
    assert.equal(result.record.double, true);
    const saved = JSON.parse(await readFile(join(result.artifactDirectory, 'run.json'), 'utf8'));
    assert.equal(saved.reason, 'completed'); assert.equal(saved.double, true); assert.equal(saved.auth, 'host-double');
    if (host === 'claude') {
      assert.deepEqual(saved.reportedModel, ['claude-synthetic-reported']);
      assert.equal(saved.usage.input_tokens, 120);
    } else {
      assert.equal(saved.reportedModel, 'unknown', 'the requested id never stands in for an unreported model');
      assert.deepEqual(saved.usage, { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 0 });
    }
    // A double record can never enter a before/after comparison or a baseline.
    assert.equal(compareRuns([], [saved, { ...saved, id: 'b' }, { ...saved, id: 'c' }]).status, 'incomparable');
  }
});

test('missing usage and model reports stay unknown instead of being filled from the request', async (t) => {
  const { root, write } = await scratch(t);
  const script = await write('claude.json', { host: 'claude', steps: steps('claude'), model: null, usage: null });
  const result = await runScenario({ host: 'claude', model: 'requested-model', scenario, skillDirectory: core, executable: process.execPath, executableArgs: [double, script],
    auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
  assert.equal(result.record.reportedModel, 'unknown'); assert.equal(result.record.usage, 'unknown');
});

test('run.json keeps timeout, auth, quota, network, non-zero exit and incomplete records as separate unverified reasons', async (t) => {
  const { root, write } = await scratch(t);
  const cases: [string, Record<string, unknown>, string][] = [
    ['not-logged-in', { failure: 'not-logged-in' }, 'auth-failed'], ['login-expired', { failure: 'login-expired' }, 'auth-failed'],
    ['quota', { failure: 'quota' }, 'quota-exhausted'], ['network', { failure: 'network' }, 'network-unavailable'],
    ['exit', { failure: 'exit-nonzero' }, 'host-nonzero-exit'], ['no-terminal', { failure: 'no-terminal' }, 'incomplete-transcript'],
    ['timeout', { sleepMs: 4000 }, 'timeout'],
  ];
  for (const host of ['claude', 'codex'] as const) for (const [name, failure, reason] of cases) {
    const script = await write(`${host}-${name}.json`, { host, steps: [], ...failure });
    const result = await runScenario({ host, model: 'requested-model', scenario, skillDirectory: core, executable: process.execPath, executableArgs: [double, script],
      auth: { mode: 'host-double' }, artifactParent: join(root, 'records'), ...(name === 'timeout' ? { timeoutMs: 1500 } : {}) });
    const saved = JSON.parse(await readFile(join(result.artifactDirectory, 'run.json'), 'utf8'));
    assert.equal(saved.reason, reason, `${host} ${name}`);
    assert.equal(saved.grade.status, 'unverified', `${host} ${name}`);
  }
});

test('host failure texts map to auth details without reading the model reply', () => {
  const claude = (text: string, error: string) => [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] }, error, is_api_error_message: true }),
    JSON.stringify({ type: 'result', is_error: true, result: text })].join('\n');
  assert.deepEqual(classifyHostRun('claude', { raw: claude('Not logged in · Please run /login', 'authentication_failed'), stderr: '', exitCode: 1 }), { reason: 'auth-failed', detail: 'not-logged-in' });
  assert.deepEqual(classifyHostRun('claude', { raw: claude('Login expired · Please run /login', 'authentication_failed'), stderr: '', exitCode: 1 }), { reason: 'auth-failed', detail: 'login-expired' });
  assert.deepEqual(classifyHostRun('claude', { raw: claude('Invalid API key · Fix external API key', 'authentication_failed'), stderr: '', exitCode: 1 }), { reason: 'auth-failed', detail: 'api-key-rejected' });
  assert.equal(classifyHostRun('claude', { raw: claude("You've hit your limit · resets 5pm", 'rate_limit'), stderr: '', exitCode: 1 }).reason, 'quota-exhausted');
  // Codex retries print 401 error events; only the final failure decides, and a model message saying "401" is never read.
  const codex = [{ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized)' }, { type: 'item.completed', item: { type: 'agent_message', text: 'usage limit reached' } },
    { type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to continue." } }].map((event) => JSON.stringify(event)).join('\n');
  assert.equal(classifyHostRun('codex', { raw: codex, stderr: '', exitCode: 1 }).reason, 'quota-exhausted');
  const reply = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Not logged in' } }) + '\n' + JSON.stringify({ type: 'turn.completed', usage: {} });
  assert.equal(classifyHostRun('codex', { raw: reply, stderr: '', exitCode: 0 }).reason, 'completed');
});

test('a completed Claude run with unlisted loads or tools is unverified, never a baseline', async (t) => {
  const { root, write } = await scratch(t);
  for (const [name, init] of [['mcp', { mcp_servers: [{ name: 'synthetic', status: 'connected' }] }], ['tools', { tools: ['Bash', 'Read', 'WebFetch'] }],
    ['plugins', { plugins: [{ name: 'synthetic-plugin' }] }], ['skills', { skills: ['synthetic-skill'] }], ['agents', { agents: ['claude', 'synthetic-agent'] }]] as const) {
    const script = await write(`${name}.json`, { host: 'claude', steps: steps('claude'), init });
    const result = await runScenario({ host: 'claude', model: 'requested-model', scenario, skillDirectory: core, executable: process.execPath, executableArgs: [double, script],
      auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
    assert.equal(result.reason, 'isolation-unverified', name);
    assert.equal(result.record.grade.status, 'unverified', name);
  }
});

test('Claude runs drop --bare, name every isolation switch and offer only the file tool plus declared commands', async (t) => {
  const { root, write } = await scratch(t);
  const environment = join(root, 'environment.jsonl');
  const script = await write('claude.json', { host: 'claude', steps: steps('claude'), environment });
  await runScenario({ host: 'claude', model: 'requested-model', scenario, skillDirectory: core, executable: process.execPath, executableArgs: [double, script],
    auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
  const seen = JSON.parse((await readFile(environment, 'utf8')).trim());
  assert.ok(!seen.args.includes('--bare'));
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(seen.args.includes(flag), flag);
  assert.equal(seen.args[seen.args.indexOf('--tools') + 1], 'Read,Bash');
  assert.deepEqual(seen.args.slice(seen.args.indexOf('--allowedTools') + 1, seen.args.indexOf('--add-dir')), ['Read', 'Bash(node *preferences.ts *)']);
  for (const name of ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS']) assert.ok(seen.names.includes(name), name);
  const settings = JSON.parse(seen.args[seen.args.indexOf('--settings') + 1]);
  assert.equal(settings.disableAllHooks, true); assert.equal(settings.autoMemoryEnabled, false);
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.ok(Object.values(settings.enabledPlugins).every((value) => value === false));
  // Help scenarios declare no commands: only the file tool is offered.
  const helpOnly = hostArguments('claude', { model: 'm', workspace: root, commands: [] });
  assert.equal(helpOnly[helpOnly.indexOf('--tools') + 1], 'Read');
  const codex = hostArguments('codex', { model: 'm', workspace: root, loginDirectory: join(root, 'login') });
  assert.ok(!codex.includes('--sandbox'), 'a --sandbox flag would replace the permission profile');
  assert.ok(codex.includes(`permissions.maa_eval.filesystem={'${join(root, 'login')}'='deny'}`));
  assert.ok(codex.includes('cli_auth_credentials_store="file"'));
});

test('the host-double mode refuses an executable that is not the double, and plan login never starts tools without a read-protection pass', async (t) => {
  const { root, write } = await scratch(t);
  const notDouble = await runScenario({ host: 'claude', model: 'm', scenario, skillDirectory: core, executable: process.execPath, auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
  assert.equal(notDouble.reason, 'host-double-required');
  const journal = join(root, 'journal.jsonl');
  const script = await write('claude.json', { host: 'claude', steps: steps('claude'), journal });
  for (const auth of [{ mode: 'plan' as const }, { mode: 'plan' as const, readProtection: { host: 'claude', loginDirectory: root, checkedAt: '' } as never }]) {
    const result = await runScenario({ host: 'claude', model: 'm', scenario, skillDirectory: core, executable: process.execPath, executableArgs: [double, script], auth, artifactParent: join(root, 'records') });
    assert.equal(result.reason, 'read-protection-required', 'a forged pass object grants nothing');
    assert.equal(result.record.grade.status, 'unverified');
  }
  await assert.rejects(readFile(journal), /ENOENT/, 'the host was never started');
});

test('path placeholders cover every spelling a host or nested JSON may print, without touching a longer sibling name', () => {
  const slash = String.fromCharCode(92);
  const login = ['C:', 'Users', 'someone', '.maa-skills-eval', 'claude-config'].join(slash);
  const redact = pathRedactor([[login, '<login-dir>']]);
  for (const sample of [login + slash + 's.txt', JSON.stringify(login + slash + 's.txt'), JSON.stringify(JSON.stringify(JSON.stringify(login))),
    login.replaceAll(slash, '/') + '/s.txt', '/c/Users/someone/.maa-skills-eval/claude-config/s.txt', '//c/Users/someone/.maa-skills-eval/claude-config/**',
    'c:' + login.slice(2), 'file:///C:/Users/someone/.maa-skills-eval/claude-config']) {
    assert.ok(!redact(sample).includes('maa-skills-eval'), sample);
  }
  assert.equal(redact(login + '-old' + slash + 'x'), login + '-old' + slash + 'x', 'a sibling with a longer name is a different path');
  const spaced = pathRedactor([['/home/someone/eval login', '<login-dir>']]);
  assert.equal(spaced('file:///home/someone/eval%20login/a'), 'file://<login-dir>/a');
});
