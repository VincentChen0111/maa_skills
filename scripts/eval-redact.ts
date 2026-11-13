import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixturePrefix } from './eval-fixture.ts';

/**
 * The one owner of what an evaluation writes to disk. Every artifact (run records, evidence, raw host output, invocation,
 * scenario, batch manifest, read-protection output) is written through `artifactWriter`, which replaces each private path
 * with a fixed placeholder first; this module alone decides which paths those are. `tests/eval-redact.test.ts` enumerates
 * every producer and every artifact.
 */
export type ArtifactContext = {
  loginDirectory?: string; sentinel?: string; fixture?: { root: string; workspace: string }; executable?: string;
  /** Exact values (not paths) that must not reach disk either, such as the sentinel's content. */
  values?: [value: string, placeholder: string][];
};
/** A path, its placeholder, and optionally a pattern for a generated name that follows it (a temporary directory's suffix). */
type RedactedPath = [path: string | undefined, placeholder: string, generated?: string];

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
/**
 * The private paths of one artifact context, each with its placeholder. Besides the context's own fixture, any evaluation
 * fixture (the version probe's, the read-protection check's) is covered by its generated name.
 */
function privatePaths(context: ArtifactContext): RedactedPath[] {
  return [[context.sentinel, '<login-dir>/<sentinel>'], [context.loginDirectory, '<login-dir>'], [context.fixture?.workspace, '<workspace>'],
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
/** One character in each spelling a host, JSON or a URL may give it: as itself, percent-encoded, or as JSON `\u` escapes. */
function character(char: string): string {
  const spellings = [escape(char)];
  const percent = encodeURIComponent(char);
  if (percent !== char) spellings.push(escape(percent));
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
/** A path and its resolved form (a junction or a short name resolves to another spelling a host may print instead). */
function spellings(path: string): string[] {
  let resolved: string | undefined;
  try { resolved = realpathSync.native(path); } catch { resolved = undefined; }
  return [...new Set([path, ...(resolved ? [resolved] : [])])];
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
