/** The relation baseline: three collections, validated references, the links a page and a list get, and empty relations. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordPropsOf } from "../../src/data/record-context.ts";
import { ids, pageAt, withSite } from "../data-record-site.ts";

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
  "_data/release-lines.yml": "- id: rel-1\n  product: starling\n  rules: [hold]\n- id: rel-empty\n  rules: []\n- id: rel-missing\n",
  "_data/rules.yml": "- id: hold\n  title: Hold\n",
  "_templates/products.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n",
  "_templates/release-lines.md": "---\ntitle: \"Release {id}\"\n---\n# :field[id]\n",
  "_templates/rules.md": "---\ntitle: \"{title}\"\n---\n# :field[title]\n",
  "releases/index.md": "---\ntitle: Releases\nlist:\n  collection: release-lines\n---\n# Releases\n",
};

test("three collections validate, and a scalar reference reaches a record page and a list as a link", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);

    const product = recordPropsOf(result.site, pageAt(result, "/products/starling/")!)!;
    assert.deepEqual(product.links, { rule: "/rules/hold/" });

    const release = recordPropsOf(result.site, pageAt(result, "/releases/rel-1/")!)!;
    assert.deepEqual(release.links, { product: "/products/starling/" });

    const list = pageAt(result, "/releases/")!.list!;
    const records = new Map(list.records.map((record) => [record.id, record]));
    assert.deepEqual(records.get("rel-1")!.links, { product: "/products/starling/" });
  });
});

test("a relation that holds a list of ids is validated but has no link yet", async () => {
  await withSite(FILES, (_root, result) => {
    const release = recordPropsOf(result.site, pageAt(result, "/releases/rel-1/")!)!;
    assert.deepEqual(release.fields.rules, ["hold"]);
    assert.equal("rules" in release.links, false);

    const list = pageAt(result, "/releases/")!.list!;
    const row = list.records.find((record) => record.id === "rel-1")!;
    assert.equal("rules" in row.links, false);
  });
});

test("an absent relation and an empty list are allowed, and add no link", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);

    const list = pageAt(result, "/releases/")!.list!;
    const records = new Map(list.records.map((record) => [record.id, record]));
    assert.deepEqual(records.get("rel-empty")!.fields.rules, []);
    assert.deepEqual(records.get("rel-empty")!.links, {});
    assert.deepEqual(records.get("rel-missing")!.fields, { id: "rel-missing" });
    assert.deepEqual(records.get("rel-missing")!.links, {});
  });
});

test("an empty string or an empty scalar is a validation error, not an absent relation", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  products:\n" +
        "    source: _data/products.yml\n" +
        "  release-lines:\n" +
        "    source: _data/release-lines.yml\n" +
        "    references:\n" +
        "      product: products\n",
      "_data/products.yml": "- id: starling\n",
      "_data/release-lines.yml": "- id: blank\n  product: \"\"\n- id: empty\n  product:\n",
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.reference-missing", "data.reference-invalid"]);
      assert.match(result.diagnostics[0]!.message, /references "", which is not a record id in "products"/);
      assert.match(result.diagnostics[1]!.message, /must be an id or a list of ids/);
    },
  );
});
