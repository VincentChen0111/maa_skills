import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createFixture, collectEvidence, renderPolicy } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { entryId, scenarioCatalog, type ScenarioEntry } from '../scripts/eval-scenarios.ts';
import type { ScenarioDefinition } from '../scripts/eval-run.ts';
import { doctorHandoff, latestRecord, latestRecordKeys } from '../eval/maa-doctor/scenarios.ts';

/*
 * 26 H4 (recurrence rule). The same scenario defect showed up twice: daily-unknown (26 H, R8b) and then daily-base-apply-unknown
 * (third real run) told the model to hand an unknown write outcome to maa-doctor, the model ran doctor check, and the scenario did
 * not grant the latest record check writes. One helper owns that allowance (`doctorHandoff` in eval/maa-doctor/scenarios.ts); this
 * test enumerates every unknown-outcome world in the catalog (a retained write lock among its inputs) outside the maa-doctor group
 * and holds each to it, by structure and by running the installed doctor check in the scenario's own world.
 */
const lockFile = 'config/.maa-skills.lock';
const lockKey = (definition: ScenarioDefinition) => Object.keys(definition.jsonInputs ?? {}).find((key) => key === lockFile || key.endsWith(`/${lockFile}`));
const lockWorlds = (entries: ScenarioEntry[]) => entries.filter((entry) => entry.group !== 'maa-doctor' && typeof entry.definition === 'object' && !!lockKey(entry.definition));
const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
const doctorCheck = (layout: string) => `node ${layout}/skills/maa-core/scripts/doctor.ts check --json`;
const admitsDoctorCheck = (pattern: string) => ['.agents', '.claude'].some((layout) => glob(pattern).test(doctorCheck(layout)));

/** What a lock world misses of the handoff allowance, by structure: each piece the helper returns, the grants compared by value. */
function handoffProblems(entries: ScenarioEntry[]): string[] {
  const problems: string[] = [];
  for (const entry of lockWorlds(entries)) {
    const definition = entry.definition as ScenarioDefinition;
    const problem = (what: string) => problems.push(`${definition.id}: ${what}`);
    if (!Object.hasOwn(entry.companionSkills, 'maa-doctor')) problem('maa-doctor is not installed beside the subject');
    const commands = definition.commands ?? definition.policy.expectedCalls;
    for (const layout of ['.agents', '.claude']) if (!commands.some((pattern) => glob(pattern).test(doctorCheck(layout)))) problem(`no command pattern admits ${doctorCheck(layout)}`);
    if (!definition.jsonFiles?.includes(latestRecord)) problem('the latest record is not read key by key');
    for (const key of latestRecordKeys) if (!definition.policy.allowedKeys.includes(key)) problem(`the record key ${key} is not allowed`);
    if (!definition.policy.generatedUtcFields?.some((field) => field.file === latestRecord && field.key === 'checkedAt')) problem('checkedAt is not a generated time');
    // The grants doctor check writes in this world: the helper's literal record for its configuration and lock. Whether MAA.exe is
    // present and the connection settings are readable is the world's; the run below pins which one the installed doctor writes.
    const key = lockKey(definition)!;
    const inputs = definition.jsonInputs!;
    const configuration = inputs[`${key.slice(0, -lockFile.length)}config/gui.new.json`];
    const granted = definition.policy.grants.filter((grant) => grant.file === latestRecord);
    const worlds = [true, false].flatMap((maaPresent) => [true, false].map((connectionReadable) => ({ retained: inputs[key], maaPresent, connectionReadable })));
    if (!worlds.some((world) => isDeepStrictEqual(doctorHandoff(configuration, world).grants, granted))) problem('the latest record grants are not what doctor check writes in this world');
  }
  return problems;
}

type Piece = 'companion' | 'command' | 'record' | 'grants' | 'keys' | 'checkedAt';
const pieces: Piece[] = ['companion', 'command', 'record', 'grants', 'keys', 'checkedAt'];
/** The entry with the named pieces of the handoff allowance taken out. */
function strip(entry: ScenarioEntry, removed: Piece[]): ScenarioEntry {
  const definition = structuredClone(entry.definition as ScenarioDefinition);
  const companionSkills = { ...entry.companionSkills };
  if (removed.includes('companion')) { delete companionSkills['maa-doctor']; definition.companions = definition.companions?.filter((name) => name !== 'maa-doctor'); }
  if (removed.includes('command')) definition.commands = definition.commands?.filter((pattern) => !admitsDoctorCheck(pattern));
  if (removed.includes('record')) definition.jsonFiles = definition.jsonFiles?.filter((file) => file !== latestRecord);
  if (removed.includes('grants')) definition.policy.grants = definition.policy.grants.filter((grant) => grant.file !== latestRecord);
  if (removed.includes('keys')) definition.policy.allowedKeys = definition.policy.allowedKeys.filter((key) => !latestRecordKeys.includes(key));
  if (removed.includes('checkedAt')) definition.policy.generatedUtcFields = definition.policy.generatedUtcFields?.filter((field) => field.file !== latestRecord);
  return { ...entry, definition, companionSkills };
}
const replace = (catalog: ScenarioEntry[], next: ScenarioEntry) => catalog.map((entry) => entryId(entry) === entryId(next) ? next : entry);

test('every unknown-outcome world outside the maa-doctor group carries the maa-doctor handoff allowance (26 H4)', () => {
  const catalog = scenarioCatalog();
  const ids = lockWorlds(catalog).map(entryId);
  for (const id of ['daily-unknown', 'daily-base-apply-unknown']) assert.ok(ids.includes(id), `${id} is found as a lock world`);
  assert.deepEqual(handoffProblems(catalog), []);
});

test('the conformance check fails when a lock world loses any piece of the allowance, or a new lock world comes without it (26 H4)', () => {
  const catalog = scenarioCatalog();
  for (const entry of lockWorlds(catalog)) {
    for (const piece of pieces) {
      const problems = handoffProblems(replace(catalog, strip(entry, [piece])));
      assert.ok(problems.some((problem) => problem.startsWith(`${entryId(entry)}: `)), `${entryId(entry)} without ${piece}: ${JSON.stringify(problems)}`);
    }
  }
  // daily-base-apply-unknown as it was before 26 H4: the lock in its world and no allowance at all.
  const baseApply = catalog.find((entry) => entryId(entry) === 'daily-base-apply-unknown')!;
  assert.ok(handoffProblems(replace(catalog, strip(baseApply, pieces))).length >= pieces.length);
  // A new scenario whose world holds a retained lock, added without the allowance.
  const source = catalog.find((entry) => entryId(entry) === 'daily-base-apply-unapproved')!;
  const definition = structuredClone(source.definition as ScenarioDefinition);
  const added: ScenarioEntry = { ...source, definition: { ...definition, id: 'daily-base-apply-new-lock-world',
    jsonInputs: { ...definition.jsonInputs, [lockFile]: { incomplete: 'synthetic retained evidence' } } } };
  assert.ok(handoffProblems([...catalog, added]).some((problem) => problem.startsWith('daily-base-apply-new-lock-world: ')));
});

test('in every lock world the installed doctor check writes exactly the granted record, and without the allowance the same run fails authorization (26 H4)', async (t) => {
  for (const entry of lockWorlds(scenarioCatalog())) for (const layout of ['.agents', '.claude']) {
    const definition = entry.definition as ScenarioDefinition;
    const fixture = await createFixture({ ...(entry.skillDirectory ? { skillDirectory: entry.skillDirectory } : {}), companionSkills: entry.companionSkills,
      jsonInputs: definition.jsonInputs, jsonFiles: definition.jsonFiles });
    t.after(() => fixture.dispose());
    const startedAt = new Date().toISOString();
    const check = spawnSync(process.execPath, [join(fixture.workspace, layout, 'skills/maa-core/scripts/doctor.ts'), 'check', '--json'],
      { cwd: fixture.workspace, env: fixture.env, input: '{}', encoding: 'utf8', windowsHide: true });
    assert.equal(check.status, 1, `${entryId(entry)} ${layout}: the retained lock is an error row`);
    const evidence = { ...await collectEvidence(fixture, { completed: true, calls: [], outputs: [check.stdout] }), executionWindow: { startedAt, endedAt: new Date().toISOString() } };
    assert.deepEqual(evidence.changes.map((change) => `${change.file}#${change.key}`).sort(), latestRecordKeys.map((key) => `${latestRecord}#${key}`).sort(),
      `${entryId(entry)} ${layout}: check writes its latest record and nothing else`);
    const graded = grade({ ...renderPolicy(definition.policy, fixture.workspace), secrets: fixture.policy.secrets }, evidence);
    // Only the scenario's own expected invocations are missing (this run makes only the handoff's check).
    assert.ok(graded.failed.every((rule) => rule === 'expected-behavior'), `${entryId(entry)} ${layout}: ${JSON.stringify(graded)}`);
    const bare = strip(entry, pieces).definition as ScenarioDefinition;
    assert.ok(grade({ ...renderPolicy(bare.policy, fixture.workspace), secrets: fixture.policy.secrets }, evidence).failed.includes('authorization'),
      `${entryId(entry)} ${layout}: without the allowance the handoff fails authorization`);
  }
});
