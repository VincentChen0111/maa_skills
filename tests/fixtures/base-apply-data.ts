import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftBaseReport, approveBaseReportItems } from '../../skills/maa-core/scripts/base-report.ts';
import { recordReviewSkip } from '../../skills/maa-core/scripts/advice-report.ts';
import { nameTable, planInput, planSnapshot, planTables } from './base-plan-data.ts';
import { infrastConfig } from './base-apply-worlds.ts';

// Synthetic homes for the product tests of applying an approved base plan (ticket 23): a synthetic MAA GUI configuration
// with one Infrast task, and a base report drafted by the real ticket 22 tools from the synthetic roster. Only the MAA
// process is faked. The evaluation scenarios' worlds are fixed literals in tests/fixtures/base-apply-worlds.ts.
export const goals = { source: 'user-stated', text: '我想要龙门币和赤金稳定' };
export { infrastConfig };

export type ApplyHome = { home: string; maa: string; configFile: string; tablesFile: string; reportHash: string; reference: string };
/** A temporary home with settings, snapshot, MAA directory (name table and GUI configuration) and a saved base report. */
export async function applyHome(options: { input?: Record<string, unknown>; approve?: boolean; config?: unknown; baseFile?: unknown } = {}): Promise<ApplyHome> {
  const home = await mkdtemp(join(tmpdir(), 'maa-base-apply-')), maa = join(home, 'maa'), tablesFile = join(home, 'base-tables.json');
  await mkdir(join(maa, 'resource'), { recursive: true }); await mkdir(join(maa, 'config'), { recursive: true });
  if (options.baseFile !== undefined) {
    // An existing plan file the account edits: fields this tool does not know must survive into the applied copy.
    await mkdir(join(home, 'base-plans'), { recursive: true });
    await writeFile(join(home, 'base-plans', 'base.json'), JSON.stringify(options.baseFile));
    options = { ...options, input: { base: 'base-plans/base.json', ...options.input } };
  }
  await writeFile(join(maa, 'resource', 'battle_data.json'), JSON.stringify(nameTable()));
  await writeFile(join(maa, 'config', 'gui.new.json'), JSON.stringify(options.config ?? infrastConfig(), null, 2));
  await writeFile(join(home, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: home, maaDirectory: maa }));
  await writeFile(join(home, 'account-snapshot.json'), JSON.stringify(planSnapshot()));
  await writeFile(tablesFile, JSON.stringify(planTables()));
  const drafted = await draftBaseReport({ goals, ...planInput(), tablesFile, ...options.input }, { home, now: () => new Date('2026-11-13T09:00:00.000Z') });
  if (drafted.status !== 'saved') throw new Error(`fixture draft: ${JSON.stringify(drafted)}`);
  await recordReviewSkip(home, 'base', drafted.reportHash, { userWords: '这次跳过审查' });
  if (options.approve !== false) await approveBaseReportItems(home, drafted.reportHash, { items: ['P1'], userWords: '我批准排班这一项 P1' });
  return { home, maa, configFile: join(maa, 'config', 'gui.new.json'), tablesFile, reportHash: drafted.reportHash, reference: `base/${drafted.reportHash}#P1` };
}
