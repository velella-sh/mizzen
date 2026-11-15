import assert from "node:assert/strict";
import { test } from "node:test";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const SITE = {
  "mizzen.yml":
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n",
  "_data/components.yml": "- id: button\n  name: Button\n  meta:\n    label: Press me\n  nothing:\n",
  "_templates/components.md":
    "---\ntitle: \"{name}\"\nlayout: record\n---\n# :field[name]\n\nNested: :field[meta.label]. Optional: :field[nothing].\n",
};

test("a field renders its value and the position of the value in the data file", async () => {
  await withSite(SITE, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const page = pageAt(result, "/components/button/")!;
    assert.match(page.html, /Nested: <span data-src="_data\/components\.yml:4:5-4:20">Press me<\/span>\./);
    assert.match(page.html, /Optional: \.<\/p>/);
    assert.match(page.markdown, /Nested: Press me\. Optional: \./);
  });
});

test("an unknown field is an error at the directive, and a non-scalar is an error too", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  components:\n" +
        "    source: _data/components.yml\n" +
        "    template: _templates/components.md\n" +
        "    permalink: /components/{id}/\n" +
        "    schema: components.schema.json\n",
      "components.schema.json": JSON.stringify({
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, meta: { type: "object" } },
      }),
      "_data/components.yml": "- id: button\n  name: Button\n  meta:\n    label: Press me\n",
      "_templates/components.md": "---\ntitle: Button\n---\n:field[missing] and :field[meta]\n",
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.unknown-field", "data.not-a-scalar"]);
      assert.equal(result.diagnostics[0]!.pos?.file, "_templates/components.md");
      assert.equal(result.diagnostics[0]!.pos?.line, 4);
      assert.match(result.diagnostics[0]!.message, /missing/);
      assert.match(result.diagnostics[1]!.message, /meta/);
      const page = pageAt(result, "/components/button/")!;
      assert.match(page.html, /:field\[missing\]/);
      assert.match(page.html, /:field\[meta\]/);
    },
  );
});
