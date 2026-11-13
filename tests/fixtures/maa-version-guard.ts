import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onVersionRead } from './maa-version-double.ts';
import { readMaaVersion } from '../../skills/maa-core/scripts/maa-version.ts';

/**
 * Ticket 25: the installed MAA.exe version is a system boundary. A `MaaProcess` without `version()` falls back to the
 * real reader (`readMaaVersion`, which starts PowerShell), and so do setup and doctor without a `versionReader`.
 * A test file imports this module first: the real reader is then answered without starting PowerShell (version unknown)
 * and the file fails at the end, naming each MAA.exe it was asked to read, so a test double that forgets `version` or
 * `versionReader` cannot pass. A test that exists to exercise the real reader does not import it.
 * CLI children are not covered by this process: preload `versionDoublePreload` into them with `--import`.
 */
export const versionDoublePreload = new URL('./maa-version-double.ts', import.meta.url).href;
const reads: string[] = [];
onVersionRead(binary => reads.push(binary));
// The double must still match the real reader's command form; otherwise this guard would silently stop guarding.
if (process.platform === 'win32' && process.env.SystemRoot) {
  const directory = await mkdtemp(join(tmpdir(), 'maa-version-guard-'));
  try {
    assert.equal(await readMaaVersion(directory), null);
    assert.deepEqual(reads, [join(directory, 'MAA.exe')], 'the version double no longer intercepts readMaaVersion');
  } finally { reads.length = 0; await rm(directory, { recursive: true, force: true }); }
}
after(() => assert.deepEqual(reads, [], 'the real MAA.exe version reader was reached: give the MaaProcess double a version() or pass a versionReader'));
