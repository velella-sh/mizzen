import assert from "node:assert/strict";
import { test } from "node:test";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const files = (body: string) => ({
  "mizzen.yml":
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n" +
    "  children:\n" +
    "    source: _data/children.yml\n" +
    "    references:\n" +
    "      parent: components\n",
  "_data/components.yml": "- id: button\n  name: Button\n- id: input\n  name: Input\n",
  "_data/children.yml":
    "- id: a\n  parent: button\n  name: Child A\n  order: 2\n" +
    "- id: b\n  parent: button\n  name: Child B\n  order: 1\n" +
    "- id: c\n  parent: button\n  name: Child C\n  order: 3\n" +
    "- id: d\n  parent: input\n  name: Child D\n  order: 1\n",
  "_templates/components.md": `---\ntitle: "{name}"\nlayout: record\n---\n${body}`,
});

test("records repeats its body for the records that name this one", async () => {
  await withSite(
    files(':::records{from=children where="parent=id" sort=order}\n- :field[name]\n:::\n'),
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const button = pageAt(result, "/components/button/")!;
      assert.deepEqual(button.markdown.trim().split("\n"), ["- Child B", "- Child A", "- Child C"]);
      assert.match(button.html, /data-src="_data\/children\.yml:7:/);
      assert.doesNotMatch(button.html, /data-src="_data\/components\.yml/);
      const input = pageAt(result, "/components/input/")!;
      assert.deepEqual(input.markdown.trim().split("\n"), ["- Child D"]);
    },
  );
});

test("an empty result renders nothing, and limit keeps the first records", async () => {
  await withSite(
    files(':::records{from=children where="parent=id" sort=order limit=2}\n- :field[name]\n:::\n'),
    (_root, result) => {
      const button = pageAt(result, "/components/button/")!;
      assert.deepEqual(button.markdown.trim().split("\n"), ["- Child B", "- Child A"]);
    },
  );
  await withSite(files(':::records{from=children where="parent=none"}\n- :field[name]\n:::\n'), (_root, result) => {
    const button = pageAt(result, "/components/button/")!;
    assert.equal(button.markdown.trim(), "");
  });
});

test("an unknown collection and a malformed where are errors at the block", async () => {
  await withSite(files(':::records{from=nope}\nText.\n:::\n'), (_root, result) => {
    assert.deepEqual(ids(result), ["data.unknown-collection", "data.unknown-collection"]);
  });
  await withSite(files(':::records{from=children where="parent"}\nText.\n:::\n'), (_root, result) => {
    assert.deepEqual(ids(result), ["data.records-where", "data.records-where"]);
  });
});
