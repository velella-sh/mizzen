import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";

const pos = { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

export function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
    url: "https://example.test",
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

export function page(url = "/guide/", overrides: Partial<Page> = {}): Page {
  return {
    url,
    source: pos,
    frontMatter: {},
    title: "Page",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

export function site(cfg: SiteConfig, pages: Page[] = [page("/"), page()]): Site {
  return { config: cfg, pages, nav: {}, collections: {}, data: {} };
}
