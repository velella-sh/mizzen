import type { Diagnostic } from "../../contracts/index.ts";

/** The content of one imported Starlight page and what the import could not map. */
export interface StarlightImport {
  /** Markdown body: supported components become content and unknown ones are unwrapped. */
  readonly body: string;
  /** One warning per unknown component, at its opening tag. */
  readonly diagnostics: readonly Diagnostic[];
}

const MDX_IMPORT = /^import\s/;
const MDX_TAG = /^<([A-Z][\w.]*)((?:\s[^>]*?)?)\s*(\/?)>\s*$/;
const MDX_CLOSE = /^<\/([A-Z][\w.]*)>\s*$/;
const MARKDOC_TAG = /^\{%\s*(\/?)\s*([A-Za-z][\w.-]*)([\s\S]*?)%\}\s*$/;

const STEPS = "steps";
const FILE_TREE = "filetree";
const LINK_CARD = "linkcard";

/** Read a quoted attribute, such as `href="/guides/"`, from a component or tag. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match?.[1] ?? match?.[2];
}

/** `[title](href)` and, when set, an em dash with the description. */
function linkCard(tag: string): string {
  const title = attribute(tag, "title") ?? "";
  const href = attribute(tag, "href") ?? "";
  const description = attribute(tag, "description");
  const link = `[${title}](${href})`;
  return description ? `${link} — ${description}` : link;
}

/** A FileTree list becomes one `text` fence, two spaces per nesting level, markers removed. */
function fileTree(inner: readonly string[]): readonly string[] {
  const entries: string[] = [];
  for (const line of inner) {
    const match = /^(\s*)[-*+]\s+(.*\S)\s*$/.exec(line);
    if (match) entries.push(`${"  ".repeat(Math.floor(match[1]!.length / 2))}${match[2]!}`);
  }
  return ["```text", ...entries, "```"];
}

/** Drop the blank lines around a component's children, keeping their own content intact. */
function innerLines(lines: readonly string[], start: number, end: number): readonly string[] {
  let first = start;
  let last = end;
  while (first < last && lines[first]!.trim() === "") first++;
  while (last > first && lines[last - 1]!.trim() === "") last--;
  return lines.slice(first, last);
}

/** One blank line between blocks and exactly one final newline, without touching code fences. */
function finish(lines: readonly string[]): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const blank = line.trim() === "";
    if (!fenced && blank && (out.length === 0 || out[out.length - 1]!.trim() === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/**
 * Convert one Starlight page body (front matter already split off) to Markdown.
 * `bodyLine` is the 1-based line where the body starts, so diagnostics point into the file.
 */
export function convertStarlight(body: string, file: string, bodyLine = 1): StarlightImport {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  const diagnostics: Diagnostic[] = [];

  const warn = (name: string, index: number): void => {
    const line = bodyLine + index;
    const text = lines[index]!;
    diagnostics.push({
      id: "import-starlight.unknown-component",
      severity: "warning",
      message: `Unknown Starlight component \`${name}\`; its content is kept as Markdown.`,
      pos: {
        file,
        line,
        column: text.length - text.trimStart().length + 1,
        endLine: line,
        endColumn: Math.max(text.length, 1),
      },
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (MDX_IMPORT.test(line) || MDX_CLOSE.test(line)) continue;

    const mdx = MDX_TAG.exec(line);
    if (mdx) {
      const name = mdx[1]!;
      const rest = mdx[2] ?? "";
      if (name === "LinkCard") {
        out.push(linkCard(rest));
        continue;
      }
      if (name !== "Steps" && name !== "FileTree") {
        warn(name, i);
        if (mdx[3] !== "/") {
          const close = findClose(lines, i + 1, (candidate) => MDX_CLOSE.exec(candidate)?.[1] === name);
          if (close !== -1) {
            out.push(...innerLines(lines, i + 1, close));
            i = close;
          }
        }
        continue;
      }
      const close = findClose(
        lines,
        i + 1,
        (candidate) => MDX_CLOSE.exec(candidate)?.[1] === name,
      );
      if (close !== -1) {
        const inner = innerLines(lines, i + 1, close);
        out.push(...(name === "FileTree" ? fileTree(inner) : inner));
        i = close;
      }
      continue;
    }

    const markdoc = MARKDOC_TAG.exec(line);
    if (markdoc) {
      const selfClosing = markdoc[1] === "" && /\/\s*$/.test(markdoc[3]!);
      const closing = markdoc[1] === "/";
      const name = markdoc[2]!;
      if (selfClosing && name === LINK_CARD) {
        out.push(linkCard(markdoc[3]!));
        continue;
      }
      if (closing) continue;
      if (name === STEPS || name === FILE_TREE) {
        const close = findClose(
          lines,
          i + 1,
          (candidate) => {
            const end = MARKDOC_TAG.exec(candidate);
            return end?.[1] === "/" && end[2] === name;
          },
        );
        if (close !== -1) {
          const inner = innerLines(lines, i + 1, close);
          out.push(...(name === FILE_TREE ? fileTree(inner) : inner));
          i = close;
        }
        continue;
      }
      warn(name, i);
      const close = findClose(
        lines,
        i + 1,
        (candidate) => {
          const end = MARKDOC_TAG.exec(candidate);
          return end?.[1] === "/" && end[2] === name;
        },
      );
      if (close !== -1) {
        out.push(...innerLines(lines, i + 1, close));
        i = close;
      }
      continue;
    }

    out.push(line);
  }

  return { body: finish(out), diagnostics };
}

/** Index of the line that closes the component opened before `start`, or -1. */
function findClose(
  lines: readonly string[],
  start: number,
  isClose: (line: string) => boolean,
): number {
  for (let i = start; i < lines.length; i++) {
    if (isClose(lines[i]!)) return i;
  }
  return -1;
}
