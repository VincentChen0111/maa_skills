import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path';
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

/** One deny rule per form of the login directory the runner holds (`loginDirectoryForms`: the long form, then the given one). */
export function claudeSettings(loginDirectories: readonly string[] = []): string {
  return JSON.stringify({
    disableAllHooks: true, autoMemoryEnabled: false,
    enabledPlugins: Object.fromEntries(claudeBuiltinPlugins.map((name) => [name, false])),
    permissions: { blockReadsOutsideWorkingDirectories: true, deny: loginDirectories.map((directory) => `Read(${claudePermissionPath(directory)}/**)`) },
    sandbox: { enabled: true },
  });
}

/**
 * `loginDirectories`: every form of the login directory the runner holds (`loginDirectoryForms`), each denied. `shellPath` (Codex,
 * required there): the PATH of the child environment the run gives the host (`childPath`), which the sandboxed shell is pinned to.
 */
export type HostArgumentOptions = { model: string; workspace: string; commands?: string[]; toolless?: boolean; readOnly?: boolean; loginDirectories?: readonly string[];
  shellPath?: string };
/**
 * Variables the sandboxed shell never inherits (26 H, R6): the host's own process needs `CODEX_HOME` to find the plan login, which
 * the runner points at the login directory, but a command the model runs must not see it (a first real run listed it). The Claude
 * configuration variable is excluded too, so neither host's configuration directory reaches a Codex shell.
 */
export const sandboxExcludedVariables = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'];
/**
 * The PATH a process spawned with `env` receives, picked the way Node's spawner picks it: on Windows, where names ignore case, the
 * first name equal to `PATH` ignoring case in sorted order (a later spelling is dropped even when that first one has no value);
 * elsewhere `PATH` itself. Undefined when the spawner hands over no PATH; Windows then copies the runner's own PATH into the child,
 * which this does not follow: no PATH is refused (`sandboxPathRefusal`), never filled in. The one place the evaluation picks a
 * PATH out of a child environment.
 */
export function childPath(env: NodeJS.ProcessEnv): string | undefined {
  const name = process.platform === 'win32' ? Object.keys(env).sort().find((key) => key.toUpperCase() === 'PATH') : 'PATH';
  return name === undefined ? undefined : env[name];
}
/**
 * A TOML basic string holding `value` exactly: `\` and `"` escaped, everything else as it is (TOML is UTF-8). Undefined when the
 * value holds a control character (Unicode `Cc`, tab included) or a lone surrogate, which this form does not carry as given. Never
 * a literal string (`'…'`), which cannot hold `'`.
 */
export function tomlBasicString(value: string): string | undefined {
  return /[\p{Cc}\p{Cs}]/u.test(value) ? undefined : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
export type SandboxPathRefusal = 'sandbox-path-missing' | 'sandbox-path-unencodable';
/** Why the sandboxed shell cannot be pinned to `path` (none or empty; one `tomlBasicString` cannot write); undefined when it can. */
export function sandboxPathRefusal(path: string | undefined): SandboxPathRefusal | undefined {
  return !path ? 'sandbox-path-missing' : tomlBasicString(path) === undefined ? 'sandbox-path-unencodable' : undefined;
}
/**
 * The Codex permission profile: the sandbox (MXC on Windows, the only one that enforces deny-read there), the profile's base, one
 * deny entry per form of the login directory, the shell environment exclusion and the shell's PATH. `exec` and the read-protection
 * enforcement probe (`codex sandbox`) both take it from here, with the same `shellPath`, so the probe checks what the model runs under.
 * 26 H2: Codex puts its own helper directory, which lies under `CODEX_HOME` (the login directory), first on the PATH its commands
 * inherit, and the exclusion cannot take one entry out of a variable; so `shell_environment_policy.set` pins PATH to `shellPath`,
 * the PATH of the child environment the runner gives the host. Without a PATH that can be pinned there is no profile: this throws
 * the refusal code, and callers check `sandboxPathRefusal` first so that nothing starts.
 */
export function codexPermissionArguments(options: { readOnly?: boolean; loginDirectories?: readonly string[]; shellPath?: string }): string[] {
  const refusal = sandboxPathRefusal(options.shellPath);
  if (refusal) throw new Error(refusal);
  return [...(process.platform === 'win32' ? ['-c', 'windows.sandbox="mxc"'] : []),
    '-c', 'default_permissions="maa_eval"', '-c', `permissions.maa_eval.extends="${options.readOnly ? ':read-only' : ':workspace'}"`,
    ...(options.loginDirectories?.length ? ['-c', `permissions.maa_eval.filesystem={${options.loginDirectories.map((directory) => `'${directory}'='deny'`).join(',')}}`] : []),
    '-c', `shell_environment_policy.exclude=[${sandboxExcludedVariables.map((name) => `"${name}"`).join(',')}]`,
    '-c', `shell_environment_policy.set={PATH=${tomlBasicString(options.shellPath!)}}`];
}
/**
 * The arguments as a record keeps them: the pinned PATH value becomes `<shell-path>`. The PATH can name places the path redaction
 * does not know (npm adds `node_modules/.bin` of every directory above the repository, and a user's PATH has its own entries), so its
 * value is not written into the recorded arguments (output the model prints still goes through the one redaction); the arguments given
 * to the host are unchanged. It is the same child-environment PATH the run used.
 */
export const recordedShellPath = '<shell-path>';
export function recordedArguments(args: readonly string[]): string[] {
  return args.map((arg) => (arg.startsWith('shell_environment_policy.set=') ? `shell_environment_policy.set={PATH=${recordedShellPath}}` : arg));
}
/** `codex sandbox` running one command under exactly the profile `exec` gets for the same options; no model is involved. */
export function codexSandboxArguments(options: { readOnly?: boolean; loginDirectories?: readonly string[]; shellPath?: string }, command: string[]): string[] {
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
    '--settings', claudeSettings(options.loginDirectories)];
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
  | 'api-key-in-environment' | 'host-double-required' | 'sandbox-path-refused';
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


/**
 * The host binary the runner itself starts for a run (26 H, R5). The fixture puts the reviewer shims first on the PATH the model's
 * shell inherits; the runner never starts its host through them. A path (absolute or with a directory part) is used as given unless
 * it lies inside the fixture; a bare name is looked up on the entries of the PATH the spawner would hand over (`childPath`) that lie
 * outside the fixture, the way the process spawner looks it up (on Windows the name itself when it has an extension, then with .com
 * and .exe appended; elsewhere an executable file of that name). Undefined when nothing outside the fixture matches: the host is
 * then unavailable and nothing is started.
 */
export function hostExecutable(executable: string, env: NodeJS.ProcessEnv, fixtureRoot: string): string | undefined {
  const root = resolve(fixtureRoot);
  const inside = (path: string) => { const from = relative(root, resolve(path)); return !from || !from.startsWith('..') && !isAbsolute(from); };
  if (isAbsolute(executable) || /[\\/]/.test(executable)) return inside(executable) ? undefined : resolve(executable);
  const windows = process.platform === 'win32';
  const names = windows ? [...(extname(executable) ? [executable] : []), `${executable}.com`, `${executable}.exe`] : [executable];
  for (const entry of (childPath(env) ?? '').split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (!directory || !isAbsolute(directory) || inside(directory)) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch { /* not here */ }
    }
  }
  return undefined;
}

export function probeVersion(executable: string, executableArgs: string[], cwd: string, env: NodeJS.ProcessEnv): { available: boolean; version: string; double: boolean } {
  const result = spawnSync(executable, [...executableArgs, '--version'], { cwd, env, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const version = result.status === 0 ? (result.stdout ?? '').trim() : '';
  return { available: result.status === 0, version: version || 'unavailable', double: version.startsWith(doubleVersionPrefix) };
}
