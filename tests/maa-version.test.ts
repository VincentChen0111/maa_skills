import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessMaaVersion, compareMaaVersions, compareVersionStamp, readVerificationRecord, readVersionStamp, type VerificationRecord } from '../skills/maa-core/scripts/maa-version.ts';
import { checkSetup } from '../skills/maa-core/scripts/setup.ts';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';

async function directory(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'maa-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const record = (sourceVerified: string[], deviceVerified: string[] = [], recordVersion = 3): VerificationRecord =>
  ({ available: true, recordVersion, sourceVerified, deviceVerified });

test('the generated verification record carries its own version; malformed or beta-listing records are unavailable', async (t) => {
  const root = await directory(t);
  const write = async (name: string, value: unknown) => { const file = join(root, name); await writeFile(file, JSON.stringify(value)); return pathToFileURL(file); };
  assert.deepEqual(await readVerificationRecord(await write('ok.json', { schemaVersion: 2, recordVersion: 4, sourceVerified: ['6.21.4', '6.22.0'], deviceVerified: [] })),
    { available: true, recordVersion: 4, sourceVerified: ['6.21.4', '6.22.0'], deviceVerified: [] });
  for (const [name, value] of [
    ['old.json', { schemaVersion: 1, sourceVerified: [], deviceVerified: [] }],
    ['no-version.json', { schemaVersion: 2, sourceVerified: [], deviceVerified: [] }],
    ['zero.json', { schemaVersion: 2, recordVersion: 0, sourceVerified: [], deviceVerified: [] }],
    ['beta.json', { schemaVersion: 2, recordVersion: 1, sourceVerified: ['6.22.0-beta.4'], deviceVerified: [] }],
    ['text.json', { schemaVersion: 2, recordVersion: 1, sourceVerified: ['latest'], deviceVerified: [] }],
    ['extra.json', { schemaVersion: 2, recordVersion: 1, sourceVerified: [], deviceVerified: [], note: 'x' }],
  ] as const) assert.deepEqual(await readVerificationRecord(await write(name, value)), { available: false, recordVersion: null, sourceVerified: [], deviceVerified: [] }, name);
  assert.equal((await readVerificationRecord()).available, true, 'the packaged record is readable');
});

test('a newer source-verified stable release is an upgrade reminder; unverified versions still only warn', () => {
  const upgrade = assessMaaVersion('6.21.4', record(['6.21.4', '6.22.0'], ['6.21.4']));
  assert.deepEqual([upgrade.status, upgrade.reason], ['warning', 'maa-upgrade-available']);
  assert.deepEqual(upgrade.evidence, { installed: '6.21.4', recordAvailable: true, recordEmpty: false, recordVersion: 3, sourceVerified: true, deviceVerified: true,
    newerSourceVerified: '6.22.0', newerDeviceVerified: false });
  // An installed version newer than every verified one, or a beta, is not told to move to an older release.
  for (const installed of ['6.23.0', '6.23.0-beta.1']) {
    const result = assessMaaVersion(installed, record(['6.22.0']));
    assert.deepEqual([result.status, result.reason, result.evidence.newerSourceVerified], ['warning', 'maa-version-not-fully-verified', null], installed);
  }
  // The beta before a verified stable release is reminded about that release.
  assert.equal(assessMaaVersion('6.22.0-beta.4', record(['6.22.0'])).reason, 'maa-upgrade-available');
  const current = assessMaaVersion('6.22.0', record(['6.21.4', '6.22.0'], ['6.22.0']));
  assert.deepEqual([current.status, current.reason, current.evidence.newerSourceVerified], ['normal', 'maa-version-verified', null]);
  const unknown = assessMaaVersion(null, record(['6.22.0']));
  assert.deepEqual([unknown.status, unknown.reason, unknown.evidence.newerSourceVerified], ['warning', 'maa-version-unknown', null]);
  assert.equal(assessMaaVersion('6.21.4', { available: false, recordVersion: null, sourceVerified: [], deviceVerified: [] }).reason, 'verification-record-unavailable');
  assert.equal(assessMaaVersion('6.21.4', record([], [])).reason, 'verification-record-empty');
});

test('MAA versions order by SemVer precedence with betas before their release', () => {
  const sorted = ['6.22.0', '6.21.4', '6.22.0-beta.10', '6.22.0-beta.2', '6.3.0'].sort(compareMaaVersions);
  assert.deepEqual(sorted, ['6.3.0', '6.21.4', '6.22.0-beta.2', '6.22.0-beta.10', '6.22.0']);
  assert.throws(() => compareMaaVersions('6.22', '6.22.0'), /version-invalid/);
});

test('setup reads the record and names the upgrade as the user\'s own step', async (t) => {
  const root = await directory(t);
  const home = join(root, 'home'), maaDirectory = join(root, 'maa'), privateDirectory = join(root, 'private');
  await mkdir(join(maaDirectory, 'config'), { recursive: true }); await mkdir(privateDirectory);
  await writeFile(join(maaDirectory, 'MAA.exe'), 'synthetic executable placeholder');
  await writeFile(join(maaDirectory, 'config/gui.new.json'), JSON.stringify({ Current: 'Default', Configurations: { Default: { Gui: { RuntimeSettings: { ClientType: 'Official' } } } } }));
  await updateSettings({ language: 'en', privateDirectory, maaDirectory }, home);
  const verificationRecord = join(root, 'record.json');
  await writeFile(verificationRecord, JSON.stringify({ schemaVersion: 2, recordVersion: 7, sourceVerified: ['6.21.4', '6.22.0'], deviceVerified: [] }));
  const result = await checkSetup({ home, verificationRecord }, async () => '6.21.4');
  const row = result.checks.find(item => item.id === 'version')!;
  assert.deepEqual([row.status, row.reason, row.repair.id, row.repair.executor], ['warning', 'maa-upgrade-available', 'upgrade-maa-yourself', 'user']);
  assert.equal(row.repair.channel, undefined, 'no skill channel performs an MAA upgrade');
  assert.deepEqual(result.version, { installed: '6.21.4', recordAvailable: true, recordEmpty: false, recordVersion: 7, sourceVerified: true, deviceVerified: false,
    newerSourceVerified: '6.22.0', newerDeviceVerified: false });
});

test('a version stamp records the MAA version and record version; differences are reported, never refused', async (t) => {
  const root = await directory(t);
  await writeFile(join(root, 'MAA.exe'), 'synthetic executable placeholder');
  const verificationRecord = join(root, 'record.json');
  await writeFile(verificationRecord, JSON.stringify({ schemaVersion: 2, recordVersion: 5, sourceVerified: ['6.22.0'], deviceVerified: [] }));
  let reads = 0;
  const stamp = await readVersionStamp(root, async () => { reads++; return '6.22.0'; }, verificationRecord);
  assert.deepEqual(stamp, { maaVersion: '6.22.0', recordVersion: 5 });
  // Without MAA.exe the reader is not run at all.
  assert.deepEqual(await readVersionStamp(join(root, 'absent'), async () => { throw new Error('must not run'); }, verificationRecord), { maaVersion: null, recordVersion: 5 });
  assert.deepEqual(await readVersionStamp(root, async () => { throw new Error('unreadable'); }, verificationRecord), { maaVersion: null, recordVersion: 5 });
  assert.equal(reads, 1);
  assert.deepEqual(compareVersionStamp(stamp, stamp), { state: 'same', recorded: stamp, current: stamp, changed: [] });
  assert.deepEqual(compareVersionStamp(stamp, { maaVersion: '6.22.1', recordVersion: 6 }),
    { state: 'changed', recorded: stamp, current: { maaVersion: '6.22.1', recordVersion: 6 }, changed: ['maaVersion', 'recordVersion'] });
  assert.deepEqual(compareVersionStamp(stamp, { maaVersion: '6.22.0', recordVersion: 6 }).changed, ['recordVersion']);
  assert.deepEqual(compareVersionStamp({ maaVersion: null, recordVersion: 5 }, stamp), { state: 'unknown', recorded: { maaVersion: null, recordVersion: 5 }, current: stamp, changed: [] });
  assert.deepEqual(compareVersionStamp(undefined, stamp), { state: 'unrecorded', recorded: null, current: stamp, changed: [] });
  assert.deepEqual(compareVersionStamp({ maaVersion: 'not a version', recordVersion: 5 }, stamp).state, 'unrecorded');
});
