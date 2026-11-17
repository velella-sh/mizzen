/**
 * Custom MDX components in a Docusaurus page: the importer unwraps each one to its Markdown children and reports it
 * once, at the opening tag's exact place, so the page stays readable and the case that needs manual conversion is
 * visible in the report. Nothing here resolves an import, evaluates an expression, or executes a component.
 *
 * A name imported from `@theme/` is Docusaurus's own and is left for the component converter; every other capitalised
 * tag is custom. Tags inside fenced or inline code are examples, not components, and are left alone. A warning never
 * fails the build.
 */
import type { Diagnostic, SourcePos } from "../../contracts/index.ts";

/** A page after its custom components were unwrapped, with one warning per component. */
export interface CustomComponents {
  /** The page's source with each custom opening, closing, and self-closing tag removed; children stay as written. */
  readonly markdown: string;
  /** One `import.component` warning per custom component, in first-use order. */
  readonly diagnostics: readonly Diagnostic[];
}

/** An opening or closing tag found outside code; `end` is exclusive. */
interface Tag {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

/**
 * `import Name from "@theme/…"`.
 *
 * shortcut: only a single-line default import counts, which is how Docusaurus theme components are written; upgrade
 * when a fixture ever splits one across lines or imports a theme component by name.
 */
const THEME_IMPORT = /^[ \t]*import[ \t]+([A-Za-z_$][\w$]*)[ \t]+from[ \t]+["']@theme\/[^"'\n]+["'];?[ \t]*$/gm;

const NAME_START = /[A-Za-z]/;
const NAME_PART = /[\w.:-]/;

/** Offsets covered by a fenced code block or inline code, so a tag there is never taken for a component. */
function codeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  let fence: string | undefined;
  let lineStart = 0;
  for (;;) {
    let lineEnd = source.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = source.length;
    const line = source.slice(lineStart, lineEnd);
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    const match = /^[ \t]*(`{3,}|~{3,})/.exec(text);
    if (fence !== undefined) {
      mask.fill(1, lineStart, lineEnd);
      // a fence of the same character closes the block; a longer marker is a detail this pass does not need
      if (match && match[1]![0] === fence) fence = undefined;
    } else if (match) {
      fence = match[1]![0];
      mask.fill(1, lineStart, lineEnd);
    } else {
      maskInline(text, lineStart, mask);
    }
    if (lineEnd === source.length) return mask;
    lineStart = lineEnd + 1;
  }
}

/** Marks each inline-code span on one line. A span that does not close on that line is left unmasked. */
function maskInline(text: string, offset: number, mask: Uint8Array): void {
  let at = 0;
  while (at < text.length) {
    if (text[at] !== "`") {
      at += 1;
      continue;
    }
    let run = 1;
    while (text[at + run] === "`") run += 1;
    let close = text.indexOf("`", at + run);
    while (close !== -1) {
      let size = 1;
      while (text[close + size] === "`") size += 1;
      if (size === run) break;
      close = text.indexOf("`", close + size);
    }
    if (close === -1) {
      at += run;
      continue;
    }
    mask.fill(1, offset + at, offset + close + run);
    at = close + run;
  }
}

/** The tag at `at`, or `undefined` when the `<` does not start one. `at` is the `<`. */
function tagAt(source: string, at: number): Tag | undefined {
  let cursor = at + 1;
  const closing = source[cursor] === "/";
  if (closing) cursor += 1;
  if (!NAME_START.test(source[cursor] ?? "")) return undefined;
  const nameStart = cursor;
  while (cursor < source.length && NAME_PART.test(source[cursor]!)) cursor += 1;
  const name = source.slice(nameStart, cursor);
  let quote: string | undefined;
  for (; cursor < source.length; cursor += 1) {
    const char = source[cursor]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") {
      const before = source.slice(nameStart + name.length, cursor).trimEnd();
      return { name, start: at, end: cursor + 1, closing, selfClosing: before.endsWith("/") };
    }
  }
  return undefined;
}

/** Every tag on the page that is not inside code, in document order. */
function tagsIn(source: string, mask: Uint8Array): Tag[] {
  const tags: Tag[] = [];
  for (let at = 0; at < source.length; at += 1) {
    if (source[at] !== "<" || mask[at] === 1) continue;
    if (source.startsWith("<!--", at)) {
      const close = source.indexOf("-->", at + 4);
      at = close === -1 ? source.length : close + 2;
      continue;
    }
    const tag = tagAt(source, at);
    if (tag === undefined) continue;
    tags.push(tag);
    at = tag.end - 1;
  }
  return tags;
}

/** The names imported from Docusaurus's own theme, which the component converter owns. */
function themeNames(source: string, mask: Uint8Array): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(THEME_IMPORT)) {
    if (mask[match.index] !== 1) names.add(match[1]!);
  }
  return names;
}

/** The offset where each line starts, so a tag offset maps to a line and a column. */
function lineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** The 1-based line and column of an offset; a column counts code points, so a character is one column. */
function pointAt(source: string, starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: [...source.slice(starts[low]!, offset)].length + 1 };
}

/** A tag's span, with the end inclusive as the contracts require. */
function spanOf(source: string, starts: readonly number[], file: string, tag: Tag): SourcePos {
  const start = pointAt(source, starts, tag.start);
  const end = pointAt(source, starts, tag.end - 1);
  return { file, line: start.line, column: start.column, endLine: end.line, endColumn: end.column };
}

/**
 * Unwraps the custom components of one MDX page: each opening, closing, and self-closing tag is removed, its children
 * stay as Markdown, and the first use of each name adds an `import.component` warning at that opening tag. Names are
 * reported once per page, nested components once each, in document order, so the report is stable across builds.
 */
export function convertCustomComponents(source: string, file: string): CustomComponents {
  const mask = codeMask(source);
  const theme = themeNames(source, mask);
  const tags = tagsIn(source, mask);
  const custom = new Map<string, Tag>();
  for (const tag of tags) {
    if (tag.closing || !/^[A-Z]/.test(tag.name) || theme.has(tag.name) || custom.has(tag.name)) continue;
    custom.set(tag.name, tag);
  }
  if (custom.size === 0) return { markdown: source, diagnostics: [] };

  const starts = lineStarts(source);
  const diagnostics = [...custom].map(([name, tag]): Diagnostic => ({
    id: "import.component",
    severity: "warning",
    message: `Custom MDX component <${name}> needs manual conversion; its content is kept as Markdown.`,
    pos: spanOf(source, starts, file, tag),
    help: `Replace <${name}> with Markdown, or render it from the theme.`,
  }));

  let markdown = "";
  let last = 0;
  for (const tag of tags) {
    if (!custom.has(tag.name)) continue;
    markdown += source.slice(last, tag.start);
    last = tag.end;
  }
  markdown += source.slice(last);
  return { markdown, diagnostics };
}
