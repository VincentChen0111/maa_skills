// Evaluation fixture only: real filesystem operations in a freshly created sample.
import { readFile, writeFile, appendFile, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const workspace = process.cwd();
const marker = JSON.parse(await readFile(join(workspace, '.eval-fixture.json'), 'utf8'));
if (marker.kind !== 'maa-skills-evaluation' || resolve(process.env.MAA_SKILLS_HOME ?? '') !== resolve(workspace, 'private')) throw new Error('fixture-required');
if (process.argv[2] !== 'write') throw new Error('unknown-probe-action');
const operation = randomUUID();
const pid = process.pid;
const log = (event: object) => appendFile(join(workspace, 'events.jsonl'), `${JSON.stringify(event)}\n`);
const lockPath = join(workspace, 'private/write.lock');
const lock = await open(lockPath, 'wx');
try {
  await lock.writeFile(JSON.stringify({ operation, pid }));
  await log({ kind: 'lock-acquired', operation, pid });
  const file = join(workspace, 'maa/config.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.queue = ['1-7'];
  await writeFile(file, JSON.stringify(config));
  await log({ kind: 'write', operation, pid, file: 'maa/config.json', key: 'queue', value: ['1-7'] });
} finally {
  await lock.close();
  await unlink(lockPath);
  await log({ kind: 'lock-released', operation, pid });
}
console.log(JSON.stringify({ ok: true, changed: ['queue'] }));
