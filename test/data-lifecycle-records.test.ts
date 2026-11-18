import assert from "node:assert/strict";
import { test } from "node:test";
import type { Site } from "../src/contracts/content.ts";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { URLS_LOCK_FILE } from "../src/data/urls-lock.ts";
import { redirects } from "../src/outputs/redirects.ts";
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

/** The files the redirects output writes for a model, by path. */
async function redirectOutput(site: Site): Promise<{ files: Map<string, string>; reported: Diagnostic[] }> {
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("the redirects output never renders a page")),
    report: (finding) => reported.push(finding),
  };
  const files = await redirects.run(site, ctx);
  return { files: new Map(files.map((file) => [file.path, String(file.contents)])), reported };
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

test("url: retain keeps the retired record's page and writes no redirect", async () => {
  await withSite(
    files("- id: old\n  slug: before\n  state: retired\n  replacedBy: new\n- id: new\n  slug: after\n", "retain"),
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      assert.equal(pageAt(result, "/items/before/")?.record?.replacementUrl, "/items/after/");
      const { files: written, reported } = await redirectOutput(result.site);
      assert.deepEqual(reported, []);
      assert.equal(written.get("items/before/index.html"), undefined);
      assert.equal(written.get("_redirects"), undefined);
    },
  );
});

test("url: redirect removes the retired page and sends its old URLs to the replacement's current URL", async () => {
  const lock = `${JSON.stringify({
    version: 1,
    collections: {
      items: {
        old: { url: "/items/before/", previous: ["/items/older/"] },
        new: { url: "/items/after/", previous: ["/items/new-old/"] },
      },
    },
  })}\n`;
  await withSite(
    {
      ...files("- id: old\n  slug: before\n  state: retired\n  replacedBy: new\n- id: new\n  slug: after\n", "redirect"),
      [URLS_LOCK_FILE]: lock,
    },
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      assert.equal(pageAt(result, "/items/before/"), undefined);
      const { files: written, reported } = await redirectOutput(result.site);
      assert.deepEqual(reported, []);
      assert.match(written.get("items/before/index.html")!, /url=\/items\/after\//);
      assert.match(written.get("items/older/index.html")!, /url=\/items\/after\//);
      assert.equal(
        written.get("_redirects"),
        "/items/before/ /items/after/ 301\n/items/new-old/ /items/after/ 301\n/items/older/ /items/after/ 301\n",
      );
    },
  );
});
