/** Resolving configured relations: the order a record writes its ids in, a missing target, and a collection without settings. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { relationsOf } from "../../src/data/relations/index.ts";
import { ids, withSite } from "../data-record-site.ts";

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
  "_data/release-lines.yml": "- id: rel-1\n  product: starling\n  rules: [hold, draft]\n",
  "_data/rules.yml": "- id: draft\n  title: Draft\n- id: hold\n  title: Hold\n",
  "_templates/products.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n",
  "_templates/release-lines.md": "---\ntitle: \"Release {id}\"\n---\n# :field[id]\n",
  "_templates/rules.md": "---\ntitle: \"{title}\"\n---\n# :field[title]\n",
};

test("a scalar relation resolves to one record, and a list keeps the record's order, not the target collection's", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const { collections, config } = result.site;
    const record = collections["release-lines"]!.records[0]!;

    const relations = relationsOf(collections, config, "release-lines", record.fields, config.lang);

    assert.deepEqual(Object.keys(relations), ["product", "rules"]);
    assert.deepEqual(relations.product!.map((related) => [related.collection, related.id, related.url]), [
      ["products", "starling", "/products/starling/"],
    ]);
    assert.deepEqual(relations.rules!.map((related) => related.id), ["hold", "draft"]);
    assert.deepEqual(relations.rules!.map((related) => related.url), ["/rules/hold/", "/rules/draft/"]);
    assert.deepEqual(relations.rules![0]!.fields, { id: "hold", title: "Hold" });
  });
});

test("a missing target is left out, and the build reports the invalid reference once", async () => {
  const files = { ...FILES, "_data/release-lines.yml": "- id: rel-1\n  product: starling\n  rules: [hold, gone]\n" };
  await withSite(files, (_root, result) => {
    const { collections, config } = result.site;
    const record = collections["release-lines"]!.records[0]!;
    const relations = relationsOf(collections, config, "release-lines", record.fields, config.lang);

    assert.deepEqual(relations.rules!.map((related) => related.id), ["hold"]);
    assert.deepEqual(ids(result), ["data.reference-missing"]);
    assert.equal(
      result.diagnostics[0]!.message,
      'Field "rules" of record "rel-1" in "release-lines" references "gone", which is not a record id in "rules".',
    );
  });
});

test("a collection without references settings, and a field it does not configure, resolve to nothing", async () => {
  await withSite(FILES, (_root, result) => {
    const { collections, config } = result.site;
    const rule = collections["rules"]!.records[0]!;
    assert.deepEqual(relationsOf(collections, config, "rules", rule.fields, config.lang), {});

    const product = collections["products"]!.records[0]!;
    const relations = relationsOf(collections, config, "products", { ...product.fields, category: "tools" }, config.lang);
    assert.deepEqual(Object.keys(relations), ["rule"]);
  });
});
