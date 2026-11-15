// Ticket 32 (owner, 2026-11-16: 「check required 要给我具体的，和有没有替代」): the shared module `check-required.ts` owns every
// reason a command can stop on (adopted by the training fix after the central merge). This conformance test enumerates the
// producers — every static code thrown in the training and gap scripts, every check-required result they build in the flow,
// and the codes their direct dependencies can throw into them — and requires each to map to a catalogue reason (not the
// producer's fallback) with what to check and at least one alternative.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkRequired, checkRequiredFor, checkRequiredReason, isCheckRequired, producers, type CheckRequiredProducer } from '../skills/maa-core/scripts/check-required.ts';

const thrown = async (file: string) => {
  const text = await readFile(resolve('skills/maa-core/scripts', file), 'utf8');
  const literal = [...text.matchAll(/new (?:Error|TrainingCheckError)\('([a-z][a-z0-9-]*)'/g)].map(match => match[1]!);
  const prefixed = [...text.matchAll(/new Error\(`([a-z][a-z0-9-]*):\$\{/g)].map(match => match[1]!);
  // Results built in the flow (apply, close, reconcile) name their reason through the module's constructor or the plan's `held`.
  const built = [...text.matchAll(/\b(?:held|checkRequired)\('([a-z][a-z0-9-]*)'/g)].map(match => match[1]!);
  const conditional = [...text.matchAll(/\b(?:held|checkRequired)\([^,)]*\? '([a-z][a-z0-9-]*)' : '([a-z][a-z0-9-]*)'/g)].flatMap(match => [match[1]!, match[2]!]);
  return [...literal, ...prefixed, ...built, ...conditional];
};
/** A code maps to a catalogue reason other than the producer's fallback, and that reason says what to check and what else to do. */
const covered = (producer: CheckRequiredProducer, code: string) => {
  const reason = checkRequiredReason(producer, new Error(code));
  if (reason === producers[producer].fallback && code !== reason) return false;
  const result = checkRequired(reason);
  return Boolean(result.check.trim() && result.alternatives.length && result.alternatives.every(item => item.trim()));
};

test('32: every reason a training command can stop on maps to a catalogue reason with a check and alternatives', async () => {
  const own = (await Promise.all(['training-plan.ts', 'training-time.ts', 'training-state.ts', 'training-config.ts'].map(thrown))).flat();
  // Direct dependencies that can throw into prepare, query and refresh: approved-report resolution, the base-skill query, settings.
  const dependencies = ['report-reference-invalid', 'report-not-approvable:pending-review', 'report-item-not-approved', 'report-not-found', 'report-content-mismatch',
    'report-content-invalid', 'report-record-invalid', 'base-data-invalid', 'base-snapshot-invalid', 'base-snapshot-required', 'base-input-invalid', 'base-room-invalid',
    'base-cross-check-invalid', 'settings-unreadable', 'maa-directory-unset'];
  assert.ok(own.length > 30, 'the enumeration found the producers');
  for (const producer of ['training-plan', 'training-time'] as const) assert.deepEqual([...new Set([...own, ...dependencies])].filter(code => !covered(producer, code)), [], producer);
  for (const code of ['training-facts-required', 'report-not-approvable:needs-correction', 'something-never-listed']) {
    const output = checkRequiredFor('training-plan', new Error(code));
    assert.ok(isCheckRequired(output), code); assert.ok(output.alternatives.length, code);
  }
  assert.equal(checkRequiredFor('training-plan', new Error('something-never-listed')).reason, 'training-unclassified-failure');
});

test('32: every reason the gap command can stop on maps to a catalogue reason, and the CLI prints the shared shape', async t => {
  const own = await thrown('cultivation-gaps.ts');
  assert.deepEqual([...new Set([...own, 'cost-source-unavailable:items', 'settings-unreadable'])].filter(code => !covered('cultivation-gaps', code)), []);
  assert.deepEqual(checkRequiredFor('cultivation-gaps', new Error('gaps-source-unavailable:building')).details, { detail: 'building' });
  const root = await mkdtemp(join(tmpdir(), 'gap-checks-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: root }));
  const run = spawnSync(process.execPath, [resolve('skills/maa-core/scripts/cultivation-gaps.ts'), 'query'], { input: JSON.stringify({ targets: [] }), encoding: 'utf8',
    env: { ...process.env, MAA_SKILLS_HOME: root } });
  assert.equal(run.status, 1);
  assert.deepEqual(JSON.parse(run.stderr), checkRequired('gaps-snapshot-unavailable'));
});
