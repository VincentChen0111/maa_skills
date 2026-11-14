// Ticket 30, review round 1: one definition of "the same configuration value" (config-projection.ts), and the kind of
// comparison every site in `skills/` uses. MAA saves objects in its own key order (System.Text.Json, for example each
// `Copilot.TaskList` item), so an order-sensitive comparison of values MAA saved refused or left unknown a correct write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDiff, configValueKey, projectionRevision, sameConfigValue, wholeConfigFingerprint } from '../skills/maa-core/scripts/config-projection.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the predicate: object key order does not count; array order, key presence and every value do', () => {
  assert.equal(sameConfigValue({ a: 1, b: [{ x: 1, y: { p: 1, q: 2 } }] }, { b: [{ y: { q: 2, p: 1 }, x: 1 }], a: 1 }), true);
  assert.equal(sameConfigValue({ b: 1, 10: 2 }, { 10: 2, b: 1 }), true);
  const different: [unknown, unknown][] = [
    [[1, 2], [2, 1]],
    [{ a: [{ b: 1 }, { c: 1 }] }, { a: [{ c: 1 }, { b: 1 }] }],
    [{ a: null }, {}],
    [{ a: 1 }, { a: '1' }],
    [{ a: true }, { a: 1 }],
    [{ a: 0 }, { a: false }],
    [{ a: { b: 1 } }, { a: { b: 2 } }],
    [{ a: { b: 1 } }, { a: { b: 1, c: 1 } }],
    [{ 10: 1, b: 2 }, { 10: 1, b: 3 }],
    [null, undefined],
    ['', null],
  ];
  for (const [left, right] of different) assert.equal(sameConfigValue(left, right), false, JSON.stringify([left, right]));
  // The key is the predicate's own form; arrays and scalars are written exactly as JSON writes them.
  assert.equal(configValueKey({ b: 1, a: { d: 1, c: 2 } }), configValueKey({ a: { c: 2, d: 1 }, b: 1 }));
  assert.equal(configValueKey([3, 'x', null, true]), JSON.stringify([3, 'x', null, true]));
});

test('fingerprints: the diff follows the predicate; the approval revision and doctor\'s exact comparison keep key order', () => {
  const item = { Name: 'SYN-1', FilePath: 'synthetic.json', CopilotId: 1, IsRaid: false, IsChecked: true, IsNavNameOverride: false, Index: 0 };
  const maaOrder = { Name: 'SYN-1', IsNavNameOverride: false, FilePath: 'synthetic.json', CopilotId: 1, Index: 0, IsRaid: false, IsChecked: true };
  const config = (list: unknown[], profiles: string[] = ['A', 'B']) => ({ Current: 'A', Configurations: Object.fromEntries(profiles.map(name =>
    [name, name === 'A' ? { Copilot: { TaskList: list, EnableUserAdditional: false } } : {}])), Timers: { List: [] } });
  const path = [['Configurations', 'A', 'Copilot', 'TaskList']];
  const after = config([{ ...item, CopilotId: 2 }]);
  // The diff: MAA saving the old list in its own key order changes neither the entries nor the fingerprint ...
  assert.equal(configDiff(config([maaOrder]), after, path).fingerprint, configDiff(config([item]), after, path).fingerprint);
  assert.deepEqual(configDiff(config([item]), config([maaOrder]), path).entries, [], 'key order alone is no change');
  // ... while any value, an array's order or a key's presence does.
  for (const changed of [[{ ...item, IsChecked: false }], [item, item], [{ ...item, Extra: null }]]) {
    assert.notEqual(configDiff(config(changed), after, path).fingerprint, configDiff(config([item]), after, path).fingerprint, JSON.stringify(changed));
  }
  // The approval revision hashes the projection's raw JSON: a request names a profile by its position in `Configurations`,
  // which is that object's key order, so reordering profiles must make an approval stale.
  assert.notEqual(projectionRevision(config([item], ['B', 'A'])), projectionRevision(config([item])));
  assert.notEqual(projectionRevision(config([maaOrder])), projectionRevision(config([item])), 'a re-save in another order refuses (fail-closed), never widens');
  // Doctor's comparison stays the exact one the spec asks for; review round 1 left it unchanged (reasons in the record).
  assert.notEqual(wholeConfigFingerprint(config([maaOrder])), wholeConfigFingerprint(config([item])));
});

type Kind = 'configuration-value' | 'predicate-definition' | 'fingerprint-key-order-counts' | 'raw-evidence' | 'no-objects' | 'not-configuration';
/** Every site in `skills/` the patterns below find, with the kind of comparison it is and why. */
const sites: { file: string; site: string; kind: Kind; why: string }[] = [
  // The predicate and its key.
  { file: 'config-projection.ts', site: 'export function configValueKey(', kind: 'predicate-definition', why: 'the one definition' },
  { file: 'config-projection.ts', site: 'export function sameConfigValue(', kind: 'predicate-definition', why: 'the one definition' },
  { file: 'config-projection.ts', site: 'return configValueKey(left) === configValueKey(right);', kind: 'predicate-definition', why: 'the one definition' },
  // Configuration values: every one goes through the predicate.
  { file: 'config-edit.ts', site: 'if (sameConfigValue(JSON.parse(slice(node)), value)) return slice(node);', kind: 'configuration-value', why: 'minimal edit: an equal value keeps its bytes' },
  { file: 'config-edit.ts', site: '!used.has(at) && sameConfigValue(candidate, item)', kind: 'configuration-value', why: 'minimal edit: a reorder keeps each item\'s bytes' },
  { file: 'config-edit.ts', site: 'if (!sameConfigValue(JSON.parse(result.startsWith(bom)', kind: 'configuration-value', why: 'minimal edit: the final check' },
  { file: 'config-projection.ts', site: '.filter(entry => !sameConfigValue(entry.before, entry.after));', kind: 'configuration-value', why: 'diff: which changes count' },
  { file: 'config-projection.ts', site: 'update(configValueKey(entries.map(', kind: 'configuration-value', why: 'diff fingerprint, key order ignored' },
  { file: 'consumption-grant.ts', site: 'if (sameConfigValue(before[field], task[field])) continue;', kind: 'configuration-value', why: 'changed consumption fields' },
  { file: 'consumption-grant.ts', site: 'restore && sameConfigValue(restore[field], task[field])', kind: 'configuration-value', why: 'doctor restore takes back the backup value' },
  { file: 'maa-config.ts', site: 'return configValueKey(value);', kind: 'configuration-value', why: 'comparableAt: target checks before and after closing, read-back, doctor per-change state' },
  { file: 'maa-config.ts', site: '!sameConfigValue(training.changes, request.changes)', kind: 'configuration-value', why: 'training plan change set equals the approval' },
  { file: 'maa-config.ts', site: '!sameConfigValue(base.changes, request.changes)', kind: 'configuration-value', why: 'base plan change set equals the approval' },
  { file: 'maa-config.ts', site: "allowed = sameConfigValue(value, approvedJobList(", kind: 'configuration-value', why: 'job list equals the approved list' },
  { file: 'maa-config.ts', site: 'changedKeys: request.changes.filter(change => !sameConfigValue(', kind: 'configuration-value', why: 'changed keys in the run record' },
  { file: 'training-config.ts', site: '!sameConfigValue(trainingTimerIdentity(timer), trainingTimerIdentity(grant.expectedTimer))', kind: 'configuration-value', why: 'the bound timer is unchanged' },
  { file: 'training-plan.ts', site: 'return sameConfigValue(expected, actual);', kind: 'configuration-value', why: 'the bound queue and timer are unchanged' },
  { file: 'training-plan.ts', site: 'if (!sameConfigValue({ ...current, IsEnabled: null }, { ...expected, IsEnabled: null })', kind: 'configuration-value', why: 'cleanup owns the timer it armed' },
  // Fingerprints that keep key order, on purpose.
  { file: 'config-projection.ts', site: "update(JSON.stringify(projectConfig(config)))", kind: 'fingerprint-key-order-counts', why: 'approval revision: a profile index is the key order of Configurations; a re-save in another order only refuses' },
  { file: 'config-projection.ts', site: "update(JSON.stringify(config)).digest('hex')", kind: 'fingerprint-key-order-counts', why: 'doctor exact comparison, unchanged by round 1' },
  // Byte identity of raw evidence, not parsed values.
  { file: 'maa-config.ts', site: 'update(JSON.stringify([rawLock, rawCurrent, rawBackup, rawPending, summary]))', kind: 'raw-evidence', why: 'evidence revision over the raw texts' },
  // No object inside, so key order cannot arise.
  { file: 'maa-config.ts', site: 'const same = (left: (string | number)[], right: (string | number)[]) => JSON.stringify(left) === JSON.stringify(right);', kind: 'no-objects', why: 'change paths' },
  { file: 'base-apply.ts', site: 'if (runs && JSON.stringify(times) !== JSON.stringify([...runs].sort()))', kind: 'no-objects', why: 'sorted HH:MM strings built from the timers' },
  { file: 'setup-connection.ts', site: "const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value))", kind: 'no-objects', why: 'candidate ids and the projection revision string' },
  // Not configuration values: reports, plans, job files, logs, credentials and research inputs maa-skills itself writes or reads.
  { file: 'advice-report.ts', site: "if (digest(JSON.stringify(value)) !== hash)", kind: 'not-configuration', why: 'saved report content' },
  { file: 'base-apply.ts', site: 'JSON.stringify(reportItem.scope) !== JSON.stringify(resolved.item.scope)', kind: 'not-configuration', why: 'approved report scope' },
  { file: 'base-config.ts', site: 'JSON.stringify(reportItem.scope) !== JSON.stringify(item.scope)', kind: 'not-configuration', why: 'approved report scope' },
  { file: 'base-plan.ts', site: 'return digest(JSON.stringify({ operators: rows,', kind: 'not-configuration', why: 'account snapshot facts' },
  { file: 'base-plan.ts', site: 'JSON.stringify(before) === JSON.stringify(now)', kind: 'not-configuration', why: 'plan input fingerprints' },
  { file: 'base-query.ts', site: 'remaining.findIndex(other => JSON.stringify(other) === JSON.stringify(skill))', kind: 'not-configuration', why: 'game skill data' },
  { file: 'base-report.ts', site: 'const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);', kind: 'not-configuration', why: 'report input fields' },
  { file: 'base-report.ts', site: 'filter(key => JSON.stringify(old[key]) !== JSON.stringify(next[key]))', kind: 'not-configuration', why: 'report result fields' },
  { file: 'credentials.ts', site: 'isDeepStrictEqual(record.fields, services[service].fields)', kind: 'not-configuration', why: 'credential field names' },
  { file: 'credentials.ts', site: 'isDeepStrictEqual(Object.keys(parsed), [...services[service].fields])', kind: 'not-configuration', why: 'credential field names' },
  { file: 'cultivation-report.ts', site: 'const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);', kind: 'not-configuration', why: 'report input fields' },
  { file: 'cultivation-report.ts', site: 'filter(key => JSON.stringify(old[key]) !== JSON.stringify(next[key]))', kind: 'not-configuration', why: 'report result fields' },
  { file: 'research.ts', site: "update(JSON.stringify(canonical(parts)))", kind: 'not-configuration', why: 'research cache key' },
  { file: 'stage-job-plan.ts', site: "update(JSON.stringify(content)).digest('hex') !== expected", kind: 'not-configuration', why: 'approved job file content' },
  { file: 'stage-jobs.ts', site: "const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value))", kind: 'not-configuration', why: 'report, job and snapshot hashes' },
  { file: 'stage-jobs.ts', site: 'digest(row.required) !== digest(row.effectiveRequired)', kind: 'not-configuration', why: 'job requirement display' },
  { file: 'stage-run.ts', site: "const digest = createHash('sha256').update(JSON.stringify({ runId: record.runId,", kind: 'not-configuration', why: 'switch request key over the generated list' },
  { file: 'training-state.ts', site: 'JSON.stringify(target.skill_mastery) === JSON.stringify(ranks)', kind: 'not-configuration', why: 'MAA log task parameters' },
  { file: 'training-state.ts', site: "JSON.stringify(params.facility) === '[\"Training\"]'", kind: 'not-configuration', why: 'MAA log task parameters' },
  { file: 'training-state.ts', site: "hash: createHash('sha256').update(JSON.stringify(parameters))", kind: 'not-configuration', why: 'MAA log task parameters' },
];
const patterns = [
  /JSON\.stringify\([^;]*?\)\s*[!=]==|[!=]==\s*JSON\.stringify\(/, // JSON text equality
  /(createHash\([^)]*\)\.update\(|digest\(|\bhash\()\s*JSON\.stringify\(/, // a hash over JSON text
  /\b(isDeepStrictEqual|deepStrictEqual)\(/, // deep equality
  /\b(sameConfigValue|configValueKey)\(/, // the predicate
];

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []))).flat();
}

test('every comparison of values in skills/ is enumerated, and each configuration value goes through the one predicate', async () => {
  const found: { file: string; line: string }[] = [];
  for (const file of await sources(join(root, 'skills'))) {
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      if (/^\s*(\*|\/\/|\/\*)/.test(line) || !patterns.some(pattern => pattern.test(line))) continue;
      found.push({ file: relative(join(root, 'skills'), file).split(sep).join('/'), line });
    }
  }
  const used = new Set<number>();
  for (const { file, line } of found) {
    const matches = sites.map((site, index) => ({ site, index })).filter(({ site }) => file.endsWith(`/${site.file}`) && line.includes(site.site));
    assert.equal(matches.length, 1, `classify this comparison in tests/config-value.test.ts: ${file}: ${line.trim()}`);
    used.add(matches[0]!.index);
  }
  assert.deepEqual(sites.filter((_, index) => !used.has(index)), [], 'every listed site still exists');
  // A site that compares configuration values must use the predicate itself, never JSON text or deep equality.
  for (const site of sites.filter(item => item.kind === 'configuration-value')) assert.match(site.site, /sameConfigValue\(|configValueKey\(/, site.site);
  // comparableAt (the predicate's form) is how the writer and doctor compare targets, read-backs and changed fields.
  const writer = await readFile(join(root, 'skills/maa-core/scripts/maa-config.ts'), 'utf8');
  const comparisons = writer.split(/\r?\n/).filter(line => /comparableAt\(/.test(line) && !/^function comparableAt/.test(line.trim())).map(line => line.trim());
  assert.equal(comparisons.length, 7, comparisons.join('\n'));
  for (const reason of ['authorized-target-changed', 'readback-mismatch', 'readback-target-changed']) assert.ok(comparisons.some(line => line.includes(reason)), reason);
  // Byte identity stays byte-exact: the edit refuses a file that does not round-trip, the backup and the written file are bytes,
  // and doctor's evidence is stable only while the raw lock and configuration texts are unchanged.
  for (const exact of ["if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('configuration-text-unsupported');", 'await backup.writeFile(before);',
    'await handle.writeFile(edited!);', "rawCurrent === await read(join(context.maaDirectory, 'config', 'gui.new.json'))"]) assert.ok(writer.includes(exact), exact);
});
