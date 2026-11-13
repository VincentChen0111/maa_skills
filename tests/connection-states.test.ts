import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { classifyAdbListing, connectionCheck, connectionStates, type ConnectionState } from '../skills/maa-core/scripts/setup-connection.ts';
import { checkMessages } from '../skills/maa-core/scripts/checks.ts';

// Address kinds as MAA users configure them, and every way `adb devices` can show (or not show) that address.
const addresses = {
  'auto-scanned local port': ['127.0.0.1:5555', 'localhost:5555', '127.0.0.1:5585'],
  'emulator serial': ['emulator-5554', 'emulator-5584'],
  'other network address': ['127.0.0.1:16384', '127.0.0.1:62001', '127.0.0.1:21503', 'localhost:16384', '192.168.0.20:5555'],
};
/** The same device written the other way: localhost/127.0.0.1, and a local adb port N+1 listed as emulator-N. */
function otherSpellings(address: string): string[] {
  const loopback = /^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(address);
  const serial = /^emulator-(\d+)$/.exec(address);
  if (serial) return [`127.0.0.1:${Number(serial[1]) + 1}`, `localhost:${Number(serial[1]) + 1}`];
  if (!loopback) return [];
  const port = Number(loopback[1]);
  return [address.startsWith('localhost') ? `127.0.0.1:${port}` : `localhost:${port}`, ...(port >= 5555 && port <= 5585 && port % 2 ? [`emulator-${port - 1}`] : [])];
}
const listing = (lines: string[]) => ['List of devices attached', ...lines, ''].join('\n');
// Absence never proves the emulator is off, and no amount of waiting makes adb list it (scan only at server start).
const forbidden = /may not be running|is not running|isn't running|probably (?:off|not)|not started|has not (?:been )?detected|a moment|wait|eventually|will appear|later/i;

test('every address kind and list situation maps to one state whose message and repair stay honest', () => {
  const reached = new Set<ConnectionState>();
  for (const [kind, values] of Object.entries(addresses)) for (const address of values) {
    const situations: [string, string, ConnectionState][] = [
      ['listed device', listing([`${address}\tdevice`]), 'device-online'],
      ['listed offline', listing([`${address}\toffline`]), 'device-offline'],
      ['listed unauthorized', listing([`${address}\tunauthorized`]), 'device-unauthorized'],
      ['absent, another device listed', listing(['emulator-5560\tdevice', '127.0.0.1:7555\tdevice']), 'device-not-connected'],
      ['empty list', listing([]), 'device-not-connected'],
      ...otherSpellings(address).map(other => [`listed as ${other}`, listing([`${other}\tdevice`]), 'device-online'] as [string, string, ConnectionState]),
      // The configured spelling is what MAA uses, so its own entry wins over a stale entry under another spelling, whatever the order.
      ...otherSpellings(address).map(other => [`stale ${other} listed first`, listing([`${other}\toffline`, `${address}\tdevice`]), 'device-online'] as [string, string, ConnectionState]),
      ...otherSpellings(address).map(other => [`own entry offline, ${other} online`, listing([`${address}\toffline`, `${other}\tdevice`]), 'device-offline'] as [string, string, ConnectionState]),
      ...otherSpellings(address).map(other => [`only ${other}, offline then online`, listing([`${other}\toffline`, `${other}\tdevice`]), 'device-online'] as [string, string, ConnectionState]),
    ];
    for (const [situation, stdout, expected] of situations) {
      const state = classifyAdbListing(address, stdout);
      assert.equal(state, expected, `${kind} ${address}: ${situation}`);
      reached.add(state);
    }
  }
  assert.deepEqual([...reached].sort(), ['device-not-connected', 'device-offline', 'device-online', 'device-unauthorized']);
  for (const [state, entry] of Object.entries(connectionStates) as [ConnectionState, typeof connectionStates[ConnectionState]][]) {
    const row = connectionCheck(state);
    assert.deepEqual([row.id, row.status, row.reason, row.message], ['connection', entry.status, state, entry.message]);
    assert.doesNotMatch(`${row.message} ${row.repair.description}`, forbidden, state);
    if (row.repair.executor === 'skill') assert.match(row.repair.channel ?? '', /^setup\.ts discover\|test/, state);
  }
  // Every state where the address is absent or unverified routes to setup's test/connect flow, or to the user starting an emulator that is off.
  for (const state of ['device-not-connected', 'adb-unavailable', 'adb-missing', 'adb-path-unrecognized', 'connection-not-configured'] as ConnectionState[]) {
    const row = connectionCheck(state);
    assert.match(row.repair.channel ?? '', /^setup\.ts discover\|test/, state);
  }
  assert.match(connectionCheck('device-not-connected').repair.description, /If the emulator is off, the user starts it/);
  assert.match(connectionCheck('device-not-connected').message, /does not show whether the emulator is running/);
});

test('the state table has one owner: no other module maps connection states to messages or repairs', async () => {
  const states = Object.keys(connectionStates);
  assert.equal(states.some(state => Object.hasOwn(checkMessages, state)), false, 'checks.ts holds no connection state messages');
  for (const file of ['doctor.ts', 'doctor-checks.ts', 'maa-log.ts', 'checks.ts', 'setup.ts']) {
    const source = await readFile(fileURLToPath(new URL(`../skills/maa-core/scripts/${file}`, import.meta.url)), 'utf8');
    for (const state of states) assert.equal(source.includes(`'${state}'`), false, `${file} must not map '${state}' itself`);
  }
});
