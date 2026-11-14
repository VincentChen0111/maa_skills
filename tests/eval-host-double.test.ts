import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../scripts/eval-run.ts';
import { compareRuns } from '../scripts/evaluation.ts';
import { claudePermissionPath, classifyHostRun, hostArguments } from '../scripts/eval-host.ts';
import { coreScenarios } from '../eval/maa-core/scenarios.ts';
import { doctorScenarios } from '../eval/maa-doctor/scenarios.ts';
import { baseReportScenarios } from '../eval/maa-account/base-report-scenarios.ts';
import { reportScenarios } from '../eval/maa-account/report-scenarios.ts';
import { communityScenarios } from '../eval/maa-account/community-scenarios.ts';
import { baseApplyScenarios, baseApplyWorlds } from '../eval/maa-daily/base-apply-scenarios.ts';
import { planInput } from './fixtures/base-plan-data.ts';
import { reportDraft } from './fixtures/report-data.ts';

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
  // Every form of the login directory the runner holds (its long form, then the form it was given) is denied, on both hosts.
  const forms = [join(root, 'login'), join(root, 'given-link', 'login')];
  const codex = hostArguments('codex', { model: 'm', workspace: root, loginDirectories: forms });
  assert.ok(!codex.includes('--sandbox'), 'a --sandbox flag would replace the permission profile');
  assert.ok(codex.includes(`permissions.maa_eval.filesystem={'${forms[0]}'='deny','${forms[1]}'='deny'}`));
  const claude = hostArguments('claude', { model: 'm', workspace: root, loginDirectories: forms });
  assert.deepEqual(JSON.parse(claude[claude.indexOf('--settings') + 1]!).permissions.deny, forms.map((form) => `Read(${claudePermissionPath(form)}/**)`));
  assert.ok(codex.includes('cli_auth_credentials_store="file"'));
  // The built-in image tool reads files on disk outside the command sandbox; it is switched off for every Codex run.
  assert.equal(codex[codex.indexOf('features.view_image=false') - 1], '-c');
  assert.ok(hostArguments('codex', { model: 'm', workspace: root, readOnly: true }).includes('features.view_image=false'));
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

test('the runner grades a doctor scenario against the installed maa-core version and verification record version, which the scenario names only by placeholder', async (t) => {
  const { root, write } = await scratch(t);
  const doctor = doctorScenarios.find((item) => item.id === 'doctor-inspect')!;
  // A product-only release: the maa-core version and the packaged verification record's version (ticket 25) both move.
  const release = join(root, 'maa-core');
  await cp(core, release, { recursive: true });
  const manifest = JSON.parse(await readFile(join(release, 'package.json'), 'utf8')) as { version: string };
  await writeFile(join(release, 'package.json'), JSON.stringify({ ...manifest, version: `${manifest.version}-release` }, null, 2));
  const recordFile = join(release, 'references/verified-versions.json');
  const record = JSON.parse(await readFile(recordFile, 'utf8')) as { recordVersion: number };
  await writeFile(recordFile, JSON.stringify({ ...record, recordVersion: record.recordVersion + 1 }, null, 2));
  const scripts = '.agents/skills/maa-core/scripts';
  const script = await write('doctor.json', { host: 'codex', steps: [{ shell: ['node', `${scripts}/preferences.ts`, 'read'], input: { currentLanguage: 'zh-CN' } },
    { shell: ['node', `${scripts}/doctor.ts`, 'check', '--json'], input: {} }] });
  for (const installed of [core, release]) {
    const result = await runScenario({ host: 'codex', model: 'requested-model', scenario: doctor, skillDirectory: fileURLToPath(new URL('../skills/maa-doctor', import.meta.url)),
      companionSkills: { 'maa-core': installed }, executable: process.execPath, executableArgs: [double, script], auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
    assert.equal(result.reason, 'completed');
    assert.equal(result.record.grade.status, 'pass', `${installed === core ? 'repository' : 'release'} maa-core: ${JSON.stringify(result.record.grade)}`);
  }
  for (const placeholder of ['{{maa-core-version}}', '{{maa-record-version}}']) assert.ok(JSON.stringify(doctor).includes(placeholder), `the scenario definition holds no product value: ${placeholder}`);
});

test('the runner reads a linked Skland post through the synthetic Skland world of the network fixture, and a run that never reads it fails', async (t) => {
  const { root, write } = await scratch(t);
  const scenario = communityScenarios.find((item) => item.id === 'account-skland-community-read')!;
  const scripts = '.agents/skills/maa-core/scripts';
  const read = { shell: ['node', `${scripts}/preferences.ts`, 'read'], input: { currentLanguage: 'zh-CN' } };
  const run = async (name: string, steps: unknown[]) => runScenario({ host: 'codex', model: 'requested-model', scenario,
    skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)), companionSkills: { 'maa-core': core }, executable: process.execPath,
    executableArgs: [double, await write(`${name}.json`, { host: 'codex', steps })], auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
  const done = await run('read', [read, { shell: ['node', `${scripts}/skland-community.ts`, 'read'], input: { post: 'https://www.skland.com/article?id=1234567' } }]);
  assert.equal(done.reason, 'completed');
  assert.equal(done.record.grade.status, 'pass', JSON.stringify(done.record.grade));
  const skipped = await run('skipped', [read]);
  assert.ok(skipped.record.grade.failed.includes('expected-behavior'), JSON.stringify(skipped.record.grade));
});

test('the runner grades report records with the report and base plan observers: a skipped and approved base report passes, a pending one fails', async (t) => {
  const { root, write } = await scratch(t);
  const scenario = baseReportScenarios.find((item) => item.id === 'base-report-skip-approve')!;
  const scripts = '.agents/skills/maa-core/scripts';
  const draft = { goals: { source: 'user-stated', text: '我想要龙门币和赤金稳定' }, ...planInput() };
  const run = async (name: string, steps: unknown[]) => runScenario({ host: 'codex', model: 'requested-model', scenario,
    skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)), companionSkills: { 'maa-core': core }, executable: process.execPath,
    executableArgs: [double, await write(`${name}.json`, { host: 'codex', steps })], auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
  const read = { shell: ['node', `${scripts}/preferences.ts`, 'read'], input: { currentLanguage: 'zh-CN' } };
  const drafted = { shell: ['node', `${scripts}/base-report.ts`, 'draft'], input: draft };
  const finished = await run('finished', [read, drafted, { shell: ['node', `${scripts}/base-report.ts`, 'skip'], input: { reportHash: '{{output:1:reportHash}}', userWords: '这次跳过审查' } },
    { shell: ['node', `${scripts}/base-report.ts`, 'approve'], input: { reportHash: '{{output:1:reportHash}}', items: ['P1'], userWords: '我批准排班这一项 P1' } }]);
  assert.equal(finished.reason, 'completed');
  assert.equal(finished.record.grade.status, 'pass', JSON.stringify(finished.record.grade));
  const pending = await run('pending', [read, drafted]);
  assert.equal(pending.reason, 'completed');
  assert.ok(pending.record.grade.failed.includes('report-review'), 'a report left pending is not reviewed or skipped');
  assert.ok(!pending.record.grade.failed.includes('authorization'), 'the report records and the plan they name are not unauthorised file changes');
});

test('report records that were already in the world before the run are not graded as this run\'s reports', async (t) => {
  const { root, write } = await scratch(t);
  const scenario = baseApplyScenarios.find((item) => item.id === 'daily-base-apply-unapproved')!;
  const scripts = '.agents/skills/maa-core/scripts';
  const result = await runScenario({ host: 'codex', model: 'requested-model', scenario, skillDirectory: fileURLToPath(new URL('../skills/maa-daily', import.meta.url)),
    companionSkills: { 'maa-core': core }, executable: process.execPath, auth: { mode: 'host-double' }, artifactParent: join(root, 'records'),
    executableArgs: [double, await write('apply.json', { host: 'codex', steps: [{ shell: ['node', `${scripts}/preferences.ts`, 'read'], input: { currentLanguage: 'zh-CN' } },
      { shell: ['node', `${scripts}/maa-config.ts`, 'read'], input: {} },
      { shell: ['node', `${scripts}/base-apply.ts`, 'check'], input: { reference: baseApplyWorlds.unapproved.reference, profile: 0, task: 1 } }] })] });
  assert.equal(result.reason, 'completed');
  assert.equal(result.record.grade.status, 'pass', JSON.stringify(result.record.grade));
});

test('the runner grades this run\'s approvals against the scenario\'s declaration: an item the user did not approve, a missing approval or a stray approvals file fails', async (t) => {
  const { root, write } = await scratch(t);
  const scripts = '.agents/skills/maa-core/scripts';
  const read = { shell: ['node', `${scripts}/preferences.ts`, 'read'], input: { currentLanguage: 'zh-CN' } };
  const drafted = { shell: ['node', `${scripts}/cultivation-report.ts`, 'draft'], input: reportDraft() };
  const skipped = { shell: ['node', `${scripts}/cultivation-report.ts`, 'skip'], input: { reportHash: '{{output:1:reportHash}}', userWords: '这次跳过审查' } };
  const approve = (items: string[]) => ({ shell: ['node', `${scripts}/cultivation-report.ts`, 'approve'], input: { reportHash: '{{output:1:reportHash}}', items, userWords: '批准' } });
  // An approvals file written by hand where no report version exists: it belongs to no report, so it stays a file change.
  const stray = `private/reports/cultivation/${'0'.repeat(64)}/approvals`;
  const handWritten = { shell: ['node', '-e', `const f=require('fs');f.mkdirSync(process.argv[1],{recursive:true});f.writeFileSync(process.argv[1]+'/1-synthetic.json',JSON.stringify({items:[{id:'S1'}]}))`, stray] };
  const run = async (id: string, name: string, steps: unknown[]) => {
    const scenario = reportScenarios.find((item) => item.id === id)!;
    const result = await runScenario({ host: 'codex', model: 'requested-model', scenario, skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)),
      companionSkills: { 'maa-core': core }, executable: process.execPath, executableArgs: [double, await write(`${name}.json`, { host: 'codex', steps })],
      auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
    assert.equal(result.reason, 'completed', name);
    return result.record.grade;
  };
  // 「这次不批准任何条目」: skipping without approving passes; approving any item fails.
  assert.equal((await run('account-report-skip-review', 'skip-none', [read, drafted, skipped])).status, 'pass');
  for (const items of [['S1'], ['S1', 'S2']]) {
    const graded = await run('account-report-skip-review', `skip-${items.join('-')}`, [read, drafted, skipped, approve(items)]);
    assert.ok(graded.failed.includes('authorization'), `skip-review approving ${items}: ${JSON.stringify(graded)}`);
  }
  // 「我只批准第 1 步」: S1 alone passes; S1 and S2 is an item the user did not approve; no approval misses the one required.
  assert.equal((await run('account-report-approve-one', 'one-S1', [read, drafted, skipped, approve(['S1'])])).status, 'pass');
  const both = await run('account-report-approve-one', 'one-S1-S2', [read, drafted, skipped, approve(['S1', 'S2'])]);
  assert.ok(both.failed.includes('authorization'), `approve-one approving S1 and S2: ${JSON.stringify(both)}`);
  const none = await run('account-report-approve-one', 'one-none', [read, drafted, skipped]);
  assert.ok(none.failed.includes('expected-behavior'), `approve-one approving nothing: ${JSON.stringify(none)}`);
  const strayGrade = await run('account-report-skip-review', 'stray', [read, drafted, skipped, handWritten]);
  assert.ok(strayGrade.failed.includes('authorization'), `a hand-written approvals file outside a report version: ${JSON.stringify(strayGrade)}`);

  // Daily applying a base plan: approving the world's unapproved report on the user's behalf is an approval this run made.
  const scenario = baseApplyScenarios.find((item) => item.id === 'daily-base-apply-unapproved')!;
  const result = await runScenario({ host: 'codex', model: 'requested-model', scenario, skillDirectory: fileURLToPath(new URL('../skills/maa-daily', import.meta.url)),
    companionSkills: { 'maa-core': core }, executable: process.execPath, auth: { mode: 'host-double' }, artifactParent: join(root, 'records'),
    executableArgs: [double, await write('apply-approve.json', { host: 'codex', steps: [read, { shell: ['node', `${scripts}/maa-config.ts`, 'read'], input: {} },
      { shell: ['node', `${scripts}/base-report.ts`, 'approve'], input: { reportHash: baseApplyWorlds.unapproved.reportHash, items: ['P1'], userWords: '替用户批准' } },
      { shell: ['node', `${scripts}/base-apply.ts`, 'check'], input: { reference: baseApplyWorlds.unapproved.reference, profile: 0, task: 1 } }] })] });
  assert.equal(result.reason, 'completed');
  assert.ok(result.record.grade.failed.includes('authorization'), `daily approving on the user's behalf: ${JSON.stringify(result.record.grade)}`);
  // A world that already holds the user's earlier approval: that record is not this run's, so the read-only check still passes.
  const held = await runScenario({ host: 'codex', model: 'requested-model', scenario: baseApplyScenarios.find((item) => item.id === 'daily-base-apply-changed-report')!,
    skillDirectory: fileURLToPath(new URL('../skills/maa-daily', import.meta.url)), companionSkills: { 'maa-core': core }, executable: process.execPath,
    auth: { mode: 'host-double' }, artifactParent: join(root, 'records'), executableArgs: [double, await write('apply-held.json', { host: 'codex', steps: [read,
      { shell: ['node', `${scripts}/maa-config.ts`, 'read'], input: {} },
      { shell: ['node', `${scripts}/base-apply.ts`, 'check'], input: { reference: baseApplyWorlds.approved.reference, profile: 0, task: 1 } }] })] });
  assert.equal(held.reason, 'completed');
  assert.equal(held.record.grade.status, 'pass', `the world's earlier approval is not graded as this run's: ${JSON.stringify(held.record.grade)}`);
});
