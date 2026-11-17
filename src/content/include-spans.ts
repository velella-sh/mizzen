import type { SourcePos } from "../contracts/index.ts";

/**
 * Source spans of an expanded body. A body with includes is text from more than one file, and a splice moves every
 * line after it, so a position in the expanded body no longer names the page. Every copied line and every substituted
 * value records where it came from, and a Markdown node's span is looked up here before it becomes `data-src`, a
 * heading, or a source-map section.
 *
 * Positions are 1-based like the rest of the engine, and a span's end is inclusive. A run never crosses a line.
 */

/** Where one run of an expanded body came from. */
export interface IncludeSpan {
  /** 1-based line of the run's first character in the expanded body. */
  readonly line: number;
  /** 1-based column of the run's first character in the expanded body. */
  readonly column: number;
  /** 1-based line of the run's last character in the expanded body. */
  readonly endLine: number;
  /** Column of the run's last character in the expanded body. */
  readonly endColumn: number;
  /** The file that holds the run's text, relative to the source folder, `/`-separated. */
  readonly file: string;
  /** 1-based line of the run's first character in `file`. */
  readonly sourceLine: number;
  /** 1-based column of the run's first character in `file`. */
  readonly sourceColumn: number;
  /** Characters the run covers in `file`: its own length when the text was copied unchanged, else the placeholder's. */
  readonly sourceLength: number;
  /** True when the run is a parameter value, whose origin is the whole placeholder it replaced. */
  readonly substituted: boolean;
}

/** A run before the expanded body is assembled: `at` is a 0-based offset in that body. */
export interface SpanDraft {
  readonly at: number;
  readonly length: number;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly sourceLength: number;
  readonly substituted: boolean;
}

/** A point in a body or file, 1-based; the end of a span is exclusive, as Markdown parsers report it. */
export interface SpanPoint {
  readonly line: number;
  readonly column: number;
}

/** One run of `text`, which must not contain a newline; an empty run has no span. */
export function spanDraft(
  at: number,
  text: string,
  file: string,
  line: number,
  column = 1,
  sourceLength = text.length,
  substituted = false,
): SpanDraft | undefined {
  if (text === "") return undefined;
  return { at, length: text.length, file, line, column, sourceLength, substituted };
}

/** Rebased drafts, for text inserted at the end of what came before. */
export function shiftDrafts(drafts: readonly SpanDraft[], by: number): readonly SpanDraft[] {
  return by === 0 ? drafts : drafts.map((draft) => ({ ...draft, at: draft.at + by }));
}

/**
 * The spans of a body from its drafts. `bodyLine` is the 1-based line where the body starts in its file, so the
 * spans land in file coordinates like the Markdown nodes they map.
 */
export function finalizeSpans(
  drafts: readonly SpanDraft[],
  body: string,
  bodyLine: number,
): readonly IncludeSpan[] {
  const spans: IncludeSpan[] = [];
  let offset = 0;
  let line = bodyLine;
  let column = 1;
  for (const draft of drafts) {
    while (offset < draft.at) {
      if (body[offset] === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      offset += 1;
    }
    spans.push({
      line,
      column,
      endLine: line,
      endColumn: column + draft.length - 1,
      file: draft.file,
      sourceLine: draft.line,
      sourceColumn: draft.column,
      sourceLength: draft.sourceLength,
      substituted: draft.substituted,
    });
  }
  return spans;
}

/** The source point of output character `column` inside `span`; a value's origin is its whole placeholder. */
function sourcePointAt(span: IncludeSpan, column: number, end: boolean): SpanPoint {
  if (span.substituted) {
    return {
      line: span.sourceLine,
      column: end ? span.sourceColumn + span.sourceLength - 1 : span.sourceColumn,
    };
  }
  return { line: span.sourceLine, column: span.sourceColumn + Math.min(column, span.endColumn) - span.column };
}

/** The source point of a span's last character. */
function sourceEndOf(span: IncludeSpan): SpanPoint {
  return span.substituted
    ? { line: span.sourceLine, column: span.sourceColumn + span.sourceLength - 1 }
    : { line: span.sourceLine, column: span.sourceColumn + span.endColumn - span.column };
}

/**
 * The source span of a node whose position is `start` to `end` (exclusive) in the expanded body. The file is the one
 * that holds the first character: a node that ends in another file ends at the last character that file holds, so the
 * span stays inside one file. `undefined` when the start is not covered.
 */
export function sourceSpanOf(
  spans: readonly IncludeSpan[],
  start: SpanPoint,
  end: SpanPoint,
): SourcePos | undefined {
  const index = spans.findIndex(
    (span) => span.line === start.line && start.column >= span.column && start.column <= span.endColumn,
  );
  if (index === -1) return undefined;
  const first = spans[index]!;
  const source = sourcePointAt(first, start.column, false);
  let last = source;
  for (let i = index; i < spans.length; i++) {
    const span = spans[i]!;
    if (span.line > end.line || (span.line === end.line && span.column >= end.column)) break;
    if (span.file !== first.file) continue;
    const endsHere = span.line === end.line && end.column > span.column && end.column <= span.endColumn + 1;
    last = endsHere ? sourcePointAt(span, end.column - 1, true) : sourceEndOf(span);
  }
  return { file: first.file, line: source.line, column: source.column, endLine: last.line, endColumn: last.column };
}
