import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SiteConfig } from "../src/contracts/index.ts";
import { headers } from "../src/outputs/headers.ts";
import { apiSiteFiles, withBuiltSite } from "./data-api-build.ts";
import { context, site } from "./data-api-site.ts";

function withHeaders(on: boolean): NonNullable<SiteConfig["api"]> {
  return { version: "v1", collections: { packages: { fields: ["name"] } }, ...(on ? { headers: true } : {}) };
}

test("the file is left out by default", async () => {
  assert.deepEqual(await headers.run(site(), context()), []);
});

test("api.headers writes CORS and cache rules for /api/* under the base", async () => {
  const files = await headers.run(site({ api: withHeaders(true) }), context());
  assert.deepEqual(files.map((f) => f.path), ["_headers"]);
  const text = String(files[0]!.contents);
  assert.match(text, /^\/docs\/api\/\*\n {2}Access-Control-Allow-Origin: \*\n/);
  assert.match(text, /Cache-Control: public, max-age=300\n$/);
});

test("a _headers file the source folder already has is not replaced", async () => {
  const root = mkdtempSync(join(tmpdir(), "api-headers-"));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "_headers"), "/*\n  X-Mine: 1\n");
    const ctx = { ...context(), build: { root, workers: 1 } };
    assert.deepEqual(await headers.run(site({ api: withHeaders(true) }), ctx), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real build writes the file only when asked, and keeps the site's own", async () => {
  const api = ["api:", "  headers: true", "  collections:", "    packages:", "      fields: [name, eol]"];
  await withBuiltSite(apiSiteFiles(api), async (out) => {
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(join(out, "_headers"), "utf8"), /\/docs\/api\/\*/);
  });
  await withBuiltSite(apiSiteFiles(api, { _headers: "/*\n  X-Mine: 1\n" }), async (out) => {
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(join(out, "_headers"), "utf8"), "/*\n  X-Mine: 1\n");
  });
  await withBuiltSite(apiSiteFiles(api.filter((line) => line !== "  headers: true")), async (out) => {
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(out, "_headers")), false);
  });
});
