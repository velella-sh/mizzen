import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";
import { buildModel } from "../src/model/build.ts";
import { sha256, storedPath, writeLock } from "../src/data/lock.ts";
import { build } from "../src/pipeline/build.ts";
import { cacheKey } from "../src/pipeline/cache.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-cache-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The cache key of a site, with empty theme and output folders. */
async function keyOf(root: string): Promise<string> {
  const { config } = loadConfig(root);
  const theme = mkdtempSync(join(tmpdir(), "data-cache-theme-"));
  const outputs = mkdtempSync(join(tmpdir(), "data-cache-outputs-"));
  try {
    return await cacheKey({
      root,
      sourceDir: resolve(root, config.source),
      config,
      themeRoot: theme,
      outputsDir: outputs,
    });
  } finally {
    rmSync(theme, { recursive: true, force: true });
    rmSync(outputs, { recursive: true, force: true });
  }
}

test("a site without collections keeps its key when only a lock file appears", async () => {
  const root = tree({ "mizzen.yml": "title: D\n", "index.md": "# Hi\n" });
  try {
    const before = await keyOf(root);
    writeFileSync(join(root, "mizzen.lock.json"), '{"version":1,"sources":{}}\n');
    assert.equal(await keyOf(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a collection source outside the discovered folder changes the key when its bytes change", async () => {
  const root = tree({
    "mizzen.yml": "title: D\nsource: docs\ncollections:\n  items:\n    source: data/items.yml\n",
    "docs/index.md": "# Hi\n",
    "data/items.yml": "- id: a\n  name: Alpha\n",
  });
  try {
    const first = await keyOf(root);
    writeFileSync(join(root, "data/items.yml"), "- id: a\n  name: Beta\n");
    const second = await keyOf(root);
    assert.notEqual(second, first);
    assert.equal(await keyOf(root), second, "an unchanged source keeps the key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package's installed source and version both change the key", async () => {
  const root = tree({
    "mizzen.yml": "title: D\ncollections:\n  items:\n    source: npm:pkg/items.yml\n",
    "index.md": "# Hi\n",
    "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }),
    "node_modules/pkg/items.yml": "- id: a\n",
  });
  try {
    const first = await keyOf(root);
    writeFileSync(join(root, "node_modules/pkg/items.yml"), "- id: b\n");
    const sourceChanged = await keyOf(root);
    assert.notEqual(sourceChanged, first);

    writeFileSync(join(root, "node_modules/pkg/package.json"), JSON.stringify({ name: "pkg", version: "1.0.1" }));
    const versionChanged = await keyOf(root);
    assert.notEqual(versionChanged, sourceChanged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lock and the stored bytes of a remote source are inputs", async () => {
  const bytes = "id\n1\n";
  const hash = sha256(bytes);
  const root = tree({
    "mizzen.yml": "title: D\ncollections:\n  items:\n    source: https://example.test/items.csv\n",
    "index.md": "# Hi\n",
  });
  try {
    const path = storedPath(root, hash);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    await writeLock(root, {
      version: 1,
      sources: {
        "https://example.test/items.csv": { address: "https://example.test/items.csv", bytes: bytes.length, sha256: hash },
      },
    });
    const first = await keyOf(root);
    writeFileSync(path, "id\n2\n");
    assert.notEqual(await keyOf(root), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a data change reaches the build hash when it changes a page", async () => {
  const root = tree({
    "mizzen.yml":
      "title: D\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
    "_data/greeting.yml": "text: Hello\n",
    "page.md": "# :data[greeting.text]\n",
  });
  try {
    const out = (name: string) => join(root, `_${name}`);
    const first = await build({ root, out: out("out-one"), themeRoot: THEME, defaultLayout: "doc" });
    const one = JSON.parse(readFileSync(join(out("out-one"), ".mizzen/manifest.json"), "utf8")) as {
      build: { hash: string };
    };
    assert.equal(first.files.includes("page/index.html"), true);

    writeFileSync(join(root, "_data/greeting.yml"), "text: Goodbye\n");
    await build({ root, out: out("out-two"), themeRoot: THEME, defaultLayout: "doc" });
    const two = JSON.parse(readFileSync(join(out("out-two"), ".mizzen/manifest.json"), "utf8")) as {
      build: { hash: string };
    };
    assert.notEqual(two.build.hash, one.build.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package file that links outside is refused, is not read, and does not change the key", async () => {
  const outside = mkdtempSync(join(tmpdir(), "data-cache-outside-"));
  const secret = join(outside, "secret.yml");
  writeFileSync(secret, "- id: before\n");
  const root = tree({
    "mizzen.yml": "collections:\n  items:\n    source: npm:pkg/items.yml\n",
    "index.md": "# Hi\n",
    "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }),
  });
  try {
    symlinkSync(secret, join(root, "node_modules/pkg/items.yml"));
    const before = await keyOf(root);
    const { config } = loadConfig(root);
    const result = await loadCollections({ root, config });
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.id), ["data.package-escape"]);
    assert.deepEqual(result.collections, {});

    const model = await buildModel(root);
    assert.ok(model.diagnostics.some((diagnostic) => diagnostic.id === "data.package-escape"));
    assert.equal(model.site.collections["items"], undefined);

    writeFileSync(secret, "- id: after\n");
    assert.equal(await keyOf(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
