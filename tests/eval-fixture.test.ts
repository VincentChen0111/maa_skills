import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';

test('isolated demonstration records real config changes and locks without touching the caller home', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  assert.notEqual(fixture.env.HOME, process.env.HOME);
  assert.equal(fixture.env.HOME, fixture.env.USERPROFILE);
  assert.ok(fixture.env.MAA_SKILLS_HOME?.startsWith(fixture.root));
  assert.ok(!('GITHUB_TOKEN' in fixture.env));
  await access(join(fixture.workspace, '.agents/skills/maa-eval-probe/SKILL.md'));
  await access(join(fixture.workspace, '.claude/skills/maa-eval-probe/SKILL.md'));
  const result = spawnSync(process.execPath, ['probe.ts', 'write'], { cwd: fixture.workspace, env: fixture.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(fixture.workspace, 'maa/config.json'), 'utf8')).queue, ['1-7']);
  const evidence = await collectEvidence(fixture, { completed: true, calls: [{ tool: 'shell', input: 'node probe.ts write', succeeded: true }], outputs: [result.stdout] });
  assert.equal(grade(fixture.policy, evidence).status, 'pass');
  assert.equal(evidence.events.map((event) => event.kind).join(','), 'lock-acquired,write,lock-released');
  await writeFile(join(fixture.workspace, 'maa/config.json'), JSON.stringify({ queue: ['2-1'], stone: false }));
  const tampered = await collectEvidence(fixture, evidence.transcript);
  assert.ok(grade(fixture.policy, tampered).failed.includes('authorization'));
  assert.ok(grade(fixture.policy, tampered).failed.includes('write-lock'));
});

test('a caller-provided skill is copied only into both temporary native skill directories', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'maa-skill-source-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const original = '---\nname: synthetic-skill\ndescription: synthetic fixture\n---\nRead the supplied sample only.\n';
  await writeFile(join(source, 'SKILL.md'), original);
  const binary = Buffer.from([0, 255, 195, 128]);
  await writeFile(join(source, 'sample.bin'), binary);
  const fixture = await createFixture({ skillDirectory: source });
  t.after(() => fixture.dispose());
  for (const host of ['.agents', '.claude']) assert.equal(await readFile(join(fixture.workspace, host, 'skills/subject/SKILL.md'), 'utf8'), original);
  assert.deepEqual(await readFile(join(fixture.workspace, '.agents/skills/subject/sample.bin')), binary);
  await writeFile(join(fixture.workspace, '.agents/skills/subject/sample.bin'), Buffer.from([0, 254, 195, 128]));
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  assert.ok(evidence.changes.some((change) => change.file.endsWith('sample.bin')), 'binary input changes must not collapse to the same replacement character');
  await writeFile(join(fixture.workspace, '.agents/skills/subject/SKILL.md'), 'modified sample');
  assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), original);
});

test('authorized non-MAA settings changes do not require the MAA write lock', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const content = JSON.stringify({ language: 'en' });
  await writeFile(join(fixture.workspace, 'private/settings.json'), content);
  const grant = { file: 'private/settings.json', key: '$file', value: Buffer.from(content).toString('base64') };
  const policy = { ...fixture.policy, lockFiles: ['maa/config.json'], allowedKeys: ['$file'], grants: [grant], expectedChanges: [grant] };
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  assert.equal(grade(policy, evidence).status, 'pass');
  assert.ok(grade({ ...policy, lockFiles: undefined }, evidence).failed.includes('write-lock'), 'unspecified scope remains fail-closed');
});

test('a custom JSON input is rendered inside the temporary fixture and observed by field', async (t) => {
  const fixture = await createFixture({ jsonInputs: { 'private/config.json': { language: null, privateDirectory: '{{private}}' } }, jsonFiles: ['private/config.json'] });
  t.after(() => fixture.dispose());
  const file = join(fixture.workspace, 'private/config.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.privateDirectory, join(fixture.workspace, 'private'));
  await writeFile(file, JSON.stringify({ ...config, language: 'en' }));
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  assert.deepEqual(evidence.changes, [{ file: 'private/config.json', key: 'language', before: null, after: 'en' }]);
  await assert.rejects(createFixture({ jsonInputs: { '../outside.json': {} } }), /fixture-path/);
});

test('companion skills install beside the subject in both isolated hosts', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'maa-companion-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(join(source, 'SKILL.md'), 'synthetic companion');
  const fixture = await createFixture({ skillDirectory: source, companionSkills: { 'maa-core': source } });
  t.after(() => fixture.dispose());
  for (const host of ['.agents', '.claude']) {
    assert.equal(await readFile(join(fixture.workspace, host, 'skills/maa-core/SKILL.md'), 'utf8'), 'synthetic companion');
    assert.ok(fixture.original.has(`${host}/skills/maa-core/SKILL.md`));
  }
  for (const name of ['../outside', 'subject', 'maa-eval-probe', 'MixedCase']) {
    await assert.rejects(createFixture({ skillDirectory: source, companionSkills: { [name]: source } }), /companion-name/);
  }
});

test('new declared JSON objects expose file creation and each top-level field', async (t) => {
  const fixture = await createFixture({ jsonFiles: ['private/new-snapshot.json'] });
  t.after(() => fixture.dispose());
  await writeFile(join(fixture.workspace, 'private/new-snapshot.json'), JSON.stringify({ source: 'maa', readAt: '2026-11-11T00:00:00.000Z' }));
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  assert.deepEqual(evidence.changes, [
    { file: 'private/new-snapshot.json', key: '$exists', before: false, after: true },
    { file: 'private/new-snapshot.json', key: 'source', before: undefined, after: 'maa' },
    { file: 'private/new-snapshot.json', key: 'readAt', before: undefined, after: '2026-11-11T00:00:00.000Z' },
  ]);
});

test('JSON existence, deletion, and unsafe object shapes cannot disappear from evidence', async (t) => {
  const fixture = await createFixture({ jsonInputs: { 'private/deleted.json': { source: 'maa' } },
    jsonFiles: ['private/deleted.json', 'private/empty.json', 'private/array.json', 'private/malformed.json', 'private/reserved.json'] });
  t.after(() => fixture.dispose());
  await rm(join(fixture.workspace, 'private/deleted.json'));
  for (const [file, value] of [['empty', '{}'], ['array', '[]'], ['malformed', '{bad'], ['reserved', '{"$exists":true}']]) {
    await writeFile(join(fixture.workspace, `private/${file}.json`), value!);
  }
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  assert.deepEqual(evidence.changes.filter(change => change.file === 'private/deleted.json'), [
    { file: 'private/deleted.json', key: '$exists', before: true, after: false },
    { file: 'private/deleted.json', key: 'source', before: 'maa', after: undefined },
  ]);
  assert.deepEqual(evidence.changes.filter(change => change.file === 'private/empty.json'), [
    { file: 'private/empty.json', key: '$exists', before: false, after: true },
  ]);
  for (const file of ['array', 'malformed', 'reserved']) {
    assert.equal(evidence.changes.filter(change => change.file === `private/${file}.json`).length, 1);
    assert.equal(evidence.changes.find(change => change.file === `private/${file}.json`)!.key, '$file');
  }
  assert.equal(grade({ ...fixture.policy, lockFiles: [] }, evidence).status, 'fail');
});
