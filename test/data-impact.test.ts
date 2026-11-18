import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { compareScope, impactSummary, type OutputOrigin, type PublishedOutput } from "../src/data/impact.ts";
import { buildModel } from "../src/model/build.ts";
import {
  buildDependencyGraph,
  explainAffectedOutputs,
  recordNodeId,
  type AffectedOutputs,
} from "../src/pipeline/dependency-graph.ts";
import { site } from "./data-record-site.ts";

const CHANGED_A: OutputOrigin = { node: "record:posts/a", change: "changed" };
const REMOVED_B: OutputOrigin = { node: "record:posts/b", change: "removed" };

function plan(page: readonly string[] = [], list: readonly string[] = [], feed: readonly string[] = [], api: readonly string[] = []): AffectedOutputs {
  return { page, list, feed, api };
}

test("an output the plan did not name is outside the recorded scope, with the change that published it", () => {
  const changed: readonly PublishedOutput[] = [
    { path: "/posts/a/", origin: CHANGED_A },
    { path: "/posts/b/", origin: REMOVED_B },
    { path: "/feeds/posts.xml", origin: CHANGED_A },
  ];
  const scope = compareScope(plan(["output:/posts/a/", "output:/feeds/posts.xml"]), changed);
  assert.deepEqual(scope.outside, [{ path: "/posts/b/", origin: REMOVED_B }]);
  assert.deepEqual(scope.unconfirmed, []);
});

test("an unconfirmed prediction is reported apart from an out-of-scope publication", () => {
  const scope = compareScope(plan(["output:/posts/a/"], [], [], ["output:/api/v1/posts/a.json"]), [
    { path: "/posts/b/", origin: REMOVED_B },
  ]);
  assert.deepEqual(scope.outside, [{ path: "/posts/b/", origin: REMOVED_B }]);
  assert.deepEqual(scope.unconfirmed, ["/api/v1/posts/a.json", "/posts/a/"]);
});

test("the answer is sorted by path and the input order does not change it", () => {
  const changed: readonly PublishedOutput[] = [
    { path: "/posts/z/", origin: CHANGED_A },
    { path: "/posts/b/", origin: REMOVED_B },
    { path: "/posts/a/", origin: CHANGED_A },
  ];
  const scope = compareScope(plan(["output:/posts/c/"]), changed);
  assert.deepEqual(scope.outside.map((output) => output.path), ["/posts/a/", "/posts/b/", "/posts/z/"]);
  assert.deepEqual(scope.unconfirmed, ["/posts/c/"]);
  assert.deepEqual(compareScope(plan(["output:/posts/c/"]), [...changed].reverse()), scope);
});

const SITE = {
  "mizzen.yml": [
    "title: Trial",
    "url: https://example.test",
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
  ].join("\n"),
  "_data/posts.yml": "- id: a\n  title: Alpha\n  published: 2026-05-01\n",
  "_templates/post.md": '---\ntitle: "{title}"\nlayout: record\n---\n# :field[title]\n',
  "posts.md": "---\ntitle: Posts\nlayout: list\nlist:\n  collection: posts\n---\n# Posts\n",
};

test("the summary names the record, each output kind with its count, and the report link", async () => {
  const root = site(SITE);
  try {
    const { site: model, diagnostics } = await buildModel(root);
    assert.deepEqual(diagnostics, []);
    const { graph, diagnostics: graphDiagnostics } = await buildDependencyGraph({ root, site: model });
    assert.deepEqual(graphDiagnostics, []);
    const outputs = explainAffectedOutputs(graph, [recordNodeId("posts", "a")]);
    const summary = impactSummary("posts/a", outputs, "reports/posts-a.json");
    assert.equal(
      summary,
      [
        "<!-- mizzen-data-impact -->",
        "### Data change: `posts/a`",
        "",
        "| Output | Count |",
        "| --- | ---: |",
        "| page | 1 |",
        "| list | 1 |",
        "| feed | 2 |",
        "| api | 5 |",
        "",
        "[Full report](reports/posts-a.json)",
        "",
      ].join("\n"),
    );
    assert.equal(impactSummary("posts/a", [...outputs].reverse(), "reports/posts-a.json"), summary);
    assert.ok(impactSummary("posts/a", [], "reports/posts-a.json").includes("No published output is affected."));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
