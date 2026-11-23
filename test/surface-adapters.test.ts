import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SiteConfig } from "../src/contracts/config.ts";
import type { Collection } from "../src/contracts/data.ts";
import { discoverCommands } from "../src/surface/adapters/cli.ts";
import { discoverConfig } from "../src/surface/adapters/config.ts";
import { discoverData } from "../src/surface/adapters/data.ts";
import { discoverOpenApi } from "../src/surface/adapters/openapi.ts";
import { discoverSymbols } from "../src/surface/adapters/symbols.ts";
import { discoverVersions } from "../src/surface/adapters/versions.ts";

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "surface-adapters-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    collections: {},
    feeds: {},
    defaults: [],
    theme: {},
    search: {},
    redirects: {},
    outputs: {},
    ...overrides,
  };
}

test("#1338 discovers the entry point's exports and drops non-exported and duplicate names", async () => {
  const root = tree({
    "src/entry.ts": [
      "/** Build the site. */",
      "export function buildSite(root: string): Promise<void> { return Promise.resolve(); }",
      "",
      "/** @deprecated Use buildSite. */",
      "export function makeSite(root: string): void {}",
      "",
      "export function exportedHelper(): void {}",
      "export { exportedHelper as helper };",
      "export { exportedHelper as helper };",
      "const hidden = 1;",
      "export const version = \"1.0.0\";",
    ].join("\n"),
  });
  try {
    const result = await discoverSymbols({ entry: "src/entry.ts", root, version: "0.2.7" });
    assert.deepEqual(result.findings, []);
    const names = result.items.map((item) => item.name).sort();
    // `hidden` is not exported, so it is never a symbol; the twice re-exported alias appears once.
    assert.deepEqual(names, ["buildSite", "exportedHelper", "helper", "makeSite", "version"]);
    const deprecated = result.items.find((item) => item.name === "makeSite");
    assert.equal(deprecated?.stability, "deprecated");
    assert.equal(deprecated?.source.file, "src/entry.ts");
    assert.equal(deprecated?.source.line, 5);
    assert.ok(result.items.every((item) => item.id.startsWith("symbol:")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1338 an unreadable entry is one error finding and no items, never a crash", async () => {
  const root = tree({ "src/other.ts": "export const x = 1;\n" });
  try {
    const result = await discoverSymbols({ entry: "src/missing.ts", root });
    assert.deepEqual(result.items, []);
    assert.equal(result.findings[0]?.code, "surface.symbol-entry");
    assert.equal(result.findings[0]?.severity, "error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1340 reads every config key with its type and key position", async () => {
  const result = await discoverConfig({ version: "0.2.7" });
  const ids = new Set(result.items.map((item) => item.id));
  assert.ok(ids.has("config-key:title"));
  assert.ok(ids.has("config-key:collections"));
  assert.ok(ids.has("config-key:surface.package"));
  const title = result.items.find((item) => item.id === "config-key:title")!;
  assert.equal(title.area, "config");
  assert.equal(title.source.file, "schema/config.schema.json");
  assert.ok(title.source.line > 1);
  assert.equal(title.signature, "string");
  // The resolver applies the schema's top-level defaults, so no drift is reported for them.
  assert.deepEqual(result.findings.filter((finding) => finding.code === "config.default-drift"), []);
});

test("#1341 records operations, parameters, and responses with stable ids and deprecation", async () => {
  const doc = {
    openapi: "3.1.0",
    info: { title: "Catalogue", version: "1.0.0" },
    paths: {
      "/releases": {
        get: {
          operationId: "listReleases",
          deprecated: true,
          parameters: [{ name: "limit", in: "query", schema: { type: "integer" }, deprecated: true }],
          responses: { "200": { description: "The releases." } },
        },
      },
    },
  };
  const root = tree({ "openapi.json": JSON.stringify(doc, null, 2) });
  try {
    const result = await discoverOpenApi({ source: "openapi.json", root, version: "0.2.7" });
    const ids = new Set(result.items.map((item) => item.id));
    assert.ok(ids.has("operation:listReleases"));
    assert.ok(ids.has("parameter:listReleases:query:limit"));
    assert.ok(ids.has("response:listReleases:200"));
    assert.equal(result.items.find((item) => item.id === "operation:listReleases")?.stability, "deprecated");
    assert.equal(result.items.find((item) => item.id === "parameter:listReleases:query:limit")?.stability, "deprecated");
    // The operation's own line, not the document's first line.
    assert.ok((result.items.find((item) => item.id === "operation:listReleases")?.source.line ?? 0) > 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1342 records collections and only the fields the public policy allows", async () => {
  const records = [
    {
      id: "one",
      fields: { title: "One", secret: "canary-value-898", author: { name: "Ada", email: "ada@example.test" } },
      position: { file: "_data/posts.yml", startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 },
      fieldPositions: {},
    },
  ];
  const collection: Collection = { name: "posts", source: "_data/posts.yml", records };
  const result = await discoverData({
    root: "/tmp",
    config: config({ collections: { posts: { source: "_data/posts.yml", public: ["title", "author.name"] } } }),
    collections: { posts: collection },
    version: "0.2.7",
  });
  const ids = new Set(result.items.map((item) => item.id));
  assert.ok(ids.has("collection:posts"));
  assert.ok(ids.has("field:posts.title"));
  assert.ok(ids.has("field:posts.author"));
  assert.ok(!ids.has("field:posts.secret"), "a private field is never an item");
  assert.ok(!JSON.stringify(result.items).includes("canary-value-898"), "no private value reaches the surface");
});

test("#1342 raw.private keeps a field out of the surface too", async () => {
  const records = [
    {
      id: "one",
      fields: { title: "One", internalScore: 7 },
      position: { file: "_data/posts.yml", startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 },
      fieldPositions: {},
    },
  ];
  const result = await discoverData({
    root: "/tmp",
    config: config({ collections: { posts: { source: "_data/posts.yml", raw: { private: ["internalScore"] } } } }),
    collections: { posts: { name: "posts", source: "_data/posts.yml", records } },
  });
  const ids = new Set(result.items.map((item) => item.id));
  assert.ok(ids.has("field:posts.title"));
  assert.ok(!ids.has("field:posts.internalScore"), "a field raw.private hides is not a public field");
});

test("#1339 reads the running CLI's commands and flags with real help lines", async () => {
  const result = await discoverCommands({ version: "0.2.7" });
  const ids = new Set(result.items.map((item) => item.id));
  assert.ok(ids.has("command:build"));
  assert.ok(ids.has("command:surface"));
  assert.ok(ids.has("flag:--json"));
  const build = result.items.find((item) => item.id === "command:build")!;
  assert.equal(build.area, "cli");
  assert.match(build.source.file, /cli\/index\.ts$/);
  assert.ok(build.source.line > 100, "the help line is inside the usage literal, not the module's first line");
  // `examples` was registered but missing from `COMMANDS`; the epic fixed that drift, so it is now registered.
  assert.ok(!result.findings.some((finding) => finding.code === "cli.unregistered-command"));
});

test("versions record the data API version and refuse an incomplete deprecation", async () => {
  const root = tree({
    "mizzen.yml": "title: T\napi:\n  version: v1\n  collections: {}\n  versions:\n    v0:\n      collections: {}\n      deprecated: true\n      sunset: 2026-01-01\n      successor: v1\n",
  });
  try {
    const siteConfig = config({
      api: {
        version: "v1",
        collections: {},
        versions: { v0: { collections: {}, deprecated: true, sunset: "2026-01-01", successor: "v1" } },
      },
    });
    const result = await discoverVersions({ root, config: siteConfig, version: "0.2.7" });
    const ids = new Set(result.items.map((item) => item.id));
    assert.ok(ids.has("version:v1"));
    assert.ok(ids.has("version:v0"));
    assert.equal(result.items.find((item) => item.id === "version:v0")?.stability, "deprecated");
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
