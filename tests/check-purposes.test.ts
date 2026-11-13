import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockingChecks, checkPurposes, knownCheckIds, purposeRules, type CheckPurpose } from '../skills/maa-core/scripts/checks.ts';
import { runChecks } from '../skills/maa-core/scripts/doctor.ts';
import { checkSetup, recheckSetup } from '../skills/maa-core/scripts/setup.ts';
import { inspectCredentials } from '../skills/maa-core/scripts/credentials.ts';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import type { MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';

/**
 * Conformance for the one owner of "which check results block what" (`blockingChecks` in checks.ts). Every check id the
 * shared checks can produce is classified for every purpose, and every consumer of check results decides through the
 * predicate with a registered purpose; a new check id or a new consumer fails here until it is classified.
 */
const repository = fileURLToPath(new URL('..', import.meta.url));
const error = (id: string) => ({ id, status: 'error' as const });

async function producedIds(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'maa-check-purposes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private');
  await mkdir(join(maaDirectory, 'config'), { recursive: true }); await mkdir(privateDirectory);
  await writeFile(join(maaDirectory, 'config/gui.new.json'), JSON.stringify({ Current: 'P', Configurations: { P: { TaskQueue: [] } }, Timers: { List: [] } }));
  const maa: MaaProcess = { inspect: async () => ({ running: false, treeExited: true, idle: true, ready: false }),
    close: async () => { throw new Error('unexpected close'); }, start: async () => { throw new Error('unexpected start'); } };
  const doctor = (await runChecks({ maaDirectory, privateDirectory, home: root, skillsRoot: join(root, 'skills') }, maa,
    { versionReader: async () => { throw new Error('unknown'); }, adb: { run: async () => ({ exitCode: 1, stdout: '' }) } })).checks.map(check => check.id);
  const setup = (await checkSetup({ home: root, maaDirectory })).checks.map(check => check.id);
  const credentials = (await inspectCredentials(privateDirectory)).checks.map(check => check.id);
  const home = join(root, 'settings');
  await updateSettings({ language: 'en', privateDirectory, maaDirectory }, home);
  const recheck = ((await recheckSetup({}, { home }, async () => null, { run: async () => ({ exitCode: 1, stdout: '' }) }, maa)).checks as { id: string }[])
    .map(check => check.id);
  return { doctor, setup, credentials, recheck };
}
type Producer = keyof Awaited<ReturnType<typeof producedIds>>;

test('every check id the shared checks produce is known and classified for every purpose; no stale or double classification', async t => {
  const { doctor, setup, credentials, recheck } = await producedIds(t);
  assert.equal(new Set(doctor).size, doctor.length, 'check ids are unique');
  assert.deepEqual([...doctor].sort(), [...knownCheckIds].sort(), 'runChecks produces exactly the known check ids');
  for (const id of [...setup, ...credentials, ...recheck]) assert.ok(doctor.includes(id), `${id} from setup, recheck or credentials is also a doctor check`);
  for (const purpose of checkPurposes) {
    const rule = purposeRules[purpose];
    if (rule === 'every-error') continue;
    const blocks = new Set(rule.blocks), notRelevant = new Set(rule.notRelevant);
    for (const id of knownCheckIds) assert.ok(blocks.has(id) !== notRelevant.has(id), `${purpose}: ${id} is classified exactly once`);
    for (const id of [...blocks, ...notRelevant]) assert.ok(knownCheckIds.includes(id), `${purpose}: ${id} is a known check id`);
  }
});

const setupRows = ['platform', 'maa', 'server', 'node', 'settings', 'private-directory', 'version', 'credential-nga', 'credential-skland', 'credential-bilibili'];
/** The check ids each producer's rows carry; asserted against one real run below. */
const producerRows: Record<Producer, readonly string[]> = {
  doctor: knownCheckIds,
  setup: setupRows,
  credentials: ['credential-nga', 'credential-skland', 'credential-bilibili'],
  recheck: [...setupRows, 'configuration', 'write-lock'],
};
/**
 * What each purpose's consumer passes to `blockingChecks`: the producer whose rows it passes, the ids the consumer supplies
 * outside those rows, and blocked ids it declares it never sees. A purpose may block only an id in one of the three.
 */
const consumerInputs: Record<CheckPurpose, { rows: Producer; separately: readonly string[]; notProduced: readonly string[] }> = {
  'doctor-exit': { rows: 'doctor', separately: [], notProduced: [] },
  'setup-exit': { rows: 'setup', separately: [], notProduced: [] },
  'credentials-exit': { rows: 'credentials', separately: [], notProduced: [] },
  'stage-retry': { rows: 'doctor', separately: [], notProduced: [] }, // verifyStageRun passes runChecks' rows
  // recheckSetup adds its own `connection` entry from a fresh discovery and transport test.
  'setup-recheck': { rows: 'recheck', separately: ['connection'], notProduced: [] },
};

test('a purpose blocks only ids its consumer sees: produced by its input rows, supplied separately, or declared not produced', async t => {
  const produced = await producedIds(t);
  for (const producer of Object.keys(producerRows) as Producer[]) {
    assert.deepEqual([...produced[producer]].sort(), [...producerRows[producer]].sort(), `${producer} rows match the declared list`);
  }
  assert.deepEqual(Object.keys(consumerInputs).sort(), [...checkPurposes].sort(), 'every purpose declares its consumer input');
  for (const purpose of checkPurposes) {
    const rule = purposeRules[purpose]; const input = consumerInputs[purpose]; const rows = producerRows[input.rows];
    for (const id of [...input.separately, ...input.notProduced]) assert.ok(!rows.includes(id), `${purpose}: ${id} is declared outside the rows but the rows carry it`);
    // An `every-error` purpose claims only the errors in its own input.
    if (rule === 'every-error') { assert.deepEqual([input.separately, input.notProduced], [[], []], purpose); continue; }
    for (const id of [...input.separately, ...input.notProduced]) assert.ok(rule.blocks.includes(id), `${purpose}: ${id} is declared but not blocked`);
    for (const id of rule.blocks) {
      assert.ok(rows.includes(id) || input.separately.includes(id) || input.notProduced.includes(id),
        `${purpose} blocks ${id}, but its consumer never sees that check: produce it, supply it separately, or declare it not produced`);
    }
  }
});

/** Direct decisions on a check status outside the owner; tests may compare statuses, product code may not. */
const directStatus = /\bstatus\s*[!=]==?\s*['"](?:error|warning|normal)['"]|['"](?:error|warning|normal)['"]\s*[!=]==?\s*[\w.?]*\bstatus\b/;
const purposeCall = /blockingChecks\([^'"]*?,\s*['"]([a-z-]+)['"]\s*\)/g;
async function sources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') files.push(...await sources(path)); }
    else if (/\.(?:ts|mjs|js)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test('every consumer of check results decides through blockingChecks with a registered purpose', async () => {
  const consumers: Record<string, CheckPurpose[]> = {};
  const direct: string[] = [];
  for (const root of ['skills', 'scripts', 'eval']) {
    for (const file of await sources(join(repository, root))) {
      const name = relative(repository, file).replaceAll('\\', '/');
      if (name === 'skills/maa-core/scripts/checks.ts') continue;
      const text = await readFile(file, 'utf8');
      text.split(/\r?\n/).forEach((line, index) => { if (directStatus.test(line)) direct.push(`${name}:${index + 1}`); });
      const named = [...text.matchAll(purposeCall)].map(match => match[1] as CheckPurpose);
      assert.equal(named.length, text.match(/blockingChecks\(/g)?.length ?? 0, `${name}: every blockingChecks call names its purpose literally`);
      if (named.length) consumers[name] = named;
    }
  }
  assert.deepEqual(direct, [], 'a check status is compared outside checks.ts: route the decision through blockingChecks and register its purpose');
  assert.deepEqual(consumers, {
    'eval/maa-doctor/scenarios.ts': ['doctor-exit'],
    'skills/maa-core/scripts/credentials.ts': ['credentials-exit'],
    'skills/maa-core/scripts/doctor.ts': ['doctor-exit'],
    'skills/maa-core/scripts/setup.ts': ['setup-exit', 'setup-recheck', 'setup-exit'], // check; recheck completion and its exit code
    'skills/maa-core/scripts/stage-run.ts': ['stage-retry'],
  });
  assert.deepEqual([...new Set(Object.values(consumers).flat())].sort(), [...checkPurposes].sort(), 'every purpose has a consumer');
});

test('stage-retry: errors in MAA, its configuration, the connection or the write lock block; credentials, skill copies, links and private records do not', () => {
  const blocking = (ids: string[]) => blockingChecks(ids.map(error), 'stage-retry');
  for (const id of ['connection', 'write-lock', 'configuration', 'configuration-fields', 'maa', 'server', 'settings', 'private-directory']) {
    assert.deepEqual(blocking([id]), { blocking: [id], notBlocking: [] }, id);
  }
  for (const id of ['credential-nga', 'credential-skland', 'credential-bilibili', 'skill-version', 'skill-links', 'private-files', 'node', 'platform']) {
    assert.deepEqual(blocking([id]), { blocking: [], notBlocking: [id] }, `${id} is reported, not blocking`);
  }
  assert.deepEqual(blocking(['credential-nga', 'connection', 'skill-links']), { blocking: ['connection'], notBlocking: ['credential-nga', 'skill-links'] });
  assert.deepEqual(blockingChecks([{ id: 'connection', status: 'warning' }, { id: 'write-lock', status: 'normal' }], 'stage-retry'), { blocking: [], notBlocking: [] },
    'warnings never block');
});

test('setup-recheck: errors in what setup installs or configures block completion; other features\' state is reported, not blocking', () => {
  const blocking = (ids: string[]) => blockingChecks(ids.map(error), 'setup-recheck');
  const blocks = ['maa', 'server', 'node', 'settings', 'private-directory', 'connection', 'configuration', 'write-lock'];
  const reported = ['platform', 'version', 'configuration-fields', 'remote-control', 'credential-nga', 'credential-skland', 'credential-bilibili', 'private-files',
    'skill-version', 'skill-links'];
  assert.deepEqual([...blocks, ...reported].sort(), [...knownCheckIds].sort(), 'the table names every known check id');
  for (const id of blocks) assert.deepEqual(blocking([id]), { blocking: [id], notBlocking: [] }, id);
  for (const id of reported) assert.deepEqual(blocking([id]), { blocking: [], notBlocking: [id] }, `${id} is reported, not blocking`);
  assert.deepEqual(blocking(['credential-nga', 'node', 'private-files']), { blocking: ['node'], notBlocking: ['credential-nga', 'private-files'] });
  assert.deepEqual(blockingChecks([{ id: 'maa', status: 'warning' }, { id: 'node', status: 'normal' }], 'setup-recheck'), { blocking: [], notBlocking: [] },
    'warnings never block');
});

test('a new or unknown check id blocks every purpose until it is classified (fail closed); an unknown purpose is rejected', () => {
  for (const purpose of checkPurposes) assert.deepEqual(blockingChecks([error('a-new-check')], purpose), { blocking: ['a-new-check'], notBlocking: [] }, purpose);
  assert.throws(() => blockingChecks([error('connection')], 'unknown-purpose' as CheckPurpose), /check-purpose-unknown/);
});

test('exit codes keep counting every error: doctor, setup and the credentials check', () => {
  const checks = [error('credential-nga'), error('skill-links'), { id: 'connection', status: 'warning' as const }];
  for (const purpose of ['doctor-exit', 'setup-exit', 'credentials-exit'] as const) {
    assert.deepEqual(blockingChecks(checks, purpose), { blocking: ['credential-nga', 'skill-links'], notBlocking: [] }, purpose);
  }
});
