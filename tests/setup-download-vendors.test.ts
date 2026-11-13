import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { planSetupDownload, downloadSetupProgram, setupDownloadStatus } from '../skills/maa-core/scripts/setup.ts';
import { emulatorVendors, vendorScriptable, type DownloadChain, type Fetcher } from '../skills/maa-core/scripts/setup-download.ts';

// Conformance for the single emulator source table and the one "scriptable" predicate. Every recorded official
// chain is replayed with its recorded HEAD statuses: a scriptable vendor plans and downloads after one confirmation,
// a vendor whose official source refuses scripted requests (401/403) never reaches a plan, a live 401/403 on any hop
// at plan or download time ends as source-refused without a retry, and a redirect to an unlisted host is refused at
// the plan hop and at the download hop before that host is contacted.
const supported = ['mumu', 'ldplayer', 'bluestacks-cn', 'bluestacks', 'nox', 'memu'];
/** Pinned on purpose: changing which vendors the script may download needs a new HEAD check and new docs. */
const refusedVendors = ['bluestacks-cn'];
const sameCompanyUnlisted: Record<string, string> = {
  mumu: 'a12.gdl.netease.com', ldplayer: 'res.ldplayer.net', 'bluestacks-cn': 'cdn3.bluestacks.com',
  bluestacks: 'aliosscdn1.bluestacks.cn', nox: 'res07.bignox.com', memu: 'www.microvirt.com',
};
const redirects = [301, 302, 303, 307, 308];
const bytes = Buffer.from('synthetic emulator installer');
const root = new URL('..', import.meta.url);

type Replay = { head?: { index: number; status: number }; get?: { index: number; status: number }; divertGet?: string };
/**
 * Network double replaying one recorded chain: address i answers the chain's recorded status `observed[i]`
 * (a redirect to address i + 1, the file, or a refusal). `head`/`get` replace one address's status for that method;
 * `divertGet` makes the download GET redirect to another host from the hop before the file (or from the start).
 */
function replay(vendor: string, chain: DownloadChain, options: Replay = {}) {
  const urls = [chain.start, ...chain.hops.map((host, index) => index === chain.hops.length - 1
    ? `https://${host}/synthetic/${vendor}-installer.exe?n=synthetic` : `https://${host}/synthetic/hop-${index}`)];
  const requests: { url: string; method: string; headers: string[] }[] = [];
  const fetch: Fetcher = async (url, init) => {
    const method = init.method ?? 'GET';
    requests.push({ url, method, headers: [...new Headers(init.headers).keys()] });
    assert.equal(init.redirect, 'manual');
    if (options.divertGet && new URL(url).hostname === options.divertGet) return new Response(new Uint8Array(bytes), { status: 200 });
    const index = urls.indexOf(url);
    if (index < 0) throw new TypeError('synthetic network: unlisted address');
    const override = method === 'HEAD' ? options.head : options.get;
    const status = override?.index === index ? override.status : chain.observed[index]!;
    if (method === 'GET' && options.divertGet && index === Math.max(0, urls.length - 2)) {
      return new Response(null, { status: 302, headers: { location: `https://${options.divertGet}/synthetic/${vendor}-installer.exe` } });
    }
    if (redirects.includes(status)) return new Response(null, { status, headers: { location: urls[index + 1]! } });
    if (status !== 200) return new Response('refused', { status });
    return new Response(method === 'HEAD' ? null : new Uint8Array(bytes), { status, headers: { 'content-length': String(bytes.length) } });
  };
  return { fetch, urls, requests };
}

async function settings(t: { after: (fn: () => Promise<unknown>) => void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'maa-setup-vendors-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'settings'); const privateDirectory = join(directory, 'private');
  await updateSettings({ language: 'en', privateDirectory }, home); await mkdir(privateDirectory, { recursive: true });
  return { home, privateDirectory };
}
const files = async (directory: string) => {
  try { return (await readdir(directory, { recursive: true })).map(item => String(item).replaceAll('\\', '/')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
};
const request = (id: string, chain: DownloadChain) => ({ program: 'emulator', vendor: id, url: chain.start, version: '9.9.9' });
const chainsOf = (ids: string[]) => ids.flatMap(id => emulatorVendors[id]!.chains.map(chain => ({ id, chain })));
const scriptableIds = supported.filter(id => !refusedVendors.includes(id));

test('the vendor table lists exactly the fully supported emulators with well-formed recorded chains documented in setup-sources.md', async () => {
  assert.deepEqual(Object.keys(emulatorVendors).sort(), [...supported].sort());
  const sources = await readFile(new URL('docs/setup-sources.md', root), 'utf8');
  for (const [id, vendor] of Object.entries(emulatorVendors)) {
    assert.ok(vendor.chains.length > 0, id);
    assert.match(vendor.checked, /^\d{4}-\d{2}-\d{2}$/, id); assert.ok(sources.includes(vendor.checked), `${id} check date ${vendor.checked} is recorded`);
    for (const chain of vendor.chains) {
      assert.ok(sources.includes(chain.start), `${id} start ${chain.start} is recorded`);
      for (const host of chain.hops) assert.ok(sources.includes(host), `${id} hop ${host} is recorded`);
      // One HEAD status per address: redirects until the last address, which serves the file (200) or refuses (401/403).
      assert.equal(chain.observed.length, chain.hops.length + 1, `${id} ${chain.start} has one status per address`);
      assert.ok(chain.observed.slice(0, -1).every(status => redirects.includes(status)), `${id} ${chain.start} redirects until its last address`);
      assert.ok([200, 401, 403].includes(chain.observed.at(-1)!), `${id} ${chain.start} ends with the file or a refusal`);
    }
  }
});

test('the scriptable flag derived from the recorded statuses refuses exactly BlueStacks 5 (CN), and every document lists the same vendors', async () => {
  assert.deepEqual(supported.filter(id => !vendorScriptable(emulatorVendors[id]!)), refusedVendors);
  // Each document that tells the user (or the agent) which vendors the script cannot download names the same ids.
  for (const document of ['docs/setup-sources.md', 'docs/spec.md', 'skills/maa-setup/references/setup.md', 'skills/maa-setup/SKILL.md']) {
    const text = await readFile(new URL(document, root), 'utf8');
    const lists = [...text.matchAll(/脚本不能下载的厂商[^：]{0,40}：((?:`[a-z-]+`(?:（[^）]*）)?、?)+)/g)]
      .map(match => [...match[1]!.matchAll(/`([a-z-]+)`/g)].map(item => item[1]!).sort());
    assert.ok(lists.length > 0, `${document} lists the vendors the script cannot download`);
    for (const list of lists) assert.deepEqual(list, [...refusedVendors].sort(), document);
  }
});

test('every scriptable vendor chain, replayed with its recorded statuses, plans and downloads after one confirmation with only the script User-Agent', async t => {
  const { home, privateDirectory } = await settings(t);
  for (const { id, chain } of chainsOf(scriptableIds)) await t.test(`${id} ${chain.start}`, async () => {
    const net = replay(id, chain);
    const plan = await planSetupDownload(request(id, chain), { home, fetch: net.fetch }) as Record<string, any>;
    assert.equal(plan.status, 'planned');
    const done = await downloadSetupProgram({ ...request(id, chain), planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download this installer' }, { home, fetch: net.fetch });
    assert.equal(done.status, 'downloaded', JSON.stringify(done));
    assert.equal(await readFile(join(privateDirectory, 'downloads', done.fileName as string), 'utf8'), bytes.toString());
    // No Referer or any browser-imitating header is ever sent to get past a vendor's protection.
    assert.ok(net.requests.every(item => item.headers.join() === 'user-agent'), JSON.stringify(net.requests));
  });
});

test('a vendor whose recorded official source refuses scripted requests never reaches a plan or a download and is never contacted', async t => {
  const { home, privateDirectory } = await settings(t);
  for (const { id, chain } of chainsOf(refusedVendors)) await t.test(`${id} ${chain.start}`, async () => {
    const net = replay(id, chain);
    await assert.rejects(planSetupDownload(request(id, chain), { home, fetch: net.fetch }), { message: 'source-refused' });
    await assert.rejects(planSetupDownload({ program: 'emulator', vendor: id }, { home, fetch: net.fetch }), { message: 'source-refused' });
    await assert.rejects(downloadSetupProgram({ ...request(id, chain), planId: randomUUID(), fingerprint: 'f'.repeat(64), reference: 'Download this installer' },
      { home, fetch: net.fetch }), { message: 'source-refused' });
    assert.deepEqual(net.requests, []);
    assert.deepEqual(await files(join(privateDirectory, 'downloads')), []);
  });
});

test('a live 401 or 403 on any plan hop of any scriptable vendor ends as source-refused, with no further hop and no retry', async t => {
  const { home, privateDirectory } = await settings(t);
  for (const { id, chain } of chainsOf(scriptableIds)) for (let index = 0; index <= chain.hops.length; index++) for (const status of [401, 403]) {
    await t.test(`${id} ${chain.start} hop ${index} ${status}`, async () => {
      const net = replay(id, chain, { head: { index, status } });
      await assert.rejects(planSetupDownload(request(id, chain), { home, fetch: net.fetch }), { message: 'source-refused' });
      assert.deepEqual(net.requests.map(item => [item.method, item.url]), net.urls.slice(0, index + 1).map(url => ['HEAD', url]));
      assert.deepEqual(await files(join(privateDirectory, 'downloads')), []);
    });
  }
});

test('a live 403 on any download hop ends as failed / source-refused, never retried, with nothing kept', async t => {
  const { home, privateDirectory } = await settings(t);
  for (const { id, chain } of chainsOf(scriptableIds)) for (let index = 0; index <= chain.hops.length; index++) {
    await t.test(`${id} ${chain.start} hop ${index}`, async () => {
      const net = replay(id, chain, { get: { index, status: 403 } });
      const plan = await planSetupDownload(request(id, chain), { home, fetch: net.fetch }) as Record<string, any>;
      assert.equal(plan.status, 'planned');
      const done = await downloadSetupProgram({ ...request(id, chain), planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download this installer' }, { home, fetch: net.fetch });
      assert.deepEqual([done.status, done.reason], ['failed', 'source-refused']);
      assert.deepEqual(net.requests.filter(item => item.method === 'GET').map(item => item.url), net.urls.slice(0, index + 1));
      assert.ok(net.requests.every(item => item.headers.join() === 'user-agent'));
      assert.deepEqual((await files(join(privateDirectory, 'downloads'))).filter(name => !name.startsWith('records')), []);
      const status = (await setupDownloadStatus({ home })).items.find(item => item.planId === plan.planId)!;
      assert.deepEqual([status.status, status.reason], ['failed', 'source-refused']);
    });
  }
});

test('a redirect to an unlisted same-company host is refused uncontacted at the plan hop and at the download hop', async t => {
  const { home, privateDirectory } = await settings(t);
  for (const { id, chain } of chainsOf(scriptableIds)) await t.test(`${id} ${chain.start}`, async () => {
    const unlisted = sameCompanyUnlisted[id]!;
    const contacted = (net: ReturnType<typeof replay>) => net.requests.some(item => new URL(item.url).hostname === unlisted);
    // Plan hop: a chain whose start serves the file gets the diverting redirect from the start address itself.
    const diverted = replay(id, chain.hops.length ? { ...chain, hops: [...chain.hops.slice(0, -1), unlisted] }
      : { start: chain.start, hops: [unlisted], observed: [302, 200] });
    await assert.rejects(planSetupDownload(request(id, chain), { home, fetch: diverted.fetch }), { message: 'unofficial-source' });
    assert.equal(contacted(diverted), false);
    // Download hop: the plan sees the recorded chain; only the download GET is diverted.
    const net = replay(id, chain, { divertGet: unlisted });
    const plan = await planSetupDownload(request(id, chain), { home, fetch: net.fetch }) as Record<string, any>;
    assert.equal(plan.status, 'planned');
    const done = await downloadSetupProgram({ ...request(id, chain), planId: plan.planId, fingerprint: plan.fingerprint, reference: 'Download this installer' }, { home, fetch: net.fetch });
    assert.deepEqual([done.status, done.reason], ['failed', 'unofficial-source']);
    assert.equal(contacted(net), false, 'the unlisted host is never contacted by the download');
    assert.deepEqual((await files(join(privateDirectory, 'downloads'))).filter(name => !name.startsWith('records')), []);
  });
});

/** Top-level declarations of a module, comments removed, so that uses can be attributed to the declaring function. */
function declarations(source: string) {
  const marks = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|class|type)\s+([A-Za-z_$][\w$]*)/gm)];
  return marks.map((mark, index) => ({ name: mark[1]!,
    body: source.slice(mark.index, marks[index + 1]?.index ?? source.length).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') }));
}
async function repositoryFiles(directory: URL, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.tmp'].includes(entry.name)) continue;
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await repositoryFiles(new URL(`${entry.name}/`, directory), `${path}/`));
    else if (/\.(?:ts|mjs|js)$/.test(entry.name)) result.push(path);
  }
  return result.sort();
}

test('every producer and consumer of the vendor table and of the scriptable predicate is enumerated', async () => {
  const module = 'skills/maa-core/scripts/setup-download.ts';
  const source = await readFile(new URL(module, root), 'utf8');
  const parts = declarations(source);
  const users = (name: string, pattern: RegExp) => parts.filter(part => part.name !== name && pattern.test(part.body)).map(part => part.name).sort();
  // Producers of statuses: the recorded chains (table) and every live hop, which only `request` performs.
  assert.deepEqual(users('', /\bfetcher\(/), ['request'], 'every network request goes through request()');
  assert.deepEqual(users('', /\bfetch\(/), []);
  assert.deepEqual(users('request', /\brequest\(/), ['resolveEmulator', 'resolveNode', 'text', 'transfer']);
  assert.deepEqual(users('text', /\btext\(/), ['resolveAdb', 'resolveMaa', 'resolveNode']);
  // The predicate and its consumers: request() on every live hop, vendorScriptable() on the recorded statuses.
  assert.deepEqual(users('chainScriptable', /\bchainScriptable\(/), ['request', 'vendorScriptable']);
  assert.deepEqual(users('vendorScriptable', /\bvendorScriptable\(/), ['resolveEmulator']);
  // The vendor table and its consumers; plan and download both reach resolveEmulator through resolve_.
  assert.deepEqual(users('emulatorVendors', /\bemulatorVendors\b/), ['resolveEmulator', 'transfer']);
  assert.deepEqual(users('vendorHosts', /\bvendorHosts\(/), ['resolveEmulator', 'transfer']);
  assert.deepEqual(users('resolveEmulator', /\bresolveEmulator\(/), ['resolve_']);
  assert.deepEqual(users('resolve_', /\bresolve_\(/), ['executeDownload', 'planDownload']);
  assert.deepEqual(users('transfer', /\btransfer\(/), ['executeDownload']);
  // Across the repository: one importer of the module, and the table and predicates are named nowhere else but this test.
  const all = await repositoryFiles(root);
  const texts = new Map(await Promise.all(all.map(async path => [path, await readFile(new URL(path, root), 'utf8')] as const)));
  assert.deepEqual(all.filter(path => /from\s+['"][^'"]*setup-download\.ts['"]/.test(texts.get(path)!) && !path.startsWith('tests/')), ['skills/maa-core/scripts/setup.ts']);
  const imported = /import\s*\{([^}]*)\}\s*from\s*'\.\/setup-download\.ts'/.exec(texts.get('skills/maa-core/scripts/setup.ts')!)![1]!.split(',').map(item => item.trim()).sort();
  assert.deepEqual(imported, ['DownloadError', 'downloadStatus', 'executeDownload', 'installDownload', 'planDownload', 'type DownloadContext']);
  assert.deepEqual(all.filter(path => path !== module && /\b(?:emulatorVendors|vendorScriptable|chainScriptable|vendorHosts)\b/.test(texts.get(path)!)),
    ['tests/setup-download-vendors.test.ts']);
});
