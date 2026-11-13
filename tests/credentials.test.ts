import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { updateSettings } from '../skills/maa-core/scripts/preferences.ts';
import { applyTerminalInput, inspectCredentials, readCredential, recordCredentialOutcome, saveCredential } from '../skills/maa-core/scripts/credentials.ts';
import type { Protector } from '../skills/maa-core/scripts/credential-protection.ts';

const core = fileURLToPath(new URL('../skills/maa-core', import.meta.url));
const script = join(core, 'scripts/credentials.ts');
const loader = new URL('./fixtures/credential-boundary.mjs', import.meta.url).href;
const syntheticValue = () => `synthetic-credential-${randomUUID()}`;

async function fixture(t: { after(fn: () => Promise<unknown>): void }, language: string | null = 'zh-CN') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maa-credentials-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'settings'); const privateDirectory = join(root, 'private');
  await updateSettings({ language, privateDirectory }, home);
  return { root, home, privateDirectory };
}

function run(f: { home: string; root: string }, args: string[], input = '', options: { boundary?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(process.execPath, [...(options.boundary === false ? [] : ['--import', loader]), script, ...args], {
    env: { ...process.env, MAA_SKILLS_HOME: f.home, MAA_CREDENTIAL_TEST_CORE: core, MAA_CREDENTIAL_TEST_JOURNAL: join(f.root, 'protection.log'), ...options.env },
    input, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function files(directory: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) for (const [name, bytes] of await files(path)) result.set(name, bytes);
    else result.set(path, await readFile(path));
  }
  return result;
}

async function assertNoLeak(root: string, value: string, ...texts: string[]) {
  for (const text of texts) assert.equal(text.includes(value), false, 'console output must not contain the secret');
  for (const [, bytes] of await files(root)) assert.equal(bytes.includes(value), false, 'no saved file may contain the secret in plain text');
}

function check(f: { home: string; root: string }) {
  const result = run(f, ['check', '--json']);
  return { ...result, value: JSON.parse(result.stdout) as { exitCode: number; credentials: { service: string; state: string }[]; checks: { id: string; status: string; reason: string }[] } };
}

test('the Skland input flow discloses before the paste prompt, has no password prompt and saves only protected data', async (t) => {
  const f = await fixture(t);
  const settings = await readFile(join(f.home, 'config.json'));
  const value = syntheticValue();
  const result = run(f, ['input', 'skland', '--stdin'], `y\n${value}\n`);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const disclosure = result.stdout.search(/截至 2026-11-13.*鹰角/);
  const readOnly = result.stdout.search(/只用来读取你的账号数据/);
  const prompt = result.stdout.search(/粘贴.*token/);
  assert.ok(disclosure >= 0 && readOnly >= 0 && prompt > disclosure && prompt > readOnly, result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /密码|password/i);
  assert.match(result.stdout, /你给出链接的森空岛社区帖子/, 'since 2026-11-14 the same token also reads the Skland community posts the user links');
  assert.match(result.stdout, /不用于任何写入、签到、发帖、点赞、评论或修改/);
  assert.match(result.stdout, /token 过期后，重新运行本脚本粘贴新的 token/);
  await assertNoLeak(f.root, value, result.stdout, result.stderr);
  assert.deepEqual(await readFile(join(f.home, 'config.json')), settings, 'the settings file carries no credential data');
  assert.ok((await stat(join(f.privateDirectory, 'credentials/skland.json'))).isFile());
  assert.match(await readFile(join(f.root, 'protection.log'), 'utf8'), /^protect$/m, 'the value passed through the protection boundary');
  const status = check(f);
  assert.equal(status.code, 0, status.stdout + status.stderr);
  assert.deepEqual(status.value.credentials.map(item => [item.service, item.state]), [['nga', 'unset'], ['skland', 'unverified'], ['bilibili', 'unset']]);
  assert.deepEqual(status.value.checks.map(item => [item.id, item.status]), [['credential-nga', 'normal'], ['credential-skland', 'warning'], ['credential-bilibili', 'normal']]);
  await assertNoLeak(f.root, value, status.stdout, status.stderr);
});

const double = (await import(new URL('./fixtures/credential-protection-double.mjs', import.meta.url).href) as { windowsProtector: Protector }).windowsProtector;

async function snapshot(directory: string) {
  return [...(await files(directory))].map(([name, bytes]) => [name, bytes.toString('base64')]).sort();
}

test('cancelled, rejected or failed input keeps an existing usable credential and its status intact', async (t) => {
  const f = await fixture(t);
  const first = syntheticValue();
  assert.equal(run(f, ['input', 'skland', '--stdin'], `y\n${first}\n`).code, 0);
  const saved = await readCredential('skland', { privateDirectory: f.privateDirectory, protector: double });
  assert.deepEqual(Object.values(saved.values), [first]);
  assert.equal(await recordCredentialOutcome('skland', saved.revision, 'usable', { privateDirectory: f.privateDirectory }), true);
  assert.equal(check(f).value.credentials[1]!.state, 'usable');
  const before = await snapshot(f.privateDirectory);
  const second = syntheticValue();
  const attempts: [string, string, NodeJS.ProcessEnv?][] = [
    ['declined', `n\n${second}\n`], ['no answer', ''], ['no value', 'y\n'], ['empty value', 'y\n   \n'],
    ['control character', `y\n${second}\u0001x\n`], ['too long', `y\n${second}${'x'.repeat(9000)}\n`], ['spaces inside', `y\n${second} x\n`],
    ['protection failure', `y\n${second}\n`, { MAA_CREDENTIAL_TEST_PROTECTION: 'fail' }],
  ];
  for (const [name, input, env] of attempts) {
    const result = run(f, ['input', 'skland', '--stdin'], input, { env });
    assert.equal(result.code, 1, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /原有设置保持不变/, name);
    assert.deepEqual(await snapshot(f.privateDirectory), before, `${name} must not change saved files or leave temporary files`);
    await assertNoLeak(f.root, second, result.stdout, result.stderr);
  }
  // Without --stdin the flow only runs in the user's own terminal; piped input is never read.
  const piped = run(f, ['input', 'skland'], `y\n${second}\n`);
  assert.equal(piped.code, 1); assert.match(piped.stderr, /你自己的终端/);
  assert.deepEqual(await snapshot(f.privateDirectory), before);
  assert.equal(check(f).value.credentials[1]!.state, 'usable');
  await assertNoLeak(f.root, first, piped.stdout, piped.stderr);
});

test('the shared check separates unset, unverified, usable, known-expired and unreadable without decrypting', async (t) => {
  const f = await fixture(t);
  const states = async (now?: Date) => (await inspectCredentials(f.privateDirectory, now)).credentials.map(item => item.state);
  assert.deepEqual(await states(), ['unset', 'unset', 'unset']);
  const values = [syntheticValue(), syntheticValue(), syntheticValue()];
  const pair = `a=${values[0]}`;
  const nga = await saveCredential('nga', `Cookie: ${pair}; b=c`, { privateDirectory: f.privateDirectory, protector: double });
  const skland = await saveCredential('skland', values[1]!, { privateDirectory: f.privateDirectory, protector: double });
  const bilibili = await saveCredential('bilibili', `"${values[2]}"`, { privateDirectory: f.privateDirectory, protector: double });
  // Existence alone is never reported as valid.
  assert.deepEqual(await states(), ['unverified', 'unverified', 'unverified']);
  assert.deepEqual(Object.entries((await readCredential('nga', { privateDirectory: f.privateDirectory, protector: double })).values), [['cookie', `${pair}; b=c`]]);
  assert.deepEqual(Object.values((await readCredential('bilibili', { privateDirectory: f.privateDirectory, protector: double })).values), [values[2]]);
  await recordCredentialOutcome('nga', nga.revision, 'usable', { privateDirectory: f.privateDirectory });
  await recordCredentialOutcome('skland', skland.revision, 'expired', { privateDirectory: f.privateDirectory });
  await recordCredentialOutcome('bilibili', bilibili.revision, 'usable', { privateDirectory: f.privateDirectory, expiresAt: '2030-01-01T00:00:00.000Z' });
  assert.deepEqual(await states(new Date('2029-12-31T23:59:59.000Z')), ['usable', 'expired', 'usable']);
  assert.deepEqual(await states(new Date('2030-01-01T00:00:00.000Z')), ['usable', 'expired', 'expired'], 'a known expiry time passes offline');
  const journal = join(f.root, 'protection.log');
  await rm(journal, { force: true });
  assert.equal(check(f).value.credentials[0]!.state, 'usable');
  await assert.rejects(readFile(journal), { code: 'ENOENT' }, 'the check CLI never reaches the protection boundary');
  const result = await inspectCredentials(f.privateDirectory);
  assert.deepEqual(result.checks.map(item => [item.id, item.status, item.reason, item.repair.executor]), [
    ['credential-nga', 'normal', 'credential-usable', 'user'], ['credential-skland', 'error', 'credential-expired', 'user'], ['credential-bilibili', 'normal', 'credential-usable', 'user']]);
  const expired = result.checks[1]!;
  assert.equal(expired.repair.id, 'reenter-credential');
  assert.match(expired.repair.description, /credentials\.ts input skland" yourself in your own terminal and paste a new token/, 'an expired token is fixed only by pasting again');
  assert.doesNotMatch(JSON.stringify(result), /password|log ?in\b|sign-in page/i);
  assert.match(result.checks[2]!.message, /experimental/i);
  for (const value of values) assert.equal(JSON.stringify(result).includes(value), false);
  assert.equal(JSON.stringify(result).includes(f.root), false, 'no local path in check output');

  // Re-entering replaces the value: the old result no longer applies and a late old result is ignored.
  const renewed = await saveCredential('skland', syntheticValue(), { privateDirectory: f.privateDirectory, protector: double });
  assert.equal((await states())[1], 'unverified');
  assert.equal(await recordCredentialOutcome('skland', skland.revision, 'usable', { privateDirectory: f.privateDirectory }), false);
  assert.equal((await states())[1], 'unverified');
  assert.equal(await recordCredentialOutcome('skland', renewed.revision, 'usable', { privateDirectory: f.privateDirectory }), true);
  assert.equal((await states())[1], 'usable');

  // A damaged result only loses verification; a damaged or foreign record is unreadable, not unset.
  await writeFile(join(f.privateDirectory, 'credentials/skland.status.json'), '{');
  assert.equal((await states())[1], 'unverified');
  await writeFile(join(f.privateDirectory, 'credentials/nga.json'), await readFile(join(f.privateDirectory, 'credentials/skland.json')));
  assert.equal((await states())[0], 'unreadable');
  await writeFile(join(f.privateDirectory, 'credentials/bilibili.json'), 'not json');
  assert.equal((await states())[2], 'unreadable');
  const cli = check(f);
  assert.equal(cli.code, 1, 'expired or unreadable credentials are check errors');
  assert.equal(cli.value.exitCode, 1);

  // A record this Windows account cannot decrypt is marked unreadable for the shared check.
  const record = JSON.parse(await readFile(join(f.privateDirectory, 'credentials/skland.json'), 'utf8'));
  record.revision = randomUUID();
  await writeFile(join(f.privateDirectory, 'credentials/skland.json'), JSON.stringify(record));
  await assert.rejects(readCredential('skland', { privateDirectory: f.privateDirectory, protector: double }), { message: 'credential-unreadable' });
  assert.equal((await states())[1], 'unreadable');

  const unknown = await inspectCredentials(null);
  assert.deepEqual(unknown.checks.map(item => [item.status, item.reason, item.repair.id]), Array(3).fill(['warning', 'credential-unknown', 'inspect-settings']));
});

test('NGA and experimental Bilibili flows speak the user language and accept only the documented value', async (t) => {
  const f = await fixture(t, 'en');
  const cookie = syntheticValue();
  const nga = run(f, ['input', 'nga', '--stdin'], `yes\nCookie: session=${cookie}; other=1\n`);
  assert.equal(nga.code, 0, nga.stdout + nga.stderr);
  assert.match(nga.stdout, /NGA credential/); assert.match(nga.stdout, /never signs in for you/); assert.match(nga.stdout, /Paste the Cookie/);
  assert.match(nga.stdout, /not yet verified/);
  const sessdata = syntheticValue();
  const bilibili = run(f, ['input', 'bilibili', '--stdin'], `y\n${sessdata}\n`);
  assert.equal(bilibili.code, 0, bilibili.stdout + bilibili.stderr);
  assert.ok(bilibili.stdout.search(/experimental/i) >= 0 && bilibili.stdout.search(/experimental/i) < bilibili.stdout.search(/Paste the SESSDATA/), bilibili.stdout);
  const chinese = run(f, ['input', 'bilibili', '--stdin', '--language', 'zh-Hans-CN'], 'n\n');
  assert.equal(chinese.code, 1); assert.match(chinese.stdout, /实验性/); assert.match(chinese.stderr, /已取消/);
  for (const output of [nga, bilibili, chinese]) assert.doesNotMatch(output.stdout + output.stderr, /password|密码/i);
  await assertNoLeak(f.root, cookie, nga.stdout, nga.stderr);
  await assertNoLeak(f.root, sessdata, bilibili.stdout, bilibili.stderr);
  assert.deepEqual(Object.entries((await readCredential('nga', { privateDirectory: f.privateDirectory, protector: double })).values), [['cookie', `session=${cookie}; other=1`]]);
  assert.equal(run(f, ['input', 'nga', '--stdin'], 'y\nno-cookie-pair\n').code, 1, 'an NGA value must be a cookie header');
  for (const args of [['input', 'steam', '--stdin'], ['input', 'skland', '--stdin', '--stdin'], ['input'], ['remove', 'skland'], ['check', '--verbose']]) {
    const result = run(f, args, 'y\n');
    assert.equal(result.code, 1, args.join(' '));
  }
  const fresh = { root: f.root, home: join(f.root, 'unsaved-settings') };
  const first = run(fresh, ['input', 'skland', '--stdin', '--language', 'en'], `y\n${syntheticValue()}\n`);
  assert.equal(first.code, 1); assert.match(first.stderr, /maa-setup first/);
  await assert.rejects(readdir(fresh.home), { code: 'ENOENT' }, 'nothing is created before the private directory is chosen');
});

test('Windows per-user protection round-trips through the real input flow and the reader', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const value = syntheticValue();
  const result = run(f, ['input', 'skland', '--stdin'], `y\n${value}\n`, { boundary: false });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  await assertNoLeak(f.root, value, result.stdout, result.stderr);
  const record = JSON.parse(await readFile(join(f.privateDirectory, 'credentials/skland.json'), 'utf8'));
  assert.equal(record.protection, 'windows-dpapi-current-user');
  const read = await readCredential('skland', { privateDirectory: f.privateDirectory });
  assert.deepEqual(Object.values(read.values), [value]);
  // The ciphertext is bound to its service and revision: a copied or altered record cannot be opened.
  record.revision = randomUUID();
  await writeFile(join(f.privateDirectory, 'credentials/skland.json'), JSON.stringify(record));
  await assert.rejects(readCredential('skland', { privateDirectory: f.privateDirectory }), { message: 'credential-unreadable' });
  assert.equal((await inspectCredentials(f.privateDirectory)).credentials[1]!.state, 'unreadable');
});

test('hidden terminal input handles typing, pasting, editing keys, cancellation and split line endings', () => {
  const empty = { value: '', skipLineFeed: false };
  const feed = (chunks: string[]) => {
    const results: (string | null)[] = [];
    let line = empty; let queue = [...chunks];
    while (queue.length) {
      const step = applyTerminalInput(line, queue.shift()!);
      line = step.line;
      if (step.result !== undefined) { results.push(step.result); if (step.rest) queue = [step.rest, ...queue]; }
    }
    return { results, line };
  };
  assert.deepEqual(feed(['y\r']).results, ['y']);
  assert.deepEqual(feed(['to', 'ken-part', '\r']).results, ['token-part'], 'typed or pasted pieces join until Enter');
  assert.deepEqual(feed(['abx\u007fc\bd\r']).results, ['abd'], 'backspace removes the last character');
  assert.deepEqual(feed(['partial\u0003']).results, [null], 'Ctrl+C cancels');
  assert.deepEqual(feed(['\u001a']).results, [null]);
  assert.deepEqual(feed(['\u001b[Aab\u001bOD\r']).results, ['ab'], 'arrow-key sequences are ignored');
  assert.deepEqual(feed(['y\r', '\nsecond\r']).results, ['y', 'second'], 'a line feed split from its carriage return does not end the next answer');
  assert.deepEqual(feed(['y\r\nsecond\r']).results, ['y', 'second'], 'input after Enter is kept for the next prompt');
  assert.deepEqual(feed(['\r']).results, [''], 'Enter alone gives an empty answer, which the flow treats as cancelled');
  assert.equal(feed(['x'.repeat(20_000)]).line.value.length <= 16_385, true, 'runaway input is bounded');
});
