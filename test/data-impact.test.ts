import assert from "node:assert/strict";
import { test } from "node:test";
import { compareScope, type OutputOrigin, type PublishedOutput } from "../src/data/impact.ts";
import type { AffectedOutputs } from "../src/pipeline/dependency-graph.ts";

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
