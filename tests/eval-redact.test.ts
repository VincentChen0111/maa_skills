import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runBatch } from '../scripts/eval-batch.ts';
import { selectScenarios } from '../scripts/eval-scenarios.ts';

const double = fileURLToPath(new URL('../eval/host-double.mjs', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const unique = () => Math.random().toString(36).slice(2, 8);
const root = await mkdtemp(join(tmpdir(), 'maa-redact-test-'));
// The home directory and the login directory carry unique marker segments, so a leak is found in any spelling.
const homeMarker = `HomeMarker${unique()}`;
const home = join(root, homeMarker); const settings = join(root, 'settings');
await mkdir(home); await mkdir(settings);
await writeFile(join(settings, 'config.json'), JSON.stringify({ privateDirectory: join(root, 'private') }));
Object.assign(process.env, { USERPROFILE: home, HOME: home, MAA_SKILLS_HOME: settings });
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
/** The 8.3 short form Windows gives an existing path; undefined where there is none (not Windows, or short names off on the volume). */
function shortForm(path: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const result = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${path}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true });
  const short = result.status === 0 ? result.stdout.trim() : '';
  return short && short.toLowerCase() !== path.toLowerCase() ? short : undefined;
}
// GitHub's Windows runner names its temporary directory in the 8.3 short form; the batch below names its login directory that
// way wherever short names exist, so this file reproduces the runner on any Windows machine.
const longRoot = realpathSync.native(root); const shortRoot = shortForm(longRoot);
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result.push(...entry.isDirectory() ? await files(path) : [path]);
  }
  return result;
}

test('the one redaction replaces a private path in every spelling and whatever follows it', async () => {
  const { redactor } = await import('../scripts/eval-redact.ts');
  const slash = String.fromCharCode(92);
  // Paths are assembled from segments so the repository's private-path check never sees a literal one.
  const segments = ['Users', 'someone', '.maa-skills-eval', 'claude-config'];
  const login = ['C:', ...segments].join(slash);
  const forward = login.replaceAll(slash, '/');
  const redact = redactor({ loginDirectory: login });
  const spellings = [login, login + slash + 's.txt', JSON.stringify(login), JSON.stringify(JSON.stringify(login)), JSON.stringify(JSON.stringify(JSON.stringify(login))),
    forward, '/c' + forward.slice(2), '//c' + forward.slice(2) + '/**', slash + slash + '?' + slash + login, 'file:///' + forward, login.toUpperCase(),
    'c:' + login.slice(2), [...login].map((char, index) => index % 2 ? char.toLowerCase() : char.toUpperCase()).join(''), encodeURIComponent(login),
    login.replaceAll(slash, slash + 'u005c'), JSON.stringify(login.replaceAll(slash, slash + 'u005c'))];
  for (const spelling of spellings) {
    for (const text of [`${spelling}目录不可读。`, `I could not read ${spelling}.`, `${spelling}-old`, `${spelling}7`, `"${spelling}"`, `'${spelling}'`, `（${spelling}）`, `${spelling}_x`]) {
      assert.ok(!redact(text).toLowerCase().includes('maa-skills-eval'), text);
    }
  }
  assert.equal(redact(`${login}目录不可读。`), '<login-dir>目录不可读。', 'text after the path stays');
  // A non-ASCII user name, as itself, percent-encoded, or as JSON \u escapes (one or more levels).
  const named = ['C:', 'Users', '张三', '.maa-skills-eval', 'codex-home'].join(slash);
  const escaped = named.replace(/[^\x00-\x7e]/g, (char) => slash + 'u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  const redactNamed = redactor({ loginDirectory: named });
  for (const text of [named, 'file:///' + encodeURI(named.replaceAll(slash, '/')), escaped, JSON.stringify(escaped)]) {
    assert.ok(!redactNamed(text).includes('maa-skills-eval'), text);
  }
  const posix = redactor({ loginDirectory: ['', 'home', 'someone', 'eval login'].join('/') });
  assert.equal(posix('file://' + ['', 'home', 'someone', 'eval%20login', 'a'].join('/')), 'file://<login-dir>/a');
});

test('any character but a letter or digit may come percent-encoded: a file URL of an 8.3 short name carries %7E for its tilde', async () => {
  const { redactor } = await import('../scripts/eval-redact.ts');
  const slash = String.fromCharCode(92);
  const login = ['C:', 'Users', 'RUNNER~1', 'AppData', "odd -_.!~*'()$&+,;=@[]{}^`#%name", 'LoginMarker', 'claude-config'].join(slash);
  const redact = redactor({ loginDirectory: login });
  const forward = login.replaceAll(slash, '/');
  // Node's pathToFileURL encodes `~` (encodeURIComponent does not); a strict encoder may encode every punctuation character.
  const strict = [...forward].map((char) => /[A-Za-z0-9/]/.test(char) ? char : `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  for (const text of ['file:///' + forward.replaceAll('~', '%7E'), 'file:///' + forward.replaceAll('~', '%7e'), strict, strict.toUpperCase(),
    'file:///' + encodeURI(forward).replaceAll('~', '%7E')]) {
    assert.equal(redact(`${text}/x`).toLowerCase().includes('loginmarker'), false, text);
  }
});

test('on Windows a login directory named in the 8.3 short form is redacted in its long form, and before it exists',
  { skip: shortRoot ? false : 'no 8.3 short names here (not Windows, or short names are off on this volume)' }, async () => {
    const { redactor } = await import('../scripts/eval-redact.ts');
    for (const exists of [true, false]) {
      const marker = `LoginMarker${unique()}`;
      const short = join(shortRoot!, marker, 'claude-config'); const long = join(longRoot, marker, 'claude-config');
      if (exists) await mkdir(long, { recursive: true });
      const redact = redactor({ loginDirectory: short });
      for (const text of [short, long, pathToFileURL(short).href, pathToFileURL(long).href, JSON.stringify(long)]) {
        assert.equal(redact(`${text}目录不可读。`).toLowerCase().includes(marker.toLowerCase()), false, `${exists ? 'existing' : 'absent'}: ${text}`);
      }
    }
  });

test('every producer writes every artifact through the one redaction: no private path survives in any file a batch writes', async () => {
  for (const host of ['claude', 'codex'] as const) {
    const loginMarker = `LoginMarker${unique()}`;
    const loginDirectory = join(shortRoot ?? root, loginMarker, host === 'claude' ? 'claude-config' : 'codex-home');
    await mkdir(loginDirectory, { recursive: true });
    const script = join(root, `script-${host}.json`);
    // The double names the login directory, home, repository, its workspace and fixture (and the sentinel when it sees one)
    // in its version, reply and stderr, so every producer receives them: the batch manifest (host version, attempts), the
    // read-protection output, and each run's record, evidence, raw output, stderr, invocation and scenario.
    await writeFile(script, JSON.stringify({ host, noise: [loginDirectory, home, repository],
      authStatus: host === 'claude' ? { loggedIn: true, authMethod: 'claude.ai' } : 'Logged in using ChatGPT',
      steps: host === 'claude' ? [{ fileRead: '{{sentinel}}', deny: true }, { shellRead: '{{sentinel}}', deny: true }] : [{ shellRead: '{{sentinel}}', deny: true }] }));
    const { directory, manifest } = await runBatch({ host, model: 'fixed-model', entries: selectScenarios(['core-language']), executable: process.execPath,
      executableArgs: [double, script], loginDirectory, batchParent: join(root, 'batches') });
    assert.equal(manifest.status, 'complete', `${host}: ${JSON.stringify(manifest.abort)}`);
    // Every artifact, by producer: the batch (manifest), the read-protection check, and each scenario run.
    const written = (await files(directory)).map((path) => relative(directory, path).replaceAll('\\', '/'));
    const run = manifest.runs[0]!.directory;
    assert.deepEqual(written.sort(), ['manifest.json', `read-protection-${host}.jsonl`, `read-protection-${host}.stderr.txt`,
      ...['evidence.json', 'host.jsonl', 'invocation.json', 'run.json', 'scenario.json', 'stderr.txt'].map((file) => `${run}/${file}`)].sort(),
      'a new artifact must be added to this list and written through artifactWriter');
    const markers = [loginMarker, homeMarker, 'maa-evaluation-', ...(basename(repository).length >= 8 ? [basename(repository)] : [])].map((marker) => marker.toLowerCase());
    for (const file of written) {
      const text = (await readFile(join(directory, file), 'utf8')).toLowerCase();
      for (const marker of markers) assert.ok(!text.includes(marker), `${host} ${file} names ${marker}`);
      // The private paths did reach every artifact, and were replaced there.
      assert.ok(text.includes('<login-dir>'), `${host} ${file} received the login directory`);
    }
  }
});

test('no evaluation module writes an artifact except through artifactWriter', async () => {
  // Direct file writes allowed outside the writer: the sentinel inside the login directory, the Codex enforcement probe's control
  // file inside the temporary workspace, and the lock beside the login directory.
  const allowed: Record<string, string[]> = { 'scripts/eval-run.ts': [], 'scripts/eval-auth.ts': ['sentinel', 'control'], 'scripts/eval-batch.ts': ['path'] };
  for (const [file, targets] of Object.entries(allowed)) {
    const text = await readFile(join(repository, file), 'utf8');
    assert.match(text, /import \{[^}]*\bartifactWriter\b[^}]*\} from '\.\/eval-redact\.ts'/, `${file} uses the one writer`);
    const direct = [...text.matchAll(/\b(?:writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream|copyFile|cp)\(\s*([\w.]+)/g)].map((match) => match[1]);
    assert.deepEqual(direct, targets, `${file} writes only through artifactWriter`);
  }
});
