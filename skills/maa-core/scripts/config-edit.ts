/**
 * Ticket 30: the writer's minimal edit. It replaces only the text of the values a request changes and leaves every other
 * byte of `gui.new.json` as it was: a byte-order mark, line endings, indentation, key order, number and escape spellings,
 * and integers beyond 2^53 that a JavaScript parse would round. A whole re-serialization changed all of those (the reasons
 * and what MAA could observe are in docs/daily-verification.md, 「30 配置写入器加固」).
 *
 * The parser here only finds where each value starts and ends; values themselves are always decoded by `JSON.parse`. The
 * result is checked: parsing it must give exactly the configuration the writer prepared, or the edit throws and nothing
 * is written.
 *
 * Review round 1: "the same value" is `sameConfigValue`, for which object key order does not count (MAA saves objects in
 * its own key order, for example each `Copilot.TaskList` item). A value equal to the old one keeps its bytes whatever its
 * key order; a changed object whose keys are in another order than the prepared one is written whole, in the prepared
 * order; the final check compares by the same predicate, so array order and every value still have to match exactly.
 */
import { sameConfigValue } from './config-projection.ts';

type Node = { start: number; end: number; kind: 'object' | 'array' | 'scalar'; members: Member[]; items: Node[] };
type Member = { key: string; keyStart: number; keyEnd: number; value: Node };
type Path = (string | number)[];

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const literal = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
/** A UTF-8 byte-order mark, which MAA's reader accepts and the writer keeps. */
const bom = String.fromCharCode(0xfeff);

function parse(text: string): Node {
  let position = text.startsWith(bom) ? 1 : 0;
  const fail = (): never => { throw new Error('configuration-text-unsupported'); };
  const space = () => { while (position < text.length && ' \t\n\r'.includes(text[position]!)) position++; };
  const string = () => {
    if (text[position] !== '"') fail();
    for (position++; position < text.length; position++) {
      if (text[position] === '\\') position++;
      else if (text[position] === '"') { position++; return; }
    }
    fail();
  };
  const value = (): Node => {
    space();
    const start = position, next = text[position];
    if (next === '{') {
      const members: Member[] = []; position++; space();
      if (text[position] === '}') { position++; return { start, end: position, kind: 'object', members, items: [] }; }
      for (;;) {
        space(); const keyStart = position; string(); const keyEnd = position;
        space(); if (text[position] !== ':') fail(); position++;
        members.push({ key: JSON.parse(text.slice(keyStart, keyEnd)) as string, keyStart, keyEnd, value: value() });
        space();
        if (text[position] === ',') { position++; continue; }
        if (text[position] === '}') { position++; return { start, end: position, kind: 'object', members, items: [] }; }
        fail();
      }
    }
    if (next === '[') {
      const items: Node[] = []; position++; space();
      if (text[position] === ']') { position++; return { start, end: position, kind: 'array', members: [], items }; }
      for (;;) {
        items.push(value()); space();
        if (text[position] === ',') { position++; continue; }
        if (text[position] === ']') { position++; return { start, end: position, kind: 'array', members: [], items }; }
        fail();
      }
    }
    if (next === '"') { string(); return { start, end: position, kind: 'scalar', members: [], items: [] }; }
    literal.lastIndex = position;
    const match = literal.exec(text);
    if (!match) fail();
    position += match![0].length;
    return { start, end: position, kind: 'scalar', members: [], items: [] };
  };
  const root = value(); space();
  if (position !== text.length) fail();
  return root;
}

/**
 * The configuration text with each changed path's value replaced. `before` is the text's parse, `after` the configuration
 * the writer prepared from it; `paths` are the request's resolved change paths. Only a missing `Timers.List[i].IsEnabled`
 * (MAA's omitted null) may be added, at the end of its object, where the writer's prepared object also has it.
 */
export function editConfigurationText(text: string, after: unknown, paths: Path[]): string {
  const root = parse(text);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = /\n([ \t]+)\S/.exec(text)?.[1] ?? '';
  const slice = (node: Node) => text.slice(node.start, node.end);
  const indentAt = (offset: number) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', offset - 1) + 1))![0];
  const serialize = (value: unknown, indent: string) => unit ? JSON.stringify(value, null, unit).split('\n').join(newline + indent) : JSON.stringify(value);
  const member = (node: Node, key: string) => node.members.findLast(item => item.key === key);
  const splice = (node: Node, spans: { start: number; end: number; text: string }[]) => {
    let result = '', cursor = node.start;
    for (const span of spans) { result += text.slice(cursor, span.start) + span.text; cursor = span.end; }
    return result + text.slice(cursor, node.end);
  };
  const render = (node: Node, value: unknown): string => {
    if (sameConfigValue(JSON.parse(slice(node)), value)) return slice(node);
    if (node.kind === 'array' && Array.isArray(value) && value.length === node.items.length) {
      // A permutation of the old items (a queue reorder) keeps each item's own bytes; otherwise each item is edited in place.
      const old = node.items.map(item => JSON.parse(slice(item)) as unknown), used = new Set<number>();
      const order = value.map(item => { const index = old.findIndex((candidate, at) => !used.has(at) && sameConfigValue(candidate, item)); used.add(index); return index; });
      const pieces = order.every(index => index >= 0) ? order.map(index => slice(node.items[index]!)) : node.items.map((item, index) => render(item, value[index]));
      return splice(node, node.items.map((item, index) => ({ start: item.start, end: item.end, text: pieces[index]! })));
    }
    // Members are edited in place only when the file holds the prepared keys in the prepared order (so no key repeats);
    // otherwise the object is written whole in the prepared order (MAA's own save may have put its keys in another order).
    const keys = isRecord(value) ? Object.keys(value) : [];
    if (node.kind === 'object' && isRecord(value) && node.members.length === keys.length && node.members.every((item, index) => item.key === keys[index])) {
      return splice(node, node.members.map(item => ({ start: item.value.start, end: item.value.end, text: render(item.value, value[item.key]) })));
    }
    return serialize(value, indentAt(node.start));
  };
  const edits: { start: number; end: number; text: string }[] = [];
  for (const path of paths) {
    let node = root, target: unknown = after;
    for (const [index, key] of path.entries()) {
      const last = index === path.length - 1;
      target = (target as Record<string | number, unknown>)?.[key];
      const child = node.kind === 'array' && typeof key === 'number' ? node.items[key] : node.kind === 'object' && typeof key === 'string' ? member(node, key)?.value : undefined;
      if (child) { node = child; continue; }
      if (!last || node.kind !== 'object' || typeof key !== 'string' || path.length !== 4 || path[0] !== 'Timers' || path[1] !== 'List' || key !== 'IsEnabled') throw new Error('configuration-text-unsupported');
      // MAA omits a null one-shot flag; the prepared object has the key at its end, so it is added there.
      const previous = node.members.at(-1);
      const text_ = JSON.stringify(key) + (previous ? text.slice(previous.keyEnd, previous.value.start) : ': ') + serialize(target, indentAt(previous?.keyStart ?? node.start + 1));
      const separator = !previous ? '' : node.members.length > 1 ? text.slice(node.members.at(-2)!.value.end, previous.keyStart) : `,${text.slice(node.start + 1, previous.keyStart)}`;
      const at = previous ? previous.value.end : node.start + 1;
      edits.push({ start: at, end: at, text: separator + text_ });
      node = undefined as unknown as Node;
      break;
    }
    if (node) edits.push({ start: node.start, end: node.end, text: render(node, target) });
  }
  edits.sort((left, right) => left.start - right.start);
  if (edits.some((edit, index) => index > 0 && edit.start < edits[index - 1]!.end)) throw new Error('configuration-text-unsupported');
  let result = '', cursor = 0;
  for (const edit of edits) { result += text.slice(cursor, edit.start) + edit.text; cursor = edit.end; }
  result += text.slice(cursor);
  if (!sameConfigValue(JSON.parse(result.startsWith(bom) ? result.slice(1) : result), after)) throw new Error('configuration-text-unsupported');
  return result;
}
