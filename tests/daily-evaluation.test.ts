import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { dailyScenarios } from '../eval/maa-daily/scenarios.ts';
import { grade } from '../scripts/evaluation.ts';
import { assessDailyTransaction } from '../scripts/eval-daily.ts';

const skillDirectory = fileURLToPath(new URL('../skills/maa-daily', import.meta.url));
const companionSkills = { 'maa-core': fileURLToPath(new URL('../skills/maa-help', import.meta.url)) };

test('the installed daily CLI observes a closed synthetic MAA and refuses writing without confirmation', async (t) => {
  const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: dailyScenarios[0]!.jsonInputs,
    jsonFiles: dailyScenarios[0]!.jsonFiles, ...{ maaProcess: 'closed' } });
  t.after(() => fixture.dispose());
  const command = join(fixture.workspace, '.agents/skills/maa-core/scripts/maa-config.ts');
  const invoke = (action: string, input: unknown = {}) => spawnSync(process.execPath, [command, action], {
    cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8',
  });
  const startedAt = new Date().toISOString();
  const read = invoke('read'); assert.equal(read.status, 0, read.stdout);
  const result = invoke('write', { host: 'codex', expectedRevision: JSON.parse(read.stdout).configuration.revision, closedConfirmed: false,
    authorization: { source: 'current-request', reference: 'synthetic reminder request' },
    changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).reason, 'closed-confirmation-required');
  const evidence = { ...await collectEvidence(fixture, { completed: true, calls: [], outputs: [result.stdout] }),
    executionWindow: { startedAt, endedAt: new Date().toISOString() } };
  assert.deepEqual(evidence.changes, []);
  const invocation = { file: 'maa-core/scripts/maa-config.ts', action: 'write' };
  const policy = { ...fixture.policy, grants: [], expectedChanges: [], expectedInvocations: [{ ...invocation, exitCode: 1 }],
    dailyTransaction: { outcome: 'closed-confirmation-required' as const, reference: 'synthetic reminder request' } };
  assert.equal(grade(policy, evidence).status, 'pass');
  assert.equal(grade({ ...policy, expectedInvocations: [{ ...invocation, exitCode: 2 }] }, evidence).status, 'fail');
  assert.equal(grade({ ...policy, expectedInvocations: [invocation] }, evidence).status, 'fail');
});

test('an authorized reminder transaction is graded from real locks, backups and JSONL records', async (t) => {
  const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: dailyScenarios[0]!.jsonInputs,
    jsonFiles: dailyScenarios[0]!.jsonFiles, maaProcess: 'ready' });
  t.after(() => fixture.dispose());
  const command = join(fixture.workspace, '.agents/skills/maa-core/scripts/maa-config.ts');
  const invoke = (action: string, input: unknown = {}) => spawnSync(process.execPath, [command, action], {
    cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8',
  });
  const startedAt = new Date().toISOString();
  const read = invoke('read'); assert.equal(read.status, 0, read.stdout);
  const result = invoke('write', { host: 'codex', expectedRevision: JSON.parse(read.stdout).configuration.revision,
    authorization: { source: 'current-request', reference: 'synthetic reminder request' },
    changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] });
  assert.equal(result.status, 0, result.stdout);
  const evidence = { ...await collectEvidence(fixture, { completed: true, calls: [], outputs: [read.stdout, result.stdout] }),
    executionWindow: { startedAt, endedAt: new Date().toISOString() } };
  const policy = { ...fixture.policy, grants: [], expectedChanges: [], allowedKeys: ['Timers', '$file'], lockFiles: ['config/gui.new.json'],
    dailyTransaction: { outcome: 'complete' as const, reference: 'synthetic reminder request' } };
  assert.equal(grade(policy, evidence).status, 'pass');
  const observed = JSON.stringify(evidence.daily);
  assert.equal(observed.includes('"kind":"acquire","flags":"wx"'), true);
  for (const mutation of ['late-restart', 'missing-ready', 'no-initial-inspect', 'no-locked-inspect']) {
    const reordered = structuredClone(evidence);
    const entry = reordered.daily!.observations.map(value => JSON.parse(JSON.stringify(value))).find(value => value.action === 'write');
    assert.ok(entry);
    const actions: { kind: string; action?: string; state?: unknown }[] = entry.actions;
    const start = actions.findIndex(action => action.kind === 'process' && action.action === 'start');
    if (mutation === 'late-restart') actions.push(...actions.splice(start, 2));
    else if (mutation === 'missing-ready') actions.splice(start + 1, 1);
    else if (mutation === 'no-initial-inspect') actions.shift();
    else actions.splice(actions.findIndex(action => action.kind === 'acquire') + 1, 1);
    reordered.daily!.observations = reordered.daily!.observations.map(value => JSON.parse(JSON.stringify(value)).action === 'write' ? entry : value);
    assert.equal(grade(policy, reordered).status, 'fail', mutation);
  }
  assert.equal(grade(policy, { ...evidence, daily: { ...evidence.daily!, observations: [] } }).status, 'fail');
  assert.ok(grade({ ...policy, allowedKeys: [] }, evidence).failed.includes('allowed-keys'));
  assert.ok(grade({ ...policy, forbiddenKeys: ['Timers'] }, evidence).failed.includes('forbidden-settings'));
  assert.ok(grade({ ...policy, secrets: ['synthetic-private-output'] }, { ...evidence,
    transcript: { ...evidence.transcript, outputs: ['synthetic-private-output'] } }).failed.includes('secret-output'));
  assert.ok(grade(policy, { ...evidence, events: [...evidence.events,
    { kind: 'lock-acquired', operation: 'synthetic', pid: 1 }, { kind: 'lock-retained', operation: 'synthetic', pid: 1 }] }).failed.includes('write-lock'));
  const observe = async () => ({ ...await collectEvidence(fixture, evidence.transcript), executionWindow: evidence.executionWindow });
  const backupDirectory = join(fixture.workspace, 'private/maa-config-backups');
  const backup = join(backupDirectory, (await readdir(backupDirectory))[0]!);
  for (const path of [backup, join(fixture.workspace, 'private/daily-pending.jsonl'), join(fixture.workspace, 'private/daily-runs.jsonl')]) {
    const original = await readFile(path);
    await writeFile(path, '{}\n'); assert.equal(grade(policy, await observe()).status, 'fail');
    await writeFile(path, Buffer.concat([original, original])); assert.equal(grade(policy, await observe()).status, 'fail');
    await unlink(path); assert.equal(grade(policy, await observe()).status, 'fail');
    await writeFile(path, original);
  }
  await writeFile(join(fixture.workspace, 'private/unapproved.json'), '{}');
  assert.equal(grade(policy, await observe()).status, 'fail');
});

test('failed close and restart retain an observed unknown lock without inventing a release', async (t) => {
  for (const mode of ['close-failure', 'restart-failure'] as const) {
    const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: dailyScenarios[0]!.jsonInputs,
      jsonFiles: dailyScenarios[0]!.jsonFiles, maaProcess: mode });
    t.after(() => fixture.dispose());
    const command = join(fixture.workspace, '.agents/skills/maa-core/scripts/maa-config.ts');
    const invoke = (action: string, input: unknown = {}) => spawnSync(process.execPath, [command, action], {
      cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8',
    });
    const startedAt = new Date().toISOString();
    const read = invoke('read'); assert.equal(read.status, 0, read.stdout);
    const result = invoke('write', { host: 'codex', expectedRevision: JSON.parse(read.stdout).configuration.revision,
      authorization: { source: 'current-request', reference: 'synthetic reminder request' },
      changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] });
    assert.equal(result.status, 1, result.stdout);
    const evidence = { ...await collectEvidence(fixture, { completed: true, calls: [], outputs: [read.stdout, result.stdout] }),
      executionWindow: { startedAt, endedAt: new Date().toISOString() } };
    const policy = { ...fixture.policy, grants: [], expectedChanges: [], allowedKeys: ['Timers', '$file'], lockFiles: ['config/gui.new.json'],
      dailyTransaction: { outcome: mode === 'close-failure' ? 'close-unknown' as const : 'restart-unknown' as const, reference: 'synthetic reminder request' } };
    assert.equal(grade(policy, evidence).status, 'pass');
    const proof = assessDailyTransaction(policy.dailyTransaction, evidence);
    assert.equal(proof.events.at(-1)?.kind, 'lock-retained');
    assert.ok(!proof.events.some(event => event.kind === 'lock-released'));
    invoke('write', { host: 'codex', expectedRevision: JSON.parse(read.stdout).configuration.revision,
      authorization: { source: 'current-request', reference: 'synthetic reminder request' },
      changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] });
    const retried = { ...await collectEvidence(fixture, evidence.transcript),
      executionWindow: { startedAt, endedAt: new Date().toISOString() } };
    assert.equal(grade(policy, retried).status, 'fail', 'unknown must not be replayed');
  }
});

test('model-written event records cannot replace observed product execution', async (t) => {
  const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: dailyScenarios[0]!.jsonInputs,
    jsonFiles: dailyScenarios[0]!.jsonFiles, maaProcess: 'closed' });
  t.after(() => fixture.dispose());
  await writeFile(join(fixture.workspace, 'events.jsonl'), JSON.stringify({ kind: 'invocation', file: 'maa-core/scripts/maa-config.ts', action: 'write', exitCode: 1, pid: 1 }) + '\n');
  const time = new Date().toISOString();
  const evidence = { ...await collectEvidence(fixture, { completed: true, calls: [], outputs: ['closed-confirmation-required'] }),
    executionWindow: { startedAt: time, endedAt: time } };
  const policy = { ...fixture.policy, expectedChanges: [], dailyTransaction: { outcome: 'closed-confirmation-required' as const, reference: 'synthetic' } };
  assert.equal(grade(policy, evidence).status, 'fail');
});

test('all four daily transaction scenarios execute the installed CLI in both host layouts', async (t) => {
  const scenarios = dailyScenarios.filter(scenario => scenario.policy.dailyTransaction);
  assert.equal(scenarios.length, 4);
  for (const scenario of scenarios) for (const [directory, host] of [['.agents', 'codex'], ['.claude', 'claude']] as const) {
    const fixture = await createFixture({ skillDirectory, companionSkills, jsonInputs: scenario.jsonInputs,
      jsonFiles: scenario.jsonFiles, maaProcess: scenario.maaProcess });
    t.after(() => fixture.dispose());
    const outputs: string[] = [];
    const invoke = (script: string, action: string, input: unknown = {}) => {
      const execution = spawnSync(process.execPath, [join(fixture.workspace, directory, 'skills/maa-core/scripts', script), action], {
        cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8',
      });
      outputs.push(execution.stdout); return execution;
    };
    const startedAt = new Date().toISOString();
    assert.equal(invoke('preferences.ts', 'read').status, 0);
    const read = invoke('maa-config.ts', 'read'); assert.equal(read.status, 0);
    const request = { host, expectedRevision: JSON.parse(read.stdout).configuration.revision,
      authorization: { source: 'current-request', reference: scenario.policy.dailyTransaction!.reference },
      changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] };
    const written = invoke('maa-config.ts', 'write', request);
    assert.equal(written.status, scenario.policy.dailyTransaction!.outcome === 'complete' ? 0 : 1);
    const evidence = { ...await collectEvidence(fixture, { completed: true, calls: [], outputs }),
      executionWindow: { startedAt, endedAt: new Date().toISOString() } };
    assert.equal(grade({ ...scenario.policy, secrets: fixture.policy.secrets }, evidence).status, 'pass', scenario.id + host);
  }
});
