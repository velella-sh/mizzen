import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import { affectedNodes, buildDependencyGraph, fileNodeId, outputNodeId } from "../src/pipeline/dependency-graph.ts";
import { planInvalidation } from "../src/pipeline/invalidation.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-list-graph-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const FILES = {
  "mizzen.yml": "collections:\n  posts:\n    source: _data/posts.yml\n",
  "_data/posts.yml": "- id: a\n  status: published\n",
  "_data/navigation.yml": "main:\n  - title: Blog\n    url: /blog/\n  - title: About\n    url: /about/\n",
  "blog/index.md": "---\ntitle: Blog\nlist: { collection: posts }\n---\n# Blog\n",
  "about.md": "---\ntitle: About\n---\n:count{from=posts where=\"status=published\"}\n",
  "other.md": "---\ntitle: Other\n---\nText.\n",
};

test("a list page and a count depend on the collection source, and a change rebuilds their outputs only", async () => {
  const root = tree(FILES);
  try {
    const { site } = await buildModel(root);
    const { graph, diagnostics } = await buildDependencyGraph({ root, site });
    assert.deepEqual(diagnostics, []);
    const pairs = graph.edges.map((edge) => `${edge.from} -> ${edge.to}`);
    const source = fileNodeId("_data/posts.yml");
    assert.ok(pairs.includes(`${fileNodeId("blog/index.md")} -> ${source}`));
    assert.ok(pairs.includes(`${fileNodeId("about.md")} -> ${source}`));

    const affected = affectedNodes(graph, ["_data/posts.yml"]);
    assert.ok(affected.includes(outputNodeId("/blog/")));
    assert.ok(affected.includes(outputNodeId("/about/")));
    assert.equal(affected.includes(outputNodeId("/other/")), false);
    assert.deepEqual(
      planInvalidation({ graph, changes: [{ kind: "changed", path: "_data/posts.yml" }] }).outputs.map((output) => output.url),
      ["/about/", "/blog/"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
