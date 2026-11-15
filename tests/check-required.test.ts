import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRequired, checkRequiredReasons, isCheckRequired, noAlternative, producers, CheckRequiredError, checkRequiredFor,
  type CheckRequiredProducer } from '../skills/maa-core/scripts/check-required.ts';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';

// Owner trial item 10 (2026-11-16): 「check required 要给我具体的，和有没有替代」. This is the conformance test the owner's
// recurrence rule asks for: it enumerates every producer of `check-required` and every consumer that tells the agent how
// to report one, and fails when a new producer or consumer is added without being listed here.
const root = fileURLToPath(new URL('..', import.meta.url));
const scripts = join(root, 'skills', 'maa-core', 'scripts');

/** Producer key -> the script whose CLI emits it. */
const producerScripts: Record<CheckRequiredProducer, string> = {
  'stage-jobs': 'stage-jobs.ts', 'stage-run': 'stage-run.ts', 'maa-config': 'maa-config.ts', 'account-snapshot': 'account-snapshot.ts',
  'skland-account': 'skland-account.ts', 'base-query': 'base-query.ts', credentials: 'credentials.ts', preferences: 'preferences.ts', setup: 'setup.ts',
};
/**
 * Owned by the parallel training fix (session training-chain-fix), which emits the same shape on its own branch. They adopt
 * this module after the central merge; until then they are listed, not converted, and not edited here.
 */
const adoptedAfterMerge = ['training-plan.ts', 'training-time.ts', 'training-state.ts', 'cultivation-gaps.ts'];
const adoptedConsumersAfterMerge = ['skills/maa-core/references/training.md'];
/** `connection.reason` in setup's recheck record: "connection not tested until the MAA checks pass". Not a failure result. */
const notAResult = { 'setup.ts': ['maa-check-required'] };

/** Every SKILL.md and reference that tells the agent how to report a check-required result. */
const consumers = [
  'skills/maa-core/SKILL.md', 'skills/maa-setup/SKILL.md', 'skills/maa-account/SKILL.md', 'skills/maa-daily/SKILL.md', 'skills/maa-doctor/SKILL.md',
  'skills/maa-daily/references/stage-jobs.md', 'skills/maa-daily/references/stage-run.md', 'skills/maa-daily/references/configuration.md',
  'skills/maa-account/references/import.md', 'skills/maa-account/references/skland.md', 'skills/maa-core/references/base-query.md',
  'skills/maa-core/references/credentials.md', 'skills/maa-core/references/preferences.md', 'skills/maa-setup/references/setup.md',
  'skills/maa-account/references/cultivation-report.md',
];
const retiredCodes = ['account-check-required', 'base-query-check-required', 'credential-check-required', 'preferences-check-required', 'setup-check-required'];

test('the catalogue: stable kebab reasons, a check for each, and a stated absence of alternatives', () => {
  assert.ok(checkRequiredReasons.length > 0);
  assert.equal(new Set(checkRequiredReasons).size, checkRequiredReasons.length);
  for (const reason of checkRequiredReasons) {
    const result = checkRequired(reason);
    assert.match(reason, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    assert.deepEqual(Object.keys(result).sort(), ['alternatives', 'check', 'ok', 'reason', 'status']);
    assert.equal(result.ok, false); assert.equal(result.status, 'check-required'); assert.equal(result.reason, reason);
    assert.ok(result.check.trim().length >= 8, reason);
    assert.ok(result.alternatives.every(item => typeof item === 'string' && item.trim().length >= 4), reason);
    if (!result.alternatives.length) assert.ok(result.check.endsWith(noAlternative), `${reason} must say there is no alternative`);
    // Static texts only: nothing that looks like a path, an address or a placeholder to fill in.
    assert.doesNotMatch(result.check + result.alternatives.join(''), /[A-Za-z]:\\|https?:\/\/|\$\{|<[a-z]/, reason);
    assert.ok(isCheckRequired(result), reason);
  }
  const sample = checkRequired('stage-jobs-snapshot-missing');
  assert.equal(isCheckRequired({ ...sample, extra: 1 }), false);
  assert.equal(isCheckRequired({ ...sample, check: 'x' }), false);
  assert.equal(isCheckRequired({ ...sample, alternatives: [] }), false);
  assert.equal(isCheckRequired({ ok: false, status: 'check-required' }), false);
  assert.equal(isCheckRequired({ ...sample, reason: 'not-in-catalogue' }), false);
  assert.throws(() => checkRequired('not-in-catalogue' as never), /check-required-unknown-reason/);
});

test('every producer maps only to catalogue reasons, every reason has a producer, and the catch-all classifies before falling back', () => {
  assert.deepEqual(Object.keys(producers).sort(), Object.keys(producerScripts).sort());
  const used = new Set<string>();
  for (const [name, producer] of Object.entries(producers)) {
    assert.ok(checkRequiredReasons.includes(producer.fallback), name); used.add(producer.fallback);
    for (const reason of Object.values(producer.codes)) { assert.ok(checkRequiredReasons.includes(reason), `${name}: ${reason}`); used.add(reason); }
  }
  assert.deepEqual(checkRequiredReasons.filter(reason => !used.has(reason)), [], 'a reason no producer can emit');
  assert.equal(checkRequiredFor('stage-jobs', new CheckRequiredError('stage-jobs-snapshot-changed')).reason, 'stage-jobs-snapshot-changed');
  assert.equal(checkRequiredFor('stage-jobs', new Error('approval-mismatch')).reason, 'stage-jobs-approval-mismatch');
  assert.equal(checkRequiredFor('maa-config', Object.assign(new Error('synthetic'), { code: 'ENOENT' })).reason, 'maa-config-unreadable');
  assert.equal(checkRequiredFor('stage-jobs', new Error('synthetic unclassified')).reason, 'stage-jobs-query-failed');
  assert.equal(checkRequiredFor('stage-jobs', new Error('synthetic unclassified'), 'stage-jobs-prepare-outcome-unknown').reason, 'stage-jobs-prepare-outcome-unknown');
});

test('only the module builds the shape: every file that mentions check-required is the module, a listed producer, or adopted after merge', async () => {
  const files = (await readdir(scripts)).filter(file => file.endsWith('.ts'));
  for (const file of files) {
    const source = await readFile(join(scripts, file), 'utf8');
    const mentions = [...source.matchAll(/[a-z-]*check-required[a-z-]*/g)].map(match => match[0]).filter(word => !(notAResult as Record<string, string[]>)[file]?.includes(word));
    if (file === 'check-required.ts') continue;
    if (adoptedAfterMerge.includes(file)) continue;
    const producer = Object.values(producerScripts).includes(file);
    if (producer) {
      assert.match(source, /from '\.\/check-required\.ts'/, `${file} must use the shared module`);
      assert.doesNotMatch(source, /status:\s*'check-required'/, `${file} builds the shape by hand`);
      for (const code of retiredCodes) assert.ok(!source.includes(`'${code}'`), `${file} still emits ${code}`);
    } else assert.deepEqual(mentions.filter(word => word !== 'check-required.ts'), [], `${file} mentions check-required but is not a listed producer`);
  }
  for (const file of adoptedAfterMerge) assert.ok(files.includes(file), `${file} is listed as adopted after merge but does not exist`);
});

/** Static failure codes thrown in a producer's own sources; each must map to a reason (or is reported in another shape, listed). */
const staticCodes = async (file: string) => {
  const source = await readFile(join(scripts, file), 'utf8');
  return new Set([...source.matchAll(/(?:fail|deny|new Error|new CheckRequiredError)\('([a-z][a-z0-9]*(?:-[a-z0-9]+)+)'\)/g)].map(match => match[1]!));
};
test('stage-run: every code its CLI can report (own throws, gate denials and holds, job-plan checks) has a catalogue entry', async () => {
  const table = producers['stage-run'].codes as Record<string, string>;
  const codes = new Set([...await staticCodes('stage-run.ts'), ...await staticCodes('stage-run-state.ts'), ...await staticCodes('stage-job-plan.ts')]);
  // Holds and hard blocks are returned as values, not thrown; every kebab literal in the gate's module is either a reason or listed here.
  const state = await readFile(join(scripts, 'stage-run-state.ts'), 'utf8');
  const notReasons = new Set(['ask-progress', 'chain-end', 'chain-started-before-anchor', 'close-before-start', 'closed-before-start', 'environment-verified', 'evidence-gap',
    'game-session', 'gui-marker', 'gui-without-callback', 'in-progress', 'job-failure', 'keep-observing', 'maa-gone', 'maa-process-exited', 'maa-reported-failure',
    'manual-login', 'manual-play', 'native-schedule', 'no-earlier-chain', 'no-sanity', 'not-evaluated', 'not-fought', 'not-list-mode', 'not-three-star',
    'nothing-before-tracking', 'other-task-chain', 'process-changed', 'retry-decided', 'retry-within-approval', 'run-duration-limit', 'stage-result', 'start-alternate',
    'stop-and-tell-user', 'subtask-error', 'switch-alternate', 'switch-decided', 'user-report']);
  for (const match of state.matchAll(/'([a-z]+(?:-[a-z0-9]+)+)'/g)) if (!notReasons.has(match[1]!)) codes.add(match[1]!);
  for (const code of ['busy', 'run-busy', 'stage-invalid']) if ((await readFile(join(scripts, 'stage-run.ts'), 'utf8')).includes(`'${code}'`)) codes.add(code);
  codes.delete('busy');
  assert.deepEqual([...codes].filter(code => !Object.hasOwn(table, code)).sort(), []);
});
test('stage-jobs: every static code its CLI can hit has a catalogue entry', async () => {
  const table = producers['stage-jobs'].codes as Record<string, string>;
  // Job content problems are per-candidate reasons inside the report, never a failure of the whole query.
  const perCandidate = new Set(['job-operators-invalid', 'job-group-name-duplicate']);
  const codes = new Set([...await staticCodes('stage-jobs.ts'), ...await staticCodes('stage-job-plan.ts')]);
  codes.delete('job-file-changed'); // read only by stage-run
  assert.deepEqual([...codes].filter(code => !perCandidate.has(code) && !Object.hasOwn(table, code)).sort(), []);
});

test('consumers: every SKILL.md and reference that hands out a producer tells the agent to relay reason, check and alternatives', async () => {
  const rule = await readFile(join(root, 'skills/maa-core/SKILL.md'), 'utf8');
  assert.match(rule, /check-required/); assert.match(rule, /`reason`/); assert.match(rule, /`check`/); assert.match(rule, /`alternatives`/);
  for (const file of consumers) {
    const text = await readFile(join(root, file), 'utf8');
    assert.match(text, /check-required/, `${file} must mention check-required`);
    // An entry SKILL.md points to the one rule from a line that names check-required; it does not restate the rule.
    if (file.endsWith('SKILL.md') && file !== 'skills/maa-core/SKILL.md') assert.ok(text.split(/\r?\n/).some(line => line.includes('check-required') && line.includes('](../maa-core/SKILL.md)')), `${file} must point to the shared rule`);
    else for (const field of ['reason', 'check', 'alternatives']) assert.match(text, new RegExp(`\`${field}\``), `${file} must name ${field}`);
    for (const code of retiredCodes) assert.ok(!text.includes(code), `${file} still documents ${code}`);
  }
  // Every operating skill is a consumer: each runs a producer (at least preferences.ts read).
  for (const skill of await readdir(join(root, 'skills'))) if (skill.startsWith('maa-') && !['maa-core', 'maa-help'].includes(skill)) assert.ok(consumers.includes(`skills/${skill}/SKILL.md`), skill);
  // Each producer's interface document, as maa-core's script table links it, is a consumer (maa-config's is maa-daily's transaction doc).
  const table = rule.split(/\r?\n/).filter(line => line.startsWith('| `scripts/'));
  const interfaceDocs: Record<string, string> = { 'maa-config.ts': 'skills/maa-daily/references/configuration.md' };
  for (const script of Object.values(producerScripts)) {
    if (interfaceDocs[script]) continue;
    const row = table.find(line => line.includes(`\`scripts/${script}\``)); assert.ok(row, script);
    const link = /\]\(([^)]+\.md)\)/.exec(row.split('|').at(-2)!); assert.ok(link, `${script} has an interface document`);
    interfaceDocs[script] = join('skills/maa-core', link[1]!).replace(/\\/g, '/');
  }
  for (const [script, doc] of Object.entries(interfaceDocs)) assert.ok(consumers.includes(doc), `${doc} (interface of ${script}) must be a listed consumer`);
});

// Each producer's CLI, run for real in a temporary home: the failure it reports is specific and says what to check.
const cli = (script: string, args: string[], input: unknown, home: string) => {
  const result = spawnSync(process.execPath, [join(scripts, script), ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, MAA_SKILLS_HOME: home, HOME: home, USERPROFILE: home }, windowsHide: true });
  const line = [result.stdout, result.stderr].join('\n').split(/\r?\n/).find(text => text.includes('"check-required"'));
  return { status: result.status, body: line ? JSON.parse(line) as unknown : null, output: result.stdout + result.stderr };
};
const expectReason = (run: ReturnType<typeof cli>, reason: string) => {
  assert.ok(run.body, run.output); assert.ok(isCheckRequired(run.body), run.output);
  assert.equal((run.body as { reason: string }).reason, reason, run.output);
  assert.notEqual(run.status, 0);
};

test('producers report specific reasons from their real CLIs', async t => {
  const home = await mkdtemp(join(tmpdir(), 'maa-check-required-')); t.after(() => rm(home, { recursive: true, force: true }));
  const privateDirectory = join(home, 'private'), maaDirectory = join(home, 'maa'); await mkdir(privateDirectory); await mkdir(join(maaDirectory, 'config'), { recursive: true });
  await updateSettings({ language: 'zh-CN', privateDirectory }, home);
  const request = { stages: [{ stageId: 'synthetic_01', code: 'SYN-1', difficulty: 'normal', loops: 1 }], maaVersion: 'v6.21.4' };
  const tablesFile = join(home, 'tables.json'), jobsFile = join(home, 'jobs.json');
  await writeFile(tablesFile, JSON.stringify({ stages: { synthetic_01: { stageId: 'synthetic_01', code: 'SYN-1', levelId: 'obt/synthetic/level_synthetic_01', zoneId: 'synthetic_map', difficulty: 'NORMAL' } } }));
  await writeFile(jobsFile, '[]');

  // stage-jobs
  expectReason(cli('stage-jobs.ts', ['query'], { request, tablesFile, jobsFile }, home), 'stage-jobs-snapshot-missing');
  await writeFile(join(privateDirectory, 'account-snapshot.json'), '{"synthetic": ');
  expectReason(cli('stage-jobs.ts', ['query'], { request, tablesFile, jobsFile }, home), 'stage-jobs-snapshot-unreadable');
  await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify({ version: 1, source: 'maa', readAt: '2026-11-16T00:00:00.000Z', operators: [], items: {}, lmd: null, base: null,
    sourceTimes: { operators: null, inventory: null }, coverage: { operators: { status: 'missing', issues: [] }, inventory: { status: 'missing', issues: [] }, base: { status: 'unavailable', issues: [] } } }));
  expectReason(cli('stage-jobs.ts', ['query'], { request, tablesFile, jobsFile, extra: 1 }, home), 'stage-jobs-request-invalid');
  expectReason(cli('stage-jobs.ts', ['query'], { request: { ...request, stages: [{ ...request.stages[0], code: 'SYN-2' }] }, tablesFile, jobsFile }, home), 'stage-jobs-scope-invalid');
  expectReason(cli('stage-jobs.ts', ['query'], { request, tablesFile: join(home, 'missing.json'), jobsFile }, home), 'stage-jobs-input-file-unreadable');
  expectReason(cli('stage-jobs.ts', ['query'], { request, tablesFile, jobsFile, snapshotFile: join(home, 'missing-snapshot.json') }, home), 'stage-jobs-snapshot-missing');
  const approval = { reportHash: 'a'.repeat(64), reference: '合成批准', map: 'synthetic_map', selections: [{ stageId: 'synthetic_01', primary: 1, alternates: [], loops: 1 }] };
  expectReason(cli('stage-jobs.ts', ['prepare'], { approval, profile: 0, host: 'codex', expectedRevision: 'b'.repeat(64) }, home), 'maa-directory-unset');
  await updateSettings({ maaDirectory }, home);
  expectReason(cli('stage-jobs.ts', ['prepare'], { approval, profile: 0, host: 'codex', expectedRevision: 'b'.repeat(64) }, home), 'stage-jobs-report-missing');

  // stage-run
  expectReason(cli('stage-run.ts', ['read'], { extra: 1 }, home), 'request-invalid');
  expectReason(cli('stage-run.ts', ['read'], {}, home), 'run-not-found');

  // maa-config
  expectReason(cli('maa-config.ts', ['read'], '', home), 'maa-config-unreadable');
  expectReason(cli('maa-config.ts', ['write'], { authorization: { source: 'current-request', reference: 'x', basePlan: {} } }, home), 'base-apply-route-required');
  expectReason(cli('maa-config.ts', ['write'], { authorization: { source: 'current-request', reference: 'x', jobPlan: { continuation: {} } } }, home), 'job-continuation-route-required');
  expectReason(cli('maa-config.ts', ['write'], { unexpected: 1 }, home), 'maa-config-request-invalid');

  // account-snapshot and skland-account
  expectReason(cli('account-snapshot.ts', ['import'], { callbackFile: join(home, 'missing-callback.txt') }, home), 'account-input-unreadable');
  await writeFile(join(home, 'broken-snapshot.json'), '{"synthetic": ');
  expectReason(cli('skland-account.ts', ['compare'], { maaFile: join(home, 'broken-snapshot.json'), sklandFile: join(home, 'broken-snapshot.json') }, home), 'skland-snapshot-unreadable');
  expectReason(cli('skland-account.ts', ['compare'], { extra: 1 }, home), 'skland-request-invalid');

  // base-query
  expectReason(cli('base-query.ts', ['query'], { operators: ['合成甲'], snapshotFile: join(home, 'missing-snapshot.json') }, home), 'base-snapshot-missing');

  // Unreadable settings: each producer that reads them says so, instead of a reasonless failure.
  await writeFile(join(home, 'config.json'), '{"language": ');
  expectReason(cli('preferences.ts', ['read'], {}, home), 'settings-unreadable');
  expectReason(cli('maa-config.ts', ['read'], '', home), 'settings-unreadable');
  expectReason(cli('stage-run.ts', ['read'], {}, home), 'settings-unreadable');
  expectReason(cli('stage-jobs.ts', ['query'], { request, tablesFile, jobsFile }, home), 'settings-unreadable');
  expectReason(cli('base-query.ts', ['query'], { operators: ['合成甲'] }, home), 'settings-unreadable');
  expectReason(cli('skland-account.ts', ['compare'], {}, home), 'settings-unreadable');
});

test('setup reports a private directory it cannot write as specific, keeping its exit code for unexpected failures', async t => {
  const home = await mkdtemp(join(tmpdir(), 'maa-check-required-setup-')); t.after(() => rm(home, { recursive: true, force: true }));
  const privateDirectory = join(home, 'private'), maaDirectory = join(home, 'maa');
  await updateSettings({ language: 'en', privateDirectory, maaDirectory }, home);
  await writeFile(privateDirectory, 'synthetic blocked directory');
  const run = cli('setup.ts', ['prepare', '--json'], {}, home);
  expectReason(run, 'setup-files-unwritable');
  assert.equal(run.status, 2);
  assert.doesNotMatch(run.output, /EPERM|ENOTDIR|EEXIST|synthetic blocked/);
});
