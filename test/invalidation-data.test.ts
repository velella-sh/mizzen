import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { write } from "../fixtures/data-large/generate.ts";
import { buildModel } from "../src/model/build.ts";
import {
  buildDependencyGraph,
  collectionNodeId,
  outputNodeId,
  recordNodeId,
  type DependencyGraph,
} from "../src/pipeline/dependency-graph.ts";
import {
  planInvalidation,
  serializeInvalidationPlan,
  type InvalidationChange,
  type InvalidationPlan,
} from "../src/pipeline/invalidation.ts";

/** A 600-record site: 5 regions, 299 components, 296 releases, and a schema and a lock for `components`. */
async function setup(): Promise<{ root: string; graph: DependencyGraph }> {
  const root = mkdtempSync(join(tmpdir(), "invalidation-data-"));
  write(root, 600);
  writeFileSync(join(root, "components.schema.json"), '{"type":"object"}\n');
  const config = readFileSync(join(root, "mizzen.yml"), "utf8");
  writeFileSync(join(root, "mizzen.yml"), config.replace("    id: slug\n", "    id: slug\n    schema: components.schema.json\n"));
  const { site } = await buildModel(root);
  const { graph } = await buildDependencyGraph({ root, site });
  return { root, graph };
}

function plan(graph: DependencyGraph, ...changes: InvalidationChange[]): InvalidationPlan {
  return planInvalidation({ graph, changes });
}

const urls = (p: InvalidationPlan): string[] => p.outputs.map((output) => output.url);

test("a changed record rebuilds its page, the lists of its collection, and names the record for feeds and indexes", async () => {
  const { root, graph } = await setup();
  try {
    const id = recordNodeId("components", "component-00007");
    const p = plan(graph, { kind: "changed", path: id });
    assert.equal(p.complete, false);

    const page = p.outputs.find((output) => output.url === "/components/component-00007/");
    assert.ok(page, "the record's own page is planned");
    assert.equal(page.action, "rebuild");
    assert.deepEqual(page.direct.map((cause) => cause.node), [id]);
    assert.equal(page.direct[0]!.explanation, "/components/component-00007/ → components/component-00007 (changed)");

    // The list pages read the collection as a whole; the cause chain goes through the collection node.
    const list = p.outputs.find((output) => output.url === "/components/");
    assert.ok(list, "a list of the collection is planned");
    assert.deepEqual(
      list.transitive[0]!.chain.map((step) => step.id),
      [outputNodeId("/components/"), collectionNodeId("components"), id],
    );

    // Nothing of another record, another collection's page, or an unrelated page is planned.
    assert.equal(urls(p).includes("/components/component-00008/"), false);
    assert.equal(urls(p).includes("/releases/"), false);
    assert.equal(urls(p).includes("/"), false);

    // Feeds and indexes of the collection: only that record moved.
    assert.deepEqual(
      p.collections.map((c) => [c.name, c.scope, c.records]),
      [["components", "records", ["component-00007"]]],
    );
    assert.deepEqual(p.collections[0]!.causes.map((cause) => cause.node), [id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed template rebuilds every page of its collection and no other", async () => {
  const { root, graph } = await setup();
  try {
    const p = plan(graph, { kind: "changed", path: "_templates/components.md" });
    assert.equal(p.complete, false);
    const pages = urls(p).filter((url) => /^\/components\/component-/.test(url));
    assert.equal(pages.length, 299);
    assert.equal(urls(p).some((url) => url.startsWith("/releases/") || url.startsWith("/regions/")), false);

    const one = p.outputs.find((output) => output.url === "/components/component-00001/")!;
    assert.deepEqual(one.direct.map((cause) => cause.explanation), [
      "/components/component-00001/ → _templates/components.md (changed)",
    ]);
    // Feeds and indexes read records, not the template: the collection itself is not affected.
    assert.deepEqual(p.collections, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed schema or lock file reads the whole collection again, with a chain through its config", async () => {
  const { root, graph } = await setup();
  try {
    const p = plan(graph, { kind: "changed", path: "components.schema.json" });
    assert.equal(p.complete, false);
    const pages = urls(p).filter((url) => /^\/components\/component-/.test(url));
    assert.equal(pages.length, 299);
    assert.ok(urls(p).includes("/components/"));
    assert.equal(urls(p).some((url) => url.startsWith("/releases/")), false);

    const page = p.outputs.find((output) => output.url === "/components/component-00001/")!;
    const chain = [...page.direct, ...page.transitive][0]!.chain.map((step) => step.id);
    assert.equal(chain[0], outputNodeId("/components/component-00001/"));
    assert.ok(chain.includes("collection-config:components"));
    assert.equal(chain.at(-1), "file:components.schema.json");

    assert.deepEqual(
      p.collections.map((c) => [c.name, c.scope, c.records]),
      [["components", "full", []]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed collection config entry reaches the same set as a changed schema", async () => {
  const { root, graph } = await setup();
  try {
    const p = plan(graph, { kind: "changed", path: "collection-config:components" });
    assert.equal(urls(p).filter((url) => /^\/components\/component-/.test(url)).length, 299);
    assert.equal(p.collections[0]!.scope, "full");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed source file rebuilds every record of its collection and the references onto it", async () => {
  const { root, graph } = await setup();
  try {
    const p = plan(graph, { kind: "changed", path: "_data/components.yml" });
    assert.equal(urls(p).filter((url) => /^\/components\/component-/.test(url)).length, 299);
    assert.deepEqual(p.collections.map((c) => [c.name, c.scope]).filter(([name]) => name === "components"), [["components", "full"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unprovable change rebuilds everything, and the plan is byte-identical for equivalent inputs", async () => {
  const { root, graph } = await setup();
  try {
    const unknown = plan(graph, { kind: "changed", path: "_data/not-in-graph.yml" });
    assert.equal(unknown.complete, true);
    assert.ok(unknown.collections.length >= 3);
    assert.ok(unknown.collections.every((c) => c.scope === "full"));

    const a = serializeInvalidationPlan(
      plan(
        graph,
        { kind: "changed", path: recordNodeId("components", "component-00007") },
        { kind: "changed", path: "_templates/releases.md" },
      ),
    );
    const b = serializeInvalidationPlan(
      plan(
        graph,
        { kind: "changed", path: "_templates/releases.md" },
        { kind: "changed", path: recordNodeId("components", "component-00007") },
      ),
    );
    assert.equal(a, b);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
