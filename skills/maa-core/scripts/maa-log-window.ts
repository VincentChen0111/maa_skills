import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Bounds MAA's own logs to one run. MAA v6.21.4 renames a full `debug/asst.log` to `debug/asst.bak.log` and keeps
 * writing a new `asst.log`; the GUI moves `gui.log` to `gui.bak.log` at start-up (see docs/stage-run-sources.md).
 * A cursor names the file by device and file index (a rename keeps it; Windows may give the new file the old creation
 * time), its byte offset and a hash of the bytes just before the offset. Only complete lines after the cursor are
 * returned. A file that cannot be connected to the cursor is a gap: its contents are not attributed to the run.
 */
export type LogName = 'asst' | 'gui';
export const logFiles: Readonly<Record<LogName, { current: string; rotated: string }>> = Object.freeze({
  asst: { current: 'debug/asst.log', rotated: 'debug/asst.bak.log' },
  gui: { current: 'debug/gui.log', rotated: 'debug/gui.bak.log' },
});
export type LogCursor = { file: string; present: boolean; offset: number; size: number; identity: string | null; tailHash: string | null; tailLength: number };
export type LogGap = 'rotated-unmatched' | 'truncated' | 'missing';
export type LogRead = { lines: string[]; cursor: LogCursor; gap: LogGap | null; rotated: boolean };

const tailBytes = 4096;
type Info = { size: number; identity: string | null };

async function info(path: string): Promise<Info | null> {
  try {
    const value = await stat(path, { bigint: true });
    if (!value.isFile()) return null;
    return { size: Number(value.size), identity: value.ino === 0n ? null : `${value.dev}:${value.ino}` };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function bytes(path: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally { await handle.close(); }
}
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function cursorAt(path: string, file: string, offset: number, current: Info): Promise<LogCursor> {
  const tailLength = Math.min(tailBytes, offset);
  return { file, present: true, offset, size: current.size, identity: current.identity, tailLength,
    tailHash: tailLength ? hash(await bytes(path, offset - tailLength, offset)) : null };
}
async function connects(path: string, current: Info, cursor: LogCursor): Promise<boolean> {
  if (current.size < cursor.offset) return false;
  if (cursor.identity !== null && current.identity !== null && current.identity !== cursor.identity) return false;
  if (!cursor.tailLength) return cursor.identity !== null && current.identity === cursor.identity;
  return hash(await bytes(path, cursor.offset - cursor.tailLength, cursor.offset)) === cursor.tailHash;
}
/** Complete lines from `start`; a line already in progress at `start` belongs to the earlier owner. */
async function linesFrom(path: string, start: number, end: number, closed: boolean): Promise<{ lines: string[]; next: number }> {
  let from = start;
  if (start > 0) {
    const previous = await bytes(path, start - 1, start);
    if (previous[0] !== 0x0a) {
      const rest = await bytes(path, start, end), newline = rest.indexOf(0x0a);
      if (newline < 0) return { lines: [], next: start };
      from = start + newline + 1;
    }
  }
  const content = await bytes(path, from, end);
  const last = content.lastIndexOf(0x0a);
  const complete = closed ? content : content.subarray(0, last + 1);
  const lines = complete.toString('utf8').split('\n').map(line => line.replace(/\r$/, ''));
  if (lines.at(-1) === '') lines.pop();
  return { lines, next: from + complete.length };
}

export async function captureLogCursor(maaDirectory: string, name: LogName): Promise<LogCursor> {
  const file = logFiles[name].current, path = join(maaDirectory, file), current = await info(path);
  if (!current) return { file, present: false, offset: 0, size: 0, identity: null, tailHash: null, tailLength: 0 };
  return cursorAt(path, file, current.size, current);
}

export async function readLogSince(maaDirectory: string, name: LogName, cursor: LogCursor): Promise<LogRead> {
  const { current: file, rotated: rotatedFile } = logFiles[name];
  const path = join(maaDirectory, file), current = await info(path);
  if (!cursor.present) {
    if (!current) return { lines: [], cursor, gap: null, rotated: false };
    const read = await linesFrom(path, 0, current.size, false);
    return { lines: read.lines, cursor: await cursorAt(path, file, read.next, current), gap: null, rotated: false };
  }
  if (current && await connects(path, current, cursor)) {
    const read = await linesFrom(path, cursor.offset, current.size, false);
    return { lines: read.lines, cursor: await cursorAt(path, file, read.next, current), gap: null, rotated: false };
  }
  const rotatedPath = join(maaDirectory, rotatedFile), rotated = await info(rotatedPath);
  if (rotated && cursor.identity !== null && rotated.identity === cursor.identity && await connects(rotatedPath, rotated, cursor)) {
    const before = await linesFrom(rotatedPath, cursor.offset, rotated.size, true);
    if (!current) return { lines: before.lines, cursor: { file, present: false, offset: 0, size: 0, identity: null, tailHash: null, tailLength: 0 }, gap: null, rotated: true };
    const after = await linesFrom(path, 0, current.size, false);
    return { lines: [...before.lines, ...after.lines], cursor: await cursorAt(path, file, after.next, current), gap: null, rotated: true };
  }
  const gap: LogGap = !current ? 'missing' : current.identity !== null && current.identity === cursor.identity && current.size < cursor.offset ? 'truncated' : 'rotated-unmatched';
  return { lines: [], cursor: await captureLogCursor(maaDirectory, name), gap, rotated: false };
}
