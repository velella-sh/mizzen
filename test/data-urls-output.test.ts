import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { OutputContext } from "../src/contracts/output.ts";
import { urls } from "../src/outputs/urls.ts";
import { URLS_LOCK_FILE } from "../src/data/urls-lock.ts";
import { ids, withSite } from "./data-record-site.ts";

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

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../schema/urls.schema.json", import.meta.url), "utf8"),
) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** A context that never renders a page. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the urls output never renders a page")),
  report: () => undefined,
};

/** The parsed `urls.json` a model writes. */
async function documentOf(site: Parameters<typeof urls.run>[0]): Promise<Record<string, unknown>> {
  const files = await urls.run(site, ctx);
  assert.equal(files.length, 1);
  return JSON.parse(String(files[0]!.contents)) as Record<string, unknown>;
}

test("urls.json maps each record id to its page path and validates against its schema", async () => {
  await withSite(FILES, async (_root, result) => {
    assert.deepEqual(ids(result), []);
    const files = await urls.run(result.site, ctx);
    assert.equal(files[0]!.path, "urls.json");
    const document = await documentOf(result.site);
    assert.equal(validate(document), true, JSON.stringify(validate.errors));
    assert.equal(document.version, 1);
    assert.match(String(document.data), /^[0-9a-f]{64}$/);
    assert.deepEqual(document.collections, { pages: { a: "/pages/alpha/" } });
  });
});

test("a site with url maps to absolute URLs, and an unchanged data set hashes the same", async () => {
  const hashes: string[] = [];
  for (const run of [0, 1]) {
    await withSite(
      {
        ...FILES,
        "mizzen.yml": `url: https://example.com\n${FILES["mizzen.yml"]}`,
        ...(run === 1 ? { "_data/pages.yml": "- id: a\n  name: Alpha\n" } : {}),
      },
      async (_root, result) => {
        const document = await documentOf(result.site);
        assert.deepEqual(document.collections, { pages: { a: "https://example.com/pages/alpha/" } });
        hashes.push(String(document.data));
      },
    );
  }
  assert.equal(hashes[0], hashes[1]);
});

test("the map leaves out a removed record and writes nothing for a site with no records", async () => {
  await withSite(
    {
      ...FILES,
      [URLS_LOCK_FILE]: `${JSON.stringify({
        version: 1,
        collections: {
          pages: { a: { url: "/pages/alpha/", previous: [] }, gone: { url: "/pages/gone/", previous: [] } },
        },
      })}\n`,
      "_data/pages.yml": "- id: a\n  name: Alpha\n",
      "mizzen.yml": `${FILES["mizzen.yml"]}    onRemoved: gone\n`,
    },
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      const document = await documentOf(result.site);
      assert.deepEqual(document.collections, { pages: { a: "/pages/alpha/" } });
    },
  );
  await withSite({ ...FILES, "_data/pages.yml": "[]\n" }, async (_root, result) => {
    assert.deepEqual(await urls.run(result.site, ctx), []);
  });
});
