import assert from "node:assert/strict";
import { test } from "node:test";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const files = (permalink: string, extra = "") => ({
  "mizzen.yml":
    `base: /docs\ncollections:\n  components:\n    source: _data/components.yml\n    template: _templates/components.md\n    permalink: "${permalink}"\n`,
  "_data/components.yml": "- id: button\n  meta:\n    slug: press\n  name: Button\n",
  "_templates/components.md": "---\ntitle: \"{name}\"\nlayout: record\n---\nBody.\n",
  ...(extra === "" ? {} : { "components/press.md": "---\ntitle: Press\n---\nText.\n" }),
});

test("a pattern is filled, keeps base, and ends in a slash", async () => {
  await withSite(files("/components/{id}/"), (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    assert.ok(pageAt(result, "/docs/components/button/"));
  });
});

test("a nested pattern fills a dotted path", async () => {
  await withSite(files("/parts/{meta.slug}"), (_root, result) => {
    assert.ok(pageAt(result, "/docs/parts/press/"));
  });
});

test("a missing field is an error at the record, and no page is built", async () => {
  await withSite(files("/components/{nope}/"), (_root, result) => {
    assert.deepEqual(ids(result), ["data.permalink-field"]);
    const finding = result.diagnostics[0]!;
    assert.equal(finding.pos?.file, "_data/components.yml");
    assert.equal(finding.pos?.line, 1);
    assert.match(finding.message, /"nope"/);
    assert.equal(pageAt(result, "/docs/components/button/"), undefined);
  });
});

test("a filled pattern that collides with a file page is one error naming both", async () => {
  await withSite(files("/components/{meta.slug}/", "press"), (_root, result) => {
    assert.deepEqual(ids(result), ["page.duplicate-url"]);
    assert.match(result.diagnostics[0]!.message, /components\/press\.md/);
    assert.match(result.diagnostics[0]!.message, /_data\/components\.yml/);
  });
});
