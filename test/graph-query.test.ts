import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { buildGraph } from "../src/graph/build.ts";
import { queryGraph } from "../src/graph/query.ts";

const pagePos = { file: "_templates/finding.md", line: 1, column: 1, endLine: 1, endColumn: 1 };
const dataPos = { file: "_data/findings.yml", startLine: 1, startColumn: 1, endLine: 6, endColumn: 1 };
const blockPos = { file: "guide.md", line: 3, column: 1, endLine: 3, endColumn: 10 };

const config: SiteConfig = {
  title: "Query",
  base: "",
  lang: "en",
  dir: "ltr",
  languages: [],
  source: ".",
  include: [],
  exclude: [],
  navigation: "_data/navigation.yml",
  collections: { findings: { source: "_data/findings.yml", evidence: "claims" } },
  feeds: {},
  defaults: [],
  theme: { options: {} },
  search: {},
  redirects: {},
  outputs: {},
};

const record: Collection["records"][number] = {
  id: "eol",
  fields: {
    eol: "2025-04-30",
    claims: {
      eol: [{ id: "schedule", title: "Node release schedule", url: "https://nodejs.org/en/about/previous-releases" }],
    },
  },
  position: dataPos,
  fieldPositions: {},
};

const recordPage: Page = {
  url: "/findings/eol/",
  source: pagePos,
  frontMatter: { title: "EOL" },
  title: "EOL",
  lang: "en",
  dir: "ltr",
  headings: [],
  html: "",
  markdown: "",
  kind: "doc",
  record: { collection: "findings", id: "eol", position: dataPos, template: "_templates/finding.md", templateLine: 1, fallbacks: [] },
};

const docPage: Page = {
  url: "/guide/",
  source: { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
  frontMatter: { title: "Guide" },
  title: "Guide",
  lang: "en",
  dir: "ltr",
  headings: [],
  blocks: [{ id: "docs-block", pos: blockPos, declared: true }],
  html: "",
  markdown: "",
  kind: "doc",
};

const site: Site = {
  config,
  nav: {},
  data: {},
  pages: [docPage, recordPage],
  collections: { findings: { name: "findings", source: "_data/findings.yml", records: [record] } },
};

test("neighbors and the shortest evidence path are stable and ordered", () => {
  const { graph } = buildGraph({
    site,
    codeRefs: [{ page: "guide.md", path: "src/math.ts", line: 1, symbol: "add", block: "docs-block", pos: blockPos }],
    symbols: [{ file: "src/math.ts", name: "add", kind: "function", line: 1 }],
  });
  const query = { snapshot: graph.snapshot.id, from: "page:guide.md", to: "symbol:src/math.ts#add" };
  const first = queryGraph(graph, query);
  const second = queryGraph(graph, query);
  assert.deepEqual(first, second);
  assert.equal(first.status, "present");
  assert.ok(first.neighbors.length > 0);
  assert.ok(first.found);
  assert.equal(first.path?.at(-1)?.node.id, "symbol:src/math.ts#add");
  assert.equal(first.path?.[0]?.node.id, "page:guide.md");

  const evidence = queryGraph(graph, { snapshot: graph.snapshot.id, from: "claim:findings/eol/eol", to: "evidence:https://nodejs.org/en/about/previous-releases" });
  assert.equal(evidence.found, true, JSON.stringify(evidence));
  assert.deepEqual(evidence.path?.map((step) => step.node.id), ["claim:findings/eol/eol", "evidence:https://nodejs.org/en/about/previous-releases"]);
});

test("a query for another snapshot sees nothing", () => {
  const { graph } = buildGraph({ site });
  const result = queryGraph(graph, { snapshot: "another", from: "page:guide.md" });
  assert.equal(result.partial, false);
  assert.deepEqual(result.neighbors, []);
});
