import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import {
  affectedNodes,
  buildDependencyGraph,
  collectionNodeId,
  outputNodeId,
  recordNodeId,
} from "../src/pipeline/dependency-graph.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "graph-outputs-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const CONFIG = [
  "url: https://example.com",
  "collections:",
  "  posts:",
  "    source: _data/posts.yml",
  "    template: _templates/post.md",
  "    permalink: /posts/{id}/",
  "    dates: [published]",
  "feeds:",
  "  posts:",
  "    collection: posts",
  "    date: published",
  "    formats: [atom, rss]",
  "api:",
  "  collections:",
  "    posts:",
  "      fields: [title, published]",
  "",
].join("\n");

const FILES = {
  "mizzen.yml": CONFIG,
  "_data/posts.yml": "- id: a\n  title: Alpha\n  published: 2026-05-01\n",
  "_templates/post.md": '---\ntitle: "{title}"\n---\n# :field[title]\n',
};

test("a feed file depends on its collection and an API file on its record or collection", async () => {
  const root = tree(FILES);
  try {
    const { site } = await buildModel(root);
    const { graph, diagnostics } = await buildDependencyGraph({ root, site });
    assert.deepEqual(diagnostics, []);

    const nodeAt = (path: string) => graph.nodes.find((node) => node.id === outputNodeId(path));
    assert.equal(nodeAt("/feeds/posts.xml")?.role, "feed");
    assert.equal(nodeAt("/feeds/posts.rss.xml")?.role, "feed");
    assert.equal(nodeAt("/api/v1/index.json")?.role, "api");
    assert.equal(nodeAt("/api/v1/openapi.json")?.role, "api");
    assert.equal(nodeAt("/api/v1/posts.json")?.role, "api");
    assert.equal(nodeAt("/api/v1/posts.ndjson")?.role, "api");
    assert.equal(nodeAt("/api/v1/posts/a.json")?.role, "api");

    const pairs = new Set(graph.edges.map((edge) => `${edge.from} -> ${edge.to}`));
    for (const path of ["/feeds/posts.xml", "/feeds/posts.rss.xml"]) {
      assert.ok(pairs.has(`${outputNodeId(path)} -> ${collectionNodeId("posts")}`), `${path} depends on the collection`);
    }
    for (const path of ["/api/v1/index.json", "/api/v1/openapi.json", "/api/v1/posts.json", "/api/v1/posts.ndjson"]) {
      assert.ok(pairs.has(`${outputNodeId(path)} -> ${collectionNodeId("posts")}`), `${path} depends on the collection`);
    }
    assert.ok(pairs.has(`${outputNodeId("/api/v1/posts/a.json")} -> ${recordNodeId("posts", "a")}`));

    const affected = affectedNodes(graph, ["_data/posts.yml"]);
    assert.ok(affected.includes(outputNodeId("/feeds/posts.xml")));
    assert.ok(affected.includes(outputNodeId("/api/v1/posts/a.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turning the feeds or api output off leaves no node for it", async () => {
  const root = tree({ ...FILES, "mizzen.yml": `${CONFIG}outputs:\n  feeds: false\n  api: false\n` });
  try {
    const { site } = await buildModel(root);
    const { graph } = await buildDependencyGraph({ root, site });
    assert.equal(
      graph.nodes.some((node) => node.role === "feed" || node.role === "api"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
