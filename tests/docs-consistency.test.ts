import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
  'maa-config.ts': { read: [], preview: ['host', 'expectedRevision', 'closedConfirmed', 'authorization', 'changes'],
    write: ['host', 'expectedRevision', 'closedConfirmed', 'authorization', 'changes', 'diffFingerprint'] },
  'doctor.ts': { check: [], analyze: ['run', 'interfaceUnobscured', 'conclusion', 'processExitCode'],
    repair: ['host', 'approved', 'reference', 'evidenceRevision', 'closedConfirmed', 'medicineCount', 'stoneCount', 'expiringMedicine'] },
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
    apply: ['id', 'host', 'closedConfirmed', 'expiringMedicine', 'reference'], reconcile: ['id', 'logFile', 'host', 'closedConfirmed', 'expiringMedicine', 'reference'] },
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

/** `column`: where the mention starts on its line, so a claim can be tied to the sentence or table cell that holds it. */
type Mention = { file: string; line: number; column: number; script: string; action?: string; flags: string };
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
      mentions.push({ file, line: index + 1, column: match.index!, script: match[1]!, ...(match[2] ? { action: match[2] } : {}), flags: (match[3] ?? '').trim() });
      current = match[1]!;
    }
    const spans = actionSpans(line, current);
    for (const span of spans) mentions.push({ file, line: index + 1, column: span.start, script: span.script, action: span.action, flags: span.flags });
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

/*
 * Writing commands (ticket 26, package P, round 2). The same defect showed up twice: the maa-daily references (round 1) and
 * then the doctor triage table (round 2) called a doctor command read-only although it saves a record. So one table owns
 * which commands write, the scripts' code decides whether the table is complete, and one scan holds every skill document to it.
 */

/**
 * The functions each command-line action of a shared script calls, as the script's command-line block dispatches them. This is
 * the input of the derivation, not a claim about writing: the test below requires the block to call each of them and follows them
 * through the scripts' code to every file write they reach. Which branch of the block calls which function is read off the block
 * by hand; every function the block calls that reaches a write must be listed under some action.
 */
const commandCalls: Record<string, Record<string, string[]>> = {
  'preferences.ts': { read: ['readSettings', 'startup'], set: ['updateSettings'], append: ['appendPreference'] },
  'maa-config.ts': { read: ['inspectConfiguration'], preview: ['previewConfigWrite'], write: ['executeConfigWrite'] },
  'doctor.ts': { check: ['runChecks'], analyze: ['runAnalysis'], repair: ['executeRepairs'] },
  'setup.ts': { check: ['checkSetup'], prepare: ['prepareSetup'], discover: ['discoverSetupConnections'], test: ['testSetupConnection'],
    apply: ['applySetupConnection'], plan: ['planSetupDownload'], download: ['downloadSetupProgram'], install: ['installSetupDownload'],
    downloads: ['setupDownloadStatus'], recheck: ['recheckSetup'] },
  'stage-jobs.ts': { stages: ['loadStageTables'], query: ['loadStageTables', 'matchStageJobs', 'collectStageJobs', 'readVersionStamp'],
    prepare: ['prepareStageJobs'] },
  'account-snapshot.ts': { inspect: ['inspectMaaSnapshot'], import: ['importMaaSnapshot'] },
  'operator-cost.ts': { query: ['queryOperatorCost'] },
  'cultivation-gaps.ts': { query: ['queryCultivationGaps'] },
  'training-time.ts': { query: ['queryTraining'] },
  'training-plan.ts': { prepare: ['prepareTrainingPlan'], read: ['readTrainingPlan'], refresh: ['refreshTrainingMaterials'],
    apply: ['applyTrainingPlan'], reconcile: ['reconcileTrainingPlan'] },
  'base-query.ts': { query: ['queryBaseSkills', 'queryPublicBaseSkills'] },
  'credentials.ts': { check: ['inspectCredentials'], input: ['runInput'] },
  'stage-run.ts': { start: ['startStageRun'], observe: ['observeStageRun'], verify: ['verifyStageRun'], decide: ['decideStageRun'],
    progress: ['recordStageProgress'], switch: ['switchStageRun'], read: ['readStageRun', 'summarizeStageRun', 'loadBatchView'] },
  'nga.ts': { search: ['searchNga'], read: ['readNgaThread'], status: ['ngaStatus'] },
  'skland-community.ts': { read: ['readSklandPost'], status: ['sklandCommunityStatus'] },
  'bilibili.ts': { read: ['readBilibiliVideo'], status: ['bilibiliStatus'] },
  // One function serves both reads; it saves the snapshot only for import, and both record the credential result.
  'skland-account.ts': { inspect: ['runSklandRead'], import: ['runSklandRead'], compare: ['compareAccountSnapshots'] },
  'cultivation-report.ts': { draft: ['draftCultivationReport'], read: ['load'], brief: ['load', 'writeReviewBrief'], review: ['recordReview'],
    fail: ['recordReviewFailure'], skip: ['recordReviewSkip'], approve: ['approveReportItems'] },
  'base-report.ts': { draft: ['draftBaseReport'], read: ['loadAdviceReport'], brief: ['loadAdviceReport', 'writeReviewBrief'], review: ['recordReview'],
    fail: ['recordReviewFailure'], skip: ['recordReviewSkip'], approve: ['approveBaseReportItems'], freshness: ['baseReportFreshness'] },
  'base-plan.ts': { generate: ['generateBasePlan'], check: ['runCheck'], candidates: ['runCandidates'] },
  'base-apply.ts': { check: ['checkBaseApply'], apply: ['applyBasePlan'] },
};

type WritingCommand = { writes: string; markers: string[]; names?: string[]; onlyWith?: string };
/** The skill names the documents use for the doctor commands in prose ("交给 maa-doctor 先核对", "共享 doctor 检查"). */
const doctorNames = ['maa-doctor', 'doctor 检查', 'doctor 的检查'];
const researchWrites: WritingCommand = { writes: '私有目录里的调研缓存和读取门限记录；用了已保存的凭据时，还记下这次读取的凭据结果',
  markers: ['cache', 'gate.json', 'status.json'] };
const reportWrites = (draft: WritingCommand): Record<string, WritingCommand> => ({ draft,
  brief: { writes: '私有目录里这份报告的审查说明 review-brief.md', markers: ['review-brief.md'] },
  review: { writes: '私有目录里这份报告的审查记录 review.json', markers: ['review.json'] },
  fail: { writes: '私有目录里这份报告的审查失败记录 review-failures', markers: ['review-failures'] },
  skip: { writes: '私有目录里这份报告的跳过审查记录 review.json', markers: ['review.json'] },
  approve: { writes: '私有目录里这份报告的批准记录 approvals', markers: ['approvals'] } });
/**
 * The one table of writing commands: every shared-script action that writes a file, and what it writes. `markers` are string
 * literals of those files in the code the action reaches; `names` are the prose names skill documents use for the action besides
 * its code form; `onlyWith` is the input key without which the action writes nothing. The first test below derives the writing
 * actions from the scripts' code and requires exactly this table; the document scan after it reads only this table.
 */
const writingCommands: Record<string, Record<string, WritingCommand>> = {
  'preferences.ts': { set: { writes: '设置文件 config.json', markers: ['config.json'] },
    append: { writes: '私有目录里的偏好原话记录 preferences.jsonl', markers: ['preferences.jsonl'] } },
  'maa-config.ts': { write: { writes: 'MAA 配置 gui.new.json，私有目录里的配置备份、待执行记录和运行记录',
    markers: ['gui.new.json', 'maa-config-backups', 'daily-pending.jsonl', 'daily-runs.jsonl'] } },
  'doctor.ts': {
    check: { writes: '私有目录里的最近检查记录 doctor-latest.json', markers: ['doctor-latest'], names: doctorNames },
    analyze: { writes: '私有目录里的最近分析记录 doctor-analysis-latest.json', markers: ['doctor-analysis-latest'], names: doctorNames },
    repair: { writes: '经配置写入器改 MAA 配置或清锁，私有目录里的核对存档、配置备份和运行记录',
      markers: ['maa-config-reconciliations', 'gui.new.json', 'daily-runs.jsonl'], names: doctorNames },
  },
  'setup.ts': {
    prepare: { writes: '私有目录里的环境检查记录 setup-environment.json', markers: ['setup-environment.json'] },
    recheck: { writes: '私有目录里的环境检查记录 setup-environment.json', markers: ['setup-environment.json'] },
    apply: { writes: '经配置写入器改 MAA 的连接字段，私有目录里的配置备份和运行记录', markers: ['gui.new.json', 'daily-runs.jsonl'] },
    download: { writes: '私有目录 downloads 里的安装包和下载记录', markers: ['downloads', 'records'] },
    install: { writes: '解压到批准的目标目录，私有目录里的下载记录', markers: ['records'] },
  },
  'stage-jobs.ts': {
    query: { writes: '带 saveReport 时，私有目录里的候选报告 stage-jobs/reports', markers: ['reports'], onlyWith: 'saveReport' },
    prepare: { writes: '私有目录 stage-jobs 里批准的作业文件，经配置写入器改 MAA 的作业列表', markers: ['stage-jobs', 'gui.new.json'] },
  },
  'account-snapshot.ts': { import: { writes: '私有目录里的账号快照 account-snapshot.json', markers: ['account-snapshot.json'] } },
  'training-plan.ts': {
    prepare: { writes: '私有目录里的训练记录 training-plans', markers: ['training-plans'] },
    refresh: { writes: '私有目录里的训练记录 training-plans', markers: ['training-plans'] },
    apply: { writes: '私有目录里的训练记录，经配置写入器改 MAA 配置', markers: ['training-plans', 'gui.new.json'] },
    reconcile: { writes: '私有目录里的训练记录，经配置写入器改 MAA 配置', markers: ['training-plans', 'gui.new.json'] },
  },
  'credentials.ts': { input: { writes: '私有目录 credentials 里加密保存的凭据', markers: ['credentials'] } },
  'stage-run.ts': {
    start: { writes: '私有目录里的运行记录 stage-runs', markers: ['stage-runs'] },
    observe: { writes: '私有目录里的运行记录 stage-runs', markers: ['stage-runs'] },
    verify: { writes: '私有目录里的运行记录 stage-runs；它运行的 doctor 检查更新最近检查记录 doctor-latest.json', markers: ['stage-runs', 'doctor-latest'] },
    decide: { writes: '私有目录里的运行记录 stage-runs', markers: ['stage-runs'] },
    progress: { writes: '私有目录里的运行记录 stage-runs', markers: ['stage-runs'] },
    switch: { writes: '运行记录和换关记录，经配置写入器改 MAA 的作业列表', markers: ['stage-runs', 'switches', 'gui.new.json'] },
  },
  'nga.ts': { search: researchWrites, read: researchWrites },
  'skland-community.ts': { read: researchWrites },
  'bilibili.ts': { read: researchWrites },
  'skland-account.ts': {
    inspect: { writes: '私有目录里这次读取的森空岛凭据结果', markers: ['status.json'] },
    import: { writes: '私有目录里的森空岛账号快照 account-snapshot-skland.json 和这次读取的凭据结果', markers: ['account-snapshot-skland.json', 'status.json'] },
  },
  'cultivation-report.ts': reportWrites({ writes: '私有目录 reports 里的报告 report.json；重新读取的调研进缓存', markers: ['reports', 'report.json'] }),
  'base-report.ts': reportWrites({ writes: '私有目录 reports 里的报告 report.json 和排班文件 base-plans', markers: ['reports', 'report.json', 'base-plans'] }),
  'base-plan.ts': { generate: { writes: '私有目录里的排班文件 base-plans', markers: ['base-plans'] } },
  'base-apply.ts': { apply: { writes: '私有目录里的排班副本 base-applied，经配置写入器改 MAA 的基建设置', markers: ['base-applied', 'gui.new.json'] } },
};

/** Comments, and the text inside string, template and regular-expression literals, become spaces; line breaks stay. */
function codeOnly(source: string): string {
  let out = '', index = 0;
  const templates: number[] = []; // open braces inside each `${` of the templates being read
  const blank = (char: string) => (char === '\n' || char === '\r' ? char : ' ');
  const template = () => { // read template text up to the closing backtick or the next `${`
    while (index < source.length) {
      const char = source[index]!;
      if (char === '\\') { out += blank(char) + blank(source[index + 1] ?? ''); index += 2; continue; }
      if (char === '`') { out += char; index++; return; }
      if (char === '$' && source[index + 1] === '{') { out += '${'; index += 2; templates.push(0); return; }
      out += blank(char); index++;
    }
  };
  // A slash starts a regular expression where an operand is expected: after an operator, an opening bracket or a keyword.
  const operandExpected = () => { const before = out.trimEnd(); return !before || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(?:return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(before); };
  while (index < source.length) {
    const char = source[index]!, next = source[index + 1];
    if (char === '/' && next === '/') { while (index < source.length && source[index] !== '\n') { out += ' '; index++; } continue; }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2), stop = end < 0 ? source.length : end + 2;
      while (index < stop) out += blank(source[index++]!);
      continue;
    }
    if (char === '\'' || char === '"') {
      out += char; index++;
      while (index < source.length && source[index] !== char && source[index] !== '\n') {
        if (source[index] === '\\') { out += ' '; index++; }
        out += blank(source[index] ?? ''); index++;
      }
      if (index < source.length) out += source[index++];
      continue;
    }
    if (char === '`') { out += char; index++; template(); continue; }
    if (char === '}' && templates.length && templates.at(-1) === 0) { templates.pop(); out += char; index++; template(); continue; }
    if (char === '}' && templates.length) templates[templates.length - 1]!--;
    if (char === '{' && templates.length) templates[templates.length - 1]!++;
    if (char === '/' && operandExpected()) {
      out += char; index++;
      let inClass = false;
      while (index < source.length && source[index] !== '\n') {
        const current = source[index]!;
        if (current === '\\') { out += '  '; index += 2; continue; }
        if (current === '/' && !inClass) break;
        if (current === '[') inClass = true; else if (current === ']') inClass = false;
        out += ' '; index++;
      }
      if (source[index] === '/') out += source[index++];
      continue;
    }
    out += char; index++;
  }
  return out;
}

type Unit = { module: string; name: string; start: number; text: string; code: string };
/** A file write: a write-family call, or `open` with a write flag. */
const writeCall = /\b(?:writeFile|appendFile|rename|copyFile|cp|mkdir|rm|rmdir|unlink|link|symlink|truncate|createWriteStream)(?:Sync)?\(/;
const openCall = /\bopen(?:Sync)?\(/;
const writeFlag = /'(?:w|wx|w\+|wx\+|a|ax|a\+|ax\+|r\+|rs\+)'/;

/**
 * The shared scripts as top-level statements: a statement starts in column 0 of the code and runs to the next one. A
 * statement refers to another by name (in code, not in comments or strings), through a named import, or through a dynamic
 * import of its module. The command-line block (`if (entry && …)`) is the unit named `<cli>`.
 */
async function scriptGraph() {
  const units = new Map<string, Unit>(), edges = new Map<string, Set<string>>(), imports = new Map<string, Map<string, string>>();
  const key = (module: string, name: string) => `${module}#${name}`;
  for (const module of (await readdir(scripts)).filter((name) => name.endsWith('.ts')).sort()) {
    const text = await readFile(join(scripts, module), 'utf8');
    const lines = text.split('\n'), code = codeOnly(text).split('\n');
    assert.equal(code.length, lines.length, `${module}: blanking kept the lines`);
    const scope = new Map<string, string>();
    for (const match of text.matchAll(/^import\s+\{([^}]*)\}\s+from\s+'\.\/([a-z0-9-]+\.ts)'/gm)) {
      for (const part of match[1]!.split(',').map((item) => item.trim()).filter((item) => item && !item.startsWith('type '))) {
        const [name, alias] = part.split(/\s+as\s+/).map((item) => item.trim());
        scope.set(alias ?? name!, key(match[2]!, name!));
      }
    }
    imports.set(module, scope);
    const starts: { line: number; name: string }[] = [];
    code.forEach((line, index) => {
      if (!/^[A-Za-z_$]/.test(line)) return;
      const named = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|(?:const|let|var|class|type|interface)\s+([\w$]+))/);
      starts.push({ line: index, name: named ? (named[1] ?? named[2])! : /^if \((?:entry|entryPath) &&/.test(line) ? '<cli>' : `<line ${index + 1}>` });
    });
    starts.forEach((start, index) => {
      const end = starts[index + 1]?.line ?? lines.length;
      units.set(key(module, start.name), { module, name: start.name, start: start.line, text: lines.slice(start.line, end).join('\n'), code: code.slice(start.line, end).join('\n') });
    });
  }
  for (const [name, unit] of units) {
    const words = new Set(unit.code.match(/[A-Za-z_$][\w$]*/g) ?? []), out = new Set<string>();
    const reachable = [unit.module, ...[...unit.text.matchAll(/import\('\.\/([a-z0-9-]+\.ts)'\)/g)].map((match) => match[1]!)];
    for (const other of units.values()) if (reachable.includes(other.module) && other !== unit && words.has(other.name)) out.add(key(other.module, other.name));
    for (const [alias, target] of imports.get(unit.module)!) if (words.has(alias)) out.add(target);
    edges.set(name, out);
  }
  const writes = (unit: Unit) => {
    const raw = unit.text.split('\n');
    return unit.code.split('\n').flatMap((line, index) => writeCall.test(line) || openCall.test(line) && writeFlag.test(raw[index]!) ? [unit.start + index + 1] : []);
  };
  const reach = (from: string[]) => {
    const seen = new Set<string>(), stack = [...from];
    while (stack.length) { const next = stack.pop()!; if (seen.has(next)) continue; seen.add(next); stack.push(...edges.get(next) ?? []); }
    return seen;
  };
  const resolve = (module: string, name: string) => units.has(key(module, name)) ? key(module, name) : imports.get(module)!.get(name);
  return { units, edges, writes, reach, resolve, key };
}

test('the writing-command table lists exactly the shared-script actions whose code writes a file', async () => {
  const { units, edges, writes, reach, resolve, key } = await scriptGraph();
  const problems: string[] = [];
  const sorted = (items: Iterable<string>) => [...items].sort().join(', ');
  const writing = (keys: Iterable<string>) => [...keys].flatMap((name) => { const unit = units.get(name); return unit ? writes(unit).map((line) => `${unit.module}:${line}`) : []; });
  const commandLines = [...units.values()].filter((unit) => unit.name === '<cli>').map((unit) => unit.module);
  assert.equal(sorted(commandLines), sorted(Object.keys(contract)), 'every script with a command line is in the contract, and only those');
  assert.equal(sorted(Object.keys(commandCalls)), sorted(Object.keys(contract)));
  for (const [script, actions] of Object.entries(contract)) {
    const cli = units.get(key(script, '<cli>'))!;
    // The actions the command line accepts: the names it compares the action argument with.
    const accepted = new Set<string>();
    for (const match of cli.text.matchAll(/(?:\baction|process\.argv\[2\]|\bargs\[0\])!?\s*[!=]==\s*'([a-z][a-z-]*)'/g)) accepted.add(match[1]!);
    for (const match of cli.text.matchAll(/\[((?:\s*'[a-z][a-z-]*'\s*,?)+)(?:\s*\.\.\.[^\]]*)?\]\.includes\((?:action|process\.argv\[2\])/g)) {
      for (const name of match[1]!.matchAll(/'([a-z][a-z-]*)'/g)) accepted.add(name[1]!);
    }
    if (sorted(accepted) !== sorted(Object.keys(actions))) problems.push(`${script}: the command line accepts ${sorted(accepted)}, the contract lists ${sorted(Object.keys(actions))}`);
    if (sorted(Object.keys(commandCalls[script]!)) !== sorted(Object.keys(actions))) problems.push(`${script}: commandCalls lists ${sorted(Object.keys(commandCalls[script]!))}`);
    const listed = new Set(Object.values(commandCalls[script]!).flat().map((name) => resolve(script, name)));
    for (const target of edges.get(key(script, '<cli>'))!) {
      if (!listed.has(target) && writing(reach([target])).length) problems.push(`${script}: the command line calls ${target}, which writes, but no action lists it in commandCalls`);
    }
    // A write in the command-line block itself belongs to the action it compares with last before it; `guard` is the innermost
    // `if (…)` between that comparison and the write that encloses the write (less indented), if any.
    const inline = new Map<string, { line: number; guard: string }[]>();
    const comparison = /(?:\baction|process\.argv\[2\]|\bargs\[0\])!?\s*===\s*'([a-z][a-z-]*)'/;
    const indent = (text: string) => text.match(/^\s*/)![0].length;
    for (const line of writes(cli)) {
      const raw = cli.text.split('\n'), code = cli.code.split('\n'), index = line - cli.start - 1;
      const at = raw.slice(0, index).findLastIndex((text) => comparison.test(text));
      const owner = at < 0 ? undefined : raw[at]!.match(comparison)![1]!;
      if (!owner) { problems.push(`${script}:${line}: a write in the command line that no action comparison precedes`); continue; }
      const guard = code.slice(at + 1, index).reverse().find((text) => /^\s*if\s*\(/.test(text) && indent(text) < indent(code[index]!)) ?? '';
      inline.set(owner, [...inline.get(owner) ?? [], { line, guard }]);
    }
    for (const [action, names] of Object.entries(commandCalls[script]!)) {
      const targets = names.map((name) => resolve(script, name));
      names.forEach((name, index) => {
        if (!targets[index]) problems.push(`${script} ${action}: ${name} is neither declared in nor imported by the script`);
        else if (!edges.get(key(script, '<cli>'))!.has(targets[index]!)) problems.push(`${script} ${action}: the command line does not call ${name}`);
      });
      const reached = reach(targets.filter((target): target is string => !!target));
      const sites = [...writing(reached), ...(inline.get(action) ?? []).map((site) => `${script}:${site.line}`)];
      const entry = writingCommands[script]?.[action];
      if (sites.length && !entry) problems.push(`${script} ${action} writes (${sites.slice(0, 3).join(', ')}) but is not in writingCommands`);
      if (!sites.length && entry) problems.push(`${script} ${action} is in writingCommands but its code writes no file`);
      // What the table says it writes must be named by a string literal in the code the action reaches.
      const literals = [...reached].map((name) => units.get(name)?.text ?? '').concat(inline.has(action) ? [cli.text] : [])
        .flatMap((text) => [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? ''));
      for (const marker of entry?.markers ?? []) if (!literals.some((literal) => literal.includes(marker))) problems.push(`${script} ${action}: no string literal in the code it reaches names ${marker}`);
      // An action that writes only with an input key: the key is one of its inputs, and it writes only in the command line,
      // inside an `if` that tests that key.
      if (entry?.onlyWith) {
        if (!actions[action]!.includes(entry.onlyWith)) problems.push(`${script} ${action}: onlyWith ${entry.onlyWith} is not one of its input keys`);
        if (writing(reached).length) problems.push(`${script} ${action}: onlyWith ${entry.onlyWith}, but a function it calls writes`);
        for (const site of inline.get(action) ?? []) if (!new RegExp(`\\b${entry.onlyWith}\\b`).test(site.guard)) problems.push(`${script}:${site.line}: written outside an if on ${entry.onlyWith}`);
      }
    }
  }
  for (const [script, actions] of Object.entries(writingCommands)) {
    for (const action of Object.keys(actions)) if (!commandCalls[script]?.[action]) problems.push(`writingCommands names ${script} ${action}, which is not a command`);
  }
  assert.deepEqual(problems, []);
});

/**
 * 「只读」, read-only, or 「不写」 standing alone (「不写」「不写入」 before punctuation, 「不写任何文件」, 「不写文件」): a claim
 * that nothing is written. 「不写」 with its object (「不写 MAA 配置」「不写快照」「不写设置」) names the file a command leaves alone,
 * and 「不写「最优」」 or 「不写 `runs`」 is about text the agent writes; neither is a read-only claim.
 */
const readOnlyWord = /只读|read[- ]only|不写入?(?=\s*(?:$|[，。；、：:）)」！？!?,.;]|任何|文件))/gi;

/**
 * The read-only claims in a piece of prose, outside code spans, leaving out claims limited to MAA: 「对 MAA（配置）只读」,
 * 「只读 MAA 目录下…」, 「MAA 只读…」 (what MAA itself reads), "read-only to MAA".
 */
function readOnlyClaims(text: string): string[] {
  const prose = text.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
  const claims: string[] = [];
  for (const match of prose.matchAll(readOnlyWord)) {
    const before = prose.slice(0, match.index), after = prose.slice(match.index + match[0].length);
    if (/(?:对\s*MAA[^，,。；;：:、（）()]{0,12}|MAA\s*)$/.test(before) || /^\s*取?\s*MAA\b/.test(after) || /^\s+(?:to|for|on)\s+MAA\b/i.test(after)) continue;
    claims.push(match[0]);
  }
  return claims;
}

/** Ranges of `line[from, to)` cut after a character of `ends`, or of `spaced` before a space, outside code spans. */
function cut(line: string, from: number, to: number, ends: RegExp, spaced: RegExp): [number, number][] {
  const ranges: [number, number][] = [];
  let start = from, code = false;
  for (let index = from; index < to; index++) {
    const char = line[index]!;
    if (char === '`') code = !code;
    else if (!code && (ends.test(char) || spaced.test(char) && /\s/.test(line[index + 1] ?? ' '))) { ranges.push([start, index + 1]); start = index + 1; }
  }
  if (start < to) ranges.push([start, to]);
  return ranges;
}
const sentences = (line: string, from: number, to: number) => cut(line, from, to, /[。！？]/, /[.!?]/);
const clauses = (line: string, from: number, to: number) => cut(line, from, to, /[，；;]/, /,/);

/** Ranges of the cells of a table row, split at pipes outside code spans. */
function cells(line: string): [number, number][] {
  const ranges: [number, number][] = [];
  let start = -1, code = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '`') code = !code;
    else if (line[index] === '|' && !code && line[index - 1] !== '\\') { if (start >= 0) ranges.push([start, index]); start = index + 1; }
  }
  if (start >= 0 && line.slice(start).trim()) ranges.push([start, line.length]);
  return ranges;
}

type Named = { all: Set<string>; writers: Set<string> };
const merge = (...groups: Named[]): Named => ({ all: new Set(groups.flatMap((group) => [...group.all])), writers: new Set(groups.flatMap((group) => [...group.writers])) });

/**
 * Where one skill document calls a writing command read-only. A place is reported when its words make a read-only claim not
 * limited to MAA (`readOnlyClaims`) while it speaks of a command of `writingCommands`, named in code (`doctor.ts check`, or
 * `check` where doctor.ts is the script in context), by one of the command's prose `names`, or as a script all of whose commands
 * write. The places:
 * - a clause of prose (cut at ，；). It speaks of the commands it names; one that names none, or starts with 它, also speaks of the
 *   first command named before it in its sentence or, for the first clause, in the sentence before (one step back only);
 * - a table cell: as prose, where the row's first cell is what a cell speaks of when nothing before it names a command; its
 *   column heading's claims speak of the commands the cell and the row's first cell name;
 * - a heading: its claims speak of every command named in its section.
 * A command that writes only with an input key (`onlyWith`) is not counted in a sentence that says the key is left out
 * (「不加 `saveReport`」). Fenced blocks are skipped.
 */
function readOnlyWriters(file: string, text: string): string[] {
  const lines = text.split(/\r?\n/);
  const { mentions } = extractDocument(file, text);
  const problems: string[] = [];
  const aliases = new Map<string, string[]>();
  for (const [script, actions] of Object.entries(writingCommands)) for (const [action, entry] of Object.entries(actions)) {
    for (const name of entry.names ?? []) aliases.set(name, [...aliases.get(name) ?? [], `${script} ${action}`]);
  }
  const describe = (command: string) => { const [script, action] = command.split(' '); return `${command}（写${writingCommands[script!]![action!]!.writes}）`; };
  /** The commands named on line `number` (1-based) in [from, to), one group per name, in the order they are named. */
  const named = (number: number, from: number, to: number): Named[] => {
    const groups: (Named & { column: number })[] = [];
    for (const mention of mentions) {
      if (mention.line !== number || mention.column < from || mention.column >= to) continue;
      if (mention.action) {
        const command = `${mention.script} ${mention.action}`;
        groups.push({ column: mention.column, all: new Set([command]), writers: new Set(writingCommands[mention.script]?.[mention.action] ? [command] : []) });
        continue;
      }
      const actions = Object.keys(contract[mention.script] ?? {});
      const writing = actions.length > 0 && actions.every((action) => writingCommands[mention.script]?.[action]);
      groups.push({ column: mention.column, all: new Set([mention.script]), writers: new Set(writing ? actions.map((action) => `${mention.script} ${action}`) : []) });
    }
    // Link targets (`](../maa-doctor/…)`) are paths, not names.
    const prose = lines[number - 1]!.slice(from, to).replace(/\]\([^)]*\)/g, (link) => ' '.repeat(link.length));
    for (const [name, commands] of aliases) {
      for (let at = prose.indexOf(name); at >= 0; at = prose.indexOf(name, at + name.length)) groups.push({ column: from + at, all: new Set(commands), writers: new Set(commands) });
    }
    return groups.sort((left, right) => left.column - right.column);
  };
  /** Commands not counted in this sentence: it says the input key that makes them write is left out. */
  const quiet = (sentence: string) => new Set(Object.entries(writingCommands).flatMap(([script, actions]) => Object.entries(actions)
    .filter(([, entry]) => entry.onlyWith && new RegExp(`(?:不(?:加|带|传)|without)\\s*\`${entry.onlyWith}\``).test(sentence)).map(([action]) => `${script} ${action}`)));
  const report = (number: number, words: string[], writers: Iterable<string>, skip = new Set<string>()) => {
    const counted = [...new Set(writers)].filter((command) => !skip.has(command)).sort();
    if (words.length && counted.length) problems.push(`skills/${file}:${number}: 「${[...new Set(words)].join('」「')}」 names ${counted.map(describe).join('; ')}`);
  };
  const prose = (number: number, from: number, to: number, fallback: Named = merge()) => {
    const line = lines[number - 1]!;
    let carried: Named | undefined;
    for (const [sentenceFrom, sentenceTo] of sentences(line, from, to)) {
      const skip = quiet(line.slice(sentenceFrom, sentenceTo));
      let subject = carried ?? fallback, first: Named | undefined;
      for (const [start, end] of clauses(line, sentenceFrom, sentenceTo)) {
        const part = line.slice(start, end), groups = named(number, start, end), own = merge(...groups);
        const speaksOf = own.all.size && !/^\s*(?:它|它们|this\b|it\b)/i.test(part) ? own : merge(own, subject);
        report(number, readOnlyClaims(part), speaksOf.writers, skip);
        if (groups[0]) { subject = groups[0]; first ??= groups[0]; }
      }
      carried = first;
    }
  };
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  let fence = false, header: [number, number][] = [], headerLine = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!, number = index + 1;
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s/);
    if (heading) {
      const section: Named[] = [];
      for (let below = index + 1; below < lines.length; below++) {
        const level = lines[below]!.match(/^(#{1,6})\s/)?.[1]!.length;
        if (level !== undefined && level <= heading[1]!.length) break;
        section.push(...named(below + 1, 0, lines[below]!.length));
      }
      report(number, readOnlyClaims(line), merge(...section).writers);
      continue;
    }
    if (!line.trimStart().startsWith('|')) { header = []; prose(number, 0, line.length); continue; }
    if (separator.test(line)) continue;
    if (separator.test(lines[index + 1] ?? '')) { header = cells(line); headerLine = number; prose(number, 0, line.length); continue; }
    const row = cells(line), first = row[0];
    const rowSubject = first ? merge(...named(number, first[0], first[1])) : merge();
    row.forEach(([from, to], column) => {
      prose(number, from, to, column > 0 ? rowSubject : merge());
      const columnHeading = header[column];
      if (columnHeading) report(number, readOnlyClaims(lines[headerLine - 1]!.slice(columnHeading[0], columnHeading[1])),
        merge(rowSubject, ...named(number, from, to)).writers, quiet(line.slice(from, to)));
    });
  }
  return problems;
}

/** Every skill document: SKILL.md, references and any other Markdown under skills/. */
async function skillDocuments(directory = skills, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...await skillDocuments(join(directory, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith('.md')) found.push(`${prefix}${entry.name}`);
  }
  return found.sort();
}

test('no skill document calls a writing command read-only, unless it limits the claim to MAA', async () => {
  const documents = await skillDocuments();
  assert.ok(documents.includes('README.md') && documents.includes('maa-doctor/references/triage.md'), 'the scan reads every Markdown file under skills/');
  const problems: string[] = [];
  for (const file of documents) problems.push(...readOnlyWriters(file, await readFile(join(skills, file), 'utf8')));
  assert.deepEqual(problems, []);
});

test('the read-only scan finds the shapes it was built for, and passes claims limited to MAA', async () => {
  // Each pair: text the documents hold now, and the earlier wording the scan must report (the triage heading and column of
  // round 2; doctor's own step 1; the maa-daily hand-offs and stage-run verify step round 1 fixed).
  const reverted: [string, string, string][] = [
    ['maa-doctor/references/triage.md', '## 逐类：本机能核对的（不改 MAA），和只能转介的', '## 逐类：本机只读能核对的，和只能转介的'],
    ['maa-doctor/references/triage.md', '| 本机核对（不改 MAA） |', '| 本机只读核对 |'],
    ['maa-doctor/SKILL.md', '检查不改 MAA，只更新私有目录里的最近检查记录。', '检查只读，仅更新私有目录的最近检查记录。'],
    ['maa-daily/SKILL.md', 'maa-doctor 先核对（doctor 的检查会更新私有目录里的最近检查记录，不改 MAA 配置、锁和运行记录）', 'maa-doctor 先只读核对'],
    ['maa-daily/references/base-apply.md', 'maa-doctor 先核对（doctor 的检查会更新私有目录里的最近检查记录，不改 MAA 配置、锁和运行记录）', 'maa-doctor 先只读核对'],
    ['maa-daily/references/stage-run.md', '它读取 MAA 进程、批准的列表和作业文件，运行共享 doctor 检查，不改 MAA 配置和作业文件；这次核对的结果记进运行记录，doctor 的检查会更新私有目录里的最近检查记录。',
      '它只读：MAA 进程、批准的列表和作业文件、共享 doctor 检查；'],
  ];
  for (const [file, now, before] of reverted) {
    const text = await readFile(join(skills, file), 'utf8');
    assert.ok(text.includes(now), `${file} still says: ${now}`);
    assert.deepEqual(readOnlyWriters(file, text), [], file);
    assert.notDeepEqual(readOnlyWriters(file, text.replace(now, before)), [], `${file}: the scan reports ${before}`);
  }
  // Doctor's analyze step says what analyze saves, and that it leaves MAA alone.
  assert.match(await readFile(join(skills, 'maa-doctor/SKILL.md'), 'utf8'), /`analyze` 把结果存为私有目录里的最近分析记录，不改 MAA 配置、锁和运行记录/);
  // Synthetic shapes: a later clause naming no command speaks of the earlier one, in its sentence or one sentence on, not further;
  // a reader beside a writer stays clean; a claim limited to MAA passes; 「不写」 with its object is no claim; a table column
  // heading speaks for its cells and a heading for its section; a prose name and a script all of whose commands write count as
  // naming; a command that writes only with an input key may be called read-only where the key is left out.
  const doc = (body: string) => readOnlyWriters('synthetic.md', ['共享入口为 `node scripts/doctor.ts <action>`。', body].join('\n'));
  assert.equal(doc('运行 `check`，只读。').length, 1);
  assert.deepEqual(doc('`account-snapshot.ts inspect` 只读，`account-snapshot.ts import` 写入快照。'), []);
  assert.deepEqual(doc('`check` 对 MAA 只读，不写 MAA 配置。'), []);
  assert.deepEqual(doc('`analyze` 只读 MAA 目录下的日志。'), []);
  assert.equal(doc(['| 项 | 只读核对 |', '| --- | --- |', '| 连接 | `check` 的连接 |'].join('\n')).length, 1);
  assert.equal(doc('`scripts/doctor.ts` 是只读检查。').length, 1);
  assert.equal(doc('## 只读部分\n\n`analyze` 的结果。').length, 1);
  assert.deepEqual(doc('报告里不写「最优」，`check` 的结果照常。'), []);
  assert.deepEqual(doc('```\n`check` 只读\n```'), []);
  assert.equal(doc('运行 `check`。检查只读。').length, 1);
  assert.deepEqual(doc('运行 `check`。结果见上。只读部分另说。'), []);
  assert.equal(doc('交给 maa-doctor 先只读核对。').length, 1);
  assert.deepEqual(doc('`check` 不写 MAA 配置，也不写快照。'), []);
  assert.equal(doc('`check` 不写任何文件。').length, 1);
  assert.deepEqual(doc('只运行只读的 `stage-jobs.ts query`（不加 `saveReport`）。'), []);
  assert.equal(doc('只运行只读的 `stage-jobs.ts query`。').length, 1);
});

/*
 * Read preferences first (ticket 26, package P2). The first real Codex run found a maa-daily refusal sent before preferences
 * were read (R11); package P added the clause to maa-daily alone, and the second run found maa-account doing the same (R4).
 * By the recurrence rule: one rule with one owner, the 「先读偏好」 item of maa-core's caller convention. Every other SKILL.md
 * that runs `preferences.ts read` points to it from a line that runs the read, and no other skill document restates it.
 */
const readFirstOwner = 'maa-core/SKILL.md';
const readFirstItem = '- 先读偏好：';
const readFirstLink = /\[[^\]]*「先读偏好」[^\]]*\]\(\.\.\/maa-core\/SKILL\.md\)/;
/** Words of the owner's item that no other skill document uses: writing them restates the rule instead of pointing to it. */
const readFirstWords = '任何答复';
const preferenceReaders = ['maa-account/SKILL.md', 'maa-daily/SKILL.md', 'maa-doctor/SKILL.md', 'maa-setup/SKILL.md'];

/** The items of the 「调用方的约定」 list in maa-core's SKILL.md. */
function callerConvention(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf('调用方的约定：');
  const items: string[] = [];
  if (start < 0) return items;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('- ')) items.push(line);
    else if (line.trim() && !line.startsWith('  ')) break;
  }
  return items;
}

/**
 * The read-first rule over skill documents (path under skills/ → text). The readers are the SKILL.md files, other than the
 * owner, with a line that runs `preferences.ts read`, found two ways: the literal command, and the shared command extraction
 * the script-contract test uses (it also sees `preferences.ts` named first and a bare `read` after it).
 */
function readFirstCheck(texts: Map<string, string>): { readers: string[]; problems: string[] } {
  const problems: string[] = [];
  const owner = texts.get(readFirstOwner) ?? '';
  const owned = callerConvention(owner).filter((item) => item.startsWith(readFirstItem)).length;
  const anywhere = owner.split(/\r?\n/).filter((line) => line.startsWith(readFirstItem)).length;
  if (owned !== 1 || anywhere !== 1) problems.push(`${readFirstOwner}: the caller convention must hold the one 「先读偏好」 item (found ${owned} there, ${anywhere} in the file)`);
  const readers: string[] = [];
  for (const [file, text] of texts) {
    if (file !== readFirstOwner && text.includes(readFirstWords)) problems.push(`${file}: restates the read-first rule ("${readFirstWords}"); point to maa-core instead`);
    if (!file.endsWith('SKILL.md') || file === readFirstOwner) continue;
    const lines = text.split(/\r?\n/);
    const running = new Set(lines.flatMap((line, index) => /(?<![\w.-])preferences\.ts\s+read\b/.test(line) ? [index + 1] : []));
    for (const mention of extractDocument(file, text).mentions) if (mention.script === 'preferences.ts' && mention.action === 'read') running.add(mention.line);
    if (!running.size) continue;
    readers.push(file);
    if (![...running].some((line) => readFirstLink.test(lines[line - 1]!))) problems.push(`${file}: runs preferences.ts read without pointing to maa-core's 「先读偏好」 on that line`);
  }
  return { readers: readers.sort(), problems };
}

async function skillTexts(): Promise<Map<string, string>> {
  return new Map(await Promise.all((await skillDocuments()).map(async (file) => [file, await readFile(join(skills, file), 'utf8')] as const)));
}

test('every SKILL.md that runs preferences.ts read points to the one read-first rule in maa-core', async () => {
  const texts = await skillTexts();
  // The scan reads every skill's SKILL.md: one per directory under skills/, none nested deeper.
  const directories = (await readdir(skills, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => `${entry.name}/SKILL.md`).sort();
  assert.deepEqual([...texts.keys()].filter((file) => basename(file) === 'SKILL.md'), directories);
  const { readers, problems } = readFirstCheck(texts);
  assert.deepEqual(problems, []);
  // The enumeration is complete: exactly the four operating skills, and it covers every skill whose eval scenarios expect the read.
  assert.deepEqual(readers, preferenceReaders);
  const expected = new Set(scenarioCatalog().flatMap((entry) => {
    const definition = entry.definition as ScenarioDefinition;
    const reads = (definition.policy.expectedInvocations ?? []).some((call) => call.file === 'maa-core/scripts/preferences.ts' && call.action === 'read');
    return reads && entry.skillDirectory ? [`${basename(entry.skillDirectory)}/SKILL.md`] : [];
  }));
  assert.deepEqual([...expected].sort(), preferenceReaders);
});

test('the read-first check fails when a skill drops the pointer, restates the rule, or the owner loses it', async () => {
  const texts = await skillTexts();
  const changed = (file: string, edit: (text: string) => string) => readFirstCheck(new Map([...texts, [file, edit(texts.get(file)!)]]));
  for (const file of preferenceReaders) {
    const dropped = changed(file, (text) => text.replace(new RegExp(readFirstLink.source, 'g'), '「先读偏好」'));
    assert.deepEqual(dropped.problems, [`${file}: runs preferences.ts read without pointing to maa-core's 「先读偏好」 on that line`]);
    assert.deepEqual(dropped.readers, preferenceReaders);
  }
  assert.equal(changed(readFirstOwner, (text) => text.replace(readFirstItem, '- ')).problems.length, 1);
  assert.equal(changed(readFirstOwner, (text) => `${readFirstItem}副本。\n\n${text}`).problems.length, 1);
  assert.deepEqual(changed('maa-daily/SKILL.md', (text) => `${text}\n在任何答复之前读偏好。\n`).problems,
    ['maa-daily/SKILL.md: restates the read-first rule ("任何答复"); point to maa-core instead']);
  // A new skill joins the readers, also when it names the script first and the action after it.
  const added = readFirstCheck(new Map([...texts, ['maa-new/SKILL.md', '确认 `../maa-core/scripts/preferences.ts` 存在。\n\n1. 运行 `preferences.ts` 的 `read`。\n']]));
  assert.deepEqual(added.readers, [...preferenceReaders, 'maa-new/SKILL.md'].sort());
  assert.deepEqual(added.problems, ["maa-new/SKILL.md: runs preferences.ts read without pointing to maa-core's 「先读偏好」 on that line"]);
});

/*
 * Never edit MAA's configuration directly (ticket 26, package P2, R6). On an older payload a model patched the MAA config file
 * itself to turn gacha on, with no approval, no lock and no writer. One owner again: the 「不直接改 MAA 配置」 item of maa-core's
 * caller convention; maa-account's boundary line points to it.
 */
test('maa-core owns the rule against editing MAA configuration directly, and maa-account\'s boundary points to it', async () => {
  const core = await readFile(join(skills, 'maa-core/SKILL.md'), 'utf8');
  const items = core.split(/\r?\n/).filter((line) => line.startsWith('- 不直接改 MAA 配置：'));
  assert.equal(items.length, 1);
  assert.ok(callerConvention(core).includes(items[0]!), 'the item sits in the caller convention');
  const account = await readFile(join(skills, 'maa-account/SKILL.md'), 'utf8');
  const boundary = account.split(/\r?\n/).filter((line) => line.includes('抽卡、礼包、付费、登录'));
  assert.equal(boundary.length, 1);
  assert.match(boundary[0]!, /\[[^\]]*「不直接改 MAA 配置」[^\]]*\]\(\.\.\/maa-core\/SKILL\.md\)/);
});
