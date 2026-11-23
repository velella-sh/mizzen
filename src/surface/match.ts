/**
 * Match the public surface to documentation references (#1343): reads each documentation page's links, inline-code
 * references, code references, and directives, resolves them to surface items, and states for each item whether it is
 * `complete`, `partial`, or `missing`.
 *
 * The rules are fixed so a reader can predict them:
 *
 * - **strong** evidence is a link whose text or target anchors the item's name (or id), inline code whose text equals
 *   the item's name (a command may be written `mizzen <name>`, a flag `--flag`), a directive that names a data field,
 *   or a `file:line` code reference that points at the item's declaration line;
 * - **weak** evidence is a heading that names the item, without the item being linked or written as code.
 *
 * `complete` means at least one strong reference; `partial` means only weak references; `missing` means none. Excluded
 * items are matched nowhere and left out of the gaps.
 */
import { posix } from "node:path";
import type { Page } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { SourcePos } from "../contracts/source.ts";
import type {
  SurfaceEvidence,
  SurfaceItem,
  SurfaceMatch,
  SurfaceDocState,
} from "../contracts/surface.ts";
import { codeRefsIn, type CodeRef } from "../drift/code-refs.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { byCodePoint } from "./contract.ts";
import type { Nodes, Root } from "mdast";

/** What matching needs. */
export interface MatchOptions {
  /** The documentation pages, already filtered to the configured folders. */
  readonly pages: readonly Page[];
  /** The items to match. */
  readonly items: readonly SurfaceItem[];
}

/** One reference read from a page, with its span. */
interface Reference {
  readonly kind: "link" | "code-reference" | "directive" | "heading";
  /** The text a reference names: a link's text, an inline code's value, a directive's field, or a heading's text. */
  readonly text: string;
  /** For a link, the URL it points at. */
  readonly href?: string;
  /** For a `file:line` code reference, the file and line. */
  readonly file?: string;
  readonly line?: number;
  readonly pos: SourcePos;
}

/** The document extensions a documentation page may have; an HTML page holds no Markdown references. */
const MARKDOWN_FILE = /\.(?:md|markdown)$/i;

/** The text of a Markdown node's children. */
function textOf(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node) return node.children.map(textOf).join("");
  return "";
}

/** The span of a Markdown node, or undefined when it has no position. */
function posOf(node: Nodes, file: string): SourcePos | undefined {
  if (node.position === undefined) return undefined;
  return {
    file,
    line: node.position.start.line,
    column: node.position.start.column,
    endLine: node.position.end.line,
    endColumn: Math.max(1, node.position.end.column - 1),
  };
}

/** The directives a page writes: `:field[...]`, `:::each{field=...}`, and the include form. */
function directiveText(node: Nodes): string | undefined {
  if (node.type === "containerDirective" || node.type === "leafDirective" || node.type === "textDirective") {
    const attributes = (node as { attributes?: Record<string, string | null | undefined> }).attributes;
    // A directive's argument is its child text, as in `:field[name]`; its label is the `{...}` attributes.
    const parts = [node.name, "children" in node ? node.children.map(textOf).join("") : ""];
    if (attributes !== undefined) {
      for (const key of Object.keys(attributes).sort()) {
        const value = attributes[key];
        if (typeof value === "string" && value !== "") parts.push(value);
      }
    }
    return parts.filter((part) => part !== "").join(" ");
  }
  return undefined;
}

/** Every reference of one page, in document order. */
function referencesOf(tree: Root, file: string, codeRefs: readonly CodeRef[]): Reference[] {
  const out: Reference[] = [];
  const walk = (node: Nodes): void => {
    const pos = posOf(node, file);
    if (node.type === "link" && pos !== undefined) {
      out.push({ kind: "link", text: textOf(node).trim(), href: node.url, pos });
    } else if (node.type === "heading" && pos !== undefined) {
      out.push({ kind: "heading", text: textOf(node).trim(), pos });
    } else if (node.type === "inlineCode" && pos !== undefined) {
      out.push({ kind: "code-reference", text: node.value.trim(), pos });
    }
    const directive = directiveText(node);
    if (directive !== undefined && pos !== undefined) out.push({ kind: "directive", text: directive, pos });
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  for (const ref of codeRefs) {
    out.push({ kind: "code-reference", text: `${ref.path}:${ref.line}`, file: ref.path, line: ref.line, pos: ref.pos });
  }
  return out;
}

/** The documentation pages: Markdown doc pages whose source is under one of `folders`. */
export function documentationPages(pages: readonly Page[], folders: readonly string[]): Page[] {
  const roots = folders.map((folder) => folder.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "")).filter((folder) => folder !== "");
  const within = (file: string): boolean => roots.length === 0 || roots.some((root) => file === root || file.startsWith(`${root}/`));
  return pages.filter((page) => page.kind === "doc" && MARKDOWN_FILE.test(page.source.file) && within(page.source.file));
}

/** True when an inline code token names the item: its name, its id, `mizzen <name>`, or `npx mizzen <name>`. */
function codeNames(item: SurfaceItem, text: string): boolean {
  const value = text.trim();
  if (value === item.name || value === item.id) return true;
  if (item.kind === "flag" && (value === item.name || value === item.name.replace(/^--/, ""))) return true;
  if (item.kind === "command") {
    return value === `mizzen ${item.name}` || value === `npx mizzen ${item.name}` || value === `${item.name}()` || value === item.name;
  }
  if (item.kind === "symbol") {
    // Inline code may write a call or a signature: `buildSite(...)`, `interface Foo`.
    return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(item.name)}(?![A-Za-z0-9_$])`).test(value);
  }
  return false;
}

/** True when a link's text or target anchors the item: its text equals the name, or the href's last segment or fragment does. */
function linkNames(item: SurfaceItem, text: string, href: string | undefined): boolean {
  if (text === item.name || text === item.id) return true;
  if (href === undefined) return false;
  const withoutQuery = href.split("?")[0]!;
  const fragment = withoutQuery.includes("#") ? withoutQuery.slice(withoutQuery.indexOf("#") + 1) : "";
  const path = withoutQuery.split("#")[0]!;
  const last = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return fragment === item.name || decodeURIComponent(fragment) === item.name || last === item.name;
}

/** True when a directive names the item: a data field by `collection.field`, or by its own name. */
function directiveNames(item: SurfaceItem, text: string): boolean {
  if (item.area !== "data") return false;
  const leaf = item.name.includes(".") ? item.name.slice(item.name.lastIndexOf(".") + 1) : item.name;
  return text.split(/\s+/).some((token) => token === item.name || token === item.id || token === leaf || token.endsWith(`.${leaf}`));
}

/** True when a `file:line` reference points at the item's declaration. */
function codeReferenceNames(item: SurfaceItem, file: string | undefined, line: number | undefined): boolean {
  if (file === undefined || line === undefined) return false;
  if (posix.normalize(file) !== posix.normalize(item.source.file)) return false;
  return line >= item.source.line && line <= Math.max(item.source.line, item.source.endLine);
}

/** True when a heading names the item as a whole word. */
function headingNames(item: SurfaceItem, text: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$-])${escapeRegExp(item.name)}($|[^A-Za-z0-9_$-])`).test(text);
}

/** Escapes a literal for a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether one reference is strong for one item. */
function strong(item: SurfaceItem, ref: Reference): boolean {
  if (ref.kind === "link") return linkNames(item, ref.text, ref.href);
  if (ref.kind === "code-reference") return codeNames(item, ref.text) || codeReferenceNames(item, ref.file, ref.line);
  if (ref.kind === "directive") return directiveNames(item, ref.text);
  return false;
}

/** Whether one reference is weak (a heading naming the item) for one item. */
function weak(item: SurfaceItem, ref: Reference): boolean {
  return ref.kind === "heading" && headingNames(item, ref.text);
}

/** The evidence a match records from one reference. */
function evidenceOf(ref: Reference): SurfaceEvidence {
  return {
    kind: ref.kind === "heading" ? "link" : ref.kind,
    file: ref.pos.file,
    line: ref.pos.line,
    column: ref.pos.column,
    text: ref.text,
  };
}

/** Orders evidence by file, line, column, then kind. */
function sortEvidence(evidence: readonly SurfaceEvidence[]): SurfaceEvidence[] {
  return [...evidence].sort(
    (a, b) => byCodePoint(a.file, b.file) || a.line - b.line || a.column - b.column || byCodePoint(a.kind, b.kind),
  );
}

/**
 * Reads every documentation page and states each item's documentation. A page that cannot be parsed yields a
 * `surface.parse` diagnostic and no references, never a crash and never a false `missing`.
 */
export async function matchDocumentation(
  options: MatchOptions,
): Promise<{ matches: readonly SurfaceMatch[]; diagnostics: readonly Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const references: Reference[] = [];
  for (const page of [...options.pages].sort((a, b) => byCodePoint(a.source.file, b.source.file))) {
    try {
      const tree = await parseMarkdown(page.markdown, page.source.line);
      references.push(...referencesOf(tree, page.source.file, codeRefsIn(tree, page.source.file)));
    } catch (error) {
      diagnostics.push({
        id: "surface.parse",
        severity: "warning",
        message: `Cannot read the documentation page "${page.source.file}": ${error instanceof Error ? error.message : String(error)}.`,
        pos: page.source,
      });
    }
  }

  const matches: SurfaceMatch[] = options.items.map((item) => {
    const strongRefs: SurfaceEvidence[] = [];
    const weakRefs: SurfaceEvidence[] = [];
    for (const ref of references) {
      if (strong(item, ref)) strongRefs.push(evidenceOf(ref));
      else if (weak(item, ref)) weakRefs.push(evidenceOf(ref));
    }
    const state: SurfaceDocState = strongRefs.length > 0 ? "complete" : weakRefs.length > 0 ? "partial" : "missing";
    return {
      item: item.id,
      area: item.area,
      state,
      evidence: sortEvidence(state === "complete" ? strongRefs : weakRefs),
    };
  }).sort((a, b) => byCodePoint(a.area, b.area) || byCodePoint(a.item, b.item));

  return { matches, diagnostics };
}
