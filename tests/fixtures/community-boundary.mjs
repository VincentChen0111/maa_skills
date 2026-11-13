import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Test-only: replaces the network transport that the Skland community and Bilibili readers import through
// research-fetch.ts. The CLIs, settings, credential reader, cache, gate files and parsers stay real.
const core = realpathSync.native(process.env.MAA_RESEARCH_TEST_CORE);
const helperUrl = pathToFileURL(join(core, 'scripts/research-fetch.ts')).href;
const transportUrl = pathToFileURL(join(core, 'scripts/research-transport.ts')).href;
const doubleUrl = new URL('./community-transport-double.mjs', import.meta.url).href;
const canonicalUrl = (url) => {
  try { return pathToFileURL(realpathSync.native(fileURLToPath(url))).href; } catch { return undefined; }
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (canonicalUrl(context.parentURL) === helperUrl && canonicalUrl(result.url) === transportUrl) return { url: doubleUrl, shortCircuit: true };
    return result;
  },
});
