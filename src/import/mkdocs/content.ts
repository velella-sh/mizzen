/**
 * Converts the MkDocs and Material Markdown that has an exact Mizzen equivalent, before anything else reads the page:
 *
 *   !!! note "Title"      →  :::note{title="Title"}
 *       body                 body
 *                            :::
 *   ???+ tip "Title"      →  :::tip{title="Title" collapsible open}
 *   === "macOS"           →  :::::tabs / :::tab{label="macOS"} … :::::
 *   --8<-- "snippets/x.md" →  ::include[snippets/x.md]
 *
 * The conversion is textual, like the other importers': an admonition body moves out of its four-space indent so its
 * lists and fences stay Markdown, and a tab body does the same. Nested admonitions and tabs are converted too. Code
 * fences are examples, not syntax, and are left alone.
 *
 * A snippet path that is not a source file, or a named fragment that `::include` cannot address, leaves the line as it
 * is and reports a warning at its line. Every converted block is recorded for the accuracy report.
 */
import { posix } from "node:path";
import type { Diagnostic, SourcePos } from "../../contracts/index.ts";
import type { ImportBlock, ImportedPage } from "../contract.ts";

/** What one page's conversion produced. */
export interface MkdocsPage extends ImportedPage {
  readonly blocks: readonly ImportBlock[];
  readonly diagnostics: readonly Diagnostic[];
}

/** The source facts a conversion needs to resolve an include. */
export interface MkdocsPageOptions {
  /** The docs folder from `mkdocs.yml`, relative to the source root and without a trailing slash. */
  readonly docsDir: string;
  /** Every regular file under the source root. */
  readonly files: readonly string[];
}

/** One source line with its 1-based number, so a nested body still reports its real position. */
interface Line {
  readonly text: string;
  readonly line: number;
}

/** A fence that opens or closes a code block; its body is never read as MkDocs syntax. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** `!!! note`, `??? note`, or `???+ note`, with an optional quoted or bare title. */
const ADMONITION = /^([ \t]*)(!{3,}|\?{3,}\+?)[ \t]+([\w.-]+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|(.*?)))?[ \t]*$/;
/** `=== "Label"` or `=== Label`. */
const TAB = /^([ \t]*)={3,}[ \t]+(?:"([^"]*)"|'([^']*)'|(.*?))[ \t]*$/;
/** `--8<-- "path"`, `--8<-- "path:1:3"`, or `--8<-- "path:fragment"`. */
const SNIPPET = /^([ \t]*)--8<--[ \t]+(?:"([^"]+)"|'([^']*)')[ \t]*$/;

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

/** A source-relative path with `.` and `..` resolved, or `undefined` when it leaves the root. */
function normalized(path: string): string | undefined {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

/** The body without the indentation its least-indented line carries, with blank lines at both ends trimmed. */
function dedent(lines: readonly Line[]): Line[] {
  const body = [...lines];
  while (body[0]?.text.trim() === "") body.shift();
  while (body[body.length - 1]?.text.trim() === "") body.pop();
  const widths = body.filter((line) => line.text.trim() !== "").map((line) => indentOf(line.text));
  const cut = widths.length === 0 ? 0 : Math.min(...widths);
  return body.map((line) => ({ text: line.text.slice(cut), line: line.line }));
}

/** The body of the container at `start`, from `start + 1` to the first non-blank line indented no deeper. */
function bodyOf(lines: readonly Line[], start: number, indent: number): { body: Line[]; next: number } {
  let end = start + 1;
  while (end < lines.length) {
    const text = lines[end]?.text ?? "";
    if (text.trim() !== "" && indentOf(text) <= indent) break;
    end += 1;
  }
  return { body: dedent(lines.slice(start + 1, end)), next: end };
}

/** A directive attribute value: quoted, with backslashes and quotes escaped. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** An attribute list for the attributes that are present, or `""` when there are none. */
function attributes(entries: readonly (readonly [string, string | true])[]): string {
  const kept = entries.map(([name, value]) => (value === true ? name : `${name}=${quoted(value)}`));
  return kept.length === 0 ? "" : `{${kept.join(" ")}}`;
}

/** A warning at one source line; the import never fails for a page it can still read. */
function warning(id: string, message: string, file: string, line: number): Diagnostic {
  const pos: SourcePos = { file, line, column: 1, endLine: line, endColumn: 1 };
  return { id, severity: "warning", message, pos };
}

/** The include path from a page's destination to a snippet's destination. */
function includePathOf(destination: string, snippet: string, docsDir: string): string {
  const target = snippet.startsWith(`${docsDir}/`) ? snippet.slice(docsDir.length + 1) : snippet;
  return posix.relative(posix.dirname(destination), target) || target;
}

/** Where a snippet path lands in the source, trying the page's folder, then `docs_dir`, then the project root. */
function snippetFileOf(source: string, docsDir: string, files: ReadonlySet<string>, path: string): string | undefined {
  const candidates = [
    normalized(`${posix.dirname(source)}/${path}`),
    normalized(`${docsDir}/${path}`),
    normalized(path),
  ];
  return candidates.find((candidate) => candidate !== undefined && files.has(candidate));
}

/** A snippet directive as the converted line, or the diagnostic that keeps the line unchanged. */
function snippetOf(
  raw: string,
  line: Line,
  source: string,
  destination: string,
  docsDir: string,
  files: ReadonlySet<string>,
): { text: string; block: ImportBlock } | { diagnostic: Diagnostic } {
  const parts = raw.split(":");
  const path = parts[0] ?? "";
  const range = parts.length === 3 && parts[1] !== undefined && parts[2] !== undefined && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])
    ? [Number(parts[1]), Number(parts[2])]
    : undefined;
  const file = snippetFileOf(source, docsDir, files, path);
  if (file === undefined) {
    return {
      diagnostic: warning(
        "import.snippet-missing",
        `snippet \`${raw}\` names no file in the source; include the content by hand.`,
        source,
        line.line,
      ),
    };
  }
  if (parts.length > 1 && range === undefined) {
    return {
      diagnostic: warning(
        "import.snippet-fragment",
        `snippet \`${raw}\` selects a named fragment, which \`::include\` cannot address; convert it to a line range.`,
        source,
        line.line,
      ),
    };
  }
  const include = includePathOf(destination, file, docsDir);
  const target = include.includes("]") ? `::include{path=${quoted(include)}}` : `::include[${include}]`;
  const text = `${target}${range === undefined ? "" : `{lines=${range[0]}-${range[1]}}`}`;
  return { text, block: { line: line.line, status: "full" } };
}

/** Converts one page. `source` and `destination` are source-relative paths; `file` names the page in diagnostics. */
export function convertPage(
  markdown: string,
  source: string,
  destination: string,
  options: MkdocsPageOptions,
): MkdocsPage {
  const files = new Set(options.files);
  const blocks: ImportBlock[] = [];
  const diagnostics: Diagnostic[] = [];
  const lines: Line[] = markdown.split(/\r?\n/).map((text, index) => ({ text, line: index + 1 }));

  const convert = (body: readonly Line[]): string[] => {
    const out: string[] = [];
    let fence = "";
    for (let index = 0; index < body.length; index += 1) {
      const line = body[index] ?? { text: "", line: 1 };
      const text = line.text;

      const marker = FENCE.exec(text)?.[1];
      if (fence !== "") {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = "";
        out.push(text);
        continue;
      }
      if (marker !== undefined) {
        fence = marker;
        out.push(text);
        continue;
      }

      const snippet = SNIPPET.exec(text);
      if (snippet !== null) {
        const converted = snippetOf(
          snippet[2] ?? snippet[3] ?? "",
          line,
          source,
          destination,
          options.docsDir,
          files,
        );
        if ("diagnostic" in converted) diagnostics.push(converted.diagnostic);
        else blocks.push(converted.block);
        out.push("diagnostic" in converted ? text : `${snippet[1] ?? ""}${converted.text}`);
        continue;
      }

      const admonition = ADMONITION.exec(text);
      if (admonition !== null) {
        const indent = (admonition[1] ?? "").length;
        const state = admonition[2] ?? "";
        const type = admonition[3] ?? "note";
        const title = (admonition[4] ?? admonition[5] ?? admonition[6] ?? "").trim();
        const collapsible = state.startsWith("?");
        const { body: inner, next } = bodyOf(body, index, indent);
        const props: [string, string | true][] = [];
        if (title !== "") props.push(["title", title]);
        if (collapsible) {
          props.push(["collapsible", true]);
          if (state.includes("+")) props.push(["open", true]);
        }
        out.push(`${admonition[1] ?? ""}:::${type}${attributes(props)}`);
        out.push(...convert(inner));
        out.push(`${admonition[1] ?? ""}:::`);
        if ((body[next]?.text.trim() ?? "") !== "") out.push("");
        blocks.push({ line: line.line, status: "full" });
        index = next - 1;
        continue;
      }

      const tab = TAB.exec(text);
      if (tab !== null) {
        const indent = (tab[1] ?? "").length;
        const tabs: { label: string; body: Line[] }[] = [];
        let cursor = index;
        while (cursor < body.length) {
          const header = TAB.exec(body[cursor]?.text ?? "");
          if (header === null || (header[1] ?? "").length !== indent) break;
          const { body: inner, next } = bodyOf(body, cursor, indent);
          tabs.push({ label: (header[2] ?? header[3] ?? header[4] ?? "").trim(), body: inner });
          cursor = next;
          while (body[cursor]?.text.trim() === "") cursor += 1;
        }
        const prefix = tab[1] ?? "";
        out.push(`${prefix}:::::tabs`);
        for (const entry of tabs) {
          out.push(`${prefix}:::tab${entry.label === "" ? "" : attributes([["label", entry.label]])}`);
          out.push(...convert(entry.body).map((converted) => `${prefix}${converted}`));
          out.push(`${prefix}:::`);
        }
        out.push(`${prefix}:::::`);
        if ((body[cursor]?.text.trim() ?? "") !== "") out.push("");
        blocks.push({ line: line.line, status: "full" });
        index = cursor - 1;
        continue;
      }

      out.push(text);
    }
    return out;
  };

  const contents = convert(lines).join("\n");
  return {
    source,
    destination,
    contents: markdown.endsWith("\n") && !contents.endsWith("\n") ? `${contents}\n` : contents,
    blocks,
    diagnostics,
  };
}
