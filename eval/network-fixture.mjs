import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression fixture, not a security boundary against a hostile model. Never installed in product skills.
const workspace = dirname(fileURLToPath(import.meta.url));
let file;
try { file = relative(workspace, realpathSync(process.argv[1])).replaceAll('\\', '/'); } catch {}
// Exactly these product entries and actions. The cultivation report draft loads the same pinned tables (ticket 20); the
// base plan and base report actions below read the pinned public tables when no tablesFile is given (ticket 22).
const entries = { 'operator-cost': ['query'], 'cultivation-gaps': ['query'], 'cultivation-report': ['draft'],
  'base-plan': ['generate', 'check', 'candidates'], 'base-report': ['draft', 'freshness'] };
const entry = /^\.(agents|claude)\/skills\/maa-core\/scripts\/(operator-cost|cultivation-gaps|cultivation-report|base-plan|base-report)\.ts$/.exec(file ?? '');
if (entry && entries[entry[2]].includes(process.argv[2])) {
  const responses = JSON.parse(readFileSync(join(workspace, '.eval-network-responses.json'), 'utf8'));
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET' || !Object.hasOwn(responses, url)) throw new Error('eval-network-unlisted');
    return new Response(JSON.stringify(responses[url]), { headers: { 'Content-Type': 'application/json' } });
  };
}
