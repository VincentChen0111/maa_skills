import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordedStdinJson } from '../scripts/eval-daily.ts';

/**
 * 26 H3 (R1) conformance: the grader reads a product CLI's recorded standard input only through scripts/eval-daily.ts.
 * There, `recordedStdinBytes` is the one place an observation's recorded stdin (`inputBase64`, or `input` in a record from
 * before the round-1 fix) is taken, and only two functions take those bytes, each through the CLI's own reader
 * `decodeStdinJson` (skills/maa-core/scripts/stdin-json.ts): `recordedStdinJson`, the request as the CLI read it, and
 * `refusedRequestMatches`, which only compares a refused write with the counted write.
 *
 * Every file of the evaluation framework (scripts/eval-*.ts, scripts/evaluation.ts, eval/**) is checked, whether or not it
 * names the journal, so a helper module that receives a recorded entry is caught too: no file may read an `input` property
 * that is not listed below as something other than recorded stdin, mention `inputBase64` (only the observer writes it), or
 * parse an `input` itself. The lists of files that read their own standard input or reach the journal stay exact.
 */
const repository = fileURLToPath(new URL('..', import.meta.url));
const owner = 'scripts/eval-daily.ts';
const observer = 'eval/daily-observer.mjs';
const bytesReader = 'recordedStdinBytes';
const decoders = ['recordedStdinJson', 'refusedRequestMatches'];

/** Files that read their own process's standard input, and why that is not a product CLI's recorded request. */
const stdinReaders: Record<string, string> = {
  [observer]: 'records the product CLI\'s standard input as it passes through, as bytes, without decoding or parsing it',
  'eval/host-double.mjs': 'the host double reads the prompt the runner gives the host',
  'eval/review-double.mjs': 'the reviewer double reads the review brief as text (byte order mark and CRLF normalised), never as JSON',
};
/** Files that reach the daily journal or its observations, and what each does with the recorded stdin. */
const journalReaders: Record<string, string> = {
  [observer]: 'writes the journal',
  'scripts/eval-fixture.ts': 'collects the journal records into the evidence; never reads input',
  'scripts/eval-preflight.ts': 'reads the observed actions of the double run; never reads input',
  [owner]: `grades the transaction; takes input only in ${bytesReader}`,
};
/** Reads of an `input` property that is not a product CLI's recorded stdin, exactly as they appear in each file. */
const otherInputReads: Record<string, { reads: string[]; reason: string }> = {
  'scripts/evaluation.ts': { reads: ['block.input', 'block.input', 'call.input', 'call.input'],
    reason: 'a tool-use block of the host\'s stream, and a transcript call\'s input: the text of the host\'s tool call' },
  'scripts/eval-auth.ts': { reads: ['call.input', 'call.input', 'call.input', 'call.input'], reason: 'a transcript call\'s input: the text of the host\'s tool call' },
  'eval/host-double.mjs': { reads: ['step.input'], reason: 'a script step of the double: what it pipes to a command, before any observer sees it' },
};

const readsStdin = /\bprocess\s*(?:\??\.\s*stdin\b|\[\s*['"`]stdin)|\bread(?:File)?Sync\(\s*(?:0\s*[,)]|['"`]\/dev\/stdin)|\bfrom\s+['"`](?:node:)?process['"`]/;
const reachesJournal = /\bobservations\b|MAA_EVAL_DAILY_JOURNAL|eval-daily-observations/;
/**
 * An `input` read: a property access (with what it is read from), an index, or a destructuring in an assignment or a
 * parameter list, with or without renaming and with or without a type annotation. A brace preceded by `:`, `&`, `|` or `<`
 * is a type literal, not a destructuring.
 */
const inputReads = [/(?:[\w$]+|[\])!])\s*\??\.\s*input\b/g, /\[\s*['"`]input['"`]\s*\]/g,
  /(?<![:&|<]\s*)\{[^{}]*\binput\b[^{}]*\}\s*(?::\s*(?:\{[^{}]*\}|[^=;(){}])*)?(?:=(?![=>])|\)\s*(?:=>|\{|:))/g];
const recordedBytes = /\binputBase64\b/;
const parsesInput = /JSON\.parse\(\s*[^)]*\binput(?:Base64)?\b/;
/** A top-level function with its doc comment; group 1 is the body. */
const functionPattern = (name: string) => new RegExp(String.raw`(?:\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*)?(?:export\s+)?function ${name}\([^)]*\)[^{]*\{([\s\S]*?)\n\}`);
const cliReader = /import\s*\{[^}]*\bdecodeStdinJson\b[^}]*\}\s*from\s*'\.\.\/skills\/maa-core\/scripts\/stdin-json\.ts'/;

const module = /\.(?:[cm]?[jt]s)$/;
const framework = (name: string) => /^scripts\/(?:eval-.*|evaluation)\.ts$/.test(name) || name.startsWith('eval/') && module.test(name);
const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"`](\.{1,2}\/[^'"`]+)['"`]/g;

/**
 * The framework files, and every repository module they import (statically or dynamically, transitively), so a helper the
 * framework hands a recorded entry to is checked wherever it lives. Modules under skills/ are the product being graded,
 * not the framework (the CLI's own reader is there); `overrides` replaces or adds files for the counter-examples.
 */
async function sources(overrides: Record<string, string> = {}): Promise<Map<string, string>> {
  const roots = [...(await readdir(join(repository, 'scripts'))).map((name) => `scripts/${name}`),
    ...(await readdir(join(repository, 'eval'), { recursive: true })).map((entry) => `eval/${String(entry).replaceAll('\\', '/')}`), ...Object.keys(overrides)];
  const queue = roots.filter(framework);
  const files = new Map<string, string>();
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (files.has(name)) continue;
    const text = Object.hasOwn(overrides, name) ? overrides[name] : await readFile(join(repository, name), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    files.set(name, text);
    for (const [, specifier] of text.matchAll(importSpecifier)) {
      const target = posix.normalize(posix.join(posix.dirname(name), specifier!));
      if (!target.startsWith('../') && !target.startsWith('skills/') && module.test(target)) queue.push(target);
    }
  }
  return files;
}

/** Every `input` read in `text`, whitespace removed. */
const readsOf = (text: string) => inputReads.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0].replace(/\s+/g, '')));

/** Every violation of the one-decoder rule for recorded stdin; empty when it holds. */
function recordedStdinViolations(files: Map<string, string>): string[] {
  const violations: string[] = [];
  const ownerText = files.get(owner) ?? '';
  const reader = ownerText.match(functionPattern(bytesReader))?.[0];
  if (reader === undefined) violations.push(`${owner}: ${bytesReader} is missing`);
  for (const name of decoders) {
    const body = ownerText.match(functionPattern(name))?.[1];
    if (body === undefined) violations.push(`${owner}: ${name} is missing`);
    else if (!new RegExp(String.raw`\b${bytesReader}\(`).test(body) || !/\bdecodeStdinJson\(/.test(body) || /JSON\.parse\(/.test(body)) {
      violations.push(`${owner}: ${name} does not decode the recorded bytes through decodeStdinJson`);
    }
  }
  if (!cliReader.test(ownerText)) violations.push(`${owner}: decodeStdinJson is not the CLI's own reader`);
  for (const [name, text] of files) {
    if (readsStdin.test(text) && !Object.hasOwn(stdinReaders, name)) violations.push(`${name}: reads standard input but is not in the conformance list`);
    if (reachesJournal.test(text) && !Object.hasOwn(journalReaders, name)) violations.push(`${name}: reaches the recorded stdin but is not in the conformance list`);
    // The owner's bytes reader is the one place recorded stdin is taken; every other line of every file is checked.
    const rest = name === owner && reader !== undefined ? text.replace(reader, '') : text;
    if (name !== observer && recordedBytes.test(rest)) violations.push(`${name}: reads recorded stdin bytes outside ${bytesReader}`);
    const reads = readsOf(rest).sort();
    if (reads.join('\n') !== [...otherInputReads[name]?.reads ?? []].sort().join('\n')) violations.push(`${name}: reads recorded stdin outside ${bytesReader}`);
    if (parsesInput.test(rest)) violations.push(`${name}: parses recorded stdin itself`);
    if (name === owner) {
      const outside = decoders.reduce((current, decoder) => current.replace(functionPattern(decoder), ''), rest);
      if (new RegExp(String.raw`\b${bytesReader}\(`).test(outside)) violations.push(`${owner}: takes the recorded bytes outside ${decoders.join(' and ')}`);
    }
  }
  for (const name of new Set([...Object.keys(stdinReaders), ...Object.keys(journalReaders), ...Object.keys(otherInputReads)])) {
    if (!files.has(name)) violations.push(`${name}: listed but missing`);
  }
  return violations.sort();
}

test('26 H3 conformance: every evaluation file that reads stdin or reaches recorded stdin is listed, and only recordedStdinBytes takes it, decoded through the CLI\'s reader', async () => {
  const files = await sources();
  assert.deepEqual(recordedStdinViolations(files), []);
  assert.ok([...files.keys()].some((name) => !framework(name)), 'modules the framework imports from outside its own directories are checked too');
  assert.deepEqual([...files].filter(([, text]) => readsStdin.test(text)).map(([name]) => name).sort(), Object.keys(stdinReaders).sort(), 'the stdin readers are exactly the listed ones');
  assert.deepEqual([...files].filter(([, text]) => reachesJournal.test(text)).map(([name]) => name).sort(), Object.keys(journalReaders).sort(), 'the journal readers are exactly the listed ones');
  // The owner behaves as the CLI reader on the exact recorded bytes: the pipe's mark and CRLF are read past; a mark with
  // `?` is refused as lossy; bytes that are not UTF-8 are refused, not read as U+FFFD.
  const recorded = (bytes: string | Buffer) => ({ inputBase64: Buffer.from(bytes).toString('base64') });
  assert.deepEqual(recordedStdinJson(recorded('﻿{"host":"codex"}\r\n')), { host: 'codex' });
  assert.throws(() => recordedStdinJson(recorded('﻿{"reference":"??"}')), { code: 'input-encoding-lossy' });
  assert.throws(() => recordedStdinJson(recorded(Buffer.from('7b2272223a22bfaa227d', 'hex'))), { code: 'input-encoding-lossy' });
  assert.throws(() => recordedStdinJson({}), /input-required/);
  assert.throws(() => recordedStdinJson({ inputBase64: 'not base64!' }), /bytes-required/);
  assert.throws(() => recordedStdinJson({ ...recorded('{}'), input: '{}' }), /input-ambiguous/);
  // A record written before the round-1 fix keeps only the decoded text, and is still read.
  assert.deepEqual(recordedStdinJson({ input: '﻿{"host":"codex"}\r\n' }), { host: 'codex' });
  assert.throws(() => recordedStdinJson({ input: '﻿{"reference":"??"}' }), { code: 'input-encoding-lossy' });
});

test('26 H3 conformance check fails when a consumer parses recorded stdin itself, the owner stops using the decoder, or a reader is unlisted', async () => {
  const files = await sources();
  const mutate = (name: string, from: string | RegExp, to: string) => {
    const text = files.get(name)!; const changed = text.replace(from, to);
    assert.notEqual(changed, text, `the mutation of ${name} applied: ${String(from)}`);
    return new Map(files).set(name, changed);
  };
  const outside = `${owner}: reads recorded stdin outside ${bytesReader}`;
  assert.deepEqual(recordedStdinViolations(mutate(owner, 'object(recordedStdinJson(write))', 'object(JSON.parse(write.input))')), [`${owner}: parses recorded stdin itself`, outside]);
  assert.deepEqual(recordedStdinViolations(mutate(owner, 'object(recordedStdinJson(preview))', '(({ input }) => object(input))(preview)')), [outside]);
  assert.deepEqual(recordedStdinViolations(mutate(owner, 'return decodeStdinJson(recordedStdinBytes(observation), { maxBytes: null });',
    "return JSON.parse(recordedStdinBytes(observation).toString('utf8'));")), [`${owner}: recordedStdinJson does not decode the recorded bytes through decodeStdinJson`]);
  assert.deepEqual(recordedStdinViolations(mutate(owner, 'object(recordedStdinJson(write))', "object(JSON.parse(recordedStdinBytes(write).toString('utf8')))")),
    [`${owner}: takes the recorded bytes outside ${decoders.join(' and ')}`]);
  assert.deepEqual(recordedStdinViolations(mutate(owner, 'object(recordedStdinJson(write))', "object(JSON.parse(Buffer.from(write.inputBase64, 'base64').toString()))")),
    [`${owner}: parses recorded stdin itself`, `${owner}: reads recorded stdin bytes outside ${bytesReader}`]);
  const fixture = 'scripts/eval-fixture.ts';
  const collector = new Map(files).set(fixture, `${files.get(fixture)!}\nexport const firstInput = (records: { input: string }[]) => JSON.parse(records[0]!.input);\n`);
  assert.deepEqual(recordedStdinViolations(collector), [`${fixture}: parses recorded stdin itself`, `${fixture}: reads recorded stdin outside ${bytesReader}`]);
  const reader = new Map(files).set('eval/new-observer.mjs', "let raw = ''; for await (const chunk of process.stdin) raw += chunk;");
  assert.deepEqual(recordedStdinViolations(reader), ['eval/new-observer.mjs: reads standard input but is not in the conformance list']);
  for (const form of ["import { stdin } from 'node:process';", "const text = readFileSync(0, 'utf8');", "const text = readFileSync('/dev/stdin');", "const raw = process['stdin'];"]) {
    assert.deepEqual(recordedStdinViolations(new Map(files).set('eval/form.mjs', form)), ['eval/form.mjs: reads standard input but is not in the conformance list'], form);
  }
  const consumer = new Map(files).set('scripts/eval-new.ts', 'export const requests = (evidence: any) => evidence.daily.observations.map((item: any) => item.input);');
  assert.deepEqual(recordedStdinViolations(consumer), ['scripts/eval-new.ts: reaches the recorded stdin but is not in the conformance list',
    `scripts/eval-new.ts: reads recorded stdin outside ${bytesReader}`]);
  const removed = new Map(files); removed.delete('eval/review-double.mjs');
  assert.deepEqual(recordedStdinViolations(removed), ['eval/review-double.mjs: listed but missing']);
  // A listed reader of a transcript call's input gains one more `input` read.
  assert.deepEqual(recordedStdinViolations(mutate('scripts/evaluation.ts', 'call.input === command', 'call.input === command && call.input')), ['scripts/evaluation.ts: reads recorded stdin outside recordedStdinBytes']);
});

test('26 H3 round-1 fix: a typed destructuring with renaming, and a helper module that receives the recorded entry without naming the journal, both fail the check', async () => {
  const files = await sources();
  const outside = (name: string) => `${name}: reads recorded stdin outside ${bytesReader}`;
  // (a) In the owner: destructuring with renaming and a type annotation, as an arrow parameter, a function parameter and a declaration.
  for (const form of ['(({ input: raw }: Value) => object(JSON.parse(raw)))(preview)', '(function ({ input: raw }: { input: string }): unknown { return object(JSON.parse(raw)); })(preview)',
    '(() => { const { input: raw }: Value = preview; return object(JSON.parse(raw)); })()']) {
    const typed = new Map(files).set(owner, files.get(owner)!.replace('object(recordedStdinJson(preview))', form));
    assert.notEqual(typed.get(owner), files.get(owner), form);
    assert.deepEqual(recordedStdinViolations(typed), [outside(owner)], form);
  }
  // (b) A helper module the owner hands the recorded entry to; it does not name the journal or its observations. The
  // enumeration reaches it through the owner's import, also outside scripts/eval-*.ts and eval/.
  const helpers: [string, string, string[]][] = [
    ['scripts/eval-request.ts', 'export const requestOf = (entry: { input: string }) => JSON.parse(entry.input);\n',
      ['scripts/eval-request.ts: parses recorded stdin itself', outside('scripts/eval-request.ts')]],
    ['scripts/request-helper.ts', 'export const requestOf = (entry: { input: string }) => JSON.parse(entry.input);\n',
      ['scripts/request-helper.ts: parses recorded stdin itself', outside('scripts/request-helper.ts')]],
    ['scripts/request-helper.ts', 'export function requestOf(entry: Record<string, string>) { const text = entry.input; return JSON.parse(text); }\n',
      [outside('scripts/request-helper.ts')]],
    ['scripts/request-helper.ts', 'export const requestOf = ({ input: raw }: { input: string }) => JSON.parse(raw);\n', [outside('scripts/request-helper.ts')]],
    ['eval/request.mjs', "export const requestOf = (entry) => JSON.parse(Buffer.from(entry.inputBase64, 'base64').toString());\n",
      ['eval/request.mjs: parses recorded stdin itself', 'eval/request.mjs: reads recorded stdin bytes outside recordedStdinBytes']],
  ];
  for (const [name, text, expected] of helpers) {
    const specifier = name.startsWith('eval/') ? '../eval/request.mjs' : `./${name.slice('scripts/'.length)}`;
    const importing = `import { requestOf } from '${specifier}';\n${files.get(owner)!.replace('object(recordedStdinJson(preview))', 'object(requestOf(preview))')}`;
    const changed = await sources({ [owner]: importing, [name]: text });
    assert.ok(changed.has(name), `the enumeration reaches ${name}`);
    assert.equal(reachesJournal.test(text), false, 'the helper does not name the journal');
    assert.deepEqual(recordedStdinViolations(changed), expected, text);
  }
});
