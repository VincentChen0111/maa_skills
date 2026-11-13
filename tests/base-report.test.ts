import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { draftBaseReport, formatBaseReportMarkdown, formatBaseReportBody, changedReportResults, resultProducers, approveBaseReportItems, baseReportFreshness,
  type BaseContent } from '../skills/maa-core/scripts/base-report.ts';
import { loadAdviceReport, recordReview, recordReviewSkip, writeReviewBrief, resolveApprovedItem } from '../skills/maa-core/scripts/advice-report.ts';
import { readVerificationRecord } from '../skills/maa-core/scripts/maa-version.ts';
import { planInput, planHome, planNetwork, planSnapshot, planTables } from './fixtures/base-plan-data.ts';

// Synthetic layout, roster, skills and MAA name table only. The network is the only replaced boundary.
const script = fileURLToPath(new URL('../skills/maa-core/scripts/base-report.ts', import.meta.url));
const goals = { source: 'user-stated', text: '我想要龙门币和赤金稳定，一天换两次班' };
const draft = (extra: Record<string, unknown> = {}) => ({ goals, ...planInput(), summary: '两班轮换，金工和交涉干员各上 12 小时', ...extra });

test('a draft writes the plan in the private directory, keeps facts and inference apart and waits for the default review', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  const maaBefore = await readdir(join(home, 'maa'), { recursive: true });
  const result = await draftBaseReport(draft(), { home, fetcher: planNetwork() });
  assert.equal(result.status, 'saved', JSON.stringify(result));
  if (result.status !== 'saved') return;
  const content = result.state.content;
  assert.equal(result.state.status, 'pending-review');
  assert.equal(content.plan.sha256.length, 64);
  assert.equal(await readFile(join(home, content.plan.file), 'utf8').then(text => JSON.parse(text).plans.length), 2, 'the plan file is in the private directory');
  assert.deepEqual(content.items.map(item => [item.id, item.scope.applicable]), [['P1', true]]);
  assert.deepEqual(content.items[0]!.scope.dailyMayArrange, [{ action: 'apply-custom-infrast-plan', planFile: content.plan.file, sha256: content.plan.sha256 }]);
  assert.deepEqual(content.maaProtocol, { version: 'v6.21.4', commit: '52d0b2acaca116585b02e1e6a9da303460f81a24', file: 'docs/zh-cn/protocol/base-scheduling-schema.md' });
  const markdown = formatBaseReportMarkdown(result.state);
  for (const text of ['# 基建建议报告', '【待审查】', '目标（你的原话）：我想要龙门币和赤金稳定，一天换两次班', '## 排班（事实：工具导出的排班文件）', '## 干员的有效技能（事实',
    '合成金工〔当前有效〕：进驻制造站时，贵金属类配方的生产力+30%', '## 收益（推断）', '基础 100 + 技能 60 + 全局 5 = 165', '## 验收门', '## 你可以做的步骤和成本',
    '每天换班 2 次', '## 数据新鲜度（生成时）', '账号快照：新鲜', '## 未建模', 'maa-account 不写 MAA 配置、不执行排班', '总体推断：两班轮换']) assert.ok(markdown.includes(text), text);
  assert.ok(!markdown.includes('不执行培养'), 'the shared banner speaks about the base plan, not cultivation');
  assert.deepEqual(await readdir(join(home, 'maa'), { recursive: true }), maaBefore, 'no MAA file changes');
});

// Ticket 25: the report records the MAA version and the verification-record version read when it is generated. The
// MAA.exe metadata reader is the replaced boundary; no real PowerShell runs.
test('the report stamps the MAA and verification-record versions read at generation; an unreadable version is null, never guessed', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  const { recordVersion } = await readVerificationRecord();
  assert.ok(recordVersion !== null && recordVersion >= 1, 'the packaged record carries its own version');
  const absent = await draftBaseReport(draft(), { home, fetcher: planNetwork(), versionReader: async () => { throw new Error('must not run without MAA.exe'); } });
  if (absent.status !== 'saved') return assert.fail(JSON.stringify(absent));
  assert.deepEqual(absent.state.content.versions, { maaVersion: null, recordVersion }, 'no MAA.exe: the version is unknown and the reader is not run');
  await writeFile(join(home, 'maa', 'MAA.exe'), 'synthetic executable placeholder');
  const reads: string[] = [];
  const read = await draftBaseReport(draft(), { home, fetcher: planNetwork(), versionReader: async directory => { reads.push(directory); return '6.22.0'; } });
  if (read.status !== 'saved') return assert.fail(JSON.stringify(read));
  assert.deepEqual(read.state.content.versions, { maaVersion: '6.22.0', recordVersion });
  assert.deepEqual(reads, [join(home, 'maa')], 'the configured MAA directory is read once');
  const unreadable = await draftBaseReport(draft(), { home, fetcher: planNetwork(), versionReader: async () => { throw new Error('synthetic unreadable version'); } });
  if (unreadable.status !== 'saved') return assert.fail(JSON.stringify(unreadable));
  assert.deepEqual(unreadable.state.content.versions, { maaVersion: null, recordVersion });
  // The stamp is part of the immutable report version: the approval binds it, and editing it later breaks the hash.
  assert.deepEqual(((await loadAdviceReport(home, 'base', read.reportHash)).content as BaseContent).versions, { maaVersion: '6.22.0', recordVersion });
});

test('without stated goals the draft asks first; an assumption is saved only as a labelled assumption', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await draftBaseReport(draft({ goals: undefined }), { home, fetcher: planNetwork() }), { status: 'needs-input', issues: ['goals-required'] });
  assert.deepEqual(await draftBaseReport(draft({ layout: undefined }), { home, fetcher: planNetwork() }), { status: 'needs-input', issues: ['layout-required'] });
  const assumed = await draftBaseReport(draft({ goals: { source: 'assumed', text: '假设你以龙门币为主' } }), { home, fetcher: planNetwork() });
  if (assumed.status !== 'saved') return assert.fail(JSON.stringify(assumed));
  assert.ok(formatBaseReportMarkdown(assumed.state).includes('目标（假设，不是你的原话）：假设你以龙门币为主'));
});

test('a failing gate is named in the report and blocks approval; unverified items are listed and travel with the approval', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  const failing = await draftBaseReport(draft({ layout: planInput().layout.map(room => room.type === 'control' ? { ...room, level: 2 } : room) }), { home, fetcher: planNetwork() });
  if (failing.status !== 'saved') return assert.fail(JSON.stringify(failing));
  assert.equal(failing.state.content.items[0]!.scope.applicable, false);
  const failingMarkdown = formatBaseReportMarkdown(failing.state);
  assert.ok(failingMarkdown.includes('不可应用') && failingMarkdown.includes('第 10 项（控制中枢满员、光环不重复）'), 'the report says which gate failed');
  await recordReviewSkip(home, 'base', failing.reportHash, { userWords: '这次跳过审查' });
  await assert.rejects(approveBaseReportItems(home, failing.reportHash, { items: ['P1'], userWords: '批准' }), /base-plan-not-applicable/);

  const open = await draftBaseReport(draft({ moodDefault: undefined, combos: undefined }), { home, fetcher: planNetwork() });
  if (open.status !== 'saved') return assert.fail(JSON.stringify(open));
  const scope = open.state.content.items[0]!.scope;
  assert.equal(scope.applicable, true);
  assert.deepEqual((scope.unverified as string[]).filter(entry => entry.startsWith('gate-')), ['gate-4', 'gate-7', 'gate-14']);
  const openMarkdown = formatBaseReportMarkdown(open.state);
  assert.ok(openMarkdown.includes('未核实的项（不算通过，是否应用由你决定）') && openMarkdown.includes('第 4 项（心情上限与恢复）'));
  await recordReviewSkip(home, 'base', open.reportHash, { userWords: '不用审' });
  const { approval } = await approveBaseReportItems(home, open.reportHash, { items: ['P1'], userWords: '批准 P1，未核实的我知道了' });
  assert.deepEqual(approval.items.map(item => item.reference), [`base/${open.reportHash}#P1`]);
  const resolved = await resolveApprovedItem(home, `base/${open.reportHash}#P1`);
  assert.deepEqual(resolved.item.scope.unverified, scope.unverified, 'maa-daily sees what the user approved without verification');
  assert.ok((resolved.item.scope.notIncluded as string[]).includes('maa-config-by-account'));
});

test('review, correction and approval reuse the shared protocol; the correction lists what changed', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  const first = await draftBaseReport(draft(), { home, fetcher: planNetwork() });
  if (first.status !== 'saved') return assert.fail(JSON.stringify(first));
  const { sha256 } = await writeReviewBrief(home, 'base', first.reportHash, formatBaseReportBody(first.state.content).join('\n'));
  const brief = await readFile(join(home, 'reports', 'base', first.reportHash, 'review-brief.md'), 'utf8');
  assert.ok(brief.includes('基建报告') && brief.includes('`check`'), 'the shared template also tells the reviewer where base numbers live');
  await recordReview(home, 'base', first.reportHash, { reviewer: { host: 'claude', method: 'fresh-context' }, briefSha256: sha256,
    findings: [{ id: 'F1', location: '总体推断', problem: '总体推断说三班', evidence: '方案只有两个计划', decision: 'accepted', reason: '可在报告中核实的真实错误' }] });
  assert.equal((await loadAdviceReport(home, 'base', first.reportHash)).status, 'needs-correction');
  await writeFile(join(home, 'account-snapshot.json'), JSON.stringify(planSnapshot(['char_ghost', 'char_rec1'])));
  const revision = await draftBaseReport(draft({ summary: '两班轮换', revisionOf: { reportHash: first.reportHash, corrections: [{ finding: 'F1', change: '总体推断改为两班' }] } }),
    { home, fetcher: planNetwork() });
  if (revision.status !== 'saved') return assert.fail(JSON.stringify(revision));
  assert.equal(revision.state.status, 'reviewed');
  assert.deepEqual(revision.state.content.revisionOf!.changedFields, ['summary']);
  assert.deepEqual(revision.state.content.revisionOf!.changedResults, ['snapshot.fingerprint'], 'the re-read snapshot changed; nothing else did');
  const markdown = formatBaseReportMarkdown(revision.state);
  assert.ok(markdown.includes('改正 F1：总体推断改为两班') && markdown.includes('这些变化没有经过审查'));
  const { approval } = await approveBaseReportItems(home, revision.reportHash, { items: ['P1'], userWords: '批准' });
  assert.equal(approval.reviewStatus, 'reviewed');
});

// The single predicate for corrections: every re-read or recomputed producer lists real changes and never a later
// read of the same content.
test('conformance: every re-read or recomputed producer lists real changes only, never a later read of the same content', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  const first = await draftBaseReport(draft(), { home, fetcher: planNetwork() });
  if (first.status !== 'saved') return assert.fail(JSON.stringify(first));
  const base = first.state.content, later = '2099-01-01T00:00:00.000Z';
  const cases: Record<string, { later: (content: BaseContent) => void; changed: (content: BaseContent) => void; field: string }> = {
    'snapshot': { later: content => { content.snapshot.readAt = later; content.snapshot.sourceTimes = { operators: later, inventory: later }; },
      changed: content => { content.snapshot.coverage = { ...content.snapshot.coverage as object, operators: { status: 'partial', issues: [] } }; }, field: 'snapshot.coverage' },
    'operators': { later: () => undefined, changed: content => { content.operators['合成金一']!.skills[0]!.text = '改过的条件'; }, field: 'operators.合成金一' },
    'check': { later: () => undefined, changed: content => { content.check.gates[0]!.verdict = 'fail'; }, field: 'check.gates' },
    'plan-file': { later: () => undefined, changed: content => { content.plan.sha256 = '0'.repeat(64); }, field: 'plan.sha256' },
    'name-table': { later: () => undefined, changed: content => { content.sources.names.sha256 = 'f'.repeat(64); }, field: 'sources.names' },
    'public-tables': { later: content => { content.sources.files = content.sources.files.map(file => ({ ...file, readAt: later })); },
      changed: content => { content.sources.files = content.sources.files.map((file, index) => index ? file : { ...file, sha256: '0'.repeat(64) }); }, field: 'sources.files' },
    'maa-protocol': { later: () => undefined, changed: content => { content.maaProtocol = { ...content.maaProtocol, commit: 'f'.repeat(40) }; }, field: 'maaProtocol' },
  };
  assert.deepEqual(resultProducers.map(producer => producer.name), Object.keys(cases), 'every producer is enumerated here');
  for (const [name, check] of Object.entries(cases)) {
    const reread = structuredClone(base); check.later(reread);
    assert.deepEqual(changedReportResults(base, reread), [], `${name}: the same content read again later is not a change`);
    const changed = structuredClone(base); check.changed(changed);
    assert.deepEqual(changedReportResults(base, changed), [check.field], `${name}: a real change is listed`);
  }
  // Every top-level content key is a producer's result, the agent's input (changedFields) or version metadata.
  assert.deepEqual(Object.keys(base).sort(), ['assumptions', 'check', 'createdAt', 'goals', 'input', 'items', 'kind', 'maaProtocol', 'operators', 'plan', 'revisionOf',
    'schemaVersion', 'snapshot', 'sources', 'summary', 'versions']);
  // The MAA and record versions read at generation are version metadata like createdAt: a correction drafted after MAA
  // was upgraded did not change a result (applying reports the version difference instead).
  assert.deepEqual(changedReportResults(base, { ...structuredClone(base), versions: { maaVersion: '6.22.1', recordVersion: 99 } }), []);
});

test('freshness is fresh, stale or unknown; a stale check is re-run and the old result is not used as proof', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  const result = await draftBaseReport(draft(), { home, fetcher: planNetwork() });
  if (result.status !== 'saved') return assert.fail(JSON.stringify(result));
  const fresh = await baseReportFreshness(home, result.reportHash, { home, fetcher: planNetwork() });
  assert.deepEqual(fresh.states, { snapshot: 'fresh', tables: 'fresh', names: 'fresh', plan: 'fresh', check: 'fresh' });
  assert.equal(fresh.recheck, null);
  await writeFile(join(home, 'account-snapshot.json'), JSON.stringify({ ...planSnapshot(), readAt: '2099-01-01T00:00:00.000Z' }));
  assert.equal((await baseReportFreshness(home, result.reportHash, { home, fetcher: planNetwork() })).states.check, 'fresh', 'the same facts read later stay fresh');
  await writeFile(join(home, 'account-snapshot.json'), JSON.stringify(planSnapshot(['char_ghost', 'char_gold1'])));
  const stale = await baseReportFreshness(home, result.reportHash, { home, fetcher: planNetwork() });
  assert.equal(stale.states.snapshot, 'stale'); assert.equal(stale.states.check, 'stale');
  assert.ok(stale.recheck && stale.recheck.warnings.includes('operator-unowned:合成金一'), 'the check runs again on the current snapshot');
  const offline = await baseReportFreshness(home, result.reportHash, { home, fetcher: async () => { throw new Error('offline'); } });
  assert.equal(offline.states.tables, 'unknown');
  const file = join(home, result.state.content.plan.file);
  await writeFile(file, (await readFile(file, 'utf8')).replace('白班', '早班'));
  const edited = await baseReportFreshness(home, result.reportHash, { home, fetcher: planNetwork() });
  assert.equal(edited.states.plan, 'stale');
  assert.equal(edited.recheck!.gates.find(entry => entry.gate === 13)!.verdict, 'fail', 'an edited plan file is not the approved export');
});

test('the CLI drafts, reads, skips and approves through the shared protocol and never touches MAA', async (t) => {
  const home = await planHome(); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'tables.json'), JSON.stringify(planTables()));
  const run = (action: string, input: unknown) => {
    const result = spawnSync(process.execPath, [script, action], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, env: { ...process.env, MAA_SKILLS_HOME: home } });
    return { status: result.status, stdout: result.stdout, json: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })() };
  };
  const drafted = run('draft', { ...draft(), tablesFile: join(home, 'tables.json') });
  assert.equal(drafted.status, 0, drafted.stdout);
  assert.equal(drafted.json.status, 'pending-review'); assert.equal(drafted.json.applicable, true); assert.deepEqual(drafted.json.items, [{ id: 'P1', title: drafted.json.items[0].title }]);
  const reportHash = drafted.json.reportHash as string;
  const read = run('read', { reportHash, format: 'markdown' });
  assert.equal(read.status, 0); assert.ok(read.stdout.includes('来源：所提供的离线表，本次未从公开镜像获取或核验'));
  assert.deepEqual(run('approve', { reportHash, items: ['P1'], userWords: '批准' }).json, { ok: false, error: 'report-not-approvable:pending-review' });
  assert.equal(run('skip', { reportHash, userWords: '这次跳过审查' }).json.status, 'unreviewed');
  const approved = run('approve', { reportHash, items: ['P1'], userWords: '批准 P1' });
  assert.deepEqual(approved.json, { ok: true, status: 'unreviewed', approved: [{ id: 'P1', reference: `base/${reportHash}#P1` }] });
  const fresh = run('freshness', { reportHash });
  assert.equal(fresh.json.ok, true); assert.equal(fresh.json.states.check, 'fresh');
  assert.deepEqual(run('draft', { ...draft({ goals: undefined }), tablesFile: join(home, 'tables.json') }).json, { ok: false, status: 'needs-input', issues: ['goals-required'] });
  assert.deepEqual(run('nonsense', {}).json, { ok: false, error: 'base-action-invalid' });
});
