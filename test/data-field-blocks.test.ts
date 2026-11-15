import assert from "node:assert/strict";
import { test } from "node:test";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n",
  "_data/components.yml":
    "- id: button\n  status: stable\n  tags:\n    - name: primary\n    - name: danger\n- id: input\n  status:\n  tags: []\n",
  "_templates/components.md":
    "---\ntitle: \"{id}\"\nlayout: record\n---\n" +
    ":::if{field=status}\nStatus: :field[status].\n:::\n" +
    ":::each{field=tags}\nTag: :field[name].\n:::\n",
};

test("an if keeps its body only when the field has a value, and each repeats one per item", async () => {
  await withSite(FILES, (_root, result) => {
    const button = pageAt(result, "/components/button/")!;
    assert.match(button.markdown, /Status: stable\./);
    assert.match(button.markdown, /Tag: primary\./);
    assert.match(button.markdown, /Tag: danger\./);
    const input = pageAt(result, "/components/input/")!;
    assert.doesNotMatch(input.markdown, /Status:/);
    assert.doesNotMatch(input.markdown, /Tag:/);
  });
});

test("an empty list repeats nothing, and a block nested more than one level is one error", async () => {
  await withSite(
    {
      ...FILES,
      "_templates/components.md":
        "---\ntitle: \"{id}\"\nlayout: record\n---\n" +
        ":::if{field=status}\n:::if{field=status}\n:::if{field=status}\nToo deep.\n:::\n:::\n:::\n",
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.block-nesting"]);
      assert.match(result.diagnostics[0]!.message, /nested more than one level/);
      assert.equal(result.diagnostics[0]!.pos?.file, "_templates/components.md");
    },
  );
});

test("each uses the item's own field, and a field that is not a list is one error", async () => {
  await withSite(
    {
      ...FILES,
      "_templates/components.md":
        "---\ntitle: \"{id}\"\nlayout: record\n---\n:::each{field=status}\n- :field[status]\n:::\n",
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.each-not-list"]);
      assert.match(result.diagnostics[0]!.message, /not a list/);
    },
  );
});
