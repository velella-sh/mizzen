/**
 * The prediction against a real build: one record change and one record removal on a small trial site. The before and
 * after folders are built by the engine with a trial renderer, `diffBuilds` computes the real output diff, and
 * `compareScope` checks the plan against it (#829).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { compareScope, type OutputOrigin, type PublishedOutput, type ScopeComparison } from "../src/data/impact.ts";
import { diffBuilds, type SiteDiff } from "../src/diff/index.ts";
import { buildModel } from "../src/model/build.ts";
import { affectedOutputs, buildDependencyGraph, recordNodeId } from "../src/pipeline/dependency-graph.ts";
import { build } from "../src/pipeline/build.ts";
import { site } from "./data-record-site.ts";

const CONFIG = [
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
].join("\n");

const BEFORE = "- id: a\n  title: Alpha\n  published: 2026-05-01\n- id: b\n  title: Beta\n  published: 2026-05-02\n";
const CHANGED = "- id: a\n  title: Alpha Two\n  published: 2026-05-01\n- id: b\n  title: Beta\n  published: 2026-05-02\n";
const REMOVED = "- id: a\n  title: Alpha\n  published: 2026-05-01\n";

const FILES = {
  "mizzen.yml": CONFIG,
  "_data/posts.yml": BEFORE,
  "_templates/post.md": '---\ntitle: "{title}"\nlayout: record\n---\n# :field[title]\n',
  "posts.md": "---\ntitle: Posts\nlayout: list\nlist:\n  collection: posts\n---\n# Posts\n",
};

/** A trial renderer with the three layouts the fixture uses; each prints enough to change when its data changes. */
function trialTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "data-impact-theme-"));
  const files = {
    "package.json": JSON.stringify({ name: "data-impact-theme", type: "module" }),
    "src/index.ts": 'export const theme = { name: "data-impact-theme", folders: ["layouts"] };\n',
    "layouts/doc.ts":
      'export default function doc({ page }) { return `<!DOCTYPE html>\\n<html lang="en"><body>${page.html}</body></html>\\n`; }\n',
    "layouts/record.ts":
      'export default function record({ page, record }) { return `<!DOCTYPE html>\\n<html lang="en"><body>${page.html}<p id="record">${record?.id}</p></body></html>\\n`; }\n',
    "layouts/list.ts":
      'export default function list({ page, list }) { return `<!DOCTYPE html>\\n<html lang="en"><body>${page.html}<p id="list">${list.records.map((record) => record.id).join(",")}</p></body></html>\\n`; }\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The one record the real diff changed or removed, as the origin of every output it published. */
function originOf(diff: SiteDiff, change: "changed" | "removed"): OutputOrigin {
  for (const collection of diff.records) {
    const records = collection[change];
    if (records.length === 0) continue;
    assert.equal(records.length, 1, `the diff must hold one ${change} record`);
    return { node: recordNodeId(collection.collection, records[0]!.id), change };
  }
  assert.fail(`the diff holds no ${change} record`);
}

/** The outputs a data plan covers that the diff really changed: pages, feeds, and API files. */
function published(diff: SiteDiff, origin: OutputOrigin): PublishedOutput[] {
  const paths = new Set<string>();
  for (const page of [...diff.pages.added, ...diff.pages.removed, ...diff.pages.changed]) paths.add(page.url);
  for (const files of [diff.files.added, diff.files.removed, diff.files.changed]) {
    for (const file of files) {
      if (file.group !== "feeds" && file.group !== "api") continue;
      paths.add(`/${"path" in file ? file.path : file.name}`);
    }
  }
  return [...paths].sort().map((path) => ({ path, origin }));
}

/** Builds the trial site before and after `after`, predicts `record`, and compares the prediction with the real diff. */
async function trial(after: string, record: string): Promise<{ diff: SiteDiff; scope: ScopeComparison }> {
  const root = site(FILES);
  const themeRoot = trialTheme();
  const out = mkdtempSync(join(tmpdir(), "data-impact-out-"));
  try {
    const before = await build({ root, out: join(out, "before"), themeRoot, defaultLayout: "doc" });
    assert.deepEqual(before.diagnostics, []);

    const { site: model } = await buildModel(root);
    const { graph, diagnostics } = await buildDependencyGraph({ root, site: model });
    assert.deepEqual(diagnostics, []);
    const predicted = affectedOutputs(graph, [recordNodeId("posts", record)]);

    writeFileSync(join(root, "_data/posts.yml"), after);
    const head = await build({ root, out: join(out, "after"), themeRoot, defaultLayout: "doc" });
    assert.deepEqual(head.diagnostics, []);

    const diff = await diffBuilds(join(out, "before"), join(out, "after"));
    const origin = originOf(diff, diff.records.some((collection) => collection.removed.length > 0) ? "removed" : "changed");
    return { diff, scope: compareScope(predicted, published(diff, origin)) };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

test("a record change: the plan covers the real diff and the two API files it over-predicts", async () => {
  const { diff, scope } = await trial(CHANGED, "a");
  assert.equal(diff.summary.records.changed, 1);
  assert.ok(diff.pages.changed.some((page) => page.url === "/posts/a/"));
  assert.deepEqual(scope, {
    outside: [],
    unconfirmed: ["/api/v1/index.json", "/api/v1/openapi.json"],
  });
});

test("a record removal: the plan covers the removed page and API file and over-predicts openapi", async () => {
  const { diff, scope } = await trial(REMOVED, "b");
  assert.equal(diff.summary.records.removed, 1);
  assert.deepEqual(
    diff.pages.removed.map((page) => page.url),
    ["/posts/b/"],
  );
  assert.ok(diff.files.removed.some((file) => file.name === "api/v1/posts/b.json"));
  assert.deepEqual(scope, {
    outside: [],
    unconfirmed: ["/api/v1/openapi.json"],
  });
});
