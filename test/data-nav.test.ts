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

test("only the list's language expands a collection entry, ordered by its localized field", async () => {
  await withSite(
    {
      "mizzen.yml":
        "languages:\n" +
        "  - code: en\n    name: English\n    prefix: \"\"\n" +
        "  - code: fa\n    name: فارسی\n    prefix: /fa\n" +
        "collections:\n" +
        "  components:\n" +
        "    source: _data/components.yml\n" +
        "    template: _templates/components.md\n" +
        "    permalink: /components/{id}/\n",
      "_data/components.yml":
        "- id: button\n  name:\n    en: Button\n    fa: B\n- id: alert\n  name:\n    en: Alert\n    fa: A\n",
      "_templates/components.md": "---\ntitle: \"{name}\"\nlayout: record\n---\nBody.\n",
      "_data/navigation.yml":
        "docs:\n  - collection: components\n    order: name\n    limit: 1\n" +
        "main:\n  - collection: components\n    order: name\n" +
        "docs_fa:\n  - collection: components\n    order: name\n" +
        "main_fa:\n  - collection: components\n    order: name\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const urls = (list: string): string[] => {
        const items = result.site.nav[list] ?? [];
        const group = items[0];
        assert.ok(group !== undefined && "children" in group);
        return group.children.map((child) => ("url" in child ? child.url : ""));
      };
      assert.deepEqual(urls("docs"), ["/components/alert/"]);
      assert.deepEqual(urls("main"), ["/components/alert/", "/components/button/"]);
      assert.deepEqual(urls("docs_fa"), ["/fa/components/alert/", "/fa/components/button/"]);
      assert.deepEqual(urls("main_fa"), ["/fa/components/alert/", "/fa/components/button/"]);

      for (const list of ["docs", "main"]) {
        assert.equal(urls(list).some((url) => url.startsWith("/fa/")), false, `${list} holds no translation`);
      }
      const state = navState(result.site.nav["docs_fa"]!, "/fa/components/button/");
      assert.deepEqual(state.trail.map((entry) => entry.title), ["components", "B"]);
      assert.equal(state.pager.prev?.title, "A");
      assert.equal(state.pager.next, undefined);
    },
  );
});
