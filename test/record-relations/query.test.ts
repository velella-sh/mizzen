/** The `related` prop of a record page and of list records, its stable order, and its absence without configured relations. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordPropsOf } from "../../src/data/record-context.ts";
import { pageAt, withSite } from "../data-record-site.ts";

const CONFIG =
  "collections:\n" +
  "  products:\n" +
  "    source: _data/products.yml\n" +
  "    template: _templates/products.md\n" +
  "    permalink: /products/{id}/\n" +
  "    references:\n" +
  "      rule: rules\n" +
  "  release-lines:\n" +
  "    source: _data/release-lines.yml\n" +
  "    template: _templates/release-lines.md\n" +
  "    permalink: /releases/{id}/\n" +
  "    references:\n" +
  "      product: products\n" +
  "      rules: rules\n" +
  "  rules:\n" +
  "    source: _data/rules.yml\n" +
  "    template: _templates/rules.md\n" +
  "    permalink: /rules/{id}/\n";

const FILES = {
  "mizzen.yml": CONFIG,
  "_data/products.yml": "- id: starling\n  name: Starling\n  rule: hold\n",
  "_data/release-lines.yml": "- id: rel-1\n  product: starling\n  rules: [draft, hold]\n",
  "_data/rules.yml": "- id: draft\n  title: Draft\n- id: hold\n  title: Hold\n",
  "_templates/products.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n",
  "_templates/release-lines.md": "---\ntitle: \"Release {id}\"\n---\n# :field[id]\n",
  "_templates/rules.md": "---\ntitle: \"{title}\"\n---\n# :field[title]\n",
  "releases/index.md": "---\ntitle: Releases\nlist:\n  collection: release-lines\n---\n# Releases\n",
};

test("a record page exposes its configured relations in the record's order", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const props = recordPropsOf(result.site, pageAt(result, "/releases/rel-1/")!)!;

    assert.deepEqual(Object.keys(props.related!), ["product", "rules"]);
    assert.deepEqual(props.related!.product!.map((related) => [related.collection, related.id, related.url]), [
      ["products", "starling", "/products/starling/"],
    ]);
    assert.deepEqual(props.related!.rules!.map((related) => related.id), ["draft", "hold"]);
    assert.deepEqual(props.related!.rules!.map((related) => related.url), ["/rules/draft/", "/rules/hold/"]);
    assert.deepEqual(props.related!.rules![1]!.fields, { id: "hold", title: "Hold" });
    assert.deepEqual(props.links, { product: "/products/starling/" });
  });
});

test("list records expose the same relations, in the record's order", async () => {
  await withSite(FILES, (_root, result) => {
    const row = pageAt(result, "/releases/")!.list!.records[0]!;

    assert.deepEqual(Object.keys(row.related!), ["product", "rules"]);
    assert.deepEqual(row.related!.product!.map((related) => related.id), ["starling"]);
    assert.deepEqual(row.related!.rules!.map((related) => related.id), ["draft", "hold"]);
  });
});

test("a site without configured relations has no related prop on a page or a list record", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  notes:\n" +
        "    source: _data/notes.yml\n" +
        "    template: _templates/notes.md\n" +
        "    permalink: /notes/{id}/\n",
      "_data/notes.yml": "- id: first\n  title: First\n",
      "_templates/notes.md": "---\ntitle: \"{title}\"\n---\n# :field[title]\n",
      "notes/index.md": "---\ntitle: Notes\nlist:\n  collection: notes\n---\n# Notes\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const props = recordPropsOf(result.site, pageAt(result, "/notes/first/")!)!;
      assert.equal(Object.hasOwn(props, "related"), false);
      assert.deepEqual(props.links, {});

      const row = pageAt(result, "/notes/")!.list!.records[0]!;
      assert.equal(Object.hasOwn(row, "related"), false);
    },
  );
});
