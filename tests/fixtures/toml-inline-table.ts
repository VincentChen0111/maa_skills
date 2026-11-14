/**
 * A minimal reader for the one TOML shape the Codex permission profile hands over as a value: an inline table of bare keys and
 * basic strings, `{NAME="value",...}` (TOML 1.0, "Basic strings"). Written from the specification for the tests, separately
 * from the encoder in `scripts/eval-host.ts`: undefined for anything else, including a raw control character (tab aside) and an
 * unknown escape.
 */
export function inlineTable(text: string): Record<string, string> | undefined {
  const body = text.match(/^\{(.*)\}$/s)?.[1];
  if (body === undefined) return undefined;
  const table: Record<string, string> = {};
  let at = 0;
  const space = () => { while (body[at] === ' ' || body[at] === '\t') at += 1; };
  space();
  if (at === body.length) return table;
  for (;;) {
    space();
    const key = body.slice(at).match(/^[A-Za-z0-9_-]+/)?.[0];
    if (!key) return undefined;
    at += key.length; space();
    if (body[at++] !== '=') return undefined;
    space();
    if (body[at++] !== '"') return undefined;
    let value = '';
    for (;;) {
      const char = body[at++];
      if (char === undefined) return undefined;
      if (char === '"') break;
      if (char === '\\') {
        const escape = body[at++] ?? '';
        const simple: Record<string, string> = { '"': '"', '\\': '\\', b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' };
        if (Object.hasOwn(simple, escape)) { value += simple[escape]; continue; }
        const size = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
        const hex = body.slice(at, at + size);
        if (!size || !new RegExp(`^[0-9A-Fa-f]{${size}}$`).test(hex)) return undefined;
        value += String.fromCodePoint(parseInt(hex, 16)); at += size;
        continue;
      }
      if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(char)) return undefined;
      value += char;
    }
    table[key] = value; space();
    if (at === body.length) return table;
    if (body[at++] !== ',') return undefined;
  }
}

/** The PATH a `-c shell_environment_policy.set={PATH="..."}` value sets; undefined when the value is not that shape. */
export function setPath(argument: string | undefined): string | undefined {
  const prefix = 'shell_environment_policy.set=';
  if (!argument?.startsWith(prefix)) return undefined;
  const table = inlineTable(argument.slice(prefix.length));
  return table && Object.keys(table).length === 1 ? table.PATH : undefined;
}
