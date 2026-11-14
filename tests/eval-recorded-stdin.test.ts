import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordedStdinJson } from '../scripts/eval-daily.ts';

/**
 * 26 H3 (R1) conformance: the grader reads a product CLI's recorded standard input only through `recordedStdinJson`
 * (scripts/eval-daily.ts), which decodes it with the CLI's own reader `decodeStdinJson` (skills/maa-core/scripts/stdin-json.ts).
 * The list below is every file of the evaluation framework (scripts/eval-*.ts, scripts/evaluation.ts, eval/**) that reads
 * standard input or reaches the recorded stdin (the daily journal and its observations); the check fails when a file joins
 * either set unlisted, or when any file other than the owner reads an observation's `input` or parses it itself.
 */
const repository = fileURLToPath(new URL('..', import.meta.url));
const owner = 'scripts/eval-daily.ts';

/** Files that read their own process's standard input, and why that is not a product CLI's recorded request. */
const stdinReaders: Record<string, string> = {
  'eval/daily-observer.mjs': 'records the product CLI\'s standard input as it passes through, without parsing it',
  'eval/host-double.mjs': 'the host double reads the prompt the runner gives the host',
  'eval/review-double.mjs': 'the reviewer double reads the review brief as text (byte order mark and CRLF normalised), never as JSON',
};
/** Files that reach the daily journal or its observations, and what each does with the recorded stdin. */
const journalReaders: Record<string, string> = {
  'eval/daily-observer.mjs': 'writes the journal',
  'scripts/eval-fixture.ts': 'collects the journal records into the evidence; never reads input',
  'scripts/eval-preflight.ts': 'reads the observed actions of the double run; never reads input',
  [owner]: 'grades the transaction; reads input only through recordedStdinJson',
};

const readsStdin = /\bprocess\s*(?:\??\.\s*stdin\b|\[\s*['"`]stdin)|\bread(?:File)?Sync\(\s*(?:0\s*[,)]|['"`]\/dev\/stdin)|\bfrom\s+['"`](?:node:)?process['"`]/;
const reachesJournal = /\bobservations\b|MAA_EVAL_DAILY_JOURNAL|eval-daily-observations/;
/** An observation's `input`: a property access, an index, or a destructuring (in an assignment or a parameter list). */
const readsInput = /\.\s*input\b|\[\s*['"`]input['"`]\s*\]|\{[^{}]*\binput\b[^{}]*\}\s*(?:=(?![=>])|\)\s*(?:=>|\{))/;
const parsesInput = /JSON\.parse\(\s*[^)]*\binput\b/;
const ownerFunction = /export function recordedStdinJson\([^)]*\)[^{]*\{([\s\S]*?)\n\}/;

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of await readdir(join(repository, 'scripts'))) {
    if (/^eval-.*\.ts$/.test(name) || name === 'evaluation.ts') files.set(`scripts/${name}`, await readFile(join(repository, 'scripts', name), 'utf8'));
  }
  for (const entry of await readdir(join(repository, 'eval'), { recursive: true })) {
    const name = String(entry).replaceAll('\\', '/');
    if (/\.(?:[cm]?[jt]s)$/.test(name)) files.set(`eval/${name}`, await readFile(join(repository, 'eval', name), 'utf8'));
  }
  return files;
}

/** Every violation of the one-decoder rule for recorded stdin; empty when it holds. */
function recordedStdinViolations(files: Map<string, string>): string[] {
  const violations: string[] = [];
  const ownerText = files.get(owner) ?? '';
  const body = ownerText.match(ownerFunction)?.[1];
  if (body === undefined) violations.push(`${owner}: recordedStdinJson is missing`);
  else {
    if (!/\bdecodeStdinJson\(/.test(body) || /JSON\.parse\(/.test(body)) violations.push(`${owner}: recordedStdinJson does not decode through decodeStdinJson`);
    if (!/import\s*\{[^}]*\bdecodeStdinJson\b[^}]*\}\s*from\s*'\.\.\/skills\/maa-core\/scripts\/stdin-json\.ts'/.test(ownerText)) {
      violations.push(`${owner}: decodeStdinJson is not the CLI's own reader`);
    }
  }
  for (const [name, text] of files) {
    if (readsStdin.test(text) && !Object.hasOwn(stdinReaders, name)) violations.push(`${name}: reads standard input but is not in the conformance list`);
    if (reachesJournal.test(text) && !Object.hasOwn(journalReaders, name)) violations.push(`${name}: reaches the recorded stdin but is not in the conformance list`);
    if (!Object.hasOwn(journalReaders, name) && !reachesJournal.test(text)) continue;
    // The owner's own body is the one place an observation's input is read.
    const rest = name === owner && body !== undefined ? text.replace(ownerFunction, '') : text;
    if (name !== 'eval/daily-observer.mjs' && readsInput.test(rest)) violations.push(`${name}: reads recorded stdin outside recordedStdinJson`);
    if (parsesInput.test(rest)) violations.push(`${name}: parses recorded stdin itself`);
  }
  for (const name of new Set([...Object.keys(stdinReaders), ...Object.keys(journalReaders)])) if (!files.has(name)) violations.push(`${name}: listed but missing`);
  return violations.sort();
}

test('26 H3 conformance: every evaluation file that reads stdin or reaches recorded stdin is listed, and only recordedStdinJson reads it, through the CLI\'s decoder', async () => {
  const files = await sources();
  assert.deepEqual(recordedStdinViolations(files), []);
  assert.deepEqual([...files].filter(([, text]) => readsStdin.test(text)).map(([name]) => name).sort(), Object.keys(stdinReaders).sort(), 'the stdin readers are exactly the listed ones');
  assert.deepEqual([...files].filter(([, text]) => reachesJournal.test(text)).map(([name]) => name).sort(), Object.keys(journalReaders).sort(), 'the journal readers are exactly the listed ones');
  // The owner behaves as the CLI reader: the pipe's mark and CRLF are read past; a mark with `?` is refused as lossy.
  assert.deepEqual(recordedStdinJson({ input: '\uFEFF{"host":"codex"}\r\n' }), { host: 'codex' });
  assert.throws(() => recordedStdinJson({ input: '\uFEFF{"reference":"??"}' }), { code: 'input-encoding-lossy' });
  assert.throws(() => recordedStdinJson({}), /input-required/);
});

test('26 H3 conformance check fails when a consumer parses recorded stdin itself, the owner stops using the decoder, or a reader is unlisted', async () => {
  const files = await sources();
  const direct = new Map(files).set(owner, files.get(owner)!.replace('object(recordedStdinJson(write))', 'object(JSON.parse(write.input))'));
  assert.notEqual(direct.get(owner), files.get(owner), 'the mutation applied');
  assert.deepEqual(recordedStdinViolations(direct), [`${owner}: parses recorded stdin itself`, `${owner}: reads recorded stdin outside recordedStdinJson`]);
  const destructured = new Map(files).set(owner, files.get(owner)!.replace('object(recordedStdinJson(preview))', '(({ input }) => object(input))(preview)'));
  assert.notEqual(destructured.get(owner), files.get(owner), 'the mutation applied');
  assert.deepEqual(recordedStdinViolations(destructured), [`${owner}: reads recorded stdin outside recordedStdinJson`]);
  const bypassed = new Map(files).set(owner, files.get(owner)!.replace(/return decodeStdinJson\([^;]*;/, 'return JSON.parse(observation.input);'));
  assert.notEqual(bypassed.get(owner), files.get(owner), 'the mutation applied');
  assert.deepEqual(recordedStdinViolations(bypassed), [`${owner}: recordedStdinJson does not decode through decodeStdinJson`]);
  const fixture = 'scripts/eval-fixture.ts';
  const collector = new Map(files).set(fixture, `${files.get(fixture)!}\nexport const firstInput = (records: { input: string }[]) => JSON.parse(records[0]!.input);\n`);
  assert.deepEqual(recordedStdinViolations(collector), [`${fixture}: parses recorded stdin itself`, `${fixture}: reads recorded stdin outside recordedStdinJson`]);
  const reader = new Map(files).set('eval/new-observer.mjs', "let raw = ''; for await (const chunk of process.stdin) raw += chunk;");
  assert.deepEqual(recordedStdinViolations(reader), ['eval/new-observer.mjs: reads standard input but is not in the conformance list']);
  for (const form of ["import { stdin } from 'node:process';", "const text = readFileSync(0, 'utf8');", "const text = readFileSync('/dev/stdin');", "const raw = process['stdin'];"]) {
    assert.deepEqual(recordedStdinViolations(new Map(files).set('eval/form.mjs', form)), ['eval/form.mjs: reads standard input but is not in the conformance list'], form);
  }
  const consumer = new Map(files).set('scripts/eval-new.ts', 'export const requests = (evidence: any) => evidence.daily.observations.map((item: any) => item.input);');
  assert.deepEqual(recordedStdinViolations(consumer), ['scripts/eval-new.ts: reaches the recorded stdin but is not in the conformance list',
    'scripts/eval-new.ts: reads recorded stdin outside recordedStdinJson']);
  const removed = new Map(files); removed.delete('eval/review-double.mjs');
  assert.deepEqual(recordedStdinViolations(removed), ['eval/review-double.mjs: listed but missing']);
});
