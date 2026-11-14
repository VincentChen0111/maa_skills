import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarioCatalog, entryId } from '../scripts/eval-scenarios.ts';
import type { ScenarioDefinition } from '../scripts/eval-run.ts';
import { repositoryTools } from '../scripts/release-check.ts';

const skills = fileURLToPath(new URL('../skills/', import.meta.url));
const scripts = join(skills, 'maa-core/scripts');

/**
 * Command-line contract of every shared script: the actions each accepts and the top-level standard-input keys each action
 * accepts, transcribed from the scripts' own validation. The first test binds every name here to a string literal in the
 * script source (or a shared module it imports), so a renamed or removed action or key fails until this table and the docs are
 * corrected together.
 */
const planKeys = ['title', 'description', 'layout', 'shifts', 'fill', 'mood', 'moodDefault', 'combos', 'exclusions', 'efficiency', 'tolerance', 'runs'];
const reportActions = { read: ['reportHash', 'format'], brief: ['reportHash'], review: ['reportHash', 'format', 'reviewer', 'briefSha256', 'findings'],
  fail: ['reportHash', 'format', 'reviewer', 'reason', 'detail'], skip: ['reportHash', 'format', 'userWords'], approve: ['reportHash', 'format', 'items', 'userWords'] };
const contract: Record<string, Record<string, string[]>> = {
  'preferences.ts': { read: ['currentLanguage'], set: ['language', 'languageAsked', 'privateDirectory', 'maaDirectory', 'server'], append: ['date', 'source', 'text'] },
  'maa-config.ts': { read: [], write: ['host', 'expectedRevision', 'closedConfirmed', 'authorization', 'changes'] },
  'doctor.ts': { check: [], analyze: ['run', 'interfaceUnobscured', 'conclusion', 'processExitCode'],
    repair: ['host', 'approved', 'reference', 'evidenceRevision', 'closedConfirmed', 'medicineCount'] },
  'setup.ts': { check: ['maaDirectory'], prepare: [], discover: ['adbPaths', 'addresses'], test: ['adbPaths', 'addresses', 'discoveryRevision', 'candidate'],
    apply: ['adbPaths', 'addresses', 'discoveryRevision', 'candidate', 'host', 'reference', 'closedConfirmed'],
    // Ticket 08's download and recheck actions, transcribed from the same validation (`downloadActions` in setup.ts).
    plan: ['program', 'vendor', 'url', 'version'], download: ['program', 'planId', 'fingerprint', 'reference', 'termsAccepted', 'vendor', 'url', 'version'],
    install: ['planId', 'target'], downloads: [], recheck: ['adbPaths', 'addresses', 'candidate'] },
  'stage-jobs.ts': { stages: ['codes', 'tablesFile'], query: ['request', 'tablesFile', 'jobsFile', 'operator', 'format', 'saveReport'],
    prepare: ['approval', 'profile', 'host', 'expectedRevision', 'closedConfirmed'] },
  'account-snapshot.ts': { inspect: ['callbackFile', 'depotFile', 'operBoxFile', 'currentLanguage', 'format'], import: ['callbackFile', 'depotFile', 'operBoxFile', 'currentLanguage', 'format'] },
  'operator-cost.ts': { query: ['name', 'operatorId', 'target', 'current', 'mode', 'snapshotFile', 'format'] },
  'cultivation-gaps.ts': { query: ['targets', 'progress', 'inventory', 'mode', 'snapshotFile', 'format'] },
  'training-time.ts': { query: ['name', 'operatorId', 'skill', 'target', 'current', 'facts', 'tablesFile', 'snapshotFile', 'format'] },
  'training-plan.ts': { prepare: ['query', 'authorization', 'binding', 'currentTrainee', 'manualTraining'], read: ['id'], refresh: ['id', 'query'],
    apply: ['id', 'host', 'closedConfirmed'], reconcile: ['id', 'logFile', 'host', 'closedConfirmed'] },
  'base-query.ts': { query: ['operators', 'room', 'tablesFile', 'snapshotFile', 'format', 'currentLanguage'] },
  // `check [--json]` and `input <service> [--stdin]` take no JSON on standard input (input reads terminal answers).
  'credentials.ts': { check: [], input: [] },
  'stage-run.ts': { start: ['operation', 'reference', 'retryOf'], observe: ['runId', 'waitSeconds', 'userReport', 'processExitCode'], verify: ['runId'],
    decide: ['runId', 'decision', 'reason'], progress: ['runId', 'reference', 'stages'], switch: ['runId', 'stageId', 'expectedRevision', 'host', 'closedConfirmed'],
    read: ['runId'] },
  // search and read accept `format` beside the request keys the reader validates; status reads no input.
  'nga.ts': { search: ['keyword', 'forum', 'pages', 'fresh', 'cacheOnly', 'format'], read: ['thread', 'pages', 'fresh', 'cacheOnly', 'format'], status: [] },
  // Ticket 19's readers, in the same form: read takes `format` beside the request keys it validates; status reads no input.
  'skland-community.ts': { read: ['post', 'fresh', 'cacheOnly', 'format'], status: [] },
  'bilibili.ts': { read: ['video', 'part', 'subtitles', 'fresh', 'cacheOnly', 'format'], status: [] },
  'skland-account.ts': { inspect: ['currentLanguage', 'format'], import: ['currentLanguage', 'format'], compare: ['currentLanguage', 'format', 'maaFile', 'sklandFile'] },
  // The two report tools: review, fail, skip and approve take `reportHash` and `format` beside the record keys the shared
  // advice-report library checks; the base report draft takes the base plan proposal keys beside its own.
  'cultivation-report.ts': { draft: ['priorities', 'steps', 'evidence', 'assumptions', 'summary', 'progress', 'inventory', 'mode', 'snapshotFile', 'revisionOf', 'format'],
    ...reportActions },
  'base-report.ts': { draft: ['goals', 'assumptions', 'summary', 'revisionOf', ...planKeys, 'target', 'base', 'snapshotFile', 'tablesFile', 'format'], ...reportActions,
    freshness: ['reportHash'] },
  'base-plan.ts': { generate: [...planKeys, 'target', 'base', 'snapshotFile', 'tablesFile', 'format'],
    check: ['planFile', 'layout', 'shifts', 'mood', 'moodDefault', 'combos', 'exclusions', 'efficiency', 'tolerance', 'runs', 'snapshotFile', 'tablesFile', 'format'],
    candidates: ['layout', 'snapshotFile', 'tablesFile', 'format'] },
  'base-apply.ts': { check: ['reference', 'profile', 'task', 'decision'], apply: ['reference', 'profile', 'task', 'decision', 'host', 'expectedRevision', 'closedConfirmed'] },
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
 * A command is `<script>.ts` optionally followed by an action word and flags, or a code span holding only an action (`read`,
 * `repair --json`): of the script in context, else of the document's primary script (its first `scripts/` path). The script in
 * context is the one named last, reset to the primary script at each heading. An example JSON is a ```json block (fences may be
 * indented; an unclosed block runs to the end of the document), or an inline code span that is `{}` or starts with `{"`; spans
 * with unquoted keys or placeholder values (`{id,host}`, `{ "x": 表 }`, `{"ok":…}`) are field notation, not examples.
 * A block takes an action span that follows the last explicit `script action` on the line above it, else the action named
 * explicitly in the two lines above, else the action span starting the line above; an inline example takes the action named
 * explicitly on its own line, else its table row's first cell, else the single action span on its line; otherwise none.
 */
function extractDocument(file: string, text: string): { mentions: Mention[]; examples: Example[] } {
  const mentions: Mention[] = []; const examples: Example[] = [];
  // A script name starts a word: the tail of a longer file name (`tests/research.test.ts`) is not a script.
  const explicit = /(?<![\w.-])([a-z][a-z0-9-]*\.ts)(?:\s+([a-z][a-z-]*))?((?:\s+--[a-z-]+)*)/g;
  const lines = text.split(/\r?\n/);
  const all = lines.flatMap((line) => [...line.matchAll(explicit)].map((match) => ({ script: match[1]!, path: line.slice(Math.max(0, match.index! - 8), match.index!).includes('scripts/') })));
  const primary = (all.find((item) => item.path) ?? all[0])?.script;
  // A document that names no script (the reviewer brief, whose JSON is the reviewer's reply) holds no script input examples.
  if (!primary) return { mentions, examples };
  let current = primary;
  const owner = (action: string, script: string | undefined) => [script, primary].find((name) => name && contract[name] && Object.hasOwn(contract[name]!, action));
  const actionSpans = (line: string, script: string | undefined) => [...line.matchAll(/`([a-z][a-z-]*)((?:\s+--[a-z-]+)*)`/g)]
    .flatMap((match) => { const found = owner(match[1]!, script); return found ? [{ script: found, action: match[1]!, flags: (match[2] ?? '').trim(), start: match.index! }] : []; });
  const explicitOn = (line: string) => [...line.matchAll(explicit)].filter((match) => match[2]).map((match) => ({ script: match[1]!, action: match[2]!, start: match.index! }));
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^#/.test(line)) current = primary;
    if (line.trim() === '```json') {
      // The closing fence may be indented like the opening one (a block inside a list item); without one the block runs to
      // the end. Either way the scan moves forward only, so each line is read once.
      let end = index + 1;
      while (end < lines.length && lines[end]!.trim() !== '```') end++;
      const above: string[] = [];
      for (let back = index - 1; back >= 0 && above.length < 2; back--) if (lines[back]!.trim()) above.unshift(lines[back]!);
      // An action span after the last explicit name on the line above wins ("run `maa-config.ts read`, then `switch`:").
      const last = above.at(-1) ?? '';
      const explicitLast = explicitOn(last).at(-1);
      const after = explicitLast ? actionSpans(last, current).filter((span) => span.start > explicitLast.start).at(-1) : undefined;
      const leading = last.trimStart().startsWith('`') ? actionSpans(last, current).find((span) => span.start === last.indexOf('`')) : undefined;
      const named = after ?? above.flatMap(explicitOn).at(-1) ?? leading;
      examples.push({ file, line: index + 1, text: lines.slice(index + 1, end).join('\n'),
        ...(named ? { script: named.script, action: named.action } : current ? { script: current } : {}) });
      index = end; continue;
    }
    const found = [...line.matchAll(explicit)];
    for (const match of found) {
      mentions.push({ file, line: index + 1, script: match[1]!, ...(match[2] ? { action: match[2] } : {}), flags: (match[3] ?? '').trim() });
      current = match[1]!;
    }
    const spans = actionSpans(line, current);
    for (const span of spans) mentions.push({ file, line: index + 1, script: span.script, action: span.action, flags: span.flags });
    const row = line.match(/^\|\s*`([a-z][a-z-]*)`\s*\|/);
    const rowOwner = row ? owner(row[1]!, current) : undefined;
    const own = explicitOn(line).at(-1);
    const distinct = [...new Map(spans.map((span) => [`${span.script} ${span.action}`, span])).values()];
    for (const span of line.matchAll(/`(\{[^`]*\})`/g)) {
      if (span[1] !== '{}' && !span[1]!.startsWith('{"')) continue;
      // `…` standing for a value (`{"ok":false,"error":…}`) marks a shape, not an input to pass.
      if (/:\s*…/.test(span[1]!)) continue;
      const named = own ?? (row && rowOwner ? { script: rowOwner, action: row[1]! } : distinct.length === 1 ? distinct[0] : undefined);
      examples.push({ file, line: index + 1, text: span[1]!, ...(named ? { script: named.script, action: named.action } : current ? { script: current } : {}) });
    }
  }
  return { mentions, examples };
}

/**
 * An example's value. An unquoted `<…>` placeholder right after a colon stands for a number the agent fills in
 * (`"completedRuns":<次数>`); it parses as 0, so the keys around it are still checked. Anything else must be JSON.
 */
function exampleValue(text: string): unknown {
  return JSON.parse(text.replace(/(:\s*)<[^<>"\n]+>/g, (_, colon: string) => `${colon}0`));
}

async function extract(): Promise<{ mentions: Mention[]; examples: Example[] }> {
  const mentions: Mention[] = []; const examples: Example[] = [];
  for (const file of await documents()) {
    const found = extractDocument(file, await readFile(join(skills, file), 'utf8'));
    mentions.push(...found.mentions); examples.push(...found.examples);
  }
  return { mentions, examples };
}

test('the contract names only actions and keys that appear in each script source', async () => {
  for (const [script, actions] of Object.entries(contract)) {
    // The script and the shared maa-core modules it imports directly (the report tools validate review records in advice-report.ts,
    // the base report draft validates the proposal in base-plan.ts).
    const own = await readFile(join(scripts, script), 'utf8');
    const shared = await Promise.all([...new Set([...own.matchAll(/^\s*import\b[^;]*?\sfrom\s+'\.\/([a-z0-9-]+\.ts)'/gm)].map((match) => match[1]!))]
      .map((name) => readFile(join(scripts, name), 'utf8')));
    const source = [own, ...shared].join('\n');
    for (const [action, keys] of Object.entries(actions)) for (const name of [action, ...keys]) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(source), `${script}: ${name} does not occur in the script; update the contract and the docs together`);
    }
  }
});

test('the extraction passes over each document once: an indented fence closes at its indented closing line, an unclosed one runs to the end', () => {
  // The shape of skills/maa-daily/references/stage-run.md: a ```json block inside a numbered list item, both fences indented.
  // The closing fence used to be looked up as an unindented line; finding none sent the scan back to the first line, forever.
  const indented = extractDocument('synthetic.md', ['# 标题', '', '共享入口为 `node scripts/training-plan.ts <action>`。', '2. 先运行 `read`：', '',
    '   ```json', '   {"id":"x"}', '   ```', '', '然后 `training-plan.ts refresh`。'].join('\n'));
  assert.deepEqual(indented.examples, [{ file: 'synthetic.md', line: 6, text: '   {"id":"x"}', script: 'training-plan.ts' }]);
  assert.deepEqual(indented.mentions.map((mention) => [mention.line, mention.script, mention.action]),
    [[3, 'training-plan.ts', undefined], [4, 'training-plan.ts', 'read'], [10, 'training-plan.ts', 'refresh']]);
  // An unclosed fence runs to the end of the document (as in CommonMark); its text then fails to parse and is reported.
  const unclosed = extractDocument('synthetic.md', ['`training-plan.ts read`：', '```json', '{"id":"x"}', '', '`training-plan.ts apply`'].join('\n'));
  assert.deepEqual(unclosed.examples, [{ file: 'synthetic.md', line: 2, text: '{"id":"x"}\n\n`training-plan.ts apply`', script: 'training-plan.ts', action: 'read' }]);
  assert.deepEqual(unclosed.mentions.map((mention) => mention.line), [1]);
  // The other two shapes the merged references brought: a repository test file is not a script mention, and an unquoted
  // number placeholder leaves the keys checkable while other broken JSON still fails.
  assert.deepEqual(extractDocument('synthetic.md', '`tests/research.test.ts` 的一致性测试；`training-plan.ts read`').mentions.map((mention) => mention.script), ['training-plan.ts']);
  assert.deepEqual(exampleValue('{"runId":"<runId>","stages":[{"stageId":"<关卡>","completedRuns":<次数>}]}'), { runId: '<runId>', stages: [{ stageId: '<关卡>', completedRuns: 0 }] });
  assert.throws(() => exampleValue('{"runId":<runId>,}'));
  assert.throws(() => exampleValue('{"runId":"<runId>" "x":1}'));
});

test('the extraction ties examples to the action the text names: the primary script after a detour, a later action span, shapes and briefs', () => {
  // configuration.md: a line about base-apply.ts, then `write` of the document's own maa-config.ts introduces the block.
  const detour = extractDocument('synthetic.md', ['入口：`../maa-core/scripts/maa-config.ts`。', '排班只经 `base-apply.ts apply` 写入。', '`read` 输出摘要。', '',
    '`write` 输入示例：', '', '```json', '{"host":"codex"}', '```'].join('\n'));
  assert.deepEqual(detour.examples.map((example) => [example.script, example.action]), [['maa-config.ts', 'write']]);
  assert.deepEqual(detour.mentions.map((mention) => [mention.line, mention.script, mention.action]),
    [[1, 'maa-config.ts', undefined], [2, 'base-apply.ts', 'apply'], [3, 'maa-config.ts', 'read'], [5, 'maa-config.ts', 'write']]);
  // stage-run.md: "run `maa-config.ts read` for the revision, then run `switch`:" introduces a switch input, not a read input.
  const later = extractDocument('synthetic.md', ['共享入口为 `node scripts/stage-run.ts <action>`。', '先运行 `maa-config.ts read` 拿到 `revision`，再运行 `switch`：', '',
    '   ```json', '   {"runId":"x"}', '   ```'].join('\n'));
  assert.deepEqual(later.examples.map((example) => [example.script, example.action]), [['stage-run.ts', 'switch']]);
  // A shape with `…` values is field notation; a document that names no script (a reviewer brief) holds no input examples.
  assert.deepEqual(extractDocument('synthetic.md', '`skland-account.ts import` 失败时输出 `{"ok":false,"error":…}`。').examples, []);
  assert.deepEqual(extractDocument('synthetic.md', ['只回复一个 JSON 代码块：', '```json', '{"findings":[]}', '```'].join('\n')).examples, []);
});

test('every script command and example JSON in SKILL.md and references matches the shared scripts', async () => {
  const { mentions, examples } = await extract();
  const problems: string[] = [];
  const available = new Set(await readdir(scripts));
  // Repository maintenance tools the docs name (one list, owned by the release package check, which does not require them in an
  // install). Each must exist in the repository's scripts/ and still be named, so the list cannot hide a later mention.
  const repositoryScripts = new Set(await readdir(join(skills, '..', 'scripts')));
  const unnamedTools = new Set(Object.keys(repositoryTools));
  for (const mention of mentions) {
    const where = `skills/${mention.file}:${mention.line}`;
    if (!available.has(mention.script) && repositoryTools[mention.script] && repositoryScripts.has(mention.script) && !mention.action) { unnamedTools.delete(mention.script); continue; }
    if (!available.has(mention.script)) { problems.push(`${where}: ${mention.script} does not exist in maa-core/scripts`); continue; }
    if (mention.action && contract[mention.script] && !Object.hasOwn(contract[mention.script]!, mention.action)) problems.push(`${where}: ${mention.script} has no action ${mention.action}`);
  }
  for (const tool of unnamedTools) problems.push(`${tool}: listed as a repository tool but no longer named in the docs, or not in the repository's scripts/`);
  assert.ok(examples.length >= 15, 'the extraction still finds the documented examples');
  // JSON that is quoted in the docs but is not standard input to a script, with what it is. Each entry must still occur, so the
  // list cannot hide a later example.
  const notInput: Record<string, Record<string, string>> = {
    'maa-core/references/base-plan.md': { '{"skip": true}': 'a room value in the exported MAA plan file' },
  };
  const unseen = new Set(Object.entries(notInput).flatMap(([file, texts]) => Object.keys(texts).map((text) => `${file} ${text}`)));
  for (const example of examples) {
    const where = `skills/${example.file}:${example.line}`;
    if (notInput[example.file]?.[example.text]) { unseen.delete(`${example.file} ${example.text}`); continue; }
    let value: unknown;
    try { value = exampleValue(example.text); } catch { problems.push(`${where}: example JSON does not parse`); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${where}: example JSON is not an object`); continue; }
    const actions = example.script ? contract[example.script] : undefined;
    if (!actions || example.action && !actions[example.action]) { problems.push(`${where}: example JSON is not tied to a known script action (${example.script ?? '?'} ${example.action ?? '?'})`); continue; }
    const keys = Object.keys(value);
    const candidates = example.action ? [example.action] : Object.keys(actions);
    if (!candidates.some((action) => keys.every((key) => actions[action]!.includes(key)))) {
      problems.push(`${where}: no single ${example.script} action ${example.action ?? `(${candidates.join('/')})`} accepts keys ${keys.filter((key) => !candidates.some((action) => actions[action]!.includes(key))).join(', ') || keys.join(', ')}`);
    }
  }
  for (const entry of unseen) problems.push(`${entry}: listed as not standard input but no longer in the docs`);
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
