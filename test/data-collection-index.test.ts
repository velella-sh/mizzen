import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/index.ts";
import { collectionIndex } from "../src/outputs/collection-index.ts";
import { withSite } from "./data-record-site.ts";
import { SEARCH_FILES } from "./search-fixture.ts";

/** A context that keeps every diagnostic, so the size report can be read back. */
function context(): { ctx: { renderPage: () => Promise<string>; report: (d: Diagnostic) => void }; reports: Diagnostic[] } {
  const reports: Diagnostic[] = [];
  return { ctx: { renderPage: async () => "", report: (d) => reports.push(d) }, reports };
}

test("a collection index is a column layout with one row per record and its page URL", async () => {
  await withSite(SEARCH_FILES, async (_root, result) => {
    const { ctx } = context();
    const files = await collectionIndex.run(result.site, ctx);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, "data/posts.index.json");
    const index = JSON.parse(String(files[0]!.contents)) as {
      collection: string;
      columns: string[];
      rows: (string | null)[][];
    };
    assert.equal(index.collection, "posts");
    assert.deepEqual(index.columns, ["title", "date", "status", "url"]);
    assert.deepEqual(index.rows, [
      ["Alpha", "2024-01-01", "published", "/posts/alpha/"],
      ["Beta", "2024-06-01", "draft", "/posts/beta/"],
      ["Gamma", "2025-01-01", "published", "/posts/gamma/"],
      ["Delta", "2025-01-01", "published", "/posts/delta/"],
    ]);
  });
});

test("an index over the byte budget is split into numbered chunks listed by the head file", async () => {
  const files = {
    ...SEARCH_FILES,
    "mizzen.yml": [
      "collections:",
      "  posts:",
      "    source: _data/posts.yml",
      "    template: _templates/posts.md",
      "    permalink: /posts/{id}/",
      "    index:",
      "      fields: [title, status]",
      "      bytes: 200",
      "",
    ].join("\n"),
  };
  await withSite(files, async (_root, result) => {
    const { ctx, reports } = context();
    const written = await collectionIndex.run(result.site, ctx);
    const paths = written.map((file) => file.path);
    assert.ok(paths.length > 2, "the index is split");
    assert.equal(paths.at(-1), "data/posts.index.json", "the head file sorts after the numbered chunks");
    const head = JSON.parse(String(written.at(-1)!.contents)) as { chunks: string[] };
    assert.deepEqual(head.chunks, paths.slice(0, -1));
    for (const chunk of written.slice(0, -1)) {
      const text = String(chunk.contents);
      assert.ok(Buffer.byteLength(text) <= 200, `${chunk.path} fits the budget`);
      const body = JSON.parse(text) as { columns: string[]; rows: string[][] };
      assert.deepEqual(body.columns, ["title", "status", "url"]);
      assert.ok(body.rows.length > 0, "a chunk holds at least one row");
    }
    assert.ok(reports.some((d) => d.id === "collection-index.size" && d.severity === "info" && /gzipped/.test(d.message)));
  });
});

test("a collection without an index key writes no file", async () => {
  const files = {
    ...SEARCH_FILES,
    "mizzen.yml": "collections:\n  posts:\n    source: _data/posts.yml\n    template: _templates/posts.md\n    permalink: /posts/{id}/\n",
  };
  await withSite(files, async (_root, result) => {
    assert.deepEqual(await collectionIndex.run(result.site, context().ctx), []);
  });
});
