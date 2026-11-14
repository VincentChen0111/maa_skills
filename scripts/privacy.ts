import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repositoryFiles } from './files.ts';

export type PrivacyFinding = { file: string; line: number; rule: string };
const privatePath = /\b[A-Za-z]:[\\/]|\/(?:Users|home)\/[^\s/<>]+/;
const rules = [
  ['private-path', privatePath],
  ['credential', /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['account-marker', /PRIVATE[_-]ACCOUNT[_-]MARKER|\b(?:uid|gameUid|accountId|playerId)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_@.-]{4,}/i],
] as const;

function hasAssignedCredential(line: string): boolean {
  const assignments = /\b(?:token|cookie|password|secret|api[_-]?key|authorization)\b["']?\s*(?::\s*string\s*)?[:=]\s*(?:"([^"]*)"|'([^']*)'|((?:Bearer\s+)?[^\s,;}]+))/gi;
  for (const match of line.matchAll(assignments)) {
    const quoted = match[1] ?? match[2];
    const value = (quoted ?? match[3] ?? '').replace(/^Bearer\s+/i, '');
    if (/^<[^>]*>['"`\]),.]*$/.test(value) || value.startsWith('${')) continue;
    if (quoted !== undefined) { if (value.length >= 6) return true; }
    else if (value.length >= 6 && !/\b(?:const|let|var)\s+$/.test(line.slice(0, match.index))
      && !/^(?:string|number|boolean|unknown|undefined)$/.test(value) && !value.startsWith('process.env.')) return true;
  }
  return false;
}

export async function inspectPrivacy(root: string): Promise<PrivacyFinding[]> {
  const findings: PrivacyFinding[] = [];
  for (const file of await repositoryFiles(root)) findings.push(...inspectText(file, await readFile(join(root, file), 'utf8')));
  return findings;
}

/** The same line rules for one file's text; the release package check applies them to an installed directory. */
export function inspectText(file: string, text: string): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (hasAssignedCredential(line)) findings.push({ file, line: index + 1, rule: 'credential' });
    for (const [rule, pattern] of rules) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, rule });
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const findings = await inspectPrivacy(resolve(process.argv[2] ?? '.'));
    console.log(JSON.stringify({ ok: findings.length === 0, findings }));
    process.exitCode = findings.length ? 1 : 0;
  } catch {
    console.error('Privacy check could not inspect all files.');
    process.exitCode = 1;
  }
}
