/** Helpers the page tools share: closest matches for an unknown page, sections of a page, and blocks of its source. */
import type { Heading as MdHeading, Nodes, Root } from "mdast";
import { parseMarkdown } from "../markdown/parse.ts";
import type { PageInfo, SiteState } from "./site.ts";

/** Splits text into lower-case words, by letters and digits of any script. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** The pages whose URL, source, or title is closest to `ref`, nearest first (at most `count`). */
export function closestPages(site: SiteState, ref: string, count = 5): readonly { readonly url: string; readonly title: string; readonly source: string }[] {
  const needle = ref.toLowerCase().replace(/\/+$/, "");
  const scored = site.pages.map((info) => {
    const url = info.page.url.toLowerCase().replace(/\/+$/, "");
    const shared = new Set(words(needle).filter((w) => words(`${url} ${info.page.title} ${info.source}`).includes(w))).size;
    return { info, score: distance(needle, url) - shared * 3 };
  });
  scored.sort((a, b) => a.score - b.score || (a.info.page.url < b.info.page.url ? -1 : 1));
  return scored.slice(0, count).map(({ info }) => ({ url: info.page.url, title: info.page.title, source: info.source }));
}

/** A markdown block of a page body with its offsets into `page.markdown`. */
export interface BodyBlock {
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly pos: { readonly line: number; readonly column: number; readonly endLine: number; readonly endColumn: number };
}

const LEAF = new Set(["paragraph", "heading", "code", "html", "tableCell"]);

/** The body's leaf blocks in document order, with positions in the file (the body starts at `bodyLine`). */
export async function bodyBlocks(info: PageInfo, bodyLine: number): Promise<readonly BodyBlock[]> {
  const tree: Root = await parseMarkdown(info.page.markdown, bodyLine);
  const out: BodyBlock[] = [];
  const visit = (node: Nodes): void => {
    if (LEAF.has(node.type) && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      out.push({
        kind: node.type,
        start: node.position.start.offset,
        end: node.position.end.offset,
        pos: {
          line: node.position.start.line,
          column: node.position.start.column,
          endLine: node.position.end.line,
          endColumn: node.position.end.column - 1,
        },
      });
      return;
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return out;
}

/** The text of the section a heading opens: from its line to the next heading of the same or a higher level. */
export async function sectionText(info: PageInfo, headingId: string): Promise<string | undefined> {
  const index = info.page.headings.findIndex((h) => h.id === headingId);
  if (index < 0) return undefined;
  const tree = await parseMarkdown(info.page.markdown, 1);
  const headings = tree.children.filter((n): n is MdHeading => n.type === "heading");
  if (headings.length !== info.page.headings.length) {
    // Headings that come from directives or HTML are not top-level nodes; count every heading node instead.
    const all: MdHeading[] = [];
    const walk = (n: Nodes): void => {
      if (n.type === "heading") all.push(n);
      if ("children" in n) for (const c of n.children) walk(c);
    };
    walk(tree);
    if (all.length !== info.page.headings.length) return undefined;
    return cut(info, all, index);
  }
  return cut(info, headings, index);
}

function cut(info: PageInfo, headings: readonly MdHeading[], index: number): string | undefined {
  const here = headings[index]!;
  const start = here.position?.start.offset;
  if (start === undefined) return undefined;
  let end = info.page.markdown.length;
  for (const next of headings.slice(index + 1)) {
    if (next.depth <= here.depth && next.position?.start.offset !== undefined) {
      end = next.position.start.offset;
      break;
    }
  }
  return info.page.markdown.slice(start, end).trimEnd();
}
