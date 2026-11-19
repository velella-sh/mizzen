import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { buildGraph, GRAPH_FORMAT } from "../src/graph/build.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(readFileSync(new URL("../schema/graph.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

const pos = { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 5 };

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Graph",
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

function page(overrides: Partial<Page> = {}): Page {
  return {
    url: "/guide/",
    source: pos,
    frontMatter: { title: "Guide" },
    title: "Guide",
    lang: "en",
    dir: "ltr",
    headings: [{ depth: 1, id: "guide", text: "Guide", pos }],
    blocks: [{ id: "intro", pos, declared: true }],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, collections: {}, data: {} };
}

test("a built snapshot matches the versioned schema", () => {
  const { graph, diagnostics } = buildGraph({
    site: site([page()]),
    links: [{ page: "guide.md", href: "/guide/", pos, internal: true, target: "guide.md", text: "Guide" }],
  });
  assert.deepEqual(diagnostics, []);
  assert.equal(graph.format, GRAPH_FORMAT);
  assert.equal(graph.snapshot.format, GRAPH_FORMAT);
  assert.match(graph.snapshot.id, /^graph:[0-9a-f]{32}$/);
  assert.equal(validate(graph), true, JSON.stringify(validate.errors));
  assert.ok(graph.nodes.some((node) => node.id === "block:intro" && node.pos?.file === "guide.md"));
});

test("an edge whose target is not a node is rejected", () => {
  const { graph, diagnostics } = buildGraph({
    site: site([page()]),
    links: [{ page: "guide.md", href: "/missing/", pos, internal: true, target: "missing.md" }],
  });
  assert.equal(graph.edges.some((edge) => edge.to === "page:missing.md"), false);
  const finding = diagnostics.find((problem) => problem.code === "graph.edge-invalid");
  assert.ok(finding, JSON.stringify(diagnostics));
  assert.equal(finding.severity, "error");
  assert.equal(finding.pos?.file, "guide.md");
  assert.equal(validate(graph), true, JSON.stringify(validate.errors));
});

test("the schema rejects an unknown node kind and an unknown key", () => {
  const { graph } = buildGraph({ site: site([page()]) });
  assert.equal(validate({ ...graph, nodes: [{ ...graph.nodes[0], kind: "ghost" }] }), false);
  assert.equal(validate({ ...graph, extra: true }), false);
});
