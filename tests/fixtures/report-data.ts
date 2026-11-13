// Synthetic inputs for advice-report tests and evaluation scenarios. No real account, operator or post.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { craftingSources } from '../../skills/maa-core/scripts/cultivation-gaps.ts';
import { operatorCostSources } from '../../skills/maa-core/scripts/operator-cost.ts';
import { gapTables, gapSnapshot, gapProgress, gapGoal } from './gap-data.ts';

const raw = (source: { repository: string; commit: string; file: string }) => `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`;
/** The pinned public URLs mapped to synthetic tables, for both a fetcher double and the evaluation network fixture. */
export function reportNetworkFixtures(): Record<string, unknown> {
  const tables = gapTables();
  return Object.fromEntries(Object.entries({ ...operatorCostSources, ...craftingSources }).map(([key, source]) => [raw(source), tables[key as keyof typeof tables]]));
}
export function reportFetcher(): typeof fetch {
  const routes = reportNetworkFixtures();
  return async (input) => {
    if (!Object.hasOwn(routes, String(input))) throw new Error(`unexpected request ${String(input)}`);
    return new Response(JSON.stringify(routes[String(input)]));
  };
}
/** A settings home that is also the private directory, holding a synthetic snapshot. */
export async function reportHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'maa-advice-report-'));
  await writeFile(join(directory, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: directory }));
  await writeFile(join(directory, 'account-snapshot.json'), JSON.stringify(gapSnapshot()));
  return directory;
}
export const reportDraft = () => ({
  priorities: { source: 'user-stated', text: '我主要打肉鸽，肉鸽优先' },
  steps: [{ ...gapGoal, reason: '肉鸽里经常用到，先补精一' }, { name: '合成二号', target: { elite: 1, level: 1 }, reason: '其次补齐第二位' }],
  progress: gapProgress,
});
export const reportSnapshot = gapSnapshot;
