import { spawnSync } from 'node:child_process';
import type { Host } from './evaluation.ts';

/** Version output prefix of `eval/host-double.mjs`; a run whose host reports it is a double, never a host success. */
export const doubleVersionPrefix = 'maa-eval-host-double';
export type AuthMode = 'plan' | 'api-key' | 'host-double';

// Claude Code 2.1.321 loads these built-in plugins even under --safe-mode; the runner disables them by name and
// the init event of every run must show none. The built-in agent names are listed although the Agent tool is absent.
export const claudeBuiltinPlugins = ['cc-plugin-agents-md@builtin', 'cc-plugin-privacy@builtin', 'cc-plugin-plugin-authoring@builtin'];
export const claudeBuiltinAgents = ['claude', 'Explore', 'general-purpose', 'Plan'];
/** Set for every Claude child process: documented switches for memory files, auto memory, bundled skills and nonessential traffic. */
export const claudeIsolationEnvironment: Record<string, string> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};
/** Variables that would make a host use a credential other than the plan login in its dedicated directory. */
const credentialNames: Record<Host, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'],
};

/** Names (never values) of variables in a child environment that carry another credential or an evaluation key. */
export function credentialVariables(env: NodeJS.ProcessEnv, host: Host): string[] {
  const forbidden = new Set(credentialNames[host]);
  return Object.keys(env).filter((name) => env[name] && (forbidden.has(name.toUpperCase()) || /^MAA_EVAL_.*(KEY|TOKEN)$/i.test(name))).sort();
}

/** Claude permission rules use POSIX form: a drive-letter path is written `//<drive letter>/<rest with forward slashes>`. */
export function claudePermissionPath(path: string): string {
  const posix = path.replaceAll('\\', '/');
  const drive = posix.match(/^([A-Za-z]):\/(.*)$/);
  return drive ? `//${drive[1]!.toLowerCase()}/${drive[2]}` : `/${posix}`;
}

export function claudeSettings(loginDirectory?: string): string {
  return JSON.stringify({
    disableAllHooks: true, autoMemoryEnabled: false,
    enabledPlugins: Object.fromEntries(claudeBuiltinPlugins.map((name) => [name, false])),
    permissions: { blockReadsOutsideWorkingDirectories: true, deny: loginDirectory ? [`Read(${claudePermissionPath(loginDirectory)}/**)`] : [] },
    sandbox: { enabled: true },
  });
}

export type HostArgumentOptions = { model: string; workspace: string; commands?: string[]; toolless?: boolean; readOnly?: boolean; loginDirectory?: string };
/**
 * The Codex permission profile: the sandbox (MXC on Windows, the only one that enforces deny-read there), the profile's base and
 * the deny entry for the login directory. `exec` and the read-protection enforcement probe (`codex sandbox`) both take it from here.
 */
export function codexPermissionArguments(options: { readOnly?: boolean; loginDirectory?: string }): string[] {
  return [...(process.platform === 'win32' ? ['-c', 'windows.sandbox="mxc"'] : []),
    '-c', 'default_permissions="maa_eval"', '-c', `permissions.maa_eval.extends="${options.readOnly ? ':read-only' : ':workspace'}"`,
    ...(options.loginDirectory ? ['-c', `permissions.maa_eval.filesystem={'${options.loginDirectory}'='deny'}`] : [])];
}
/** `codex sandbox` running one command under exactly the profile `exec` gets for the same options; no model is involved. */
export function codexSandboxArguments(options: { readOnly?: boolean; loginDirectory?: string }, command: string[]): string[] {
  return ['sandbox', ...codexPermissionArguments(options), '--', ...command];
}
/** One argument set for every authentication mode, so plan-login and API-key records share the runner fingerprint. */
export function hostArguments(host: Host, options: HostArgumentOptions): string[] {
  if (host === 'codex') {
    return ['exec', '--json', '--model', options.model, '--cd', options.workspace, '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '-c', 'cli_auth_credentials_store="file"',
      // The built-in image tool reads files on disk itself, outside the command sandbox, and has no record item of its own.
      '-c', 'features.view_image=false', ...codexPermissionArguments(options), '-'];
  }
  const commands = options.toolless ? [] : options.commands ?? [];
  const tools = options.toolless ? [''] : [commands.length ? 'Read,Bash' : 'Read'];
  return ['-p', '--model', options.model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-prompts', 'none',
    '--safe-mode', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--tools', ...tools,
    ...(options.toolless ? [] : ['--allowedTools', 'Read', ...commands.map((command) => `Bash(${command})`), '--add-dir', options.workspace]),
    '--settings', claudeSettings(options.loginDirectory)];
}

export function expectedClaudeTools(options: { commands?: string[]; toolless?: boolean }): string[] {
  return options.toolless ? [] : options.commands?.length ? ['Bash', 'Read'] : ['Read'];
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
function events(raw: string): RecordValue[] {
  const result: RecordValue[] = [];
  for (const line of raw.split(/\r?\n/)) { if (!line.trim()) continue; try { result.push(object(JSON.parse(line))); } catch { /* not an event */ } }
  return result;
}

export type RunReason = 'completed' | 'not-run' | 'ci-disabled' | 'host-unavailable' | 'timeout' | 'auth-failed' | 'quota-exhausted' | 'network-unavailable'
  | 'host-nonzero-exit' | 'incomplete-transcript' | 'invalid-evidence' | 'isolation-unverified' | 'read-protection-required' | 'login-directory-refused'
  | 'api-key-in-environment' | 'host-double-required';
export type AuthDetail = 'not-logged-in' | 'login-expired' | 'api-key-rejected';
export type HostOutcome = { reason: RunReason; detail?: AuthDetail };
export type HostExecution = { raw: string; stderr: string; exitCode: number | null; error?: NodeJS.ErrnoException };

/** Failure texts the host itself reports; the model's own words are never read here. */
function failureTexts(host: Host, raw: string): { texts: string[]; failed: boolean; authFlag: boolean; quotaFlag: boolean } {
  const texts: string[] = [];
  let failed = false; let authFlag = false; let quotaFlag = false;
  for (const event of events(raw)) {
    if (host === 'claude') {
      if (event.type === 'result' && event.is_error === true) { failed = true; if (typeof event.result === 'string') texts.push(event.result); }
      if (event.type === 'assistant' && event.is_api_error_message === true) {
        for (const block of Array.isArray(object(event.message).content) ? object(event.message).content as unknown[] : []) {
          const text = object(block).text; if (typeof text === 'string') texts.push(text);
        }
        if (event.error === 'authentication_failed') authFlag = true;
        if (event.error === 'rate_limit' || event.error === 'billing_error') quotaFlag = true;
      }
      if (event.type === 'rate_limit_event' && object(event.rate_limit_info).status === 'rejected') quotaFlag = true;
    } else {
      if (event.type === 'turn.failed') { failed = true; const message = object(event.error).message; if (typeof message === 'string') texts.push(message); }
      if (event.type === 'error' && typeof event.message === 'string') texts.push(event.message);
    }
  }
  return { texts, failed, authFlag, quotaFlag };
}

export function classifyHostRun(host: Host, execution: HostExecution): HostOutcome {
  const code = execution.error?.code;
  if (code === 'ETIMEDOUT') return { reason: 'timeout' };
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return { reason: 'host-unavailable' };
  if (execution.error) return { reason: 'incomplete-transcript' };
  const { texts, failed, authFlag, quotaFlag } = failureTexts(host, execution.raw);
  // Codex reports every retry as an error event; only the final failure decides unless the turn failed.
  const decisive = host === 'codex' ? texts.slice(-1) : texts;
  const text = [...decisive, ...(execution.exitCode === 0 ? [] : [execution.stderr])].join('\n');
  if (failed || execution.exitCode !== 0) {
    if (quotaFlag || /hit your (?:usage )?limit|usage limit reached|usage_limit_reached|out of (?:usage )?credits|monthly spend limit|shared budget/i.test(text)) return { reason: 'quota-exhausted' };
    if (authFlag || /not logged in|login expired|invalid api key|incorrect api key|401|unauthori[sz]ed|refresh token|sign in again|log in again|authentication/i.test(text)) {
      return { reason: 'auth-failed', detail: /login expired|refresh token|expired|sign in again|log in again/i.test(text) ? 'login-expired'
        : /api key/i.test(text) ? 'api-key-rejected' : 'not-logged-in' };
    }
    if (/unable to connect|connectionrefused|econnrefused|econnreset|enotfound|eai_again|getaddrinfo|error sending request|stream disconnected|network/i.test(text)) return { reason: 'network-unavailable' };
    return { reason: execution.exitCode === 0 ? 'incomplete-transcript' : 'host-nonzero-exit' };
  }
  return { reason: 'completed' };
}

export type Usage = Record<string, number>;
/** The actual model ids and token usage come only from the host's own output; nothing is filled in from the request. */
export function reportedUsage(host: Host, raw: string): { reportedModel: string[] | 'unknown'; usage: Usage | 'unknown' } {
  const numbers = (value: unknown): Usage => Object.fromEntries(Object.entries(object(value)).filter(([, item]) => typeof item === 'number' && Number.isFinite(item))) as Usage;
  const all = events(raw);
  if (host === 'claude') {
    const result = all.filter((event) => event.type === 'result').at(-1);
    const models = Object.keys(object(result?.modelUsage));
    const usage = result && Object.hasOwn(result, 'usage') ? numbers(result.usage) : undefined;
    return { reportedModel: models.length ? models.sort() : 'unknown', usage: usage && Object.keys(usage).length ? usage : 'unknown' };
  }
  const models = new Set<string>();
  for (const event of all) for (const value of [event.model, object(event.item).model]) if (typeof value === 'string' && value) models.add(value);
  const turns = all.filter((event) => event.type === 'turn.completed' && Object.hasOwn(event, 'usage')).map((event) => numbers(event.usage));
  const usage: Usage = {};
  for (const turn of turns) for (const [key, value] of Object.entries(turn)) usage[key] = (usage[key] ?? 0) + value;
  return { reportedModel: models.size ? [...models].sort() : 'unknown', usage: turns.length ? usage : 'unknown' };
}

/** Items outside the documented load list make the run unverified; only item names are returned, never values. */
export function claudeIsolationProblems(raw: string, expected: { tools: string[]; plan: boolean }): string[] {
  const init = events(raw).find((event) => event.type === 'system' && event.subtype === 'init');
  if (!init) return ['init-missing'];
  const list = (value: unknown) => Array.isArray(value) ? value : ['<not-a-list>'];
  const problems: string[] = [];
  if (JSON.stringify([...list(init.tools)].map(String).sort()) !== JSON.stringify([...expected.tools].sort())) problems.push('tools');
  for (const key of ['mcp_servers', 'slash_commands', 'skills', 'plugins']) if (list(init[key]).length) problems.push(key);
  if (!list(init.agents).every((name) => claudeBuiltinAgents.includes(String(name)))) problems.push('agents');
  if (init.output_style !== undefined && init.output_style !== 'default') problems.push('output_style');
  if (expected.plan && init.apiKeySource !== undefined && init.apiKeySource !== 'none') problems.push('apiKeySource');
  return problems;
}


export function probeVersion(executable: string, executableArgs: string[], cwd: string, env: NodeJS.ProcessEnv): { available: boolean; version: string; double: boolean } {
  const result = spawnSync(executable, [...executableArgs, '--version'], { cwd, env, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const version = result.status === 0 ? (result.stdout ?? '').trim() : '';
  return { available: result.status === 0, version: version || 'unavailable', double: version.startsWith(doubleVersionPrefix) };
}
