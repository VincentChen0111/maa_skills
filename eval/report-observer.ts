import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence } from '../scripts/evaluation.ts';

// Report observer for evaluations (ticket 20). It reads the advice-report records a run left in the fixture's
// private directory, straight from the files, and turns them into the grader's `reports`/`reviews` evidence.
// Report records are graded by the report-review rule rather than by file grants, so they leave `changes`.
// Not wired into the runner yet (scripts/eval-run.ts belongs to ticket 28); offline tests use it directly.
export type ObservedReports = Pick<Evidence, 'reports' | 'reviews'> & { files: string[]; approvals: { file: string; items: string[] }[] };
type Record = { [key: string]: unknown };

async function list(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function json(file: string): Promise<Record | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Record; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function walk(directory: string, prefix: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(join(directory, entry.name), path)); else files.push(path);
  }
  return files;
}

const parentOf = (report: Record) => report.revisionOf && typeof report.revisionOf === 'object' ? String((report.revisionOf as Record).reportHash) : null;
const accepted = (review: Record | undefined) => Array.isArray(review?.findings) && review.findings.some(finding => (finding as Record).decision === 'accepted');

/**
 * The review state follows the protocol: a version whose review accepted an error is finished only once a corrected
 * version points to it (both then count as reviewed); without one it is `needs-correction` and its review did not pass.
 */
export async function observeReports(workspace: string): Promise<ObservedReports> {
  const root = join(workspace, 'private', 'reports');
  const observed: ObservedReports = { reports: [], reviews: [], files: await walk(root, 'private/reports'), approvals: [] };
  for (const kind of await list(root)) {
    const versions: { hash: string; report: Record }[] = [];
    for (const hash of await list(join(root, kind))) { const report = await json(join(root, kind, hash, 'report.json')); if (report) versions.push({ hash, report }); }
    const corrected = new Set(versions.map(version => parentOf(version.report)).filter((hash): hash is string => hash !== null));
    for (const { hash, report } of versions) {
      const directory = join(root, kind, hash), file = `private/reports/${kind}/${hash}/report.json`, parent = parentOf(report);
      const review = await json(parent ? join(root, kind, parent, 'review.json') : join(directory, 'review.json'));
      const reviewer = review?.outcome === 'reviewed' && review.reviewer && typeof review.reviewer === 'object'
        ? `${String((review.reviewer as Record).host)}:${String((review.reviewer as Record).method)}` : undefined;
      // A revision is reviewed through its parent only when that review accepted the errors it corrects.
      const finished = review?.outcome === 'reviewed' && (parent ? accepted(review) : !accepted(review) || corrected.has(hash));
      const failed = (await list(join(directory, 'review-failures'))).length > 0;
      observed.reports.push({ file, review: review?.outcome === 'reviewed' ? finished ? 'reviewed' : 'needs-correction' : review?.outcome === 'skipped' ? 'unreviewed'
        : failed ? 'review-failed' : 'pending-review', ...(reviewer ? { reviewer } : {}) });
      if (reviewer) observed.reviews.push({ file, reviewer, passed: finished });
      for (const name of await list(join(directory, 'approvals'))) {
        const approval = await json(join(directory, 'approvals', name));
        observed.approvals.push({ file, items: Array.isArray(approval?.items) ? approval.items.map(item => String((item as Record).id)) : [] });
      }
    }
  }
  return observed;
}

/** Evidence for grading: report records judged by the report-review rule, every other file change still needs a grant. */
export function withReportEvidence(evidence: Evidence, observed: ObservedReports): Evidence {
  return { ...evidence, changes: evidence.changes.filter(change => !observed.files.includes(change.file)),
    reports: [...evidence.reports, ...observed.reports], reviews: [...evidence.reviews, ...observed.reviews] };
}
