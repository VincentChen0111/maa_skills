import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { planSetupDownload, downloadSetupProgram, setupDownloadStatus, installSetupDownload, recheckSetup, discoverSetupConnections, type AdbBoundary } from '../skills/maa-core/scripts/setup.ts';
import { systemArchive, type Fetcher } from '../skills/maa-core/scripts/setup-download.ts';
import type { MaaProcess } from '../skills/maa-core/scripts/maa-config.ts';
import { runChecks } from '../skills/maa-core/scripts/doctor.ts';
import { storedZip } from './fixtures/zip.ts';

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const sha1 = (value: Buffer | string) => createHash('sha1').update(value).digest('hex');
type Route = { status?: number; headers?: Record<string, string>; body?: string | Buffer; failAfter?: number };

/** Network boundary double: only listed URLs answer, every request is recorded, redirects are never followed for the caller. */
function network(routes: Record<string, Route>) {
  const calls: { url: string; method: string }[] = [];
  const fetch: Fetcher = async (url, init) => {
    const method = init.method ?? 'GET'; calls.push({ url, method });
    assert.equal(init.redirect, 'manual', 'redirects must be checked hop by hop');
    const route = routes[url];
    if (!route) throw new TypeError('synthetic network: unlisted address');
    const bytes = typeof route.body === 'string' ? Buffer.from(route.body) : route.body;
    let body: ReadableStream<Uint8Array> | null = null;
    let sent = false;
    if (method !== 'HEAD' && bytes) body = new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new Uint8Array(route.failAfter === undefined ? bytes : bytes.subarray(0, route.failAfter))); }
      else if (route.failAfter === undefined) controller.close();
      else controller.error(new Error('synthetic connection reset'));
    } });
    return new Response(body, { status: route.status ?? 200, headers: route.headers ?? {} });
  };
  return { fetch, calls, binaryCalls: () => calls.filter(call => !/index\.json|releases\/latest|repository2-1\.xml|SHASUMS256/.test(call.url) && call.method === 'GET') };
}

const maaIndexUrl = 'https://api.github.com/repos/MaaAssistantArknights/MaaAssistantArknights/releases/latest';
function maaRelease(tag: string, bytes: Buffer, extra: Record<string, unknown> = {}) {
  const name = `MAA-${tag}-win-x64.zip`;
  const url = `https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases/download/${tag}/${name}`;
  const storage = `https://release-assets.githubusercontent.com/synthetic/${tag}`;
  return { name, url, storage, routes: {
    [maaIndexUrl]: { body: JSON.stringify({ tag_name: tag, draft: false, prerelease: false, assets: [
      { name: `MAA-${tag}-win-arm64.zip`, size: 1, digest: `sha256:${'0'.repeat(64)}`, browser_download_url: url.replace('x64', 'arm64') },
      { name, size: bytes.length, digest: `sha256:${sha256(bytes)}`, browser_download_url: url, ...extra }] }) },
    [url]: { status: 302, headers: { location: storage } },
    [storage]: { body: bytes, headers: { 'content-length': String(bytes.length) } },
  } as Record<string, Route> };
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, options: { maa?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maa-setup-download-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'settings'); const privateDirectory = join(root, 'private'); const maaDirectory = join(root, 'maa');
  if (options.maa) {
    await mkdir(join(maaDirectory, 'config'), { recursive: true }); await writeFile(join(maaDirectory, 'MAA.exe'), 'synthetic executable');
  }
  await updateSettings({ language: 'en', privateDirectory, ...(options.maa ? { maaDirectory } : {}) }, home);
  await mkdir(privateDirectory, { recursive: true });
  return { root, home, privateDirectory, maaDirectory };
}
const files = async (directory: string): Promise<string[]> => {
  try { return (await readdir(directory, { recursive: true })).map(item => String(item).replaceAll('\\', '/')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
};

test('a missing MAA gets an official plan with file, version, source, size and executors, and planning downloads nothing', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic MAA archive');
  const release = maaRelease('v9.1.0', bytes); const net = network(release.routes);
  const plan = await planSetupDownload({ program: 'maa' }, { home: f.home, arch: 'x64', fetch: net.fetch }) as Record<string, any>;
  assert.equal(plan.status, 'planned');
  assert.equal(plan.fileName, 'MAA-v9.1.0-win-x64.zip'); assert.equal(plan.version, '9.1.0');
  assert.equal(plan.source, release.url); assert.equal(plan.officialPage, 'https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases');
  assert.equal(plan.size, bytes.length); assert.equal(plan.sizeKnown, true);
  assert.deepEqual(plan.checksum, { algorithm: 'sha256', value: sha256(bytes) });
  assert.match(plan.planId, /^[0-9a-f-]{36}$/); assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.steps.map((step: { id: string; executor: string }) => [step.id, step.executor]), [
    ['download', 'skill'], ['verify', 'skill'], ['extract-maa', 'skill'], ['maa-dependencies', 'user'], ['maa-first-run', 'user'], ['save-maa-directory', 'skill'], ['recheck', 'skill']]);
  assert.deepEqual(net.calls, [{ url: maaIndexUrl, method: 'GET' }], 'only the official index is read while planning');
  assert.deepEqual(await files(f.privateDirectory), []);
  const again = await planSetupDownload({ program: 'maa' }, { home: f.home, arch: 'x64', fetch: net.fetch }) as Record<string, any>;
  assert.notEqual(again.planId, plan.planId, 'every plan is a separate confirmation target');
  assert.doesNotMatch(JSON.stringify(plan), /maa-setup-download-/);
});

test('download needs the confirmation of this exact plan; refusal, missing or mismatched confirmation request nothing', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic MAA archive');
  const net = network(maaRelease('v9.1.0', bytes).routes); const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  // The user declined: the skill never calls download, so nothing is requested or written.
  assert.deepEqual(net.binaryCalls(), []);
  const missing = await downloadSetupProgram({ program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint }, context);
  assert.deepEqual(missing, { status: 'rejected', reason: 'confirmation-required' });
  const blank = await downloadSetupProgram({ program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: '  ' }, context);
  assert.equal(blank.reason, 'confirmation-required');
  const otherPlan = await downloadSetupProgram({ program: 'maa', planId: randomUUID(), fingerprint: plan.fingerprint, reference: 'Yes, download it' }, context);
  assert.equal(otherPlan.reason, 'plan-changed', 'an approval of another plan does not carry over');
  assert.deepEqual(net.binaryCalls(), []);
  assert.deepEqual(await files(f.privateDirectory), []);
});

test('a confirmed plan downloads once through official redirects, verifies size and checksum, and cannot be reused', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic MAA archive');
  const release = maaRelease('v9.1.0', bytes); const net = network(release.routes); const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  const request = { program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download MAA-v9.1.0-win-x64.zip from GitHub' };
  const done = await downloadSetupProgram(request, context) as Record<string, any>;
  assert.equal(done.status, 'downloaded'); assert.equal(done.size, bytes.length); assert.equal(done.checksumVerified, true);
  assert.deepEqual(done.next.map((step: { id: string }) => step.id), ['extract-maa', 'maa-dependencies', 'maa-first-run', 'save-maa-directory', 'recheck']);
  assert.deepEqual(await readFile(join(f.privateDirectory, 'downloads', release.name)), bytes);
  assert.deepEqual(net.binaryCalls().map(call => call.url), [release.url, release.storage]);
  assert.doesNotMatch(JSON.stringify(done), /maa-setup-download-|Download MAA/);
  const reused = await downloadSetupProgram(request, context);
  assert.deepEqual(reused, { status: 'rejected', reason: 'plan-already-used' });
  assert.equal(net.binaryCalls().length, 2, 'a used plan never requests the file again');
  const status = await setupDownloadStatus({ home: f.home });
  assert.deepEqual(status.items.map(item => [item.program, item.status, item.install]), [['maa', 'downloaded', null]]);
  const record = JSON.parse(await readFile(join(f.privateDirectory, 'downloads/records', `${plan.planId}.json`), 'utf8'));
  assert.equal(record.version, '9.1.0'); assert.equal(record.source, release.url); assert.equal(record.sha256, sha256(bytes));
  assert.equal(record.versionSource, 'github-latest-release'); assert.equal(record.officialPage, 'https://github.com/MaaAssistantArknights/MaaAssistantArknights/releases');
  assert.equal(record.confirmation.reference, request.reference);
  // Resuming re-checks the file: a verified download is not repeated.
  const resumed = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  assert.equal(resumed.status, 'already-downloaded'); assert.equal(resumed.planId, plan.planId);
  assert.equal(net.binaryCalls().length, 2);
});

test('two concurrent downloads of one confirmed plan request the file once', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic MAA archive');
  const net = network(maaRelease('v9.1.0', bytes).routes); const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  const request = { program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download it once' };
  const results = await Promise.all([downloadSetupProgram(request, context), downloadSetupProgram(request, context)]);
  assert.deepEqual(results.map(item => item.status).sort(), ['downloaded', 'rejected']);
  assert.equal(results.find(item => item.status === 'rejected')!.reason, 'plan-already-used');
  assert.equal(net.binaryCalls().filter(call => call.url.startsWith('https://github.com/')).length, 1);
});

test('a release that changed after the plan was shown is not downloaded under the old confirmation', async t => {
  const f = await fixture(t); const old = maaRelease('v9.1.0', Buffer.from('old'));
  const routes = { ...old.routes }; const net = network(routes); const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  Object.assign(routes, maaRelease('v9.2.0', Buffer.from('new')).routes);
  const result = await downloadSetupProgram({ program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download v9.1.0' }, context);
  assert.deepEqual(result, { status: 'rejected', reason: 'plan-changed' });
  assert.deepEqual(net.binaryCalls(), []); assert.deepEqual(await files(f.privateDirectory), []);
});

test('unofficial sources are refused at planning and at every redirect, and nothing is kept', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic MAA archive');
  const wrongAsset = maaRelease('v9.1.0', bytes, { browser_download_url: 'https://example.invalid/MAA-v9.1.0-win-x64.zip' });
  const refused = network(wrongAsset.routes);
  await assert.rejects(planSetupDownload({ program: 'maa' }, { home: f.home, arch: 'x64', fetch: refused.fetch }), { message: 'unofficial-source' });
  await assert.rejects(planSetupDownload({ program: 'emulator', vendor: 'ldplayer', url: 'https://ldmnq.com.example.invalid/setup.exe', version: '9.1' },
    { home: f.home, fetch: refused.fetch }), { message: 'unofficial-source' });
  await assert.rejects(planSetupDownload({ program: 'emulator', vendor: 'ldplayer', url: 'http://lddl01.ldmnq.com/setup.exe', version: '9.1' },
    { home: f.home, fetch: refused.fetch }), { message: 'unofficial-source' });
  await assert.rejects(planSetupDownload({ program: 'emulator', vendor: 'unlisted', url: 'https://lddl01.ldmnq.com/setup.exe', version: '9.1' },
    { home: f.home, fetch: refused.fetch }), { message: 'emulator-vendor-unsupported' });
  const release = maaRelease('v9.1.0', bytes);
  const hijacked = network({ ...release.routes, [release.url]: { status: 302, headers: { location: 'https://mirror.example.invalid/MAA.zip' } },
    'https://mirror.example.invalid/MAA.zip': { body: bytes } });
  const context = { home: f.home, arch: 'x64', fetch: hijacked.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  const result = await downloadSetupProgram({ program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download it' }, context);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'unofficial-source');
  assert.equal(hijacked.calls.some(call => call.url.includes('mirror.example.invalid')), false, 'the unofficial host is never contacted');
  assert.deepEqual(await files(join(f.privateDirectory, 'downloads')), ['records', `records/${plan.planId}.json`]);
  assert.deepEqual((await setupDownloadStatus({ home: f.home })).items.map(item => [item.status, item.reason]), [['failed', 'unofficial-source']]);
});

test('an official server that answers 401 or 403 refuses the script: no plan, or a failed download, as source-refused without a retry', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic MAA archive');
  const refusing = (url: string, status: number) => network({ ...maaRelease('v9.1.0', bytes).routes, [url]: { status, body: 'refused' } });
  await assert.rejects(planSetupDownload({ program: 'maa' }, { home: f.home, arch: 'x64', fetch: refusing(maaIndexUrl, 403).fetch }), { message: 'source-refused' });
  await assert.rejects(planSetupDownload({ program: 'adb' }, { home: f.home, fetch: network({ 'https://dl.google.com/android/repository/repository2-1.xml': { status: 401 } }).fetch }),
    { message: 'source-refused' });
  const node = network({ 'https://nodejs.org/dist/index.json': { body: JSON.stringify([{ version: 'v24.12.3' }]) },
    'https://nodejs.org/dist/v24.12.3/SHASUMS256.txt': { body: `${sha256('x')}  node-v24.12.3-x64.msi\n` }, 'https://nodejs.org/dist/v24.12.3/node-v24.12.3-x64.msi': { status: 403 } });
  await assert.rejects(planSetupDownload({ program: 'node' }, { home: f.home, arch: 'x64', fetch: node.fetch, nodeVersion: '22.20.0' }), { message: 'source-refused' });
  // At download time: the plan was made, then the file host refuses the download request.
  const release = maaRelease('v9.1.0', bytes); const routes = { ...release.routes }; const net = network(routes);
  const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  routes[release.storage] = { status: 403, body: 'refused' };
  const result = await downloadSetupProgram({ program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download it' }, context);
  assert.deepEqual([result.status, result.reason], ['failed', 'source-refused']);
  assert.deepEqual(net.calls.filter(call => call.url === release.storage), [{ url: release.storage, method: 'GET' }], 'one request, no retry');
  assert.deepEqual(await files(join(f.privateDirectory, 'downloads')), ['records', `records/${plan.planId}.json`]);
});

test('Node 24 plan reports an unknown size honestly and still verifies the official SHASUMS256 checksum', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic node installer');
  const file = 'node-v24.12.3-x64.msi'; const url = `https://nodejs.org/dist/v24.12.3/${file}`;
  const net = network({
    'https://nodejs.org/dist/index.json': { body: JSON.stringify([{ version: 'v25.1.0' }, { version: 'v24.12.3' }, { version: 'v24.9.0' }, { version: 'v22.20.0' }]) },
    'https://nodejs.org/dist/v24.12.3/SHASUMS256.txt': { body: `${sha256('other')}  node-v24.12.3-arm64.msi\n${sha256(bytes)}  ${file}\n` },
    [url]: { body: bytes },
  });
  const context = { home: f.home, arch: 'x64', fetch: net.fetch, nodeVersion: '22.20.0' };
  const plan = await planSetupDownload({ program: 'node' }, context) as Record<string, any>;
  assert.equal(plan.status, 'planned'); assert.equal(plan.fileName, file); assert.equal(plan.version, '24.12.3');
  assert.equal(plan.size, null); assert.equal(plan.sizeKnown, false);
  assert.deepEqual(plan.steps.map((step: { id: string; executor: string }) => [step.id, step.executor]),
    [['download', 'skill'], ['verify', 'skill'], ['run-node-installer', 'user'], ['reopen-terminal', 'user'], ['recheck', 'skill']]);
  const done = await downloadSetupProgram({ program: 'node', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download node-v24.12.3-x64.msi' }, context);
  assert.equal(done.status, 'downloaded');
  const install = await installSetupDownload({ planId: plan.planId }, { home: f.home }) as Record<string, any>;
  assert.equal(install.status, 'user-steps');
  assert.deepEqual(install.steps.map((step: { executor: string }) => step.executor), ['user', 'user', 'skill']);
  assert.equal((await planSetupDownload({ program: 'node' }, { ...context, nodeVersion: '24.12.3' }) as Record<string, any>).status, 'not-needed');
  const corrupt = network({
    'https://nodejs.org/dist/index.json': { body: JSON.stringify([{ version: 'v24.12.4' }]) },
    'https://nodejs.org/dist/v24.12.4/SHASUMS256.txt': { body: `${sha256('expected')}  node-v24.12.4-x64.msi\n` },
    'https://nodejs.org/dist/v24.12.4/node-v24.12.4-x64.msi': { body: 'tampered' } });
  const corruptContext = { ...context, fetch: corrupt.fetch };
  const second = await planSetupDownload({ program: 'node' }, corruptContext) as Record<string, any>;
  const rejected = await downloadSetupProgram({ program: 'node', planId: second.planId, fingerprint: second.fingerprint, reference: 'Download it' }, corruptContext);
  assert.deepEqual([rejected.status, rejected.reason], ['failed', 'checksum-mismatch']);
  assert.equal((await files(join(f.privateDirectory, 'downloads'))).includes('node-v24.12.4-x64.msi'), false);
});

test('an interrupted download is not marked downloaded, and a resume re-checks state and needs a new confirmation', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic MAA archive with more bytes');
  const release = maaRelease('v9.1.0', bytes);
  const routes = { ...release.routes, [release.storage]: { body: bytes, failAfter: 5 } };
  const net = network(routes); const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  const request = { program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download it' };
  const result = await downloadSetupProgram(request, context);
  assert.deepEqual([result.status, result.reason], ['failed', 'download-interrupted']);
  assert.deepEqual(await files(join(f.privateDirectory, 'downloads')), ['records', `records/${plan.planId}.json`], 'the partial file is removed');
  assert.equal((await installSetupDownload({ planId: plan.planId, target: join(f.root, 'new-maa') }, { home: f.home })).reason, 'download-not-verified');
  assert.equal((await downloadSetupProgram(request, context)).reason, 'plan-already-used');
  // A process that died mid-download leaves an unfinished record; status reports it as interrupted, never downloaded.
  const crashed = randomUUID();
  await writeFile(join(f.privateDirectory, 'downloads/records', `${crashed}.json`), JSON.stringify({ schemaVersion: 1, planId: crashed, program: 'maa', vendor: null,
    fileName: release.name, version: '9.1.0', source: release.url, size: bytes.length, checksum: null, confirmation: { reference: 'synthetic', termsAccepted: false },
    status: 'downloading', pid: 2147483646, startedAt: new Date().toISOString() }));
  await writeFile(join(f.privateDirectory, 'downloads', `.${crashed}.partial`), 'partial');
  const status = await setupDownloadStatus({ home: f.home });
  assert.deepEqual(status.items.map(item => item.status).sort(), ['failed', 'interrupted']);
  routes[release.storage] = { body: bytes };
  const fresh = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  assert.equal(fresh.status, 'planned', 'nothing verified exists, so a new plan is shown for a new confirmation');
  assert.equal((await downloadSetupProgram({ ...request, planId: fresh.planId, fingerprint: fresh.fingerprint }, context)).status, 'downloaded');
  assert.equal((await files(join(f.privateDirectory, 'downloads'))).includes(`.${crashed}.partial`), false, 'the partial file of a dead download is reclaimed');
  assert.deepEqual((await setupDownloadStatus({ home: f.home })).items.map(item => item.status).sort(), ['downloaded', 'failed', 'interrupted']);
});

test('adb download needs the user\'s own acceptance of the Android SDK license and checks the official SHA-1', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic platform tools');
  const xml = `<?xml version="1.0"?><sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/01">
<remotePackage path="platform-tools"><revision><major>99</major><minor>0</minor><micro>3</micro></revision><uses-license ref="android-sdk-preview-license"/><channelRef ref="channel-2"/>
<archives><archive><complete><size>1</size><checksum>${'1'.repeat(40)}</checksum><url>platform-tools_r99.0.3-win.zip</url></complete><host-os>windows</host-os></archive></archives></remotePackage>
<remotePackage path="platform-tools"><revision><major>98</major><minor>0</minor><micro>1</micro></revision><uses-license ref="android-sdk-license"/><channelRef ref="channel-0"/>
<archives><archive><complete><size>5</size><checksum>${'2'.repeat(40)}</checksum><url>platform-tools_r98.0.1-linux.zip</url></complete><host-os>linux</host-os></archive>
<archive><complete><size>${bytes.length}</size><checksum>${sha1(bytes)}</checksum><url>platform-tools_r98.0.1-win.zip</url></complete><host-os>windows</host-os></archive></archives></remotePackage>
</sdk:sdk-repository>`;
  const url = 'https://dl.google.com/android/repository/platform-tools_r98.0.1-win.zip';
  const net = network({ 'https://dl.google.com/android/repository/repository2-1.xml': { body: xml }, [url]: { body: bytes } });
  const context = { home: f.home, fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'adb' }, context) as Record<string, any>;
  assert.deepEqual([plan.fileName, plan.version, plan.size, plan.source], ['platform-tools_r98.0.1-win.zip', '98.0.1', bytes.length, url]);
  assert.deepEqual(plan.terms, { url: 'https://developer.android.com/studio/terms', acceptanceRequired: true });
  assert.deepEqual(plan.steps[0], { id: 'accept-terms', executor: 'user', description: plan.steps[0].description });
  const request = { program: 'adb', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download platform tools' };
  assert.deepEqual(await downloadSetupProgram(request, context), { status: 'rejected', reason: 'terms-acceptance-required' });
  assert.deepEqual(net.binaryCalls(), []);
  assert.equal((await downloadSetupProgram({ ...request, termsAccepted: true }, context)).status, 'downloaded');
});

test('emulator plans accept only the vendor\'s official domain and report an unknown size when the server gives none', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic emulator installer');
  const link = 'https://www.ldmnq.com/download/synthetic';
  const net = network({ [link]: { status: 302, headers: { location: 'https://lddl01.ldmnq.com/downloader/ldplayer-synthetic.exe' } },
    'https://lddl01.ldmnq.com/downloader/ldplayer-synthetic.exe': { body: bytes } });
  const context = { home: f.home, fetch: net.fetch };
  await assert.rejects(planSetupDownload({ program: 'emulator', vendor: 'ldplayer', url: link }, context), { message: 'version-required' });
  const plan = await planSetupDownload({ program: 'emulator', vendor: 'ldplayer', url: link, version: '9.1.40' }, context) as Record<string, any>;
  assert.deepEqual([plan.fileName, plan.version, plan.versionSource, plan.size, plan.sizeKnown, plan.checksum, plan.officialPage],
    ['ldplayer-synthetic.exe', '9.1.40', 'official-page-stated', null, false, null, 'https://www.ldmnq.com/']);
  assert.equal(plan.steps.filter((step: { executor: string }) => step.executor === 'user').length, 3);
  assert.match(plan.steps.find((step: { id: string }) => step.id === 'game-client').description, /never enters a game account or operates the device/);
  const done = await downloadSetupProgram({ program: 'emulator', vendor: 'ldplayer', url: link, version: '9.1.40', planId: plan.planId, fingerprint: plan.fingerprint,
    reference: 'Download the LDPlayer installer' }, context);
  assert.equal(done.status, 'downloaded'); assert.equal(done.checksumVerified, false);
  assert.deepEqual((done.next as { id: string }[]).map(step => step.id), ['run-emulator-installer', 'emulator-first-run', 'game-client', 'connect-adb', 'recheck']);
  assert.equal((await installSetupDownload({ planId: plan.planId }, { home: f.home })).status, 'user-steps');
  // Only when the official address carries no installer name does the server's Content-Disposition name it.
  const unnamed = network({ 'https://lddl01.ldmnq.com/get?id=1': { headers: { 'content-disposition': 'attachment; filename="ldplayer-named.exe"' } } });
  const named = await planSetupDownload({ program: 'emulator', vendor: 'ldplayer', url: 'https://lddl01.ldmnq.com/get?id=1', version: '9.1.40' }, { home: f.home, fetch: unnamed.fetch }) as Record<string, any>;
  assert.equal(named.fileName, 'ldplayer-named.exe');
});

test('MuMu downloads follow its official download API to the official file host only; other NetEase hosts are refused', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic MuMu installer');
  const api = 'https://mumu.nie.netease.com/api/dl/win';
  const fileHost = 'https://a11.gdl.netease.com/MuMu_9.0.1_apinochannel_zh-Hans_1794.exe';
  // Like the real servers: every API call issues a fresh `n=` and signature, and the file host answers every
  // request with a different Content-Disposition name. Only the file path stays the same.
  let issued = 0; const requests: { url: string; method: string }[] = [];
  const fetch: Fetcher = async (url, init) => {
    const method = init.method ?? 'GET'; requests.push({ url, method }); assert.equal(init.redirect, 'manual');
    issued++;
    if (url === api) return new Response(null, { status: 302, headers: { location: `${fileHost}?n=MuMu_9.0.1_${issued}rnd.exe&key1=k${issued}&key2=k${issued}` } });
    if (url.split('?')[0] === fileHost) return new Response(method === 'HEAD' ? null : new Uint8Array(bytes),
      { status: 200, headers: { 'content-length': String(bytes.length), 'content-disposition': `attachment; filename="MuMu_9.0.1_${issued}cd.exe"` } });
    throw new TypeError('synthetic network: unlisted address');
  };
  const context = { home: f.home, fetch };
  const fromBrowserList = `${fileHost}?n=MuMu_9.0.1_0rnd.exe&key1=k0&key2=k0`;
  for (const start of [api, fromBrowserList]) {
    const plan = await planSetupDownload({ program: 'emulator', vendor: 'mumu', url: start, version: '9.0.1' }, context) as Record<string, any>;
    assert.deepEqual([plan.status, plan.fileName, plan.size, plan.officialPage], ['planned', 'MuMu_9.0.1_apinochannel_zh-Hans_1794.exe', bytes.length, 'https://mumu.163.com/']);
    const done = await downloadSetupProgram({ program: 'emulator', vendor: 'mumu', url: start, version: '9.0.1', planId: plan.planId, fingerprint: plan.fingerprint,
      reference: 'Download the MuMu installer' }, context);
    assert.equal(done.status, 'downloaded', `one confirmation is enough when starting from ${start}`);
    assert.equal(done.fileName, 'MuMu_9.0.1_apinochannel_zh-Hans_1794.exe');
    assert.equal(await readFile(join(f.privateDirectory, 'downloads', done.fileName as string), 'utf8'), bytes.toString());
  }
  assert.equal(requests.filter(call => call.method === 'GET' && call.url.startsWith(fileHost)).length, 2);
  const elsewhere = network({ [api]: { status: 302, headers: { location: 'https://cdn.netease.com/MuMu_9.0.1.exe' } }, 'https://cdn.netease.com/MuMu_9.0.1.exe': { body: bytes } });
  await assert.rejects(planSetupDownload({ program: 'emulator', vendor: 'mumu', url: api, version: '9.0.1' }, { home: f.home, fetch: elsewhere.fetch }), { message: 'unofficial-source' });
  assert.equal(elsewhere.calls.some(call => call.url.includes('cdn.netease.com')), false);
  for (const url of ['https://adl.netease.com/d/g/a11/c/gw_win', 'https://x.a11.gdl.netease.com/MuMu.exe', 'https://mumu.nie.netease.com.example.invalid/api/dl/win']) {
    await assert.rejects(planSetupDownload({ program: 'emulator', vendor: 'mumu', url, version: '9.0.1' }, context), { message: 'unofficial-source' }, url);
  }
  await assert.rejects(planSetupDownload({ program: 'emulator', vendor: 'ldplayer', url: api, version: '9.0.1' }, context), { message: 'unofficial-source' },
    'a host allowed for one vendor is not allowed for another');
});

test('MAA extraction is the skill\'s only install step, never marks MAA installed, and is not repeated on resume', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const archive = storedZip([{ name: 'MAA.exe', data: 'synthetic executable' }, { name: 'DependencySetup_依赖库安装.bat', data: 'rem synthetic' }]);
  const release = maaRelease('v9.1.0', archive); const net = network(release.routes); const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  assert.equal((await downloadSetupProgram({ program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download it' }, context)).status, 'downloaded');
  const target = join(f.root, 'MAA');
  assert.equal((await installSetupDownload({ planId: plan.planId, target: f.privateDirectory }, { home: f.home })).reason, 'target-overlaps-private-directory');
  await mkdir(join(f.root, 'occupied')); await writeFile(join(f.root, 'occupied/keep.txt'), 'existing');
  assert.equal((await installSetupDownload({ planId: plan.planId, target: join(f.root, 'occupied') }, { home: f.home })).reason, 'target-not-empty');
  assert.equal(await readFile(join(f.root, 'occupied/keep.txt'), 'utf8'), 'existing');
  const extracted = await installSetupDownload({ planId: plan.planId, target }, { home: f.home }) as Record<string, any>;
  assert.equal(extracted.status, 'extracted');
  assert.deepEqual(extracted.steps.map((step: { id: string; executor: string }) => [step.id, step.executor]),
    [['maa-dependencies', 'user'], ['maa-first-run', 'user'], ['save-maa-directory', 'skill'], ['recheck', 'skill']]);
  assert.equal(await readFile(join(target, 'MAA.exe'), 'utf8'), 'synthetic executable');
  assert.doesNotMatch(JSON.stringify(extracted), /maa-setup-download-/);
  const settings = JSON.parse(await readFile(join(f.home, 'config.json'), 'utf8'));
  assert.equal(settings.maaDirectory ?? null, null, 'settings are written only through the preferences script');
  const again = await installSetupDownload({ planId: plan.planId, target: join(f.root, 'elsewhere') }, { home: f.home });
  assert.equal(again.status, 'already-extracted');
  assert.deepEqual(await files(join(f.root, 'elsewhere')), []);
  assert.deepEqual((await setupDownloadStatus({ home: f.home })).items.map(item => [item.status, item.install]), [['downloaded', 'extracted']]);
  await updateSettings({ maaDirectory: target }, f.home);
  const recheck = await recheckSetup({}, { home: f.home }, async () => null) as Record<string, any>;
  assert.equal(recheck.complete, false, 'MAA without its first-run configuration is not installed');
  assert.equal(recheck.checks.find((item: { id: string }) => item.id === 'maa').reason, 'maa-configuration-unreadable');
  assert.equal((await planSetupDownload({ program: 'maa' }, context) as Record<string, any>).status, 'not-needed');
});

test('an archive that tries to escape its folder or fails to extract leaves the chosen folder empty', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const archive = storedZip([{ name: '../escape.txt', data: 'escaped' }, { name: 'MAA.exe', data: 'synthetic executable' }]);
  const net = network(maaRelease('v9.1.0', archive).routes); const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  await downloadSetupProgram({ program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download it' }, context);
  const target = join(f.root, 'inner', 'MAA');
  const result = await installSetupDownload({ planId: plan.planId, target }, { home: f.home });
  assert.deepEqual([result.status, result.reason], ['failed', 'extract-failed']);
  assert.deepEqual(await files(join(f.root, 'inner')), []);
  assert.deepEqual((await setupDownloadStatus({ home: f.home })).items.map(item => item.install), ['failed']);
});

test('a chosen folder path that Windows would read as another folder is refused, and the folder it would mean stays as it was', async t => {
  // Node checks and creates the folder through the extended-length form, which keeps a trailing dot or space; Windows
  // drops them, so `MAA ` or `games.\MAA` would be checked as one folder and written as the user's existing `MAA`.
  const f = await fixture(t);
  const net = network(maaRelease('v9.1.0', storedZip([{ name: 'MAA.exe', data: 'synthetic executable' }])).routes); const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  await downloadSetupProgram({ program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download it' }, context);
  const chosen = join(f.root, 'chosen');
  await mkdir(join(chosen, 'games', 'MAA'), { recursive: true }); await writeFile(join(chosen, 'games', 'MAA', 'keep.txt'), 'existing');
  assert.equal((await installSetupDownload({ planId: plan.planId, target: join(chosen, 'games', 'MAA') }, { home: f.home })).reason, 'target-not-empty');
  for (const target of ['games\\MAA ', 'games\\MAA.', 'games\\MAA. .', 'games.\\MAA', 'games \\MAA', 'games..\\MAA', 'games\\MAA\\NUL', 'games\\MAA\\com1.txt',
    'games\\MAA:stream', 'games\\M<A>', 'games\\MA\tA', `games\\MA${'\ud800'}A`]) {
    const result = await installSetupDownload({ planId: plan.planId, target: join(chosen, target) }, { home: f.home });
    assert.deepEqual([result.status, result.reason], ['rejected', 'target-path-invalid'], JSON.stringify(target));
  }
  assert.deepEqual(await files(chosen), ['games', 'games/MAA', 'games/MAA/keep.txt'], 'no folder created and nothing written');
  assert.equal(await readFile(join(chosen, 'games', 'MAA', 'keep.txt'), 'utf8'), 'existing');
  assert.deepEqual((await setupDownloadStatus({ home: f.home })).items.map(item => item.install), [null], 'a refused target is not an install attempt');
});

/** The real Windows extraction boundary on a synthetic zip: `parent` holds only `target`, so anything else in it escaped. */
async function extraction(t: { after: (fn: () => Promise<unknown>) => void }, folder = 'target') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maa-setup-extract-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, 'parent'); const target = join(parent, folder); const archive = join(root, 'archive.zip');
  await mkdir(target, { recursive: true });
  const extract = async (entries: Parameters<typeof storedZip>[0]) => { await writeFile(archive, storedZip(entries)); return systemArchive.extract(archive, target); };
  return { parent, target, extract };
}

test('the Windows extraction boundary keeps UTF-8 entry names and bytes exactly, whatever the ANSI code page', { skip: process.platform !== 'win32' }, async t => {
  // No single legacy ANSI code page holds simplified Chinese, Hangul, an accented letter and an emoji together, so an
  // extractor that converts names to the process code page fails here on every Windows whose code page is not UTF-8.
  // The chosen folder's own name is not ASCII either.
  const x = await extraction(t, '明日方舟 MAA');
  const binary = Buffer.from(Array.from({ length: 1024 }, (_, index) => (index * 7) % 256));
  const entries = [{ name: 'MAA.exe', data: binary, deflate: true }, { name: 'DependencySetup_依赖库安装.bat', data: 'rem synthetic' },
    { name: 'resource/', data: '' }, { name: 'resource/한국어/données 😀.json', data: '{"stage":"1-7"}', deflate: true }];
  assert.deepEqual(await x.extract(entries), { exitCode: 0, timedOut: false });
  assert.deepEqual(await files(x.target), ['DependencySetup_依赖库安装.bat', 'MAA.exe', 'resource', 'resource/한국어', 'resource/한국어/données 😀.json']);
  for (const entry of entries.filter(item => !item.name.endsWith('/'))) {
    assert.deepEqual(await readFile(join(x.target, entry.name)), Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data), entry.name);
  }
  assert.deepEqual(await files(x.parent), (await files(x.target)).map(item => `明日方舟 MAA/${item}`).concat('明日方舟 MAA').sort());
});

test('the Windows extraction boundary writes paths longer than 260 characters, as tar.exe did', { skip: process.platform !== 'win32' }, async t => {
  const x = await extraction(t, 'm'.repeat(120));
  const name = `resource/${'r'.repeat(150)}.json`;
  assert.ok(join(x.target, name).length > 260);
  assert.deepEqual(await x.extract([{ name: 'MAA.exe', data: 'synthetic executable' }, { name, data: 'long', deflate: true }]), { exitCode: 0, timedOut: false });
  assert.equal(await readFile(join(x.target, name), 'utf8'), 'long');
});

test('the Windows extraction boundary refuses unsafe entry names before writing anything', { skip: process.platform !== 'win32' }, async t => {
  const cases: [string, (parent: string) => string | Buffer][] = [
    ['parent segment', () => '../outside.txt'], ['parent segment after a folder', () => 'sub\\..\\..\\outside.txt'],
    ['absolute path with a drive letter', parent => join(parent, 'outside.txt')], ['extended-length prefix', parent => `\\\\?\\${join(parent, 'outside.txt')}`],
    ['rooted path', () => '/outside.txt'], ['alternate data stream', () => 'a:b'], ['device name', () => 'resource/NUL.txt'],
    ['trailing dot', () => 'MAA.exe.'], ['name that is not UTF-8', () => Buffer.from([0x44, 0xd2, 0xc0, 0x2e, 0x62, 0x61, 0x74])],
    ['duplicate name differing only in case', () => 'maa.EXE'], ['file used as a folder', () => 'MAA.exe/inner.txt'],
  ];
  for (const [label, name] of cases) {
    await t.test(label, async t => {
      const x = await extraction(t);
      const result = await x.extract([{ name: 'MAA.exe', data: 'synthetic executable' }, { name: name(x.parent), data: 'escaped' }]);
      assert.equal(result.exitCode, 2, 'refused by the entry-name check');
      assert.deepEqual(await files(x.parent), ['target'], 'nothing written, inside or outside the target');
    });
  }
});

test('the Windows extraction boundary never overwrites an existing file and never follows a reparse point', { skip: process.platform !== 'win32' }, async t => {
  const x = await extraction(t);
  await writeFile(join(x.target, 'MAA.exe'), 'existing');
  assert.notEqual((await x.extract([{ name: 'MAA.exe', data: 'replacement' }])).exitCode, 0);
  assert.equal(await readFile(join(x.target, 'MAA.exe'), 'utf8'), 'existing');
  const y = await extraction(t);
  const outside = join(y.parent, 'outside'); await mkdir(outside);
  await symlink(outside, join(y.target, 'link'), 'junction');
  assert.equal((await y.extract([{ name: 'link/sub/escaped.txt', data: 'escaped' }])).exitCode, 2, 'refused at the reparse point');
  assert.deepEqual(await files(outside), [], 'nothing created through the junction');
});

test('the Windows extraction boundary refuses a target that Windows reads as another folder', { skip: process.platform !== 'win32' }, async t => {
  // Both folders exist: the literal one Node created through the extended-length form, and the user's own one that the
  // ordinary path names once Windows drops a trailing dot or space.
  const cases: [string, string, string][] = [['trailing space', 'MAA ', 'MAA'], ['trailing dot', 'MAA.', 'MAA'], ['folder on the way ending in a dot', 'games.\\MAA', 'games\\MAA']];
  for (const [label, folder, own] of cases) {
    await t.test(label, async t => {
      const x = await extraction(t, folder);
      await mkdir(join(x.parent, own), { recursive: true }); await writeFile(join(x.parent, own, 'keep.txt'), 'existing');
      assert.equal((await x.extract([{ name: 'MAA.exe', data: 'synthetic executable' }])).exitCode, 3, 'refused as a target path that is not plain');
      assert.deepEqual(await files(join(x.parent, own)), ['keep.txt'], 'the user\'s folder is unchanged');
      assert.deepEqual(await files(x.target), [], 'nothing written into the literal folder either');
    });
  }
});

test('the Windows extraction boundary fails, writing nothing, when the archive\'s entry list cannot be read or is empty', { skip: process.platform !== 'win32' }, async t => {
  const cases: [string, Parameters<typeof storedZip>[0]][] = [
    ['entry name with a character .NET refuses in a path', [{ name: 'MAA.exe', data: 'synthetic executable' }, { name: 'a|b', data: 'other' }]],
    ['GBK name without the UTF-8 flag', [{ name: 'MAA.exe', data: 'synthetic executable', utf8: false }, { name: Buffer.from([0x44, 0xd2, 0xc0, 0x2e, 0x62, 0x61, 0x74]), data: 'rem', utf8: false }]],
    ['archive with no entries', []],
  ];
  for (const [label, entries] of cases) {
    await t.test(label, async t => {
      const x = await extraction(t);
      assert.notEqual((await x.extract(entries)).exitCode, 0);
      assert.deepEqual(await files(x.parent), ['target'], 'nothing written, inside or outside the target');
    });
  }
});

test('a downloaded file changed on disk is reported invalid and is never extracted', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic MAA archive');
  const release = maaRelease('v9.1.0', bytes); const net = network(release.routes); const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  await downloadSetupProgram({ program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download it' }, context);
  await writeFile(join(f.privateDirectory, 'downloads', release.name), 'replaced');
  assert.deepEqual((await setupDownloadStatus({ home: f.home })).items.map(item => item.status), ['download-invalid']);
  let extracted = 0;
  const result = await installSetupDownload({ planId: plan.planId, target: join(f.root, 'MAA') }, { home: f.home, archive: { extract: async () => { extracted++; return { exitCode: 0 }; } } });
  assert.equal(result.reason, 'download-not-verified'); assert.equal(extracted, 0);
  assert.equal((await planSetupDownload({ program: 'maa' }, context) as Record<string, any>).status, 'planned');
});

test('an extraction that hits the time limit is reported as such and leaves the chosen folder as it was', async t => {
  const f = await fixture(t); const bytes = Buffer.from('synthetic MAA archive');
  const net = network(maaRelease('v9.1.0', bytes).routes); const context = { home: f.home, arch: 'x64', fetch: net.fetch };
  const plan = await planSetupDownload({ program: 'maa' }, context) as Record<string, any>;
  await downloadSetupProgram({ program: 'maa', planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download it' }, context);
  const target = join(f.root, 'MAA');
  const slow = { extract: async (_archive: string, into: string) => { await writeFile(join(into, 'MAA.exe'), 'partly extracted'); return { exitCode: 1, timedOut: true }; } };
  const result = await installSetupDownload({ planId: plan.planId, target }, { home: f.home, archive: slow });
  assert.deepEqual([result.status, result.reason], ['failed', 'extract-timeout']);
  await assert.rejects(readdir(target), { code: 'ENOENT' });
  assert.deepEqual((await setupDownloadStatus({ home: f.home })).items.map(item => item.install), ['failed']);
});

test('a record whose file name points outside the downloads folder is ignored and never extracted', async t => {
  const f = await fixture(t); const outside = Buffer.from('file outside the downloads folder');
  await writeFile(join(f.root, 'outside.zip'), outside);
  const planId = randomUUID(); await mkdir(join(f.privateDirectory, 'downloads/records'), { recursive: true });
  await writeFile(join(f.privateDirectory, 'downloads/records', `${planId}.json`), JSON.stringify({ schemaVersion: 1, planId, program: 'maa', vendor: null,
    fileName: '../../outside.zip', version: '9.1.0', source: 'https://github.com/synthetic', size: outside.length, checksum: null,
    confirmation: { reference: 'synthetic', termsAccepted: false }, status: 'downloaded', pid: process.pid, startedAt: new Date().toISOString(), bytes: outside.length, sha256: sha256(outside) }));
  assert.deepEqual((await setupDownloadStatus({ home: f.home })).items, []);
  let extracted = 0;
  const result = await installSetupDownload({ planId, target: join(f.root, 'MAA') }, { home: f.home, archive: { extract: async () => { extracted++; return { exitCode: 0 }; } } });
  assert.deepEqual([result.status, result.reason, extracted], ['rejected', 'download-unknown', 0]);
});

test('final recheck covers Node, MAA, adb and the connection, finds the chosen candidate afresh after the connection is saved, and updates the environment record', async t => {
  const f = await fixture(t, { maa: true });
  const configFile = join(f.maaDirectory, 'config/gui.new.json');
  // MAA writes `Timers` in its own configuration; the writers' read (doctor's `configuration` check) requires it.
  const config = { Current: 'Synthetic profile', Configurations: { 'Synthetic profile': { Gui: {
    ConnectSettings: { AdbPath: '', Address: '', AddressHistory: [], AutoDetect: true, AlwaysAutoDetect: false }, RuntimeSettings: { ClientType: 'Official' } } } }, Timers: { List: [] } };
  await writeFile(configFile, JSON.stringify(config));
  const adbPath = join(f.maaDirectory, 'adb/platform-tools/adb.exe'); await mkdir(join(f.maaDirectory, 'adb/platform-tools'), { recursive: true }); await writeFile(adbPath, 'synthetic adb');
  const calls: string[][] = [];
  const adb: AdbBoundary = { run: async (_file, args) => { calls.push(args); return { exitCode: 0, stdout: args[0] === 'devices' ? 'List of devices attached\n127.0.0.1:16384\tdevice\n' : args.at(-1) === 'get-state' ? 'device\n' : 'connected' }; } };
  const context = { home: f.home, adbPaths: [adbPath] };
  const step4 = await discoverSetupConnections(context, adb);
  const chosen = step4.candidates[0]!.id;
  const untested = await recheckSetup({}, context, async () => null, adb) as Record<string, any>;
  assert.deepEqual([untested.complete, untested.connection.status, untested.connection.candidates, untested.exitCode], [false, 'selection-required', 1, 1]);
  assert.ok(untested.pending.includes('connection'));
  assert.equal(calls.every(args => args[0] === 'devices'), true, 'no connection is opened without a chosen candidate');
  const recorded = JSON.parse(await readFile(join(f.privateDirectory, 'setup-environment.json'), 'utf8'));
  assert.equal(recorded.complete, false); assert.deepEqual(recorded.downloads, []);
  // Step 5 apply rewrites the connection fields (and MAA may rewrite its configuration on start): the old discovery revision is stale.
  const applied = JSON.parse(await readFile(configFile, 'utf8'));
  Object.assign(applied.Configurations['Synthetic profile'].Gui.ConnectSettings, { AdbPath: 'adb/platform-tools/adb.exe', Address: '127.0.0.1:16384', AutoDetect: false, AlwaysAutoDetect: false });
  applied.Configurations['Synthetic profile'].Gui.RuntimeSettings.LastStart = 'synthetic value written by MAA';
  await writeFile(configFile, JSON.stringify(applied));
  assert.notEqual((await discoverSetupConnections(context, adb)).discoveryRevision, step4.discoveryRevision);
  const tested = await recheckSetup({ candidate: chosen }, context, async () => null, adb) as Record<string, any>;
  assert.equal(tested.connection.status, 'connected');
  assert.deepEqual(calls.slice(-2), [['connect', '127.0.0.1:16384'], ['-s', '127.0.0.1:16384', 'get-state']]);
  assert.deepEqual(tested.checks.map((item: { id: string }) => item.id), ['platform', 'maa', 'server', 'node', 'settings', 'private-directory', 'version',
    'credential-nga', 'credential-skland', 'credential-bilibili', 'configuration', 'write-lock']);
  assert.deepEqual(tested.checks.filter((item: { id: string }) => ['configuration', 'write-lock'].includes(item.id)).map((item: { status: string }) => item.status), ['normal', 'normal']);
  // On a non-Windows test machine the platform check is an error; the recheck command itself refuses to run there, so it is reported, not
  // pending. The exit code still means "there is an error".
  const windows = process.platform === 'win32';
  assert.deepEqual([tested.complete, tested.exitCode, tested.pending, tested.notBlocking], [true, windows ? 0 : 1, [], windows ? [] : ['platform']]);
  const saved = JSON.parse(await readFile(join(f.privateDirectory, 'setup-environment.json'), 'utf8'));
  assert.equal(saved.connection.status, 'connected'); assert.equal(saved.complete, tested.complete);
  assert.doesNotMatch(JSON.stringify(saved) + JSON.stringify(tested), /127\.0\.0\.1|maa-setup-download-|Synthetic profile/);
  const failing: AdbBoundary = { run: async (_file, args) => ({ exitCode: 0, stdout: args[0] === 'devices' ? 'List of devices attached\n127.0.0.1:16384\tdevice\n' : 'offline' }) };
  const failed = await recheckSetup({ candidate: chosen }, context, async () => null, failing) as Record<string, any>;
  assert.deepEqual([failed.complete, failed.connection.status, failed.pending, failed.exitCode], [false, 'failed', ['connection'], 1]);
  assert.equal(JSON.parse(await readFile(join(f.privateDirectory, 'setup-environment.json'), 'utf8')).complete, false);
});

test('recheck reports a chosen candidate that no longer exists instead of a generic failure, and opens no connection', async t => {
  const f = await fixture(t, { maa: true });
  await writeFile(join(f.maaDirectory, 'config/gui.new.json'), JSON.stringify({ Current: 'P', Configurations: { P: { Gui: {
    ConnectSettings: { AdbPath: '', Address: '', AddressHistory: [], AutoDetect: true, AlwaysAutoDetect: false }, RuntimeSettings: { ClientType: 'Official' } } } }, Timers: { List: [] } }));
  const adbPath = join(f.root, 'tools/adb.exe'); await mkdir(join(f.root, 'tools')); await writeFile(adbPath, 'synthetic adb');
  const calls: string[][] = [];
  let devices = 'List of devices attached\n127.0.0.1:16384\tdevice\n';
  const adb: AdbBoundary = { run: async (_file, args) => { calls.push(args); return { exitCode: 0, stdout: args[0] === 'devices' ? devices : 'device\n' }; } };
  const context = { home: f.home, adbPaths: [adbPath] };
  const chosen = (await discoverSetupConnections(context, adb)).candidates[0]!.id;
  devices = 'List of devices attached\n127.0.0.1:5555\tdevice\n';
  const result = await recheckSetup({ candidate: chosen }, context, async () => null, adb) as Record<string, any>;
  assert.deepEqual([result.connection.status, result.connection.reason, result.complete], ['candidate-unavailable', 'chosen-candidate-not-found', false]);
  assert.equal(result.connection.candidates, 1);
  assert.equal(calls.every(args => args[0] === 'devices'), true);
  assert.ok(result.pending.includes('connection'));
  assert.equal(JSON.parse(await readFile(join(f.privateDirectory, 'setup-environment.json'), 'utf8')).connection.status, 'candidate-unavailable');
  await assert.rejects(recheckSetup({ discoveryRevision: 'stale', candidate: chosen } as never, context, async () => null, adb), { message: 'request-invalid' });
});

test('recheck completes despite an unreadable NGA credential, which it still reports; an installation error keeps setup pending', async t => {
  const f = await fixture(t, { maa: true });
  const configFile = join(f.maaDirectory, 'config/gui.new.json');
  const gui = (client: string) => JSON.stringify({ Current: 'P', Configurations: { P: { Gui: {
    ConnectSettings: { AdbPath: '', Address: '', AddressHistory: [], AutoDetect: true, AlwaysAutoDetect: false }, RuntimeSettings: { ClientType: client } } } }, Timers: { List: [] } });
  await writeFile(configFile, gui('Official'));
  const adbPath = join(f.root, 'tools/adb.exe'); await mkdir(join(f.root, 'tools')); await writeFile(adbPath, 'synthetic adb');
  const adb: AdbBoundary = { run: async (_file, args) => ({ exitCode: 0, stdout: args[0] === 'devices' ? 'List of devices attached\n127.0.0.1:16384\tdevice\n' : 'device\n' }) };
  const context = { home: f.home, adbPaths: [adbPath] };
  const chosen = (await discoverSetupConnections(context, adb)).candidates[0]!.id;
  // Another feature's state: a damaged NGA credential record in the private directory.
  await mkdir(join(f.privateDirectory, 'credentials')); await writeFile(join(f.privateDirectory, 'credentials/nga.json'), '{"damaged":true}');
  const reported = [...(process.platform === 'win32' ? [] : ['platform']), 'credential-nga'];
  const result = await recheckSetup({ candidate: chosen }, context, async () => null, adb) as Record<string, any>;
  assert.equal(result.checks.find((item: { id: string }) => item.id === 'credential-nga').status, 'error');
  // Complete, yet the exit code keeps meaning "there is an error" (spec 「检查与修法」); the model reads `complete`.
  assert.deepEqual([result.connection.status, result.complete, result.exitCode, result.pending, result.notBlocking], ['connected', true, 1, [], reported]);
  const saved = JSON.parse(await readFile(join(f.privateDirectory, 'setup-environment.json'), 'utf8'));
  assert.deepEqual([saved.complete, saved.notBlocking], [true, reported]);
  // An installation error setup is responsible for still blocks: a client outside the CN scope, and the connection is then not checked.
  await writeFile(configFile, gui('YoStarEN'));
  const blocked = await recheckSetup({ candidate: chosen }, context, async () => null, adb) as Record<string, any>;
  assert.deepEqual([blocked.complete, blocked.exitCode, blocked.pending, blocked.notBlocking, blocked.connection.status], [false, 1, ['server', 'connection'], reported, 'not-checked']);
});

/** The connection is already written (by setup apply) and the chosen candidate tests connected; only the configuration write lock varies. */
async function writeLockFixture(t: { after: (fn: () => Promise<unknown>) => void }, lock?: string) {
  const f = await fixture(t, { maa: true });
  const adbPath = join(f.root, 'tools/adb.exe'); await mkdir(join(f.root, 'tools')); await writeFile(adbPath, 'synthetic adb');
  await writeFile(join(f.maaDirectory, 'config/gui.new.json'), JSON.stringify({ Current: 'P', Configurations: { P: { Gui: {
    ConnectSettings: { AdbPath: adbPath, Address: '127.0.0.1:16384', AddressHistory: [], AutoDetect: false, AlwaysAutoDetect: false }, RuntimeSettings: { ClientType: 'Official' } } } },
    Timers: { List: [] } }));
  if (lock !== undefined) await writeFile(join(f.maaDirectory, 'config/.maa-skills.lock'), lock);
  const adb: AdbBoundary = { run: async (_file, args) => ({ exitCode: 0, stdout: args[0] === 'devices' ? 'List of devices attached\n127.0.0.1:16384\tdevice\n' : 'device\n' }) };
  const context = { home: f.home, adbPaths: [adbPath] };
  const chosen = (await discoverSetupConnections(context, adb)).candidates[0]!.id;
  // MAA process boundary: read-only inspection; the recheck never closes or starts MAA.
  const maa: MaaProcess = { inspect: async () => ({ running: false, treeExited: true, idle: true, ready: false }),
    close: async () => { throw new Error('unexpected close'); }, start: async () => { throw new Error('unexpected start'); } };
  return { ...f, adb, context, chosen, maa };
}
const lockFile = (pid: number) => JSON.stringify({ id: randomUUID(), skill: 'maa-setup', host: 'claude', pid, startedAt: new Date().toISOString(), phase: 'restart' });
const row = (result: Record<string, any>, id: string) => result.checks.find((item: { id: string }) => item.id === id);

test('recheck keeps setup pending while a configuration write is unreconciled (stale or unknown lock), with the write-lock row doctor shows', async t => {
  // setup apply wrote the connection but its restart ended unknown, so the lock stays; a pid that cannot exist on Windows (not a multiple of 4).
  for (const [state, lock] of [['stale', lockFile(999999)], ['unknown', 'interrupted lock']] as const) {
    const f = await writeLockFixture(t, lock);
    const result = await recheckSetup({ candidate: f.chosen }, f.context, async () => null, f.adb, f.maa) as Record<string, any>;
    assert.equal(result.connection.status, 'connected', state);
    assert.deepEqual([row(result, 'write-lock').status, row(result, 'configuration').status], ['error', 'normal'], state);
    assert.deepEqual([result.complete, result.exitCode, result.pending], [false, 1, ['write-lock']], state);
    const saved = JSON.parse(await readFile(join(f.privateDirectory, 'setup-environment.json'), 'utf8'));
    assert.deepEqual([saved.complete, saved.exitCode, saved.pending], [false, 1, ['write-lock']], state);
    // The same producer as doctor: identical rows, including the repair doctor offers.
    const doctor = await runChecks({ maaDirectory: f.maaDirectory, privateDirectory: f.privateDirectory, home: f.home, skillsRoot: join(f.root, 'skills') }, f.maa,
      { versionReader: async () => null, adb: f.adb });
    for (const id of ['configuration', 'write-lock']) {
      const { group: _group, ...doctorRow } = doctor.checks.find(item => item.id === id)!;
      assert.deepEqual(row(result, id), doctorRow, `${state}: ${id}`);
    }
  }
});

test('recheck reports a write lock whose holder is still alive as a warning and still completes; with no lock it completes as before', async t => {
  const windows = process.platform === 'win32';
  for (const [state, lock, status] of [['active', lockFile(process.pid), 'warning'], ['none', undefined, 'normal']] as const) {
    const f = await writeLockFixture(t, lock);
    const result = await recheckSetup({ candidate: f.chosen }, f.context, async () => null, f.adb, f.maa) as Record<string, any>;
    assert.deepEqual([row(result, 'write-lock').status, row(result, 'configuration').status], [status, 'normal'], state);
    assert.deepEqual([result.connection.status, result.complete, result.exitCode, result.pending, result.notBlocking],
      ['connected', true, windows ? 0 : 1, [], windows ? [] : ['platform']], state);
  }
});

test('recheck blocks on a configuration every writer refuses even when the MAA row reads it', async t => {
  const f = await writeLockFixture(t);
  const configFile = join(f.maaDirectory, 'config/gui.new.json');
  const config = JSON.parse(await readFile(configFile, 'utf8')); config.Timers = null;
  await writeFile(configFile, JSON.stringify(config));
  const result = await recheckSetup({ candidate: f.chosen }, f.context, async () => null, f.adb, f.maa) as Record<string, any>;
  assert.deepEqual([row(result, 'maa').status, row(result, 'configuration').status], ['normal', 'error']);
  assert.deepEqual([result.connection.status, result.complete, result.exitCode, result.pending], ['connected', false, 1, ['configuration']]);
});
