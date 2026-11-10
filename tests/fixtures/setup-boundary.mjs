import { registerHooks } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Test-only process boundaries. Filesystem and the installed setup/writer remain real.
const core = realpathSync(process.env.MAA_SETUP_TEST_CORE);
const workspace = realpathSync(process.env.MAA_SETUP_TEST_WORKSPACE);
if (JSON.parse(readFileSync(join(workspace, '.eval-fixture.json'), 'utf8')).kind !== 'maa-skills-evaluation') throw new Error('setup-fixture-required');
const setupUrl = pathToFileURL(join(core, 'scripts/setup.ts')).href;
const processUrl = pathToFileURL(join(core, 'scripts/maa-process.ts')).href;
const source = `
import { appendFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
const workspace = ${JSON.stringify(workspace)};
const journal = join(workspace, '.setup-boundary.jsonl');
const state = join(workspace, '.setup-maa-running');
const record = value => appendFileSync(journal, JSON.stringify(value) + '\\n');
export function execFile(executable, args, options, callback) {
  if (resolve(executable) !== resolve(join(workspace, 'synthetic-adb.exe'))) {
    // setup reads only the fake MAA.exe version resource through this exact command form.
    if (/powershell\\.exe$/i.test(executable) && args[0] === '-NoProfile' && options.env?.MAA_SETUP_BINARY === join(workspace, 'MAA.exe')) {
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
  if (resolve(directory) !== resolve(workspace)) throw new Error('unexpected-maa-directory');
  return {
    inspect: async () => { const running = existsSync(state); return { running, treeExited: !running, idle: true, ready: running }; },
    close: async () => { record({ kind: 'maa-close' }); if (existsSync(state)) unlinkSync(state); },
    start: async () => { record({ kind: 'maa-start' }); writeFileSync(state, 'synthetic'); },
  };
}
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === setupUrl && specifier === 'node:child_process') return { url: 'maa-setup-test:boundary', shortCircuit: true };
    const result = nextResolve(specifier, context);
    if (context.parentURL === setupUrl && result.url === processUrl) return { url: 'maa-setup-test:boundary', shortCircuit: true };
    return result;
  },
  load(url, context, nextLoad) {
    if (url === 'maa-setup-test:boundary') return { source, format: 'module', shortCircuit: true };
    return nextLoad(url, context);
  },
});
