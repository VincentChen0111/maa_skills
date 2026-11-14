import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScenarioDefinition, ScenarioName } from './eval-run.ts';
import { accountScenarios } from '../eval/maa-account/scenarios.ts';
import { baseScenarios } from '../eval/maa-account/base-scenarios.ts';
import { costScenarios } from '../eval/maa-account/cost-scenarios.ts';
import { gapScenarios } from '../eval/maa-account/gap-scenarios.ts';
import { researchScenarios } from '../eval/maa-account/research-scenarios.ts';
import { sklandScenarios } from '../eval/maa-account/skland-scenarios.ts';
import { communityScenarios } from '../eval/maa-account/community-scenarios.ts';
import { reportScenarios } from '../eval/maa-account/report-scenarios.ts';
import { baseReportScenarios } from '../eval/maa-account/base-report-scenarios.ts';
import { coreScenarios } from '../eval/maa-core/scenarios.ts';
import { dailyScenarios } from '../eval/maa-daily/scenarios.ts';
import { stageScenarios } from '../eval/maa-daily/stage-scenarios.ts';
import { stageRunScenarios } from '../eval/maa-daily/stage-run-scenarios.ts';
import { stageAlternateScenarios } from '../eval/maa-daily/stage-alternate-scenarios.ts';
import { baseApplyScenarios } from '../eval/maa-daily/base-apply-scenarios.ts';
import { trainingScenarios } from '../eval/maa-daily/training-scenarios.ts';
import { doctorScenarios } from '../eval/maa-doctor/scenarios.ts';
import { helpScenarios } from '../eval/maa-help/scenarios.ts';
import { setupDownloadScenarios, setupScenarios } from '../eval/maa-setup/scenarios.ts';
import { crossSkillScenarios } from '../eval/cross-skill/scenarios.ts';

/** One runnable scenario with the skill directories the runner installs for it. */
export type ScenarioEntry = { group: string; definition: ScenarioName | ScenarioDefinition; skillDirectory?: string; companionSkills: Record<string, string> };
/**
 * Where a skill is installed from: the checkout's `skills/<name>`, or the same path in a payload directory (`--payload`, made
 * by `scripts/eval-payload.ts`). Only the installed skills move; the scenarios, their fixtures and the runner stay the checkout's.
 */
export const skillDirectory = (name: string, payload?: string) => payload ? join(payload, 'skills', name) : fileURLToPath(new URL(`../skills/${name}`, import.meta.url));

// Each product group installs its skill as the subject plus the companions its scripts need (at least maa-core).
const groups: { group: string; subject?: string; companions: string[]; scenarios: ScenarioDefinition[] }[] = [
  { group: 'maa-core', subject: 'maa-core', companions: [], scenarios: coreScenarios },
  { group: 'maa-help', subject: 'maa-help', companions: [], scenarios: helpScenarios },
  { group: 'maa-setup', subject: 'maa-setup', companions: ['maa-core'], scenarios: [...setupScenarios, ...setupDownloadScenarios] },
  { group: 'maa-doctor', subject: 'maa-doctor', companions: ['maa-core'], scenarios: doctorScenarios },
  { group: 'maa-account', subject: 'maa-account', companions: ['maa-core'], scenarios: [...accountScenarios, ...baseScenarios, ...costScenarios, ...gapScenarios, ...researchScenarios,
    ...sklandScenarios, ...communityScenarios, ...reportScenarios, ...baseReportScenarios] },
  { group: 'maa-daily', subject: 'maa-daily', companions: ['maa-core'], scenarios: [...dailyScenarios, ...stageScenarios, ...trainingScenarios, ...stageRunScenarios,
    ...stageAlternateScenarios, ...baseApplyScenarios] },
  // Cross-skill scenarios name their operating skills; each is installed under its own name next to maa-core.
  { group: 'cross-skill', companions: ['maa-core'], scenarios: crossSkillScenarios },
];

/** The catalog, each scenario installing its skills from the checkout or from the given payload directory. */
export function scenarioCatalog(payload?: string): ScenarioEntry[] {
  return groups.flatMap(({ group, subject, companions, scenarios }) => scenarios.map((definition) => {
    const names = [...new Set([...(definition.skills ?? []), ...companions, ...(definition.companions ?? [])])];
    return { group, definition, ...(subject ? { skillDirectory: skillDirectory(subject, payload) } : {}),
      companionSkills: Object.fromEntries(names.map((name) => [name, skillDirectory(name, payload)])) };
  }));
}
export const scenarioGroups = () => [...groups.map(({ group }) => group), 'all'];
export const entryId = (entry: ScenarioEntry) => typeof entry.definition === 'string' ? entry.definition : entry.definition.id;

/** Resolves scenario ids, group names or `all`, in the given order and without duplicates. */
export function selectScenarios(names: string[], payload?: string): ScenarioEntry[] {
  const catalog = scenarioCatalog(payload);
  const selected: ScenarioEntry[] = [];
  for (const name of names) {
    const matches = name === 'all' ? catalog : catalog.filter((entry) => entry.group === name || entryId(entry) === name);
    if (!matches.length) throw new Error(`unknown-scenario:${name}`);
    for (const entry of matches) if (!selected.some((item) => entryId(item) === entryId(entry))) selected.push(entry);
  }
  return selected;
}
/** Scenario ids for a comparison subset: a group name or `all` expands through the catalog, anything else is taken as an id. */
export function scenarioIds(names: string[]): string[] {
  const catalog = scenarioCatalog();
  return [...new Set(names.flatMap((name) => name === 'all' ? catalog.map(entryId)
    : scenarioGroups().includes(name) ? catalog.filter((entry) => entry.group === name).map(entryId) : [name]))];
}

/**
 * What a scenario needs from the payload it runs on, read from its own definition: every skill it installs (with its
 * SKILL.md), every script its command patterns and expected calls name (`node *<name>.ts …`, found by file name in an
 * installed skill), and every public data commit its network fixtures pin (named in an installed skill's text, so the
 * product requests what the fixture answers).
 */
export function scenarioRequirements(entry: ScenarioEntry): { directories: string[]; scripts: string[]; dataCommits: string[] } {
  const definition = typeof entry.definition === 'object' ? entry.definition : undefined;
  const commands = definition ? [...definition.commands ?? [], ...definition.policy.expectedCalls] : [];
  return {
    directories: [...new Set([...(entry.skillDirectory ? [entry.skillDirectory] : []), ...Object.values(entry.companionSkills)])],
    scripts: [...new Set(commands.flatMap((command) => command.match(/^node\s+\*?([\w.-]+\.(?:ts|mts|mjs|js|cjs))(?:\s|$)/)?.[1] ?? []))],
    dataCommits: [...new Set(Object.keys(definition?.networkFixtures ?? {}).map((url) => url.split('/')[5]!))],
  };
}
export type ScenarioRefusal = { code: 'payload-skill-missing' | 'payload-script-missing' | 'payload-data-commit-missing'; detail: string };
/**
 * The scenarios the installed skills cannot serve, by id, each with one static code and what is missing (a skill name, a
 * script file name or a data commit): the first missing skill, else the first missing script, else the first missing data
 * commit. A batch refuses these before any host call and never counts them as passed or failed.
 */
export async function payloadRefusals(entries: ScenarioEntry[]): Promise<Map<string, ScenarioRefusal>> {
  const listings = new Map<string, Promise<string[] | undefined>>();
  const texts = new Map<string, Promise<string>>();
  const list = async (directory: string, relative = ''): Promise<string[]> => (await Promise.all((await readdir(join(directory, relative), { withFileTypes: true })).map(async (item) =>
    item.isDirectory() ? list(directory, join(relative, item.name)) : item.isFile() ? [join(relative, item.name)] : []))).flat();
  const listing = (directory: string) => listings.get(directory) ?? listings.set(directory, (async () => {
    try { if (!(await stat(join(directory, 'SKILL.md'))).isFile()) return undefined; } catch { return undefined; }
    return list(directory);
  })()).get(directory)!;
  const text = (directory: string) => texts.get(directory) ?? texts.set(directory, (async () =>
    (await Promise.all((await listing(directory) ?? []).map((file) => readFile(join(directory, file), 'utf8')))).join('\n'))()).get(directory)!;
  const refusals = new Map<string, ScenarioRefusal>();
  for (const entry of entries) {
    const { directories, scripts, dataCommits } = scenarioRequirements(entry);
    const files = await Promise.all(directories.map(listing));
    const skill = directories.find((_directory, index) => !files[index]);
    const names = new Set(files.flatMap((items) => items ?? []).map((file) => basename(file)));
    const script = scripts.find((name) => !names.has(name));
    const installedText = dataCommits.length && !skill ? (await Promise.all(directories.map(text))).join('\n') : '';
    const commit = dataCommits.find((value) => !installedText.includes(value));
    const refusal: ScenarioRefusal | undefined = skill ? { code: 'payload-skill-missing', detail: basename(skill) } : script ? { code: 'payload-script-missing', detail: script }
      : commit ? { code: 'payload-data-commit-missing', detail: commit } : undefined;
    if (refusal) refusals.set(entryId(entry), refusal);
  }
  return refusals;
}
