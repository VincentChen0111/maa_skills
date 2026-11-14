import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Issue 91 (ticket 26, package P): the Codex reviewer gets the report's review brief (`brief` writes it to a file) through a
// file redirection, never a PowerShell pipe. Windows PowerShell 5.1 re-encodes piped text: it adds a byte order mark and turns
// non-ASCII characters into `?`, so the reviewer would read a garbled brief. The exact commands live in one document, the owner
// below; every other skill document that mentions `codex exec` links there and repeats no other form.

const skillsRoot = fileURLToPath(new URL('../skills/', import.meta.url));
const owner = 'maa-core/references/advice-report.md';
const placeholder = '<file>';
const flags = '--sandbox read-only --ephemeral --skip-git-repo-check';
/** POSIX shells: the brief file redirected into `codex exec -`. */
const posixForm = new RegExp(`^codex exec ${flags} - < "${placeholder}"$`);
/** Windows PowerShell: the path goes into an environment variable that cmd expands; cmd's `<` hands the bytes over unchanged. */
const windowsForm = new RegExp(`^\\$env:([A-Z_]+) = '${placeholder}'; cmd /d /c 'codex exec ${flags} - < "%\\1%"'$`);

/** Inline code spans and the lines of fenced blocks in a Markdown text; `\|` in a table cell is a literal pipe. */
function codeSpans(text: string): string[] {
  const spans: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) spans.push(line.trim());
    else for (const [, span] of line.matchAll(/`([^`\n]+)`/g)) spans.push(span!.replaceAll('\\|', '|'));
  }
  return spans;
}
/** A span that runs `codex exec` with arguments; a bare `codex exec` names the process. */
const runsCodex = (span: string) => /\bcodex\s+exec\s+\S/.test(span);
const pipesIntoCodex = (text: string) => /\|\s*(?:&\s*)?codex\b/.test(text);

/** The two documented handoff commands, read from the owner document. */
function documentedCommands(ownerText: string): { windows: string[]; posix: string[] } {
  const commands = codeSpans(ownerText).filter(runsCodex);
  return { windows: commands.filter(span => windowsForm.test(span)), posix: commands.filter(span => posixForm.test(span)) };
}

/** Every violation of the handoff rule in a set of skill documents (path relative to skills/ → text); empty when it holds. */
function handoffViolations(docs: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  const { windows, posix: posixCommands } = documentedCommands(docs.get(owner) ?? '');
  if (windows.length !== 1) violations.push(`${owner}: ${windows.length} Windows redirection commands, expected 1`);
  if (posixCommands.length !== 1) violations.push(`${owner}: ${posixCommands.length} POSIX redirection commands, expected 1`);
  const documented = new Set([...windows, ...posixCommands]);
  for (const [doc, text] of docs) {
    for (const span of codeSpans(text)) {
      if (pipesIntoCodex(span)) violations.push(`${doc}: pipes into codex: ${span}`);
      else if (runsCodex(span) && !documented.has(span)) violations.push(`${doc}: not the documented redirection command: ${span}`);
    }
    let fenced = false;
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      else if (!fenced && !line.trimStart().startsWith('|') && pipesIntoCodex(line.replace(/`[^`\n]*`/g, ''))) {
        violations.push(`${doc}: pipes into codex in prose: ${line.trim()}`);
      }
    }
    const link = posix.relative(posix.dirname(doc), owner);
    if (doc !== owner && /\bcodex exec\b/.test(text) && !text.includes(`](${link})`)) violations.push(`${doc}: mentions codex exec without linking ${link}`);
  }
  return violations.sort();
}

async function skillDocuments(): Promise<Map<string, string>> {
  const names = (await readdir(skillsRoot, { recursive: true })).map(name => String(name).replaceAll('\\', '/')).filter(name => name.endsWith('.md')).sort();
  return new Map(await Promise.all(names.map(async name => [name, await readFile(join(skillsRoot, name), 'utf8')] as const)));
}

test('conformance: every codex exec command in the skills hands the brief over by file redirection, never by a pipe', async () => {
  const docs = await skillDocuments();
  assert.deepEqual(handoffViolations(docs), []);
  const { windows, posix: posixCommands } = documentedCommands(docs.get(owner)!);
  assert.equal(windows[0]!.match(windowsForm)![1], 'MAA_REVIEW_BRIEF');
  assert.ok(posixCommands.length === 1);
  const text = docs.get(owner)!;
  // The forbidden form is named with its reason, next to the commands.
  assert.match(text, /不要用[^\n]*PowerShell 管道[^\n]*`codex exec`[^\n]*PowerShell 5\.1[^\n]*BOM[^\n]*`\?`/);
  // A reply that shows the reviewer could not read the brief is no verdict: step 4 records `fail`.
  assert.match(text, /^4\. [^\n]*没读到说明[^\n]*乱码[^\n]*`\?`[^\n]*`fail`/m);
  assert.match(docs.get('maa-help/references/hosts.md')!, /\]\(\.\.\/\.\.\/maa-core\/references\/advice-report\.md\)/);
});

test('conformance check fails on the old stdin form, a pipe, a restated variant and a mention without the link', async () => {
  const docs = await skillDocuments();
  const hosts = 'maa-help/references/hosts.md';
  const ownerText = docs.get(owner)!, hostsText = docs.get(hosts)!;
  const { windows, posix: posixCommands } = documentedCommands(ownerText);
  const mutate = (doc: string, text: string) => { assert.notEqual(text, docs.get(doc), `the mutation of ${doc} applied`); return handoffViolations(new Map(docs).set(doc, text)); };

  const oldForm = mutate(owner, ownerText.replace(`\`${windows[0]}\``, `\`codex exec ${flags} -\``));
  assert.ok(oldForm.includes(`${owner}: 0 Windows redirection commands, expected 1`), oldForm.join('\n'));
  assert.ok(oldForm.includes(`${owner}: not the documented redirection command: codex exec ${flags} -`), oldForm.join('\n'));

  const piped = mutate(hosts, `${hostsText}\n\`Get-Content -Raw '${placeholder}' | codex exec ${flags} -\`\n`);
  assert.deepEqual(piped, [`${hosts}: pipes into codex: Get-Content -Raw '${placeholder}' | codex exec ${flags} -`]);
  const fenced = mutate(hosts, `${hostsText}\n\`\`\`powershell\nGet-Content '${placeholder}' | & codex exec -\n\`\`\`\n`);
  assert.deepEqual(fenced, [`${hosts}: pipes into codex: Get-Content '${placeholder}' | & codex exec -`]);
  const prose = mutate(hosts, `${hostsText}\nGet-Content ${placeholder} | codex exec -\n`);
  assert.deepEqual(prose, [`${hosts}: pipes into codex in prose: Get-Content ${placeholder} | codex exec -`]);

  const variant = `codex exec --ephemeral - < "${placeholder}"`;
  assert.deepEqual(mutate(hosts, `${hostsText}\n\`${variant}\`\n`), [`${hosts}: not the documented redirection command: ${variant}`]);
  assert.deepEqual(mutate(hosts, `${hostsText}\n\`${posixCommands[0]}\`\n`), [], 'repeating a documented command verbatim is allowed');

  const unlinked = mutate(hosts, hostsText.replaceAll('../../maa-core/references/advice-report.md', '../../maa-core/references/report-review.md'));
  assert.deepEqual(unlinked, [`${hosts}: mentions codex exec without linking ../../maa-core/references/advice-report.md`]);
});

// ---- A real Windows PowerShell 5.1 and cmd. A fake codex.cmd stands in for codex: no model, no network. ---------------

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';

test('Windows: the documented command hands a Chinese brief at a path with a space, Chinese, a quote and % to codex exec byte for byte', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maa-brief-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), record = join(root, 'received.json');
  await mkdir(bin);
  // The fake codex records its arguments and the SHA-256 and bytes of everything it read on standard input.
  await writeFile(join(bin, 'receive.mjs'), [
    "import { createHash } from 'node:crypto';",
    "import { writeFileSync } from 'node:fs';",
    'const parts = []; for await (const part of process.stdin) parts.push(part);',
    'const bytes = Buffer.concat(parts);',
    `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }));`,
    '',
  ].join('\n'));
  await writeFile(join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${join(bin, 'receive.mjs')}" %*\r\n`);
  // CODEX_HOME points at an empty directory: even a real codex found by mistake would have no login and could not call a model.
  const env = { ...process.env, [pathKey]: `${bin};${process.env[pathKey] ?? ''}`, CODEX_HOME: join(root, 'codex-home') };
  const powershell = (command: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', env, cwd: root, timeout: 60_000, windowsHide: true });
  const received = async (command: string) => {
    await rm(record, { force: true });
    const run = powershell(command);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    return JSON.parse(await readFile(record, 'utf8')) as { args: string[]; sha256: string; base64: string };
  };

  // Guard: both PowerShell and cmd resolve codex to the fake before anything runs it.
  const resolved = powershell('(Get-Command codex).Source; cmd /d /c where codex');
  assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
  // Compare canonical long paths: PowerShell keeps an 8.3 short TEMP (CI runners use RUNNER~1) while `where` prints the long form.
  // A line that is not an existing file throws here, so the guard still fails closed.
  const canonical = (file: string) => realpathSync.native(file).toLowerCase();
  const fake = canonical(join(bin, 'codex.cmd'));
  assert.deepEqual(resolved.stdout.trim().split(/\r?\n/).slice(0, 2).map(line => canonical(line.trim())), [fake, fake]);

  const chinese = '审查说明：只看这份培养报告，第 1 步「精英化」花费是否算对？';
  const brief = Buffer.from(`# ${chinese}\r\n\r\n报告全文 {"S1":"合成干员 → 精英1"} 🙂 ?\n`, 'utf8');
  // A space, Chinese, a single quote (the one character the documented command asks to double) and %PATH%, which cmd must not
  // expand a second time.
  const directory = join(root, 'with space', "审查 目录 o'k %PATH%");
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'review-brief.md');
  await writeFile(file, brief);

  const { windows, posix: posixCommands } = documentedCommands(await readFile(join(skillsRoot, owner), 'utf8'));
  assert.equal(windows.length, 1, 'advice-report.md documents one Windows command');
  const command = windows[0]!.replace(placeholder, file.replaceAll("'", "''"));
  const args = posixCommands[0]!.replace(/^codex /, '').replace(/ < .*$/, '').split(' ');
  // The command as documented, then under the two console code pages the stdin-json tests cover (UTF-8 and Chinese Windows' 936).
  for (const prefix of ['', '[Console]::InputEncoding = [System.Text.Encoding]::GetEncoding(65001); ', '[Console]::InputEncoding = [System.Text.Encoding]::GetEncoding(936); ']) {
    const result = await received(prefix + command);
    assert.deepEqual(result.args, args, prefix);
    assert.equal(result.sha256, sha256(brief), `the reviewer reads the brief's exact bytes ${prefix}`);
  }

  // Why the pipe is forbidden: the same brief piped from PowerShell arrives changed.
  for (const codePage of [65001, 936]) {
    const piped = await received(`[Console]::InputEncoding = [System.Text.Encoding]::GetEncoding(${codePage}); `
      + `Get-Content -Raw -Encoding UTF8 -LiteralPath '${file.replaceAll("'", "''")}' | codex ${args.join(' ')}`);
    const text = Buffer.from(piped.base64, 'base64').toString('utf8');
    if (piped.sha256 === sha256(brief)) { t.diagnostic(`code page ${codePage}: this runner's PowerShell pipe kept the brief's bytes`); continue; }
    assert.notEqual(piped.sha256, sha256(brief));
    t.diagnostic(`code page ${codePage}: the PowerShell pipe changed the brief: byte order mark ${text.startsWith('﻿')}, Chinese kept ${text.includes(chinese)}`);
  }
});
