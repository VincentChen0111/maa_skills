// Reviewer double for the evaluation runner (ticket 26, package H, decision D2). A report's independent reviewer is another
// host process, a system boundary, so evaluations replace it: the fixture installs this file as `.eval-review-double.mjs` and
// puts `.eval-bin/codex.cmd` and `.eval-bin/codex`, which run it, first on the PATH of every fixture with skills. It never
// calls a model and never reviews anything: it answers the reviewer call the report skill prescribes
// (`codex exec --sandbox read-only --ephemeral --skip-git-repo-check -`, the brief on standard input) when the brief is
// one of this run's review briefs, with the reply format of maa-core's references/report-review.md and no findings.
// Usage (through the shims): codex exec [options] [-] < <review brief>
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const refuse = (message) => { process.stderr.write(`maa-eval-review-double: ${message}\n`); process.exit(1); };

// Mistaken for a host, the double reports a double's version (scripts/eval-host.ts `doubleVersionPrefix`): a run started
// through it is marked a double, never a baseline. The runner itself never resolves its host through the fixture PATH.
if (args.length === 1 && args[0] === '--version') { process.stdout.write('maa-eval-host-double review-double (reviewer shim)\n'); process.exit(0); }
if (args[0] !== 'exec') refuse('only `codex exec ... -` with this run\'s review brief on standard input is answered');

// `codex exec` options that take a value; every other argument starting with `-` is a flag. What remains is the prompt.
const valued = new Set(['-c', '--config', '-m', '--model', '-s', '--sandbox', '-C', '--cd', '-p', '--profile', '-o', '--output-last-message',
  '--color', '-i', '--image', '--output-schema', '--add-dir', '--enable', '--disable', '--local-provider']);
const positional = []; let output; let json = false;
for (let index = 1; index < args.length; index++) {
  const arg = args[index];
  if (arg === '-' || !arg.startsWith('-')) { positional.push(arg); continue; }
  const [name, inline] = arg.includes('=') && arg.startsWith('--') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
  if (name === '--json') json = true;
  if (valued.has(name)) {
    const value = inline ?? args[++index];
    if (name === '-o' || name === '--output-last-message') output = value;
  }
}
if (positional.length > 1 || positional.length === 1 && positional[0] !== '-') refuse('the review brief must arrive on standard input (`-`), not as a prompt or subcommand');

// Transport differences a reviewer reads past (a Windows pipe's byte-order mark, CRLF line ends, trailing newlines) are
// normalised on both sides; any other difference, such as characters a pipe replaced with `?`, means it is not the brief.
const normalise = (text) => text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const digest = (text) => createHash('sha256').update(normalise(text)).digest('hex');
let received = '';
try { received = readFileSync(0, 'utf8'); } catch { /* no standard input */ }
const briefs = [];
const walk = (directory) => {
  let entries = [];
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && entry.name === 'review-brief.md') briefs.push(path);
  }
};
walk(join(workspace, 'private'));
const brief = received.trim() ? briefs.find((file) => digest(readFileSync(file, 'utf8')) === digest(received)) : undefined;
if (!brief) refuse('the review brief on standard input is not one of this run\'s review briefs');

// The report tools keep each version's brief at <private>/reports/<kind>/<reportHash>/review-brief.md.
const reportHash = basename(dirname(brief));
const message = ['```json', JSON.stringify({ reportHash, findings: [] }), '```'].join('\n');
if (output) writeFileSync(resolve(process.cwd(), output), message);
if (json) {
  for (const event of [{ type: 'thread.started', thread_id: randomUUID() }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: message } },
    { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }]) process.stdout.write(`${JSON.stringify(event)}\n`);
} else process.stdout.write(`${message}\n`);
