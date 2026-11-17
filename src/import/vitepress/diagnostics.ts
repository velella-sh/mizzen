import type { Diagnostic, SourcePos } from "../../contracts/index.ts";

/** A page's Vue syntax removed, its static Markdown kept, and the places that need a person. */
export interface VueConversion {
  /** The source with dynamic Vue syntax removed; every static byte is kept, in source order. */
  readonly markdown: string;
  /** One warning per dynamic construct, in source order. */
  readonly diagnostics: readonly Diagnostic[];
}

/** One range of source text, from its first character to the one after its last. */
type Span = readonly [number, number];

/** A Vue construct, a tag, or a comment; alternation order decides which wins at one offset. */
const VUE =
  /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|\{\{[\s\S]*?\}\}|<\/?[A-Za-z](?:[^<>"']|"[^"]*"|'[^']*')*?>/g;

/** The fence that opens or closes a code block. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The name of an opening or closing tag. */
const TAG_NAME = /^<\/?([A-Za-z][\w.:-]*)/;

/** A Vue attribute on a tag, by the name as written. */
const VUE_ATTR = /(?:^|\s)(:[\w-]+|@[\w.-]+|v-[\w-]+(?::[\w-]+)?|#[\w-]+)/;

/**
 * Converts the Vue logic of one VitePress page to static Markdown (issue #585).
 *
 * A dynamic part needs Vue to produce its text, so it is never evaluated here:
 *
 * - an interpolation `{{ … }}` is removed and leaves the gap it held;
 * - a `<script>` or `<script setup>` block is removed, unread;
 * - an element with a binding (`:prop`, `@event`, `v-if`, `v-for`, `v-html`, `#slot`), a `{{ … }}`
 *   attribute, or a component with no mapping is unwrapped: its tags go, its children stay as Markdown.
 *
 * Each removal is reported once, at its real source position, in source order. Vue syntax inside a code
 * block or a code span is an example, not Vue, and is kept silently. The input is read as text only.
 */
export function reportVue(source: string, file: string): VueConversion {
  const code = codeRanges(source);
  const lineStarts = lineStartOffsets(source);
  const diagnostics: Diagnostic[] = [];
  const removals: Span[] = [];
  /** Names of dynamic elements still open, so their closing tag is unwrapped too. */
  const open: string[] = [];

  for (const match of source.matchAll(VUE)) {
    const played = match[0];
    const start = match.index ?? 0;
    const end = start + played.length;
    if (inside(code, start) || played.startsWith("<!--")) continue;

    if (/^<script\b/i.test(played)) {
      diagnostics.push(
        warning(
          "import.vue-script",
          "Vue script block is not executed; convert its logic by hand.",
          posOf(lineStarts, file, start, end),
        ),
      );
      removals.push(lineRange(source, start, end));
      continue;
    }

    if (played.startsWith("{{")) {
      diagnostics.push(
        warning(
          "import.vue-expression",
          `Vue interpolation ${oneLine(played)} is not evaluated; static text is kept.`,
          posOf(lineStarts, file, start, end),
        ),
      );
      removals.push([start, end]);
      continue;
    }

    const name = TAG_NAME.exec(played)?.[1];
    if (name === undefined) continue;

    if (played.startsWith("</")) {
      const at = open.lastIndexOf(name);
      if (at === -1) continue;
      open.length = at;
      removals.push(lineRange(source, start, end));
      continue;
    }

    const binding = VUE_ATTR.exec(played)?.[1];
    const component = /^[A-Z]/.test(name);
    if (!component && binding === undefined && !played.includes("{{")) continue;

    const id = component ? "import.vue-component" : "import.vue-expression";
    const message = component
      ? `Vue component <${name}> needs manual conversion; static text is kept.`
      : binding !== undefined
        ? `Vue binding ${binding} on <${name}> is not evaluated; static text is kept.`
        : `Vue expression on <${name}> is not evaluated; static text is kept.`;
    diagnostics.push(warning(id, message, posOf(lineStarts, file, start, end)));
    removals.push(lineRange(source, start, end));
    if (!/\/\s*>$/.test(played)) open.push(name);
  }

  return { markdown: withoutRanges(source, removals), diagnostics };
}

/** A warning at `pos`; the importer never fails a build for a page it can still read. */
function warning(id: string, message: string, pos: SourcePos): Diagnostic {
  return { id, severity: "warning", message, pos };
}

/** Collapses whitespace so a multi-line expression stays one line in the report. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Every offset where a line starts, the first one included. */
function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let at = 0; at < source.length; at++) {
    if (source.charCodeAt(at) === 10) starts.push(at + 1);
  }
  return starts;
}

/** The 1-based source position of the inclusive span `[start, end)`. */
function posOf(lineStarts: readonly number[], file: string, start: number, end: number): SourcePos {
  const first = lineIndex(lineStarts, start);
  const last = lineIndex(lineStarts, end - 1);
  return {
    file,
    line: first + 1,
    column: start - (lineStarts[first] ?? 0) + 1,
    endLine: last + 1,
    endColumn: end - 1 - (lineStarts[last] ?? 0) + 1,
  };
}

/** The zero-based index of the line that holds `offset`. */
function lineIndex(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Drops a tag's whole line too when nothing else sits on it, so unwrapping leaves no blank line. */
function lineRange(source: string, start: number, end: number): Span {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const newline = source.indexOf("\n", end);
  const lineEnd = newline === -1 ? source.length : newline + 1;
  const before = source.slice(lineStart, start);
  const after = source.slice(end, newline === -1 ? source.length : newline);
  return before.trim() === "" && after.trim() === "" ? [lineStart, lineEnd] : [start, end];
}

/** Removes every range; ranges arrive in source order and do not overlap. */
function withoutRanges(source: string, ranges: readonly Span[]): string {
  let out = "";
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    out += source.slice(at, start);
    at = end;
  }
  return out + source.slice(at);
}

/** Whether `offset` sits inside one of `ranges`. */
function inside(ranges: readonly Span[], offset: number): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/** Fenced blocks and inline code spans, where Vue syntax is an example, not a dynamic part. */
function codeRanges(source: string): Span[] {
  const ranges: Span[] = [];
  let fence: { readonly char: string; readonly length: number; readonly start: number } | undefined;
  let offset = 0;

  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const lineEnd = newline === -1 ? source.length : newline;
    const run = FENCE.exec(source.slice(offset, lineEnd))?.[1];
    if (fence !== undefined) {
      if (run !== undefined && run.charAt(0) === fence.char && run.length >= fence.length) {
        ranges.push([fence.start, newline === -1 ? source.length : newline + 1]);
        fence = undefined;
      }
    } else if (run !== undefined) {
      fence = { char: run.charAt(0), length: run.length, start: offset };
    }
    if (newline === -1) break;
    offset = newline + 1;
  }
  if (fence !== undefined) ranges.push([fence.start, source.length]);

  const spans: Span[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    inlineCode(source, from, start, spans);
    from = end;
  }
  inlineCode(source, from, source.length, spans);
  ranges.push(...spans);
  return ranges;
}

/** Collects inline code spans in `[from, to)` by pairing backtick runs of equal length. */
function inlineCode(source: string, from: number, to: number, into: Span[]): void {
  let at = from;
  while (at < to) {
    const open = source.indexOf("`", at);
    if (open === -1 || open >= to) return;
    let length = 1;
    while (source.charAt(open + length) === "`") length++;
    const close = closingRun(source, open + length, to, length);
    if (close === -1) {
      at = open + length;
      continue;
    }
    into.push([open, close + length]);
    at = close + length;
  }
}

/** The start of the next backtick run of exactly `length` before `to`. */
function closingRun(source: string, from: number, to: number, length: number): number {
  let at = from;
  while (at < to) {
    const next = source.indexOf("`", at);
    if (next === -1 || next >= to) return -1;
    let run = 1;
    while (source.charAt(next + run) === "`") run++;
    if (run === length) return next;
    at = next + run;
  }
  return -1;
}
