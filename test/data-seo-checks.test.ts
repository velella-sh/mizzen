import assert from "node:assert/strict";
import { test } from "node:test";
import { withSite } from "./data-record-site.ts";

/** A site with one collection of `rows`, a template that builds the title and description, and extra config lines. */
function files(rows: string, config = "", template = 'title: "{name}"\ndescription: "{summary}"'): Record<string, string> {
  return {
    "mizzen.yml":
      "collections:\n  items:\n    source: _data/items.yml\n    template: _templates/items.md\n    permalink: /items/{id}/\n" +
      config,
    "_data/items.yml": rows,
    "_templates/items.md": `---\n${template}\nlayout: record\n---\n# :field[name]\n`,
  };
}

const seoIds = (diagnostics: readonly { id: string }[]): string[] => diagnostics.map((d) => d.id).filter((id) => id.startsWith("data.seo")).sort();

test("a clean collection gives no SEO finding", async () => {
  const rows = "- id: a\n  name: Alpha\n  summary: First one.\n- id: b\n  name: Beta\n  summary: Second one.\n";
  await withSite(files(rows), (_root, result) => assert.deepEqual(seoIds(result.diagnostics), []));
});

test("a title over 70 characters and a description over 160 are warnings, and the text is kept", async () => {
  const long = "x".repeat(71);
  const rows = `- id: a\n  name: ${long}\n  summary: ${"y".repeat(161)}\n- id: b\n  name: ${"x".repeat(70)}\n  summary: ${"y".repeat(160)}\n`;
  await withSite(files(rows), (_root, result) => {
    const found = result.diagnostics.filter((d) => d.id.startsWith("data.seo"));
    assert.deepEqual(found.map((d) => d.id).sort(), ["data.seo-description-long", "data.seo-title-long"]);
    assert.ok(found.every((d) => d.severity === "warning"));
    assert.match(found.find((d) => d.id === "data.seo-title-long")!.message, /1 record page of "items" \(en\) have a title over 70 characters: \/items\/a\//);
    assert.equal(result.site.pages.find((p) => p.url === "/items/a/")!.title, long, "never shortened");
  });
});

test("the config changes both limits", async () => {
  const rows = "- id: a\n  name: Alpha\n  summary: Twelve chars\n";
  await withSite(files(rows, "    seo:\n      titleMax: 3\n      descriptionMax: 5\n"), (_root, result) => {
    assert.deepEqual(seoIds(result.diagnostics), ["data.seo-description-long", "data.seo-title-long"]);
    assert.match(result.diagnostics.find((d) => d.id === "data.seo-title-long")!.message, /over 3 characters/);
  });
  await withSite(files(`- id: a\n  name: ${"x".repeat(80)}\n  summary: ok\n`, "    seo:\n      titleMax: 100\n"), (_root, result) => {
    assert.deepEqual(seoIds(result.diagnostics), []);
  });
});

test("an empty title or description is reported for a collection that sets seo, and a blank one always", async () => {
  const rows = "- id: a\n  name: Alpha\n  summary: Fine.\n";
  await withSite(files(rows, "    seo: {}\n", 'title: "{name}"'), (_root, result) => {
    assert.deepEqual(seoIds(result.diagnostics), []);
  });
  await withSite(files(rows, "    seo:\n      titleMax: 70\n", 'title: "{name}"'), (_root, result) => {
    assert.deepEqual(seoIds(result.diagnostics), ["data.seo-description-empty"]);
  });
  // Without a seo key a missing description is not a finding.
  await withSite(files(rows, "", 'title: "{name}"'), (_root, result) => {
    assert.deepEqual(seoIds(result.diagnostics), []);
  });
});

test("pages that share a title or a description are one finding each, naming five URLs and the count of the rest", async () => {
  const rows = Array.from({ length: 8 }, (_, i) => `- id: r${i}\n  name: Same\n  summary: Own ${i}\n`).join("") +
    "- id: s1\n  name: Other\n  summary: Shared\n- id: s2\n  name: Another\n  summary: Shared\n";
  await withSite(files(rows), (_root, result) => {
    const found = result.diagnostics.filter((d) => d.id.startsWith("data.seo-duplicate"));
    found.sort((a, b) => (a.id < b.id ? 1 : -1));
    assert.deepEqual(found.map((d) => d.id), ["data.seo-duplicate-title", "data.seo-duplicate-description"]);
    assert.match(found[0]!.message, /8 record pages \(en\) share the title "Same": \/items\/r0\/, \/items\/r1\/, \/items\/r2\/, \/items\/r3\/, \/items\/r4\/ and 3 more\./);
    assert.match(found[1]!.message, /2 record pages \(en\) share the description "Shared": \/items\/s1\/, \/items\/s2\/\./);
  });
});

test("duplicates are never compared across languages", async () => {
  const rows = "- id: a\n  name: Same\n  summary: Same\n- id: b\n  name: Same\n  summary: Same\n";
  const config = "";
  const f = files(rows, config);
  f["mizzen.yml"] = "languages:\n  - code: en\n  - code: fa\n    prefix: fa\n" + f["mizzen.yml"];
  await withSite({ ...f, "_data/items.yml": "- id: a\n  name: Same\n  summary: One\n" }, (_root, result) => {
    assert.ok(result.site.pages.some((p) => p.lang === "fa" && p.record !== undefined), "the record has a page in each language");
    assert.deepEqual(seoIds(result.diagnostics), [], "one record in two languages is not a duplicate");
  });
});
