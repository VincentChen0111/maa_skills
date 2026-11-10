import { appendFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only the isolated runner preloads this observer; product installs never do.
const workspace = dirname(fileURLToPath(import.meta.url));
let file;
try { file = relative(workspace, realpathSync(process.argv[1])).replaceAll('\\', '/'); } catch {}
const native = file?.match(/^\.(?:agents|claude)\/skills\/(.+)$/);
if (native) {
  if (process.env.MAA_EVAL_MAA_PROCESS && native[1] === 'maa-core/scripts/maa-config.ts') {
    const { observeDaily } = await import('./.eval-daily-observer.mjs');
    observeDaily(workspace, file);
  }
  const action = process.argv[2];
  process.on('exit', (exitCode) => {
    appendFileSync(join(workspace, 'events.jsonl'), `${JSON.stringify({ kind: 'invocation', file: native[1], action, exitCode, pid: process.pid })}\n`);
  });
}
