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
export const skillDirectory = (name: string) => fileURLToPath(new URL(`../skills/${name}`, import.meta.url));

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

export function scenarioCatalog(): ScenarioEntry[] {
  return groups.flatMap(({ group, subject, companions, scenarios }) => scenarios.map((definition) => {
    const names = [...new Set([...(definition.skills ?? []), ...companions])];
    return { group, definition, ...(subject ? { skillDirectory: skillDirectory(subject) } : {}),
      companionSkills: Object.fromEntries(names.map((name) => [name, skillDirectory(name)])) };
  }));
}
export const scenarioGroups = () => [...groups.map(({ group }) => group), 'all'];
export const entryId = (entry: ScenarioEntry) => typeof entry.definition === 'string' ? entry.definition : entry.definition.id;

/** Resolves scenario ids, group names or `all`, in the given order and without duplicates. */
export function selectScenarios(names: string[]): ScenarioEntry[] {
  const catalog = scenarioCatalog();
  const selected: ScenarioEntry[] = [];
  for (const name of names) {
    const matches = name === 'all' ? catalog : catalog.filter((entry) => entry.group === name || entryId(entry) === name);
    if (!matches.length) throw new Error(`unknown-scenario:${name}`);
    for (const entry of matches) if (!selected.some((item) => entryId(item) === entryId(entry))) selected.push(entry);
  }
  return selected;
}
