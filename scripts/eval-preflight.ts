import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixture, collectEvidence } from './eval-fixture.ts';
import { runScenario, type ScenarioDefinition } from './eval-run.ts';
import { scenarioCatalog, entryId, type ScenarioEntry } from './eval-scenarios.ts';
import type { Host } from './evaluation.ts';

const doubleScript = fileURLToPath(new URL('../eval/host-double.mjs', import.meta.url));
const skill = (name: string) => fileURLToPath(new URL(`../skills/${name}`, import.meta.url));
export type PreflightCheck = { id: string; status: 'pass' | 'fail'; detail?: string };
export type DoubleRun = { host: Host; scenario: string; reason: string; grade: string; double: boolean };
/** No model is called. Records come from the host double and are marked as such: never a baseline, never compared. */
export type EnvironmentPreflight = { status: 'pass' | 'fail'; double: true; baseline: false; checks: PreflightCheck[]; doubleRuns: DoubleRun[] };

const entry = (id: string): ScenarioEntry => {
  const found = scenarioCatalog().find((item) => entryId(item) === id);
  if (!found) throw new Error(`preflight-scenario:${id}`);
  return found;
};
type Step = { shell: string[]; input?: unknown };
/** Fixed double scripts: the declared product commands for one scenario, in the layout of each host. */
function doubleSteps(host: Host, scenario: string): Step[] {
  const layout = host === 'codex' ? '.agents' : '.claude';
  const core = (subject: boolean) => `${layout}/skills/${subject ? 'subject' : 'maa-core'}/scripts`;
  const read = (subject = false): Step => ({ shell: ['node', `${core(subject)}/preferences.ts`, 'read'], input: { currentLanguage: 'zh-CN' } });
  if (scenario === 'core-language') return [read(true), { shell: ['node', `${core(true)}/preferences.ts`, 'set'], input: { language: 'en' } },
    { shell: ['node', `${core(true)}/preferences.ts`, 'append'], input: { date: '2026-11-10T06:00:00.000Z', source: 'synthetic-help-case', text: '以后用英文' } }];
  if (scenario === 'daily-closed') return [read(), { shell: ['node', `${core(false)}/maa-config.ts`, 'read'], input: {} },
    { shell: ['node', `${core(false)}/maa-config.ts`, 'write'], input: { host, expectedRevision: '{{output:1:configuration.revision}}',
      authorization: { source: 'current-request', reference: '开启定时提醒' }, changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] } }];
  if (scenario === 'account-cost-raw') return [read(), { shell: ['node', `${core(false)}/operator-cost.ts`, 'query'],
    input: { name: '合成干员', target: { elite: 2, level: 2 }, mode: 'raw' } }];
  throw new Error(`preflight-scenario:${scenario}`);
}

/**
 * Proves the evaluation environment works before any model is paid for: temporary home and workspace, both native skill
 * layouts, the Node observer, the MAA process double with the daily observer, the network double (listed requests answered,
 * unlisted rejected), file differences and events, and finally a full runScenario pass per host with the host double.
 */
export async function runEnvironmentPreflight(): Promise<EnvironmentPreflight> {
  const checks: PreflightCheck[] = [];
  const doubleRuns: DoubleRun[] = [];
  const check = async (id: string, body: () => Promise<string | undefined>) => {
    try { const detail = await body(); checks.push({ id, status: detail ? 'fail' : 'pass', ...(detail ? { detail } : {}) }); }
    catch (error) { checks.push({ id, status: 'fail', detail: error instanceof Error ? error.message : 'unexpected' }); }
  };
  const scratch = await mkdtemp(join(tmpdir(), 'maa-eval-preflight-'));
  try {
    await check('fixture-and-skills', async () => {
      const daily = entry('daily-inspect');
      const fixture = await createFixture({ skillDirectory: daily.skillDirectory!, companionSkills: daily.companionSkills, jsonInputs: (daily.definition as ScenarioDefinition).jsonInputs! });
      try {
        for (const path of ['home', 'workspace']) await access(join(fixture.root, path));
        for (const layout of ['.agents', '.claude']) for (const name of ['subject', 'maa-core']) await access(join(fixture.workspace, layout, 'skills', name, 'SKILL.md'));
        const set = spawnSync(process.execPath, ['.claude/skills/maa-core/scripts/preferences.ts', 'set'], { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify({ language: 'en' }), encoding: 'utf8' });
        if (set.status !== 0) return 'preferences-set-failed';
        const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
        if (!evidence.events.some((event) => event.kind === 'invocation' && event.file === 'maa-core/scripts/preferences.ts' && event.action === 'set' && event.exitCode === 0)) return 'node-observer-missing';
        if (!evidence.changes.some((change) => change.file === 'private/config.json')) return 'file-difference-missing';
        return undefined;
      } finally { await fixture.dispose(); }
    });
    await check('maa-process-double-and-daily-observer', async () => {
      const closed = entry('daily-closed');
      const definition = closed.definition as ScenarioDefinition;
      const fixture = await createFixture({ skillDirectory: closed.skillDirectory!, companionSkills: closed.companionSkills, jsonInputs: definition.jsonInputs!, jsonFiles: definition.jsonFiles!, maaProcess: 'closed' });
      try {
        const invoke = (action: string, input: unknown) => spawnSync(process.execPath, ['.agents/skills/maa-core/scripts/maa-config.ts', action], { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8' });
        const read = invoke('read', {});
        const write = invoke('write', { host: 'codex', expectedRevision: JSON.parse(read.stdout).configuration.revision, authorization: { source: 'current-request', reference: '开启定时提醒' },
          changes: [{ path: ['Timers', 'NotifyBeforeScheduledStart'], value: true }] });
        if (write.status !== 1 || JSON.parse(write.stdout).reason !== 'closed-confirmation-required') return 'closed-double-not-observed';
        const evidence = await collectEvidence(fixture, { completed: true, calls: [], outputs: [] });
        const observed = (evidence.daily?.observations ?? []) as { action?: string; actions?: { kind: string; action?: string }[] }[];
        if (!observed.some((item) => item.action === 'write' && item.actions?.some((action) => action.kind === 'process' && action.action === 'inspect'))) return 'daily-observer-missing';
        return evidence.changes.length ? 'unexpected-file-change' : undefined;
      } finally { await fixture.dispose(); }
    });
    await check('network-double', async () => {
      const cost = entry('account-cost-raw');
      const definition = cost.definition as ScenarioDefinition;
      const query = async (networkFixtures: Record<string, unknown>) => {
        const fixture = await createFixture({ skillDirectory: cost.skillDirectory!, companionSkills: cost.companionSkills, jsonInputs: definition.jsonInputs!, networkFixtures });
        try {
          return spawnSync(process.execPath, ['.claude/skills/maa-core/scripts/operator-cost.ts', 'query'], { cwd: fixture.workspace, env: fixture.env, encoding: 'utf8',
            input: JSON.stringify({ name: '合成干员', target: { elite: 2, level: 2 }, mode: 'raw' }) });
        } finally { await fixture.dispose(); }
      };
      const listed = await query(definition.networkFixtures!);
      if (listed.status !== 0 || JSON.parse(listed.stdout).status !== 'ok') return 'listed-request-not-answered';
      const [first, ...rest] = Object.keys(definition.networkFixtures!);
      const unlisted = await query(Object.fromEntries(rest.map((url) => [url, definition.networkFixtures![url]])));
      if (!first || unlisted.status === 0 && JSON.parse(unlisted.stdout).status === 'ok') return 'unlisted-request-not-rejected';
      return undefined;
    });
    for (const host of ['claude', 'codex'] as Host[]) for (const scenario of ['core-language', 'daily-closed', 'account-cost-raw']) {
      await check(`host-double:${host}:${scenario}`, async () => {
        const selected = entry(scenario);
        const script = join(scratch, `${host}-${scenario}.json`);
        await writeFile(script, JSON.stringify({ host, steps: doubleSteps(host, scenario), reply: 'Synthetic double reply.' }));
        const outcome = await runScenario({ host, model: 'host-double-model', scenario: selected.definition as ScenarioDefinition, executable: process.execPath,
          executableArgs: [doubleScript, script], auth: { mode: 'host-double' }, artifactParent: join(scratch, 'records'),
          ...(selected.skillDirectory ? { skillDirectory: selected.skillDirectory } : {}), companionSkills: selected.companionSkills });
        doubleRuns.push({ host, scenario, reason: outcome.reason, grade: outcome.record.grade.status, double: outcome.record.double === true });
        const saved = JSON.parse(await readFile(join(outcome.artifactDirectory, 'run.json'), 'utf8'));
        if (saved.double !== true) return 'double-mark-missing';
        return outcome.reason === 'completed' && outcome.record.grade.status === 'pass' ? undefined : `${outcome.reason}:${outcome.record.grade.failed.join(',')}`;
      });
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { status: checks.every((item) => item.status === 'pass') ? 'pass' : 'fail', double: true, baseline: false, checks, doubleRuns };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runEnvironmentPreflight();
  console.log(JSON.stringify(result));
  if (result.status !== 'pass') process.exitCode = 1;
}
