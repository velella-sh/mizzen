import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { buildGraph } from "../src/graph/build.ts";
import { queryGraph } from "../src/graph/query.ts";

const config: SiteConfig = {
  title: "Permissions",
  base: "",
  lang: "en",
  dir: "ltr",
  languages: [],
  source: ".",
  include: [],
  exclude: [],
  navigation: "_data/navigation.yml",
  collections: { notes: { source: "_data/notes.yml" } },
  feeds: {},
  defaults: [],
  theme: { options: {} },
  search: {},
  redirects: {},
  outputs: {},
};

const pos = { file: "public.md", line: 1, column: 1, endLine: 1, endColumn: 1 };
function page(file: string, title: string, audience?: string): Page {
  return {
    url: `/${file.replace(/\.md$/, "")}/`,
    source: { ...pos, file },
    frontMatter: { title, ...(audience === undefined ? {} : { audience }) },
    title,
    lang: "en",
    dir: "ltr",
    headings: [],
    blocks: [{ id: `${file.replace(/\.md$/, "")}-block`, pos: { ...pos, file, line: 3, endLine: 3 }, declared: true }],
    html: "",
    markdown: "",
    kind: "doc",
  };
}

const record: Collection["records"][number] = {
  id: "secret",
  fields: { statement: "Internal note", audience: "staff" },
  position: { file: "_data/notes.yml", startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 },
  fieldPositions: {},
};

const site: Site = {
  config,
  nav: {},
  data: {},
  pages: [page("public.md", "Public"), page("secret.md", "Secret title", "staff")],
  collections: { notes: { name: "notes", source: "_data/notes.yml", records: [record] } },
};

test("unauthorized titles and metadata are absent from results and omissions", () => {
  const { graph } = buildGraph({
    site,
    links: [{ page: "public.md", href: "/secret/", pos, internal: true, target: "secret.md" }],
  });
  const hidden = queryGraph(graph, { snapshot: graph.snapshot.id, from: "page:public.md", depth: 4, nodes: 100 });
  const text = JSON.stringify(hidden);
  assert.equal(text.includes("Secret title"), false);
  assert.equal(text.includes("page:secret.md"), false);
  assert.equal(text.includes("block:secret-block"), false);
  assert.ok(hidden.neighbors.some((entry) => entry.node.id === "page:public.md" || entry.node.id === "block:public-block"));

  const allowed = queryGraph(graph, { snapshot: graph.snapshot.id, from: "page:public.md", depth: 4, nodes: 100, allow: ["staff"] });
  assert.ok(allowed.neighbors.some((entry) => entry.node.id === "block:secret-block"));

  const noPath = queryGraph(graph, { snapshot: graph.snapshot.id, from: "page:public.md", to: "page:secret.md", depth: 4 });
  assert.equal(noPath.found, false);
  assert.equal(JSON.stringify(noPath).includes("Secret title"), false);
  const path = queryGraph(graph, { snapshot: graph.snapshot.id, from: "page:public.md", to: "page:secret.md", depth: 4, allow: ["staff"] });
  assert.equal(path.found, true);

  const recordHidden = queryGraph(graph, { snapshot: graph.snapshot.id, from: "record:notes/secret" });
  assert.deepEqual(recordHidden.neighbors, []);
  assert.equal(JSON.stringify(recordHidden).includes("Internal note"), false);
  const recordAllowed = queryGraph(graph, { snapshot: graph.snapshot.id, from: "record:notes/secret", allow: ["staff"] });
  assert.ok(recordAllowed.neighbors.length > 0);
});

test("narrowing the query does not bypass policy", () => {
  const { graph } = buildGraph({ site });
  for (const options of [
    { depth: 1 },
    { depth: 0 },
    { nodes: 1 },
    { kinds: ["contains" as const] },
  ]) {
    const result = queryGraph(graph, { snapshot: graph.snapshot.id, from: "page:secret.md", ...options });
    assert.equal(result.status, "unknown");
    assert.deepEqual(result.neighbors, []);
    assert.equal(JSON.stringify(result).includes("Secret title"), false);
  }
});
