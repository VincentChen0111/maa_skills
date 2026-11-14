import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeStdinJson, readStdinJson, stdinJsonCode, stdinJsonCodes, type StdinJsonOptions } from '../skills/maa-core/scripts/stdin-json.ts';

// Ticket 26 (R1): Windows PowerShell 5.1 pipes JSON to node with a UTF-8 byte order mark in front and every non-ASCII
// character already replaced by `?`. Every CLI under skills/ reads its JSON request through one shared reader.

const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const bytes = (text: string, marked = false) => marked ? Buffer.concat([bom, Buffer.from(text)]) : Buffer.from(text);
const failure = (run: () => unknown) => { try { run(); } catch (error) { return stdinJsonCode(error); } return undefined; };
const failureOf = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { return stdinJsonCode(error); } return undefined; };
async function* chunks(...parts: Buffer[]) { for (const part of parts) yield part; }
const unlimited: StdinJsonOptions = { maxBytes: null };

test('a leading byte order mark is removed and escaped non-ASCII text arrives unchanged', () => {
  assert.deepEqual(decodeStdinJson(bytes('{"currentLanguage":"zh-CN"}\r\n', true), unlimited), { currentLanguage: 'zh-CN' });
  assert.deepEqual(decodeStdinJson(bytes('{"text":"\\u4ee5\\u540e\\u7528\\u82f1\\u6587\\u003f"}', true), unlimited), { text: '以后用英文?' });
  assert.deepEqual(decodeStdinJson(bytes('{"text":"以后用英文"}'), unlimited), { text: '以后用英文' }, 'UTF-8 without a mark is read as before');
});

test('a byte order mark together with a literal ? is refused: the text may already have lost characters', () => {
  assert.equal(stdinJsonCodes.lossy, 'input-encoding-lossy');
  for (const text of ['{"text":"?a"}', '{"?":1}', '{"keyword":"干员?"}']) {
    assert.equal(failure(() => decodeStdinJson(bytes(text, true), unlimited)), 'input-encoding-lossy', text);
  }
  // The refusal code is the same whatever codes the calling CLI keeps for its other input failures.
  assert.equal(failure(() => decodeStdinJson(bytes('{"a":"?"}', true), { maxBytes: null, invalidCode: 'request-invalid', tooLargeCode: 'request-invalid' })), 'input-encoding-lossy');
});

test('a ? without a byte order mark is legitimate text and is accepted', () => {
  assert.deepEqual(decodeStdinJson(bytes('{"text":"why?","url":"https://example.invalid/a?b=1"}'), unlimited), { text: 'why?', url: 'https://example.invalid/a?b=1' });
});

test('bytes that are not UTF-8 are refused as lossy instead of being stored as replacement characters', () => {
  const gbk = Buffer.from([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xd6, 0xd0, 0x22, 0x7d]); // {"t":"中"} in code page 936
  assert.equal(failure(() => decodeStdinJson(gbk, unlimited)), 'input-encoding-lossy');
});

test('unparsable or empty input gets the calling CLI\'s own code, or the shared default', () => {
  assert.equal(stdinJsonCodes.invalid, 'input-json-invalid');
  assert.equal(failure(() => decodeStdinJson(bytes('{"a":'), unlimited)), 'input-json-invalid');
  assert.equal(failure(() => decodeStdinJson(bytes(''), unlimited)), 'input-json-invalid', 'empty input is not JSON unless the CLI names a default');
  assert.equal(failure(() => decodeStdinJson(bytes('not json'), { maxBytes: null, invalidCode: 'request-invalid' })), 'request-invalid');
  assert.deepEqual(decodeStdinJson(bytes(''), { maxBytes: null, empty: {} }), {});
  assert.deepEqual(decodeStdinJson(bom, { maxBytes: null, empty: {} }), {}, 'a mark alone is empty input');
  assert.equal(stdinJsonCode(new Error('input-encoding-lossy')), undefined, 'only the shared reader\'s own failures carry a code');
});

test('each CLI keeps its own size limit: the limit itself is accepted, one byte more is refused before parsing', async () => {
  assert.equal(stdinJsonCodes.tooLarge, 'input-too-large');
  const exact = bytes(`{"a":"${'x'.repeat(10)}"}`);
  assert.deepEqual(await readStdinJson({ maxBytes: exact.length }, chunks(exact.subarray(0, 5), exact.subarray(5))), { a: 'x'.repeat(10) });
  assert.equal(await failureOf(() => readStdinJson({ maxBytes: exact.length - 1 }, chunks(exact))), 'input-too-large');
  assert.equal(await failureOf(() => readStdinJson({ maxBytes: 4, tooLargeCode: 'request-invalid' }, chunks(bytes('{"a":1}')))), 'request-invalid');
  assert.deepEqual(await readStdinJson(unlimited, chunks(bytes(`{"a":"${'y'.repeat(2 * 1024 * 1024)}"}`))), { a: 'y'.repeat(2 * 1024 * 1024) }, 'a CLI without a limit still has none');
});

test('a character split across two chunks is decoded whole', async () => {
  const text = bytes('{"t":"中文"}');
  assert.deepEqual(await readStdinJson(unlimited, chunks(text.subarray(0, 7), text.subarray(7))), { t: '中文' });
  assert.deepEqual(await readStdinJson(unlimited, chunks(bom.subarray(0, 1), Buffer.concat([bom.subarray(1), bytes('{"t":1}')]))), { t: 1 }, 'a mark split across chunks is still a mark');
});

// ---- Conformance: every reader of standard input under skills/ goes through the shared reader ----------------------------

const skillsRoot = fileURLToPath(new URL('../skills/', import.meta.url));
const owner = 'maa-core/scripts/stdin-json.ts';
/** Reads terminal answers line by line for the user's own credential entry: never JSON, never run by an agent. */
const terminalReaders = ['maa-core/scripts/credentials.ts'];
/** Every CLI that reads a JSON request on standard input: an action that reads it (and any flag it needs), and the interface doc. */
const consumers: Record<string, { args: string[]; doc: string }> = {
  'maa-core/scripts/account-snapshot.ts': { args: ['inspect'], doc: 'maa-account/references/import.md' },
  'maa-core/scripts/base-apply.ts': { args: ['check'], doc: 'maa-daily/references/base-apply.md' },
  'maa-core/scripts/base-plan.ts': { args: ['check'], doc: 'maa-core/references/base-plan.md' },
  'maa-core/scripts/base-query.ts': { args: ['query'], doc: 'maa-core/references/base-query.md' },
  'maa-core/scripts/base-report.ts': { args: ['read'], doc: 'maa-account/references/base-report.md' },
  'maa-core/scripts/bilibili.ts': { args: ['read'], doc: 'maa-core/references/research.md' },
  'maa-core/scripts/cultivation-gaps.ts': { args: ['query'], doc: 'maa-account/references/gaps.md' },
  'maa-core/scripts/cultivation-report.ts': { args: ['read'], doc: 'maa-core/references/advice-report.md' },
  'maa-core/scripts/doctor.ts': { args: ['analyze', '--json'], doc: 'maa-doctor/references/checks.md' },
  'maa-core/scripts/maa-config.ts': { args: ['preview'], doc: 'maa-daily/references/configuration.md' },
  'maa-core/scripts/nga.ts': { args: ['search'], doc: 'maa-core/references/research.md' },
  'maa-core/scripts/operator-cost.ts': { args: ['query'], doc: 'maa-account/references/cost.md' },
  'maa-core/scripts/preferences.ts': { args: ['read'], doc: 'maa-core/references/preferences.md' },
  'maa-core/scripts/setup.ts': { args: ['check', '--json'], doc: 'maa-setup/references/setup.md' },
  'maa-core/scripts/skland-account.ts': { args: ['inspect'], doc: 'maa-account/references/skland.md' },
  'maa-core/scripts/skland-community.ts': { args: ['read'], doc: 'maa-core/references/research.md' },
  'maa-core/scripts/stage-jobs.ts': { args: ['stages'], doc: 'maa-daily/references/stage-jobs.md' },
  'maa-core/scripts/stage-run.ts': { args: ['read'], doc: 'maa-daily/references/stage-run.md' },
  'maa-core/scripts/training-plan.ts': { args: ['read'], doc: 'maa-core/references/training.md' },
  'maa-core/scripts/training-time.ts': { args: ['query'], doc: 'maa-core/references/training.md' },
};
const quote = /['"`]/.source;
const identifier = /[A-Za-z_$][\w$]*/.source;
/** `process` or `node:process` as a module specifier. */
const processModule = String.raw`${quote}(?:node:)?process${quote}`;
/** Ways to reach standard input without naming a process object: file descriptor 0, the device, or stdin taken from the module itself. */
const moduleReads = [
  /\/dev\/stdin/, /\breadFile(?:Sync)?\(\s*0\s*[,)]/, /\breadSync\(\s*0\s*,/, /\bfd:\s*0\b/, /openStdin/,
  // import { stdin } from 'node:process', with or without `as`, alone or among other names
  new RegExp(String.raw`\bimport\b[^;]*?\{[^}]*\bstdin\b[^}]*\}\s*from\s*${processModule}`),
  // require('process').stdin, (await import('node:process'))['stdin'], const { stdin } = require('process')
  new RegExp(String.raw`\b(?:require|import)\s*\(\s*${processModule}\s*\)\s*\)?\s*(?:\??\.\s*stdin\b|\[\s*${quote}stdin)`),
  new RegExp(String.raw`\{[^}]*\bstdin\b[^}]*\}\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*${processModule}`),
];
/** Every name a source binds to the process object: the global, an alias of it, and each default, namespace or require binding of node:process. */
function processNames(text: string): string[] {
  const names = new Set(['process']);
  const bindings = [
    new RegExp(String.raw`\bimport\s+(?:\*\s*as\s+)?(${identifier})\s*(?:,[^;]*?)?from\s*${processModule}`, 'g'),
    new RegExp(String.raw`\b(?:const|let|var)\s+(${identifier})\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*${processModule}\s*\)`, 'g'),
    new RegExp(String.raw`\b(?:const|let|var)\s+(${identifier})\s*=\s*(?:globalThis\s*\.\s*)?process\s*[;,)\n]`, 'g'),
  ];
  for (const binding of bindings) for (const [, name] of text.matchAll(binding)) names.add(name!);
  return [...names];
}
/** Whether a source reads standard input itself instead of through the shared reader. */
function readsStdinDirectly(text: string): boolean {
  if (moduleReads.some(pattern => pattern.test(text))) return true;
  return processNames(text).some(name => {
    const bound = name.replace(/[$]/g, '\\$&');
    return new RegExp(String.raw`(?<![\w$])${bound}\s*(?:\??\.\s*stdin\b|\[\s*${quote}stdin)|\{[^}]*\bstdin\b[^}]*\}\s*=\s*${bound}(?![\w$])`).test(text);
  });
}
const sharedRead = /\breadStdinJson\(/;

async function sources(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true })) {
    const name = String(entry).replaceAll('\\', '/');
    if (/\.(?:[cm]?[jt]s)$/.test(name)) files.set(name, await readFile(join(root, name), 'utf8'));
  }
  return files;
}
/** Every violation of the one-reader rule in a set of source files; empty when the rule holds. */
function stdinViolations(files: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [name, text] of files) {
    if (readsStdinDirectly(text) && name !== owner && !terminalReaders.includes(name)) violations.push(`${name}: reads standard input directly`);
    if (sharedRead.test(text) && name !== owner && !Object.hasOwn(consumers, name)) violations.push(`${name}: reads standard input but is not in the conformance list`);
  }
  for (const name of Object.keys(consumers)) if (!sharedRead.test(files.get(name) ?? '')) violations.push(`${name}: does not use readStdinJson`);
  if (!files.has(owner)) violations.push(`${owner}: the shared reader is missing`);
  return violations.sort();
}

test('conformance: every standard-input reader under skills/ is listed and uses readStdinJson; no file reads stdin itself', async () => {
  const files = await sources(skillsRoot);
  assert.deepEqual(stdinViolations(files), []);
  const direct = [...files].filter(([, text]) => readsStdinDirectly(text)).map(([name]) => name).sort();
  assert.deepEqual(direct, [owner, ...terminalReaders].sort(), 'only the shared reader and the terminal-only credential entry touch process.stdin');
  const shared = [...files].filter(([name, text]) => name !== owner && sharedRead.test(text)).map(([name]) => name).sort();
  assert.deepEqual(shared, Object.keys(consumers).sort(), 'the conformance list is exactly the set of JSON readers');
});

test('conformance check fails when a consumer reads standard input directly or a new reader is unlisted', async () => {
  const files = await sources(skillsRoot);
  const name = 'maa-core/scripts/preferences.ts';
  const direct = new Map(files).set(name, files.get(name)!.replace(/await readStdinJson\([^)]*\)/, `JSON.parse(await (async () => { let raw = ''; for await (const chunk of process.stdin) raw += chunk; return raw; })())`));
  assert.notEqual(direct.get(name), files.get(name), 'the mutation applied');
  assert.deepEqual(stdinViolations(direct), [`${name}: does not use readStdinJson`, `${name}: reads standard input directly`]);
  const unlisted = new Map(files).set('maa-daily/scripts/new-tool.ts', 'const input = await readStdinJson({ maxBytes: null });');
  assert.deepEqual(stdinViolations(unlisted), ['maa-daily/scripts/new-tool.ts: reads standard input but is not in the conformance list']);
  const directForms = [
    "const text = readFileSync(0, 'utf8');", 'const text = fs.readFileSync(0);', "const text = readFileSync('/dev/stdin', 'utf8');", "fs.readFile(0, 'utf8', done);",
    'const read = readSync(0, buffer);', 'const read = fs.readSync( 0, buffer, 0, 1024, null);',
    'const { stdin } = process;', "for await (const chunk of process['stdin']) raw += chunk;",
    "import { stdin } from 'node:process';", 'import { stdin } from "process";', "import { argv, stdin as input } from 'node:process';",
    "import {\n  stdin as input,\n} from 'process';",
    "import * as proc from 'node:process'; for await (const chunk of proc.stdin) raw += chunk;",
    "import proc from 'process'; const input = proc['stdin'];", "import proc, { argv } from 'node:process'; const { stdin } = proc;",
    "const input = require('process').stdin;", "const input = require('node:process')['stdin'];",
    "const proc = require('node:process'); proc.stdin.on('data', read);", "const { stdin: input } = require('process');",
    "const input = (await import('node:process')).stdin;", "const { stdin: input } = await import('node:process');",
    'const proc = process; proc.stdin.on(\'data\', read);',
  ];
  for (const source of directForms) {
    const other = new Map(files).set('maa-core/scripts/other.ts', source);
    assert.deepEqual(stdinViolations(other), ['maa-core/scripts/other.ts: reads standard input directly'], source);
  }
  // Not standard input: a child process's own stdin, and other members of node:process.
  for (const source of ["import { argv } from 'node:process';", "import * as proc from 'node:process'; const args = proc.argv;",
    "const proc = require('process'); proc.exitCode = 1;", "child.stdin.end(input);", 'const read = readSync(fd, buffer);']) {
    const other = new Map(files).set('maa-core/scripts/other.ts', source);
    assert.deepEqual(stdinViolations(other), [], source);
  }
});

test('conformance: every listed CLI refuses a marked request with a ? as input-encoding-lossy and writes nothing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-stdin-conformance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), privateDirectory = join(root, 'private'), maaDirectory = join(root, 'maa');
  for (const directory of [home, privateDirectory, maaDirectory]) await mkdir(directory);
  const config = JSON.stringify({ privateDirectory, maaDirectory });
  await writeFile(join(home, 'config.json'), config);
  const env = { ...process.env, HOME: root, USERPROFILE: root, MAA_SKILLS_HOME: home, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata') };
  // Even if the mark were ignored, `?` is no key any CLI accepts, so nothing past input validation can run.
  const input = bytes('{"?":1}\r\n', true);
  for (const [name, { args }] of Object.entries(consumers)) {
    const result = spawnSync(process.execPath, [join(skillsRoot, name), ...args], { input, encoding: 'utf8', cwd: root, env, timeout: 60_000 });
    assert.notEqual(result.status, 0, `${name} must refuse`);
    assert.match(result.stdout + result.stderr, /"input-encoding-lossy"/, `${name}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /Error:|\n\s+at |[A-Z]:\\/, `${name} prints no stack or path`);
  }
  assert.deepEqual(await readdir(privateDirectory, { recursive: true }), [], 'no CLI wrote into the private directory');
  assert.deepEqual(await readdir(maaDirectory, { recursive: true }), [], 'no CLI touched the MAA directory');
  assert.deepEqual(await readdir(home), ['config.json']);
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), config);
});

test('conformance: the interface doc of every reader and each operating SKILL.md tell the agent how to pipe JSON from Windows PowerShell', async () => {
  const docs = [...new Set([...Object.values(consumers).map(entry => entry.doc), 'maa-core/SKILL.md',
    ...['maa-account', 'maa-daily', 'maa-doctor', 'maa-setup'].map(skill => `${skill}/SKILL.md`)])];
  for (const doc of docs) {
    const text = await readFile(join(skillsRoot, doc), 'utf8');
    assert.match(text, /Windows PowerShell[^\n]*非 ASCII 字符和 `\?` 都?写成 `\\uXXXX` 转义/, doc);
    if (!doc.endsWith('/SKILL.md') || doc === 'maa-core/SKILL.md') assert.match(text, /input-encoding-lossy/, doc);
  }
});

const specPath = fileURLToPath(new URL('../docs/spec.md', import.meta.url));
/** The generic form the rule names; every other target of 写成 on a line about escapes is a worked example. */
const escapePlaceholder = '\\uXXXX';
/** Each worked escape example on a line about escapes: the quoted text before 写成 (when there is one) and the backticked form after it. */
function escapeExamples(text: string): { source?: string; target: string }[] {
  const examples: { source?: string; target: string }[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('转义')) continue;
    for (const [, quoted, coded, target] of line.matchAll(/(?:「([^」\n]+)」|`([^`\n]+)`)?[^`「」，。；（）\n]{0,10}?写成\s*`([^`\n]*)`/g)) {
      if (target !== escapePlaceholder) examples.push({ source: quoted ?? coded, target: target! });
    }
  }
  return examples;
}

test('conformance: every escape example in the skills and the spec is a real \\uXXXX escape of the text it shows', async () => {
  const docs = (await readdir(skillsRoot, { recursive: true })).map(entry => String(entry).replaceAll('\\', '/')).filter(name => name.endsWith('.md'));
  const texts = new Map<string, string>([...await Promise.all(docs.map(async doc => [doc, await readFile(join(skillsRoot, doc), 'utf8')] as const)),
    ['docs/spec.md', await readFile(specPath, 'utf8')]]);
  for (const [doc, text] of texts) {
    for (const { source, target } of escapeExamples(text)) {
      assert.match(target, /^(?:\\u[0-9a-fA-F]{4})+$/, `${doc}: \`${target}\` is not written as \\uXXXX escapes`);
      assert.doesNotMatch(target, /[^\x00-\x7f]|\?/, `${doc}: \`${target}\` still holds the raw character`);
      if (source !== undefined) assert.equal(JSON.parse(`"${target}"`), source, `${doc}: \`${target}\` does not spell ${source}`);
    }
  }
  for (const doc of ['maa-core/SKILL.md', 'maa-core/references/preferences.md', 'docs/spec.md']) {
    assert.ok(escapeExamples(texts.get(doc)!).length > 0, `${doc} shows a worked example`);
  }
  // Without a byte order mark (a code page 936 console) a lost character cannot be told from a real `?`.
  for (const doc of ['maa-core/SKILL.md', 'maa-core/references/preferences.md']) {
    assert.match(texts.get(doc)!, /代码页 936[^\n]*不加 BOM[^\n]*一律转义[^\n]*不要靠 `input-encoding-lossy`/, doc);
  }
});

// ---- A real Windows PowerShell 5.1 pipe (the evaluation host's shell). Never touches the network. ---------------------

/** JSON with every non-ASCII character and every `?` written as a \uXXXX escape, the form the docs ask for. */
const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[^\x20-\x3e\x40-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

test('Windows PowerShell pipes reach preferences.ts and account-snapshot.ts: ASCII and escaped JSON work, bare non-ASCII is refused', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-stdin-powershell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), privateDirectory = join(root, '私有'), callbacks = join(root, '中文目录');
  for (const directory of [home, privateDirectory, callbacks]) await mkdir(directory);
  await writeFile(join(home, 'config.json'), JSON.stringify({ privateDirectory }));
  await writeFile(join(callbacks, 'callbacks.json'), JSON.stringify([
    { taskchain: 'Depot', what: 'DepotInfo', details: { done: true, data: { '4001': 1200 } } },
    { taskchain: 'OperBox', what: 'OperBoxInfo', details: { done: true, own_opers: [{ id: 'char_001_synthetic', name: '合成干员', own: true, elite: 1, level: 30 }] } },
  ]));
  const env = { ...process.env, HOME: root, USERPROFILE: root, MAA_SKILLS_HOME: home };
  const script = (name: string) => join(skillsRoot, 'maa-core/scripts', name);
  // The console input encoding decides the mark: UTF-8 (code page 65001, the evaluation host) adds it; 936 does not.
  const pipe = (json: string, name: string, action: string, codePage = 65001) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::InputEncoding = [System.Text.Encoding]::GetEncoding(${codePage}); ${quoted(json)} | & ${quoted(process.execPath)} ${quoted(script(name))} ${action}`],
  { encoding: 'utf8', env, cwd: root, timeout: 60_000, windowsHide: true });

  const read = pipe('{"currentLanguage":"zh-CN"}', 'preferences.ts', 'read');
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.equal(JSON.parse(read.stdout).ok, true);

  const words = '以后用英文?';
  for (const codePage of [65001, 936]) {
    const append = pipe(asciiJson({ text: words, source: `stdin-json test ${codePage}` }), 'preferences.ts', 'append', codePage);
    assert.equal(append.status, 0, append.stdout + append.stderr);
  }
  const saved = (await readFile(join(privateDirectory, 'preferences.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).text);
  assert.deepEqual(saved, [words, words], 'escaped text is stored verbatim under both console code pages');

  const bare = pipe(JSON.stringify({ text: words, source: 'stdin-json test bare' }), 'preferences.ts', 'append');
  assert.equal(bare.status, 1);
  assert.deepEqual(JSON.parse(bare.stderr), { ok: false, error: 'input-encoding-lossy' });
  assert.equal((await readFile(join(privateDirectory, 'preferences.jsonl'), 'utf8')).trim().split('\n').length, 2, 'the mangled words were not stored');

  const request = { callbackFile: join(callbacks, 'callbacks.json'), currentLanguage: 'zh-CN' };
  const inspect = pipe(asciiJson(request), 'account-snapshot.ts', 'inspect');
  assert.equal(inspect.status, 0, inspect.stdout + inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).operatorCount, 1);
  const lossy = pipe(JSON.stringify(request), 'account-snapshot.ts', 'inspect');
  assert.equal(lossy.status, 1);
  assert.deepEqual(JSON.parse(lossy.stderr), { ok: false, error: 'input-encoding-lossy' });
  assert.deepEqual(await readdir(privateDirectory), ['preferences.jsonl'], 'inspect stays read-only');
});
