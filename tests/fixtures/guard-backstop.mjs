// Test-only layer for the guard's own test (tests/offline-network.test.ts). Imported BEFORE offline-network.mjs, so the
// guard wraps it: anything that reaches this layer got past the guard. It records the attempt and fails it, so nothing
// leaves this machine and no child process starts even when the guard is broken. It refuses every child process start
// (spawn, spawnSync, execFile, execFileSync, exec, execSync, fork), every TCP connection to a host that is not loopback,
// and every dns.lookup of such a host. Never installed with the product skills.
import childProcess from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const loopback = (host) => host === undefined || host === null || host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
const log = [];
globalThis.__maaGuardBackstop = log;
const reached = (entry) => { log.push(entry); return new Error('guard-backstop-reached'); };

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options;
  if (Array.isArray(args[0])) options = args[0][0];
  else if (args[0] && typeof args[0] === 'object') options = args[0];
  else if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) options = { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
  else options = { path: args[0] };
  if (options && !options.path && !loopback(options.host)) throw reached(`connect ${options.host}`);
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (loopback(host)) return lookup.call(this, host, ...rest);
  const error = reached(`dns.lookup ${host}`);
  const callback = rest.at(-1);
  if (typeof callback === 'function') return process.nextTick(callback, error);
  throw error;
};
const promised = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) { return loopback(host) ? promised.call(this, host, ...rest) : Promise.reject(reached(`dns.promises.lookup ${host}`)); };
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const stand = function (command) { throw reached(`child_process.${name} ${String(command).split(/[\\/]/).pop()}`); };
  // Keeps the promisified form exec and execFile have, so the guard's handling of it can be seen.
  if (typeof childProcess[name][promisify.custom] === 'function') Object.defineProperty(stand, promisify.custom, { value: stand });
  childProcess[name] = stand;
}
syncBuiltinESMExports();
