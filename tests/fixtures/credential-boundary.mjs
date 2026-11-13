import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Test-only: replaces the Windows protection boundary that credentials.ts imports. Files, settings
// and the credential CLI itself stay real.
const core = realpathSync.native(process.env.MAA_CREDENTIAL_TEST_CORE);
const credentialsUrl = pathToFileURL(join(core, 'scripts/credentials.ts')).href;
const protectionUrl = pathToFileURL(join(core, 'scripts/credential-protection.ts')).href;
const doubleUrl = new URL('./credential-protection-double.mjs', import.meta.url).href;
const canonicalUrl = (url) => {
  try { return pathToFileURL(realpathSync.native(fileURLToPath(url))).href; } catch { return undefined; }
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (canonicalUrl(context.parentURL) === credentialsUrl && canonicalUrl(result.url) === protectionUrl) return { url: doubleUrl, shortCircuit: true };
    return result;
  },
});
