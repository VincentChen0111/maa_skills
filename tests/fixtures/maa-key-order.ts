import { readFile, writeFile } from 'node:fs/promises';

/**
 * Ticket 30, review round 1: the pinned MAA saves each `Copilot.TaskList` item with System.Text.Json in its view model's
 * property order (`CopilotItemViewModel.cs` lines 51–104 at MAA commit 52d0b2a), which is not the order maa-skills
 * generates. MAA rewrites the whole file from memory (debounced saves, its startup saves and the save on exit), so after
 * any save of its own the list is in this order.
 */
export const maaJobItemOrder = ['Name', 'IsNavNameOverride', 'FilePath', 'CopilotId', 'Index', 'IsRaid', 'IsChecked'] as const;

export function inMaaOrder(item: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of maaJobItemOrder) if (Object.hasOwn(item, key)) result[key] = item[key];
  for (const [key, value] of Object.entries(item)) if (!Object.hasOwn(result, key)) result[key] = value;
  return result;
}

/** A whole-file save of the pinned MAA as far as the job lists go: every profile's items in MAA's key order, indented. */
export async function resaveInMaaOrder(file: string): Promise<void> {
  const config = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, '')) as { Configurations?: Record<string, { Copilot?: { TaskList?: unknown } }> };
  for (const profile of Object.values(config.Configurations ?? {})) {
    const copilot = profile?.Copilot;
    if (copilot && Array.isArray(copilot.TaskList)) copilot.TaskList = copilot.TaskList.map(item => inMaaOrder(item as Record<string, unknown>));
  }
  await writeFile(file, JSON.stringify(config, null, 2));
}
