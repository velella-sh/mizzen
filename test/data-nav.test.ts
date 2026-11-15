import assert from "node:assert/strict";
import { test } from "node:test";
import { navState } from "../src/nav/tree.ts";
import { ids, withSite } from "./data-record-site.ts";

const files = (navigation: string) => ({
  "mizzen.yml":
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n",
  "_data/components.yml": "- id: button\n  name: Button\n- id: alert\n  name: Alert\n- id: card\n  name: Card\n",
  "_templates/components.md": "---\ntitle: \"{name}\"\nlayout: record\n---\nBody.\n",
  "_data/navigation.yml": navigation,
});

test("a collection entry expands to its record pages, ordered by a field and cut to the limit", async () => {
  await withSite(
    files("docs:\n  - collection: components\n    title: Components\n    order: name\n    limit: 2\n"),
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const docs = result.site.nav["docs"];
      assert.equal(docs?.length, 1);
      const group = docs[0]!;
      assert.ok("children" in group);
      assert.equal(group.title, "Components");
      assert.deepEqual(
        group.children.map((child) => "url" in child && child.url),
        ["/components/alert/", "/components/button/"],
      );
    },
  );
});

test("the trail and pager of one record page come from the expanded list", async () => {
  await withSite(
    files("docs:\n  - collection: components\n    order: name\n"),
    (_root, result) => {
      const state = navState(result.site.nav["docs"]!, "/components/button/");
      assert.equal(state.current?.title, "Button");
      assert.deepEqual(state.trail.map((entry) => entry.title), ["components", "Button"]);
      assert.equal(state.pager.prev?.title, "Alert");
      assert.equal(state.pager.next?.title, "Card");
    },
  );
});

test("an unknown collection and a bad limit are errors at the entry", async () => {
  await withSite(
    files("docs:\n  - collection: nope\n  - collection: components\n    limit: 0\n"),
    (_root, result) => {
      assert.deepEqual(ids(result), ["nav.unknown-collection", "nav.invalid-limit"]);
      assert.deepEqual(result.site.nav["docs"], []);
    },
  );
});
