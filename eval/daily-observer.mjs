import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import promises from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const actions = [];
export function observeProcess(action, state) { actions.push({ kind: 'process', action, state }); }

/** Replaces only the documented MAA process boundary of the entry script with the synthetic one in the workspace. */
export function redirectMaaProcess(workspace) {
  const entry = realpathSync(process.argv[1]);
  const boundary = new URL('./maa-process.ts', pathToFileURL(entry)).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    return result.url === boundary ? { url: pathToFileURL(join(workspace, '.eval-maa-process.mjs')).href, shortCircuit: true } : result;
  } });
}

/**
 * Ticket 30's drift modes: MAA changes the configuration by itself between the agent's preview and its write. Applied once,
 * when the first write starts and before it reads the file, and recorded as the write's first action.
 */
function applyDrift(workspace) {
  const mode = process.env.MAA_EVAL_MAA_PROCESS;
  if (process.argv[2] !== 'write' || !['drift-noise', 'drift-projection'].includes(mode)) return;
  // Only the first write: the journal already holds every earlier invocation.
  const journal = process.env.MAA_EVAL_DAILY_JOURNAL;
  if (existsSync(journal) && readFileSync(journal, 'utf8').split('\n').some(line => line && JSON.parse(line).action === 'write')) return;
  const file = join(workspace, 'config/gui.new.json');
  const before = readFileSync(file);
  const config = JSON.parse(before.toString('utf8'));
  // Noise: the window placement MAA saves when its window closes. Projection: a "this run only" task enable state that MAA
  // resets to false when all tasks complete.
  if (mode === 'drift-noise') config.Gui = { ...config.Gui, WindowPlacement: { Left: 640, Top: 360, Width: 1280, Height: 720 } };
  else for (const profile of Object.values(config.Configurations)) for (const task of profile.TaskQueue ?? []) if (task.IsEnable === null) task.IsEnable = false;
  writeFileSync(file, JSON.stringify(config));
  actions.push({ kind: 'drift', before: before.toString('base64'), after: readFileSync(file).toString('base64') });
}

export function observeDaily(workspace, file) {
  const startedAt = new Date().toISOString();
  applyDrift(workspace);
  redirectMaaProcess(workspace);
  // Observe completed real filesystem operations. No filesystem operation is replaced by a fake.
  const { readFile, open, rename, appendFile, unlink } = promises;
  const config = join(workspace, 'config/gui.new.json');
  const lock = join(workspace, 'config/.maa-skills.lock');
  const pending = join(workspace, 'private/daily-pending.jsonl');
  const runs = join(workspace, 'private/daily-runs.jsonl');
  const bytes = async path => {
    try { return (await readFile(path)).toString('base64'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const same = (value, path) => typeof value === 'string' && resolve(value) === path;
  promises.open = async (...args) => {
    const handle = await open(...args);
    if (same(args[0], lock)) actions.push({ kind: 'acquire', flags: args[1] });
    return handle;
  };
  promises.rename = async (...args) => {
    if (!same(args[1], config)) return rename(...args);
    const before = await bytes(config); const held = await bytes(lock);
    let backup = null;
    try {
      const id = JSON.parse(Buffer.from(held, 'base64')).id;
      if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) backup = await bytes(join(workspace, 'private/maa-config-backups', id + '.json'));
    } catch {}
    const result = await rename(...args);
    actions.push({ kind: 'replace', before, after: await bytes(config), lock: held, backup });
    return result;
  };
  promises.appendFile = async (...args) => {
    const target = same(args[0], pending) ? 'private/daily-pending.jsonl' : same(args[0], runs) ? 'private/daily-runs.jsonl' : undefined;
    if (!target) return appendFile(...args);
    const before = await bytes(args[0]); const held = await bytes(lock);
    const result = await appendFile(...args);
    actions.push({ kind: 'append', file: target, before, after: await bytes(args[0]), lock: held });
    return result;
  };
  promises.unlink = async (...args) => {
    if (!same(args[0], lock)) return unlink(...args);
    const held = await bytes(lock); const result = await unlink(...args);
    actions.push({ kind: 'release', lock: held }); return result;
  };
  syncBuiltinESMExports();
  let input = ''; let output = '';
  const iterator = process.stdin[Symbol.asyncIterator].bind(process.stdin);
  process.stdin[Symbol.asyncIterator] = async function* () {
    for await (const chunk of { [Symbol.asyncIterator]: iterator }) { input += String(chunk); yield chunk; }
  };
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => { output += String(args[0]); return write(...args); };
  process.on('exit', exitCode => {
    appendFileSync(process.env.MAA_EVAL_DAILY_JOURNAL, JSON.stringify({ file, action: process.argv[2], pid: process.pid,
      exitCode, input, output, startedAt, endedAt: new Date().toISOString(), actions }) + '\n');
  });
}
