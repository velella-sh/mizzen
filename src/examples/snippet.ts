/**
 * Reads the snippet an example block imports from a file (#1332).
 *
 * An executable block may carry its code inline, or name a file with `snippet="lib/math.ts:2-10"`. The snippet is read
 * through the same `readSourceRange` the `::include` directive uses, so it is subject to the same source-folder boundary
 * and produces the same diagnostics. Its evidence records the file, the range, and the language the extension gives it,
 * and the hash of the block bytes covers the snippet text, so editing the source invalidates the recorded evidence
 * through the same mechanism a changed fence uses.
 *
 * The read is total: a missing file, an invalid range, or a path outside the source folder is a finding at the fence,
 * never an exception.
 */
import type { Diagnostic } from "../contracts/diagnostic.ts";
import { readSourceRange } from "../content/code-snippets/read.ts";
import { langFromPath } from "../markdown/plugins/code-snippets.ts";
import type { MarkdownExample } from "../markdown/plugins/example-fence.ts";
import type { ExampleSnippet } from "./syntax.ts";

/** One snippet a block reads: its text and the language the file's extension gives it. */
export interface LoadedSnippet {
  /** The block's code: the snippet's lines, joined with LF. */
  readonly code: string;
  /** The language the file's extension names, or `""` when the extension is not known. */
  readonly lang: string;
  /** The file, relative to the source folder, `/`-separated. */
  readonly file: string;
  /** 1-based line of the first line the block holds. */
  readonly start: number;
  /** 1-based line of the last line the block holds, inclusive. */
  readonly end: number;
}

/** The stable id of the finding that reports an unreadable snippet. */
export const EXAMPLE_SNIPPET_ID = "example-snippet";

/** Reads the snippet `snippet` names, at the block's fence, or reports one finding and returns no snippet. */
export async function loadSnippet(options: {
  readonly snippet: ExampleSnippet;
  readonly sourceDir: string;
  readonly example: MarkdownExample;
  readonly file: string;
}): Promise<{ snippet?: LoadedSnippet; diagnostics: readonly Diagnostic[] }> {
  const { example, file } = options;
  const pos = { file, line: example.pos.line, column: example.pos.column, endLine: example.pos.endLine, endColumn: example.pos.endColumn };
  const read = await readSourceRange({
    sourceDir: options.sourceDir,
    path: options.snippet.file,
    ...(options.snippet.lines === undefined ? {} : { lines: options.snippet.lines }),
    pos,
  });
  if (read.snippet === undefined) {
    // Re-key the snippet reader's findings so a caller can tell them from an include's.
    return {
      diagnostics: read.diagnostics.map((finding) => ({ ...finding, id: EXAMPLE_SNIPPET_ID, message: `${example.id}: ${finding.message}` })),
    };
  }
  const text = read.snippet.text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return {
    snippet: {
      code: text,
      lang: langFromPath(read.snippet.file),
      file: read.snippet.file,
      start: read.snippet.start,
      end: read.snippet.end,
    },
    diagnostics: [],
  };
}
