import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, Site, SiteConfig } from "../src/contracts/index.ts";
import { buildGraph } from "../src/graph/build.ts";

const config: SiteConfig = {
  title: "Evidence",
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
    statement: "Node 18 reaches end of life.",
    claims: {
      eol: [{ id: "schedule", title: "Node release schedule", url: "https://nodejs.org/en/about/previous-releases" }],
    },
  },
  position: { file: "_data/findings.yml", startLine: 1, startColumn: 1, endLine: 6, endColumn: 1 },
  fieldPositions: {},
};

const site: Site = {
  config,
  pages: [],
  nav: {},
  data: {},
  collections: { findings: { name: "findings", source: "_data/findings.yml", records: [record] } },
};

test("claims link to sources, check results, and lineage; an unproven claim has no evidence edge", () => {
  const { graph } = buildGraph({
    site,
    evidence: [
      { collection: "findings", record: "eol", field: "eol", kind: "check", id: "dates-current", title: "Date check", status: "pass" },
      { collection: "findings", record: "eol", field: "statement", kind: "lineage", id: "statement-source", title: "Statement lineage" },
    ],
  });
  const ids = new Set(graph.nodes.map((node) => node.id));
  assert.ok(ids.has("claim:findings/eol/eol"));
  assert.ok(ids.has("claim:findings/eol/statement"));
  assert.ok(ids.has("evidence:https://nodejs.org/en/about/previous-releases"));
  assert.ok(ids.has("check:dates-current"));
  assert.ok(ids.has("lineage:findings/eol/statement"));
  assert.ok(graph.edges.some((edge) => edge.from === "claim:findings/eol/eol" && edge.to === "evidence:https://nodejs.org/en/about/previous-releases" && edge.kind === "backs"));
  assert.ok(graph.edges.some((edge) => edge.from === "claim:findings/eol/eol" && edge.to === "check:dates-current" && edge.kind === "checks"));
  assert.ok(graph.edges.some((edge) => edge.from === "claim:findings/eol/statement" && edge.to === "lineage:findings/eol/statement" && edge.kind === "derives"));

  const unproven = "claim:findings/eol/statement";
  const supported = graph.edges.filter((edge) => edge.from === unproven && (edge.kind === "backs" || edge.kind === "checks"));
  assert.deepEqual(supported, []);
});
