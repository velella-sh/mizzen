/**
 * Converts one VitePress page's front matter to the keys Mizzen reads: `title` and `description` keep their name,
 * `draft: true` becomes `published: false`, and a key with no equivalent stays as a YAML comment at its own line so
 * the page still builds and nothing is lost. A comment keeps the line count too, so a diagnostic later in the body
 * still names the source line it came from.
 */
import type { Diagnostic } from "../../contracts/index.ts";

/** The keys whose meaning carries over unchanged, plus `draft`, which maps onto `published`. */
const KNOWN = new Set(["title", "description", "draft", "published"]);

/** One page's converted text and every setting that needs a person. */
export interface FrontMatterConversion {
  readonly contents: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** The opening and closing `---` lines, when the file has a closed block at the top. */
function blockOf(lines: readonly string[]): { readonly close: number } | undefined {
  const fence = (line: string | undefined): boolean => (line ?? "").replace(/\r$/, "").trim() === "---";
  if (!fence(lines[0])) return undefined;
  for (let index = 1; index < lines.length; index++) {
    if (fence(lines[index])) return { close: index };
  }
  return undefined;
}

/** The top-level key a front matter line declares, if it declares one. */
function keyOf(line: string): string | undefined {
  return /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1];
}

/** A setting with no Mizzen equivalent, at its line in the source file. */
function unknown(key: string, line: number, text: string, file: string): Diagnostic {
  return {
    id: "import.front-matter",
    severity: "warning",
    message: `VitePress front matter \`${key}\` has no Mizzen equivalent; it is kept as a comment for a person to convert.`,
    pos: { file, line, column: 1, endLine: line, endColumn: Math.max(text.length, 1) },
  };
}

/**
 * Converts the front matter of `contents` in place and leaves the body byte for byte. A block that is absent or
 * unclosed is left for the engine to report, so the importer never guesses at half a page.
 */
export function convertFrontMatter(contents: string, file: string): FrontMatterConversion {
  const lines = contents.split("\n");
  const block = blockOf(lines);
  if (block === undefined) return { contents, diagnostics: [] };

  const keys = lines.slice(1, block.close).map(keyOf);
  const hasPublished = keys.includes("published");
  const diagnostics: Diagnostic[] = [];
  const out: string[] = [lines[0]!];
  let unknownKey = false;

  for (let index = 1; index < block.close; index++) {
    const line = lines[index]!;
    const key = keyOf(line);
    if (key !== undefined) unknownKey = !KNOWN.has(key);

    if (key === "draft") {
      const draft = /^(draft\s*:\s*)(true|false)\s*(.*)$/.exec(line.replace(/\r$/, ""));
      if (hasPublished) {
        out.push(`#${line}`);
        diagnostics.push(unknown("draft", index + 1, line, file));
      } else if (draft !== null) {
        out.push(`published: ${draft[2] === "true" ? "false" : "true"}${draft[3] === "" ? "" : ` ${draft[3]}`}${line.endsWith("\r") ? "\r" : ""}`);
      } else {
        out.push(line);
      }
      continue;
    }

    if (unknownKey) {
      out.push(`#${line}`);
      if (key !== undefined) diagnostics.push(unknown(key, index + 1, line, file));
      continue;
    }
    out.push(line);
  }

  out.push(...lines.slice(block.close));
  return { contents: out.join("\n"), diagnostics };
}
