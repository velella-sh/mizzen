/**
 * Rewrites links to imported pages so they name the page's destination instead of its source: `[x](../intro.mdx)`
 * becomes `[x](/guide/intro.md)`, keeping `?query#anchor`. The engine turns a `.md` link into its pretty URL at build
 * time, so a rewritten link needs no config here. External links and links to anything that is not a page are left
 * alone; a page link the mapping cannot resolve is reported at its source file and line and left as written.
 */
import type { Nodes, Root } from "mdast";
import { posix } from "node:path";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Diagnostic } from "../contracts/index.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import type { ImportedPage } from "./contract.ts";
import type { ImportMapping } from "./mapping.ts";

/** A link to a page's source file, which the engine turns into a URL at build time. */
const PAGE_LINK = /\.(?:md|mdx|markdown)$/i;

/** A scheme (`https:`, `mailto:`) or protocol-relative (`//`) URL, which leaves the site. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/** One page's internal page links: how many its text writes and how many now name a destination. */
export interface PageLinkCount {
  readonly source: string;
  readonly links: number;
  readonly rewritten: number;
}

/** What {@link rewriteLinks} found. */
export interface LinkRewriteResult {
  readonly pages: readonly ImportedPage[];
  readonly diagnostics: readonly Diagnostic[];
  /** One entry per page, in the order the pages were given. */
  readonly counts: readonly PageLinkCount[];
}

/** A link or a reference definition, the two places a page link's URL is written. */
type PageLink = Extract<Nodes, { type: "link" } | { type: "definition" }>;

/** One URL's replacement, by offset in the page body. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Splits `page.md?x=1#top` into its path and the tail to keep verbatim. */
function splitTail(url: string): { readonly path: string; readonly tail: string } {
  const at = url.search(/[?#]/);
  return at === -1 ? { path: url, tail: "" } : { path: url.slice(0, at), tail: url.slice(at) };
}

/** The source path a link names: from the site root, or from the page's own folder. */
function sourceOf(page: string, path: string): string {
  return path.startsWith("/") ? path.slice(1) : posix.normalize(posix.join(posix.dirname(page), path));
}

/** Visits every node in the tree. */
function eachNode(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ("children" in node) for (const child of node.children) eachNode(child, visit);
}

/**
 * Where a link's URL starts in its own source text. The URL is found after the `](` or `]:` that opens it, so a label
 * repeating the URL still rewrites the destination. A URL whose written form differs from its parsed form is left as
 * written.
 */
function urlOffset(body: string, node: PageLink): number | undefined {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined) return undefined;
  const slice = body.slice(from, to);
  const marker = node.type === "definition" ? "]:" : "](";
  const at = slice.indexOf(marker);
  if (at === -1) return undefined;
  let offset = at + marker.length;
  while (slice[offset] === " " || slice[offset] === "\t") offset++;
  if (slice[offset] === "<") offset++; // an angle-bracketed URL keeps its brackets
  return slice.startsWith(node.url, offset) ? from + offset : undefined;
}

/** Rewrites every page link in every page, and reports each one the mapping cannot resolve. */
export function rewriteLinks(pages: readonly ImportedPage[], mappings: readonly ImportMapping[]): LinkRewriteResult {
  const destinations = new Map<string, string>();
  for (const mapping of mappings) {
    if (mapping.kind === "content" && mapping.destination !== undefined) destinations.set(mapping.source, mapping.destination);
  }
  const diagnostics: Diagnostic[] = [];
  const rewritten: ImportedPage[] = [];
  const counts: PageLinkCount[] = [];
  for (const page of pages) {
    const { body, bodyLine } = parseFrontMatter(page.contents, page.source);
    const prefix = page.contents.slice(0, page.contents.length - body.length);
    const tree: Root = unified().use(remarkParse).parse(body);
    const edits: Edit[] = [];
    let links = 0;
    let resolved = 0;
    eachNode(tree, (node) => {
      if (node.type !== "link" && node.type !== "definition") return;
      if (EXTERNAL.test(node.url)) return;
      const { path, tail } = splitTail(node.url);
      if (path === "" || !PAGE_LINK.test(path)) return;
      links++;
      const destination = destinations.get(sourceOf(page.source, path));
      if (destination === undefined) {
        const start = node.position?.start;
        diagnostics.push({
          id: "import.unresolved-link",
          severity: "warning",
          message: `\`${node.url}\` names no imported page; the link is left as written.`,
          ...(start === undefined
            ? {}
            : {
                pos: {
                  file: page.source,
                  line: bodyLine + start.line - 1,
                  column: start.column,
                  endLine: bodyLine + start.line - 1,
                  endColumn: start.column,
                },
              }),
        });
        return;
      }
      const start = urlOffset(body, node);
      if (start !== undefined) {
        edits.push({ start, end: start + node.url.length, text: `/${destination}${tail}` });
        resolved++;
      }
    });
    let text = body;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    counts.push({ source: page.source, links, rewritten: resolved });
    rewritten.push({ ...page, contents: prefix + text });
  }
  return { pages: rewritten, diagnostics, counts };
}
