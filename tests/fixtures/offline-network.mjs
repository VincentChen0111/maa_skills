// Test-only guard: in the process that loads it, any TCP connection or DNS lookup to a host that is not this machine's
// loopback fails with offline-test-real-network, so a test that forgot a double cannot quietly reach a real service.
// It works at the socket layer and leaves fetch alone, so test doubles, the evaluation's trusted network fixture
// (eval/network-fixture.mjs) and loopback servers keep working whatever order the preloads load in. Import it first in
// a test file; a spawned CLI loads it with `--import` on its command line or first in NODE_OPTIONS. Never installed with
// the product skills.
import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const loopback = (host) => host === undefined || host === null || host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
const refuse = () => new Error('offline-test-real-network');

if (!globalThis.__maaOfflineNetworkGuard) {
  globalThis.__maaOfflineNetworkGuard = true;
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let options;
    if (Array.isArray(args[0])) options = args[0][0];
    else if (args[0] && typeof args[0] === 'object') options = args[0];
    else if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) options = { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
    else options = { path: args[0] };
    if (options && !options.path && !loopback(options.host)) throw refuse();
    return connect.apply(this, args);
  };
  const lookup = dns.lookup;
  dns.lookup = function (host, ...rest) {
    if (loopback(host)) return lookup.call(this, host, ...rest);
    const callback = rest.at(-1);
    if (typeof callback === 'function') return process.nextTick(callback, refuse());
    throw refuse();
  };
  const promised = dns.promises.lookup;
  dns.promises.lookup = function (host, ...rest) { return loopback(host) ? promised.call(this, host, ...rest) : Promise.reject(refuse()); };
  syncBuiltinESMExports();
}
