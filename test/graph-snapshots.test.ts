import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { archiveGraphs, buildGraph } from "../src/graph/build.ts";
import { queryGraph } from "../src/graph/query.ts";

const config: SiteConfig = {
  title: "Snapshots",
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
function site(title: string): Site {
  const page: Page = {
    url: "/guide/",
    source: pos,
    frontMatter: { title },
    title,
    lang: "en",
    dir: "ltr",
    headings: [],
    blocks: [{ id: "intro", pos, declared: true }],
    html: "",
    markdown: "",
    kind: "doc",
  };
  return { config, pages: [page], nav: {}, collections: {}, data: {} };
}

test("independent snapshots keep same-named nodes distinct and a query reads one", () => {
  const first = buildGraph({ site: site("First"), snapshot: "snapshot-a" }).graph;
  const second = buildGraph({ site: site("Second"), snapshot: "snapshot-b" }).graph;
  assert.notEqual(first.snapshot.id, second.snapshot.id);
  assert.ok(first.nodes.some((node) => node.id === "page:guide.md"));
  assert.ok(second.nodes.some((node) => node.id === "page:guide.md"));
  const archive = archiveGraphs([second, first]);
  assert.deepEqual(archive.snapshots.map((graph) => graph.snapshot.id), ["snapshot-a", "snapshot-b"]);

  const a = queryGraph(archive, { snapshot: "snapshot-a", from: "page:guide.md" });
  const b = queryGraph(archive, { snapshot: "snapshot-b", from: "page:guide.md" });
  assert.equal(a.snapshot, "snapshot-a");
  assert.equal(b.snapshot, "snapshot-b");
  assert.equal(a.neighbors[0]?.node.id, "block:intro");
  assert.equal(b.neighbors[0]?.node.id, "block:intro");
  assert.equal(first.nodes.find((node) => node.id === "page:guide.md")?.label, "First");
  assert.equal(second.nodes.find((node) => node.id === "page:guide.md")?.label, "Second");

  const missing = queryGraph(archive, { snapshot: "snapshot-c", from: "page:guide.md" });
  assert.deepEqual(missing.neighbors, []);
  assert.equal(missing.partial, false);
});
