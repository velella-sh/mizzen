import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, Site, SiteConfig } from "../src/contracts/index.ts";
import { buildGraph } from "../src/graph/build.ts";

const pos = { file: "_data/packages.yml", startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 };
const record = (id: string, fields: Record<string, unknown>): Collection["records"][number] => ({ id, fields, position: pos, fieldPositions: {} });

const config: SiteConfig = {
  title: "Data graph",
  base: "",
  lang: "en",
  dir: "ltr",
  languages: [],
  source: ".",
  include: [],
  exclude: [],
  navigation: "_data/navigation.yml",
  collections: {
    packages: {
      source: "_data/packages.yml",
      transform: {
        steps: [
          { id: "trim-name", op: "normalize", field: "name" },
          { id: "drop-internal", op: "remove", fields: ["internal"] },
        ],
      },
      join: { key: "owner", sources: [{ collection: "owners", fields: { ownerName: "name" } }] },
      derived: { age: { field: "released", kind: "days-since" } },
    },
    owners: { source: "_data/owners.yml" },
  },
  feeds: {},
  defaults: [],
  theme: { options: {} },
  search: {},
  redirects: {},
  outputs: {},
};

const site: Site = {
  config,
  nav: {},
  data: {},
  pages: [],
  collections: {
    packages: {
      name: "packages",
      source: "_data/packages.yml",
      records: [record("mizzen", { name: "mizzen", owner: "armin", released: "2026-01-01" })],
    },
    owners: { name: "owners", source: "_data/owners.yml", records: [record("armin", { name: "Armin" })] },
  },
};

test("collections, records, fields, transforms, joins, and derived values are graph nodes", () => {
  const { graph, diagnostics } = buildGraph({ site });
  assert.deepEqual(diagnostics, []);
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const id of [
    "collection:packages",
    "record:packages/mizzen",
    "field:packages/mizzen/name",
    "field:packages/name",
    "transform:packages/trim-name",
    "transform:packages/drop-internal",
    "join:packages",
    "derived:packages/age",
    "collection:owners",
    "record:owners/armin",
  ]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  const edge = (from: string, to: string, kind: string) => graph.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
  assert.ok(edge("collection:packages", "record:packages/mizzen", "contains"));
  assert.ok(edge("record:packages/mizzen", "field:packages/mizzen/name", "contains"));
  assert.ok(edge("transform:packages/trim-name", "field:packages/name", "reads"));
  assert.ok(edge("transform:packages/trim-name", "field:packages/name", "writes"));
  assert.ok(edge("join:packages", "collection:owners", "joins"));
  assert.ok(edge("derived:packages/age", "field:packages/released", "reads"));
  assert.ok(edge("derived:packages/age", "field:packages/age", "writes"));
});
