import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runScenario } from '../scripts/eval-run.ts';

test('a missing real host yields retained unverified evidence and no invented model result', async (t) => {
  const result = await runScenario({ host: 'claude', model: 'fixed-model', executable: 'maa-synthetic-absent-cli', scenario: 'approved-write' });
  t.after(() => rm(result.artifactDirectory, { recursive: true, force: true }));
  assert.equal(result.record.grade.status, 'unverified');
  assert.equal(result.reason, 'host-unavailable');
  assert.ok(result.artifactDirectory.startsWith(resolve('.tmp/evaluations')), 'evidence survives the shell temporary-directory lifecycle');
  assert.ok(result.record.evidenceHash);
  const saved = JSON.parse(await readFile(result.artifactDirectory + '/run.json', 'utf8'));
  assert.equal(saved.model, 'fixed-model');
  assert.equal(saved.host, 'claude');
  assert.ok(!JSON.stringify(saved).includes('synthetic-credential'));
  await assert.rejects(access(result.fixtureDirectory), /ENOENT/);
});

test('custom scenarios preserve their own prompt and identity for subsequent skill baselines', async (t) => {
  const result = await runScenario({ host: 'codex', model: 'fixed-model', executable: 'maa-synthetic-absent-cli', scenario: {
    id: 'custom-preferences', prompt: '使用待测 skill，保持文件不变。',
    jsonInputs: { 'private/config.json': { language: 'en' } }, jsonFiles: ['private/config.json'],
    policy: { allowedKeys: [], forbiddenKeys: ['stone'], grants: [], downloadGrants: [], expectedCalls: ['node custom-tool.ts inspect'], expectedChanges: [], reportRequired: false, skipReview: false },
  } });
  t.after(() => rm(result.artifactDirectory, { recursive: true, force: true }));
  assert.equal(result.record.scenario, 'custom-preferences');
  const invocation = JSON.parse(await readFile(result.artifactDirectory + '/invocation.json', 'utf8'));
  assert.match(invocation.prompt, /使用待测 skill/);
  const replay = JSON.parse(await readFile(result.artifactDirectory + '/scenario.json', 'utf8'));
  assert.equal(replay.jsonInputs['private/config.json'].language, 'en');
  assert.ok(replay.policy.secrets[0].startsWith('synthetic-'));
  const claude = await runScenario({ host: 'claude', model: 'fixed-model', executable: 'maa-synthetic-absent-cli', scenario: {
    id: 'custom-command', prompt: 'Read synthetic data with the supplied tool.',
    commands: ['node other-tool.ts *'],
    policy: { allowedKeys: [], forbiddenKeys: [], grants: [], downloadGrants: [], expectedCalls: ['node custom-tool.ts inspect'], expectedChanges: [], reportRequired: false, skipReview: false },
  } });
  t.after(() => rm(claude.artifactDirectory, { recursive: true, force: true }));
  const claudeInvocation = JSON.parse(await readFile(claude.artifactDirectory + '/invocation.json', 'utf8'));
  assert.ok(claudeInvocation.args.includes('Bash(node other-tool.ts *)'), 'declared tool permissions are distinct from expected calls');
  assert.ok(!claudeInvocation.args.includes('Bash(node custom-tool.ts inspect)'));
  assert.equal(result.record.grade.status, 'unverified');
});

test('scenario-supplied execution windows cannot create trusted time evidence for a missing host', async (t) => {
  const result = await runScenario({ host: 'codex', model: 'fixed-model', executable: 'maa-synthetic-absent-cli', scenario: {
    id: 'untrusted-window', prompt: 'Keep all files unchanged.',
    ...{ executionWindow: { startedAt: '1970-01-01T00:00:00.000Z', endedAt: '2999-01-01T00:00:00.000Z' } },
    policy: { allowedKeys: ['readAt'], forbiddenKeys: [], grants: [], downloadGrants: [], expectedCalls: [], expectedChanges: [],
      generatedUtcFields: [{ file: 'private/account-snapshot.json', key: 'readAt' }], reportRequired: false, skipReview: false },
  } });
  t.after(() => rm(result.artifactDirectory, { recursive: true, force: true }));
  const evidence = JSON.parse(await readFile(result.artifactDirectory + '/evidence.json', 'utf8'));
  assert.ok(!Object.hasOwn(evidence, 'executionWindow'));
  assert.equal(result.record.grade.status, 'unverified');
});
