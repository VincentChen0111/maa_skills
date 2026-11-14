import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeProcess } from './.eval-daily-observer.mjs';

// Only the isolated evaluator loads this replacement of the documented MAA boundary.
export function createMaaProcess(directory) {
  const workspace = fileURLToPath(new URL('.', import.meta.url));
  if (resolve(directory) !== resolve(workspace)) throw new Error('synthetic-maa-directory');
  const mode = process.env.MAA_EVAL_MAA_PROCESS;
  if (!['closed', 'ready', 'close-failure', 'restart-failure', 'drift-noise', 'drift-projection'].includes(mode)) throw new Error('synthetic-maa-mode');
  let running = mode !== 'closed';
  return {
    inspect: async () => {
      const state = { running, treeExited: !running, idle: running, ready: running };
      observeProcess('inspect', state); return state;
    },
    close: async () => {
      observeProcess('close', mode === 'close-failure' ? 'failed' : 'closed');
      if (mode === 'close-failure') throw new Error('synthetic-close-failure');
      running = false;
    },
    start: async () => {
      observeProcess('start', mode === 'restart-failure' ? 'failed' : 'ready');
      if (mode === 'restart-failure') throw new Error('synthetic-restart-failure');
      running = true;
    },
  };
}
