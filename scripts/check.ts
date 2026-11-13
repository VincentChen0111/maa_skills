import { mkdtemp, mkdir, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectPrivacy } from './privacy.ts';
import { inspectTracker } from './tracker.ts';
import { inspectMetadata } from './metadata.ts';

async function check(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24.');
  const root = resolve(process.argv[2] ?? '.');
  const temporaryHome = await mkdtemp(join(tmpdir(), 'maa-check-home-'));
  try {
    for (const name of ['.codex', '.claude', '.maa-skills', 'appdata', 'localappdata']) await mkdir(join(temporaryHome, name));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: temporaryHome, USERPROFILE: temporaryHome,
      CODEX_HOME: join(temporaryHome, '.codex'), CLAUDE_CONFIG_DIR: join(temporaryHome, '.claude'),
      MAA_SKILLS_HOME: join(temporaryHome, '.maa-skills'), APPDATA: join(temporaryHome, 'appdata'),
      LOCALAPPDATA: join(temporaryHome, 'localappdata'), GIT_CONFIG_GLOBAL: join(temporaryHome, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    delete env.NODE_TEST_CONTEXT;
    const tests = (await readdir(join(root, 'tests'))).filter((name) => name.endsWith('.test.ts')).sort().map((name) => join('tests', name));
    if (!tests.length) throw new Error('No script tests found.');
    const run = (args: string[]) => spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' }).status === 0;
    if (!run(['--test', ...tests])) { process.exitCode = 1; return; }
    const tracker = await inspectTracker(root);
    const privacy = await inspectPrivacy(root);
    const metadata = await inspectMetadata(root);
    console.log(JSON.stringify({ tracker: { ready: tracker.ready, errors: tracker.errors }, privacy, metadata }));
    let scorerExists = true;
    try { await access(join(root, 'scripts/eval-selftest.ts')); } catch { scorerExists = false; }
    if (scorerExists) {
      if (!run(['scripts/eval-selftest.ts'])) process.exitCode = 1;
    } else console.log('评分规则自检：尚未建立（工单 03），未验证。真模型和真实 MAA 不在离线入口运行。');
    // No-model environment preflight: every evaluation boundary plus a full runScenario pass per host with the host double.
    let preflightExists = true;
    try { await access(join(root, 'scripts/eval-preflight.ts')); } catch { preflightExists = false; }
    if (preflightExists && !run(['scripts/eval-preflight.ts'])) process.exitCode = 1;
    if (tracker.errors.length || privacy.length || metadata.length) process.exitCode = 1;
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

try { await check(); } catch {
  console.error('Offline checks could not complete. Verify Node 24 and repository inputs.');
  process.exitCode = 1;
}
