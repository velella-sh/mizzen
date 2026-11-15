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

test("every page generated from one source is an output node, for pagination and expansion", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  posts:\n    source: _data/posts.yml\n",
    "_data/posts.yml":
      "- id: a\n  title: Alpha\n  tags: [news]\n" +
      "- id: b\n  title: Beta\n  tags: [news]\n" +
      "- id: c\n  title: Gamma\n  tags: [ui]\n",
    "blog/index.md":
      "---\ntitle: Blog\nlist: { collection: posts, sort: title, perPage: 1 }\n---\n# Blog\n",
    "tags/index.md":
      "---\ntitle: Tags\n" +
      "list:\n" +
      "  collection: posts\n" +
      "  sort: title\n" +
      "  perPage: 1\n" +
      '  expand: { field: tags, permalink: "/tags/{value|slug}/" }\n' +
      "---\n# Tags\n",
  });
  try {
    const { site } = await buildModel(root);
    const { graph, diagnostics } = await buildDependencyGraph({ root, site });
    assert.deepEqual(diagnostics, []);

    const outputs = [
      "/blog/",
      "/blog/page/2/",
      "/blog/page/3/",
      "/tags/",
      "/tags/news/",
      "/tags/news/page/2/",
      "/tags/ui/",
    ];
    for (const url of outputs) {
      assert.ok(graph.nodes.some((node) => node.id === outputNodeId(url)), `${url} is an output node`);
      const source = url.startsWith("/blog/") ? "blog/index.md" : "tags/index.md";
      assert.ok(
        graph.edges.some((edge) => edge.from === outputNodeId(url) && edge.to === fileNodeId(source)),
        `${url} depends on ${source}`,
      );
    }

    const affected = affectedNodes(graph, ["_data/posts.yml"]);
    for (const url of outputs) assert.ok(affected.includes(outputNodeId(url)), `${url} is affected`);
    assert.deepEqual(
      planInvalidation({ graph, changes: [{ kind: "changed", path: "_data/posts.yml" }] }).outputs.map((output) => output.url),
      outputs,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
