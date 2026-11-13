import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { approvedJobFile } from '../skills/maa-core/scripts/stage-job-plan.ts';
import { stageSnapshot } from '../tests/fixtures/stage-data.ts';
import { attempt, chainEnd, copilotStart, gui, runJobs, runRequest, runTables } from '../tests/fixtures/stage-run-data.ts';

/**
 * Uses the installed maa-core CLIs from the user's start signal to a run result. Only the MAA process boundary is
 * replaced (its state lives in a file so separate CLI processes agree); the "MAA run" is synthetic log lines written
 * by this script. Nothing clicks the game or operates a device.
 */
export async function runStageRunDemo(coreDirectory = resolve('skills/maa-core')) {
  const root = await mkdtemp(join(tmpdir(), 'maa-stage-run-demo-'));
  try {
    const home = join(root, 'home'), privateDirectory = join(root, 'private'), maaDirectory = join(root, 'maa');
    for (const directory of [home, privateDirectory, join(maaDirectory, 'config'), join(maaDirectory, 'debug')]) await mkdir(directory, { recursive: true });
    await writeFile(join(maaDirectory, 'config/gui.new.json'), JSON.stringify({ Current: 'Synthetic', Configurations: { Synthetic: { TaskQueue: [], Copilot: { TaskList: [], EnableUserAdditional: true } } }, Timers: { List: [] } }));
    await writeFile(join(maaDirectory, 'debug/asst.log'), ''); await writeFile(join(maaDirectory, 'debug/gui.log'), '');
    await writeFile(join(privateDirectory, 'account-snapshot.json'), JSON.stringify(stageSnapshot()));
    await writeFile(join(root, 'tables.json'), JSON.stringify(runTables)); await writeFile(join(root, 'jobs.json'), JSON.stringify(runJobs()));
    const boundary = pathToFileURL(join(coreDirectory, 'scripts/maa-process.ts')).href;
    const loader = join(root, 'process-loader.mjs'), trace = join(root, 'process-actions.jsonl'), running = join(root, 'maa-running');
    const fake = `import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
      const state = () => { const up = existsSync(${JSON.stringify(running)}); return { running: up, treeExited: !up, idle: true, ready: up }; };
      export function createMaaProcess() { return { inspect: async () => state(),
        close: async () => { appendFileSync(${JSON.stringify(trace)}, 'close\\n'); rmSync(${JSON.stringify(running)}, { force: true }); },
        start: async () => { appendFileSync(${JSON.stringify(trace)}, 'reopen\\n'); writeFileSync(${JSON.stringify(running)}, ''); } }; }`;
    await writeFile(loader, `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); return result.url === ${JSON.stringify(boundary)} ? { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(fake))}, shortCircuit: true } : result; } });`);
    const env = { ...process.env, MAA_SKILLS_HOME: home, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), NODE_OPTIONS: `--import=${pathToFileURL(loader).href}` };
    const call = (script: string, action: string, input: unknown) => {
      const result = spawnSync(process.execPath, [join(coreDirectory, 'scripts', `${script}.ts`), action], { cwd: root, env, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(result.stdout);
    };
    const actions = async () => (await readFile(trace, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    call('preferences', 'set', { language: 'zh-CN', privateDirectory, maaDirectory });
    const { report } = call('stage-jobs', 'query', { request: runRequest, tablesFile: 'tables.json', jobsFile: 'jobs.json', saveReport: true });
    const { configuration } = call('maa-config', 'read', {});
    const approval = { reportHash: report.hash, map: 'synthetic_map', reference: '合成用户批准 SYN-1 两次、SYN-2 一次，备选 2 只保存',
      selections: [{ stageId: 'synthetic_01', primary: 1, alternates: [2], loops: 2 }, { stageId: 'synthetic_02', primary: 4, alternates: [], loops: 1 }] };
    const prepared = call('stage-jobs', 'prepare', { approval, profile: configuration.currentProfile, host: 'claude', expectedRevision: configuration.revision, closedConfirmed: true });
    assert.equal(prepared.status, 'complete');
    const processActions = await actions();

    const startSignal = '合成用户：准备好了，我现在点开始';
    const { runId } = call('stage-run', 'start', { operation: prepared.operation, reference: startSignal });
    const files = [1, 1, 4].map(id => approvedJobFile(privateDirectory, report.hash, id));
    const write = async (file: string, lines: string[]) => appendFile(join(maaDirectory, 'debug', file), lines.map(line => line + '\n').join(''));
    await write('asst.log', [...copilotStart(0, { files }), ...attempt(10, 0, files[0]!, 'three-star')]);
    await write('gui.log', [gui(1, 'Start Task Chain: Copilot, Task ID: 1')]);
    const middle = call('stage-run', 'observe', { runId });
    await write('asst.log', [...attempt(60, 1, files[1]!, 'three-star'), ...attempt(120, 2, files[2]!, 'not-three-star'), ...chainEnd(160, 'TaskChainError')]);
    await write('gui.log', [gui(160, '任务出错: 自动战斗', 'ERR'), gui(160, '战斗出错', 'ERR'), gui(161, '完成任务: 自动战斗')]);
    const final = call('stage-run', 'observe', { runId });
    const stages = (summary: { stages: { code: string; result: string; stageCheck: string }[] }, check: boolean) => summary.stages.map(stage => check ? [stage.code, stage.result, stage.stageCheck] : [stage.code, stage.result]);
    return { startSignal,
      whileRunning: { execution: middle.execution, next: middle.next, stages: stages(middle, false) },
      final: { execution: final.execution, next: final.next, stages: stages(final, true), reported: [...new Set((final.newFindings as { kind: string }[]).map(item => item.kind))],
        medicine: final.medicine, allowedDecisions: final.allowedDecisions },
      processActions, trackingProcessActions: (await actions()).slice(processActions.length), actualGameRun: false };
  } finally { await rm(root, { recursive: true, force: true }); }
}
const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  try { console.log(JSON.stringify(await runStageRunDemo(process.argv[2] ? resolve(process.argv[2]) : undefined))); }
  catch { console.log(JSON.stringify({ status: 'failed' })); process.exitCode = 1; }
}
