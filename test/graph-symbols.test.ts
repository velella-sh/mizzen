import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { buildGraph } from "../src/graph/build.ts";

const pos = { file: "guide.md", line: 5, column: 1, endLine: 5, endColumn: 30 };

function config(): SiteConfig {
  return {
    title: "Symbols",
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
}

function page(overrides: Partial<Page> = {}): Page {
  return {
    url: "/guide/",
    source: pos,
    frontMatter: { title: "Guide", apiReference: { kind: "operation", operation: { operationId: "createWidget" } } },
    title: "Guide",
    lang: "en",
    dir: "ltr",
    headings: [],
    blocks: [{ id: "docs-block", pos, declared: true }],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

const site: Site = { config: config(), pages: [page()], nav: {}, collections: {}, data: {} };

test("an API reference, docs block, snippet, and symbol are linked", () => {
  const { graph, diagnostics } = buildGraph({
    site,
    codeRefs: [{ page: "guide.md", path: "src/math.ts", line: 1, symbol: "add", block: "docs-block", pos }],
    symbols: [{ file: "src/math.ts", name: "add", kind: "function", line: 1 }],
  });
  assert.deepEqual(diagnostics, []);
  const api = graph.nodes.find((node) => node.kind === "api");
  assert.ok(api);
  assert.equal(api.id, "api:guide.md#createWidget");
  assert.ok(graph.edges.some((edge) => edge.from === "page:api:guide.md#createWidget" && edge.to === api.id && edge.kind === "documents"));
  const snippet = graph.nodes.find((node) => node.kind === "snippet");
  assert.ok(snippet);
  assert.equal(snippet.label, "src/math.ts:1");
  assert.ok(graph.edges.some((edge) => edge.from === "block:docs-block" && edge.to === snippet.id && edge.kind === "references"));
  assert.ok(graph.nodes.some((node) => node.id === "symbol:src/math.ts#add" && node.kind === "symbol"));
  assert.ok(graph.edges.some((edge) => edge.from === snippet.id && edge.to === "symbol:src/math.ts#add" && edge.kind === "references"));
});

test("an invalid symbol reference is an error at the reference span", () => {
  const { graph, diagnostics } = buildGraph({
    site,
    codeRefs: [{ page: "guide.md", path: "src/math.ts", line: 1, symbol: "subtract", block: "docs-block", pos }],
    symbols: [{ file: "src/math.ts", name: "add", kind: "function", line: 1 }],
  });
  const finding = diagnostics.find((problem) => problem.code === "graph.symbol-missing");
  assert.ok(finding);
  assert.equal(finding.severity, "error");
  assert.equal(finding.pos?.file, "guide.md");
  assert.equal(graph.nodes.some((node) => node.id === "symbol:src/math.ts#subtract"), false);
});
