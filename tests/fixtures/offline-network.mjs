// Test-only guard: in the process that loads it, each of these fails with offline-test-real-network, so a test that
// forgot a double cannot quietly reach a real service:
// - a TCP connection (net.Socket connect, which http, https, tls and fetch use) to a host that is not this machine's loopback;
// - dns.lookup and dns.promises.lookup of such a host;
// - starting Windows PowerShell or PowerShell 7 through child_process (spawn, spawnSync, execFile, execFileSync, exec,
//   execSync, fork). That is the Windows research transport's route: research-transport.ts lets .NET in powershell.exe
//   make the request, outside this process's sockets. A start is refused when the program's file name is powershell or
//   pwsh (any letter case, with or without .exe and a path), or when either name appears as a word in a command line
//   that a shell runs (exec, execSync, the shell option, or cmd/sh/bash as the program).
// It does not cover UDP (dgram), dns.resolve* (they query DNS servers directly), other programs a test starts (only
// PowerShell is refused), worker threads, or child Node processes unless they load this guard too.
// It leaves fetch itself alone, so test doubles, the evaluation's trusted network fixture (eval/network-fixture.mjs)
// and loopback servers keep working whatever order the preloads load in. Import it first in a test file; a spawned CLI
// loads it with `--import` on its command line or first in NODE_OPTIONS. Each refusal is also recorded in
// globalThis.__maaOfflineNetworkGuard.refused as { via, target } (an API name and a host or program name), so a test
// can show the guard was what stopped a reader whose transport turns errors into codes. Never installed with the
// product skills.
import childProcess from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const loopback = (host) => host === undefined || host === null || host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';

if (!globalThis.__maaOfflineNetworkGuard) {
  const refused = [];
  globalThis.__maaOfflineNetworkGuard = { refused };
  const refuse = (via, target) => { refused.push({ via, target: String(target) }); return new Error('offline-test-real-network'); };

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let options;
    if (Array.isArray(args[0])) options = args[0][0];
    else if (args[0] && typeof args[0] === 'object') options = args[0];
    else if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) options = { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
    else options = { path: args[0] };
    if (options && !options.path && !loopback(options.host)) throw refuse('connect', options.host);
    return connect.apply(this, args);
  };
  const lookup = dns.lookup;
  dns.lookup = function (host, ...rest) {
    if (loopback(host)) return lookup.call(this, host, ...rest);
    const error = refuse('dns.lookup', host);
    const callback = rest.at(-1);
    if (typeof callback === 'function') return process.nextTick(callback, error);
    throw error;
  };
  const promised = dns.promises.lookup;
  dns.promises.lookup = function (host, ...rest) { return loopback(host) ? promised.call(this, host, ...rest) : Promise.reject(refuse('dns.promises.lookup', host)); };

  const powershell = /^(powershell|pwsh)(\.exe)?$/i;
  const commandShell = /^(cmd|sh|bash|dash|zsh)(\.exe)?$/i;
  const fileName = (text) => String(text).split(/[\\/]/).pop();
  const words = (text) => String(text).split(/[\s"'`;&|()<>^]+/).filter(Boolean).map(fileName);
  /** The PowerShell program a start would run, if any: by the program's own name, or by a word of a line a shell runs. */
  const shellIn = (file, args, throughShell) => {
    const name = fileName(file ?? '');
    const candidates = throughShell || commandShell.test(name) ? [name, ...[file, ...args].flatMap(words)] : [name];
    return candidates.find((word) => powershell.test(word));
  };
  // (file, args?, options?) for spawn, spawnSync, execFile, execFileSync and fork; a callback is ignored.
  const argsAndOptions = (rest) => {
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    const options = Array.isArray(rest[0]) ? rest[1] : rest[0];
    return { args, options: options && typeof options === 'object' ? options : {} };
  };
  const program = (file, ...rest) => { const { args, options } = argsAndOptions(rest); return shellIn(file, args, Boolean(options.shell)); };
  const line = (command) => shellIn(command, [], true);
  const runtime = (_module, ...rest) => { const { options } = argsAndOptions(rest); return options.execPath === undefined ? undefined : shellIn(options.execPath, [], false); };
  const entries = { spawn: program, spawnSync: program, execFile: program, execFileSync: program, exec: line, execSync: line, fork: runtime };
  for (const [name, check] of Object.entries(entries)) {
    const original = childProcess[name];
    const refuseShell = (args) => { const found = check(...args); if (found !== undefined) throw refuse(`child_process.${name}`, found); };
    const guarded = function (...args) { refuseShell(args); return original.apply(this, args); };
    // exec and execFile keep their promisified form, which resolves to { stdout, stderr }.
    const custom = original[promisify.custom];
    if (typeof custom === 'function') Object.defineProperty(guarded, promisify.custom, { value: function (...args) { refuseShell(args); return custom.apply(this, args); } });
    childProcess[name] = guarded;
  }
  syncBuiltinESMExports();
}
