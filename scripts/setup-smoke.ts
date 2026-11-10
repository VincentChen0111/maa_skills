import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

/** Checks an already installed core; changes only a fresh synthetic environment, never the installation. */
export async function runSetupSmoke(installedCore: string, host: 'codex' | 'claude' = 'codex') {
  if (process.platform !== 'win32') throw new Error('windows-smoke-required');
  if (host !== 'codex' && host !== 'claude') throw new Error('host-invalid');
  const core = await realpath(installedCore);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maa-setup-native-')));
  try {
    const workspace = join(root, 'workspace'); const home = join(root, 'home'); const privateDirectory = join(workspace, 'private');
    for (const path of [join(workspace, 'config'), privateDirectory, home, join(home, 'tmp')]) await mkdir(path, { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { HOME: home, USERPROFILE: home, MAA_SKILLS_HOME: privateDirectory, TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'),
      APPDATA: home, LOCALAPPDATA: home, MAA_SETUP_TEST_CORE: core, MAA_SETUP_TEST_WORKSPACE: workspace });
    await writeFile(join(workspace, '.eval-fixture.json'), JSON.stringify({ kind: 'maa-skills-evaluation' }));
    for (const name of ['MAA.exe', 'synthetic-adb.exe']) await writeFile(join(workspace, name), 'synthetic non-executable file');
    const configuration = { Current: 'Synthetic profile', Configurations: { 'Synthetic profile': { TaskQueue: [], Gui: {
      ConnectSettings: { AdbPath: '', Address: '', AddressHistory: [], AutoDetect: true, AlwaysAutoDetect: false },
      RuntimeSettings: { ClientType: 'Official', StartGame: false },
    } } }, Timers: { List: [] }, UnknownField: 'synthetic-preserved' };
    await writeFile(join(workspace, 'config/gui.new.json'), JSON.stringify(configuration));
    const loader = new URL('../tests/fixtures/setup-boundary.mjs', import.meta.url).href;
    const run = (script: string, action: string, input: unknown, exit = 0) => {
      const result = spawnSync(process.execPath, [...(script === 'setup.ts' ? ['--import', loader] : []), join(core, 'scripts', script), action, ...(script === 'setup.ts' ? ['--json'] : [])],
        { cwd: workspace, env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      assert.equal(result.status, exit, `${script} ${action} exit`);
      return JSON.parse(result.stdout);
    };
    assert.equal(run('setup.ts', 'check', {}, 1).needsDirectoryPrompt, true);
    run('preferences.ts', 'set', { language: 'en', privateDirectory, maaDirectory: workspace, server: 'CN' });
    assert.equal(run('preferences.ts', 'read', { currentLanguage: 'zh-CN' }).language, 'en');
    assert.equal(run('setup.ts', 'prepare', {}).needsLanguagePrompt, false);
    const context = { adbPaths: [join(workspace, 'synthetic-adb.exe')], addresses: ['127.0.0.1:5555'] };
    const found = run('setup.ts', 'discover', context); assert.equal(found.candidates.length, 1);
    const selection = { ...context, discoveryRevision: found.discoveryRevision, candidate: found.candidates[0].id };
    assert.equal(run('setup.ts', 'test', selection).status, 'connected');
    const request = { ...selection, host, reference: 'synthetic native installation request' };
    assert.equal(run('setup.ts', 'apply', request, 1).reason, 'closed-confirmation-required');
    assert.equal(run('setup.ts', 'apply', { ...request, closedConfirmed: true }).status, 'complete');
    const config = JSON.parse(await readFile(join(workspace, 'config/gui.new.json'), 'utf8'));
    const expected = structuredClone(configuration);
    expected.Configurations['Synthetic profile'].Gui.ConnectSettings = { AdbPath: context.adbPaths[0]!, Address: '127.0.0.1:5555', AddressHistory: [], AutoDetect: false, AlwaysAutoDetect: false };
    assert.deepEqual(config, expected);
    const again = run('setup.ts', 'discover', context);
    assert.equal(run('setup.ts', 'apply', { ...request, discoveryRevision: again.discoveryRevision }).status, 'unchanged');
    assert.equal((await readdir(join(privateDirectory, 'maa-config-backups'))).length, 1);
    const pending = JSON.parse((await readFile(join(privateDirectory, 'daily-pending.jsonl'), 'utf8')).trim());
    const completed = JSON.parse((await readFile(join(privateDirectory, 'daily-runs.jsonl'), 'utf8')).trim());
    assert.equal(pending.host, host); assert.equal(completed.host, host); assert.equal(pending.skill, 'maa-setup');
    const journal = (await readFile(join(workspace, '.setup-boundary.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(journal.filter(item => item.kind === 'maa-start').length, 1);
    assert.equal(journal.filter(item => item.kind === 'adb').every(item => ['devices', 'connect', '-s'].includes(item.args[0])), true);
    return { status: 'pass', firstPreferences: true, closedConfirmation: true, connectionWrite: true, repeatUnchanged: true, backups: 1, transactionHost: pending.host,
      boundaries: 'synthetic-adb-and-maa-process', realDevice: false };
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await runSetupSmoke(process.argv[2] ?? '', (process.argv[3] ?? 'codex') as 'codex' | 'claude'))); }
  catch { console.error('setup-smoke-failed'); process.exitCode = 1; }
}
