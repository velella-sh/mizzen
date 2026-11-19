import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, GraphInput, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { buildGraph, refreshGraph } from "../src/graph/build.ts";

const config: SiteConfig = {
  title: "Incremental",
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

const pos = { file: "a.md", line: 1, column: 1, endLine: 1, endColumn: 1 };
function page(file: string, text: string): Page {
  return {
    url: `/${file.replace(/\.md$/, "")}/`,
    source: { ...pos, file },
    frontMatter: { title: text },
    title: text,
    lang: "en",
    dir: "ltr",
    headings: [],
    blocks: [{ id: `${file.replace(/\.md$/, "")}-block`, pos: { ...pos, file, line: 3, endLine: 3 }, declared: true }],
    html: "",
    markdown: text,
    kind: "doc",
  };
}

const record = (text: string): Collection["records"][number] => ({
  id: "eol",
  fields: { statement: text },
  position: { file: "_data/findings.yml", startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 },
  fieldPositions: {},
});

function input(a: string, b: string, statement: string): GraphInput {
  const site: Site = {
    config,
    nav: {},
    data: {},
    pages: [page("a.md", a), page("b.md", b)],
    collections: { findings: { name: "findings", source: "_data/findings.yml", records: [record(statement)] } },
  };
  return { site };
}

test("a page edit refreshes only its unit and matches a full rebuild", () => {
  const beforeInput = input("Alpha", "Beta", "First");
  const before = buildGraph(beforeInput).graph;
  const nextInput = input("Alpha", "Beta changed", "First");
  const full = buildGraph(nextInput).graph;
  const refreshed = refreshGraph(before, nextInput, { pages: ["b.md"] }).graph;
  assert.deepEqual(refreshed, full);
  assert.equal(
    refreshed.nodes.find((node) => node.id === "page:a.md"),
    before.nodes.find((node) => node.id === "page:a.md"),
    "the unchanged page is reused",
  );
  assert.notEqual(
    refreshed.nodes.find((node) => node.id === "page:b.md"),
    before.nodes.find((node) => node.id === "page:b.md"),
    "the changed page is rebuilt",
  );
});

test("a record edit refreshes only its collection and matches a full rebuild", () => {
  const beforeInput = input("Alpha", "Beta", "First");
  const before = buildGraph(beforeInput).graph;
  const nextInput = input("Alpha", "Beta", "Second");
  const full = buildGraph(nextInput).graph;
  const refreshed = refreshGraph(before, nextInput, { collections: ["findings"] }).graph;
  assert.deepEqual(refreshed, full);
  assert.equal(
    refreshed.nodes.find((node) => node.id === "page:a.md"),
    before.nodes.find((node) => node.id === "page:a.md"),
    "a page unit is reused",
  );
  assert.equal(
    refreshed.nodes.find((node) => node.id === "claim:findings/eol/statement")?.label,
    "statement",
  );
});
