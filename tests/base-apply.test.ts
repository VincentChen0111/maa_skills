import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyBasePlan, checkBaseApply } from '../skills/maa-core/scripts/base-apply.ts';
import { executeConfigWrite, inspectConfiguration, type MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';
import { approveBaseReportItems, draftBaseReport } from '../skills/maa-core/scripts/base-report.ts';
import { loadAdviceReport, recordReviewSkip, saveAdviceReport } from '../skills/maa-core/scripts/advice-report.ts';
import { applyHome, goals, infrastConfig, type ApplyHome } from './fixtures/base-apply-data.ts';
import { nameTable, planInput, planSnapshot, planTables } from './fixtures/base-plan-data.ts';

// Ticket 23: applying an approved base plan. Real temporary homes and the real report, plan and configuration tools;
// only the MAA process is replaced (it records calls). No device, adb or game is involved in any test.
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** onClose / onStart run inside the fake GUI's close and start: something else touching the private directory meanwhile. */
function fakeMaa(options: { startFails?: boolean; closeFails?: boolean; onClose?: () => Promise<unknown>; onStart?: () => Promise<unknown> } = {}) {
  let running = true; const calls: string[] = [];
  const maa: MaaProcess = {
    inspect: async () => { calls.push('inspect'); return { running, treeExited: !running, idle: true, ready: running }; },
    close: async () => { calls.push('close'); if (options.closeFails) throw new Error('synthetic close failure'); await options.onClose?.(); running = false; },
    start: async () => { calls.push('start'); if (options.startFails) throw new Error('synthetic restart failure'); await options.onStart?.(); running = true; },
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
/** Another report version saved by the real report store from an edited copy of the fixture's content, then skipped and approved as the fixture does. */
async function crafted(h: ApplyHome, edit: (content: Record<string, any>) => void): Promise<string> {
  const content = structuredClone((await loadAdviceReport(h.home, 'base', h.reportHash)).content) as Record<string, any>;
  edit(content);
  const saved = await saveAdviceReport(h.home, content as never);
  await recordReviewSkip(h.home, 'base', saved.hash, { userWords: '这次跳过审查' });
  await approveBaseReportItems(h.home, saved.hash, { items: ['P1'], userWords: '我批准排班这一项 P1' });
  return `base/${saved.hash}#P1`;
}
const approvedSha = async (h: ApplyHome) => (await checkBaseApply({ reference: h.reference, profile: 0, task: 1 }, { home: h.home })).plan!.sha256;
const grant = (sha256: string) => ({ sha256, binding: { profile: 0, task: 1 }, decision: { unverified: [], userWords: null } });
/** The complete change set base-apply derives for the fixture's Infrast task (profile 0, task 1), with the copy path for `sha`. */
const derivedChanges = (h: ApplyHome, sha: string) => ([['Mode', 'Custom'], ['Filename', join(h.home, 'base-applied', `${sha}.json`)], ['PlanSelect', -1], ['CustomFileType', 'user_defined']] as const)
  .map(([key, value]) => ({ path: ['Configurations', 0, 'TaskQueue', 1, key], value }));
/** The common writer called directly, as only base-apply does, with an approved-report authorization the case adjusts. */
const writeDirect = async (h: ApplyHome, authorization: Record<string, unknown>, changes: unknown[], maa: MaaProcess) =>
  executeConfigWrite({ maaDirectory: h.maa, privateDirectory: h.home, host: 'claude', closedConfirmed: true, expectedRevision: (await inspectConfiguration(h.maa)).revision,
    authorization: { source: 'approved-report', reference: h.reference, ...authorization } as never, changes: changes as never }, maa);

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
  const shot = await home(t), snapshot = planSnapshot() as { operators: { name: string; level: number }[] };
  snapshot.operators[0]!.level = 50;
  await writeFile(join(shot.home, 'account-snapshot.json'), JSON.stringify(snapshot));
  const changed = await checkBaseApply({ reference: shot.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: shot.home });
  assert.deepEqual(changed.reasons, ['base-snapshot-changed']); assert.equal(changed.freshness!.snapshot, 'stale');
  // An operator the plan uses is no longer in the snapshot: the recheck reports the unowned warning next to the refusal.
  const gone = await home(t), smaller = planSnapshot() as { operators: { name: string }[] };
  smaller.operators = smaller.operators.filter(operator => operator.name !== '合成金一');
  await writeFile(join(gone.home, 'account-snapshot.json'), JSON.stringify(smaller));
  const unowned = await checkBaseApply({ reference: gone.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: gone.home });
  assert.ok(unowned.reasons.includes('base-snapshot-changed'));
  assert.ok(unowned.check!.warnings.some(warning => warning.startsWith('operator-unowned') && warning.includes('合成金一')), JSON.stringify(unowned.check!.warnings));
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

test('inputs that cannot be read now stop the apply: no snapshot, no tables, or a report input this version cannot check', async (t) => {
  const cases: [keyof NonNullable<Awaited<ReturnType<typeof checkBaseApply>>['freshness']>, string, (h: ApplyHome) => Promise<unknown>][] = [
    ['snapshot', 'base-snapshot-unavailable', h => rm(join(h.home, 'account-snapshot.json'))],
    ['tables', 'base-tables-unavailable', h => rm(h.tablesFile)],
  ];
  for (const [input, reason, damage] of cases) {
    const h = await home(t), before = await readFile(h.configFile);
    await damage(h);
    const checked = await checkBaseApply({ reference: h.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: h.home });
    assert.equal(checked.status, 'refused', input); assert.deepEqual(checked.reasons, [reason], input);
    assert.equal(checked.freshness![input], 'unknown', input); assert.equal(checked.check, null, `${input}: no recheck, and the report's old result is not used`);
    const { maa, calls } = fakeMaa();
    const result = await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), maa, { home: h.home });
    assert.equal(result.status, 'rejected', input); assert.equal(result.reason, reason, input); assert.deepEqual(calls, [], input);
    await nothingWritten(h, before);
  }
  // A report version whose input carries a field this version does not know: snapshot and tables are fresh, but the check cannot run.
  const h = await home(t), before = await readFile(h.configFile);
  const reference = await crafted(h, content => { content.input.futureField = 'synthetic'; });
  const checked = await checkBaseApply({ reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: h.home });
  assert.deepEqual(checked.reasons, ['base-recheck-unavailable']); assert.equal(checked.check, null);
  assert.equal(checked.freshness!.snapshot, 'fresh'); assert.equal(checked.freshness!.tables, 'fresh');
  const { maa, calls } = fakeMaa();
  const result = await applyBasePlan({ ...(await request(h, { decision: accept(['maa-timers']) })), reference }, maa, { home: h.home });
  assert.equal(result.reason, 'base-recheck-unavailable'); assert.deepEqual(calls, []);
  await nothingWritten(h, before);
});

test('the apply-time gate 15 audits the report\'s own texts again: a superlative in an approved report stops the apply', async (t) => {
  // Reports saved by an earlier version could carry texts its gate 15 never audited; the recheck audits the same texts the draft audits now.
  const h = await home(t), before = await readFile(h.configFile);
  const edits: [string, (content: Record<string, any>) => void][] = [
    ['plan title', content => { content.input.title = '最优两班'; }],
    ['assumption', content => { content.assumptions = [...content.assumptions, '这是最佳安排']; }],
    ['summary', content => { content.summary = '合成样例：最优的排班'; }],
    ['assumed goal', content => { content.goals = { source: 'assumed', text: '最高效地拿龙门币' }; }],
  ];
  for (const [where, edit] of edits) {
    const reference = await crafted(h, edit);
    const checked = await checkBaseApply({ reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: h.home });
    assert.deepEqual(checked.reasons, ['base-plan-not-applicable'], where);
    const gate = checked.check!.gates.find(entry => entry.gate === 15)!;
    assert.equal(gate.verdict, 'fail', where); assert.ok(gate.evidence.some(line => /最优|最佳|最高效/.test(line)), `${where}: ${JSON.stringify(gate.evidence)}`);
  }
  await nothingWritten(h, before);
});

test('the writer binds a base grant to the approved bytes and route: even the full derived change set is refused with a wrong hash, another grant, another source or an edited approval', async (t) => {
  const h = await home(t), before = await readFile(h.configFile), sha = await approvedSha(h), forged = 'f'.repeat(64);
  const cases: [string, Record<string, unknown>, unknown[]][] = [
    ['a wrong hash with the approved copy path', { basePlan: grant(forged) }, derivedChanges(h, sha)],
    ['a wrong hash with its own copy path', { basePlan: grant(forged) }, derivedChanges(h, forged)],
    ['a medicine grant alongside', { basePlan: grant(sha), medicineCount: 0 }, derivedChanges(h, sha)],
    ['the current-request source', { source: 'current-request', basePlan: grant(sha) }, derivedChanges(h, sha)],
    ['an authorization field the base route does not know', { basePlan: grant(sha), extra: true }, derivedChanges(h, sha)],
  ];
  for (const [name, authorization, changes] of cases) {
    const { maa, calls } = fakeMaa();
    const result = await writeDirect(h, authorization, changes, maa);
    assert.equal(result.status, 'rejected', `${name}: ${JSON.stringify(result)}`); assert.deepEqual(calls, [], name);
  }
  await nothingWritten(h, before);
  // The approval record's scope edited after approval no longer matches the report: base-apply and the writer both refuse.
  const folder = join(h.home, 'reports', 'base', h.reportHash, 'approvals'), [name] = await readdir(folder), file = join(folder, name!);
  const raw = await readFile(file, 'utf8'), record = JSON.parse(raw);
  record.items[0].scope.note = 'synthetic edit after approval'; await writeFile(file, JSON.stringify(record));
  const mismatch = await checkBaseApply({ reference: h.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: h.home });
  assert.deepEqual(mismatch.reasons, ['base-approval-scope-mismatch']); assert.equal(mismatch.plan, null, 'refused at the approval, before anything of the plan is read');
  const edited = fakeMaa();
  assert.equal((await writeDirect(h, { basePlan: grant(sha) }, derivedChanges(h, sha), edited.maa)).status, 'rejected'); assert.deepEqual(edited.calls, []);
  await nothingWritten(h, before);
  // Control: the same change set with the true hash and the record restored is accepted, so each refusal above was the binding.
  await writeFile(file, raw);
  const control = await writeDirect(h, { basePlan: grant(sha) }, derivedChanges(h, sha), fakeMaa().maa);
  assert.equal(control.status, 'complete', JSON.stringify(control));
  // With the fields at target and the copy matching there is nothing to do: an empty base transaction is refused.
  const empty = fakeMaa(), configAfter = await readFile(h.configFile);
  assert.equal((await writeDirect(h, { basePlan: grant(sha) }, [], empty.maa)).status, 'rejected'); assert.deepEqual(empty.calls, []);
  assert.deepEqual(await readFile(h.configFile), configAfter);
});

test('the writer proves the approved hash again from the report: a version whose plan, scope hash or permitted action disagrees is refused', async (t) => {
  // Each report version is saved by the real store and approved; each disagrees in exactly one place the writer checks.
  const h = await home(t), before = await readFile(h.configFile), sha = await approvedSha(h);
  const cases: [string, (content: Record<string, any>) => string][] = [
    ['the saved plan no longer hashes to the approved SHA-256', content => { content.plan.json.title = '合成两班（改）'; return sha; }],
    ['the permitted action names another SHA-256', content => {
      for (const item of content.items) for (const entry of item.scope.dailyMayArrange) entry.sha256 = 'e'.repeat(64);
      return sha; }],
    ['the scope keeps the old SHA-256 while the plan and the permitted action name a new one', content => {
      content.plan.json.title = '合成两班（改）';
      const other = digest(`${JSON.stringify(content.plan.json, null, 2)}\n`); content.plan.sha256 = other;
      for (const item of content.items) for (const entry of item.scope.dailyMayArrange) entry.sha256 = other;
      return other; }],
  ];
  for (const [name, edit] of cases) {
    let granted = '';
    const reference = await crafted(h, content => { granted = edit(content); });
    const checked = await checkBaseApply({ reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: h.home });
    assert.equal(checked.status, 'refused', `${name}: ${JSON.stringify(checked.reasons)}`);
    const { maa, calls } = fakeMaa();
    const result = await writeDirect(h, { reference, basePlan: grant(granted) }, derivedChanges(h, granted), maa);
    assert.equal(result.status, 'rejected', `${name}: ${JSON.stringify(result)}`); assert.deepEqual(calls, [], name);
  }
  await nothingWritten(h, before);
});

test('the applied copy has a way back: a deleted copy is installed again by a copy-only transaction, an edited copy is never overwritten', async (t) => {
  const h = await home(t);
  const first = await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), fakeMaa().maa, { home: h.home });
  assert.equal(first.status, 'complete', JSON.stringify(first));
  const sha = first.plan!.sha256, copy = join(h.home, 'base-applied', `${sha}.json`), approved = await readFile(copy);
  // Fields at target and the copy matching: unchanged, but a stale revision is still refused.
  const stale = fakeMaa();
  const outdated = await applyBasePlan({ ...(await request(h, { decision: accept(['maa-timers']) })), expectedRevision: '0'.repeat(64) }, stale.maa, { home: h.home });
  assert.equal(outdated.status, 'rejected'); assert.equal(outdated.reason, 'configuration-changed'); assert.deepEqual(stale.calls, []);
  // The user edited the copy (for example while hand-tuning in MAA): refused by name; MAA, the configuration and the edits are untouched.
  const edits = '{"title":"synthetic hand-tuned"}', configBefore = await readFile(h.configFile);
  await writeFile(copy, edits);
  const changed = await checkBaseApply({ reference: h.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: h.home });
  assert.equal(changed.status, 'refused'); assert.deepEqual(changed.reasons, ['base-plan-copy-changed']); assert.equal(changed.configuration!.copy, 'changed');
  const refusedRun = fakeMaa();
  const refused = await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), refusedRun.maa, { home: h.home });
  assert.equal(refused.status, 'rejected'); assert.equal(refused.reason, 'base-plan-copy-changed'); assert.deepEqual(refusedRun.calls, []);
  assert.equal(await readFile(copy, 'utf8'), edits); assert.deepEqual(await readFile(h.configFile), configBefore);
  // The user moved the edited file away: check and apply agree, and apply installs the approved bytes through the writer, nothing else.
  await rename(copy, join(h.home, 'my-edited-plan.json'));
  const missing = await checkBaseApply({ reference: h.reference, profile: 0, task: 1, decision: accept(['maa-timers']) }, { home: h.home });
  assert.equal(missing.status, 'ready', JSON.stringify(missing)); assert.deepEqual(missing.configuration!.changes, []); assert.equal(missing.configuration!.copy, 'absent');
  const { maa, calls } = fakeMaa();
  const reinstalled = await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), maa, { home: h.home });
  assert.equal(reinstalled.status, 'complete', JSON.stringify(reinstalled));
  assert.deepEqual(reinstalled.changedKeys, []); assert.equal(reinstalled.copyInstalled, true);
  assert.deepEqual(reinstalled.readback, { fields: [], copy: 'matching', periodSelection: 'gui-at-each-run-not-observed' });
  assert.ok(calls.indexOf('close') >= 0 && calls.indexOf('close') < calls.indexOf('start'), 'the copy is installed while MAA is closed');
  assert.deepEqual(await readFile(copy), approved);
  assert.deepEqual(await readFile(h.configFile), configBefore, 'the configuration is not rewritten');
  assert.equal(await readFile(join(h.home, 'my-edited-plan.json'), 'utf8'), edits, 'the user\'s edits stay where the user put them');
  const pending = (await records(join(h.home, 'daily-pending.jsonl'))).at(-1);
  assert.equal(pending.skill, 'maa-daily'); assert.deepEqual(pending.changes, []); assert.equal(pending.baseManifest.before, 'absent'); assert.equal(pending.authorization.basePlan.sha256, sha);
  const run = (await records(join(h.home, 'daily-runs.jsonl'))).at(-1);
  assert.equal(run.status, 'complete'); assert.equal(run.basePlan.sha256, sha);
  assert.deepEqual(await readFile(join(h.home, reinstalled.backup!)), configBefore);
  assert.equal((await readdir(join(h.maa, 'config'))).includes('.maa-skills.lock'), false);
  // Everything matches again: unchanged, MAA untouched.
  const again = fakeMaa();
  assert.equal((await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), again.maa, { home: h.home })).status, 'unchanged'); assert.deepEqual(again.calls, []);
});

test('a copy that changes while the writer has MAA closed is never overwritten or claimed: the outcome is unknown and kept as evidence', async (t) => {
  // After MAA closed and before the backup, something writes the copy: stop there.
  const h = await home(t), before = await readFile(h.configFile), copy = join(h.home, 'base-applied', `${await approvedSha(h)}.json`);
  const meanwhile = '{"synthetic":"written meanwhile"}';
  const early = fakeMaa({ onClose: async () => { await mkdir(dirname(copy), { recursive: true }); await writeFile(copy, meanwhile); } });
  const result = await applyBasePlan(await request(h, { decision: accept(['maa-timers']) }), early.maa, { home: h.home });
  assert.equal(result.status, 'unknown'); assert.equal(result.phase, 'backup'); assert.equal(result.readback, null);
  assert.deepEqual(await readFile(h.configFile), before); assert.equal(await readFile(copy, 'utf8'), meanwhile);
  assert.deepEqual(await readdir(join(h.home, 'maa-config-backups')).catch(() => []), [], 'stopped before the backup');
  // After the write and the restart, before the read-back: the copy no longer matches, so success is not claimed.
  const late = await home(t), lateCopy = join(late.home, 'base-applied', `${await approvedSha(late)}.json`);
  const after = await applyBasePlan(await request(late, { decision: accept(['maa-timers']) }), fakeMaa({ onStart: () => writeFile(lateCopy, meanwhile) }).maa, { home: late.home });
  assert.equal(after.status, 'unknown'); assert.equal(after.phase, 'readback'); assert.equal(after.readback, null);
  assert.equal((await records(join(late.home, 'daily-runs.jsonl'))).at(-1).status, 'unknown');
});

test('a weekly schedule that skips days is an unverified item the user decides on', async (t) => {
  const weekly = (use: boolean, off: string[]) => {
    const config = infrastConfig({ timers: true }) as { Configurations: { synthetic: { TaskQueue: Record<string, unknown>[] } } };
    Object.assign(config.Configurations.synthetic.TaskQueue[1]!, { UseWeeklySchedule: use,
      WeeklySchedule: Object.fromEntries(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(day => [day, !off.includes(day)])) });
    return config;
  };
  const h = await home(t, { config: weekly(true, ['Sunday', 'Saturday']) });
  const checked = await checkBaseApply({ reference: h.reference, profile: 0, task: 1 }, { home: h.home });
  assert.equal(checked.status, 'needs-decision'); assert.deepEqual(checked.unverified.map(entry => entry.id), ['maa-weekly-schedule']);
  assert.ok(/周日/.test(checked.unverified[0]!.evidence.join('')) && /周六/.test(checked.unverified[0]!.evidence.join('')), JSON.stringify(checked.unverified));
  assert.deepEqual(checked.configuration!.notes, [], 'no longer only a note');
  const { maa, calls } = fakeMaa();
  assert.equal((await applyBasePlan(await request(h), maa, { home: h.home })).reason, 'base-unverified-decision-required'); assert.deepEqual(calls, []);
  const done = await applyBasePlan(await request(h, { decision: accept(['maa-weekly-schedule']) }), maa, { home: h.home });
  assert.equal(done.status, 'complete', JSON.stringify(done));
  assert.deepEqual((await records(join(h.home, 'daily-runs.jsonl'))).at(-1).basePlan.decision.unverified, ['maa-weekly-schedule']);
  // The weekly schedule switched off (MAA then ignores it), or every day on: nothing extra to decide.
  for (const config of [weekly(false, ['Sunday']), weekly(true, [])]) {
    const other = await home(t, { config });
    const ready = await checkBaseApply({ reference: other.reference, profile: 0, task: 1 }, { home: other.home });
    assert.equal(ready.status, 'ready', JSON.stringify(ready)); assert.deepEqual(ready.unverified, []);
  }
});
