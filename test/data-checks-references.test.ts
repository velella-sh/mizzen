import assert from "node:assert/strict";
import { test } from "node:test";
import { idsOf, loadSite } from "./data-schema-tree.ts";

const CONFIG =
  "collections:\n" +
  "  components:\n" +
  "    source: _data/components.yml\n" +
  "    references:\n" +
  "      region: regions\n" +
  "  regions:\n" +
  "    source: _data/regions.yml\n";

const REGIONS = "- id: north\n  name: North\n- id: south\n  name: South\n";

test("a reference to an existing id reports nothing", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/regions.yml": REGIONS,
    "_data/components.yml": "- id: button\n  region: north\n",
  });
  assert.deepEqual(result.diagnostics, []);
});

test("a broken reference is one error at the field, naming the target collection", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/regions.yml": REGIONS,
    "_data/components.yml": "- id: button\n  region: north\n- id: dialog\n  region: nowhere\n",
  });
  const found = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.reference-missing");
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /Field "region" of record "dialog" in "components" references "nowhere"/);
  assert.match(found[0]!.message, /is not a record id in "regions"/);
  assert.deepEqual([found[0]!.pos?.line, found[0]!.pos?.column], [4, 11]);
  assert.match(found[0]!.help ?? "", /such as "north"/);
});

test("a list of references is checked item by item", async () => {
  const result = await loadSite({
    "mizzen.yml":
      "collections:\n" +
      "  bundles:\n" +
      "    source: _data/bundles.yml\n" +
      "    references:\n" +
      "      parts: components\n" +
      "  components:\n" +
      "    source: _data/components.yml\n",
    "_data/components.yml": "- id: button\n- id: dialog\n",
    "_data/bundles.yml": "- id: one\n  parts: [button, missing]\n",
  });
  const found = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.reference-missing");
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /references "missing"/);
});

test("a reference target the config does not declare is one error at the first record that uses it", async () => {
  const result = await loadSite({
    "mizzen.yml":
      "collections:\n  components:\n    source: _data/components.yml\n    references:\n      region: areas\n",
    "_data/components.yml": "- id: button\n  region: north\n",
  });
  const found = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.reference-unknown-collection");
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /as a reference to "areas", which the config does not declare/);
  assert.deepEqual([found[0]!.pos?.line, found[0]!.pos?.column], [2, 11]);
});

test("a reference that holds neither an id nor a list of ids is one error at the field", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/regions.yml": REGIONS,
    "_data/components.yml": "- id: button\n  region:\n    name: north\n",
  });
  const found = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.reference-invalid");
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /must be an id or a list of ids/);
  assert.ok(idsOf(result).includes("data.reference-invalid"));
});

test("a target collection that failed to load is left to its own finding", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/components.yml": "- id: button\n  region: north\n",
  });
  assert.deepEqual(idsOf(result), ["data.source-missing"]);
});
