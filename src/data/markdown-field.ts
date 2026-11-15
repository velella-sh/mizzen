/**
 * Renders one field the config marks as Markdown through the page pipeline. The field's own text is parsed from line 1,
 * then every block is moved onto the field's span in the data file: a block scalar maps line by line, and a value that
 * sits on one line (a JSON string) maps every block to that line, clamped to the value's columns. Each block keeps a
 * `data-src` naming the data file, so the rendered HTML points at the line an agent edits.
 */
import type { Nodes, RootContent } from "mdast";
import type { RecordPos } from "../contracts/index.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { formatSpan } from "../source/spans.ts";

/** Block node types that carry `data-src`, the same set the HTML stage stamps. */
const SOURCED = new Set(["heading", "paragraph", "list", "table", "code", "blockquote", "containerDirective", "leafDirective", "tabsBlock"]);

/** The number of code points in a line, without its line ending. */
function widthOf(line: string): number {
  return Array.from(line.endsWith("\r") ? line.slice(0, -1) : line).length;
}

/** The 0-based columns of the first non-space character of a line. */
function indentOf(line: string): number {
  return Array.from(line).findIndex((char) => char !== " " && char !== "\t");
}

/** A mapping from a position inside the field value to a position in the data file. */
function mapper(span: RecordPos, sourceLines: readonly string[] | undefined) {
  const multiline = span.endLine > span.startLine && sourceLines !== undefined;
  return (line: number, column: number): { line: number; column: number; endLine: number; endColumn: number } => {
    if (!multiline) {
      // A one-line value: every block points at the string's own line, its columns kept inside the value's span.
      const offset = Math.max(0, column - 1);
      const at = Math.min(span.endColumn, span.startColumn + offset);
      return { line: span.startLine, column: at, endLine: span.startLine, endColumn: at };
    }
    const sourceLine = Math.min(span.endLine, span.startLine + line);
    const raw = sourceLines[sourceLine - 1] ?? "";
    const indent = Math.max(0, indentOf(raw));
    const at = Math.min(Math.max(1, widthOf(raw)), Math.max(1, indent + column));
    return { line: sourceLine, column: at, endLine: sourceLine, endColumn: at };
  };
}

/** Moves every node of the parsed field onto the data file, and stamps each block with its span. */
function place(node: Nodes, toSpan: ReturnType<typeof mapper>, field: string): void {
  const start = node.position?.start;
  const end = node.position?.end;
  if (start !== undefined && end !== undefined) {
    const begin = toSpan(start.line, start.column);
    const finish = toSpan(end.line, end.column);
    node.position = {
      start: { ...start, line: begin.line, column: begin.column },
      end: { ...end, line: finish.line, column: finish.endColumn },
    };
  }
  if (SOURCED.has(node.type) && node.position !== undefined) {
    const data = (node.data ??= {}) as { hProperties?: Record<string, unknown> };
    data.hProperties = {
      ...data.hProperties,
      "data-src": formatSpan({
        file: field,
        line: node.position.start.line,
        column: node.position.start.column,
        endLine: node.position.end.line,
        endColumn: node.position.end.column,
      }),
    };
  }
  if ("children" in node) {
    for (const child of node.children) place(child, toSpan, field);
  }
}

/**
 * The blocks of a Markdown field, positioned in its data file. `value` is the field's text, `span` its position, and
 * `sourceLines` the data file's lines, used to find a block scalar's real indentation.
 */
export async function markdownFieldBlocks(
  value: string,
  span: RecordPos,
  sourceLines?: readonly string[],
): Promise<RootContent[]> {
  const tree = await parseMarkdown(value, 1);
  const toSpan = mapper(span, sourceLines);
  for (const node of tree.children) place(node, toSpan, span.file);
  return tree.children;
}
