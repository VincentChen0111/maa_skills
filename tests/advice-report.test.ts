import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, collectEvidence } from '../scripts/eval-fixture.ts';
import { draftCultivationReport, formatCultivationReportMarkdown, formatCultivationReportBody, type CultivationContent } from '../skills/maa-core/scripts/cultivation-report.ts';
import { approveReportItems, loadAdviceReport, recordReview, recordReviewFailure, recordReviewSkip, resolveApprovedItem, writeReviewBrief,
  type ReportState } from '../skills/maa-core/scripts/advice-report.ts';
import { reportDraft, reportFetcher, reportHome, reportNetworkFixtures, reportSnapshot } from './fixtures/report-data.ts';

// The protocol is tested at its two seams: the installed CLI (both host layouts share one implementation)
// and the exported functions, with real temporary directories. No model runs; review results are synthetic.
const reviewer = { host: 'claude', method: 'fresh-context' };
const finding = (id: string, decision: 'accepted' | 'rejected', extra: Record<string, unknown> = {}) => ({ id, location: 'S1 推荐理由', problem: '理由与依据不符',
  evidence: '依据 E1 没有这么说', fix: '改写理由', decision, reason: decision === 'accepted' ? '可在报告中直接核实的真实错误' : '只是措辞偏好，不是错误', ...extra });

async function installed(t: TestContext) {
  const fixture = await createFixture({ skillDirectory: fileURLToPath(new URL('../skills/maa-account', import.meta.url)),
    companionSkills: { 'maa-core': fileURLToPath(new URL('../skills/maa-core', import.meta.url)) }, networkFixtures: reportNetworkFixtures(),
    jsonInputs: { 'private/config.json': { language: 'zh-CN', languageAsked: true, privateDirectory: '{{private}}' }, 'private/account-snapshot.json': reportSnapshot() } });
  t.after(() => fixture.dispose());
  const run = (action: string, input: unknown, host = '.agents') => {
    const result = spawnSync(process.execPath, [join(fixture.workspace, host, 'skills/maa-core/scripts/cultivation-report.ts'), action],
      { cwd: fixture.workspace, env: fixture.env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
    return { status: result.status, stdout: result.stdout, json: result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) : null };
  };
  return { fixture, run, privateDirectory: join(fixture.workspace, 'private') };
}
async function saved(t: TestContext) {
  const home = await reportHome(); t.after(() => rm(home, { recursive: true, force: true }));
  const result = await draftCultivationReport(reportDraft(), { home, fetcher: reportFetcher() });
  assert.equal(result.status, 'saved');
  return { home, hash: result.reportHash };
}
async function brief(home: string, hash: string) {
  const state = await loadAdviceReport(home, 'cultivation', hash);
  return writeReviewBrief(home, 'cultivation', hash, formatCultivationReportBody(state.content as CultivationContent).join('\n'));
}

test('the default review runs once from a self-contained brief; an accepted error is corrected without a second review before anything can be approved', async (t) => {
  const { fixture, run, privateDirectory } = await installed(t);
  const draft = run('draft', reportDraft());
  assert.equal(draft.status, 0, draft.stdout);
  assert.deepEqual([draft.json.ok, draft.json.status, draft.json.supportedThrough], [true, 'pending-review', 1]);
  const hash: string = draft.json.reportHash;
  const refused = (action: string, input: unknown, error: string) => { const result = run(action, input); assert.deepEqual([result.status, result.json], [1, { ok: false, error }], action); };
  refused('approve', { reportHash: hash, items: ['S1'], userWords: '批准第一步' }, 'report-not-approvable:pending-review');
  refused('review', { reportHash: hash, reviewer, briefSha256: '0'.repeat(64), findings: [] }, 'report-brief-required');

  const written = run('brief', { reportHash: hash });
  assert.equal(written.status, 0, written.stdout);
  assert.equal(relative(privateDirectory, written.json.file).replaceAll('\\', '/'), `reports/cultivation/${hash}/review-brief.md`);
  const text = await readFile(written.json.file, 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), written.json.sha256);
  assert.match(text, /^# 建议报告独立审查说明/); assert.ok(text.includes(`cultivation / ${hash}`)); assert.ok(!text.includes('{{'), 'every placeholder is filled');
  assert.match(text, /### S1 合成干员/); assert.match(text, /"supportedThrough": 1/); assert.match(text, /"findings":\[/);
  assert.ok(!/【待审查】|批准记录/.test(text), 'the brief carries the report, not its status or the author\'s conclusions');

  refused('review', { reportHash: hash, reviewer, briefSha256: '0'.repeat(64), findings: [] }, 'report-brief-mismatch');
  refused('review', { reportHash: hash, reviewer: { host: 'claude', method: 'codex-exec' }, briefSha256: written.json.sha256, findings: [] }, 'report-reviewer-invalid');
  refused('review', { reportHash: hash, reviewer, briefSha256: written.json.sha256, findings: [finding('F1', 'accepted', { reason: ' ' })] }, 'report-finding-reason-required:F1');
  refused('review', { reportHash: hash, reviewer, briefSha256: written.json.sha256, findings: [finding('F1', 'accepted', { decision: undefined })] }, 'report-finding-decision-required:F1');
  const reviewed = run('review', { reportHash: hash, reviewer, briefSha256: written.json.sha256, findings: [finding('F1', 'accepted'), finding('F2', 'rejected')] });
  assert.deepEqual([reviewed.status, reviewed.json.status], [0, 'needs-correction']);
  refused('review', { reportHash: hash, reviewer, briefSha256: written.json.sha256, findings: [] }, 'report-review-exists');
  refused('skip', { reportHash: hash, userWords: '跳过' }, 'report-review-exists');
  refused('approve', { reportHash: hash, items: ['S1'], userWords: '批准第一步' }, 'report-not-approvable:needs-correction');

  const corrected = { ...reportDraft(), steps: [{ ...reportDraft().steps[0]!, reason: '肉鸽里经常用到，先补精一（改正：依据只说明精一后好用）' }, reportDraft().steps[1]!] };
  refused('draft', { ...corrected, revisionOf: { reportHash: hash, corrections: [] } }, 'report-correction-missing:F1');
  refused('draft', { ...corrected, revisionOf: { reportHash: hash, corrections: [{ finding: 'F1', change: '改写' }, { finding: 'F2', change: '也改' }] } }, 'report-correction-not-accepted:F2');
  const revision = run('draft', { ...corrected, revisionOf: { reportHash: hash, corrections: [{ finding: 'F1', change: '按依据改写 S1 的推荐理由' }] } });
  assert.deepEqual([revision.status, revision.json.status], [0, 'reviewed'], revision.stdout);
  const next: string = revision.json.reportHash;
  refused('review', { reportHash: next, reviewer, briefSha256: written.json.sha256, findings: [] }, 'report-revision-already-reviewed');
  refused('brief', { reportHash: next }, 'report-revision-already-reviewed');
  const state = run('read', { reportHash: next }).json.report as ReportState<CultivationContent>;
  assert.deepEqual(state.content.revisionOf, { reportHash: hash, corrections: [{ finding: 'F1', change: '按依据改写 S1 的推荐理由' }], changedFields: ['steps[0].reason'],
    changedResults: [] }, 'nothing the draft re-read changed, so no tool result or citation differs');

  const approved = run('approve', { reportHash: next, items: ['S1'], userWords: '只批准第一步' });
  assert.deepEqual(approved.json, { ok: true, status: 'reviewed', approved: [{ id: 'S1', reference: `cultivation/${next}#S1` }] });
  const markdown = run('read', { reportHash: next, format: 'markdown' }).stdout;
  for (const expected of ['【已审查，已按审查改正】', '## 审查后的改动', '改正 F1：按依据改写 S1 的推荐理由', 'F2（拒绝）', '与原版本不同的输入：steps\\[0\\].reason',
    '与原版本不同的工具结果和资料：无', '批准 S1（你的原话：「只批准第一步」；当时已审查）',
    'maa-daily 可据此安排：无（这一步没有 daily 能执行的部分）', '你在游戏里自己完成：精英化和等级', '审查通过不等于批准，批准也不等于执行']) assert.ok(markdown.includes(expected), expected);
  assert.ok(!markdown.includes('批准 S2') && !markdown.includes('S1、S2'), 'only the named item is approved');

  assert.equal((await resolveApprovedItem(privateDirectory, `cultivation/${next}#S1`)).item.reference, `cultivation/${next}#S1`);
  await assert.rejects(resolveApprovedItem(privateDirectory, `cultivation/${next}#S2`), /report-item-not-approved/);
  await assert.rejects(resolveApprovedItem(privateDirectory, `cultivation/${hash}#S1`), /report-not-approvable:needs-correction/);
  const evidence = await collectEvidence(fixture, { completed: false, calls: [], outputs: [] });
  assert.ok(evidence.changes.length > 0 && evidence.changes.every(change => change.file.startsWith('private/reports/cultivation/')), 'only report records are written');
  assert.ok(!evidence.changes.some(change => change.file.startsWith('maa/')), 'MAA configuration is never touched');
  const other = run('read', { reportHash: next }, '.claude');
  assert.equal(other.json.report.hash, next, 'the second host layout reads the same records');
});

test('a correction drafted after the account snapshot changed lists every changed tool result and citation, not only the agent input', async (t) => {
  const { home, hash } = await saved(t);
  const { sha256 } = await brief(home, hash);
  await recordReview(home, 'cultivation', hash, { reviewer, briefSha256: sha256, findings: [finding('F1', 'accepted')] });
  const parent = (await loadAdviceReport(home, 'cultivation', hash)).content as CultivationContent;
  const snapshot = reportSnapshot(); snapshot.lmd = 100150; snapshot.items.mat = 50; // the user re-scanned between review and correction
  await writeFile(join(home, 'account-snapshot.json'), JSON.stringify(snapshot));
  const revision = await draftCultivationReport({ ...reportDraft(), revisionOf: { reportHash: hash, corrections: [{ finding: 'F1', change: '按依据改写 S1 的推荐理由' }] } },
    { home, fetcher: reportFetcher() });
  assert.equal(revision.status, 'saved');
  if (revision.status !== 'saved') return;
  const content = revision.state.content;
  assert.deepEqual([parent.supportedThrough, content.supportedThrough], [1, 2], 'the re-read stock changes the result');
  assert.deepEqual(content.revisionOf!.changedFields, [], 'the agent input itself is unchanged');
  for (const field of ['steps[0].cumulative', 'steps[1].cumulative', 'steps[1].supported', 'supportedThrough', 'gaps.comparison'])
    assert.ok(content.revisionOf!.changedResults.includes(field), field);
  assert.ok(!content.revisionOf!.changedResults.some(field => field.startsWith('sources')), 'the same pinned tables re-read later are not a change');
  const markdown = formatCultivationReportMarkdown(revision.state);
  assert.match(markdown, /\*\*【已审查，已按审查改正】\*\*.*改正时重新读取的快照、资料或公开表有变化，变化的部分没有经过审查/);
  assert.ok(markdown.includes('与原版本不同的输入：无'));
  assert.match(markdown, /与原版本不同的工具结果和资料：.*supportedThrough/);
});

test('an explicit skip starts no review, marks the report 未审查 at the top and still allows item approval', async (t) => {
  const { home, hash } = await saved(t);
  await assert.rejects(recordReviewSkip(home, 'cultivation', hash, { userWords: '  ' }), /report-user-words-required/);
  const skipped = await recordReviewSkip(home, 'cultivation', hash, { userWords: '这次赶时间，跳过审查' });
  assert.equal(skipped.status, 'unreviewed');
  const lines = formatCultivationReportMarkdown(skipped).split('\n');
  assert.equal(lines[0], '# 培养建议报告');
  assert.equal(lines[2], '> **【未审查】** 你本次明确跳过了独立审查（你的原话：「这次赶时间，跳过审查」）。报告里的数字和资料没有经过第二人核对，请自行权衡。');
  await assert.rejects(brief(home, hash), /report-review-exists/);
  await assert.rejects(recordReview(home, 'cultivation', hash, { reviewer, briefSha256: '0'.repeat(64), findings: [] }), /report-review-exists/);
  const { approval } = await approveReportItems(home, 'cultivation', hash, { items: ['S2'], userWords: '第二步可以' });
  assert.deepEqual([approval.reviewStatus, approval.items.map(item => item.id)], ['unreviewed', ['S2']]);
  assert.match(formatCultivationReportMarkdown(await loadAdviceReport(home, 'cultivation', hash)), /当时未审查/);
});

test('an unfinished review is never shown or approved as reviewed', async (t) => {
  const { home, hash } = await saved(t);
  await brief(home, hash);
  await assert.rejects(recordReviewFailure(home, 'cultivation', hash, { reviewer: { host: 'codex', method: 'codex-exec' }, reason: 'gave-up' }), /report-failure-invalid/);
  const failed = await recordReviewFailure(home, 'cultivation', hash, { reviewer: { host: 'codex', method: 'codex-exec' }, reason: 'host-unavailable', detail: '无法启动 codex exec' });
  assert.equal(failed.status, 'review-failed');
  assert.match(formatCultivationReportMarkdown(failed), /\*\*【审查未完成】\*\* 已发起的独立审查没有得出结论（1 次：无法启动独立审查）/);
  await assert.rejects(approveReportItems(home, 'cultivation', hash, { items: ['S1'], userWords: '批准' }), /report-not-approvable:review-failed/);
  const { sha256 } = await brief(home, hash);
  const reviewed = await recordReview(home, 'cultivation', hash, { reviewer, briefSha256: sha256, findings: [] });
  assert.deepEqual([reviewed.status, reviewed.review?.outcome === 'reviewed' && reviewed.review.priorFailures], ['reviewed', 1]);
  const markdown = formatCultivationReportMarkdown(reviewed);
  assert.match(markdown, /\*\*【已审查】\*\* 一名独立审查员审了一轮，报告 0 项意见/); assert.match(markdown, /此前未完成的审查：1 次/); assert.match(markdown, /审查员没有发现真实错误/);
  await assert.rejects(recordReviewFailure(home, 'cultivation', hash, { reviewer, reason: 'timeout' }), /report-review-exists/);

  const again = await saved(t);
  await recordReviewFailure(again.home, 'cultivation', again.hash, { reviewer, reason: 'no-usable-result' });
  const skipped = await recordReviewSkip(again.home, 'cultivation', again.hash, { userWords: '审查不成就算了，跳过' });
  assert.deepEqual([skipped.status, skipped.review?.outcome === 'skipped' && skipped.review.priorFailures], ['unreviewed', 1]);
});

test('approval names items explicitly, and a changed report file is refused instead of trusted', async (t) => {
  const { home, hash } = await saved(t);
  await recordReviewSkip(home, 'cultivation', hash, { userWords: '跳过审查' });
  for (const [input, error] of [[{ items: [], userWords: '批准' }, /report-approval-invalid/], [{ items: ['S9'], userWords: '批准' }, /report-item-unknown:S9/],
    [{ items: ['S1', 'S1'], userWords: '批准' }, /report-approval-invalid/], [{ items: ['S1'] }, /report-user-words-required/], [{ items: ['S1'], userWords: '批准', all: true }, /report-approval-invalid/]] as const)
    await assert.rejects(approveReportItems(home, 'cultivation', hash, input), error);
  const file = join(home, 'reports', 'cultivation', hash, 'report.json');
  const content = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...content, supportedThrough: 2 }));
  await assert.rejects(loadAdviceReport(home, 'cultivation', hash), /report-content-mismatch/);
  await assert.rejects(approveReportItems(home, 'cultivation', hash, { items: ['S1'], userWords: '批准' }), /report-content-mismatch/);
});
