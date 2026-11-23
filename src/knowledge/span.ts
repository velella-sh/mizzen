/**
 * Finds the source span of one top-level front matter key, so a diagnostic about a key's value points at the key
 * itself rather than the whole file. The search is literal and line-based: front matter is a `---` fenced block at
 * the top of the file, and a key is a line that starts with it at column 1.
 */
import type { SourcePos } from "../contracts/source.ts";

/** The line range of a key's value inside the front matter, or `undefined` when the key is not a top-level key. */
export function frontMatterKeySpan(source: string, file: string, key: string): SourcePos | undefined {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  let close = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === "---") {
      close = index;
      break;
    }
  }
  if (close === -1) return undefined;

  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:`);
  for (let index = 1; index < close; index++) {
    const line = lines[index]!;
    if (!pattern.test(line)) continue;
    // The span is the whole key block: from the key's line to the last indented line under it, so a diagnostic
    // covers every line of a nested declaration rather than only the key.
    let end = index;
    for (let next = index + 1; next < close; next++) {
      const candidate = lines[next]!;
      if (candidate.trim() === "") continue;
      if (!/^\s/.test(candidate)) break;
      end = next;
    }
    return {
      file,
      line: index + 1,
      column: 1,
      endLine: end + 1,
      endColumn: Math.max(1, lines[end]!.length),
    };
  }
  return undefined;
}

/** Escapes a string for a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
