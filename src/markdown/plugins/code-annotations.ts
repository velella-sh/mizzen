import type { Nodes, Root } from "mdast";
import type { Plugin } from "unified";
import type { CodeAnnotation } from "../../contracts/code.ts";
import type { Diagnostic } from "../../contracts/diagnostic.ts";
import type { SourcePos } from "../../contracts/source.ts";
import { spanFromPosition } from "../../source/spans.ts";

/** Why one annotation entry is dropped. */
export type AnnotationProblem = "syntax" | "range" | "overlap";

/** One entry in `annotations={…}` that {@link parseAnnotations} drops. */
export interface AnnotationIssue {
  /** The entry as written, trimmed. */
  readonly entry: string;
  readonly problem: AnnotationProblem;
}

/** What a fence's `annotations={…}` says: usable notes in line order, and the entries dropped. */
export interface AnnotationMeta {
  readonly annotations: readonly CodeAnnotation[];
  readonly issues: readonly AnnotationIssue[];
}

/** The `annotations={…}` meta value, verbatim between the braces. */
const ANNOTATIONS = /(?:^|\s)annotations\s*=\s*\{([^}]*)\}/;

/** One entry's line or range: `4` or `4-5`. */
const LINE = /^(\d+)\s*(?:-\s*(\d+))?$/;

const IDS: Record<AnnotationProblem, string> = {
  syntax: "code.annotation-syntax",
  range: "code.annotation-range",
  overlap: "code.annotation-overlap",
};

const HELP = "Write annotations={2: a note | 4-5: a note}.";

/** Splits on unescaped `|`; `\|` and `\\` become one literal character. */
function entriesOf(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const next = value[i + 1];
    if (char === "\\" && (next === "|" || next === "\\")) {
      current += next;
      i += 1;
    } else if (char === "|") {
      entries.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  entries.push(current);
  return entries;
}

/**
 * Reads a fence meta's `annotations={…}` into notes on 1-based lines of a block of `lines` lines.
 * Entries are dropped, not repaired: a malformed entry or one naming a line outside the block is
 * reported in `issues`, and an entry that covers a line an earlier entry already covers is reported
 * as overlapping. `issues` follows the written order, so a diagnostic built from it is deterministic.
 */
export function parseAnnotations(meta: string, lines: number): AnnotationMeta {
  const found = ANNOTATIONS.exec(meta);
  const value = found?.[1] ?? "";
  if (value.trim() === "") return { annotations: [], issues: [] };

  const annotations: CodeAnnotation[] = [];
  const issues: AnnotationIssue[] = [];

  for (const part of entriesOf(value)) {
    const entry = part.trim();
    const colon = entry.indexOf(":");
    const target = colon === -1 ? "" : entry.slice(0, colon).trim();
    const text = colon === -1 ? "" : entry.slice(colon + 1).trim();
    const match = LINE.exec(target);
    if (colon === -1 || text === "" || text.includes("}") || !match) {
      issues.push({ entry, problem: "syntax" });
      continue;
    }

    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (to < from) {
      issues.push({ entry, problem: "syntax" });
      continue;
    }
    if (from < 1 || to > lines) {
      issues.push({ entry, problem: "range" });
      continue;
    }
    if (annotations.some((other) => from <= other.to && other.from <= to)) {
      issues.push({ entry, problem: "overlap" });
      continue;
    }
    annotations.push({ from, to, text });
  }

  annotations.sort((a, b) => a.from - b.from);
  return { annotations, issues };
}

/** How many lines a fence's value occupies; an empty fence has none. */
function lineCount(value: string): number {
  return value === "" ? 0 : value.split(/\r?\n/).length;
}

/** One sentence naming the entry and, for a range, the block's last line. */
function messageOf(issue: AnnotationIssue, lines: number): string {
  switch (issue.problem) {
    case "syntax":
      return `The annotation "${issue.entry}" is not a line with a note; write <line>: <text> or <start>-<end>: <text>.`;
    case "range":
      return `The annotation "${issue.entry}" is outside the block's ${lines} lines.`;
    case "overlap":
      return `The annotation "${issue.entry}" overlaps another annotation.`;
  }
}

/** Walks the tree in document order. */
function visit(node: Nodes, visitFn: (node: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/** The fence's span in the source file, shifted by the line its Markdown body starts on. */
function posOf(node: Nodes, file: string, bodyLine: number): SourcePos {
  const position = node.position;
  if (position === undefined) return { file, line: bodyLine, column: 1, endLine: bodyLine, endColumn: 1 };
  const delta = bodyLine - 1;
  return spanFromPosition(file, {
    start: { line: position.start.line + delta, column: position.start.column },
    end: { line: position.end.line + delta, column: position.end.column },
  });
}

/**
 * Reports the first bad entry of each fenced code block's `annotations={…}`, in document order, at
 * the fence's source span. `file` is the page's source path, as `Page.source.file` gives it. A block
 * without annotations, or with only valid ones, reports nothing.
 */
export function annotationDiagnostics(tree: Root, file: string, bodyLine = 1): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  visit(tree, (node) => {
    if (node.type !== "code" || !node.meta) return;
    const lines = lineCount(node.value);
    const [issue] = parseAnnotations(node.meta, lines).issues;
    if (issue === undefined) return;
    diagnostics.push({
      id: IDS[issue.problem],
      severity: "warning",
      message: messageOf(issue, lines),
      pos: posOf(node, file, bodyLine),
      help: HELP,
    });
  });
  return diagnostics;
}

export const name = "code-annotations";
export const order = 11;

/** Discovery reads this file; annotations are parsed where the code is rendered. */
export const plugin: Plugin<[], Root> = () => () => {};
