import assert from "node:assert/strict";
import { test } from "node:test";
import { pageAt, withSite } from "./data-record-site.ts";

const config = (source: string) =>
  "collections:\n" +
  "  entries:\n" +
  `    source: ${source}\n` +
  "    template: _templates/entries.md\n" +
  "    permalink: /entries/{id}/\n" +
  "    markdown: [body]\n";

test("a Markdown field in a YAML block scalar renders blocks at their lines in the data file", async () => {
  await withSite(
    {
      "mizzen.yml": config("_data/entries.yml"),
      "_data/entries.yml": "- id: one\n  body: |\n    ## Section\n\n    A paragraph.\n",
      "_templates/entries.md": "---\ntitle: \"{id}\"\nlayout: record\n---\n:field[body]\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const page = pageAt(result, "/entries/one/")!;
      assert.match(page.html, /<h2[^>]*data-src="_data\/entries\.yml:3:5-3:14"[^>]*>Section<\/h2>/);
      assert.match(page.html, /<p[^>]*data-src="_data\/entries\.yml:5:5-5:16"[^>]*>A paragraph\.<\/p>/);
      assert.deepEqual(
        page.headings.map((heading) => [heading.id, heading.pos.file, heading.pos.line]),
        [["section", "_data/entries.yml", 3]],
      );
    },
  );
});

test("a Markdown field in a JSON string points at the string's line", async () => {
  await withSite(
    {
      "mizzen.yml": config("_data/entries.json"),
      "_data/entries.json": JSON.stringify({ one: { body: "## Section\n\nA paragraph." } }, null, 2),
      "_templates/entries.md": "---\ntitle: \"{id}\"\nlayout: record\n---\n:field[body]\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const page = pageAt(result, "/entries/one/")!;
      const lines = [...page.html.matchAll(/data-src="_data\/entries\.json:(\d+):/g)].map((match) => Number(match[1]));
      assert.deepEqual(new Set(lines), new Set([3]));
      assert.match(page.html, /<h2/);
    },
  );
});
