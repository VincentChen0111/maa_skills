// Ticket 32 (owner, 2026-11-16: 「check required 要给我具体的，和有没有替代」): one table per command family owns every reason a
// command can stop on. This conformance test enumerates the producers — every static code thrown in the training and gap
// scripts, every check-required reason they return, and the codes their direct dependencies can throw into them — and
// requires an entry with what to check and at least one alternative.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trainingChecks, trainingCheckRequired } from '../skills/maa-core/scripts/training-state.ts';
import { gapChecks, gapCheckRequired } from '../skills/maa-core/scripts/cultivation-gaps.ts';

const thrown = async (file: string) => {
  const text = await readFile(resolve('skills/maa-core/scripts', file), 'utf8');
  const literal = [...text.matchAll(/new (?:Error|TrainingCheckError)\('([a-z][a-z0-9-]*)'/g)].map(match => match[1]!);
  const prefixed = [...text.matchAll(/new Error\(`([a-z][a-z0-9-]*):\$\{/g)].map(match => match[1]!);
  const returned = [...text.matchAll(/status: 'check-required'(?: as const)?, reason: '([a-z][a-z0-9-]*)'/g)].map(match => match[1]!);
  const conditional = [...text.matchAll(/reason: [^,]*\? '([a-z][a-z0-9-]*)' : '([a-z][a-z0-9-]*)'/g)].flatMap(match => [match[1]!, match[2]!]);
  return [...literal, ...prefixed, ...returned, ...conditional];
};
const covered = (table: Record<string, { check: string; alternatives: string[] }>, code: string) => {
  const entry = table[code] ?? table[code.split(':')[0]!];
  return Boolean(entry && entry.check.trim() && entry.alternatives.length && entry.alternatives.every(item => item.trim()));
};

test('32: every reason a training command can stop on has a check and alternatives', async () => {
  const own = (await Promise.all(['training-plan.ts', 'training-time.ts', 'training-state.ts', 'training-config.ts'].map(thrown))).flat();
  // Direct dependencies that can throw into prepare, query and refresh: approved-report resolution, the base-skill query, settings.
  const dependencies = ['report-reference-invalid', 'report-not-approvable:pending-review', 'report-item-not-approved', 'report-not-found', 'report-content-mismatch',
    'report-content-invalid', 'report-record-invalid', 'base-data-invalid', 'base-snapshot-invalid', 'base-snapshot-required', 'base-input-invalid', 'base-room-invalid',
    'base-cross-check-invalid', 'settings-unreadable', 'maa-directory-unset'];
  assert.ok(own.length > 30, 'the enumeration found the producers');
  assert.deepEqual([...new Set([...own, ...dependencies])].filter(code => !covered(trainingChecks, code)), []);
  for (const code of ['training-facts-required', 'report-not-approvable:needs-correction', 'something-never-listed']) {
    const output = trainingCheckRequired(code);
    assert.deepEqual(Object.keys(output), ['ok', 'status', 'reason', 'check', 'alternatives']);
    assert.equal(output.status, 'check-required'); assert.ok(output.alternatives.length);
  }
  assert.equal(trainingCheckRequired('something-never-listed').reason, 'training-unclassified-failure');
});

test('32: every reason the gap command can stop on has a check and alternatives, and the CLI prints that shape', async t => {
  const own = await thrown('cultivation-gaps.ts');
  assert.deepEqual([...new Set([...own, 'cost-source-unavailable:items', 'settings-unreadable'])].filter(code => !covered(gapChecks, code)), []);
  assert.equal(gapCheckRequired('gaps-source-unavailable:building').reason, 'gaps-source-unavailable:building');
  const root = await mkdtemp(join(tmpdir(), 'gap-checks-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: root }));
  const run = spawnSync(process.execPath, [resolve('skills/maa-core/scripts/cultivation-gaps.ts'), 'query'], { input: JSON.stringify({ targets: [] }), encoding: 'utf8',
    env: { ...process.env, MAA_SKILLS_HOME: root } });
  assert.equal(run.status, 1);
  assert.deepEqual(JSON.parse(run.stderr), gapCheckRequired('gaps-snapshot-unavailable'));
});
