import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  Chrome, CodeConfig, Collection, CollectionSnapshot, Component, DataRecord, Diagnostic, Head, Island, Layout, ListProps, NavTree, Output, Page, Pager, Plugin, RecordPos, RecordProps, Site, SiteConfig, SourcePos, Trail,
} from "../src/contracts/index.ts";

// These values only have to type-check (`npm run typecheck`); the runtime assertions keep the test from being empty.

const pos: SourcePos = { file: "docs/guide/install.md", line: 3, column: 1, endLine: 9, endColumn: 1 };

const config: SiteConfig = {
  title: "Example",
  base: "/example",
  lang: "en",
  dir: "ltr",
  languages: [{ code: "fa", name: "فارسی", prefix: "/fa" }],
  source: ".",
  include: [".well-known"],
  exclude: [],
  navigation: "_data/navigation.yml",
  collections: { components: { source: "_data/components.yml", id: "slug" } },
  feeds: {},
  defaults: [{ path: "", values: { layout: "doc" } }],
  repository: { url: "https://github.com/example/example", branch: "main", dir: "docs" },
  theme: { options: { logo: { light: "logo.svg" } } },
  search: { text: 300 },
  redirects: { "/old/": "/new/" },
  outputs: { llms: false },
};

const recordPos: RecordPos = { file: "_data/components.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

const record: DataRecord = {
  id: "button",
  fields: { title: "Button", status: "stable" },
  position: recordPos,
  fieldPositions: { title: { ...recordPos, startColumn: 8 } },
};

const snapshot: CollectionSnapshot = { source: "_data/components.yml", ref: "abc123", capturedAt: "2026-03-01T10:20:30Z", tool: "git", toolVersion: "2.45.0" };

const collection: Collection = { name: "components", source: "_data/components.yml", records: [record], snapshot };

const page: Page = {
  url: "/example/guide/install/",
  source: pos,
  frontMatter: { title: "Install", order: 1, status: "beta", agent: { edit: false }, custom: ["kept"] },
  title: "Install",
  lang: "en",
  dir: "ltr",
  headings: [{ depth: 2, id: "build", text: "Build", pos }],
  html: '<h1 data-source="docs/guide/install.md:3">Install</h1>',
  markdown: "# Install\n",
  kind: "doc",
  record: { collection: "components", id: "button", position: recordPos, template: "docs/_templates/button.md", templateLine: 4, fallbacks: [] },
};

const nav: NavTree = {
  docs: [{ title: "Guide", children: [{ title: "Install", url: page.url, match: "/example/guide/" }] }],
};

const site: Site = {
  config,
  pages: [page],
  nav,
  collections: { components: collection },
  data: { versions: [1, 2] },
  network: { current: "docs", lock: "a".repeat(64), projects: [{ id: "docs", path: "docs", title: "Docs", current: true }, { id: "blog", path: "blog", title: "Blog", current: false, search: "find" }] },
};
const trail: Trail = [{ title: "Guide", url: "/example/guide/" }, { title: "Install", url: page.url }];
const pager: Pager = { next: { title: "Write", url: "/example/guide/write/" } };
const head: Head = {
  title: "Install",
  meta: [{ name: "description", content: "How to install" }, { name: "og:title", content: "Install", property: true }],
  links: [{ rel: "canonical", href: "https://example.com/example/guide/install/" }],
  jsonLd: [{ "@type": "TechArticle" }],
};
const island: Island = { name: "code-tabs", src: "/example/assets/code-tabs.js" };
const diagnostic: Diagnostic = { id: "link.broken", severity: "error", message: "No page at /missing/", pos, help: "Fix the link." };

const layout: Layout = ({ page: p }) => ({ type: "main", title: p.title });
const dataLayout: Layout = ({ record: r, list: l }) => ({
  type: "main",
  title: r?.fields["title"],
  records: l?.records.length,
});
const chrome: Chrome = ({ site: s }) => ({ type: "header", title: s.config.title });
const component: Component<{ kind: string }> = ({ props }) => ({ type: "aside", kind: props.kind });

const output: Output = {
  name: "example",
  async run(s, ctx) {
    ctx.report(diagnostic);
    return [{ path: "example.txt", contents: s.pages.map((p) => p.url).join("\n") }];
  },
};

const plugin: Plugin = {
  name: "example",
  content: (p) => p,
  model: (s) => s,
  outputs: (files) => files,
};
const code: CodeConfig = { plugins: [plugin] };

const recordProps: RecordProps = { collection: "components", id: "button", url: page.url, fields: record.fields, links: {} };
const listProps: ListProps = {
  collection: "components",
  records: [recordProps],
  groups: [{ key: "stable", records: [recordProps] }],
  pagination: { page: 1, total: 2, next: "/example/components/page/2/" },
};

test("example values of every contract type type-check and carry what the contracts promise", async () => {
  assert.equal(site.pages[0]?.headings[0]?.pos.file, pos.file);
  assert.equal(pager.prev, undefined);
  assert.equal(trail.at(-1)?.url, page.url);
  assert.equal(head.meta.length, 2);
  assert.equal(island.name, "code-tabs");
  assert.equal(code.plugins[0]?.name, "example");
  assert.deepEqual(layout({ site, page, trail, pager, head, islands: [island] }), { type: "main", title: "Install" });
  assert.deepEqual(
    dataLayout({ site, page, trail, pager, head, islands: [island], record: recordProps, list: listProps }),
    { type: "main", title: "Button", records: 1 },
  );
  assert.equal(page.record?.position.startLine, recordPos.startLine);
  assert.equal(site.collections["components"]?.records[0]?.fieldPositions["title"]?.startColumn, 8);
  assert.equal(site.config.collections["components"]?.source, "_data/components.yml");
  assert.deepEqual(site.collections["components"]?.snapshot, snapshot);
  const { snapshot: _omitted, ...withoutSnapshot } = collection;
  const plain: Collection = withoutSnapshot;
  assert.equal(plain.snapshot, undefined);
  assert.deepEqual(site.network?.projects.filter((p) => p.current).map((p) => p.id), ["docs"]);
  assert.deepEqual(chrome({ site, page, trail, pager }), { type: "header", title: "Example" });
  assert.deepEqual(component({ props: { kind: "note" }, page, site, html: "" }), { type: "aside", kind: "note" });
  const reported: Diagnostic[] = [];
  const files = await output.run(site, { renderPage: async () => "", report: (d) => reported.push(d) });
  assert.deepEqual(files, [{ path: "example.txt", contents: page.url }]);
  assert.equal(reported.length, 1);
});

test("the contracts entry re-exports types only, one line per contract module", () => {
  const lines = readFileSync(new URL("../src/contracts/index.ts", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*"));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(line, /^export type \{ [\w, ]+ \} from "\.\/[\w-]+\.ts";$/, `${line} is a type-only re-export`);
  }
});
