import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SiteConfig } from "../src/contracts/config.ts";
import type { Collection } from "../src/contracts/data.ts";
import { discoverData } from "../src/surface/adapters/data.ts";
import { discoverOpenApi } from "../src/surface/adapters/openapi.ts";
import { discoverVersions } from "../src/surface/adapters/versions.ts";
import { surface as surfaceOutput } from "../src/outputs/surface.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "surface-extra-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example", base: "", lang: "en", dir: "ltr", languages: [], source: ".", include: [], exclude: [],
    navigation: "_data/navigation.yml", collections: {}, feeds: {}, defaults: [], theme: {}, search: {}, redirects: {}, outputs: {},
    ...overrides,
  };
}

test("data fields take their span from the collection schema when it names them", async () => {
  const root = tree({
    "schemas/posts.json": JSON.stringify({ type: "object", properties: { title: { type: "string" }, body: { type: "string" } } }, null, 2),
  });
  try {
    const records = [{ id: "a", fields: { title: "A", body: "B" }, position: { file: "_data/posts.yml", startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }, fieldPositions: {} }];
    const collection: Collection = { name: "posts", source: "_data/posts.yml", records };
    const result = await discoverData({
      root,
      config: config({ collections: { posts: { source: "_data/posts.yml", schema: "schemas/posts.json" } } }),
      collections: { posts: collection },
    });
    const title = result.items.find((item) => item.id === "field:posts.title");
    assert.equal(title?.source.file, "schemas/posts.json");
    assert.ok((title?.source.line ?? 0) > 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a collection with no records still records its declared fields", async () => {
  const collection: Collection = { name: "empty", source: "_data/empty.yml", records: [] };
  const result = await discoverData({
    root: "/tmp",
    config: config({ collections: { empty: { source: "_data/empty.yml", public: ["title"] } } }),
    collections: { empty: collection },
  });
  assert.ok(result.items.some((item) => item.id === "collection:empty"));
  assert.ok(result.items.some((item) => item.id === "field:empty.title"));
});

test("an OpenAPI document with a bad reference yields findings and no items", async () => {
  const root = tree({
    "openapi.yaml": "openapi: 3.1.0\ninfo:\n  title: X\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      operationId: getA\n      responses:\n        '200':\n          $ref: '#/components/responses/Missing'\n",
  });
  try {
    const result = await discoverOpenApi({ source: "openapi.yaml", root });
    assert.deepEqual(result.items, []);
    assert.ok(result.findings.some((finding) => finding.severity === "error"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing OpenAPI document is one error finding", async () => {
  const result = await discoverOpenApi({ source: "nope.yaml", root: "/tmp" });
  assert.deepEqual(result.items, []);
  assert.equal(result.findings[0]?.code, "surface.openapi-source");
});

test("versions read a YAML config, point at their keys, and report an incomplete deprecation", async () => {
  const root = tree({
    "mizzen.yml": "title: T\napi:\n  version: v2\n  collections: {}\n  versions:\n    v1:\n      collections: {}\n      sunset: 2026-01-01\n",
  });
  try {
    const siteConfig = config({
      api: { version: "v2", collections: {}, versions: { v1: { collections: {}, sunset: "2026-01-01" } } },
    });
    const result = await discoverVersions({ root, config: siteConfig, version: "0.2.7" });
    const v2 = result.items.find((item) => item.id === "version:v2");
    const v1 = result.items.find((item) => item.id === "version:v1");
    assert.ok((v2?.source.line ?? 0) > 1, "v2 points at its version: key");
    assert.equal(v1?.stability, "stable");
    assert.equal(v1?.signature, "sunset 2026-01-01");
    assert.ok(result.findings.some((finding) => finding.code === "surface.version-deprecation"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site without an api key has no version items", async () => {
  const result = await discoverVersions({ root: "/tmp", config: config() });
  assert.deepEqual(result.items, []);
});

test("the surface output reports a coverage-below-minimum error and writes the file", async () => {
  const root = tree({
    "mizzen.yml": "title: S\nsurface:\n  package: pkg/index.ts\n  minCoverage: 99\n",
    "pkg/index.ts": "export const thing = 1;\n",
  });
  try {
    const { buildModel } = await import("../src/model/build.ts");
    const model = await buildModel(root);
    const reported: { id: string }[] = [];
    const files = await surfaceOutput.run(model.site, { renderPage: () => Promise.reject(new Error("no render")), build: { root, workers: 1 }, report: (d) => reported.push(d) });
    assert.ok(files.some((file) => file.path === "surface.json"));
    assert.ok(reported.some((finding) => finding.id === "surface.coverage-below-minimum"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the surface output writes nothing when the site does not declare it or has no build root", async () => {
  const site = (surface?: SiteConfig["surface"]) => ({
    config: config(surface === undefined ? {} : { surface }),
    pages: [], nav: {}, collections: {}, data: {},
  });
  assert.deepEqual(await surfaceOutput.run(site() as never, { renderPage: () => Promise.reject(new Error("no")), report: () => {} }), []);
  assert.deepEqual(await surfaceOutput.run(site({ adapters: [], docs: [], exclude: [] }) as never, { renderPage: () => Promise.reject(new Error("no")), report: () => {} }), []);
});
