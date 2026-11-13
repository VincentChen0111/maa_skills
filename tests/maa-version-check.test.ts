import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addSourceVerified, checkSources, directorySource, generateRecord, readRegistry, releaseNotes, runDailyCheck, validateRegistry, type Registry, type RecordFile } from '../scripts/maa-version-check.ts';
import { readVerificationRecord } from '../skills/maa-core/scripts/maa-version.ts';

const script = fileURLToPath(new URL('../scripts/maa-version-check.ts', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
// Git blob ids computed independently of the implementation.
const blob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const MAA = 'MaaAssistantArknights/MaaAssistantArknights';
const repository = 'synthetic-owner/synthetic-skills';
const token = '<synthetic-token-must-not-leak-7d1e>';

// A fixed synthetic "MAA source tree": no MAA code, only placeholder text.
const base: Record<string, string> = {
  'src/Config/Fields.cs': 'synthetic field declarations v1\n',
  'docs/protocol/callbacks.md': 'synthetic callback names v1\n',
  'src/Core/Log.hpp': 'synthetic log envelope v1\n',
  'src/Core/Training.cpp': 'synthetic training flow v1\n',
};
function registry(versions: string[] = ['6.21.4']): Registry {
  const entry = (id: string, skills: string[], tickets: string[], paths: string[]) => ({ id, behaviour: `synthetic behaviour ${id}`, skills, tickets,
    evidence: ['docs/synthetic-sources.md'], sources: paths.map(path => ({ path, blob: blob(base[path]!) })), sourceVerified: [...versions], deviceVerified: [] as string[] });
  return { schemaVersion: 1, repository: MAA, entries: [entry('config-fields', ['maa-core', 'maa-daily'], ['05'], ['src/Config/Fields.cs']),
    entry('callbacks', ['maa-core', 'maa-doctor'], ['10'], ['docs/protocol/callbacks.md', 'src/Core/Log.hpp']),
    entry('training', ['maa-core', 'maa-daily'], ['24'], ['src/Core/Training.cpp'])], pending: [{ ticket: '27', locations: ['src/Config/Stone.cs'], note: 'synthetic pending' }] };
}
const record = (sourceVerified: string[] = ['6.21.4'], recordVersion = 1): RecordFile => ({ schemaVersion: 2, recordVersion, sourceVerified, deviceVerified: [] });

async function tree(t: { after(fn: () => Promise<unknown>): void }, files: Record<string, string | null>) {
  const directory = await mkdtemp(join(tmpdir(), 'maa-source-tree-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) if (text !== null) { await mkdir(join(directory, path, '..'), { recursive: true }); await writeFile(join(directory, path), text); }
  return directory;
}

test('a fixed sample source tree is reported unchanged, changed or with a missing entry', async (t) => {
  const unchanged = await checkSources(registry(), directorySource(await tree(t, base)));
  assert.equal(unchanged.outcome, 'unchanged');
  assert.deepEqual(unchanged.entries.map(entry => [entry.id, entry.state]), [['config-fields', 'unchanged'], ['callbacks', 'unchanged'], ['training', 'unchanged']]);
  const changed = await checkSources(registry(), directorySource(await tree(t, { ...base, 'src/Core/Log.hpp': 'synthetic log envelope v2\n' })));
  assert.equal(changed.outcome, 'changed');
  const callbacks = changed.entries.find(entry => entry.id === 'callbacks')!;
  assert.deepEqual([callbacks.state, callbacks.skills, callbacks.sources.map(source => [source.path, source.state])],
    ['changed', ['maa-core', 'maa-doctor'], [['docs/protocol/callbacks.md', 'unchanged'], ['src/Core/Log.hpp', 'changed']]]);
  assert.equal(callbacks.sources[1]!.current, blob('synthetic log envelope v2\n'));
  const missing = await checkSources(registry(), directorySource(await tree(t, { ...base, 'src/Core/Training.cpp': null })));
  assert.deepEqual([missing.outcome, missing.entries.find(entry => entry.id === 'training')!.state], ['changed', 'missing']);
  // The offline CLI reports the same outcome with exit codes 0 / 1.
  const registryFile = join(await tree(t, {}), 'registry.json'); await writeFile(registryFile, JSON.stringify(registry()));
  const ok = spawnSync(process.execPath, [script, 'verify', '--registry', registryFile, '--source', await tree(t, base)], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.equal(JSON.parse(ok.stdout).outcome, 'unchanged');
  const bad = spawnSync(process.execPath, [script, 'verify', '--registry', registryFile, '--source', await tree(t, { ...base, 'src/Config/Fields.cs': null })], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.deepEqual(JSON.parse(bad.stdout).entries.filter((entry: { state: string }) => entry.state !== 'unchanged').map((entry: { id: string }) => entry.id), ['config-fields']);
});

test('the verification record lists only versions every entry has verified, and its own version rises only when a list changes', () => {
  const mixed = registry(['6.21.4', '6.22.0']); mixed.entries[2]!.sourceVerified = ['6.22.0']; mixed.entries[0]!.deviceVerified = ['6.22.0'];
  assert.deepEqual(generateRecord(mixed, record([], 4)), { schemaVersion: 2, recordVersion: 5, sourceVerified: ['6.22.0'], deviceVerified: [] });
  assert.deepEqual(generateRecord(mixed, record(['6.22.0'], 5)), record(['6.22.0'], 5));
  assert.throws(() => validateRegistry({ ...registry(['6.22.0-beta.1']) }), /registry-invalid/, 'a beta never enters an entry list');
  assert.throws(() => validateRegistry({ ...registry(), entries: [{ ...registry().entries[0]!, sources: [{ path: '../outside', blob: blob('x') }] }] }), /registry-invalid/);
  assert.throws(() => validateRegistry({ ...registry(), entries: [{ ...registry().entries[0]!, sourceVerified: [] }] }), /registry-invalid/);
  assert.equal(releaseNotes(record(['6.21.4', '6.22.0'])), 'MAA 源码已核：v6.21.4、v6.22.0\nMAA 实机已核：无（没有在真实 MAA、模拟器和游戏上核对过的版本）\n');
});

type World = { releases: Record<string, unknown>[]; commits: Record<string, string>; files: Record<string, Record<string, string | null>>; issues: { number: number; body: string }[];
  labelExists?: boolean; failReleases?: boolean; branches?: string[];
  // Pull requests are listed by the issues API only once labelled; `pullsDenied` models the repository setting that stops Actions opening PRs.
  pulls?: { number: number; head: string; labels: string[]; body: string }[]; pullsDenied?: boolean; branchFiles?: Record<string, Record<string, string>> };
type Call = { method: string; url: string; body?: Record<string, unknown>; auth: boolean };
function github(world: World) {
  const calls: Call[] = []; let next = 40;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET', headers = new Headers(init?.headers);
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), auth: headers.has('authorization') });
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal, 'every request is time-bounded');
    const raw = `https://raw.githubusercontent.com/${MAA}/`;
    if (url.startsWith(raw)) {
      assert.equal(headers.has('authorization'), false, 'the token is never sent to the raw file host');
      const [commit, ...rest] = url.slice(raw.length).split('/'); const text = world.files[commit!]?.[rest.join('/')];
      return text === undefined || text === null ? new Response('missing', { status: 404 }) : new Response(text);
    }
    if (url === `https://api.github.com/repos/${MAA}/releases?per_page=30`) return world.failReleases ? new Response('down', { status: 503 }) : Response.json(world.releases);
    if (url.startsWith(`https://api.github.com/repos/${MAA}/commits/`)) {
      assert.equal(headers.get('accept'), 'application/vnd.github.sha');
      return new Response(world.commits[decodeURIComponent(url.split('/').at(-1)!)] ?? '', { status: world.commits[decodeURIComponent(url.split('/').at(-1)!)] ? 200 : 404 });
    }
    const api = `https://api.github.com/repos/${repository}/`;
    assert.ok(url.startsWith(api), `unexpected host ${url}`);
    const path = url.slice(api.length);
    if (method === 'GET' && path.startsWith('issues?state=all&labels=maa-version-check&per_page=100&page=')) return Response.json(Number(path.split('=').at(-1)) === 1 ? world.issues : []);
    if (method === 'GET' && path === 'labels/maa-version-check') return world.labelExists ? Response.json({ name: 'maa-version-check' }) : new Response('{}', { status: 404 });
    if (method === 'POST' && path === 'labels') { world.labelExists = true; return Response.json({}, { status: 201 }); }
    if (method === 'POST' && path === 'issues') { const number = next++; world.issues.push({ number, body: String((calls.at(-1)!.body as { body: string }).body) }); return Response.json({ number, html_url: `https://github.com/${repository}/issues/${number}` }, { status: 201 }); }
    if (method === 'GET' && path === 'git/ref/heads/main') return Response.json({ object: { sha: 'a'.repeat(40) } });
    if (method === 'GET' && path.startsWith('git/ref/heads/maa-version-check/')) return (world.branches ?? []).includes(path.slice('git/ref/heads/'.length)) ? Response.json({}) : new Response('{}', { status: 404 });
    if (method === 'POST' && path === 'git/refs') { (world.branches ??= []).push(String(calls.at(-1)!.body!.ref).slice('refs/heads/'.length)); return Response.json({}, { status: 201 }); }
    if (method === 'GET' && path.startsWith('contents/')) {
      const [file, query] = path.slice('contents/'.length).split('?ref=');
      return Response.json({ sha: world.branchFiles?.[decodeURIComponent(query!)]?.[file!] ?? 'b'.repeat(40) });
    }
    if (method === 'PUT' && path.startsWith('contents/')) {
      const body = calls.at(-1)!.body!, file = path.slice('contents/'.length), branch = String(body.branch);
      assert.equal(body.sha, world.branchFiles?.[branch]?.[file] ?? 'b'.repeat(40), 'an update names the file version it replaces');
      ((world.branchFiles ??= {})[branch] ??= {})[file] = blob(Buffer.from(String(body.content), 'base64').toString('utf8'));
      return Response.json({}, { status: 200 });
    }
    if (method === 'GET' && path.startsWith('pulls?head=')) {
      const head = decodeURIComponent(path.slice('pulls?head='.length).split('&')[0]!);
      assert.match(path, /&state=all/);
      return Response.json((world.pulls ?? []).filter(pull => pull.head === head).map(pull => ({ number: pull.number, html_url: `https://github.com/${repository}/pull/${pull.number}`, labels: pull.labels.map(name => ({ name })) })));
    }
    if (method === 'POST' && path === 'pulls') {
      if (world.pullsDenied) return Response.json({ message: 'GitHub Actions is not permitted to create or approve pull requests.' }, { status: 403 });
      const number = next++, body = calls.at(-1)!.body!;
      (world.pulls ??= []).push({ number, head: `${repository.split('/')[0]}:${body.head}`, labels: [], body: String(body.body) });
      return Response.json({ number, html_url: `https://github.com/${repository}/pull/${number}` }, { status: 201 });
    }
    if (method === 'POST' && /^issues\/\d+\/labels$/.test(path)) {
      const pull = world.pulls?.find(item => item.number === Number(path.split('/')[1]));
      if (pull && !pull.labels.includes('maa-version-check')) { pull.labels.push('maa-version-check'); world.issues.push({ number: pull.number, body: pull.body }); }
      return Response.json([]);
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }) as typeof fetch;
  return { fetcher, calls };
}
const release = (tag: string, prerelease = false) => ({ tag_name: tag, prerelease, draft: false, body: 'synthetic release notes' });
const world = (stableFiles: Record<string, string | null>, extra: Partial<World> = {}): World => ({
  releases: [release('v6.22.0'), release('v6.21.4')], commits: { 'v6.22.0': 'c'.repeat(40), 'v6.21.4': 'd'.repeat(40) },
  files: { ['c'.repeat(40)]: stableFiles, ['d'.repeat(40)]: base }, issues: [], ...extra });
const decode = (call: Call) => JSON.parse(Buffer.from(String(call.body!.content), 'base64').toString('utf8'));

test('an unchanged stable release opens one PR adding it to the source-verified lists, and a repeated check stays silent', async () => {
  const state = world(base), { fetcher, calls } = github(state);
  const report = await runDailyCheck({ registry: registry(), record: record(), fetcher, token, publish: true, repository });
  assert.equal(report.stable!.outcome, 'unchanged');
  assert.deepEqual(report.actions.map(action => [action.kind, action.key, action.state]), [['pull-request', 'stable-verified:6.22.0', 'created']]);
  const puts = calls.filter(call => call.method === 'PUT');
  assert.deepEqual(puts.map(call => call.url.split('/contents/')[1]), ['docs/maa-dependencies.json', 'skills/maa-core/references/verified-versions.json']);
  assert.ok(puts.every(call => call.body!.branch === 'maa-version-check/v6.22.0'));
  assert.ok(decode(puts[0]!).entries.every((entry: { sourceVerified: string[] }) => entry.sourceVerified.join() === '6.21.4,6.22.0'));
  assert.deepEqual(decode(puts[1]!), record(['6.21.4', '6.22.0'], 2));
  const pull = calls.find(call => call.url.endsWith('/pulls'))!;
  assert.deepEqual([pull.body!.base, pull.body!.head], ['main', 'maa-version-check/v6.22.0']);
  assert.match(String(pull.body!.title), /v6\.22\.0/); assert.match(String(pull.body!.body), /<!-- maa-version-check:stable-verified:6\.22\.0 -->/);
  assert.match(String(pull.body!.body), /实机已核.*不变/);
  assert.ok(calls.some(call => /issues\/\d+\/labels$/.test(call.url)), 'the PR carries the notification label');
  assert.ok(calls.filter(call => call.url.startsWith('https://api.github.com/repos/' + repository)).every(call => call.auth));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(token));
  const before = calls.length;
  const repeated = await runDailyCheck({ registry: registry(), record: record(), fetcher, token, publish: true, repository });
  assert.deepEqual(repeated.actions.map(action => action.state), ['already-notified']);
  assert.equal(calls.slice(before).some(call => call.method !== 'GET'), false, 'no duplicate PR, branch or label');
  // A PR whose labelling failed is found through its branch, labelled, and not opened twice; the branch starts at the checked-out commit.
  const unlabelled = github({ ...world(base), branches: ['maa-version-check/v6.22.0'],
    pulls: [{ number: 9, head: 'synthetic-owner:maa-version-check/v6.22.0', labels: [], body: 'earlier PR' }] });
  const left = await runDailyCheck({ registry: registry(), record: record(), fetcher: unlabelled.fetcher, token, publish: true, repository });
  assert.deepEqual(left.actions.map(action => action.state), ['already-notified']);
  assert.equal(unlabelled.calls.some(call => call.url.endsWith('/pulls') || call.url.endsWith('/git/refs') || call.method === 'PUT'), false);
  assert.ok(unlabelled.calls.some(call => call.method === 'POST' && call.url.endsWith('/issues/9/labels')), 'the missing label is added to the existing PR');
  const based = github(world(base));
  await runDailyCheck({ registry: registry(), record: record(), fetcher: based.fetcher, token, publish: true, repository, baseCommit: '9'.repeat(40) });
  assert.equal(based.calls.find(call => call.url.endsWith('/git/refs'))!.body!.sha, '9'.repeat(40));
  assert.equal(based.calls.some(call => call.url.endsWith('/git/ref/heads/main')), false);
});

test('a refused PR fails the run every day until it can be opened from the existing branch; a partly written branch is completed', async () => {
  // The newest stable is unchanged (a PR) and a newer beta has a change (an early-warning issue) in the same run.
  const betaCommit = 'f'.repeat(40);
  const state = world(base, { pullsDenied: true, releases: [release('v6.23.0-beta.1', true), release('v6.22.0'), release('v6.21.4')],
    commits: { 'v6.22.0': 'c'.repeat(40), 'v6.23.0-beta.1': betaCommit } });
  state.files[betaCommit] = { ...base, 'src/Config/Fields.cs': 'synthetic field declarations v2\n' };
  const { fetcher, calls } = github(state);
  const run = () => runDailyCheck({ registry: registry(), record: record(), fetcher, token, publish: true, repository });
  const betaIssues = () => calls.filter(call => call.method === 'POST' && call.url.endsWith(`/repos/${repository}/issues`) && /提前预警/.test(String(call.body!.title))).length;
  await assert.rejects(run, /github-request-failed/, 'day 1: the branch and both files are written, then the PR is refused');
  assert.deepEqual([calls.filter(call => call.url.endsWith('/git/refs')).length, calls.filter(call => call.method === 'PUT').length], [1, 2]);
  assert.equal(betaIssues(), 1, 'day 1: the refused PR does not hold back the beta early-warning issue');
  let mark = calls.length;
  await assert.rejects(run, /github-request-failed/, 'day 2: still no PR, so the run still fails instead of counting the branch as notified');
  assert.deepEqual(calls.slice(mark).filter(call => call.method !== 'GET').map(call => call.url.split(repository + '/')[1]), ['pulls'], 'no second branch, the files already match, the beta issue is not repeated');
  assert.equal(betaIssues(), 1);
  state.pullsDenied = false; mark = calls.length;
  const opened = await run();
  assert.deepEqual(opened.actions.map(action => [action.kind, action.state]), [['pull-request', 'created'], ['issue', 'already-notified']]);
  assert.deepEqual(calls.slice(mark).filter(call => call.method !== 'GET').map(call => call.url.split(repository + '/')[1]), ['pulls', `issues/${state.pulls![0]!.number}/labels`]);
  assert.equal(calls.slice(mark).find(call => call.url.endsWith('/pulls'))!.body!.head, 'maa-version-check/v6.22.0');
  mark = calls.length;
  assert.deepEqual((await run()).actions.map(action => action.state), ['already-notified', 'already-notified']);
  assert.equal(calls.slice(mark).some(call => call.method !== 'GET'), false);
  // A branch whose second file was never written (a failed update) gets only that file before the PR is opened.
  const registryText = JSON.stringify(addSourceVerified(registry(), '6.22.0'), null, 2) + '\n';
  const partial = github(world(base, { labelExists: true, branches: ['maa-version-check/v6.22.0'],
    branchFiles: { 'maa-version-check/v6.22.0': { 'docs/maa-dependencies.json': blob(registryText) } } }));
  const completed = await runDailyCheck({ registry: registry(), record: record(), fetcher: partial.fetcher, token, publish: true, repository });
  assert.deepEqual(completed.actions.map(action => action.state), ['created']);
  assert.deepEqual(partial.calls.filter(call => call.method === 'PUT').map(call => call.url.split('/contents/')[1]), ['skills/maa-core/references/verified-versions.json']);
  assert.equal(partial.calls.some(call => call.url.endsWith('/git/refs')), false);
});

test('a stable release with a changed or missing entry opens an issue naming entries and skills, and certifies nothing', async () => {
  const state = world({ ...base, 'src/Core/Log.hpp': 'synthetic log envelope v2\n', 'src/Core/Training.cpp': null }), { fetcher, calls } = github(state);
  const report = await runDailyCheck({ registry: registry(), record: record(), fetcher, token, publish: true, repository });
  assert.equal(report.stable!.outcome, 'changed');
  assert.deepEqual(report.actions.map(action => [action.kind, action.state]), [['issue', 'created']]);
  assert.equal(calls.some(call => call.method === 'PUT' || call.url.endsWith('/pulls') || call.url.endsWith('/git/refs')), false);
  const issue = calls.find(call => call.method === 'POST' && call.url.endsWith(`/repos/${repository}/issues`))!;
  const body = String(issue.body!.body);
  assert.match(String(issue.body!.title), /v6\.22\.0/);
  for (const text of ['callbacks', 'training', 'maa-doctor', 'maa-daily', 'src/Core/Log.hpp', 'src/Core/Training.cpp', '缺失', '变化', 'c'.repeat(40)]) assert.ok(body.includes(text), text);
  assert.equal(body.includes('config-fields'), false, 'unchanged entries are not listed as affected');
  assert.deepEqual(issue.body!.labels, ['maa-version-check']);
  assert.ok(calls.some(call => call.method === 'POST' && call.url.endsWith('/labels') && !/issues\/\d+/.test(call.url)), 'the missing label is created once');
  // The same change is not reported again, including when a later release carries the identical change.
  const again = github({ ...state, releases: [release('v6.22.1'), ...state.releases], commits: { ...state.commits, 'v6.22.1': 'e'.repeat(40) },
    files: { ...state.files, ['e'.repeat(40)]: state.files['c'.repeat(40)]! } });
  const repeated = await runDailyCheck({ registry: registry(), record: record(), fetcher: again.fetcher, token, publish: true, repository });
  assert.deepEqual(repeated.actions.map(action => action.state), ['already-notified']);
  assert.equal(again.calls.some(call => call.method === 'POST'), false);
});

test('a beta with changes opens one early-warning issue; an unchanged beta is silent; neither enters the verified lists', async () => {
  const betaCommit = 'f'.repeat(40);
  const changedBeta = world(base, { releases: [release('v6.23.0-beta.2', true), release('v6.23.0-beta.1', true), release('v6.22.0'), release('v6.21.4')],
    commits: { 'v6.22.0': 'c'.repeat(40), 'v6.23.0-beta.2': betaCommit }, labelExists: true });
  changedBeta.files[betaCommit] = { ...base, 'src/Config/Fields.cs': 'synthetic field declarations v2\n' };
  const { fetcher, calls } = github(changedBeta);
  const report = await runDailyCheck({ registry: registry(['6.21.4', '6.22.0']), record: record(['6.21.4', '6.22.0'], 2), fetcher, token, publish: true, repository });
  assert.equal(report.stable!.outcome, 'already-verified');
  assert.deepEqual([report.beta!.version, report.beta!.outcome], ['6.23.0-beta.2', 'changed']);
  assert.deepEqual(report.actions.map(action => [action.kind, action.state]), [['issue', 'created']]);
  const issue = calls.find(call => call.method === 'POST' && call.url.endsWith(`/repos/${repository}/issues`))!;
  assert.match(String(issue.body!.title), /提前预警.*v6\.23\.0-beta\.2/); assert.match(String(issue.body!.body), /config-fields/);
  assert.equal(calls.some(call => call.method === 'PUT'), false, 'a beta is never written into the record');
  const repeated = await runDailyCheck({ registry: registry(['6.21.4', '6.22.0']), record: record(['6.21.4', '6.22.0'], 2), fetcher, token, publish: true, repository });
  assert.deepEqual(repeated.actions.map(action => action.state), ['already-notified']);
  const quiet = world(base, { releases: [release('v6.23.0-beta.1', true), release('v6.22.0')], commits: { 'v6.22.0': 'c'.repeat(40), 'v6.23.0-beta.1': betaCommit } });
  quiet.files[betaCommit] = base;
  const silent = github(quiet);
  const result = await runDailyCheck({ registry: registry(['6.21.4', '6.22.0']), record: record(['6.21.4', '6.22.0'], 2), fetcher: silent.fetcher, token, publish: true, repository });
  assert.deepEqual([result.beta!.outcome, result.actions], ['unchanged', []]);
  assert.equal(silent.calls.some(call => call.method !== 'GET'), false);
});

test('a dry run plans without writing, and any lookup failure publishes nothing', async () => {
  const dry = github(world(base));
  const planned = await runDailyCheck({ registry: registry(), record: record(), fetcher: dry.fetcher, publish: false, repository });
  assert.deepEqual(planned.actions.map(action => action.state), ['planned']);
  assert.equal(dry.calls.some(call => call.method !== 'GET'), false);
  const down = github(world(base, { failReleases: true }));
  await assert.rejects(() => runDailyCheck({ registry: registry(), record: record(), fetcher: down.fetcher, token, publish: true, repository }), /release-lookup-failed/);
  assert.equal(down.calls.some(call => call.method !== 'GET'), false);
  await assert.rejects(() => runDailyCheck({ registry: registry(), record: record(), fetcher: dry.fetcher, publish: true, repository }), /publish-requires-token/);
});

test('the daily CLI uses the network only with --online and publishes only with a token, printing no secret', async (t) => {
  const offline = spawnSync(process.execPath, [script, 'daily'], { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: token } });
  assert.equal(offline.status, 1); assert.deepEqual(JSON.parse(offline.stdout), { status: 'rejected', reason: 'online-flag-required' });
  const directory = await tree(t, {});
  const noToken = spawnSync(process.execPath, [script, 'daily', '--online', '--publish'], { encoding: 'utf8', cwd: directory, env: { ...process.env, GITHUB_TOKEN: '', GITHUB_REPOSITORY: repository } });
  assert.equal(noToken.status, 1); assert.deepEqual(JSON.parse(noToken.stdout), { status: 'rejected', reason: 'publish-requires-token' });
  assert.doesNotMatch(offline.stdout + offline.stderr + noToken.stdout + noToken.stderr, new RegExp(token));
});

// ---- registry coverage: every MAA source a page cites --------------------------------------------------------------
// A citation is a link to a file at a fixed MAA commit, or a backticked MAA source path.
const citation = /MaaAssistantArknights\/MaaAssistantArknights\/blob\/[0-9a-f]{40}\/([^)#\s`]+)|`((?:src\/Maa[A-Za-z]+|docs\/zh-cn|resource|\.agents\/skills|\.github\/ISSUE_TEMPLATE)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g;
/**
 * Known matches that are deliberately not registered, keyed `<page> <cited path>`; each one says why. They are historical
 * citations, or text that only looks like a citation.
 */
const historicalCitations = new Map([
  // 05's record links Bootstrapper.cs without its Main/ directory, a 404 on every version. The behaviour is registered at
  // the real path src/MaaWpfGui/Main/Bootstrapper.cs (entry startup-auto-run-skip); 05's historical record is not rewritten.
  ['docs/daily-verification.md src/MaaWpfGui/Bootstrapper.cs', 'old path in 05\'s record; registered at src/MaaWpfGui/Main/Bootstrapper.cs'],
  // 08's record lists the synthetic zip entry names its extraction must refuse; `resource/NUL.txt` is the Windows device-name
  // case (tests/setup-download.test.ts), not an MAA file.
  ['docs/setup-verification.md resource/NUL.txt', 'synthetic zip entry name in 08\'s extraction tests, not an MAA source file'],
]);
/**
 * The pages scanned: every Markdown page under docs/ (sources and verification records, tickets, reviews, the spec) and
 * every Markdown file a skill ships (SKILL.md and references). Scanning only docs/*-sources.md missed 22's and 23's
 * citations, which live in their *-verification.md pages.
 */
async function citingPages(repositoryRoot: string): Promise<string[]> {
  const markdown = async (directory: string) => (await readdir(join(repositoryRoot, directory), { recursive: true }))
    .filter(name => name.endsWith('.md')).map(name => join(repositoryRoot, directory, name));
  return [...await markdown('docs'), ...await markdown('skills')];
}
/** Citations neither registered nor pending (`<page> cites <path>`), and the historical exceptions that matched. */
async function citationCoverage(repositoryRoot: string, registry: Registry): Promise<{ unregistered: string[]; excepted: string[] }> {
  const registered = new Set([...registry.entries.flatMap(entry => entry.sources.map(source => source.path)), ...registry.pending.flatMap(item => item.locations)]);
  const unregistered = new Set<string>(), excepted = new Set<string>();
  for (const file of await citingPages(repositoryRoot)) {
    const page = relative(repositoryRoot, file).replaceAll('\\', '/');
    for (const match of (await readFile(file, 'utf8')).matchAll(citation)) {
      const path = match[1] ?? match[2]!;
      if (registered.has(path)) continue;
      if (historicalCitations.has(`${page} ${path}`)) excepted.add(`${page} ${path}`); else unregistered.add(`${page} cites ${path}`);
    }
  }
  return { unregistered: [...unregistered].sort(), excepted: [...excepted].sort() };
}

test('the citation scan reads every docs page: without 23\'s registry entry, the citations in 23\'s verification record are unregistered', async (t) => {
  // 22's and 23's MAA facts are cited in their *-verification.md pages, not in a *-sources.md page.
  const directory = await mkdtemp(join(tmpdir(), 'maa-registry-copy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const copy = JSON.parse(await readFile(join(root, 'docs/maa-dependencies.json'), 'utf8')) as Registry;
  assert.ok(copy.entries.some(entry => entry.id === 'base-plan-apply' && entry.tickets.includes('23')));
  copy.entries = copy.entries.filter(entry => entry.id !== 'base-plan-apply');
  await writeFile(join(directory, 'maa-dependencies.json'), JSON.stringify(copy, null, 2) + '\n');
  const { unregistered } = await citationCoverage(root, await readRegistry(join(directory, 'maa-dependencies.json')));
  // The files only this entry registers (the others are also in 05's or 22's entries) and that 23's record cites.
  assert.deepEqual(unregistered.filter(entry => entry.startsWith('docs/base-apply-verification.md ')), ['src/MaaCore/Common/AsstInfrastDef.h',
    'src/MaaWpfGui/Configuration/Converter/JsonPredictSerializationModifier.cs', 'src/MaaWpfGui/Constants/Enums/InfrastRoomType.cs', 'src/MaaWpfGui/Utilities/JsonPredictAttribute.cs']
    .map(path => `docs/base-apply-verification.md cites ${path}`));
});

test('the repository registry covers the delivered MAA dependencies and the packaged record is generated from it', async () => {
  const actual = await readRegistry();
  assert.equal(validateRegistry(actual), actual);
  const packaged = JSON.parse(await readFile(join(root, 'skills/maa-core/references/verified-versions.json'), 'utf8'));
  assert.deepEqual(generateRecord(actual, packaged), packaged, 'the packaged record is exactly what the registry generates');
  assert.equal((await readVerificationRecord()).available, true);
  const skills = new Set(await readdir(join(root, 'skills')));
  for (const entry of actual.entries) {
    assert.ok(entry.skills.every(skill => skills.has(skill)), entry.id);
    for (const evidence of entry.evidence) assert.ok(existsSync(join(root, evidence)), `${entry.id}: ${evidence}`);
    for (const ticket of entry.tickets) assert.ok((await readdir(join(root, 'docs/issues'))).some(file => file.startsWith(`${ticket}-`)), ticket);
  }
  // Every MAA file a docs page or skill text cites is registered, or pending for an undelivered ticket.
  const coverage = await citationCoverage(root, actual);
  assert.deepEqual(coverage.unregistered, [], 'each of these is neither registered nor pending');
  assert.deepEqual(coverage.excepted, [...historicalCitations.keys()].sort(), 'every historical exception still names a citation that exists');
  // Pending registrations belong to tickets that are not delivered yet; delivering one requires registering its entries.
  for (const item of actual.pending) {
    const file = (await readdir(join(root, 'docs/issues'))).find(name => name.startsWith(`${item.ticket}-`))!;
    assert.doesNotMatch(await readFile(join(root, 'docs/issues', file), 'utf8'), /实施进度：已完成。/, `ticket ${item.ticket} is complete; move its pending locations into entries`);
  }
});

test('the task type set entry lists every type the configuration writer identifies, with its runtime discriminator', async () => {
  const actual = await readRegistry();
  const entry = actual.entries.find(item => item.id === 'task-type-set')!;
  assert.ok(entry && entry.facts, 'the task type set is registered with its listed types');
  const writer = await readFile(join(root, 'skills/maa-core/scripts/maa-config.ts'), 'utf8');
  const known = JSON.parse(writer.match(/const types = (\[[^\]]+\]);/)![1]!.replaceAll("'", '"')) as string[];
  for (const type of known) {
    assert.ok(entry.facts!.taskTypes!.includes(type), `TaskType ${type}`);
    assert.ok(entry.facts!.typeDiscriminators!.includes(`${type}Task`), `$type ${type}Task`);
  }
});

test('the daily workflow only runs the version check, with the permissions it needs and no other secret', async () => {
  const workflow = await readFile(join(root, '.github/workflows/maa-version-check.yml'), 'utf8');
  assert.match(workflow, /schedule:\s*\n\s*- cron: '\d+ \d+ \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.deepEqual([...workflow.matchAll(/^\s*- run: (.*)$|^\s*run: (.*)$/gm)].map(match => (match[1] ?? match[2])!.trim()), ['node scripts/maa-version-check.ts daily --online --publish']);
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]), ['GITHUB_TOKEN']);
  assert.match(workflow, /permissions:\s*\n\s*contents: write\s*\n\s*issues: write\s*\n\s*pull-requests: write/);
  assert.match(workflow, /persist-credentials: false/); assert.match(workflow, /concurrency:/);
  assert.doesNotMatch(workflow, /npm|claude|codex|MAA\.exe|adb/i, 'no dependency install, model, MAA or device step');
});

test('a reverified entry takes the fingerprints and version of the local source tree it was checked against', async (t) => {
  const directory = await tree(t, {}), registryFile = join(directory, 'registry.json'), recordFile = join(directory, 'record.json');
  await writeFile(registryFile, JSON.stringify(registry())); await writeFile(recordFile, JSON.stringify(record()));
  const source = await tree(t, { ...base, 'src/Core/Log.hpp': 'synthetic log envelope v2\n' });
  const refused = spawnSync(process.execPath, [script, 'reverify', '--registry', registryFile, '--record', recordFile, '--source', source, '--version', '6.23.0-beta.1', '--entry', 'callbacks'], { encoding: 'utf8' });
  assert.equal(refused.status, 1, 'a beta cannot be recorded as verified');
  const result = spawnSync(process.execPath, [script, 'reverify', '--registry', registryFile, '--record', recordFile, '--source', source, '--version', '6.22.0', '--entry', 'callbacks'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const updated = JSON.parse(await readFile(registryFile, 'utf8')) as Registry;
  const callbacks = updated.entries.find(entry => entry.id === 'callbacks')!;
  assert.deepEqual([callbacks.sourceVerified, callbacks.sources.map(source => source.blob)], [['6.21.4', '6.22.0'], [blob(base['docs/protocol/callbacks.md']!), blob('synthetic log envelope v2\n')]]);
  assert.deepEqual(updated.entries.find(entry => entry.id === 'training')!.sourceVerified, ['6.21.4'], 'other entries are untouched');
  assert.deepEqual(JSON.parse(await readFile(recordFile, 'utf8')), record(['6.21.4'], 1), 'the record lists only versions every entry has');
  await unlink(registryFile);
});
