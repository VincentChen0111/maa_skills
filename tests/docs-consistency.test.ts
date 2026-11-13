import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarioCatalog, entryId } from '../scripts/eval-scenarios.ts';
import type { ScenarioDefinition } from '../scripts/eval-run.ts';

const skills = fileURLToPath(new URL('../skills/', import.meta.url));
const scripts = join(skills, 'maa-core/scripts');

/**
 * Command-line contract of every shared script: the actions each accepts and the top-level standard-input keys each action
 * accepts, transcribed from the scripts' own validation. The first test binds every name here to a string literal in the
 * script source, so a renamed or removed action or key fails until this table and the docs are corrected together.
 */
const contract: Record<string, Record<string, string[]>> = {
  'preferences.ts': { read: ['currentLanguage'], set: ['language', 'languageAsked', 'privateDirectory', 'maaDirectory', 'server'], append: ['date', 'source', 'text'] },
  'maa-config.ts': { read: [], write: ['host', 'expectedRevision', 'closedConfirmed', 'authorization', 'changes'] },
  'doctor.ts': { check: [], repair: ['host', 'approved', 'reference', 'evidenceRevision', 'closedConfirmed', 'medicineCount'] },
  'setup.ts': { check: ['maaDirectory'], prepare: [], discover: ['adbPaths', 'addresses'], test: ['adbPaths', 'addresses', 'discoveryRevision', 'candidate'],
    apply: ['adbPaths', 'addresses', 'discoveryRevision', 'candidate', 'host', 'reference', 'closedConfirmed'] },
  'stage-jobs.ts': { stages: ['codes', 'tablesFile'], query: ['request', 'tablesFile', 'jobsFile', 'operator', 'format', 'saveReport'],
    prepare: ['approval', 'profile', 'host', 'expectedRevision', 'closedConfirmed'] },
  'account-snapshot.ts': { inspect: ['callbackFile', 'depotFile', 'operBoxFile', 'currentLanguage', 'format'], import: ['callbackFile', 'depotFile', 'operBoxFile', 'currentLanguage', 'format'] },
  'operator-cost.ts': { query: ['name', 'operatorId', 'target', 'current', 'mode', 'snapshotFile', 'format'] },
  'cultivation-gaps.ts': { query: ['targets', 'progress', 'inventory', 'mode', 'snapshotFile', 'format'] },
  'training-time.ts': { query: ['name', 'operatorId', 'skill', 'target', 'current', 'facts', 'tablesFile', 'snapshotFile', 'format'] },
  'training-plan.ts': { prepare: ['query', 'authorization', 'binding', 'currentTrainee', 'manualTraining'], read: ['id'], refresh: ['id', 'query'],
    apply: ['id', 'host', 'closedConfirmed'], reconcile: ['id', 'logFile', 'host', 'closedConfirmed'] },
  'base-query.ts': { query: ['operators', 'room', 'tablesFile', 'snapshotFile', 'format', 'currentLanguage'] },
};

type Mention = { file: string; line: number; script: string; action?: string; flags: string };
/** `action` undefined means the docs do not name one; the keys must then all belong to a single action of the script. */
type Example = { file: string; line: number; text: string; script?: string; action?: string };

async function documents(): Promise<string[]> {
  const result: string[] = [];
  for (const skill of await readdir(skills, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    result.push(join(skill.name, 'SKILL.md'));
    try { for (const name of await readdir(join(skills, skill.name, 'references'))) if (name.endsWith('.md')) result.push(join(skill.name, 'references', name)); }
    catch { /* no references */ }
  }
  return result.map((path) => path.replaceAll('\\', '/')).sort();
}

/**
 * A command is `<script>.ts` optionally followed by an action word and flags, or a code span holding only an action of the
 * script in context (`read`, `repair --json`). The script in context is the one named last, reset to the file's primary script
 * (its first `scripts/` path) at each heading. An example JSON is a ```json block, or an inline code span that is `{}` or starts
 * with `{"`; spans with unquoted keys or placeholder values (`{id,host}`, `{ "x": 表 }`) are field notation, not examples.
 * An example takes the action named explicitly on its own line (or, for a block, in the two lines above it, or at the start
 * of the line above), else its table row's first cell, else the single action span on its line; otherwise none.
 */
async function extract(): Promise<{ mentions: Mention[]; examples: Example[] }> {
  const mentions: Mention[] = []; const examples: Example[] = [];
  const explicit = /([a-z][a-z0-9-]*\.ts)(?:\s+([a-z][a-z-]*))?((?:\s+--[a-z-]+)*)/g;
  for (const file of await documents()) {
    const lines = (await readFile(join(skills, file), 'utf8')).split(/\r?\n/);
    const all = lines.flatMap((line) => [...line.matchAll(explicit)].map((match) => ({ script: match[1]!, path: line.slice(Math.max(0, match.index! - 8), match.index!).includes('scripts/') })));
    const primary = (all.find((item) => item.path) ?? all[0])?.script;
    let current = primary;
    const actionSpans = (line: string, script: string | undefined) => !script || !contract[script] ? [] : [...line.matchAll(/`([a-z][a-z-]*)((?:\s+--[a-z-]+)*)`/g)]
      .filter((match) => Object.hasOwn(contract[script]!, match[1]!)).map((match) => ({ action: match[1]!, flags: (match[2] ?? '').trim(), start: match.index! }));
    const explicitOn = (line: string) => [...line.matchAll(explicit)].filter((match) => match[2]).map((match) => ({ script: match[1]!, action: match[2]! }));
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (/^#/.test(line)) current = primary;
      if (line.trim() === '```json') {
        const end = lines.indexOf('```', index + 1);
        const above = lines.slice(0, index).filter((item) => item.trim()).slice(-2);
        const named = above.flatMap(explicitOn).at(-1);
        const leading = above.length ? actionSpans(above.at(-1)!, current).find((span) => above.at(-1)!.trimStart().startsWith('`') && span.start === above.at(-1)!.indexOf('`')) : undefined;
        examples.push({ file, line: index + 1, text: lines.slice(index + 1, end).join('\n'), ...(named ?? (current ? { script: current, ...(leading ? { action: leading.action } : {}) } : {})) });
        index = end; continue;
      }
      const found = [...line.matchAll(explicit)];
      for (const match of found) {
        mentions.push({ file, line: index + 1, script: match[1]!, ...(match[2] ? { action: match[2] } : {}), flags: (match[3] ?? '').trim() });
        current = match[1]!;
      }
      const spans = actionSpans(line, current);
      for (const span of spans) mentions.push({ file, line: index + 1, script: current!, action: span.action, flags: span.flags });
      const row = line.match(/^\|\s*`([a-z][a-z-]*)`\s*\|/);
      const own = explicitOn(line).at(-1);
      const distinct = [...new Set(spans.map((span) => span.action))];
      for (const span of line.matchAll(/`(\{[^`]*\})`/g)) {
        if (span[1] !== '{}' && !span[1]!.startsWith('{"')) continue;
        const action = own?.action ?? (row && current && contract[current]?.[row[1]!] ? row[1] : distinct.length === 1 ? distinct[0] : undefined);
        examples.push({ file, line: index + 1, text: span[1]!, ...(own ? { script: own.script } : current ? { script: current } : {}), ...(action ? { action } : {}) });
      }
    }
  }
  return { mentions, examples };
}

test('the contract names only actions and keys that appear in each script source', async () => {
  for (const [script, actions] of Object.entries(contract)) {
    const source = await readFile(join(scripts, script), 'utf8');
    for (const [action, keys] of Object.entries(actions)) for (const name of [action, ...keys]) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(source), `${script}: ${name} does not occur in the script; update the contract and the docs together`);
    }
  }
});

test('every script command and example JSON in SKILL.md and references matches the shared scripts', async () => {
  const { mentions, examples } = await extract();
  const problems: string[] = [];
  const available = new Set(await readdir(scripts));
  for (const mention of mentions) {
    const where = `skills/${mention.file}:${mention.line}`;
    if (!available.has(mention.script)) { problems.push(`${where}: ${mention.script} does not exist in maa-core/scripts`); continue; }
    if (mention.action && contract[mention.script] && !Object.hasOwn(contract[mention.script]!, mention.action)) problems.push(`${where}: ${mention.script} has no action ${mention.action}`);
  }
  assert.ok(examples.length >= 15, 'the extraction still finds the documented examples');
  for (const example of examples) {
    const where = `skills/${example.file}:${example.line}`;
    let value: unknown;
    try { value = JSON.parse(example.text); } catch { problems.push(`${where}: example JSON does not parse`); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${where}: example JSON is not an object`); continue; }
    const actions = example.script ? contract[example.script] : undefined;
    if (!actions || example.action && !actions[example.action]) { problems.push(`${where}: example JSON is not tied to a known script action (${example.script ?? '?'} ${example.action ?? '?'})`); continue; }
    const keys = Object.keys(value);
    const candidates = example.action ? [example.action] : Object.keys(actions);
    if (!candidates.some((action) => keys.every((key) => actions[action]!.includes(key)))) {
      problems.push(`${where}: no single ${example.script} action ${example.action ?? `(${candidates.join('/')})`} accepts keys ${keys.filter((key) => !candidates.some((action) => actions[action]!.includes(key))).join(', ') || keys.join(', ')}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every scenario allowlist admits the documented command form of each script call it expects', async () => {
  const { mentions } = await extract();
  const documented = (script: string, action: string) => mentions.filter((item) => item.script === script && item.action === action);
  const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const problems: string[] = [];
  for (const entry of scenarioCatalog()) {
    const definition = entry.definition as ScenarioDefinition;
    const commands = definition.commands ?? definition.policy.expectedCalls;
    for (const call of definition.policy.expectedInvocations ?? []) {
      const [skill, , script] = call.file.split('/');
      const forms = documented(script!, call.action);
      if (!forms.length) { problems.push(`${entryId(entry)}: ${script} ${call.action} is not documented in any skill`); continue; }
      for (const layout of ['.agents', '.claude']) for (const form of new Set(forms.map((item) => item.flags))) {
        const command = `node ${layout}/skills/${skill}/scripts/${script} ${call.action}${form ? ` ${form}` : ''}`;
        if (!commands.some((pattern) => glob(pattern).test(command))) problems.push(`${entryId(entry)}: no allowlist pattern admits "${command}"`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
