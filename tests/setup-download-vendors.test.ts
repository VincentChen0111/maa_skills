import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { planSetupDownload, downloadSetupProgram } from '../skills/maa-core/scripts/setup.ts';
import { emulatorVendors, type DownloadChain, type Fetcher } from '../skills/maa-core/scripts/setup-download.ts';

// Conformance for the single emulator source table: every recorded official chain must download after one
// confirmation, and a hop to an unlisted host of the same company must be refused before it is contacted.
const supported = ['mumu', 'ldplayer', 'bluestacks-cn', 'bluestacks', 'nox', 'memu'];
const sameCompanyUnlisted: Record<string, string> = {
  mumu: 'a12.gdl.netease.com', ldplayer: 'res.ldplayer.net', 'bluestacks-cn': 'cdn3.bluestacks.com',
  bluestacks: 'aliosscdn1.bluestacks.cn', nox: 'res07.bignox.com', memu: 'www.microvirt.com',
};
const bytes = Buffer.from('synthetic emulator installer');

/** Network double replaying one chain: start → each recorded hop host → file. `divert` swaps the last hop for another host. */
function replay(vendor: string, chain: DownloadChain, divert?: string) {
  const hosts = divert ? [...chain.hops.slice(0, -1), divert] : chain.hops;
  const urls = [chain.start, ...hosts.map((host, index) => index === hosts.length - 1
    ? `https://${host}/synthetic/${vendor}-installer.exe?n=synthetic` : `https://${host}/synthetic/hop-${index}`)];
  const requests: string[] = [];
  const fetch: Fetcher = async (url, init) => {
    requests.push(url); assert.equal(init.redirect, 'manual');
    const index = urls.indexOf(url);
    if (index < 0) throw new TypeError('synthetic network: unlisted address');
    if (index < urls.length - 1) return new Response(null, { status: index % 2 ? 303 : 302, headers: { location: urls[index + 1]! } });
    return new Response(init.method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers: { 'content-length': String(bytes.length) } });
  };
  return { fetch, requests };
}

test('the vendor table lists exactly the fully supported emulators, each with recorded chains documented in setup-sources.md', async () => {
  assert.deepEqual(Object.keys(emulatorVendors).sort(), [...supported].sort());
  const sources = await readFile(new URL('../docs/setup-sources.md', import.meta.url), 'utf8');
  for (const [id, vendor] of Object.entries(emulatorVendors)) {
    assert.ok(vendor.chains.length > 0, id);
    for (const chain of vendor.chains) {
      assert.ok(sources.includes(chain.start), `${id} start ${chain.start} is recorded`);
      for (const host of chain.hops) assert.ok(sources.includes(host), `${id} hop ${host} is recorded`);
    }
  }
});

test('every recorded official chain plans and downloads after one confirmation; an unlisted same-company hop is refused uncontacted', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maa-setup-vendors-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'settings'); const privateDirectory = join(root, 'private');
  await updateSettings({ language: 'en', privateDirectory }, home); await mkdir(privateDirectory, { recursive: true });
  for (const id of supported) for (const chain of emulatorVendors[id]!.chains) await t.test(`${id} ${chain.start}`, async () => {
    const net = replay(id, chain);
    const plan = await planSetupDownload({ program: 'emulator', vendor: id, url: chain.start, version: '9.9.9' }, { home, fetch: net.fetch }) as Record<string, any>;
    assert.equal(plan.status, 'planned');
    const done = await downloadSetupProgram({ program: 'emulator', vendor: id, url: chain.start, version: '9.9.9', planId: plan.planId, fingerprint: plan.fingerprint,
      reference: 'Download this installer' }, { home, fetch: net.fetch });
    assert.equal(done.status, 'downloaded', JSON.stringify(done));
    assert.equal(await readFile(join(privateDirectory, 'downloads', done.fileName as string), 'utf8'), bytes.toString());
    // Chains whose start serves the file get a diverting redirect from the start address itself.
    const diverted = replay(id, chain.hops.length ? chain : { start: chain.start, hops: [new URL(chain.start).hostname] }, sameCompanyUnlisted[id]);
    await assert.rejects(planSetupDownload({ program: 'emulator', vendor: id, url: chain.start, version: '9.9.9' }, { home, fetch: diverted.fetch }), { message: 'unofficial-source' });
    assert.equal(diverted.requests.some(url => new URL(url).hostname === sameCompanyUnlisted[id]), false);
  });
});
