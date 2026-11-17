/** The stale-pages guide documents the keys the schemas publish, and the docs site lists it. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function text(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function schema(path: string): Record<string, any> {
  return JSON.parse(text(`schema/${path}`)) as Record<string, any>;
}

const doc = (): string => text("site/data/stale-docs.md");

test("the stale page names every config key the schema gives `stale`", () => {
  const stale = schema("config.schema.json").properties.stale.properties as Record<string, unknown>;
  for (const key of Object.keys(stale)) assert.ok(doc().includes(`\`stale.${key}\``), `stale.${key}`);
});

test("the stale page names every key of the review lock", () => {
  const lock = schema("docs-review.schema.json");
  const page = lock.$defs.page.properties as Record<string, any>;
  const file = page.files.items.properties as Record<string, unknown>;
  for (const key of [...Object.keys(lock.properties), ...Object.keys(page), ...Object.keys(file)]) {
    assert.ok(doc().includes(`\`${key}\``), key);
  }
});

test("the stale page names every key of the page JSON's stale object, and every change", () => {
  const stale = schema("page-json.schema.json").properties.stale;
  for (const key of Object.keys(stale.properties)) assert.ok(doc().includes(`\`${key}\``), key);
  for (const change of stale.properties.files.items.properties.change.enum as string[]) {
    assert.ok(doc().includes(change), change);
  }
});

test("the stale page is in the navigation", () => {
  assert.ok(text("site/_data/navigation.yml").includes("url: /data/stale-docs/"));
});
