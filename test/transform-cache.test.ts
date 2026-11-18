import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";
import { build } from "../src/pipeline/build.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "transform-cache-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A theme whose one layout writes the page body, so a build needs no real theme. */
function makeTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "transform-cache-theme-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), 'export const theme = { name: "transform-cache", folders: ["layouts"] };\n');
  writeFileSync(
    join(root, "layouts/doc.ts"),
    'import { h } from "preact";\nimport type { Layout } from "@velella/mizzen/contracts";\nconst doc: Layout = (props) => h("html", null, h("body", null, h("div", { dangerouslySetInnerHTML: { __html: props.page.html } })));\nexport default doc;\n',
  );
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

const config = (factor: number) => [
  "title: Transformed",
  "collections:",
  "  items:",
  "    source: data/items.yml",
  "    id: slug",
  "    transform:",
  "      steps:",
  "        - id: price",
  "          op: unit",
  "          field: price",
  "          factor: " + factor,
  "          round: 0",
  "",
].join("\n");

test("a rule change refreshes the output and a cached build matches a full build", async () => {
  const root = tree({
    "mizzen.yml": config(100),
    "index.md": "---\ntitle: Home\n---\n# Home\n",
    "data/items.yml": "- slug: a\n  price: 2.5\n",
  });
  const theme = makeTheme();
  const parent = mkdtempSync(join(tmpdir(), "transform-cache-out-"));
  const cacheDir = join(parent, "cache");
  try {
    const full = join(parent, "full");
    const cached = join(parent, "cached");
    const rebuilt = join(parent, "rebuilt");
    await build({ root, out: full, themeRoot: theme, defaultLayout: "doc" });
    await build({ root, out: cached, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.deepEqual(snapshot(cached), snapshot(full), "the first cached build equals a full build");

    writeFileSync(join(root, "mizzen.yml"), config(200));
    await build({ root, out: rebuilt, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    const fullAfter = join(parent, "full-after");
    await build({ root, out: fullAfter, themeRoot: theme, defaultLayout: "doc" });

    assert.notDeepEqual(snapshot(rebuilt), snapshot(cached), "a rule change changed the written site");
    assert.deepEqual(snapshot(rebuilt), snapshot(fullAfter), "the incremental build after the rule change agrees with a full build");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the loaded config carries each rule, so the build key differs when a rule changes", async () => {
  const root = tree({ "mizzen.yml": config(100), "data/items.yml": "- slug: a\n  price: 2\n" });
  try {
    const first = loadConfig(root).config;
    assert.equal(first.collections["items"]!.transform?.steps.length, 1);
    writeFileSync(join(root, "mizzen.yml"), config(200));
    const second = loadConfig(root).config;
    assert.notDeepEqual(second.collections["items"]!.transform, first.collections["items"]!.transform);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
