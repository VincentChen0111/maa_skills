import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyBasePlan, checkBaseApply } from '../skills/maa-core/scripts/base-apply.ts';
import { executeConfigWrite, inspectConfiguration, type MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';
import { draftBaseReport } from '../skills/maa-core/scripts/base-report.ts';
import { loadAdviceReport } from '../skills/maa-core/scripts/advice-report.ts';
import { applyHome, goals, infrastConfig, type ApplyHome } from './fixtures/base-apply-data.ts';
import { nameTable, planInput, planSnapshot, planTables } from './fixtures/base-plan-data.ts';

// Ticket 23: applying an approved base plan. Real temporary homes and the real report, plan and configuration tools;
// only the MAA process is replaced (it records calls). No device, adb or game is involved in any test.
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fakeMaa(options: { startFails?: boolean; closeFails?: boolean } = {}) {
  let running = true; const calls: string[] = [];
  const maa: MaaProcess = {
    inspect: async () => { calls.push('inspect'); return { running, treeExited: !running, idle: true, ready: running }; },
    close: async () => { calls.push('close'); if (options.closeFails) throw new Error('synthetic close failure'); running = false; },
    start: async () => { calls.push('start'); if (options.startFails) throw new Error('synthetic restart failure'); running = true; },
  };
  return { maa, calls };
}
async function tree(directory: string, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) Object.assign(files, await tree(join(directory, entry.name), `${prefix}${entry.name}/`));
    else files[`${prefix}${entry.name}`] = digest(await readFile(join(directory, entry.name)));
  }
  return files;
}
const records = async (file: string) => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const home = async (t: { after: (fn: () => Promise<unknown>) => void }, options: Parameters<typeof applyHome>[0] = {}) => {
  const h = await applyHome(options); t.after(() => rm(h.home, { recursive: true, force: true })); return h;
};
const request = async (h: ApplyHome, extra: Record<string, unknown> = {}) =>
  ({ reference: h.reference, profile: 0, task: 1, host: 'claude', expectedRevision: (await inspectConfiguration(h.maa)).revision, ...extra });
const accept = (ids: string[]) => ({ acceptUnverified: ids, userWords: '这些未核实的项我知道了，仍然应用' });
/** A refused request writes nothing: same configuration bytes, no lock, no backup, no copy, no pending record. */
async function nothingWritten(h: ApplyHome, before: Buffer) {
  assert.deepEqual(await readFile(h.configFile), before);
  assert.equal((await readdir(join(h.maa, 'config'))).includes('.maa-skills.lock'), false);
  for (const folder of ['maa-config-backups', 'base-applied']) assert.deepEqual(await readdir(join(h.home, folder)).catch(() => []), []);
  assert.deepEqual(await records(join(h.home, 'daily-pending.jsonl')), []);
}

test('report → approval → check → safe write → read-back: only the custom infrast fields change and MAA reads the approved bytes', async (t) => {
  const h = await home(t, { baseFile: { metadata: { note: 'synthetic' }, 'x-unknown-field': { keep: true } } });
  const reportBefore = await tree(join(h.home, 'reports')), snapshotBefore = await readFile(join(h.home, 'account-snapshot.json'));
  const configBefore = await readFile(h.configFile), original = JSON.parse(configBefore.toString('utf8'));
  const checked = await checkBaseApply({ reference: h.reference, profile: 0, task: 1 }, { home: h.home });
  assert.equal(checked.status, 'needs-decision', JSON.stringify(checked.reasons));
  assert.deepEqual(checked.unverified.map(entry => entry.id), ['maa-timers'], 'the MAA timers are off, so the run times the gates used are not proved');
  assert.equal(checked.review, 'unreviewed'); assert.equal(checked.plan!.original, 'matching');
  assert.deepEqual(checked.freshness, { snapshot: 'fresh', tables: 'fresh', names: 'fresh', plan: 'fresh', check: 'fresh' });
  assert.equal(checked.check!.gates.length, 15, 'all 15 gates are computed again at apply time');
  assert.deepEqual(checked.configuration!.changes, ['Mode', 'Filename', 'PlanSelect', 'CustomFileType']);
  const { maa, calls } = fakeMaa();
  const result = await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), maa, { home: h.home });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.backup, `maa-config-backups/${result.operation}.json`);
  assert.deepEqual(result.readback, { fields: ['Mode', 'Filename', 'PlanSelect', 'CustomFileType'], copy: 'matching', periodSelection: 'gui-at-each-run-not-observed' });
  assert.ok(calls.includes('close') && calls.includes('start') && calls.every(call => ['inspect', 'close', 'start'].includes(call)), 'only the MAA GUI boundary is used');
  // Read-back: exactly four fields of the chosen task changed; every unrelated key is byte-for-byte the same.
  const after = JSON.parse(await readFile(h.configFile, 'utf8')), task = after.Configurations.synthetic.TaskQueue[1];
  const sha = checked.plan!.sha256, copy = join(h.home, 'base-applied', `${sha}.json`);
  assert.equal(task.Mode, 'Custom'); assert.equal(task.Filename, copy); assert.equal(task.PlanSelect, -1); assert.equal(task.CustomFileType, 'user_defined');
  const expected = structuredClone(original); Object.assign(expected.Configurations.synthetic.TaskQueue[1], { Mode: 'Custom', Filename: copy, PlanSelect: -1, CustomFileType: 'user_defined' });
  assert.deepEqual(after, expected);
  assert.equal(JSON.stringify(after).includes('"product"'), false, 'no production line is written anywhere');
  // The copy is the approved file byte for byte, including fields this tool does not know.
  const approvedBytes = await readFile(join(h.home, checked.plan!.file));
  assert.deepEqual(await readFile(copy), approvedBytes); assert.equal(digest(approvedBytes), sha);
  const plan = JSON.parse(approvedBytes.toString('utf8'));
  assert.deepEqual(plan['x-unknown-field'], { keep: true }); assert.deepEqual(plan.metadata, { note: 'synthetic' });
  assert.ok(plan.plans.every((entry: { period: unknown }) => Array.isArray(entry.period)), 'each plan carries its period; the GUI picks by time');
  // Backup, pending and run records; the user's decision is in the run record.
  assert.deepEqual(await readFile(join(h.home, result.backup!)), configBefore);
  const pending = (await records(join(h.home, 'daily-pending.jsonl'))).at(-1);
  assert.equal(pending.authorization.reference, h.reference); assert.equal(pending.baseManifest.sha256, sha);
  const run = (await records(join(h.home, 'daily-runs.jsonl'))).at(-1);
  assert.equal(run.status, 'complete'); assert.deepEqual(run.basePlan, { sha256: sha, decision: { unverified: ['maa-timers'], userWords: '这些未核实的项我知道了，仍然应用' } });
  assert.equal((await readdir(join(h.maa, 'config'))).includes('.maa-skills.lock'), false);
  // daily wrote neither the report nor the snapshot, and the unreviewed mark stays.
  assert.deepEqual(await tree(join(h.home, 'reports')), reportBefore);
  assert.deepEqual(await readFile(join(h.home, 'account-snapshot.json')), snapshotBefore);
  assert.equal((await loadAdviceReport(h.home, 'base', h.reportHash)).status, 'unreviewed');
  // Applying again changes nothing and does not touch MAA.
  const again = fakeMaa();
  assert.equal((await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), again.maa, { home: h.home })).status, 'unchanged');
  assert.deepEqual(again.calls, []);
});

test('nothing unapproved runs: a missing approval, another report version and an edited report are refused before any write', async (t) => {
  const h = await home(t, { approve: false }), before = await readFile(h.configFile);
  const unapproved = await checkBaseApply({ reference: h.reference, profile: 0, task: 1 }, { home: h.home });
  assert.equal(unapproved.status, 'refused'); assert.deepEqual(unapproved.reasons, ['report-item-not-approved']);
  const { maa, calls } = fakeMaa();
  const rejected = await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), maa, { home: h.home });
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.reason, 'report-item-not-approved'); assert.deepEqual(calls, []);
  await nothingWritten(h, before);
  // An approved version, then a newer draft that was not approved: only the approved version may be applied.
  const approved = await home(t);
  const newer = await draftBaseReport({ goals, ...planInput(), tablesFile: approved.tablesFile, title: '合成两班（改）' }, { home: approved.home });
  assert.equal(newer.status, 'saved');
  const other = await checkBaseApply({ reference: `base/${newer.status === 'saved' ? newer.reportHash : ''}#P1`, profile: 0, task: 1 }, { home: approved.home });
  assert.deepEqual(other.reasons, ['report-not-approvable:pending-review']);
  // The approved report file edited afterwards no longer matches its version hash.
  const file = join(approved.home, 'reports', 'base', approved.reportHash, 'report.json'), text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('"合成两班"', '"合成两班 "'));
  const edited = await checkBaseApply({ reference: approved.reference, profile: 0, task: 1 }, { home: approved.home });
  assert.deepEqual(edited.reasons, ['report-content-mismatch']);
  assert.deepEqual((await checkBaseApply({ reference: 'cultivation/' + '0'.repeat(64) + '#S1', profile: 0, task: 1 }, { home: approved.home })).reasons, ['base-reference-invalid']);
});

test('an invalid plan, a failing gate and a snapshot changed after approval are refused; nothing is written', async (t) => {
  // Invalid now: MAA's local name table no longer has a name the plan uses (a rule error).
  const names = await home(t), before = await readFile(names.configFile);
  const table = nameTable(); delete (table.chars as Record<string, unknown>).char_gold1;
  await writeFile(join(names.maa, 'resource', 'battle_data.json'), JSON.stringify(table));
  const invalid = await checkBaseApply({ reference: names.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: names.home });
  assert.equal(invalid.status, 'refused'); assert.deepEqual(invalid.reasons, ['base-plan-not-applicable']);
  assert.equal(invalid.freshness!.names, 'stale'); assert.ok(invalid.check!.errors.some(error => error.startsWith('name-unknown')), JSON.stringify(invalid.check!.errors));
  assert.equal((await applyBasePlan(await request(names, { decision: accept(['maa-timers']) }), fakeMaa().maa, { home: names.home })).reason, 'base-plan-not-applicable');
  await nothingWritten(names, before);
  // A failing gate now: the fixed tables changed (a lower mood cap), so gate 4 is recomputed and fails.
  const gate = await home(t), tables = planTables();
  for (const entry of Object.values(tables.building.chars)) (entry as { maxManpower: number }).maxManpower = 3600000;
  await writeFile(gate.tablesFile, JSON.stringify(tables));
  const failing = await checkBaseApply({ reference: gate.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: gate.home });
  assert.deepEqual(failing.reasons, ['base-plan-not-applicable']); assert.equal(failing.freshness!.tables, 'stale');
  assert.equal(failing.check!.gates.find(entry => entry.gate === 4)!.verdict, 'fail'); assert.deepEqual(failing.check!.errors, []);
  // The snapshot changed after approval: the old approval does not cover it, so the user must approve again.
  const shot = await home(t), snapshot = planSnapshot() as { operators: { level: number }[] };
  snapshot.operators[0]!.level = 50;
  await writeFile(join(shot.home, 'account-snapshot.json'), JSON.stringify(snapshot));
  const changed = await checkBaseApply({ reference: shot.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: shot.home });
  assert.deepEqual(changed.reasons, ['base-snapshot-changed']); assert.equal(changed.freshness!.snapshot, 'stale');
  // The account's plan file edited after approval is a changed plan, not the approved one.
  const plan = await home(t), checked = await checkBaseApply({ reference: plan.reference, profile: 0, task: 1 }, { home: plan.home });
  const planFile = join(plan.home, checked.plan!.file);
  await writeFile(planFile, (await readFile(planFile, 'utf8')).replace('"白班"', '"早班"'));
  assert.deepEqual((await checkBaseApply({ reference: plan.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: plan.home })).reasons, ['base-plan-changed']);
});

test('unverified items need the user\'s explicit decision, which is recorded with the run', async (t) => {
  const h = await home(t, { input: { combos: undefined, exclusions: undefined } });
  const checked = await checkBaseApply({ reference: h.reference, profile: 0, task: 1 }, { home: h.home });
  assert.equal(checked.status, 'needs-decision');
  assert.deepEqual(checked.unverified.map(entry => entry.id), ['gate-7', 'gate-8', 'maa-timers']);
  assert.ok(checked.unverified[0]!.evidence.length > 0, 'each unverified gate carries its evidence for the user');
  const { maa, calls } = fakeMaa();
  const none = await applyBasePlan(await request(h), maa, { home: h.home });
  assert.equal(none.reason, 'base-unverified-decision-required');
  const partial = await applyBasePlan(await request(h, { decision: accept(['gate-7', 'maa-timers']) }), maa, { home: h.home });
  assert.equal(partial.reason, 'base-unverified-decision-required'); assert.deepEqual(calls, []);
  const done = await applyBasePlan(await request(h, { decision: accept(['gate-7', 'gate-8', 'maa-timers']) }), maa, { home: h.home });
  assert.equal(done.status, 'complete', JSON.stringify(done));
  const run = (await records(join(h.home, 'daily-runs.jsonl'))).at(-1);
  assert.deepEqual(run.basePlan.decision, { unverified: ['gate-7', 'gate-8', 'maa-timers'], userWords: '这些未核实的项我知道了，仍然应用' });
  // With MAA's daily timers at the plan's run times there is nothing extra to decide.
  const timed = await home(t, { config: infrastConfig({ timers: true }) });
  const ready = await checkBaseApply({ reference: timed.reference, profile: 0, task: 1 }, { home: timed.home });
  assert.equal(ready.status, 'ready', JSON.stringify(ready)); assert.deepEqual(ready.unverified, []);
});

test('an interrupted write or unknown outcome keeps its evidence for maa-doctor and is never replayed', async (t) => {
  const h = await home(t), before = await readFile(h.configFile);
  const failing = fakeMaa({ startFails: true });
  const result = await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), failing.maa, { home: h.home });
  assert.equal(result.status, 'unknown'); assert.equal(result.phase, 'restart'); assert.equal(result.backup, null); assert.equal(result.readback, null);
  assert.equal((await readdir(join(h.maa, 'config'))).includes('.maa-skills.lock'), true, 'the lock stays as evidence');
  assert.deepEqual(await readFile(join(h.home, 'maa-config-backups', `${result.operation}.json`)), before, 'the backup stays');
  const run = (await records(join(h.home, 'daily-runs.jsonl'))).at(-1);
  assert.equal(run.status, 'unknown'); assert.deepEqual(run.basePlan.decision.unverified, ['maa-timers']);
  // A second attempt does not delete the lock, retry or replay: it is refused at the check and MAA is not touched.
  const checked = await checkBaseApply({ reference: h.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: h.home });
  assert.deepEqual(checked.reasons, ['lock-requires-reconciliation']); assert.ok(checked.configuration!.lock, 'busy while this process lives, unknown once it has exited');
  const again = fakeMaa();
  const retry = await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), again.maa, { home: h.home });
  assert.equal(retry.status, 'rejected'); assert.equal(retry.reason, 'lock-requires-reconciliation'); assert.deepEqual(again.calls, []);
  // A close that fails is the same: unknown, nothing written to the configuration.
  const closing = await home(t), closed = await readFile(closing.configFile);
  const refused = await applyBasePlan(await request(closing, { decision: accept(['maa-timers']) }), fakeMaa({ closeFails: true }).maa, { home: closing.home });
  assert.equal(refused.status, 'unknown'); assert.equal(refused.phase, 'close'); assert.deepEqual(await readFile(closing.configFile), closed);
  assert.deepEqual(await readdir(join(closing.home, 'base-applied')).catch(() => []), [], 'the copy is installed only after MAA exited');
});

test('plan paths are confined to the private directory: the approved file, the applied copy and a report naming a path outside', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'maa-base-apply-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  // The account's plan folder turned into a link to a folder outside the private directory.
  const h = await home(t), before = await readFile(h.configFile);
  await rename(join(h.home, 'base-plans'), join(outside, 'base-plans'));
  await symlink(join(outside, 'base-plans'), join(h.home, 'base-plans'), 'junction');
  const linked = await checkBaseApply({ reference: h.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: h.home });
  assert.deepEqual(linked.reasons, ['plan-path-outside-private']); assert.equal(linked.plan!.original, 'outside');
  assert.equal((await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), fakeMaa().maa, { home: h.home })).reason, 'plan-path-outside-private');
  await nothingWritten(h, before);
  // The copy's folder is a link out: refused at the check, before MAA is closed.
  const copy = await home(t);
  await mkdir(join(outside, 'applied'));
  await symlink(join(outside, 'applied'), join(copy.home, 'base-applied'), 'junction');
  const out = await checkBaseApply({ reference: copy.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: copy.home });
  assert.deepEqual(out.reasons, ['plan-path-outside-private']);
  assert.deepEqual(await readdir(join(outside, 'applied')), []);
  // A copy file replaced by different bytes is not the approved plan.
  const swapped = await home(t), sha = (await checkBaseApply({ reference: swapped.reference, profile: 0, task: 1 }, { home: swapped.home })).plan!.sha256;
  await mkdir(join(swapped.home, 'base-applied')); await writeFile(join(swapped.home, 'base-applied', `${sha}.json`), '{}');
  assert.deepEqual((await checkBaseApply({ reference: swapped.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: swapped.home })).reasons, ['base-plan-copy-changed']);
});

test('the configuration must allow the plan: an Infrast task, the rooms it arranges visited, the stored mode form kept', async (t) => {
  const off = await home(t, { config: infrastConfig({ roomOff: 'Dorm' }) });
  assert.deepEqual((await checkBaseApply({ reference: off.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: off.home })).reasons, ['base-room-disabled:Dorm']);
  assert.deepEqual((await checkBaseApply({ reference: off.reference, profile: 0, task: 0, decision: accept(['maa-timers']) }, { home: off.home })).reasons, ['base-infrast-task-required']);
  assert.deepEqual((await checkBaseApply({ reference: off.reference, profile: 3, task: 1, decision: accept(['maa-timers']) }, { home: off.home })).reasons, ['base-binding-invalid']);
  // A room the plan does not arrange may stay off (training here).
  const training = await home(t, { config: infrastConfig({ roomOff: 'Training' }) });
  assert.equal((await checkBaseApply({ reference: training.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: training.home })).status, 'ready');
  const numeric = await home(t, { config: infrastConfig({ mode: 0 }) });
  const result = await applyBasePlan(await request(numeric, { decision: accept(['maa-timers']) }), fakeMaa().maa, { home: numeric.home });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(JSON.parse(await readFile(numeric.configFile, 'utf8')).Configurations.synthetic.TaskQueue[1].Mode, 10000);
});

test('the base grant is only reachable through base-apply: the writer CLI refuses it and a forged grant is rejected', async (t) => {
  const h = await home(t), before = await readFile(h.configFile);
  const checked = await checkBaseApply({ reference: h.reference, profile: 0, task: 1 }, { home: h.home });
  const grant = { sha256: checked.plan!.sha256, binding: { profile: 0, task: 1 }, decision: { unverified: [], userWords: null } };
  const changes = [{ path: ['Configurations', 'synthetic', 'TaskQueue', 1, 'Mode'], value: 'Custom' }];
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../skills/maa-core/scripts/maa-config.ts', import.meta.url)), 'write'], {
    env: { ...process.env, MAA_SKILLS_HOME: h.home }, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ host: 'claude', expectedRevision: (await inspectConfiguration(h.maa)).revision, closedConfirmed: true,
      authorization: { source: 'approved-report', reference: h.reference, basePlan: grant }, changes }) });
  assert.equal(cli.status, 1); assert.deepEqual(JSON.parse(cli.stdout), { ok: false, status: 'check-required' });
  const forged = await executeConfigWrite({ maaDirectory: h.maa, privateDirectory: h.home, host: 'claude', closedConfirmed: true, expectedRevision: (await inspectConfiguration(h.maa)).revision,
    authorization: { source: 'approved-report', reference: h.reference, basePlan: { ...grant, sha256: 'f'.repeat(64) } }, changes }, fakeMaa().maa);
  assert.equal(forged.status, 'rejected');
  const partial = await executeConfigWrite({ maaDirectory: h.maa, privateDirectory: h.home, host: 'claude', closedConfirmed: true, expectedRevision: (await inspectConfiguration(h.maa)).revision,
    authorization: { source: 'approved-report', reference: h.reference, basePlan: grant }, changes }, fakeMaa().maa);
  assert.equal(partial.status, 'rejected', 'a change set other than the derived one is refused');
  await nothingWritten(h, before);
});

test('the check CLI prints fixed codes and relative names only', async (t) => {
  const h = await home(t);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../skills/maa-core/scripts/base-apply.ts', import.meta.url)), 'check'], {
    env: { ...process.env, MAA_SKILLS_HOME: h.home }, encoding: 'utf8', windowsHide: true, input: JSON.stringify({ reference: h.reference, profile: 0, task: 1 }) });
  assert.equal(run.status, 1, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.status, 'needs-decision'); assert.equal(output.ok, false);
  assert.match(output.plan.applied, /^base-applied\/[a-f0-9]{64}\.json$/);
  assert.equal(run.stdout.includes(h.home.replaceAll('\\', '\\\\')) || run.stdout.includes(h.home), false, 'no private path is printed');
  assert.equal(run.stdout.includes('synthetic-secret-address'), false);
  const bad = spawnSync(process.execPath, [fileURLToPath(new URL('../skills/maa-core/scripts/base-apply.ts', import.meta.url)), 'check'], {
    env: { ...process.env, MAA_SKILLS_HOME: h.home }, encoding: 'utf8', windowsHide: true, input: JSON.stringify({ reference: h.reference, profile: 0 }) });
  assert.deepEqual(JSON.parse(bad.stdout), { ok: false, error: 'base-apply-input-invalid' });
});
