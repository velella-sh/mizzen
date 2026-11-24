/**
 * #1360 and #1363: decisions in the knowledge graph.
 *
 * A decision is one node, carrying its status, date, and how many alternatives it keeps — never its private text. A
 * `decides` edge reaches the page or collection the decision names, and a `supersedes` edge reaches the decision it
 * replaced, so a graph query can walk from a behavior to its decision. A link that does not resolve draws no edge.
 */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { decisionsAsGraph } from "../src/decisions/graph.ts";
import { loadDecisions } from "../src/decisions/load.ts";
import { buildGraph, decisionNodeId } from "../src/graph/build.ts";
import { collectGraphInput } from "../src/graph/collect.ts";
import { queryGraph } from "../src/graph/query.ts";
import { buildModel } from "../src/model/build.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(readFileSync(new URL("../schema/graph.schema.json", import.meta.url), "utf8")) as object;

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "decisions-graph-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("#1360 a decision is a graph node with a decides edge to the page it names", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ndecisions:\n  dir: docs/decisions\n",
    "index.md": "# Home\n",
    "guide/caching.md": "---\ntitle: Caching\n---\n\n# Caching\n\nHits come from memory.\n",
    "docs/decisions/0002.md":
      "---\nid: ADR-0002\ntitle: Redis cache\nstatus: accepted\ndate: 2025-03-02\nsource: x\nsupersedes: [ADR-0001]\npages: [guide/caching.md]\n---\n\n## Decision\n\nCache in Redis.\n",
    "docs/decisions/0001.md":
      "---\nid: ADR-0001\ntitle: In-memory cache\nstatus: superseded\ndate: 2025-01-10\nsource: x\npages: [guide/caching.md]\n---\n\n## Decision\n\nCache in a map.\n",
  });
  try {
    const { site } = await buildModel(root);
    const input = await collectGraphInput({ root, site });
    const { graph, diagnostics } = buildGraph(input);
    assert.deepEqual(diagnostics, []);

    const decision = graph.nodes.find((node) => node.id === decisionNodeId("ADR-0002"));
    assert.ok(decision, "the decision is a node");
    assert.equal(decision?.kind, "decision");
    // The node carries structure, never the private decision text.
    assert.equal(JSON.stringify(decision).includes("Cache in Redis"), false);

    assert.ok(graph.edges.some((edge) => edge.kind === "decides" && edge.from === "decision:ADR-0002" && edge.to === "page:guide/caching.md"));
    assert.ok(graph.edges.some((edge) => edge.kind === "supersedes" && edge.from === "decision:ADR-0002" && edge.to === "decision:ADR-0001"));

    const query = queryGraph(graph, { from: "decision:ADR-0002", direction: "both", depth: 1 });
    assert.ok(query.neighbors.some((neighbor) => neighbor.node.id === "decision:ADR-0001"));

    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    assert.equal(validate(graph), true, JSON.stringify(validate.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1360 a link to a node the snapshot does not hold draws no edge", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ndecisions:\n  dir: docs/decisions\n",
    "index.md": "# Home\n",
    "docs/decisions/0001.md":
      "---\nid: ADR-0001\ntitle: Gone\nstatus: accepted\ndate: 2025-01-01\nsource: x\npages: [missing.md]\n---\n\n## Decision\n\nDo it.\n",
  });
  try {
    const { site } = await buildModel(root);
    const loaded = await loadDecisions({ root, site, dir: "docs/decisions" });
    const input = { site, decisions: decisionsAsGraph(loaded.records) };
    const { graph } = buildGraph(input);
    assert.equal(graph.edges.some((edge) => edge.kind === "decides"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1360 a decision with an audience is not in the default graph projection", () => {
  const input = decisionsAsGraph([
    {
      id: "ADR-secret",
      title: "Secret",
      status: "accepted",
      date: "2025-01-01",
      source: { value: "x" },
      supersedes: [],
      supersededBy: [],
      validity: {},
      links: [],
      evidence: [],
      alternatives: [],
      audience: ["staff"],
      public: false,
      span: { file: "docs/decisions/s.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    },
  ]);
  assert.deepEqual(input, []);
});

test("#1360 a decision's behavior link resolves against a behavior a page really declares", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ndecisions:\n  dir: docs/decisions\n",
    "index.md": "# Home\n",
    "guide/caching.md":
      "---\ntitle: Caching\nbehavior:\n  - id: cache-hit\n    title: A hit is answered from the cache\n    normative: A hit is answered without reading the origin.\n    status: supported\n    versions:\n      introduced: 1.0.0\n---\n\n# Caching\n",
    "docs/decisions/0001.md":
      "---\nid: ADR-0001\ntitle: Cache in Redis\nstatus: accepted\ndate: 2025-03-02\nsource: x\nbehaviors: [cache-hit, cache-unknown]\n---\n\n## Decision\n\nCache in Redis.\n",
  });
  try {
    const { site } = await buildModel(root);
    // The behavior inventory is the engine's own: no config list supplies it.
    assert.equal(site.pages.find((page) => page.source.file === "guide/caching.md")?.behaviors?.[0]?.id, "cache-hit");
    const loaded = await loadDecisions({ root, site, dir: "docs/decisions" });
    const record = loaded.records.find((candidate) => candidate.id === "ADR-0001")!;
    const hit = record.links.find((link) => link.id === "cache-hit");
    const unknown = record.links.find((link) => link.id === "cache-unknown");
    assert.equal(hit?.resolved, true, "a real behavior id resolves");
    assert.equal(unknown?.resolved, false, "a behavior no page declares stays unresolved");
    assert.ok(loaded.diagnostics.some((diagnostic) => diagnostic.id === "decision.link-unresolved"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
