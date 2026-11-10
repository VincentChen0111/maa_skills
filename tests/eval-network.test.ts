import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { runScenario } from '../scripts/eval-run.ts';
const source = { repository: 'synthetic/public-data', commit: 'a'.repeat(40), file: 'data/table.json' };
const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`;

test('trusted network fixtures replace only the named product CLI boundary and retain real invocation/FS evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maa-network-source-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts')); await writeFile(join(root, 'SKILL.md'), 'Synthetic network observer harness.');
  await writeFile(join(root, 'scripts/public-data.ts'), await readFile(new URL('../skills/maa-core/scripts/public-data.ts', import.meta.url)));
  // This harness tests the runner seam through the real public reader, without duplicating a calculation.
  await writeFile(join(root, 'scripts/operator-cost.ts'), `import {readPublicJson} from './public-data.ts'; let raw='';for await(const c of process.stdin)raw+=c;try{console.log(JSON.stringify(await readPublicJson(JSON.parse(raw))));}catch{console.error('network-rejected');process.exitCode=1;}`);
  const fixture = await createFixture({ companionSkills: { 'maa-core': root }, networkFixtures: { [url]: { synthetic: 17 } } }); t.after(() => fixture.dispose());
  for (const host of ['.agents', '.claude']) {
    const script = `${host}/skills/maa-core/scripts/operator-cost.ts`;
    const result = spawnSync(process.execPath, [script, 'query'], { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(source), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); const response = JSON.parse(result.stdout);
    assert.deepEqual(response.value, { synthetic: 17 });
    assert.equal(response.source.sha256, createHash('sha256').update('{"synthetic":17}').digest('hex'));
    const missing = spawnSync(process.execPath, [script, 'query'], { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify({ ...source, file: 'data/unlisted.json' }), encoding: 'utf8' });
    assert.equal(missing.status, 1); assert.match(missing.stderr, /network-rejected/);
  }
  const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
  assert.deepEqual(evidence.changes, []); assert.equal(evidence.events.filter(event => event.kind === 'invocation').length, 4);
  const unrelated = spawnSync(process.execPath, ['-e', `console.log(fetch.toString().includes('eval-network-unlisted'))`], { cwd: fixture.workspace, env: fixture.env, encoding: 'utf8' });
  assert.equal(unrelated.stdout.trim(), 'false');
});

test('network fixture URL validation rejects redirects, branches, non-JSON and non-raw addresses', async () => {
  for (const invalid of ['http://raw.githubusercontent.com/a/b/' + 'a'.repeat(40) + '/x.json', url.replace('a'.repeat(40), 'main'), url + '?token=x', url.replace('raw.githubusercontent.com', 'example.invalid'), url.replace('/data/table.json', '/data/../table.json'), url.replace('.json', '.js')]) {
    await assert.rejects(createFixture({ networkFixtures: { [invalid]: {} } }), /network-fixture-url/);
  }
});

test('network payload and activation semantics enter saved scenario and fingerprint without inventing model results', async t => {
  const records = [];
  for (const count of [1, 2]) {
    const result = await runScenario({ host: 'codex', model: 'fixed-model', executable: 'maa-synthetic-absent-cli', scenario: {
      id: 'network-synthetic', prompt: 'Read synthetic data only.', networkFixtures: { [url]: { count } },
      policy: { allowedKeys: [], forbiddenKeys: [], grants: [], downloadGrants: [], expectedCalls: [], expectedChanges: [], reportRequired: false, skipReview: false },
    } });
    t.after(() => rm(result.artifactDirectory, { recursive: true, force: true }));
    assert.equal(result.record.grade.status, 'unverified'); records.push(result.record);
    const saved = JSON.parse(await readFile(join(result.artifactDirectory, 'scenario.json'), 'utf8'));
    assert.deepEqual(saved.networkFixtures, { [url]: { count } });
  }
  assert.notEqual(records[0]!.scenarioHash, records[1]!.scenarioHash);
});
