import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence } from '../scripts/evaluation.ts';

// Report observer for evaluations (ticket 20). It reads the advice-report records a run left in the fixture's
// private directory, straight from the files, and turns them into the grader's `reports`/`reviews`/`approvals` evidence.
// Records inside a saved report version are graded by the report-review rule and the scenario's approval declaration
// rather than by file grants, so they leave `changes`; any other file under the reports directory (an approvals file with
// no report version, for example) stays a file change that needs a grant.
// The runner (scripts/eval-run.ts) applies it to every run; offline tests use it directly as well.
export type ObservedReports = Pick<Evidence, 'reports' | 'reviews'> & { files: string[]; approvals: { file: string; report: string; items: string[] }[] };
type Record = { [key: string]: unknown };

const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code));
async function list(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).sort(); } catch (error) { if (absent(error)) return []; throw error; }
}
async function json(file: string): Promise<Record | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Record; } catch (error) { if (absent(error)) return undefined; throw error; }
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
  const observed: ObservedReports = { reports: [], reviews: [], files: [], approvals: [] };
  for (const kind of await list(root)) {
    const versions: { hash: string; report: Record }[] = [];
    for (const hash of await list(join(root, kind))) { const report = await json(join(root, kind, hash, 'report.json')); if (report) versions.push({ hash, report }); }
    // Only a saved report version's own records are judged with the report: nothing outside a version directory, and in its
    // approvals directory only the records directly inside it (each one graded below).
    for (const { hash } of versions) {
      const prefix = `private/reports/${kind}/${hash}`, approvals = `${prefix}/approvals/`;
      observed.files.push(...(await walk(join(root, kind, hash), prefix)).filter(path => !path.startsWith(approvals) || !path.slice(approvals.length).includes('/')));
    }
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
      // An approval counts with its items only when it is this version's record; an unreadable or foreign one carries none (it never matches).
      for (const name of await list(join(directory, 'approvals'))) {
        const approval = await json(join(directory, 'approvals', name)).catch(() => undefined);
        const own = approval?.kind === kind && approval.reportHash === hash && Array.isArray(approval.items);
        observed.approvals.push({ file: `private/reports/${kind}/${hash}/approvals/${name}`, report: file,
          items: own ? (approval.items as unknown[]).map(item => String((item as Record)?.id)) : [] });
      }
    }
  }
  return observed;
}

/**
 * Evidence for grading: report records judged by the report-review rule and approvals by the scenario's declaration (the
 * grader compares them), every other file change still needs a grant. Only report versions this run created or changed (a
 * changed file in the version's directory: report, review, failure or approval) are graded, and only the approval records this
 * run created or changed; records the scenario's world already held, such as an approved report that daily applies, are not
 * this run's.
 */
export function withReportEvidence(evidence: Evidence, observed: ObservedReports): Evidence {
  const changed = evidence.changes.map(change => change.file);
  const touched = (file: string) => { const directory = file.slice(0, file.lastIndexOf('/') + 1); return changed.some(path => path.startsWith(directory)); };
  return { ...evidence, changes: evidence.changes.filter(change => !observed.files.includes(change.file)),
    reports: [...evidence.reports, ...observed.reports.filter(report => touched(report.file))], reviews: [...evidence.reviews, ...observed.reviews.filter(review => touched(review.file))],
    approvals: [...evidence.approvals ?? [], ...observed.approvals.filter(approval => changed.includes(approval.file)).map(({ file, items }) => ({ file, items }))] };
}
