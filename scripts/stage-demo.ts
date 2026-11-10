import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageSnapshot, stageTables, stageRequest, stageJob } from '../tests/fixtures/stage-data.ts';

/** Uses actual installed CLIs. Only the MAA process boundary is replaced; all state is synthetic. */
export async function runStageDemo(coreDirectory = resolve('skills/maa-core')) {
  const root = await mkdtemp(join(tmpdir(), 'maa-stage-demo-'));
  try {
    const home = join(root, 'home'), privateDirectory = join(root, 'private'), maaDirectory = join(root, 'maa');
    for (const directory of [home, privateDirectory, join(maaDirectory, 'config')]) await mkdir(directory, { recursive: true });
    const configuration = { Current: 'Synthetic', Configurations: { Synthetic: { TaskQueue: [], Copilot: { TaskList: [], EnableUserAdditional: true, LoopTimes: 91 } } }, Timers: { List: [] }, Unrelated: { preserve: 'synthetic-value' } };
    await writeFile(join(maaDirectory, 'config/gui.new.json'), JSON.stringify(configuration));
    await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(stageSnapshot()));
    await writeFile(join(root, 'tables.json'), JSON.stringify(stageTables)); await writeFile(join(root, 'jobs.json'), JSON.stringify([stageJob(1), stageJob(2), stageJob(3, 2)]));
    const boundary = pathToFileURL(join(coreDirectory, 'scripts/maa-process.ts')).href;
    const loader = join(root, 'process-loader.mjs'), trace = join(root, 'process-actions.jsonl');
    const fake = `import { appendFileSync } from 'node:fs'; let running = false; export function createMaaProcess() { return { inspect: async () => ({ running, treeExited: !running, idle: true, ready: running }), close: async () => { appendFileSync(${JSON.stringify(trace)}, 'close\\n'); running = false; }, start: async () => { appendFileSync(${JSON.stringify(trace)}, 'reopen\\n'); running = true; } }; }`;
    await writeFile(loader, `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); return result.url === ${JSON.stringify(boundary)} ? { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(fake))}, shortCircuit: true } : result; } });`);
    const env = { ...process.env, MAA_SKILLS_HOME: home, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), NODE_OPTIONS: `--import=${pathToFileURL(loader).href}` };
    const call = (script: string, action: string, input: unknown) => {
      const result = spawnSync(process.execPath, [join(coreDirectory, 'scripts', `${script}.ts`), action], { cwd: root, env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
    };
    call('preferences', 'set', { language: 'zh-CN', privateDirectory, maaDirectory });
    const { report } = call('stage-jobs', 'query', { request: stageRequest, tablesFile: 'tables.json', jobsFile: 'jobs.json', saveReport: true });
    assert.equal(report.authorization, 'none'); assert.deepEqual(report.stages[0].alternates, [2]);
    assert.deepEqual(JSON.parse(await readFile(join(maaDirectory, 'config/gui.new.json'), 'utf8')), configuration);
    const { configuration: before } = call('maa-config', 'read', {});
    const approval = { reportHash: report.hash, map: 'synthetic_map', reference: '合成用户批准普通 SYN-1 主作业 1 三次、备选 2，准备后手动开始', selections: [{ stageId: 'synthetic_01', primary: 1, alternates: [2], loops: 3 }] };
    const prepared = call('stage-jobs', 'prepare', { approval, profile: before.currentProfile, host: 'codex', expectedRevision: before.revision, closedConfirmed: true });
    assert.equal(prepared.status, 'complete'); assert.equal(call('maa-config', 'read', {}).configuration.profiles[0].jobCount, 3);
    const readback = JSON.parse(await readFile(join(maaDirectory, 'config/gui.new.json'), 'utf8'));
    assert.deepEqual(readback.Unrelated, configuration.Unrelated); assert.equal(readback.Configurations.Synthetic.Copilot.LoopTimes, 91);
    assert.equal(readback.Configurations.Synthetic.Copilot.EnableUserAdditional, false);
    assert.deepEqual(readback.Configurations.Synthetic.Copilot.TaskList.map((item: { CopilotId: number; Index: number; IsRaid: boolean }) => [item.CopilotId, item.Index, item.IsRaid]), [[1, 0, false], [1, 1, false], [1, 2, false]]);
    const pending = JSON.parse((await readFile(join(privateDirectory, 'daily-pending.jsonl'), 'utf8')).trim());
    assert.equal(pending.authorization.jobPlan.entries[0].loops, 3); assert.equal(pending.authorization.jobPlan.entries[0].alternates[0].id, 2);
    const actions = (await readFile(trace, 'utf8')).trim().split('\n'); assert.deepEqual(actions, ['reopen']);
    return { status: prepared.status, approvedLoops: 3, preparedPrimaryEntries: 3, approvedAlternates: 1, processActions: actions, actualGameRun: false };
  } finally { await rm(root, { recursive: true, force: true }); }
}
const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  try { console.log(JSON.stringify(await runStageDemo(process.argv[2] ? resolve(process.argv[2]) : undefined))); }
  catch { console.log(JSON.stringify({ status: 'failed' })); process.exitCode = 1; }
}
