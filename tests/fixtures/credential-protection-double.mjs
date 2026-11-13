import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

// Test-only stand-in for the Windows per-user protection boundary. The transform is reversible
// but never leaves the plaintext bytes in the saved record, and a different entropy cannot open it.
const prefix = Buffer.from('double-protection-1:');
const tag = (entropy) => createHash('sha256').update(String(entropy)).digest().subarray(0, 8);
const flip = (bytes) => Buffer.from(Array.from(bytes, (byte) => byte ^ 0xa5));
const journal = (kind) => { if (process.env.MAA_CREDENTIAL_TEST_JOURNAL) appendFileSync(process.env.MAA_CREDENTIAL_TEST_JOURNAL, `${kind}\n`); };

export const windowsProtector = {
  async protect(plain, entropy) {
    journal('protect');
    if (process.env.MAA_CREDENTIAL_TEST_PROTECTION === 'fail') throw new Error('protection-failed');
    return Buffer.concat([prefix, tag(entropy), flip(plain)]);
  },
  async unprotect(cipher, entropy) {
    journal('unprotect');
    if (process.env.MAA_CREDENTIAL_TEST_PROTECTION === 'fail') throw new Error('protection-failed');
    if (!cipher.subarray(0, prefix.length).equals(prefix) || !cipher.subarray(prefix.length, prefix.length + 8).equals(tag(entropy))) throw new Error('protection-unreadable');
    return flip(cipher.subarray(prefix.length + 8));
  },
};
