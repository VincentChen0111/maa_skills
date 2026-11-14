import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixturePrefix } from './eval-fixture.ts';

/**
 * The one owner of what an evaluation writes to disk. Every artifact (run records, evidence, raw host output, invocation,
 * scenario, batch manifest, read-protection output) is written through `artifactWriter`, which replaces each private path
 * with a fixed placeholder first; this module alone decides which paths those are. `tests/eval-redact.test.ts` enumerates
 * every producer and every artifact. It also owns the forms of a path: the long form (`longPath`), which the redaction and
 * the login directory overlap check (`scripts/eval-auth.ts`) both use; the forms of the login directory the runner holds
 * (`loginDirectoryForms`); and the matcher that finds a path in any spelling (`pathMatcher`), which the redaction and the
 * grader's secret-output rule (`scripts/evaluation.ts`) both use.
 */
export type ArtifactContext = {
  /** The login directory, or every form of it the runner holds (`loginDirectoryForms`); likewise the sentinel inside it. */
  loginDirectory?: string | readonly string[]; sentinel?: string | readonly string[]; fixture?: { root: string; workspace: string }; executable?: string;
  /** Exact values (not paths) that must not reach disk either, such as the sentinel's content. */
  values?: [value: string, placeholder: string][];
};
/** A path, its placeholder, and optionally a pattern for a generated name that follows it (a temporary directory's suffix). */
type RedactedPath = [path: string | undefined, placeholder: string, generated?: string];

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const each = (value: string | readonly string[] | undefined): readonly (string | undefined)[] => typeof value === 'string' || value === undefined ? [value] : value;
/**
 * The private paths of one artifact context, each with its placeholder. Besides the context's own fixture, any evaluation
 * fixture (the version probe's, the read-protection check's) is covered by its generated name.
 */
function privatePaths(context: ArtifactContext): RedactedPath[] {
  return [...each(context.sentinel).map((path): RedactedPath => [path, '<login-dir>/<sentinel>']),
    ...each(context.loginDirectory).map((path): RedactedPath => [path, '<login-dir>']), [context.fixture?.workspace, '<workspace>'],
    [context.fixture?.root, '<fixture>'], [join(tmpdir(), fixturePrefix), '<fixture>', '[A-Za-z0-9]{6}'], [repositoryRoot, '<repo>'],
    [context.executable && isAbsolute(context.executable) ? context.executable : undefined, '<host-executable>'], [homedir(), '<home>']];
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A separator run: slashes and backslashes (any run of backslashes covers every depth of JSON escaping), JSON `\u` escapes of
// either, and their percent-encodings, in any mix. Each token starts with its own character (`\`, `/`, `%`, `u` right after a
// backslash), so a run splits into tokens one way only and matching stays linear however long the run is.
const separatorRun = '(?:\\\\|/|%(?:5c|2f)|(?<=\\\\)u00(?:5c|2f))+';
// Where a path without a drive letter starts: one slash, after any backslashes (a `\/` escape).
const rootSeparator = '\\\\*(?:/|%2f|(?<=\\\\)u002f)';
/**
 * One character in each spelling a host, JSON or a URL may give it: as itself, percent-encoded, or as JSON `\u` escapes. Encoders
 * differ in which characters they percent-encode (Node's `pathToFileURL` encodes `~`, `encodeURIComponent` does not), so every
 * character but a letter or digit also matches its UTF-8 percent-encoding; the pattern is case-insensitive, so either hex case.
 */
function character(char: string): string {
  const spellings = [escape(char)];
  if (!/^[A-Za-z0-9]$/.test(char)) spellings.push([...new TextEncoder().encode(char)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''));
  if (char.codePointAt(0)! > 0x7e) {
    spellings.push([...Array(char.length).keys()].map((index) => `\\\\+u${char.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''));
  }
  return spellings.length === 1 ? spellings[0]! : `(?:${spellings.join('|')})`;
}
/**
 * The pattern for one path, case-insensitive. Segments are matched one by one with any separator run between them; a drive
 * letter also matches its MSYS and permission-rule form (`/c/...`, `//c/...`), and a `\\?\` prefix is simply left before the
 * placeholder. There is no boundary after the last segment: whatever follows (text, punctuation, a longer sibling name's
 * suffix) stays, and the path itself is gone.
 */
function pathPattern(path: string, generated = ''): RegExp {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const drive = parts[0]?.match(/^([A-Za-z]):$/);
  const body = (drive ? parts.slice(1) : parts).map((part) => [...part].map(character).join('')).join(separatorRun);
  const head = drive ? `(?:${character(drive[1]!)}${character(':')}|/${escape(drive[1]!)})${separatorRun}` : rootSeparator;
  return new RegExp(`${head}${body}${generated}`, 'giu');
}
/**
 * The long form of a path: resolved, with its deepest existing part replaced by what the file system says it is (8.3 short
 * names expanded, junctions and symbolic links followed, a `\\?\` prefix dropped) and the part that does not exist yet appended
 * as written. Two spellings of one place have the same long form whether or not the place exists yet.
 */
export function longPath(path: string): string {
  const missing: string[] = [];
  for (let existing = resolve(path); ; existing = dirname(existing)) {
    try { return join(realpathSync.native(existing), ...missing.reverse()); } catch { /* not there yet: try its parent */ }
    if (dirname(existing) === existing) return resolve(path);
    missing.push(basename(existing));
  }
}
/**
 * A path as given, resolved, and in its long form, the spellings a host may print for it. Windows hands a host the form it was
 * given or, when the host resolves the path, the long form; it never turns a long name into a short one unless asked, and the
 * host's environment (home, temporary directory) points only into the fixture, so the short form of a long path is not listed.
 */
function spellings(path: string): string[] {
  return [...new Set([path, resolve(path), longPath(path)])];
}
/**
 * The forms of a login directory the runner holds, decided once before any use (#80): its long form first, which every use
 * takes (the host's configuration variable, the sentinel and the prompt naming it, the lock beside it), then the form it was
 * given where that differs. The deny rules handed to each host, the grader's secret paths, the redaction and the
 * read-protection probe take every form, so a host that matches its rules by string still denies whichever of the two a model
 * names; the probe proves the forms no rule names are denied too.
 */
export function loginDirectoryForms(given: string): readonly string[] {
  const long = longPath(given);
  return Object.freeze(long === given ? [long] : [long, given]);
}
/**
 * The 8.3 short form Windows gives a path (`cmd`'s `%~s`; a part that does not exist yet stays as written) when it differs from
 * the path and names the same place; undefined where there is none (not Windows, short names off on the volume). The path reaches `cmd` through a
 * variable, which `cmd` expands once and does not parse further, and `/u` makes it print UTF-16, so any character survives; a
 * garbled answer fails the same-place check. Only the read-protection probe uses it: hosts are never handed a short form.
 */
export function shortPath(path: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const result = spawnSync('cmd.exe', ['/d', '/u', '/c', 'for %I in ("%MAA_EVAL_SHORT_PATH%") do @echo %~sI'],
    { env: { ...process.env, MAA_EVAL_SHORT_PATH: path }, windowsVerbatimArguments: true, windowsHide: true, timeout: 10_000 });
  const short = result.status === 0 && result.stdout ? Buffer.from(result.stdout).toString('utf16le').trim() : '';
  return short && short.toLowerCase() !== path.toLowerCase() && longPath(short) === longPath(path) ? short : undefined;
}
/**
 * Whether a text names a path in any spelling the redaction replaces: as given, resolved or in its long form; any run of
 * separators, JSON escapes or percent-encoding; either case. These are the redaction's own patterns, so the redaction and the
 * grader's secret-output rule never disagree about what names a path.
 */
export function pathMatcher(path: string): (text: string) => boolean {
  const patterns = spellings(path).map((spelling) => pathPattern(spelling));
  return (text) => patterns.some((pattern) => text.search(pattern) >= 0);
}

/** The redaction every artifact goes through: private paths (longest first, so a nested path keeps its own placeholder), then values. */
export function redactor(context: ArtifactContext): (text: string) => string {
  const patterns = privatePaths(context).flatMap(([path, placeholder, generated]) => !path || path.length < 4 ? []
    : spellings(path).map((spelling) => ({ spelling, placeholder, generated })))
    .sort((a, b) => b.spelling.length - a.spelling.length).map(({ spelling, placeholder, generated }) => ({ regex: pathPattern(spelling, generated), placeholder }));
  const values = (context.values ?? []).filter(([value]) => value.length >= 8);
  return (text) => values.reduce((current, [value, placeholder]) => current.replaceAll(value, placeholder),
    patterns.reduce((current, { regex, placeholder }) => current.replace(regex, () => placeholder), text));
}

/** The only way an evaluation artifact reaches disk: `write(file, text)` saves `text` under `directory` after redaction. */
export function artifactWriter(directory: string, context: ArtifactContext) {
  const redact = redactor(context);
  return Object.assign((file: string, text: string) => writeFile(join(directory, file), redact(text)), { redact });
}
