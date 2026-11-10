import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [directory, delayText = '0', mode = 'ready'] = process.argv.slice(2);
const stamp = () => {
  const now = new Date();
  const pad = (n, length = 2) => String(n).padStart(length, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
};
await mkdir(join(directory, 'debug'), { recursive: true });
const log = async (name, text) => appendFile(join(directory, 'debug', 'gui.log'), `[${stamp()}][INF]${`[${name}]`.padEnd(24)} <1> ${text}\n`);
await log('Bootstrapper', 'MaaAssistantArknights GUI started');
await log('Bootstrapper', 'Version v6.21.4');
if (mode !== 'not-ready') await log('RunningState', 'Init: False to True (called from Init)');
process.send?.({ ready: true });
process.on('message', async (message) => {
  if (message === 'close' && mode !== 'refuse') {
    setTimeout(async () => { await log('Bootstrapper', 'MaaAssistantArknights GUI exited'); process.exit(0); }, Number(delayText));
  } else if (typeof message === 'object' && message?.log) {
    await log('RunningState', message.log);
    process.send?.({ logged: true });
  }
});
