import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { stageSklandSnapshot } from './fixtures/stage-data.ts';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { stageScenarios } from '../eval/maa-daily/stage-scenarios.ts';

test('stage scenarios run the installed shared CLI and leave candidate-only requests read-only', async () => {
  // Owner trial items 9 and 10 have their own tests below: they read the Skland snapshot or follow a check-required alternative.
  const own = ['daily-stage-mastery-insufficient', 'daily-stage-snapshot-alternative'];
  for (const scenario of stageScenarios.filter((item) => !item.maaProcess && !own.includes(item.id))) {
    const fixture = await createFixture({ skillDirectory: resolve('skills/maa-daily'), companionSkills: { 'maa-core': resolve('skills/maa-core') }, jsonInputs: scenario.jsonInputs });
    try {
      for (const host of ['.agents', '.claude']) {
        const execution = spawnSync(process.execPath, [`${host}/skills/maa-core/scripts/stage-jobs.ts`, 'query'], { cwd: fixture.workspace, env: fixture.env, encoding: 'utf8',
          input: JSON.stringify({ request: scenario.jsonInputs!['request.json'], tablesFile: 'tables.json', jobsFile: 'jobs.json' }) });
        assert.equal(execution.status, 0, execution.stdout + execution.stderr);
        const report = JSON.parse(execution.stdout).report;
        assert.equal(report.authorization, 'none'); assert.equal(report.stages.length, 1); assert.equal(report.stages[0].loops, 3);
        const unknownIds = ['daily-stage-unknown-elite', 'daily-stage-prerequisite', 'daily-stage-data-not-authority', 'daily-stage-requirements-unstated', 'daily-stage-undeclared-action',
          'daily-stage-prerequisite-question'];
        assert.equal(report.stages[0].candidates[0].status, unknownIds.includes(scenario.id) ? 'unknown' : scenario.id === 'daily-stage-support-named' ? 'support'
          : scenario.id === 'daily-stage-job-content-invalid' ? 'blocked' : 'ready');
        if (scenario.id === 'daily-stage-job-content-invalid') {
          assert.ok(report.stages[0].candidates[0].reasons.includes('job-content-invalid:job-group-name-duplicate')); assert.equal(report.stages[0].primary, 2);
        }
        if (scenario.id === 'daily-stage-prerequisite-question') assert.ok(report.stages[0].candidates[0].reasons.includes('prerequisite-unverified:synthetic_00:PASS'));
        if (scenario.id === 'daily-stage-requirements-unstated') assert.ok(report.stages[0].candidates[0].requirements[0].reasons.includes('requirements-unstated'));
        if (scenario.id === 'daily-stage-support-named') { assert.deepEqual(report.stages[0].supportCandidates, [1]); assert.equal(report.stages[0].primary, 2); }
        if (scenario.id === 'daily-stage-rating-order') { assert.equal(report.stages[0].primary, 2); assert.deepEqual(report.stages[0].alternates, [1]); }
        if (scenario.id === 'daily-stage-six-star-unsupported') {
          assert.deepEqual(report.stages[0].candidates.map((candidate: Record<string, unknown>) => [candidate.status, candidate.stageMatch]), [['ready', 'this-stage'], ['blocked', 'same-map-unprovable']]);
          const discovery = spawnSync(process.execPath, [`${host}/skills/maa-core/scripts/stage-jobs.ts`, 'stages'], { cwd: fixture.workspace, env: fixture.env, encoding: 'utf8', input: JSON.stringify({ codes: ['SYN-2'], tablesFile: 'tables.json' }) });
          assert.equal(discovery.status, 0, discovery.stdout + discovery.stderr);
          assert.deepEqual(JSON.parse(discovery.stdout).stages.map((stage: Record<string, unknown>) => [stage.stageId, stage.difficulty, stage.tableDifficulty]), [['synthetic_02', 'normal', 'NORMAL'], ['synthetic_02#s', 'unsupported', 'SIX_STAR']]);
        }
        if (scenario.id === 'daily-stage-undeclared-action') assert.deepEqual(report.stages[0].candidates[0].actionNames.unrecognized, ['合成丙']);
        if (scenario.id === 'daily-stage-alternative-requirements') assert.equal(report.stages[0].candidates[0].assignment['合成组'], '合成乙');
      }
      const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] }); assert.deepEqual(evidence.changes, []); assert.equal(evidence.events.length, scenario.id === 'daily-stage-six-star-unsupported' ? 4 : 2);
    } finally { await fixture.dispose(); }
  }
});

test('the approved preparation scenario grades query, read, prepare and read-back through the shared writer', async (t) => {
  const scenario = stageScenarios.find((item) => item.id === 'daily-stage-prepare-approved')!;
  for (const host of ['.agents', '.claude']) await t.test(host, async (t) => {
    const fixture = await createFixture({ skillDirectory: resolve('skills/maa-daily'), companionSkills: { 'maa-core': resolve('skills/maa-core') }, maaProcess: scenario.maaProcess!,
      jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
    t.after(() => fixture.dispose());
    const startedAt = new Date().toISOString();
    const call = (script: string, action: string, input: unknown) => {
      const result = spawnSync(process.execPath, [`${host}/skills/maa-core/scripts/${script}.ts`, action], { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
    };
    call('preferences', 'read', { currentLanguage: 'zh-CN' });
    const { report } = call('stage-jobs', 'query', { request: scenario.jsonInputs!['request.json'], tablesFile: 'tables.json', jobsFile: 'jobs.json', saveReport: true });
    const { configuration } = call('maa-config', 'read', {});
    const reference = scenario.policy.writerTransaction!.reference;
    const prepared = call('stage-jobs', 'prepare', { approval: { reportHash: report.hash, map: 'synthetic_map', reference,
      selections: [{ stageId: 'synthetic_01', primary: 1, alternates: [2], loops: 3 }] }, profile: configuration.currentProfile, host: host === '.agents' ? 'codex' : 'claude', expectedRevision: configuration.revision });
    assert.equal(prepared.status, 'complete');
    assert.equal(call('maa-config', 'read', {}).configuration.profiles[0].jobCount, 3);
    const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
    evidence.executionWindow = { startedAt, endedAt: new Date().toISOString() };
    const policy = { ...scenario.policy, secrets: fixture.policy.secrets };
    assert.equal(grade(policy, evidence).status, 'pass', JSON.stringify(grade(policy, evidence)));
    const wrongPlan = { ...policy, writerTransaction: { ...policy.writerTransaction!, jobPlan: { map: 'synthetic_map', entries: [{ stageId: 'synthetic_01', loops: 2, primary: 1, alternates: [2] }] } } };
    assert.equal(grade(wrongPlan, evidence).status, 'fail', 'a different approved loop count is not this transaction');
  });
});

// Owner trial items 9 and 10: each new scenario's correct path, run through the installed CLIs and graded.
const fixtureFor = (scenario: (typeof stageScenarios)[number]) => createFixture({ skillDirectory: resolve('skills/maa-daily'), companionSkills: { 'maa-core': resolve('skills/maa-core') },
  ...(scenario.maaProcess ? { maaProcess: scenario.maaProcess } : {}), jsonInputs: scenario.jsonInputs, jsonFiles: scenario.jsonFiles });
const runner = (fixture: Awaited<ReturnType<typeof createFixture>>, host: string) => (script: string, action: string, input: unknown) => {
  const result = spawnSync(process.execPath, [`${host}/skills/maa-core/scripts/${script}.ts`, action], { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8' });
  return { status: result.status, body: JSON.parse(result.stdout || result.stderr) };
};
const facts = [{ name: '合成甲', source: 'user-confirmed', reference: '合成甲二技能专三，Y 模组二级', mastery: { 2: 3 }, moduleTypes: { Y: 2 } }];
for (const [id, extra] of [['daily-stage-prepare-skland-mastery', { snapshotFile: 'private/account-snapshot-skland.json' }],
  ['daily-stage-prepare-user-confirmed', { operatorFacts: facts }]] as const) test(`${id}: the job is ready only with the real data, and preparing it passes the grade`, async (t) => {
  const scenario = stageScenarios.find((item) => item.id === id)!;
  const fixture = await fixtureFor(scenario); t.after(() => fixture.dispose());
  const call = runner(fixture, '.agents'), startedAt = new Date().toISOString();
  assert.equal(call('preferences', 'read', { currentLanguage: 'zh-CN' }).status, 0);
  const request = scenario.jsonInputs!['request.json'] as Record<string, unknown>;
  const first = call('stage-jobs', 'query', { request, tablesFile: 'tables.json', jobsFile: 'jobs.json' }).body.report;
  if ('snapshotFile' in extra) {
    // OB-9: with both snapshots saved, the query reads the Skland snapshot whole on its own, since the MAA one has no skills.
    assert.equal(first.stages[0].candidates[0].status, 'ready'); assert.equal(first.snapshotSelection.chosen, 'skland-covers');
  } else assert.equal(first.stages[0].candidates[0].status, 'unknown', 'without the user\'s facts the mastery and module stay 待核');
  const query = 'snapshotFile' in extra ? { request } : { request: { ...request, operatorFacts: extra.operatorFacts } };
  const { body: { report } } = call('stage-jobs', 'query', { ...query, tablesFile: 'tables.json', jobsFile: 'jobs.json', saveReport: true });
  assert.equal(report.stages[0].candidates[0].status, 'ready');
  const { configuration } = call('maa-config', 'read', {}).body;
  const prepared = call('stage-jobs', 'prepare', { approval: { reportHash: report.hash, map: 'synthetic_map', reference: scenario.policy.writerTransaction!.reference,
    selections: [{ stageId: 'synthetic_01', primary: 1, alternates: [], loops: 3 }] }, profile: configuration.currentProfile, host: 'codex', expectedRevision: configuration.revision });
  assert.equal(prepared.body.status, 'complete', JSON.stringify(prepared.body));
  assert.equal(call('maa-config', 'read', {}).body.configuration.profiles[0].jobCount, 3);
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  evidence.executionWindow = { startedAt, endedAt: new Date().toISOString() };
  const policy = { ...scenario.policy, secrets: fixture.policy.secrets };
  assert.equal(grade(policy, evidence).status, 'pass', JSON.stringify(grade(policy, evidence)));
});

test('daily-stage-mastery-insufficient: the Skland snapshot proves the mastery short, so the job is blocked and nothing is written', async (t) => {
  const scenario = stageScenarios.find((item) => item.id === 'daily-stage-mastery-insufficient')!;
  const fixture = await fixtureFor(scenario); t.after(() => fixture.dispose());
  const call = runner(fixture, '.claude');
  call('preferences', 'read', { currentLanguage: 'zh-CN' });
  // OB-9: no snapshotFile; the query reads the Skland snapshot because the MAA one has no mastery.
  const { body: { report } } = call('stage-jobs', 'query', { request: scenario.jsonInputs!['request.json'], tablesFile: 'tables.json', jobsFile: 'jobs.json' });
  assert.equal(report.snapshotSelection.source, 'skland');
  assert.equal(report.stages[0].candidates[0].status, 'blocked'); assert.ok(report.stages[0].candidates[0].requirements[0].reasons.includes('insufficient-mastery'));
  assert.equal(report.stages[0].primary, 2);
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  assert.deepEqual(evidence.changes, []);
  assert.equal(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence).status, 'pass');
});

test('daily-stage-snapshot-alternative: the missing snapshot is a specific check-required result whose alternative works', async (t) => {
  const scenario = stageScenarios.find((item) => item.id === 'daily-stage-snapshot-alternative')!;
  const fixture = await fixtureFor(scenario); t.after(() => fixture.dispose());
  const call = runner(fixture, '.agents');
  call('preferences', 'read', { currentLanguage: 'zh-CN' });
  const input = { request: scenario.jsonInputs!['request.json'], tablesFile: 'tables.json', jobsFile: 'jobs.json', format: 'markdown' };
  const missing = call('stage-jobs', 'query', input);
  assert.equal(missing.status, 1); assert.equal(missing.body.status, 'check-required'); assert.equal(missing.body.reason, 'stage-jobs-snapshot-missing');
  assert.ok(missing.body.alternatives.some((item: string) => item.includes('森空岛') && item.includes('重新查询')));
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  assert.deepEqual(evidence.changes, []);
  // Following the alternative: once maa-account has saved a Skland snapshot (written here as its result), the same query works.
  await writeFile(join(fixture.workspace, 'private', 'account-snapshot-skland.json'), JSON.stringify(stageSklandSnapshot()));
  const followed = spawnSync(process.execPath, ['.agents/skills/maa-core/scripts/stage-jobs.ts', 'query'], { cwd: fixture.workspace, env: fixture.env, encoding: 'utf8', input: JSON.stringify(input) });
  assert.equal(followed.status, 0, followed.stdout + followed.stderr); assert.match(followed.stdout, /作业 1：ready/);
  assert.equal(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence).status, 'pass', JSON.stringify(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence)));
});

test('daily-stage-job-confirmed: one confirmation of the job in the owner words makes it ready, and preparing it passes the grade', async (t) => {
  const scenario = stageScenarios.find((item) => item.id === 'daily-stage-job-confirmed')!;
  const fixture = await fixtureFor(scenario); t.after(() => fixture.dispose());
  const call = runner(fixture, '.claude'), startedAt = new Date().toISOString();
  assert.equal(call('preferences', 'read', { currentLanguage: 'zh-CN' }).status, 0);
  const request = scenario.jsonInputs!['request.json'] as Record<string, unknown>;
  const first = call('stage-jobs', 'query', { request, tablesFile: 'tables.json', jobsFile: 'jobs.json' }).body.report.stages[0].candidates[0];
  assert.equal(first.status, 'unknown'); assert.equal(first.confirmable, true);
  const jobConfirmations = [{ jobId: 1, contentHash: first.hash, source: 'user-confirmed', reference: '我核实了，都是满足的。直接开始。' }];
  const { body: { report } } = call('stage-jobs', 'query', { request: { ...request, jobConfirmations }, tablesFile: 'tables.json', jobsFile: 'jobs.json', saveReport: true });
  assert.equal(report.stages[0].candidates[0].status, 'ready');
  const { configuration } = call('maa-config', 'read', {}).body;
  const prepared = call('stage-jobs', 'prepare', { approval: { reportHash: report.hash, map: 'synthetic_map', reference: scenario.policy.writerTransaction!.reference,
    selections: [{ stageId: 'synthetic_01', primary: 1, alternates: [], loops: 3 }] }, profile: configuration.currentProfile, host: 'claude', expectedRevision: configuration.revision });
  assert.equal(prepared.body.status, 'complete', JSON.stringify(prepared.body));
  assert.equal(call('maa-config', 'read', {}).body.configuration.profiles[0].jobCount, 3);
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  evidence.executionWindow = { startedAt, endedAt: new Date().toISOString() };
  assert.equal(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence).status, 'pass', JSON.stringify(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence)));
});
