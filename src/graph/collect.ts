/**
 * Reads the references a graph needs from the site and the files beside it: Markdown links, include directives, code
 * references and their symbols, and the claims, checks, and lineage a collector supplies. This is the only part of the
 * graph that reads disk; {@link buildGraph} stays pure.
 */
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type { Nodes, Root } from "mdast";
import type { GraphCodeRefInput, GraphIncludeInput, GraphInput, GraphLinkInput, GraphSymbolInput, Page, Site, SourcePos } from "../contracts/index.ts";
import { expandIncludes } from "../content/includes.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import { codeRefsOf } from "../drift/code-refs.ts";
import { contractRefsOf } from "../drift/contract-refs.ts";
import { exportedSymbols } from "../drift/symbols.ts";
import { collectGraphKnowledge } from "../knowledge/graph.ts";
import { parseMarkdown } from "../markdown/parse.ts";

/** What {@link collectGraphInput} can add beyond the site model. */
export interface CollectOptions {
  /** The site root, for include directives and the files code references name. */
  readonly root: string;
  /** The built model. */
  readonly site: Site;
  /** Extra claims, checks, and lineage the caller already read. */
  readonly evidence?: GraphInput["evidence"];
  /** Knowledge declarations to attach; read from the site when absent. */
  readonly knowledge?: GraphInput["knowledge"];
  /** A snapshot label for the graph. */
  readonly snapshot?: string;
  /** Extra audiences by node id or unit. */
  readonly audience?: GraphInput["audience"];
}

/** Compares strings by code point. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A link is external when it names a scheme, a protocol-relative host, or another host. */
function isExternal(href: string, site: Site): boolean {
  if (href.startsWith("//")) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) {
    if (!/^https?:/i.test(href)) return true;
    const siteUrl = site.config.url;
    if (siteUrl === undefined) return true;
    try {
      return new URL(href).host !== new URL(siteUrl).host;
    } catch {
      return true;
    }
  }
  return false;
}

/** The path part of a link, without its query or fragment. */
function pathOf(href: string): string {
  return href.split("#")[0]!.split("?")[0]!;
}

/** A URL without the site base, a leading slash, or a trailing slash. */
function urlKey(url: string, base: string): string {
  let value = url;
  if (base !== "" && value.startsWith(base)) value = value.slice(base.length) || "/";
  value = value.replace(/\/+$/, "");
  return value === "" ? "/" : value;
}

/** The page a link's resolved path names, when it names one. */
function pageTargetOf(path: string, page: Page, site: Site): string | undefined {
  if (path === "") return page.source.file;
  const clean = path.split("#")[0]!.split("?")[0]!;
  if (clean === "") return page.source.file;
  const source = clean.startsWith("/")
    ? clean.replace(/^\/+/, "")
    : posix.normalize(posix.join(posix.dirname(page.source.file), clean));
  const withoutBase = site.config.base !== "" && source.startsWith(site.config.base.replace(/^\/+/, ""))
    ? source.slice(site.config.base.replace(/^\/+/, "").length)
    : source;
  const wanted = urlKey(`/${withoutBase}`, "");
  for (const candidate of site.pages) {
    if (candidate.source.file === withoutBase) return candidate.source.file;
    if (urlKey(candidate.url, site.config.base) === wanted) return candidate.source.file;
    if (urlKey(candidate.url, site.config.base) === `${wanted}/`) return candidate.source.file;
  }
  return undefined;
}

/** The text of a link's children. */
function textOf(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node) return node.children.map(textOf).join("");
  return "";
}

/** The block whose span holds `pos`, when one does. */
function blockAt(page: Page, pos: SourcePos): string | undefined {
  const after = (a: SourcePos, b: SourcePos): boolean =>
    a.line > b.line || (a.line === b.line && a.column >= b.column);
  const before = (a: SourcePos, b: SourcePos): boolean =>
    a.line < b.line || (a.line === b.line && a.column <= b.column);
  for (const block of page.blocks ?? []) {
    if (after(pos, block.pos) && before({ ...pos, line: pos.endLine, column: pos.endColumn }, { ...block.pos, line: block.pos.endLine, column: block.pos.endColumn })) {
      return block.id;
    }
  }
  return undefined;
}

/** Every Markdown link of one page, in document order. */
async function linksOf(page: Page, site: Site): Promise<GraphLinkInput[]> {
  if (page.kind !== "doc") return [];
  const tree: Root = await parseMarkdown(page.markdown, page.source.line);
  const links: GraphLinkInput[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === "link" && node.position !== undefined) {
      const pos: SourcePos = {
        file: page.source.file,
        line: node.position.start.line,
        column: node.position.start.column,
        endLine: node.position.end.line,
        endColumn: Math.max(1, node.position.end.column - 1),
      };
      const internal = !isExternal(node.url, site);
      const target = internal ? pageTargetOf(pathOf(node.url), page, site) : undefined;
      links.push({
        page: page.source.file,
        href: node.url,
        pos,
        text: textOf(node),
        ...(blockAt(page, pos) === undefined ? {} : { block: blockAt(page, pos)! }),
        ...(target === undefined ? {} : { target }),
        internal,
      });
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  return links;
}

/** Every include directive of every doc page, with the file that named it. */
async function includesOf(root: string, site: Site): Promise<GraphIncludeInput[]> {
  const includes: GraphIncludeInput[] = [];
  for (const page of [...site.pages].sort((a, b) => byCodePoint(a.source.file, b.source.file))) {
    if (page.kind !== "doc") continue;
    let text: string;
    try {
      text = await readFile(resolve(root, page.source.file), "utf8");
    } catch {
      try {
        text = await readFile(resolve(root, site.config.source, page.source.file), "utf8");
      } catch {
        continue;
      }
    }
    const front = parseFrontMatter(text, page.source.file);
    const expanded = await expandIncludes({
      body: front.body,
      bodyLine: front.bodyLine,
      file: page.source.file,
      sourceDir: resolve(root, site.config.source),
    });
    for (const include of expanded.includes) {
      includes.push({
        from: page.source.file === include.from ? page.source.file : include.from,
        path: include.path,
        pos: include.pos,
        ...(include.missing === true ? { missing: true } : {}),
      });
    }
  }
  return includes.sort(
    (a, b) =>
      byCodePoint(a.from, b.from) ||
      byCodePoint(a.path, b.path) ||
      a.pos.line - b.pos.line ||
      a.pos.column - b.pos.column,
  );
}

/** Every code reference and the exported symbol its paragraph names. */
async function codeRefsOfPages(pages: readonly Page[], root: string): Promise<{ refs: GraphCodeRefInput[]; symbols: GraphSymbolInput[] }> {
  const refs: GraphCodeRefInput[] = [];
  const files = new Set<string>();
  for (const page of pages) {
    const plain = await codeRefsOf(page);
    const claims = await contractRefsOf(page);
    for (const ref of plain) {
      const claim = claims.find(
        (candidate) => candidate.path === ref.path && candidate.line === ref.line && (candidate.endLine ?? ref.line) === (ref.endLine ?? ref.line),
      );
      refs.push({
        page: page.source.file,
        path: ref.path,
        line: ref.line,
        ...(ref.endLine === undefined ? {} : { endLine: ref.endLine }),
        ...(claim === undefined ? {} : { symbol: claim.symbol, text: claim.text }),
        ...(blockAt(page, ref.pos) === undefined ? {} : { block: blockAt(page, ref.pos)! }),
        pos: ref.pos,
      });
      if (claim !== undefined) files.add(ref.path);
    }
  }
  const symbols: GraphSymbolInput[] = [];
  for (const file of [...files].sort(byCodePoint)) {
    const result = await exportedSymbols({ file: resolve(root, file) });
    for (const symbol of result.symbols) {
      symbols.push({ file, name: symbol.name, kind: symbol.kind, line: symbol.line });
    }
  }
  return { refs, symbols };
}

/**
 * Reads every reference the graph needs from `root`: links, include directives, code references, and the symbols
 * those references name. The result is deterministic and the pure builder does the rest.
 */
export async function collectGraphInput(options: CollectOptions): Promise<GraphInput> {
  const pages = [...options.site.pages].sort((a, b) => byCodePoint(a.source.file, b.source.file));
  const links: GraphLinkInput[] = [];
  for (const page of pages) links.push(...(await linksOf(page, options.site)));
  const includes = await includesOf(options.root, options.site);
  const { refs, symbols } = await codeRefsOfPages(pages, options.root);
  return {
    site: options.site,
    links,
    includes,
    codeRefs: refs,
    symbols,
    knowledge: options.knowledge ?? collectGraphKnowledge(options.site),
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
    ...(options.audience === undefined ? {} : { audience: options.audience }),
  };
}
