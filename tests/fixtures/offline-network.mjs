// Test-only guard: in the process that loads it, each of these fails with offline-test-real-network, so a test that
// forgot a double cannot quietly reach a real service:
// - a TCP connection (net.Socket connect, which http, https, tls and fetch use) to a host that is not this machine's loopback;
// - dns.lookup and dns.promises.lookup of such a host;
// - starting Windows PowerShell or PowerShell 7 through the child_process functions spawn, spawnSync, execFile,
//   execFileSync, exec, execSync and fork, and the promisified exec and execFile. That is the Windows research
//   transport's route: research-transport.ts lets .NET in powershell.exe make the request, outside this process's
//   sockets. The guard reads the arguments as Node does (null or undefined arguments are skipped and the options come
//   next) and refuses the start, before any process exists, when the file name of any of these is powershell or pwsh
//   (any letter case, with or without .exe, bare or with a path):
//   - the program (for fork, options.execPath);
//   - the shell that runs the command line, as Node picks it: options.shell when it is a string; for `shell: true`, and
//     for exec and execSync without a string shell, ComSpec (else cmd.exe) on Windows and /bin/sh elsewhere;
//   - a word of a command line that a shell runs (exec, execSync, any shell option, or cmd, sh, bash, dash or zsh as the
//     program), with words split at white space, quotes, backquotes and ; & | ( ) < > ^.
// It does not cover UDP (dgram), dns.resolve* (they query DNS servers directly), any other program (only those two
// names are refused, so a copy or link of PowerShell under another name, or a script or program that starts it, gets
// through), a PowerShell name a shell builds at run time (variables, command substitution, an escape or quotes inside
// the name), other ways to start a process (the ChildProcess class used directly, process.execve, a function reference
// taken before this guard loaded), worker threads, or child Node processes unless they load this guard too.
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
  const objectOr = (value) => (value && typeof value === 'object' ? value : {});
  // The shell Node runs a command line through for a shell option (child_process normalizeSpawnArguments): a non-empty
  // string is that shell; true is ComSpec (else cmd.exe) on Windows and /bin/sh elsewhere; anything else runs no shell.
  const shellFor = (shell) => {
    if (typeof shell === 'string' && shell !== '') return shell;
    if (shell === true) return process.platform === 'win32' ? process.env.comspec || 'cmd.exe' : '/bin/sh';
    return undefined;
  };
  /**
   * The PowerShell name a start would run, if any: the shell that runs the line, the program itself, or a word of a line
   * that a shell runs (any shell, or cmd and the like as the program).
   */
  const powershellIn = (file, args, shell, lineThroughShell = shell !== undefined) => {
    const name = fileName(file ?? '');
    const lineWords = lineThroughShell || commandShell.test(name) ? [file, ...args].flatMap(words) : [];
    return [shell === undefined ? '' : fileName(shell), name, ...lineWords].find((word) => powershell.test(word));
  };
  // (file, args?, options?) as Node reads it for spawn, spawnSync, execFile, execFileSync and fork: an array is the
  // arguments and the options follow it; null or undefined arguments are skipped and the options follow them; any other
  // object in that place is the options. A callback is ignored.
  const argsAndOptions = (rest) => {
    if (Array.isArray(rest[0])) return { args: rest[0], options: objectOr(rest[1]) };
    if (rest[0] === null || rest[0] === undefined) return { args: [], options: objectOr(rest[1]) };
    return { args: [], options: objectOr(rest[0]) };
  };
  const program = (file, ...rest) => { const { args, options } = argsAndOptions(rest); return powershellIn(file, args, shellFor(options.shell)); };
  // exec and execSync run the line through options.shell when it is a string, otherwise through the default shell.
  const line = (command, options) => {
    const { shell } = objectOr(options);
    return powershellIn(command, [], shellFor(typeof shell === 'string' ? shell : true), true);
  };
  // fork never uses a shell (Node sets shell to false); its program is options.execPath.
  const runtime = (_module, ...rest) => { const { options } = argsAndOptions(rest); return options.execPath === undefined ? undefined : powershellIn(options.execPath, [], undefined); };
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
