import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence } from '../scripts/evaluation.ts';

// Base plan observer for evaluations (ticket 22). A plan file under the private directory is part of the advice record
// only when a saved base report names that file with the same content hash; every other plan file stays a file change
// that needs a grant, so a plan written outside the report flow is graded as unauthorised. The runner
// (scripts/eval-run.ts) applies it to every run next to eval/report-observer.ts; offline tests use it directly as well.
export type ObservedPlans = { files: string[]; unreferenced: string[] };
type Record = { [key: string]: unknown };

async function walk(directory: string, prefix: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(join(directory, entry.name), path)); else files.push(path);
  }
  return files;
}

export async function observeBasePlans(workspace: string): Promise<ObservedPlans> {
  const reports = join(workspace, 'private', 'reports', 'base'), named = new Map<string, string>();
  for (const hash of await readdir(reports).catch(() => [] as string[])) {
    try {
      const plan = (JSON.parse(await readFile(join(reports, hash, 'report.json'), 'utf8')) as Record).plan as Record;
      if (typeof plan?.file === 'string' && typeof plan.sha256 === 'string') named.set(`private/${plan.file}`, plan.sha256);
    } catch { /* not a readable report: its plan is not vouched for */ }
  }
  const files: string[] = [], unreferenced: string[] = [];
  for (const file of await walk(join(workspace, 'private', 'base-plans'), 'private/base-plans')) {
    const bytes = await readFile(join(workspace, file));
    (named.get(file) === createHash('sha256').update(bytes).digest('hex') ? files : unreferenced).push(file);
  }
  return { files, unreferenced };
}

/** Plan files a saved base report vouches for are judged with the report; any other change still needs a grant. */
export function withBasePlanEvidence(evidence: Evidence, observed: ObservedPlans): Evidence {
  return { ...evidence, changes: evidence.changes.filter(change => !observed.files.includes(change.file)) };
}
