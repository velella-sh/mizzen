import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build, type BuildResult } from "../src/pipeline/build.ts";
import { readTree } from "./data-api-build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const OUT = ["urls.json", "data/packages.index.json", "api/v1/index.json", "api/v1/packages/node.json", "packages/node/index.html"];

/** The collection's files at one schema version; the permalink and the published fields stay the same. */
function files(schema: Record<string, unknown>, records: string, config: readonly string[] = []): Record<string, string> {
  return {
    "mizzen.yml": [
      "title: Example",
      "url: https://example.test",
      "base: /docs",
      "collections:",
      "  packages:",
      "    source: _data/packages.yml",
      "    template: _templates/package.md",
      "    permalink: /packages/{id}/",
      "    schema: schemas/packages.json",
      "    index:",
      "      fields: [id, name]",
      ...config,
      "api:",
      "  version: v1",
      "  collections:",
      "    packages:",
      "      fields: [name]",
      "",
    ].join("\n"),
    "_data/packages.yml": records,
    "schemas/packages.json": JSON.stringify(schema),
    "_templates/package.md": "---\ntitle: Package\nlayout: doc\n---\n\n# Package\n",
  };
}

const V1 = files(
  { type: "object", required: ["name"], properties: { id: { type: "string" }, name: { type: "string" }, secret: { type: "string" } } },
  "- id: node\n  name: Node\n  secret: a\n- id: deno\n  name: Deno\n  secret: b\n",
);

// The schema version adds an optional field and renames an unpublished one; the ids and page URLs do not move.
const V2 = files(
  {
    type: "object",
    required: ["name"],
    properties: { id: { type: "string" }, name: { type: "string" }, note: { type: "string" }, eol: { type: "string" } },
  },
  "- id: node\n  name: Node\n  note: a\n  eol: '2028-04-30'\n- id: deno\n  name: Deno\n  note: b\n  eol: '2030-01-01'\n",
  ["    schemaRenames:", "      note: secret"],
);

async function buildSite(root: string, out: string, updateUrls: boolean): Promise<BuildResult> {
  return build({ root, out, themeRoot: THEME, defaultLayout: "doc", ...(updateUrls ? { updateUrls: true } : {}) });
}

test("a schema version change keeps every public output address and version", async () => {
  const root = mkdtempSync(join(tmpdir(), "data-schema-outputs-"));
  const out = mkdtempSync(join(tmpdir(), "data-schema-outputs-out-"));
  try {
    const write = (tree: Record<string, string>): void => {
      for (const [path, text] of Object.entries(tree)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
    };

    write(V1);
    const before = await buildSite(root, out, true);
    assert.deepEqual(before.diagnostics.filter((d) => d.severity === "error"), []);
    const first = readTree(out);
    const firstLock = readFileSync(join(root, "urls.lock.json"), "utf8");

    write(V2);
    const after = await buildSite(root, out, false);
    assert.deepEqual(after.diagnostics.filter((d) => d.id.startsWith("urls.")), [], "a schema change must not move a URL silently");
    const second = readTree(out);

    for (const path of OUT) assert.ok(second.has(path), `${path} is still written`);
    assert.equal(readFileSync(join(root, "urls.lock.json"), "utf8"), firstLock, "the URL lock is unchanged");
    assert.equal(second.get("packages/node/index.html"), first.get("packages/node/index.html"), "the record page is unchanged");
    assert.equal(second.get("api/v1/packages/node.json"), first.get("api/v1/packages/node.json"), "the API record keeps its URL");
    assert.equal(second.get("data/packages.index.json"), first.get("data/packages.index.json"), "the collection index is unchanged");

    const urls = (text: string | undefined): Record<string, unknown> => JSON.parse(text ?? "") as Record<string, unknown>;
    const oldMap = urls(first.get("urls.json"));
    const newMap = urls(second.get("urls.json"));
    assert.equal(oldMap.version, 1);
    assert.equal(newMap.version, 1);
    assert.deepEqual(newMap.collections, oldMap.collections);
    assert.deepEqual(newMap.collections, {
      packages: { deno: "https://example.test/docs/packages/deno/", node: "https://example.test/docs/packages/node/" },
    });

    const oldIndex = urls(first.get("api/v1/index.json"));
    const newIndex = urls(second.get("api/v1/index.json"));
    assert.equal(newIndex.version, "v1");
    assert.deepEqual(newIndex.collections, oldIndex.collections, "the v1 API still publishes the same entry points");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
