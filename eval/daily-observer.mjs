import { appendFileSync, realpathSync } from 'node:fs';
import promises from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const actions = [];
export function observeProcess(action, state) { actions.push({ kind: 'process', action, state }); }

export function observeDaily(workspace, file) {
  const startedAt = new Date().toISOString();
  const entry = realpathSync(process.argv[1]);
  const boundary = new URL('./maa-process.ts', pathToFileURL(entry)).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    return result.url === boundary ? { url: pathToFileURL(join(workspace, '.eval-maa-process.mjs')).href, shortCircuit: true } : result;
  } });
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
