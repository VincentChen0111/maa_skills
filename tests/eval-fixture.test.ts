import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { grade } from '../scripts/evaluation.ts';
import { scenarioHarnessFiles } from '../scripts/eval-run.ts';

/** The model's shell running `codex <args>` in the fixture: cmd.exe resolves it through PATH and PATHEXT on Windows, sh elsewhere. */
const codexInShell = (workspace: string, env: NodeJS.ProcessEnv, args: string[], input: string | Buffer) => process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/c', 'codex', ...args], { cwd: workspace, env, input, encoding: 'utf8', windowsHide: true })
  : spawnSync('sh', ['-c', `codex ${args.map((arg) => `'${arg}'`).join(' ')}`], { cwd: workspace, env, input, encoding: 'utf8' });

test('26 H (R5): a fixture with skills puts the reviewer shim first on PATH, and the reviewer double answers only this run\'s review brief', async (t) => {
  const bare = await createFixture(); t.after(() => bare.dispose());
  assert.equal(bare.env.PATH ?? bare.env.Path, process.env.PATH, 'no skills, no reviewer: the probe fixtures keep the runner PATH');
  await assert.rejects(access(join(bare.workspace, '.eval-bin')));
  const fixture = await createFixture({ companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) } });
  t.after(() => fixture.dispose());
  const shims = join(fixture.workspace, '.eval-bin');
  for (const key of ['PATH', 'Path']) if (fixture.env[key] !== undefined) assert.equal(fixture.env[key]!.split(delimiter)[0], shims, key);
  for (const file of ['.eval-review-double.mjs', '.eval-bin/codex.cmd', '.eval-bin/codex']) {
    assert.ok(fixture.original.has(file), file);
    assert.ok(scenarioHarnessFiles.includes(file), `${file} counts toward the scenario hash`);
  }
  // A brief as the report tools write it: <private>/reports/<kind>/<hash>/review-brief.md.
  const hash = 'a'.repeat(64);
  const brief = '# 建议报告独立审查说明\n\n你是一名独立审查员……报告：base-plan / ' + hash + '\n';
  await mkdir(join(fixture.workspace, 'private/reports/base-plan', hash), { recursive: true });
  await writeFile(join(fixture.workspace, 'private/reports/base-plan', hash, 'review-brief.md'), brief);
  const exec = ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '-'];
  const reply = (stdout: string) => JSON.parse(stdout.match(/```json\n(.+)\n```/)![1]!);
  const answered = codexInShell(fixture.workspace, fixture.env, exec, brief);
  assert.equal(answered.status, 0, answered.stderr);
  assert.deepEqual(reply(answered.stdout), { reportHash: hash, findings: [] });
  // A Windows pipe's byte-order mark and CRLF line ends are transport, not content.
  const piped = codexInShell(fixture.workspace, fixture.env, exec, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(brief.replaceAll('\n', '\r\n'))]));
  assert.equal(piped.status, 0, piped.stderr); assert.deepEqual(reply(piped.stdout), { reportHash: hash, findings: [] });
  // A brief whose characters changed on the way (Windows PowerShell 5.1 turns CJK into ?), or any other text, is not this run's.
  for (const other of [brief.replace(/[^\x00-\x7f]/g, '?'), 'Review the report.', '']) {
    const refused = codexInShell(fixture.workspace, fixture.env, exec, other);
    assert.equal(refused.status, 1, other); assert.equal(refused.stdout.trim(), '', other); assert.match(refused.stderr, /review brief/);
  }
  // `--json` gives the final message as an agent message item; -o also writes it to the named file.
  const json = codexInShell(fixture.workspace, fixture.env, ['exec', '--json', '--skip-git-repo-check', '-o', 'review-reply.txt', '-'], brief);
  assert.equal(json.status, 0, json.stderr);
  const message = json.stdout.trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.type === 'item.completed')?.item;
  assert.equal(message?.type, 'agent_message'); assert.deepEqual(reply(message.text), { reportHash: hash, findings: [] });
  assert.equal(await readFile(join(fixture.workspace, 'review-reply.txt'), 'utf8'), message.text);
  // Only the reviewer call the skill prescribes is answered: a prompt instead of the brief, a resumed session or any other command fails.
  for (const args of [['exec', '--skip-git-repo-check', 'review the brief file'], ['exec', 'resume', '--last'], ['login', 'status'], []]) {
    const refused = codexInShell(fixture.workspace, fixture.env, args, brief);
    assert.equal(refused.status, 1, args.join(' ')); assert.equal(refused.stdout.trim(), '', args.join(' '));
  }
  // Mistaken for a host, it reports a double's version, so a run started through it is marked a double (never a baseline).
  const version = codexInShell(fixture.workspace, fixture.env, ['--version'], '');
  assert.equal(version.status, 0); assert.match(version.stdout, /^maa-eval-host-double /);
});

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
  await writeFile(join(fixture.workspace, 'maa/config.json'), JSON.stringify({ queue: ['2-1'], gacha: false }));
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
