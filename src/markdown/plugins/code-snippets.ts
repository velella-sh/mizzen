/**
 * Renders lines already read by `readSourceRange` as a fenced code block whose language comes from the source
 * file's extension or an explicit choice. The block's `data-src` names the real file and range, so a reader goes
 * from the rendered code to `example.ts:2`, while `data.snippet` carries the same map plus the insertion point.
 *
 * Reading needs the site root, which the Markdown stage does not have, so a caller with the root reads the lines
 * first, exactly as `::include` expands before Markdown. The `plugin` export exists because every file in this
 * folder is discovered as a Markdown plugin; it has no work of its own.
 */
import { extname } from "node:path";
import type { Code, Root } from "mdast";
import type { Plugin } from "unified";
import type { Position } from "unist";
import type { SourcePos } from "../../contracts/index.ts";
import type { SourceSnippet } from "../../content/code-snippets/read.ts";
import { formatSpan } from "../../source/spans.ts";
import { parseCodeMeta } from "./code.ts";

export const name = "code-snippets";
export const order = 12;

/** Discovery reads this file; snippets are read and rendered where the source folder is known. */
export const plugin: Plugin<[], Root> = () => () => {};

/** Fence languages for the extensions a docs site usually snippets. An unknown extension gives `""`. */
const LANGUAGES: Readonly<Record<string, string>> = {
  ".astro": "astro",
  ".bash": "bash",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".cts": "ts",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".js": "js",
  ".json": "json",
  ".jsx": "jsx",
  ".kt": "kotlin",
  ".md": "md",
  ".markdown": "md",
  ".mjs": "js",
  ".mts": "ts",
  ".php": "php",
  ".py": "py",
  ".rb": "rb",
  ".rs": "rust",
  ".scss": "scss",
  ".sh": "bash",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "ts",
  ".tsx": "tsx",
  ".vue": "vue",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zsh": "bash",
};

/** The fence language for a source path: its extension, or `""` when the extension is not one in the table. */
export function langFromPath(path: string): string {
  return LANGUAGES[extname(path).toLowerCase()] ?? "";
}

/** Where a rendered snippet came from. */
export interface SnippetSourceMap {
  /** The real source file, relative to the source folder, `/`-separated. */
  readonly file: string;
  /** 1-based line of the first line in the block. */
  readonly start: number;
  /** 1-based line of the last line in the block, `start - 1` when the block is empty. */
  readonly end: number;
  /** The 1-based source line of each rendered line, top to bottom. */
  readonly lines: readonly number[];
  /** The directive's span in the page, kept apart from the code's own source. */
  readonly insertion?: SourcePos;
}

/** What {@link renderSnippet} needs. */
export interface RenderSnippetOptions {
  /** The lines a reader returned. */
  readonly snippet: SourceSnippet;
  /** The fence language; the file's extension decides when it is absent. */
  readonly lang?: string;
  /** The insertion directive's span, for a caller that wants to point back at the page. */
  readonly pos?: SourcePos;
}

/** The block and the map to its source. */
export interface RenderedSnippet {
  readonly node: Code;
  readonly sourceMap: SnippetSourceMap;
}

/** The line without its terminator: the code value and the map count bytes, not endings. */
const LINE_END = /\r?\n$/;

/** The snippet's lines, each without its ending; an empty snippet has none. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  return text.split(/(?<=\n)/).map((line) => line.replace(LINE_END, ""));
}

/** Remark's span for a node, whose end is exclusive: one column past the last character. */
function positionOf(pos: SourcePos): Position {
  return {
    start: { line: pos.line, column: pos.column },
    end: { line: pos.endLine, column: pos.endColumn + 1 },
  };
}

/**
 * One code block for a snippet's lines, with the language the extension gives them when the caller names none, and
 * a source map to the real file and lines. The node keeps the insertion point's position, so a later stage still
 * knows where the directive was, but its `data-src` names the source file rather than the page.
 */
export function renderSnippet(options: RenderSnippetOptions): RenderedSnippet {
  const { snippet } = options;
  const lines = linesOf(snippet.text);
  const last = lines[lines.length - 1] ?? "";
  const end = lines.length === 0 ? snippet.start - 1 : snippet.start + lines.length - 1;
  const sourceMap: SnippetSourceMap = {
    file: snippet.file,
    start: snippet.start,
    end,
    lines: lines.map((_, index) => snippet.start + index),
    ...(options.pos === undefined ? {} : { insertion: options.pos }),
  };
  const span = {
    file: snippet.file,
    line: snippet.start,
    column: 1,
    endLine: Math.max(snippet.start, end),
    endColumn: Math.max(1, last.length),
  };

  const node: Code = {
    type: "code",
    value: lines.join("\n"),
    lang: options.lang ?? langFromPath(snippet.file),
    ...(options.pos === undefined ? {} : { position: positionOf(options.pos) }),
  };
  const data = {
    code: parseCodeMeta(""),
    snippet: sourceMap,
    hProperties: { "data-src": formatSpan(span) },
  };
  node.data = data;
  return { node, sourceMap };
}
