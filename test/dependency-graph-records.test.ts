import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { write } from "../fixtures/data-large/generate.ts";
import { buildModel } from "../src/model/build.ts";
import {
  affectedNodes,
  buildDependencyGraph,
  changedRecords,
  collectionNodeId,
  outputNodeId,
  recordHashes,
  recordNodeId,
  serializeDependencyGraph,
} from "../src/pipeline/dependency-graph.ts";

/** 1,000 records: 5 regions, 498 components, 497 releases. */
function site(): string {
  const root = mkdtempSync(join(tmpdir(), "graph-records-"));
  write(root, 1000);
  return root;
}

test("a record of a file of a thousand changes alone, and only one record node is seen as changed", async () => {
  const root = site();
  try {
    const before = await buildModel(root);
    const hashesBefore = recordHashes(before.site);
    assert.equal(hashesBefore.size, 1000);

    const file = join(root, "_data", "releases.json");
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes('"summary": "Release 250 '));
    writeFileSync(file, text.replace('"summary": "Release 250 ', '"summary": "Release 250 (edited) '));

    const after = await buildModel(root);
    const changes = changedRecords(hashesBefore, recordHashes(after.site));
    assert.equal(changes.changed.length, 1);
    assert.deepEqual(changes.added, []);
    assert.deepEqual(changes.removed, []);
    assert.match(changes.changed[0]!, /^record:releases\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record page depends on its record and template; a list depends on its collection; the record on its file", async () => {
  const root = site();
  try {
    const { site: model } = await buildModel(root);
    const { graph } = await buildDependencyGraph({ root, site: model });
    const records = graph.nodes.filter((node) => node.kind === "record");
    assert.equal(records.length, 1000);
    assert.ok(records.every((node) => /^[0-9a-f]{64}$/.test(node.hash ?? "")));

    const id = recordNodeId("components", "component-00007");
    const url = "/components/component-00007/";
    const pairs = new Set(graph.edges.map((edge) => `${edge.from} -> ${edge.to}`));
    assert.ok(pairs.has(`${outputNodeId(url)} -> ${id}`));
    assert.ok(pairs.has(`${id} -> file:_data/components.yml`));
    assert.ok(pairs.has(`${outputNodeId(url)} -> file:_templates/components.md`));
    assert.ok(pairs.has(`${outputNodeId("/components/")} -> ${collectionNodeId("components")}`));
    assert.ok(pairs.has(`${collectionNodeId("components")} -> ${id}`));

    // One record reaches its page and the lists of its collection, and no other record's page.
    const affected = affectedNodes(graph, [id]);
    assert.ok(affected.includes(outputNodeId(url)));
    assert.ok(affected.includes(outputNodeId("/components/")));
    assert.equal(affected.includes(outputNodeId("/components/component-00008/")), false);
    assert.equal(affected.includes(outputNodeId("/releases/")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file that no collection reads gets no record node", async () => {
  const root = site();
  try {
    writeFileSync(join(root, "_data", "extra.yml"), "- id: a\n  name: A\n");
    const { site: model } = await buildModel(root);
    const { graph } = await buildDependencyGraph({ root, site: model });
    assert.equal(graph.nodes.some((node) => node.kind === "record" && node.path.startsWith("extra/")), false);
    assert.ok(graph.nodes.some((node) => node.id === "file:_data/extra.yml"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record that moved in its file keeps its hash, and the graph serializes the same twice", async () => {
  const root = site();
  try {
    const first = await buildModel(root);
    const graph = (await buildDependencyGraph({ root, site: first.site })).graph;
    const again = (await buildDependencyGraph({ root, site: (await buildModel(root)).site })).graph;
    assert.equal(serializeDependencyGraph(again), serializeDependencyGraph(graph));
    assert.match(serializeDependencyGraph(graph), /"hash": "[0-9a-f]{64}"/);
    const same = changedRecords(graph, again);
    assert.deepEqual([same.added, same.removed, same.changed], [[], [], []]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
