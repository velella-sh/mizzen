/**
 * Builds the pages of one pinned OpenAPI reference: the index at `<path>` and one page per operation. The pages are
 * ordinary doc pages, so search, the sitemap, and the Markdown twin see them; the theme renders the operation from the
 * `apiReference` front matter.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic, NavItem, Page, SiteConfig, SourcePos } from "../contracts/index.ts";
import { buildApiReferencePages, type ApiReferencePage } from "../api-reference/pages.ts";
import { readApiReference } from "../api-reference/read.ts";

/** What the build gets from one reference. */
export interface BuiltApiReference {
  readonly pages: readonly Page[];
  /** The reference's title, used for the navigation group. */
  readonly title: string;
  /** The operations grouped by tag, in navigation order. */
  readonly navigation: readonly NavItem[];
  readonly diagnostics: readonly Diagnostic[];
}

/** A position at the top of the reference's source file. */
function sourceOf(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/** Escapes the text the theme may not render, so a search index and a Markdown twin stay readable. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));
}

/** A one-line description for the head: the first paragraph with its whitespace collapsed, at most 200 characters. */
function summaryOf(text: string): string {
  const flat = (text.trim().split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 199).trimEnd()}…`;
}

/** One operation as a doc page; the theme reads the operation model from the front matter. */
function operationPage(page: ApiReferencePage, config: SiteConfig, file: string): Page {
  return {
    url: page.url,
    source: sourceOf(file),
    frontMatter: {
      title: page.title,
      description: summaryOf(page.description ?? "") || `${page.operation.method.toUpperCase()} ${page.operation.path}`,
      layout: "api-reference",
      apiReference: { kind: "operation", operation: page.operation },
    },
    title: page.title,
    lang: config.lang,
    dir: config.dir,
    headings: [],
    html: `<pre class="api-reference">${escapeHtml(page.text)}</pre>`,
    markdown: page.text,
    kind: "doc",
  };
}

/**
 * Reads the reference named by `config.apiReference` and returns its pages. A missing or invalid document yields the
 * diagnostics and no pages, so a build never writes half a reference.
 */
export async function buildApiReferencePagesFor(root: string, config: SiteConfig): Promise<BuiltApiReference> {
  const reference = config.apiReference;
  if (reference === undefined) return { pages: [], title: "API reference", navigation: [], diagnostics: [] };
  const file = reference.source;
  const path = reference.path ?? "/reference/";
  let text: string;
  try {
    text = await readFile(resolve(root, file), "utf8");
  } catch (err) {
    return {
      pages: [],
      title: "API reference",
      navigation: [],
      diagnostics: [
        {
          id: "api-reference.input",
          severity: "error",
          message: `The API reference source "${file}" cannot be read: ${err instanceof Error ? err.message : String(err)}.`,
          pos: sourceOf(file),
          help: "Point `apiReference.source` at an OpenAPI file in the site.",
        },
      ],
    };
  }

  const read = readApiReference(text, file, `${config.base}${path}`);
  if (read.document === undefined) {
    return { pages: [], title: "API reference", navigation: [], diagnostics: [...read.diagnostics] };
  }
  const document = read.document;
  const built = buildApiReferencePages(document);
  const index: Page = {
    url: `${config.base}${path}`,
    source: sourceOf(file),
    frontMatter: {
      title: document.title,
      description:
        summaryOf(document.description ?? "") || `${document.title} API reference, version ${document.version}, with ${built.pages.length} operations.`,
      layout: "api-reference-index",
      apiReference: {
        kind: "index",
        title: document.title,
        version: document.version,
        ...(document.description === undefined ? {} : { description: document.description }),
        navigation: built.navigation,
      },
    },
    title: document.title,
    lang: config.lang,
    dir: config.dir,
    headings: [],
    html: `<pre class="api-reference">${escapeHtml(built.pages.map((page) => page.title).join("\n"))}</pre>`,
    markdown: built.pages.map((page) => `# ${page.title}`).join("\n\n"),
    kind: "doc",
  };
  return {
    pages: [index, ...built.pages.map((page) => operationPage(page, config, file))],
    title: document.title,
    navigation: built.navigation,
    diagnostics: [...read.diagnostics, ...built.diagnostics],
  };
}
