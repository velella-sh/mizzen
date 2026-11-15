/**
 * Source positions for records and fields in YAML and JSON collections: the span from the first character of a
 * value to its last, counted in Unicode code points, 1-based and inclusive like every `SourcePos`.
 *
 * Positions come from the parser's own ranges, never from re-serializing the file. A range is `[start, end)`, so
 * the last character is one code unit before its end. Lines end at `\n`, which keeps a CRLF file's columns right:
 * the `\r` belongs to the line before it and is never counted as a character of the next one.
 */
import { isMap, type Node, type Pair, type YAMLMap } from "yaml";
import type { RecordPos, SourcePos } from "../contracts/index.ts";

/** A text with every line start, so an offset becomes a line and a code-point column. */
export interface LineIndex {
  /** The text the offsets belong to. */
  readonly text: string;
  /** Offset of the first character of each line; line 1 starts at 0. */
  readonly starts: readonly number[];
}

/** Indexes `text` once for every position read from it. */
export function lineIndex(text: string): LineIndex {
  const starts = [0];
  for (let offset = 0; offset < text.length; offset++) {
    if (text.charCodeAt(offset) === 10) starts.push(offset + 1);
  }
  return { text, starts };
}

/** The 1-based line and code-point column of `offset`. */
function lineColumn(index: LineIndex, offset: number): { readonly line: number; readonly column: number } {
  let low = 0;
  let high = index.starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (index.starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  const start = index.starts[low]!;
  let column = 1;
  for (const _ of index.text.slice(start, offset)) column += 1;
  return { line: low + 1, column };
}

/** The span of a `[start, end)` range, or the point at `start` for an empty range. */
export function spanOf(index: LineIndex, file: string, start: number, end: number): RecordPos {
  const last = Math.max(start, end - 1);
  const begin = lineColumn(index, start);
  const finish = lineColumn(index, last);
  return {
    file,
    startLine: begin.line,
    startColumn: begin.column,
    endLine: finish.line,
    endColumn: finish.column,
  };
}

/** The parser range of a node; a node the parser gave no range starts at the file's first character. */
function rangeOf(node: Node): readonly [number, number] {
  const range = node.range;
  if (range === null || range === undefined) return [0, 0];
  return [range[0], range[1]];
}

/** The span of one node. */
export function nodePos(index: LineIndex, file: string, node: Node): RecordPos {
  const [start, end] = rangeOf(node);
  return spanOf(index, file, start, end);
}

/** A record span as the diagnostic contract writes one: the start is `line` and `column`. */
export function sourcePosOf(pos: RecordPos): SourcePos {
  return {
    file: pos.file,
    line: pos.startLine,
    column: pos.startColumn,
    endLine: pos.endLine,
    endColumn: pos.endColumn,
  };
}

/** The mapping entries of a YAML or JSON mapping, in source order. */
export function mappingPairs(node: Node): readonly Pair<unknown, unknown>[] {
  if (!isMap(node)) return [];
  return (node as YAMLMap).items;
}

/** The text of a mapping key, when it is a scalar; `undefined` for a complex key. */
export function keyText(pair: Pair<unknown, unknown>): string | undefined {
  const key = pair.key as Node | null;
  if (key === null || typeof key !== "object" || !("value" in key)) return undefined;
  const value = (key as { readonly value?: unknown }).value;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** Where each top-level field's value sits, keyed by field name. A field without a value uses its key's span. */
export function fieldPositionsOf(
  index: LineIndex,
  file: string,
  mapping: Node,
): Record<string, RecordPos> {
  const found: Record<string, RecordPos> = {};
  for (const pair of mappingPairs(mapping)) {
    const key = keyText(pair);
    if (key === undefined) continue;
    const value = pair.value as Node | null;
    found[key] = value === null || typeof value !== "object" ? nodePos(index, file, pair.key as Node) : nodePos(index, file, value);
  }
  return found;
}
