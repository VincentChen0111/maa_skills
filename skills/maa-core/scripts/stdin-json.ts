/**
 * The one reader of JSON requests on standard input for every CLI under skills/ (ticket 26). A conformance test lists every
 * reader and fails when a CLI reads `process.stdin` itself.
 *
 * Windows PowerShell 5.1 pipes text to a native command with a UTF-8 byte order mark in front when the console input
 * encoding is UTF-8, and with its default `$OutputEncoding` (us-ascii) every non-ASCII character is already `?`. The mark is
 * removed here. When the mark was there and the text holds a literal `?`, characters may already be lost, so the request is
 * refused (`input-encoding-lossy`) instead of being stored mangled; the caller resends non-ASCII text and `?` as `\uXXXX`
 * escapes. Bytes that are not UTF-8 at all are refused the same way. Without a mark a `?` is ordinary text.
 */

export const stdinJsonCodes = { lossy: 'input-encoding-lossy', tooLarge: 'input-too-large', invalid: 'input-json-invalid' } as const;

/** A request refused before anything else ran; `code` is static and safe to print. */
export class StdinJsonError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'StdinJsonError'; this.code = code; }
}

export interface StdinJsonOptions {
  /** The CLI's own limit in bytes, kept from before the shared reader; null where the CLI never had one. */
  maxBytes: number | null;
  /** Returned for empty input; without it empty input is not JSON. */
  empty?: unknown;
  /** The CLI's existing codes for an oversized or unparsable request; the shared defaults otherwise. */
  tooLargeCode?: string;
  invalidCode?: string;
}

/** The static code of a refusal by this reader, or undefined for any other error. */
export function stdinJsonCode(error: unknown): string | undefined {
  return error instanceof StdinJsonError ? error.code : undefined;
}

export function decodeStdinJson(bytes: Uint8Array, options: StdinJsonOptions): unknown {
  let text: string;
  // ignoreBOM keeps the mark in the decoded text so it can be seen; fatal refuses bytes that are not UTF-8.
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new StdinJsonError(stdinJsonCodes.lossy); }
  if (text.startsWith('﻿')) {
    text = text.slice(1);
    if (text.includes('?')) throw new StdinJsonError(stdinJsonCodes.lossy);
  }
  if (text === '' && Object.hasOwn(options, 'empty')) return options.empty;
  try { return JSON.parse(text) as unknown; }
  catch { throw new StdinJsonError(options.invalidCode ?? stdinJsonCodes.invalid); }
}

export async function readStdinJson(options: StdinJsonOptions, source: AsyncIterable<Uint8Array | string> = process.stdin): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const part = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    size += part.length;
    if (options.maxBytes !== null && size > options.maxBytes) throw new StdinJsonError(options.tooLargeCode ?? stdinJsonCodes.tooLarge);
    chunks.push(part);
  }
  return decodeStdinJson(Buffer.concat(chunks), options);
}
