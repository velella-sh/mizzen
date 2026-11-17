/** A small site model with two collections, shared by the data API tests. */
import type { DataRecord, Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";

const pos = { file: "_data/packages.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

export function record(id: string, fields: Record<string, unknown> = {}): DataRecord {
  return { id, fields: { name: id, eol: "2030-01-01", secret: "x", ...fields }, position: pos, fieldPositions: {} };
}

function page(url: string, id: string): Page {
  return {
    url,
    source: { file: "_templates/p.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: id,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    record: { collection: "packages", id, position: pos, template: "_templates/p.md", templateLine: 1, fallbacks: [] },
  };
}

export function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
    url: "https://example.test",
    base: "/docs",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    collections: { packages: { source: "_data/packages.yml" }, tools: { source: "_data/tools.yml" } },
    feeds: {},
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
    api: { version: "v1", collections: { packages: { fields: ["name", "eol"] } } },
    ...overrides,
  };
}

export function site(overrides: Partial<SiteConfig> = {}): Site {
  return {
    config: config(overrides),
    pages: [page("/docs/packages/b/", "b"), page("/docs/packages/a/", "a")],
    nav: {},
    collections: {
      packages: {
        name: "packages",
        source: "_data/packages.yml",
        records: [record("b"), record("a")],
        snapshot: { source: "_data/packages.yml", ref: "abc123", capturedAt: "2026-11-01", tool: "git" },
      },
      tools: { name: "tools", source: "_data/tools.yml", records: [record("t")] },
    },
    data: {},
  };
}

export function context(reports: Diagnostic[] = []): OutputContext {
  return { renderPage: () => Promise.reject(new Error("no page")), report: (d) => void reports.push(d) };
}
