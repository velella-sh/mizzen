import assert from "node:assert/strict";
import { test } from "node:test";
import { ids, pageAt, withSite } from "./data-record-site.ts";

/** A site whose records are addressed by a slug, which may change without changing the record's id. */
function files(items: string, url: "retain" | "redirect" = "retain"): Record<string, string> {
  return {
    "mizzen.yml":
      "collections:\n" +
      "  items:\n" +
      "    source: _data/items.yml\n" +
      "    template: _templates/item.md\n" +
      "    permalink: /items/{slug}/\n" +
      "    lifecycle:\n" +
      "      states: [current, retired]\n" +
      "      retired: [retired]\n" +
      "      replacement: replacedBy\n" +
      `      url: ${url}\n`,
    "_data/items.yml": items,
    "_templates/item.md": "---\ntitle: \"{id}\"\n---\n# :field[id]\n",
  };
}

test("a replacement is found by id after its slug, and so its URL, changes", async () => {
  await withSite(
    files("- id: old\n  slug: before\n  state: retired\n  replacedBy: new\n- id: new\n  slug: after\n"),
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      assert.equal(pageAt(result, "/items/before/")?.record?.replacementUrl, "/items/after/");
    },
  );
});

test("an unknown replacement is reported at the record's line", async () => {
  await withSite(
    files("- id: old\n  slug: before\n  state: retired\n  replacedBy: ghost\n"),
    async (_root, result) => {
      const finding = result.diagnostics.find((entry) => entry.id === "lifecycle.replacement-unknown");
      assert.equal(finding?.severity, "error");
      assert.equal(finding?.pos?.file, "_data/items.yml");
      assert.equal(finding?.pos?.line, 1);
      assert.equal(pageAt(result, "/items/before/")?.record?.replacementUrl, undefined);
    },
  );
});

test("a self reference is reported at the record's line", async () => {
  await withSite(
    files("- id: old\n  slug: before\n  state: retired\n  replacedBy: old\n"),
    async (_root, result) => {
      const finding = result.diagnostics.find((entry) => entry.id === "lifecycle.replacement-self");
      assert.equal(finding?.severity, "error");
      assert.equal(finding?.pos?.file, "_data/items.yml");
      assert.equal(finding?.pos?.line, 1);
    },
  );
});
