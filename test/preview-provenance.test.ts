// #841: a preview build's manifest names the commit and the data hash it was built from; a normal build's manifest
// stays as it was.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Site } from "../src/contracts/content.ts";
import type { Output, OutputContext } from "../src/contracts/output.ts";
import { manifest } from "../src/outputs/manifest.ts";
import { urls } from "../src/outputs/urls.ts";
import { withSite } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "collections:\n" +
    "  pages:\n" +
    "    source: _data/pages.yml\n" +
    "    template: _templates/page.md\n" +
    "    permalink: /pages/{name|slug}/\n",
  "_data/pages.yml": "- id: a\n  name: Alpha\n",
  "_templates/page.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n",
};

/** A context that never renders a page: both outputs read the model alone. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("provenance outputs never render a page")),
  report: () => undefined,
};

/** The parsed JSON one output writes. */
async function jsonOf(output: Output, site: Site): Promise<Record<string, unknown>> {
  const files = await output.run(site, ctx);
  assert.equal(files.length, 1);
  return JSON.parse(String(files[0]!.contents)) as Record<string, unknown>;
}

test("a preview manifest names its commit and the urls.json data hash", async () => {
  await withSite(FILES, async (_root, result) => {
    const preview = { ...result.site, preview: { canonicalBase: "https://preview.example.com/", commit: "0123456789abcdef" } };
    const built = await jsonOf(manifest, preview);
    const map = await jsonOf(urls, preview);
    assert.deepEqual(built.preview, { commit: "0123456789abcdef", dataHash: map.data });

    const normal = await jsonOf(manifest, result.site);
    assert.equal("preview" in normal, false, "a normal build keeps its manifest unchanged");
  });
});

test("a preview without a known commit leaves the commit out", async () => {
  await withSite(FILES, async (_root, result) => {
    const preview = { ...result.site, preview: { canonicalBase: "https://preview.example.com/" } };
    const built = await jsonOf(manifest, preview);
    const map = await jsonOf(urls, preview);
    assert.deepEqual(built.preview, { dataHash: map.data });
  });
});
