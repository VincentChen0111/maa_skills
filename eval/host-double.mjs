// Offline host double for the evaluation runner. It is never a model and never a host success:
// it runs the fixed steps of its script file for real (so script calls, locks and file differences
// are genuine) and prints records in the Claude stream-json or Codex exec --json shape.
// Usage: node host-double.mjs <script.json> <host arguments...>
import { appendFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const doubleVersionPrefix = 'maa-eval-host-double';
const [scriptFile, ...args] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
const host = script.host;
if (host !== 'claude' && host !== 'codex') throw new Error('host-double-script');
const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const optionValue = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

// Redaction tests: `noise` lists paths the double names (with its workspace and the fixture around it) in every spelling a
// host, JSON or a URL may give, each right next to CJK text, punctuation, a digit or quotes, in its version, reply and stderr.
const slash = String.fromCharCode(92);
const spell = (path) => {
  const forward = path.replaceAll(slash, '/');
  const drive = path.match(/^([A-Za-z]):[\\/]/);
  const mixed = [...path].map((char, index) => index % 2 ? char.toLowerCase() : char.toUpperCase()).join('');
  return [path, path.replaceAll(slash, slash + slash), path.replaceAll(slash, slash.repeat(4)), forward,
    ...(drive ? [`/${drive[1].toLowerCase()}${forward.slice(2)}`, `//${drive[1].toLowerCase()}${forward.slice(2)}`, `${slash}${slash}?${slash}${path}`] : []),
    pathToFileURL(path).href, path.toUpperCase(), mixed, encodeURIComponent(path), path.replaceAll(slash, `${slash}u005c`)];
};
const around = (text) => [`${text}目录不可读。`, `${text}.`, `${text}-old`, `${text}7`, `"${text}"`, `'${text}'`, `（${text}）`, `${text}_x`];
const noise = (extra = []) => script.noise ? [...script.noise, process.cwd(), dirname(process.cwd()), ...extra].flatMap(spell).flatMap(around).join(' | ') : '';

if (args.includes('--version')) { print(`${doubleVersionPrefix} 1 (${host})${script.noise ? ` ${noise()}` : ''}`); process.exit(0); }
if (host === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  // Mirrors the fields of the real command, including the ones the runner must never save.
  const status = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', configDirectory: process.env.CLAUDE_CONFIG_DIR ?? null,
    email: 'synthetic-account@example.invalid', loginExpiresAt: null, ...(script.authStatus ?? {}) };
  print(JSON.stringify(status, null, 2)); process.exit(status.loggedIn ? 0 : 1);
}
if (host === 'codex' && args.includes('login') && args.includes('status')) {
  const text = script.authStatus ?? 'Not logged in';
  process.stderr.write(`${text}\n`); process.exit(/^Logged in|API key configured/.test(text) ? 0 : 1);
}

// `codex sandbox <-c values> -- <command>` runs the command, without a model, under the permission profile in the -c values: a read
// under a `permissions.<profile>.filesystem={'<path>'='deny'}` entry fails with EPERM (the -e script gets a patched readFileSync).
// The default 'enforce' judges the object a path names (both sides resolved by the file system: 8.3 short names expanded, junctions
// followed, case ignored on Windows), as an access check on the file itself does.
// On Windows a deny entry without `windows.sandbox="mxc"` is refused, as the real CLI does. `script.sandbox` picks other behaviours:
// 'by-name' (a sandbox that compares path strings exactly: a short name, a junction or another case gets through), 'ignore-deny'
// (every read succeeds), 'silent' (a denied path runs nothing and exits 0), 'deny-all' (every read fails), 'refuse'.
if (host === 'codex' && args[0] === 'sandbox') {
  if (script.environment) appendFileSync(script.environment, `${JSON.stringify({ names: Object.keys(process.env).sort(), configDirectory: process.env.CODEX_HOME, args })}\n`);
  const end = args.indexOf('--');
  const options = end < 0 ? [] : args.slice(1, end);
  const command = end < 0 ? [] : args.slice(end + 1);
  const values = options.filter((_, index) => options[index - 1] === '-c');
  const denied = values.flatMap((value) => [...value.matchAll(/'([^']*)'='deny'/g)].map((match) => match[1]));
  const mode = script.sandbox ?? 'enforce';
  if (!command.length || mode === 'refuse' || (process.platform === 'win32' && denied.length && !values.includes('windows.sandbox="mxc"'))) {
    process.stderr.write('cannot enforce deny-read restrictions directly; refusing to run unsandboxed\n'); process.exit(1);
  }
  const byObject = (path) => { let value; try { value = realpathSync.native(path); } catch { value = resolve(path); } return process.platform === 'win32' ? value.toLowerCase() : value; };
  const form = mode === 'by-name' ? (path) => resolve(path) : byObject;
  const target = form(command.at(-1));
  const underDenied = denied.some((path) => { const base = form(path); return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep); });
  if (mode === 'silent' && underDenied) process.exit(0);
  const blocked = mode === 'deny-all' || ((mode === 'enforce' || mode === 'by-name') && underDenied);
  const scriptIndex = command.indexOf('-e') + 1;
  if (blocked && !scriptIndex) { process.stderr.write('Permission denied\n'); process.exit(1); }
  const patch = "{const f=require('fs');f.readFileSync=()=>{throw Object.assign(new Error('EPERM: operation not permitted, open'),{code:'EPERM'})}};";
  const run = blocked ? command.map((part, index) => index === scriptIndex ? patch + part : part) : command;
  const result = spawnSync(run[0] === 'node' ? process.execPath : run[0], run.slice(1), { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}

let prompt = '';
try { prompt = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
// Tests inspect which variables reached the host: names only, plus the configuration directory it was pointed at, and what lies
// beside the workspace (the fixture root) when the host starts.
if (script.environment) appendFileSync(script.environment, `${JSON.stringify({ names: Object.keys(process.env).sort(),
  configDirectory: host === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME, args, fixtureEntries: readdirSync(dirname(process.cwd())).sort() })}\n`);
const startedAt = new Date().toISOString();
const journal = (kind) => { if (script.journal) appendFileSync(script.journal, `${JSON.stringify({ kind, host, pid: process.pid, startedAt, endedAt: new Date().toISOString() })}\n`); };
if (script.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, script.sleepMs);

const model = script.model === undefined ? optionValue('--model') ?? optionValue('-m') : script.model;
const sentinel = prompt.match(/哨兵文件：(.+)/)?.[1]?.trim();
const resolvePath = (value) => value === '{{sentinel}}' ? sentinel : value;
// `leak`: the reply carries the sentinel's value although no recorded call read it (a reader the record does not show).
const reply = [script.reply ?? 'Done.', ...(script.leak && sentinel ? [readFileSync(sentinel, 'utf8')] : []), ...(script.noise ? [noise(sentinel ? [sentinel] : [])] : [])].join(' ');
if (script.noise) process.stderr.write(`${noise(sentinel ? [sentinel] : [])}\n`);
const readCommand = (path) => ['node', '-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', path];
const quote = (value) => /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
const execute = (command, input) => {
  const [program, ...rest] = command;
  const result = spawnSync(program === 'node' ? process.execPath : program, rest, { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true,
    input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input) });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};
const calls = [];
// A step input may take a value from an earlier step's JSON output: "{{output:<step>:<dotted.path>}}".
const fill = (value) => {
  if (typeof value === 'string') {
    const match = value.match(/^\{\{output:(\d+):([\w.]+)\}\}$/);
    if (!match) return value;
    let found; try { found = JSON.parse(calls[Number(match[1])]?.stdout ?? 'null'); } catch { found = undefined; }
    for (const key of match[2].split('.')) found = found?.[key];
    return found;
  }
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
  return value;
};
// A request that offers no tools gets no tool calls; sentinel steps only apply when the prompt names a sentinel.
const toolless = host === 'claude' && optionValue('--tools') === '';
const usesSentinel = (step) => [step.fileRead, step.shellRead, step.otherTool, ...(step.shell ?? [])].includes('{{sentinel}}');
// Per-prompt failures let one batch fail on a chosen scenario: [{ "match": "<prompt text>", "failure": "quota" }].
script.failure ??= (script.failures ?? []).find((item) => prompt.includes(item.match))?.failure;
for (const step of toolless ? [] : script.steps ?? []) {
  if (usesSentinel(step) && !sentinel) continue;
  if (step.shell) {
    const command = step.shell.map(resolvePath);
    calls.push({ kind: 'shell', text: command.map(quote).join(' '), ...execute(command, fill(step.input)) });
  } else if (step.shellRead) {
    const path = resolvePath(step.shellRead);
    const command = readCommand(path);
    calls.push({ kind: 'shell', text: command.map(quote).join(' '), ...(step.deny ? { exitCode: 1, output: 'Permission denied' } : execute(command)) });
  } else if (step.fileRead && host === 'claude') {
    const path = resolvePath(step.fileRead);
    let output = 'Permission denied'; let exitCode = 1;
    if (!step.deny) { try { output = readFileSync(path, 'utf8'); exitCode = 0; } catch { output = 'File does not exist.'; } }
    calls.push({ kind: 'read', path, exitCode, output });
  } else if (step.otherTool) {
    // A tool other than the file tool or a command (Claude: an unlisted tool; Codex: an undocumented item type) touching a path.
    calls.push({ kind: 'other', path: resolvePath(step.otherTool), exitCode: 1, output: 'Denied' });
  }
}
const usage = script.usage === undefined ? { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } : script.usage;
const failureText = { 'not-logged-in': 'Not logged in · Please run /login', 'login-expired': 'Login expired · Please run /login',
  quota: "You've hit your limit · resets 5pm", network: 'Unable to connect to API (ConnectionRefused)', 'api-key-rejected': 'Invalid API key · Fix external API key' };
const codexFailure = { 'not-logged-in': 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
  'login-expired': 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
  quota: "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits.", network: 'stream disconnected before completion: error sending request',
  'api-key-rejected': 'unexpected status 401 Unauthorized: Incorrect API key provided' };

if (host === 'claude') {
  const toolsValue = optionValue('--tools');
  const tools = toolsValue === undefined ? ['Bash', 'Edit', 'Read'] : toolsValue === '' ? [] : toolsValue.split(',').sort();
  print({ type: 'system', subtype: 'init', cwd: process.cwd(), tools, mcp_servers: [], model: optionValue('--model'), permissionMode: 'default', slash_commands: [], apiKeySource: 'none',
    claude_code_version: 'host-double', output_style: 'default', agents: ['claude', 'Explore', 'general-purpose', 'Plan'], skills: [], plugins: [], ...(script.init ?? {}) });
  calls.forEach((call, index) => {
    const id = `double-${index}`;
    const use = call.kind === 'read' ? { name: 'Read', input: { file_path: call.path } } : call.kind === 'other' ? { name: 'Glob', input: { pattern: call.path } } : { name: 'Bash', input: { command: call.text } };
    print({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id, ...use }] } });
    print({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: call.output, is_error: call.exitCode !== 0 }] } });
  });
  if (script.failure && failureText[script.failure]) {
    const error = { 'not-logged-in': 'authentication_failed', 'login-expired': 'authentication_failed', 'api-key-rejected': 'authentication_failed', quota: 'rate_limit', network: 'unknown' }[script.failure];
    print({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: failureText[script.failure] }] }, error, is_api_error_message: true });
    print({ type: 'result', subtype: 'success', is_error: true, result: failureText[script.failure], usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} });
    journal('run'); process.exit(1);
  }
  print({ type: 'assistant', message: { model, content: [{ type: 'text', text: reply }] } });
  if (script.failure !== 'no-terminal') {
    print({ type: 'result', subtype: 'success', is_error: false, result: reply, ...(usage === null ? {} : { usage }),
      modelUsage: model ? { [model]: { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 } } : {} });
  }
} else {
  print({ type: 'thread.started', thread_id: 'host-double' });
  print({ type: 'turn.started' });
  calls.forEach((call, index) => print({ type: 'item.completed', item: call.kind === 'other' ? { id: `item_${index}`, type: 'file_read', path: call.path, status: 'failed' }
    : { id: `item_${index}`, type: 'command_execution', command: call.text, aggregated_output: call.output, exit_code: call.exitCode, status: call.exitCode === 0 ? 'completed' : 'failed' } }));
  if (script.failure && codexFailure[script.failure]) {
    print({ type: 'error', message: codexFailure[script.failure] });
    print({ type: 'turn.failed', error: { message: codexFailure[script.failure] } });
    journal('run'); process.exit(1);
  }
  print({ type: 'item.completed', item: { id: 'item_reply', type: 'agent_message', text: reply } });
  if (script.failure !== 'no-terminal') print({ type: 'turn.completed', ...(usage === null ? {} : { usage: script.usage ?? { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 0 } }) });
}
journal('run');
if (script.failure === 'exit-nonzero') { process.stderr.write('synthetic host failure\n'); process.exit(3); }
process.exit(0);
