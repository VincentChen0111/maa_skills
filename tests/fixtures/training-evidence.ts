import type { TrainingPlan } from '../../skills/maa-core/scripts/training-state.ts';
import { plan as fixturePlan, trainingConfig } from './training-runtime.ts';

export function plan(): TrainingPlan {
  const input = fixturePlan(), config = trainingConfig();
  config.Configurations.synthetic.TaskQueue[0]!.Filename = 'synthetic-training.json';
  input.configurationBinding = { profile: 'synthetic', queue: config.Configurations.synthetic.TaskQueue,
    timer: { Id: 0, IsEnabled: null, Config: 'synthetic', Hour: 1, Minute: 5 } };
  return input;
}
export function log(at: string, message: string, payload: unknown, processId = 17) {
  return `[${at}][INF][Px${processId}][Tx22] asst::Assistant::append_callback | ${message} ${JSON.stringify(payload)}\n`;
}
export function nativeTask(input: TrainingPlan, at = input.action!.dueAt, taskid = 4, override: { chain?: string; params?: unknown; processId?: number } = {}) {
  const chain = override.chain ?? (input.action!.kind === 'start' ? 'OperProgress' : 'Infrast');
  const ranks = [0, 0, 0]; ranks[input.target.skill - 1] = input.rank;
  const queue = input.configurationBinding?.queue ?? [];
  const params = override.params ?? (chain === 'OperProgress' ? { plans: [{ role: input.target.role, name: input.target.name, skill_mastery: ranks }] }
    : { facility: ['Training'], mode: 10000, filename: (queue[input.binding.infrastTask] as { Filename: string })?.Filename, plan_index: 0, continue_training: false });
  const processId = override.processId ?? 17;
  return `[${at}][INF][Px${processId}][Tx20] asst::Assistant::append_task ${chain} ${JSON.stringify(params)}\n`
    + `[${at}][INF][Px${processId}][Tx20] asst::Assistant::append_task | task_id: ${taskid}\n`
    + log(at, 'TaskChainStart', { taskchain: chain, taskid }, processId);
}
export function confirmation(at = '2026-11-11T01:05:01.000Z', taskid = 4) {
  return log(at, 'SubTaskCompleted', { taskchain: 'OperProgress', taskid, subtask: 'ProcessTask', details: { task: 'InfrastTrainingConfirm' } });
}
export function countdown(at = '2026-11-11T01:05:10.000Z', extra = {}, taskid = 5) {
  return log(at, 'SubTaskExtraInfo', { taskchain: 'Infrast', taskid, what: 'InfrastTrainingTimeLeft', details: { operator: '合成干员', skill: '合成技能', level: 1, time: '01:00:00', ...extra } });
}
