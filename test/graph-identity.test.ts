import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { buildGraph } from "../src/graph/build.ts";
import { nodeStatus, queryGraph } from "../src/graph/query.ts";

const config: SiteConfig = {
  title: "Identity",
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
};

const pos = { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

function page(url: string, blockText: string): Page {
  return {
    url,
    source: pos,
    frontMatter: { title: blockText },
    title: blockText,
    lang: "en",
    dir: "ltr",
    headings: [],
    blocks: [{ id: "intro", pos: { ...pos, line: 3, endLine: 3 }, declared: true }],
    html: "",
    markdown: blockText,
    kind: "doc",
  };
}

function site(pages: readonly Page[]): Site {
  return { config, pages, nav: {}, collections: {}, data: {} };
}

test("a URL or text change that keeps identity keeps the node id", () => {
  const first = buildGraph({ site: site([page("/guide/", "First text")]) }).graph;
  const moved = buildGraph({ site: site([page("/handbook/", "Second text")]) }).graph;
  assert.ok(first.nodes.some((node) => node.id === "page:guide.md"));
  assert.ok(moved.nodes.some((node) => node.id === "page:guide.md"));
  assert.ok(moved.nodes.some((node) => node.id === "block:intro"));
  assert.equal(moved.snapshot.id === first.snapshot.id, false);
});

test("a deleted node is distinguished from an unknown node", () => {
  const before = buildGraph({ site: site([page("/guide/", "Text")]) }).graph;
  const after = buildGraph({ site: site([]) }).graph;
  assert.equal(nodeStatus(before, "page:guide.md"), "present");
  assert.equal(nodeStatus(after, "page:guide.md", before), "deleted");
  assert.equal(nodeStatus(after, "page:never.md", before), "unknown");
  const result = queryGraph(after, { snapshot: after.snapshot.id, from: "page:guide.md", previous: before });
  assert.equal(result.status, "deleted");
  assert.deepEqual(result.neighbors, []);
});
