import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trainingFixture } from '../tests/fixtures/training-data.ts';
import { trainingConfig } from '../tests/fixtures/training-runtime.ts';

// Development smoke for a native-installed core directory; never starts MAA or reads the user's home.
let root: string | undefined;
try {
  if (process.argv.length !== 3) throw new Error();
  const core = resolve(process.argv[2]!); root = await mkdtemp(join(tmpdir(), 'training-install-smoke-'));
  const maa = join(root, 'maa'), privateDirectory = join(root, 'private');
  await mkdir(join(maa, 'config'), { recursive: true }); await mkdir(privateDirectory);
  const data = trainingFixture();
  await writeFile(join(root, 'config.json'), JSON.stringify({ language: 'en', privateDirectory, maaDirectory: maa }));
  await writeFile(join(maa, 'config', 'gui.new.json'), JSON.stringify(trainingConfig()));
  await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(data.snapshot));
  await writeFile(join(root, 'tables.json'), JSON.stringify(data.tables));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { HOME: root, USERPROFILE: root, MAA_SKILLS_HOME: root, TEMP: root, TMP: root, TMPDIR: root });
  const invoke = (script: string, action: string, input: unknown) => {
    const call = spawnSync(process.execPath, [join(core, 'scripts', script), action], { cwd: root, env, input: JSON.stringify(input), encoding: 'utf8', timeout: 30000 });
    if (call.status !== 0) throw new Error();
    const value = JSON.parse(call.stdout); if (!value.ok) throw new Error(); return value.result;
  };
  const query = { ...data.request, tablesFile: join(root, 'tables.json') };
  const calculation = invoke('training-time.ts', 'query', query);
  const pending = invoke('training-plan.ts', 'prepare', { query, binding: { profile: 0, infrastTask: 0, progressTask: 1, timer: 0 }, currentTrainee: null,
    authorization: { source: 'current-request', reference: 'synthetic install smoke' } });
  const record = invoke('training-plan.ts', 'read', { id: pending.id });
  if (record.state !== 'pending' || calculation.stages[0].estimatedSeconds !== 2400) throw new Error();
  console.log(JSON.stringify({ ok: true, checks: ['query', 'prepare', 'read'], state: record.state, estimatedSeconds: calculation.stages[0].estimatedSeconds }));
} catch { console.error(JSON.stringify({ ok: false, error: 'training-smoke-failed' })); process.exitCode = 1; }
finally { if (root) await rm(root, { recursive: true, force: true }); }
