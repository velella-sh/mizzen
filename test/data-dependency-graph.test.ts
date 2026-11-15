import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import { affectedNodes, buildDependencyGraph, fileNodeId, outputNodeId } from "../src/pipeline/dependency-graph.ts";
import { planInvalidation } from "../src/pipeline/invalidation.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-graph-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SITE = {
  "mizzen.yml": "collections:\n  authors:\n    source: _data/authors.yml\n",
  "_data/authors.yml": "- id: memo\n  name: Memo\n- id: nadia\n  name: Nadia\n",
  "_data/navigation.yml": "main:\n  - title: Alpha\n    url: /alpha/\n  - title: Beta\n    url: /beta/\n",
  "alpha.md": "# Alpha\n\n:data[authors.memo.name]\n",
  "beta.md": "# Beta\n",
};

test("a page that reads a collection depends on that one source, and a page that does not has no edge", async () => {
  const root = tree(SITE);
  try {
    const { site } = await buildModel(root);
    const { graph, diagnostics } = await buildDependencyGraph({ root, site });
    assert.deepEqual(diagnostics, []);
    const pairs = graph.edges.map((edge) => `${edge.from} -> ${edge.to}`);
    assert.ok(pairs.includes(`${fileNodeId("alpha.md")} -> ${fileNodeId("_data/authors.yml")}`));
    assert.equal(pairs.some((pair) => pair.startsWith(`${fileNodeId("beta.md")} -> ${fileNodeId("_data/authors.yml")}`)), false);

    const affected = affectedNodes(graph, ["_data/authors.yml"]);
    assert.ok(affected.includes(fileNodeId("alpha.md")));
    assert.ok(affected.includes(outputNodeId("/alpha/")));
    assert.equal(affected.includes(fileNodeId("beta.md")), false);
    assert.equal(affected.includes(outputNodeId("/beta/")), false);

    const plan = planInvalidation({ graph, changes: [{ kind: "changed", path: "_data/authors.yml" }] });
    assert.deepEqual(plan.outputs.map((output) => output.url), ["/alpha/"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directive the graph cannot resolve keeps every data edge for its page", async () => {
  const root = tree({ ...SITE, "alpha.md": "# Alpha\n\n:data[unknown.path]\n" });
  try {
    const { site } = await buildModel(root);
    const { graph } = await buildDependencyGraph({ root, site });
    const pairs = graph.edges.map((edge) => `${edge.from} -> ${edge.to}`);
    assert.ok(pairs.includes(`${fileNodeId("alpha.md")} -> ${fileNodeId("_data/authors.yml")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
