import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { executeConfigRecovery, inspectConfigRecovery, type MaaProcess, type RecoveryRequest } from './maa-config.ts';
import { readSettings } from './preferences.ts';

export type CheckContext = { maaDirectory: string; privateDirectory: string };
export type CheckResult = { id: string; status: 'normal' | 'warning' | 'error'; reason: string;
  repair: { id: string; executor: 'skill' | 'user'; description: string } };

export type RepairRequest = Omit<RecoveryRequest, 'action'> & { approved: string[] };
export async function executeRepairs(request: RepairRequest, maa: MaaProcess) {
  if (!Array.isArray(request.approved) || !request.approved.length || new Set(request.approved).size !== request.approved.length
    || request.approved.some(id => !['reconcile-lock', 'restore-config'].includes(id))) return { status: 'rejected', reason: 'named-approval-required' };
  if (request.approved.includes('reconcile-lock') && request.approved.includes('restore-config')) return { status: 'rejected', reason: 'conflicting-repairs' };
  return executeConfigRecovery({ ...request, action: request.approved[0] as RecoveryRequest['action'] }, maa);
}

/** Shared setup/doctor check interface. Only the most recent redacted record is written. */
export async function runChecks(context: CheckContext, maa: MaaProcess) {
  const checks: CheckResult[] = [];
  const recovery = await inspectConfigRecovery(context, maa);
  if (recovery.configuration === 'valid') {
    checks.push({ id: 'configuration', status: 'normal', reason: 'Configuration is readable.', repair: { id: 'inspect-configuration', executor: 'user', description: 'Inspect the configuration in MAA if the symptom persists.' } });
  } else { checks.push({ id: 'configuration', status: 'error', reason: 'Configuration cannot be parsed.', repair: { id: 'manual-configuration', executor: 'user', description: 'Inspect the configuration and retained backups manually.' } }); }
  const lock = recovery.lock;
  checks.push({ id: 'write-lock', status: lock === 'none' ? 'normal' : lock === 'active' ? 'warning' : 'error',
    reason: lock === 'none' ? 'No write lock is present.' : lock === 'active' ? 'The lock holder is still alive.' : 'The previous write result requires reconciliation.',
    repair: { id: recovery.canReconcile ? 'reconcile-lock' : recovery.canRestore ? 'restore-config' : 'manual-lock',
      executor: recovery.canReconcile || recovery.canRestore ? 'skill' : 'user',
      description: recovery.canReconcile ? 'Approve reconciliation of this evidence and release the retained lock.' : recovery.canRestore ? 'Approve restoring only the recorded changed fields through the configuration writer.' : 'Preserve the evidence; wait for the writer or inspect MAA manually.' } });
  const result = { checkedAt: new Date().toISOString(), exitCode: checks.some(item => item.status === 'error') ? 1 : 0, checks, recovery };
  await mkdir(context.privateDirectory, { recursive: true });
  const temporary = join(context.privateDirectory, `doctor-latest.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(context.privateDirectory, 'doctor-latest.json'));
  return result;
}

const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  const json = process.argv.includes('--json');
  const emit = (result: unknown) => {
    if (json) console.log(JSON.stringify(result));
    else {
      const value = result as { checks?: CheckResult[]; checkedAt?: string; recovery?: unknown; status?: string; reason?: string };
      if (value.checks) {
        console.log(`Checked: ${value.checkedAt}`);
        for (const item of value.checks) console.log(`${item.status} ${item.id}: ${item.reason}\n  ${item.repair.id} (${item.repair.executor}): ${item.repair.description}`);
        console.log(`Evidence: ${JSON.stringify(value.recovery)}`);
      } else console.log(`${value.status}: ${value.reason ?? 'complete'}`);
    }
  };
  try {
    const args = process.argv.slice(2);
    if (!['check', 'repair'].includes(args[0] ?? '') || args.length > 2 || args.length === 2 && args[1] !== '--json') {
      emit({ status: 'rejected', reason: 'usage: doctor.ts check|repair [--json]' }); process.exitCode = 1;
    } else {
      const settings = await readSettings();
      if (!settings.maaDirectory) { emit({ status: 'rejected', reason: 'maa-directory-unset' }); process.exitCode = 1; }
      else {
        let boundary: MaaProcess | undefined;
        const get = async () => boundary ??= (await import('./maa-process.ts')).createMaaProcess(settings.maaDirectory!);
        const maa: MaaProcess = { inspect: async () => (await get()).inspect(), close: async () => (await get()).close(), start: async () => (await get()).start() };
        const context = { maaDirectory: settings.maaDirectory, privateDirectory: settings.privateDirectory };
        if (args[0] === 'check') { const result = await runChecks(context, maa); emit(result); process.exitCode = result.exitCode; }
        else {
          let body: Record<string, unknown> | undefined;
          try {
            let text = '';
            for await (const chunk of process.stdin) { text += String(chunk); if (Buffer.byteLength(text) > 65536) throw new Error('input-too-large'); }
            const value: unknown = JSON.parse(text);
            if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['host', 'approved', 'reference', 'evidenceRevision', 'closedConfirmed', 'medicineCount', 'stoneCount', 'expiringMedicine'].includes(key))) throw new Error('request-invalid');
            body = value as Record<string, unknown>;
          } catch { /* Invalid input never authorizes a mutation. */ }
          const result = body ? await executeRepairs({ ...body, ...context } as RepairRequest, maa) : { status: 'rejected', reason: 'request-invalid' };
          emit(result); process.exitCode = result.status === 'complete' ? 0 : 1;
        }
      }
    }
  } catch { emit({ status: 'unexpected-failure', reason: 'check-could-not-complete' }); process.exitCode = 2; }
}
