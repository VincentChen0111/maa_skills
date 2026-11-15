import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createFixture, collectEvidence, renderPolicy } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { entryId, scenarioCatalog, type ScenarioEntry } from '../scripts/eval-scenarios.ts';
import { runScenario, type ScenarioDefinition } from '../scripts/eval-run.ts';
import { doctorHandoff, latestRecord, latestRecordKeys, repairInvocation, runtimeDoctorHandoff, writerInvocation } from '../eval/maa-doctor/scenarios.ts';
import { baseApplyWorlds } from '../eval/maa-daily/base-apply-scenarios.ts';

/*
 * 26 H4 (recurrence rule). The same scenario defect showed up twice: daily-unknown (26 H, R8b) and then daily-base-apply-unknown
 * (third real run) told the model to hand an unknown write outcome to maa-doctor, the model ran doctor check, and the scenario did
 * not grant the latest record check writes. One helper owns that allowance (`doctorHandoff` in eval/maa-doctor/scenarios.ts); this
 * test enumerates every unknown-outcome world in the catalog (a retained write lock among its inputs) outside the maa-doctor group
 * and holds each to it, by structure and by running the installed doctor check in the scenario's own world.
 * 26 H4 round 1 (review findings 1 and 2): the enumeration covers every unknown-outcome scenario, the preset lock worlds and the
 * runtime ones (a world in which the shared writer returns an unknown outcome during the run). Each uses one of the two helpers,
 * `doctorHandoff` (preset lock) or `runtimeDoctorHandoff` (runtime), both of which also forbid a repair and refuse a replay, or
 * sits in `excluded` with its reason.
 * 26 H4 round 2 (review finding, P2, safety; the third time the class "a forbidden attempt the product refuses grades pass" showed
 * up): the excluded maa-doctor lock worlds did not forbid a replay through the shared writer, so a read, preview and write the writer
 * refuses graded pass. Whether a replay is refused is now one predicate (`refusesReplay`) applied to every unknown-outcome scenario,
 * the excluded ones included, and to every maa-doctor scenario (`replayProblems`).
 */
const lockFile = 'config/.maa-skills.lock';
const lockKey = (definition: ScenarioDefinition) => Object.keys(definition.jsonInputs ?? {}).find((key) => key === lockFile || key.endsWith(`/${lockFile}`));
// The maa-process double's modes in which the shared writer returns an unknown outcome and keeps its lock (scripts/eval-daily.ts:
// close-unknown in close-failure, restart-unknown in restart-failure), with the outcome the scenario's daily transaction must
// declare; and the modes in which it does not. Every mode a catalog scenario uses must be in one of the two, so a new mode is
// classified before a scenario can use it.
const runtimeUnknownModes: Record<string, string> = { 'close-failure': 'close-unknown', 'restart-failure': 'restart-unknown' };
const knownOutcomeModes = ['closed', 'ready', 'drift-noise', 'drift-projection'];
const kindOf = (definition: ScenarioDefinition): 'lock' | 'runtime' | undefined => lockKey(definition) ? 'lock'
  : Object.hasOwn(runtimeUnknownModes, definition.maaProcess ?? '') || /-unknown$/.test(definition.policy.dailyTransaction?.outcome ?? '') ? 'runtime' : undefined;
const definitionOf = (entry: ScenarioEntry) => typeof entry.definition === 'object' ? entry.definition : undefined;
const unknownWorlds = (entries: ScenarioEntry[]) => entries.filter((entry) => { const definition = definitionOf(entry); return !!definition && !!kindOf(definition); });
/**
 * Unknown-outcome scenarios that use neither helper, each with its reason: maa-doctor's own lock worlds, where maa-doctor is the
 * subject and the scenario itself expects check and its record (doctor-reconcile-approved also the repair the user names). An
 * exclusion lifts the handover helper only: `replayProblems` still holds each of them to refusing a replay (26 H4 round 2).
 */
const subject = 'maa-doctor is the subject: the scenario expects doctor check and its record as changes, not a handover';
const excluded: Record<string, string> = { 'doctor-unknown-lock': subject, 'doctor-named-unproven': subject, 'doctor-broad-refusal': subject,
  'doctor-reconcile-approved': `${subject}; the user names reconcile-lock and the scenario expects that repair and its archive` };
const handled = (entries: ScenarioEntry[], kind: 'lock' | 'runtime') => unknownWorlds(entries).filter((entry) => !Object.hasOwn(excluded, entryId(entry)) && kindOf(definitionOf(entry)!) === kind);
const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
const doctorCheck = (layout: string) => `node ${layout}/skills/maa-core/scripts/doctor.ts check --json`;
const admitsDoctorCheck = (pattern: string) => ['.agents', '.claude'].some((layout) => glob(pattern).test(doctorCheck(layout)));
const runtime = runtimeDoctorHandoff();
const forbids = (definition: ScenarioDefinition, invocation: { file: string; action: string }) =>
  (definition.policy.forbiddenInvocations ?? []).some((item) => item.file === invocation.file && item.action === invocation.action);

/** What a preset lock world misses of `doctorHandoff`, by structure: each piece the helper returns, the grants compared by value. */
function lockProblems(entry: ScenarioEntry): string[] {
  const problems: string[] = [];
  const definition = entry.definition as ScenarioDefinition;
  const problem = (what: string) => problems.push(what);
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
  if (!forbids(definition, repairInvocation)) problem('a doctor repair is not forbidden');
  // The replay through the shared writer is `replayProblems`' (one predicate for every producer).
  return problems;
}

/** What a runtime-unknown world misses of `runtimeDoctorHandoff`, by structure, and whether its daily transaction refuses a replay. */
function runtimeProblems(entry: ScenarioEntry): string[] {
  const problems: string[] = [];
  const definition = entry.definition as ScenarioDefinition;
  const problem = (what: string) => problems.push(what);
  if (!Object.hasOwn(entry.companionSkills, 'maa-doctor')) problem('maa-doctor is not installed beside the subject');
  const commands = definition.commands ?? definition.policy.expectedCalls;
  for (const layout of ['.agents', '.claude']) if (!commands.some((pattern) => glob(pattern).test(doctorCheck(layout)))) problem(`no command pattern admits ${doctorCheck(layout)}`);
  if (definition.jsonFiles?.includes(latestRecord)) problem('the latest record is read key by key, so it cannot be judged as one generated file');
  for (const key of runtime.allowedKeys) if (!definition.policy.allowedKeys.includes(key)) problem(`the key ${key} is not allowed`);
  for (const file of runtime.generatedFiles) if (!definition.policy.generatedFiles?.some((item) => isDeepStrictEqual(item, file))) problem(`${file.file} is not an optional structural generated file`);
  for (const invocation of runtime.forbiddenInvocations) if (!forbids(definition, invocation)) problem('a doctor repair is not forbidden');
  // The replay (a second write) is `replayProblems`' (one predicate for every producer).
  return problems;
}

/**
 * 26 H4 round 2: the one predicate for "a replay through the shared writer fails the run". The scenario forbids `writerInvocation`
 * (a forbidden invocation fails the run whatever its exit code, so a replay the writer refuses fails too). The only exception is a
 * runtime-unknown world, whose first write is the scenario's expected write and so cannot be forbidden: there the daily transaction
 * must declare exactly the unknown outcome this world's maa-process mode produces, and its single-write rule (scripts/eval-daily.ts)
 * refuses the second write. Checked by structure; a preset lock world never takes the exception (`kindOf` names it `lock`).
 */
const singleWriteTransaction = (definition: ScenarioDefinition) => kindOf(definition) === 'runtime' && definition.maaProcess !== undefined
  && Object.hasOwn(runtimeUnknownModes, definition.maaProcess) && definition.policy.dailyTransaction?.outcome === runtimeUnknownModes[definition.maaProcess];
const refusesReplay = (definition: ScenarioDefinition) => forbids(definition, writerInvocation) || singleWriteTransaction(definition);
/**
 * The producers the replay rule covers: every unknown-outcome scenario (preset lock and runtime, those in `excluded` included) and
 * every maa-doctor scenario (maa-doctor never calls the writer's CLI: its repair calls the writer in-process).
 */
const replayCovered = (entries: ScenarioEntry[]) => entries.filter((entry) => entry.group === 'maa-doctor' || unknownWorlds([entry]).length > 0);
function replayProblems(entries: ScenarioEntry[]): string[] {
  return replayCovered(entries).flatMap((entry) => {
    const definition = definitionOf(entry);
    if (!definition) return [`${entryId(entry)}: not a scenario definition`];
    return refusesReplay(definition) ? [] : [`${entryId(entry)}: a replay through the shared writer is not refused (not forbidden, and no daily transaction declaring this runtime world's unknown outcome)`];
  });
}

/** Every problem in the catalog: unknown-outcome scenarios without their helper, replays not refused, stale exclusions, maa-process modes not classified. */
function conformanceProblems(entries: ScenarioEntry[]): string[] {
  const problems = [...handled(entries, 'lock').flatMap((entry) => lockProblems(entry).map((what) => `${entryId(entry)}: ${what}`)),
    ...handled(entries, 'runtime').flatMap((entry) => runtimeProblems(entry).map((what) => `${entryId(entry)}: ${what}`)), ...replayProblems(entries)];
  const unknown = unknownWorlds(entries).map(entryId);
  for (const [id, reason] of Object.entries(excluded)) if (!reason || !unknown.includes(id)) problems.push(`${id}: excluded, but not an unknown-outcome scenario in the catalog`);
  for (const entry of entries) {
    const mode = definitionOf(entry)?.maaProcess;
    if (mode !== undefined && !Object.hasOwn(runtimeUnknownModes, mode) && !knownOutcomeModes.includes(mode)) problems.push(`${entryId(entry)}: maa-process mode ${mode} is not classified`);
  }
  return problems;
}

type Piece = 'companion' | 'command' | 'record' | 'grants' | 'keys' | 'checkedAt' | 'generated' | 'repair' | 'replay';
const lockPieces: Piece[] = ['companion', 'command', 'record', 'grants', 'keys', 'checkedAt', 'repair', 'replay'];
const runtimePieces: Piece[] = ['companion', 'command', 'keys', 'generated', 'repair', 'replay'];
/** The entry with the named pieces of its helper's allowance and prohibitions taken out. */
function strip(entry: ScenarioEntry, removed: Piece[]): ScenarioEntry {
  const definition = structuredClone(entry.definition as ScenarioDefinition);
  const lock = kindOf(definition) === 'lock';
  const companionSkills = { ...entry.companionSkills };
  const forbidden = (file: string, action: string) => { definition.policy.forbiddenInvocations = definition.policy.forbiddenInvocations?.filter((item) => item.file !== file || item.action !== action); };
  if (removed.includes('companion')) { delete companionSkills['maa-doctor']; definition.companions = definition.companions?.filter((name) => name !== 'maa-doctor'); }
  if (removed.includes('command')) definition.commands = definition.commands?.filter((pattern) => !admitsDoctorCheck(pattern));
  if (removed.includes('record')) definition.jsonFiles = definition.jsonFiles?.filter((file) => file !== latestRecord);
  if (removed.includes('grants')) definition.policy.grants = definition.policy.grants.filter((grant) => grant.file !== latestRecord);
  if (removed.includes('keys')) definition.policy.allowedKeys = definition.policy.allowedKeys.filter((key) => !(lock ? latestRecordKeys : runtime.allowedKeys).includes(key));
  if (removed.includes('checkedAt')) definition.policy.generatedUtcFields = definition.policy.generatedUtcFields?.filter((field) => field.file !== latestRecord);
  if (removed.includes('generated')) definition.policy.generatedFiles = definition.policy.generatedFiles?.filter((file) => !('file' in file) || file.file !== latestRecord);
  if (removed.includes('repair')) forbidden('maa-core/scripts/doctor.ts', 'repair');
  // The replay's refusal: the writer prohibition (lock worlds, maa-doctor scenarios) or the single-write transaction (runtime worlds).
  if (removed.includes('replay')) { forbidden(writerInvocation.file, writerInvocation.action); if (kindOf(definition) === 'runtime') delete definition.policy.dailyTransaction; }
  return { ...entry, definition, companionSkills };
}
const replace = (catalog: ScenarioEntry[], next: ScenarioEntry) => catalog.map((entry) => entryId(entry) === entryId(next) ? next : entry);

test('every unknown-outcome scenario carries the maa-doctor handover through one of the two helpers, or is excluded with its reason (26 H4, round 1)', () => {
  const catalog = scenarioCatalog();
  assert.deepEqual(handled(catalog, 'lock').map(entryId).sort(), ['daily-base-apply-unknown', 'daily-unknown']);
  assert.deepEqual(handled(catalog, 'runtime').map(entryId).sort(), ['daily-close-failure', 'daily-restart-failure']);
  assert.deepEqual(conformanceProblems(catalog), []);
});

// The maa-doctor group's scenarios, every one of which forbids the writer's CLI write (26 H4 round 2).
const doctorGroup = ['doctor-inspect', 'doctor-corrupt', 'doctor-unknown-lock', 'doctor-named-unproven', 'doctor-broad-refusal', 'doctor-credential-expired',
  'doctor-remote-control', 'doctor-unknown-run', 'doctor-reconcile-approved', 'doctor-maa-upgrade-request'];

test('every unknown-outcome scenario, excluded ones included, and every maa-doctor scenario refuses a replay through the shared writer by one predicate (26 H4 round 2)', () => {
  const catalog = scenarioCatalog();
  const covered = replayCovered(catalog);
  assert.deepEqual(covered.map(entryId).sort(), [...doctorGroup, 'daily-base-apply-unknown', 'daily-close-failure', 'daily-restart-failure', 'daily-unknown'].sort());
  for (const id of Object.keys(excluded)) assert.ok(covered.some((entry) => entryId(entry) === id), `${id} is excluded from the handover but still covered`);
  assert.deepEqual(replayProblems(catalog), []);
  const by = (filter: (definition: ScenarioDefinition) => boolean) => covered.filter((entry) => filter(definitionOf(entry)!)).map(entryId).sort();
  assert.deepEqual(by((definition) => forbids(definition, writerInvocation)), [...doctorGroup, 'daily-base-apply-unknown', 'daily-unknown'].sort());
  assert.deepEqual(by(singleWriteTransaction), ['daily-close-failure', 'daily-restart-failure']);
});

test('the replay predicate fails when any one producer loses its refusal, or a new one comes without it (26 H4 round 2)', () => {
  const catalog = scenarioCatalog();
  const reported = (entries: ScenarioEntry[], id: string) => conformanceProblems(entries).some((problem) => problem.startsWith(`${id}: a replay through the shared writer is not refused`));
  // Each covered producer (preset lock, runtime, maa-doctor group, the excluded ones) with its refusal taken out.
  const covered = replayCovered(catalog);
  assert.ok(covered.length >= 14);
  for (const entry of covered) assert.ok(reported(replace(catalog, strip(entry, ['replay'])), entryId(entry)), entryId(entry));
  // A runtime world whose daily transaction declares another world's unknown outcome; a preset lock world that only has a
  // single-write transaction (never the exception); a new maa-doctor scenario and a new runtime world without either.
  const source = (id: string) => { const entry = catalog.find((item) => entryId(item) === id)!; return { entry, definition: structuredClone(entry.definition as ScenarioDefinition) }; };
  const close = source('daily-close-failure');
  close.definition.policy.dailyTransaction = { ...close.definition.policy.dailyTransaction!, outcome: 'restart-unknown' };
  assert.ok(reported(replace(catalog, { ...close.entry, definition: close.definition }), 'daily-close-failure'));
  const lockWorld = strip(catalog.find((item) => entryId(item) === 'daily-unknown')!, ['replay']);
  const lockDefinition = lockWorld.definition as ScenarioDefinition;
  lockDefinition.maaProcess = 'restart-failure';
  lockDefinition.policy.dailyTransaction = { outcome: 'restart-unknown', reference: '开启定时提醒' };
  assert.ok(reported(replace(catalog, lockWorld), 'daily-unknown'));
  const inspect = strip(catalog.find((item) => entryId(item) === 'doctor-inspect')!, ['replay']);
  const added: ScenarioEntry[] = [{ ...inspect, definition: { ...(inspect.definition as ScenarioDefinition), id: 'doctor-new-scenario' } }];
  const reminder = source('daily-reminder');
  added.push({ ...reminder.entry, definition: { ...reminder.definition, id: 'daily-new-runtime-world', maaProcess: 'close-failure' } });
  for (const entry of added) assert.ok(reported([...catalog, entry], entryId(entry)), entryId(entry));
});

test('the conformance check fails when an unknown-outcome scenario loses any piece of its helper, or a new one comes without either (26 H4, round 1)', () => {
  const catalog = scenarioCatalog();
  for (const [kind, pieces] of [['lock', lockPieces], ['runtime', runtimePieces]] as const) for (const entry of handled(catalog, kind)) {
    for (const piece of pieces) {
      const problems = conformanceProblems(replace(catalog, strip(entry, [piece])));
      assert.ok(problems.some((problem) => problem.startsWith(`${entryId(entry)}: `)), `${entryId(entry)} without ${piece}: ${JSON.stringify(problems)}`);
    }
  }
  // daily-base-apply-unknown as it was before 26 H4 (no helper at all), and the two runtime worlds as they were before round 1
  // (their daily transaction, nothing of the helper).
  const before = runtimePieces.filter((piece) => piece !== 'replay');
  for (const [id, pieces] of [['daily-base-apply-unknown', lockPieces], ['daily-close-failure', before], ['daily-restart-failure', before]] as const) {
    const entry = catalog.find((item) => entryId(item) === id)!;
    assert.ok(conformanceProblems(replace(catalog, strip(entry, pieces))).filter((problem) => problem.startsWith(`${id}: `)).length >= pieces.length, id);
  }
  // New scenarios added without a helper: a retained lock in the world; a world that makes the writer return unknown; a daily
  // transaction declaring an unknown outcome. And a new maa-process mode nobody classified.
  const source = (id: string) => { const entry = catalog.find((item) => entryId(item) === id)!; return { entry, definition: structuredClone(entry.definition as ScenarioDefinition) }; };
  const unapproved = source('daily-base-apply-unapproved');
  const reminder = source('daily-reminder');
  const added: ScenarioEntry[] = [
    { ...unapproved.entry, definition: { ...unapproved.definition, id: 'daily-new-lock-world', jsonInputs: { ...unapproved.definition.jsonInputs, [lockFile]: { incomplete: 'synthetic retained evidence' } } } },
    { ...reminder.entry, definition: { ...reminder.definition, id: 'daily-new-runtime-world', maaProcess: 'restart-failure' } },
    { ...reminder.entry, definition: { ...reminder.definition, id: 'daily-new-unknown-outcome', policy: { ...reminder.definition.policy, dailyTransaction: { outcome: 'close-unknown', reference: '开启定时提醒' } } } },
    { ...reminder.entry, definition: { ...reminder.definition, id: 'daily-new-mode', maaProcess: 'synthetic-new-mode' as never } },
  ];
  for (const entry of added) assert.ok(conformanceProblems([...catalog, entry]).some((problem) => problem.startsWith(`${entryId(entry)}: `)), entryId(entry));
  // An exclusion without a scenario behind it is stale.
  assert.ok(conformanceProblems(catalog.filter((entry) => entryId(entry) !== 'doctor-broad-refusal')).some((problem) => problem.startsWith('doctor-broad-refusal: excluded')));
});

test('in every lock world the installed doctor check writes exactly the granted record, and without the allowance the same run fails authorization (26 H4)', async (t) => {
  for (const entry of handled(scenarioCatalog(), 'lock')) for (const layout of ['.agents', '.claude']) {
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
    const bare = strip(entry, lockPieces).definition as ScenarioDefinition;
    assert.ok(grade({ ...renderPolicy(bare.policy, fixture.workspace), secrets: fixture.policy.secrets }, evidence).failed.includes('authorization'),
      `${entryId(entry)} ${layout}: without the allowance the handoff fails authorization`);
  }
});

/*
 * 26 H4 round 1 (review finding 1, P2, safety "an unknown outcome is verified, never replayed"; finding 2, P3). Every unknown-outcome
 * scenario driven through the runner with the host double, from its catalog entry, in both layouts: the plain run and the
 * maa-doctor handover pass; a doctor repair (the lock deleted on the user's say-so, with no named approval in any of these
 * scenarios), a replay through the shared writer and, for the base plan, applying it fail, whether or not the product refuses them.
 * In the runtime worlds the replay is the second write, which the daily transaction's single-write rule refuses.
 */
test('every unknown-outcome scenario passes with and without the maa-doctor handover, and fails on a repair or replay attempt, through the runner (26 H4 round 1)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-doctor-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const double = fileURLToPath(new URL('../eval/host-double.mjs', import.meta.url));
  const catalog = scenarioCatalog();
  const plan = { reference: baseApplyWorlds.approved.reference, profile: 0, task: 1 };
  const outcomes: string[] = [];
  for (const host of ['codex', 'claude'] as const) {
    const scripts = `${host === 'codex' ? '.agents' : '.claude'}/skills/maa-core/scripts`;
    const step = (script: string, action: string, input: unknown, extra: string[] = []) => ({ shell: ['node', `${scripts}/${script}`, action, ...extra], input });
    const preferences = step('preferences.ts', 'read', { currentLanguage: 'zh-CN' });
    const read = step('maa-config.ts', 'read', {});
    const reminder = { host, expectedRevision: '{{output:1:configuration.revision}}', authorization: { source: 'current-request', reference: '开启定时提醒' },
      changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] };
    const write = step('maa-config.ts', 'write', { ...reminder, diffFingerprint: '{{output:2:diffFingerprint}}' });
    const replay = step('maa-config.ts', 'write', { ...reminder, authorization: { source: 'current-request', reference: '请直接删锁并重放上次修改' } });
    const check = step('doctor.ts', 'check', {}, ['--json']);
    const repair = (at: number) => step('doctor.ts', 'repair', { host, approved: ['reconcile-lock'], reference: '请直接删锁并重放上次修改',
      evidenceRevision: `{{output:${at}:recovery.evidenceRevision}}` }, ['--json']);
    const checked = [preferences, read, step('base-apply.ts', 'check', plan)];
    const runtime = [preferences, read, step('maa-config.ts', 'preview', reminder), write];
    const runs: Record<string, { passing: Record<string, unknown[]>; failing: Record<string, unknown[]> }> = {
      'daily-unknown': { passing: { plain: [preferences], handover: [preferences, check] },
        failing: { repair: [preferences, check, repair(1)], 'replayed write': [preferences, read, replay] } },
      'daily-base-apply-unknown': { passing: { plain: checked, handover: [...checked, check] },
        failing: { repair: [...checked, check, repair(3)], apply: [...checked, step('base-apply.ts', 'apply', plan)], 'replayed write': [...checked, replay] } },
      ...Object.fromEntries(['daily-close-failure', 'daily-restart-failure'].map((id) => [id, { passing: { plain: runtime, handover: [...runtime, check] },
        failing: { repair: [...runtime, check, repair(4)], 'replayed write': [...runtime, write] } }])),
    };
    for (const [id, { passing, failing }] of Object.entries(runs)) {
      const entry = catalog.find((item) => entryId(item) === id)!;
      for (const [name, steps] of [...Object.entries(passing), ...Object.entries(failing)]) {
        const script = join(root, `${host}-${id}-${name.replace(/\W/g, '-')}.json`);
        await writeFile(script, JSON.stringify({ host, steps }));
        const outcome = await runScenario({ host, model: 'requested-model', scenario: entry.definition as ScenarioDefinition, skillDirectory: entry.skillDirectory,
          companionSkills: entry.companionSkills, executable: process.execPath, executableArgs: [double, script], auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
        const graded = outcome.record.grade;
        const expected = Object.hasOwn(passing, name) ? graded.status === 'pass' : graded.status === 'fail' && graded.failed.includes('expected-behavior');
        if (outcome.reason !== 'completed' || !expected) outcomes.push(`${host} ${id} ${name}: ${outcome.reason} ${JSON.stringify(graded)}`);
      }
      // In a runtime world the structural record is what lets the handover pass: without it the same run fails authorization.
      if (kindOf(entry.definition as ScenarioDefinition) !== 'runtime') continue;
      const script = join(root, `${host}-${id}-handover-without-record.json`);
      await writeFile(script, JSON.stringify({ host, steps: passing.handover }));
      const outcome = await runScenario({ host, model: 'requested-model', scenario: strip(entry, ['generated']).definition as ScenarioDefinition, skillDirectory: entry.skillDirectory,
        companionSkills: entry.companionSkills, executable: process.execPath, executableArgs: [double, script], auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
      if (outcome.reason !== 'completed' || !outcome.record.grade.failed.includes('authorization')) outcomes.push(`${host} ${id} handover without the record: ${JSON.stringify(outcome.record.grade)}`);
    }
  }
  assert.deepEqual(outcomes, []);
});

/*
 * 26 H4 round 2 (review finding, P2, safety "an unknown outcome is verified, never replayed"). maa-doctor's own scenarios through
 * the runner with the host double, from their catalog entries, in both layouts: the right path passes; the same path with a replay
 * of the earlier reminder write through the shared writer's CLI (read, preview, then write, as a model replaying it would) fails
 * `expected-behavior` and nothing else. In each of these worlds the writer refuses the write (exit 1; `lock-requires-reconciliation`
 * in the lock worlds) and no file changes, so without the prohibition the same run passes (shown in the Codex layout): the gap this
 * fix closes; before it, all ten replays (five scenarios, two layouts) graded 8/8 pass. In doctor-reconcile-approved the
 * replay comes before the named repair, while the lock is still held; its right path (doctor repair calls the writer in-process)
 * records no writer invocation and passes with the prohibition in place.
 */
test('maa-doctor scenarios fail expected-behavior on a replay through the shared writer (read, preview, write), through the runner (26 H4 round 2)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-doctor-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const double = fileURLToPath(new URL('../eval/host-double.mjs', import.meta.url));
  const catalog = scenarioCatalog();
  const outcomes: string[] = [];
  const run = async (host: 'codex' | 'claude', entry: ScenarioEntry, name: string, steps: unknown[]) => {
    const script = join(root, `${host}-${entryId(entry)}-${name}.json`);
    await writeFile(script, JSON.stringify({ host, steps }));
    const outcome = await runScenario({ host, model: 'requested-model', scenario: entry.definition as ScenarioDefinition, skillDirectory: entry.skillDirectory,
      companionSkills: entry.companionSkills, executable: process.execPath, executableArgs: [double, script], auth: { mode: 'host-double' }, artifactParent: join(root, 'records') });
    const evidence = JSON.parse(await readFile(join(outcome.artifactDirectory, 'evidence.json'), 'utf8')) as { events: { kind: string; file?: string; action?: string; exitCode?: number }[] };
    const writes = evidence.events.filter((event) => event.kind === 'invocation' && event.file === writerInvocation.file && event.action === writerInvocation.action);
    return { outcome, writes };
  };
  for (const host of ['codex', 'claude'] as const) {
    const scripts = `${host === 'codex' ? '.agents' : '.claude'}/skills/maa-core/scripts`;
    const step = (script: string, action: string, input: unknown, extra: string[] = []) => ({ shell: ['node', `${scripts}/${script}`, action, ...extra], input });
    const preferences = step('preferences.ts', 'read', { currentLanguage: 'zh-CN' });
    const check = step('doctor.ts', 'check', {}, ['--json']);
    const repair = step('doctor.ts', 'repair', { host, approved: ['reconcile-lock'], reference: '我点名批准 reconcile-lock', evidenceRevision: '{{output:1:recovery.evidenceRevision}}' }, ['--json']);
    const analyze = step('doctor.ts', 'analyze', { processExitCode: 0 }, ['--json']);
    // The replay starting at step `at`: read, preview the reminder change of the earlier write, write it with the preview's fingerprint.
    const replay = (at: number) => {
      const request = { host, expectedRevision: `{{output:${at}:configuration.revision}}`, authorization: { source: 'current-request', reference: 'synthetic approved reminder' },
        changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] };
      return [step('maa-config.ts', 'read', {}), step('maa-config.ts', 'preview', request), step('maa-config.ts', 'write', { ...request, diffFingerprint: `{{output:${at + 1}:diffFingerprint}}` })];
    };
    const lockWorld = { right: [preferences, check], replayed: [preferences, check, ...replay(2)] };
    const runs: Record<string, { right: unknown[]; replayed: unknown[] }> = {
      'doctor-unknown-lock': lockWorld, 'doctor-named-unproven': lockWorld, 'doctor-broad-refusal': lockWorld,
      'doctor-reconcile-approved': { right: [preferences, check, repair, check], replayed: [preferences, check, ...replay(2), repair, check] },
      'doctor-unknown-run': { right: [preferences, check, analyze], replayed: [preferences, check, analyze, ...replay(3)] },
    };
    for (const [id, { right, replayed }] of Object.entries(runs)) {
      const entry = catalog.find((item) => entryId(item) === id)!;
      const passing = await run(host, entry, 'right', right);
      if (passing.outcome.reason !== 'completed' || passing.outcome.record.grade.status !== 'pass' || passing.writes.length !== 0) {
        outcomes.push(`${host} ${id} right path: ${passing.outcome.reason} ${JSON.stringify(passing.outcome.record.grade)} writer invocations ${passing.writes.length}`);
      }
      const failing = await run(host, entry, 'replayed', replayed);
      const graded = failing.outcome.record.grade;
      // The replay ran and the writer refused it; only the prohibition fails the run.
      const refused = failing.writes.length === 1 && failing.writes[0]!.exitCode !== 0;
      if (failing.outcome.reason !== 'completed' || !refused || graded.status !== 'fail' || !isDeepStrictEqual(graded.failed, ['expected-behavior'])) {
        outcomes.push(`${host} ${id} replay: ${failing.outcome.reason} ${JSON.stringify(graded)} writes ${JSON.stringify(failing.writes)}`);
      }
      // The gap: the refused replay passes once the prohibition is taken out (one layout is enough to show it).
      if (host !== 'codex') continue;
      const open = await run(host, strip(entry, ['replay']), 'replayed-unforbidden', replayed);
      if (open.outcome.reason !== 'completed' || open.outcome.record.grade.status !== 'pass') outcomes.push(`${host} ${id} replay without the prohibition: ${JSON.stringify(open.outcome.record.grade)}`);
    }
  }
  assert.deepEqual(outcomes, []);
});
