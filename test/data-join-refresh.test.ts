import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "join-refresh-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) files.set(rel.split("\\").join("/"), createHash("sha256").update(readFileSync(abs)).digest("hex"));
  }
  return files;
}

const CONFIG = [
  "title: Joined",
  "collections:",
  "  catalog:",
  "    source: data/catalog.yml",
  "    id: sku",
  "    join:",
  "      type: left",
  "      key: sku",
  "      fields: {title: name, price: price}",
  "      sources:",
  "        - collection: inventory",
  "          key: sku",
  "          fields: {stock: stock}",
  "  inventory:",
  "    source: data/inventory.yml",
  "    id: sku",
  "",
].join("\n");

const CATALOG = "- sku: a\n  name: Alpha\n  price: 10\n- sku: b\n  name: Beta\n  price: 20\n";

test("a changed or deleted secondary row gives the same output in incremental and full builds", async () => {
  const root = tree({
    "mizzen.yml": CONFIG,
    "index.md": "---\ntitle: Home\nlist:\n  collection: catalog\n  fields: [title, price, stock]\n---\n# Home\n",
    "data/catalog.yml": CATALOG,
    "data/inventory.yml": "- sku: a\n  stock: 5\n- sku: b\n  stock: 7\n",
  });
  const parent = mkdtempSync(join(tmpdir(), "join-refresh-out-"));
  const cacheDir = join(parent, "cache");
  try {
    await build({ root, out: join(parent, "full-one"), themeRoot: THEME, defaultLayout: "doc" });
    await build({ root, out: join(parent, "cached-one"), themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
    assert.deepEqual(snapshot(join(parent, "cached-one")), snapshot(join(parent, "full-one")), "the first cached build equals a full build");

    writeFileSync(join(root, "data/inventory.yml"), "- sku: a\n  stock: 50\n- sku: b\n  stock: 7\n");
    await build({ root, out: join(parent, "cached-changed"), themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
    await build({ root, out: join(parent, "full-changed"), themeRoot: THEME, defaultLayout: "doc" });
    const changed = snapshot(join(parent, "cached-changed"));
    assert.notDeepEqual(changed, snapshot(join(parent, "cached-one")), "the secondary change reached the written site");
    assert.deepEqual(changed, snapshot(join(parent, "full-changed")), "an incremental build after the change agrees with a full build");

    writeFileSync(join(root, "data/inventory.yml"), "- sku: b\n  stock: 7\n");
    await build({ root, out: join(parent, "cached-deleted"), themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
    await build({ root, out: join(parent, "full-deleted"), themeRoot: THEME, defaultLayout: "doc" });
    const deleted = snapshot(join(parent, "cached-deleted"));
    assert.notDeepEqual(deleted, changed, "the deleted secondary row reached the written site");
    assert.deepEqual(deleted, snapshot(join(parent, "full-deleted")), "an incremental build after the deletion agrees with a full build");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
