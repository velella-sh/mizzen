import type { Collection, Heading, Page, Site, SiteConfig, TaskContract } from "../src/contracts/index.ts";
import { snapshotIdOf } from "../src/tasks/snapshot.ts";

/** A site config with the defaults a build fills in, plus the given overrides. */
export function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Mizzen",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    collections: {},
    feeds: {},
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
    ...overrides,
  };
}

/** A heading parsed from Markdown, with the position a build would give it. */
function headingsOf(markdown: string, file: string): Page["headings"] {
  const headings: Heading[] = [];
  for (const [index, line] of markdown.split("\n").entries()) {
    const match = /^(#{1,6})[ \t]+(.+)$/.exec(line);
    if (match === null) continue;
    headings.push({
      depth: match[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
      id: match[2]!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      text: match[2]!.trim(),
      pos: { file, line: index + 1, column: 1, endLine: index + 1, endColumn: line.length + 1 },
    });
  }
  return headings;
}

/** A doc page whose Markdown starts at line 1. */
export function page(url: string, markdown: string, title: string, file: string, extra: Partial<Page> = {}): Page {
  const lines = markdown.split("\n");
  const headings = headingsOf(markdown, file);
  return {
    url,
    source: { file, line: 1, column: 1, endLine: lines.length, endColumn: 1 },
    frontMatter: { title },
    title,
    lang: "en",
    dir: "ltr",
    headings,
    html: markdown,
    markdown,
    kind: "doc",
    ...extra,
  };
}

/** A page with declared block ids at the given 1-based heading lines. */
export function blockPage(
  url: string,
  markdown: string,
  title: string,
  file: string,
  blocks: readonly (readonly [string, number])[],
): Page {
  const base = page(url, markdown, title, file);
  return {
    ...base,
    blocks: blocks.map(([id, line]) => ({
      id,
      declared: true,
      pos: { file, line, column: 1, endLine: line, endColumn: 1 },
    })),
  };
}

/** A site model from pages and collections. */
export function site(pages: readonly Page[], collections: Record<string, Collection> = {}, data: Record<string, unknown> = {}): Site {
  return { config: config({ collections: {} }), pages, nav: {}, collections, data };
}

/** A valid task contract, with the fields a test overrides. */
export function task(overrides: Partial<TaskContract> = {}): TaskContract {
  const base = {
    version: 1 as const,
    idempotencyKey: "context-task",
    goal: "Update the install guide for Node 24",
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: [] },
    snapshot: {
      content: "a".repeat(64),
      data: "b".repeat(64),
      config: "c".repeat(64),
      tooling: "d".repeat(64),
    },
    budget: { contextTokens: 4000, toolCalls: 20, timeMs: 60000 },
    permissions: { read: ["*"], write: [], check: [] },
    acceptance: [],
  };
  const merged = { ...base, ...overrides };
  const snapshot = "id" in merged.snapshot ? merged.snapshot : { ...merged.snapshot, id: snapshotIdOf(merged.snapshot) };
  return { ...merged, snapshot };
}
