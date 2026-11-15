import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftCultivationReport, formatCultivationReportMarkdown } from '../skills/maa-core/scripts/cultivation-report.ts';
import { operatorCostSources } from '../skills/maa-core/scripts/operator-cost.ts';
import { craftingSources } from '../skills/maa-core/scripts/cultivation-gaps.ts';
import { gapTables, gapSnapshot, gapProgress } from './fixtures/gap-data.ts';

// Over-blocking review OB-9 (coordinator: "print its source and read time"); package 2 review round 1, finding F1: the
// cultivation report read the Skland snapshot on its own and said neither which snapshot nor why.

const raw = (source: { repository: string; commit: string; file: string }) => `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.file}`;
const network = (): typeof fetch => {
  const tables = gapTables();
  const routes: Record<string, unknown> = Object.fromEntries(Object.entries({ ...operatorCostSources, ...craftingSources }).map(([key, source]) => [raw(source), tables[key as keyof typeof tables]]));
  return async input => new Response(JSON.stringify(routes[String(input)]));
};

test('the cultivation report says which snapshot it read, why, and the Skland read-time caveat', async t => {
  const home = await mkdtemp(join(tmpdir(), 'maa-cultivation-source-')); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.json'), JSON.stringify({ language: 'zh-CN', privateDirectory: home }));
  const skland = { ...gapSnapshot(), source: 'skland', readAt: '2026-01-01T00:00:00.000Z',
    operators: gapSnapshot().operators.map(operator => ({ ...operator, skillLevel: 7, mastery: { 1: 0 }, modules: {} })),
    coverage: { operators: { status: 'complete', issues: [] }, inventory: { status: 'complete', issues: [] } } };
  await writeFile(join(home, 'account-snapshot.json'), JSON.stringify(gapSnapshot()));
  await writeFile(join(home, 'account-snapshot-skland.json'), JSON.stringify(skland));
  const draft = (target: Record<string, unknown>) => draftCultivationReport({ priorities: { source: 'user-stated', text: '合成用户：先练技能' },
    steps: [{ name: '合成干员', target, reason: '合成理由' }], progress: gapProgress }, { home, fetcher: network() });
  // A skill target needs skills, which only the Skland snapshot has: it is read whole, and the report says so.
  const result = await draft({ skillLevel: 7 });
  assert.equal(result.status, 'saved', JSON.stringify(result));
  if (result.status !== 'saved') return;
  assert.deepEqual(result.state.content.snapshotSelection, { source: 'skland', readAt: '2026-01-01T00:00:00.000Z', chosen: 'skland-covers', lacking: ['skills'] });
  const markdown = formatCultivationReportMarkdown(result.state);
  assert.match(markdown, /账号来源：森空岛快照（MAA 识别快照没有技能等级、专精和模组，森空岛快照完整，整份改读森空岛快照，两份不合并）/);
  assert.match(markdown, /不是游戏内的数据时间/);
});
