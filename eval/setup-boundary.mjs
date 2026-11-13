import { registerHooks } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Test and evaluation process boundaries: only adb and the MAA process are replaced; the filesystem and the
// installed setup/writer remain real. Tests name the installed core and workspace; the evaluation runner copies
// this file into the workspace root and preloads it, so the core comes from the entry script's own location.
const workspace = realpathSync.native(process.env.MAA_SETUP_TEST_WORKSPACE ?? fileURLToPath(new URL('.', import.meta.url)));
let core = process.env.MAA_SETUP_TEST_CORE ? realpathSync.native(process.env.MAA_SETUP_TEST_CORE) : undefined;
if (!core) {
  let entry; try { entry = realpathSync.native(process.argv[1]); } catch { /* no entry script */ }
  for (const layout of ['.agents', '.claude']) {
    const candidate = join(workspace, layout, 'skills', 'maa-core');
    if (entry && entry.toLowerCase().startsWith((candidate + sep).toLowerCase())) core = candidate;
  }
}
if (JSON.parse(readFileSync(join(workspace, '.eval-fixture.json'), 'utf8')).kind !== 'maa-skills-evaluation') throw new Error('setup-fixture-required');
if (core) {
const setupUrl = pathToFileURL(join(core, 'scripts/setup.ts')).href;
const connectionUrl = pathToFileURL(join(core, 'scripts/setup-connection.ts')).href;
// The MAA.exe version reader (setup's check) lives in maa-version.ts since ticket 10; it goes through the same boundary.
const versionUrl = pathToFileURL(join(core, 'scripts/maa-version.ts')).href;
const writerUrl = pathToFileURL(join(core, 'scripts/maa-config.ts')).href;
const processUrl = pathToFileURL(join(core, 'scripts/maa-process.ts')).href;
const canonicalUrl = url => {
  try { return pathToFileURL(realpathSync.native(fileURLToPath(url))).href; } catch { return undefined; }
};
const source = `
import { appendFileSync, existsSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const workspace = ${JSON.stringify(workspace)};
const journal = join(workspace, '.setup-boundary.jsonl');
const state = join(workspace, '.setup-maa-running');
const record = value => appendFileSync(journal, JSON.stringify(value) + '\\n');
const canonical = path => { try { return realpathSync.native(path); } catch { return undefined; } };
const same = (left, right) => { const value = canonical(left); return value !== undefined && value === canonical(right); };
export function execFile(executable, args, options, callback) {
  if (!same(executable, join(workspace, 'synthetic-adb.exe'))) {
    // setup reads only the fake MAA.exe version resource through this exact command form.
    if (/powershell\\.exe$/i.test(executable) && args[0] === '-NoProfile' && same(options.env?.MAA_SETUP_BINARY, join(workspace, 'MAA.exe'))) {
      queueMicrotask(() => callback(null, '', '')); return;
    }
    throw new Error('unexpected-setup-executable');
  }
  const command = JSON.stringify(args);
  const output = command === '["devices"]' ? 'List of devices attached\\n127.0.0.1:5555\\tdevice\\n'
    : command === '["connect","127.0.0.1:5555"]' ? 'connected'
    : command === '["-s","127.0.0.1:5555","get-state"]' ? 'device' : null;
  if (output === null) throw new Error('unexpected-adb-command');
  record({ kind: 'adb', args }); queueMicrotask(() => callback(null, output, ''));
}
export function createMaaProcess(directory) {
  if (canonical(directory) !== workspace) throw new Error('unexpected-maa-directory');
  return {
    inspect: async () => { const running = existsSync(state); return { running, treeExited: !running, idle: true, ready: running }; },
    close: async () => { record({ kind: 'maa-close' }); if (existsSync(state)) unlinkSync(state); },
    start: async () => { record({ kind: 'maa-start' }); writeFileSync(state, 'synthetic'); },
    // The writer's version stamp (ticket 25): the placeholder MAA.exe has no readable version.
    version: async () => null,
  };
}
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = canonicalUrl(context.parentURL);
    if ([setupUrl, connectionUrl, versionUrl].includes(parent) && specifier === 'node:child_process') return { url: 'maa-setup-test:boundary', shortCircuit: true };
    const result = nextResolve(specifier, context);
    if (parent === writerUrl && canonicalUrl(result.url) === processUrl) return { url: 'maa-setup-test:boundary', shortCircuit: true };
    return result;
  },
  load(url, context, nextLoad) {
    if (url === 'maa-setup-test:boundary') return { source, format: 'module', shortCircuit: true };
    return nextLoad(url, context);
  },
});
}
