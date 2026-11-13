import { mkdir, open, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { executeConfigRecovery, inspectConfigRecovery, inspectManagedFields, readConfiguration, type MaaProcess, type RecoveryRequest } from './maa-config.ts';
import { readSettings, settingsHome } from './preferences.ts';
import { inspectCredentials, userCredentialRepairs } from './credentials.ts';
import { groupOf, libraryCheck, type CheckResult as LibraryCheckResult, type LibraryCheck } from './checks.ts';
import { inspectInstallation } from './setup.ts';
import { inspectConnection, type AdbBoundary, type ConnectionState } from './setup-connection.ts';
import { readMaaVersion, type MaaVersionReader } from './maa-version.ts';
import { githubReleaseLookup, privateFilesCheck, remoteControlCheck, skillInstallationChecks, type ReleaseLookup } from './doctor-checks.ts';
import { classifyRun, evidenceOf, parseCallbacks, runsNewestFirst, safeToken, savedScreenshots, type Callback, type EvidenceItem } from './maa-log.ts';
export { githubReleaseLookup, type ReleaseLookup } from './doctor-checks.ts';

export type CheckResult = LibraryCheckResult;
/** `home` is the settings home; `skillsRoot` is the directory holding maa-core as the host invoked it. */
export type CheckContext = { maaDirectory: string; privateDirectory: string; home: string; skillsRoot?: string };
/** Substituted only at system boundaries: MAA.exe metadata, adb, and the release lookup network call. */
export type CheckBoundaries = { versionReader?: MaaVersionReader; adb?: AdbBoundary; releases?: ReleaseLookup };

export type RepairRequest = Omit<RecoveryRequest, 'action'> & { approved: string[] };
export async function executeRepairs(request: RepairRequest, maa: MaaProcess) {
  // Entering or re-entering a credential is done by the user in a local script; no approval lets the skill do it.
  if (Array.isArray(request.approved) && request.approved.some(id => (userCredentialRepairs as readonly unknown[]).includes(id))) return { status: 'rejected', reason: 'user-manual-repair' };
  if (!Array.isArray(request.approved) || !request.approved.length || new Set(request.approved).size !== request.approved.length
    || request.approved.some(id => !['reconcile-lock', 'restore-config'].includes(id))) return { status: 'rejected', reason: 'named-approval-required' };
  if (request.approved.includes('reconcile-lock') && request.approved.includes('restore-config')) return { status: 'rejected', reason: 'conflicting-repairs' };
  return executeConfigRecovery({ ...request, action: request.approved[0] as RecoveryRequest['action'] }, maa);
}

const connectionChecks: Record<ConnectionState, [CheckResult['status'], string]> = {
  'device-online': ['normal', 'inspect-connection-in-maa'], 'device-offline': ['error', 'restart-emulator-and-adb'],
  'device-unauthorized': ['error', 'authorize-adb'], 'device-not-listed': ['warning', 'start-emulator'],
  'adb-unavailable': ['warning', 'connect-through-setup'], 'adb-missing': ['error', 'connect-through-setup'],
  'connection-not-configured': ['warning', 'connect-through-setup'], 'connection-unreadable': ['warning', 'inspect-maa-configuration'],
};
const defaultSkillsRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function writeRecord(privateDirectory: string, name: string, value: unknown) {
  await mkdir(privateDirectory, { recursive: true });
  const temporary = join(privateDirectory, `${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(privateDirectory, `${name}.json`));
}

/** Shared setup/doctor check interface over the eight groups. Read-only apart from the most recent redacted record. */
export async function runChecks(context: CheckContext, maa: MaaProcess, boundaries: CheckBoundaries = {}) {
  const installation = await inspectInstallation({ home: context.home, maaDirectory: context.maaDirectory }, boundaries.versionReader ?? readMaaVersion);
  const checks: (CheckResult & { message?: string; details?: string[] })[] = [...installation.checks];
  const connection = await inspectConnection(context.maaDirectory, boundaries.adb);
  checks.push(libraryCheck('connection', connectionChecks[connection][0], connection, connectionChecks[connection][1]));
  const recovery = await inspectConfigRecovery(context, maa);
  if (recovery.configuration === 'valid') {
    checks.push({ id: 'configuration', status: 'normal', reason: 'Configuration is readable.', repair: { id: 'inspect-configuration', executor: 'user', description: 'Inspect the configuration in MAA if the symptom persists.' } });
  } else { checks.push({ id: 'configuration', status: 'error', reason: 'Configuration cannot be parsed.', repair: { id: 'manual-configuration', executor: 'user', description: 'Inspect the configuration and retained backups manually.' } }); }
  let config: unknown; let fields: LibraryCheck;
  try { config = await readConfiguration(context.maaDirectory); } catch { config = undefined; }
  try {
    if (config === undefined) throw new Error('configuration-unreadable');
    const managed = inspectManagedFields(config);
    fields = managed.invalid.length ? libraryCheck('configuration-fields', 'error', 'managed-fields-invalid', 'inspect-configuration-fields', managed.invalid)
      : managed.timerProfileMissing ? libraryCheck('configuration-fields', 'warning', 'timer-profile-missing', 'inspect-configuration-fields')
      : libraryCheck('configuration-fields', 'normal', 'managed-fields-valid', 'no-field-repair-needed');
  } catch { fields = libraryCheck('configuration-fields', 'warning', 'managed-fields-unknown', 'inspect-maa-configuration'); }
  checks.push(fields, remoteControlCheck(config));
  const lock = recovery.lock;
  checks.push({ id: 'write-lock', status: lock === 'none' ? 'normal' : lock === 'active' ? 'warning' : 'error',
    reason: lock === 'none' ? 'No write lock is present.' : lock === 'active' ? 'The lock holder is still alive.' : 'The previous write result requires reconciliation.',
    repair: { id: recovery.canReconcile ? 'reconcile-lock' : recovery.canRestore ? 'restore-config' : 'manual-lock',
      executor: recovery.canReconcile || recovery.canRestore ? 'skill' : 'user',
      description: recovery.canReconcile ? 'Approve reconciliation of this evidence and release the retained lock.' : recovery.canRestore ? 'Approve restoring only the recorded changed fields through the configuration writer.' : 'Preserve the evidence; wait for the writer or inspect MAA manually.',
      ...(recovery.canReconcile || recovery.canRestore ? { channel: 'doctor.ts repair' } : {}) } });
  checks.push(...(await inspectCredentials(installation.settings ? context.privateDirectory : null)).checks);
  checks.push(await privateFilesCheck(installation.settings ? context.privateDirectory : null));
  const skill = await skillInstallationChecks(context.skillsRoot ?? defaultSkillsRoot(), boundaries.releases);
  checks.push(...skill.checks);
  const grouped = checks.map(item => ({ ...item, group: groupOf(item.id) }));
  const result = { checkedAt: new Date().toISOString(), exitCode: checks.some(item => item.status === 'error') ? 1 : 0, checks: grouped, recovery,
    version: installation.version, skills: skill.skills };
  await writeRecord(context.privateDirectory, 'doctor-latest', result);
  return result;
}

export const conclusions = ['maa-defect', 'emulator-compatibility', 'game-update-not-adapted'] as const;
export type AnalyzeInput = { run?: number; interfaceUnobscured?: boolean; conclusion?: typeof conclusions[number]; processExitCode?: number };
export function parseAnalyzeInput(value: unknown): AnalyzeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request-invalid');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['run', 'interfaceUnobscured', 'conclusion', 'processExitCode'].includes(key))
    || input.run !== undefined && (!Number.isSafeInteger(input.run) || Number(input.run) < 1 || Number(input.run) > 20)
    || input.interfaceUnobscured !== undefined && typeof input.interfaceUnobscured !== 'boolean'
    || input.conclusion !== undefined && !(conclusions as readonly unknown[]).includes(input.conclusion)
    || input.processExitCode !== undefined && !Number.isSafeInteger(input.processExitCode)) throw new Error('request-invalid');
  return input as AnalyzeInput;
}

const maximumLogBytes = 8 * 1024 * 1024;
async function readLogTail(file: string): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(file, 'r');
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - maximumLogBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: start > 0 };
  } catch { return null; } finally { await handle?.close(); }
}

const officialEntries: Record<string, { url?: string; where?: string }> = {
  'maa-faq': { url: 'https://docs.maa.plus/zh-cn/manual/faq.html' },
  'maa-connection-guide': { url: 'https://docs.maa.plus/zh-cn/manual/connection.html' },
  'maa-issues': { url: 'https://github.com/MaaAssistantArknights/MaaAssistantArknights/issues' },
  'maa-issue-report-package': { where: 'MAA settings > issue report > generate the log package (the user uploads it to the issue)' },
};

/**
 * Analyses one run in MAA's own log (the latest unless `run` names an earlier one), checks the current
 * connection and MAA process, and decides only what the evidence supports. A referral summary is built
 * from whitelisted callback fields, after local causes are ruled out, and never carries a value from
 * the configuration, an address, a path outside the MAA debug folders, or any identifier.
 */
export async function runAnalysis(context: CheckContext, input: AnalyzeInput, maa: MaaProcess, boundaries: CheckBoundaries = {}) {
  const log = await readLogTail(join(context.maaDirectory, 'debug', 'asst.log'));
  const callbacks = log ? parseCallbacks(log.text) : [];
  const runs = runsNewestFirst(callbacks);
  const index = (input.run ?? 1) - 1;
  const run: Callback[] = runs[index] ?? [];
  const classified = classifyRun(run);
  const lines = log && run.length ? log.text.split(/\r?\n/).slice(run[0]!.line, run.at(-1)!.line + 1) : [];
  const screenshots: string[] = [];
  for (const path of savedScreenshots(lines)) {
    try { if ((await stat(join(context.maaDirectory, ...path.split('/')))).isFile()) screenshots.push(path); } catch { /* Not on disk: not cited. */ }
  }
  let running: 'running' | 'not-running' | 'unknown' = 'unknown';
  try { running = (await maa.inspect()).running ? 'running' : 'not-running'; } catch { /* Unknown process state stays unknown. */ }
  const currentState = { connection: await inspectConnection(context.maaDirectory, boundaries.adb), maa: running };
  const missingEvidence: string[] = [];
  if (!log) missingEvidence.push('debug/asst.log');
  else if (!runs[index]) missingEvidence.push('earlier-run-not-in-log');
  if (log?.truncated && index >= runs.length - 1) missingEvidence.push('earlier-log-not-read');
  if (run.some(item => item.detail === null)) missingEvidence.push('callback-details-unparsed');
  const relevant = run.filter(item => classified.failures.includes(item) || classified.subtaskErrors.includes(item)).slice(-20);
  const evidence: EvidenceItem[] = relevant.map(evidenceOf);
  const taskchains = [...new Set(run.filter(item => item.message === 'TaskChainStart').map(item => safeToken(item.detail?.taskchain)).filter((item): item is string => item !== null))];
  const { outcome, category, environment, cause } = classified;
  const localChecks = category === 'recognition' ? [{ id: 'resolution', state: 'ruled-out' }, { id: 'connection', state: 'ruled-out' },
    { id: 'interface-obscured', state: input.interfaceUnobscured ? 'ruled-out' : 'needs-user-confirmation' }] : [];
  const nextSteps = outcome === 'unknown' || outcome === 'stopped' ? ['verify-current-state'] : outcome === 'completed' ? []
    : environment ? ['verify-current-state', 'retry-within-approval', 'next-approved-alternative', 'stop-and-tell-user'] : ['verify-current-state', 'stop-and-tell-user'];
  // Unknown results are only verified; a stopped run is restarted only on the user's request.
  const replay = outcome === 'unknown' ? 'forbidden' : outcome === 'failed' ? 'within-existing-approval' : outcome === 'stopped' ? 'ask-user' : 'not-needed';

  let referral: Record<string, unknown> = { state: 'not-applicable' };
  const ready = async (judgement: string, confidence: 'high' | 'medium' | 'low', chain: string[]) => {
    let maaVersion: string | null = null;
    try { if ((await stat(join(context.maaDirectory, 'MAA.exe'))).isFile()) maaVersion = await (boundaries.versionReader ?? readMaaVersion)(context.maaDirectory); } catch { /* Unknown version. */ }
    const missing = [...missingEvidence, 'maa-issue-report-package', 'gui-log-timeline', 'user-reproduction-steps',
      ...(category === 'recognition' && !screenshots.length ? ['interface-screenshot'] : [])];
    const connectionRelated = category === 'connection' || judgement === 'emulator-compatibility';
    return { state: 'ready', summary: {
      overview: { outcome, category, taskchains, maaVersion: safeToken(maaVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) },
      keyEvidence: { log: 'debug/asst.log', from: run[0]?.at ?? null, to: run.at(-1)?.at ?? null, callbacks: evidence, screenshots },
      rootCause: { judgement, chain }, confidence, missingEvidence: missing },
    entries: ['maa-faq', ...(connectionRelated ? ['maa-connection-guide'] : []), 'maa-issues', 'maa-issue-report-package'].map(id => ({ id, ...officialEntries[id] })) };
  };
  const describe = (item: EvidenceItem) => [item.message, item.what, item.subtask, item.task && `task=${item.task}`, item.error, item.taskchain && `(${item.taskchain})`].filter(Boolean).join(' ');
  if (outcome === 'failed' && category) {
    const chain = evidence.map(describe);
    if (category === 'maa-defect') referral = await ready('maa-defect', 'high', [...chain, 'MAA reported an unhandled exception inside a task chain']);
    else if (category === 'recognition') {
      const remaining = localChecks.filter(item => item.state !== 'ruled-out').map(item => item.id);
      referral = remaining.length ? { state: 'pending', remaining }
        : await ready(input.conclusion ?? 'maa-recognition-failure', screenshots.length ? 'medium' : 'low', [...chain, 'no resolution or connection failure callback in this run',
          'the user confirmed the game screen was not covered', ...screenshots.map(path => `screenshot saved: ${path}`)]);
    } else if (input.conclusion) referral = await ready(input.conclusion, 'low', [...chain, `investigated and concluded outside this project's scope: ${input.conclusion}`]);
    else if (category === 'task-chain') referral = { state: 'pending', remaining: ['cause-unknown'] };
  }
  const result = { analyzedAt: new Date().toISOString(), outcome, run: index + 1,
    window: run.length ? { from: run[0]!.at, to: run.at(-1)!.at } : null, taskchains, evidence,
    classification: category ? { category, environment, cause } : null, currentState, localChecks, nextSteps, decidedBy: 'model', replay,
    screenshots, missingEvidence, ...(input.processExitCode !== undefined ? { processExit: 'not-evidence' } : {}), referral };
  await writeRecord(context.privateDirectory, 'doctor-analysis-latest', result);
  return result;
}

const entry = process.argv[1] && process.argv[1] !== '-' ? await realpath(resolve(process.argv[1])).catch(() => undefined) : undefined;
if (entry && await realpath(fileURLToPath(import.meta.url)) === entry) {
  const json = process.argv.includes('--json');
  const emit = (result: unknown) => {
    if (json) { console.log(JSON.stringify(result)); return; }
    const value = result as Record<string, any>;
    if (value.checks) {
      console.log(`Checked: ${value.checkedAt}`);
      for (const item of value.checks as (CheckResult & { message?: string; details?: string[]; group: string })[]) {
        console.log(`[${item.group}] ${item.status} ${item.id}: ${item.message ?? item.reason}${item.details ? ` (${item.details.join(', ')})` : ''}`);
        console.log(`  ${item.repair.id} (${item.repair.executor}${item.repair.channel ? ` via ${item.repair.channel}` : ''}): ${item.repair.description}`);
      }
      console.log(`Evidence: ${JSON.stringify({ recovery: value.recovery, version: value.version, skills: value.skills })}`);
    } else if (value.analyzedAt) {
      console.log(`Analyzed: ${value.analyzedAt} run ${value.run}: ${value.outcome}${value.classification ? ` (${value.classification.category}: ${value.classification.cause})` : ''}`);
      console.log(`Current state: ${JSON.stringify(value.currentState)}; next steps (decided by the model): ${value.nextSteps.join(', ') || 'none'}; replay: ${value.replay}`);
      console.log(`Evidence: ${JSON.stringify(value.evidence)}`);
      console.log(`Referral: ${JSON.stringify(value.referral)}`);
    } else console.log(`${value.status}: ${value.reason ?? 'complete'}`);
  };
  try {
    const args = process.argv.slice(2); const action = args[0] ?? ''; const flags = args.slice(1);
    if (!['check', 'analyze', 'repair'].includes(action) || new Set(flags).size !== flags.length || flags.some(flag => !(action === 'check' ? ['--json', '--online'] : ['--json']).includes(flag))) {
      emit({ status: 'rejected', reason: 'usage: doctor.ts check [--json] [--online] | analyze [--json] | repair [--json]' }); process.exitCode = 1;
    } else {
      const home = settingsHome();
      const settings = await readSettings(home);
      if (!settings.maaDirectory) { emit({ status: 'rejected', reason: 'maa-directory-unset' }); process.exitCode = 1; }
      else {
        let boundary: MaaProcess | undefined;
        const get = async () => boundary ??= (await import('./maa-process.ts')).createMaaProcess(settings.maaDirectory!);
        const maa: MaaProcess = { inspect: async () => (await get()).inspect(), close: async () => (await get()).close(), start: async () => (await get()).start() };
        // The skills root as the host invoked it, so directory links are inspected rather than followed.
        const context = { maaDirectory: settings.maaDirectory, privateDirectory: settings.privateDirectory, home, skillsRoot: resolve(dirname(resolve(process.argv[1]!)), '..', '..') };
        const readInput = async (empty: unknown) => {
          let text = '';
          for await (const chunk of process.stdin) { text += String(chunk); if (Buffer.byteLength(text) > 65536) throw new Error('input-too-large'); }
          return text === '' && empty !== undefined ? empty : JSON.parse(text) as unknown;
        };
        if (action === 'check') {
          const result = await runChecks(context, maa, flags.includes('--online') ? { releases: githubReleaseLookup() } : {});
          emit(result); process.exitCode = result.exitCode;
        } else if (action === 'analyze') {
          let input: AnalyzeInput | undefined;
          try { input = parseAnalyzeInput(await readInput({})); } catch { /* Invalid input is rejected below. */ }
          if (!input) { emit({ status: 'rejected', reason: 'request-invalid' }); process.exitCode = 1; }
          else { const result = await runAnalysis(context, input, maa); emit(result); process.exitCode = result.outcome === 'completed' ? 0 : 1; }
        } else {
          let body: Record<string, unknown> | undefined;
          try {
            const value = await readInput(undefined);
            if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['host', 'approved', 'reference', 'evidenceRevision', 'closedConfirmed', 'medicineCount'].includes(key))) throw new Error('request-invalid');
            body = value as Record<string, unknown>;
          } catch { /* Invalid input never authorizes a mutation. */ }
          const result = body ? await executeRepairs({ ...body, maaDirectory: context.maaDirectory, privateDirectory: context.privateDirectory } as RepairRequest, maa) : { status: 'rejected', reason: 'request-invalid' };
          emit(result); process.exitCode = result.status === 'complete' ? 0 : 1;
        }
      }
    }
  } catch { emit({ status: 'unexpected-failure', reason: 'check-could-not-complete' }); process.exitCode = 2; }
}
