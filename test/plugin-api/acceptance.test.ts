/**
 * The published plugin example end to end: the three plugins load through the public contract, their effects reach the
 * written site, and a repeated or incremental build writes the bytes of a full build. The example is copied first, so a
 * build never writes a cache into `examples/`.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BuildResult } from "../../src/pipeline/build.ts";
import { build } from "../../src/pipeline/build.ts";
import { loadCodeConfig } from "../../src/plugins/hooks.ts";

const EXAMPLE = fileURLToPath(new URL("../../examples/plugin-api/", import.meta.url));
const THEME = fileURLToPath(new URL("../../../lateen/", import.meta.url));

/** A copy of the example under `parent`, so the build's output and cache stay out of the repository. */
function copyOfExample(parent: string): string {
  const root = join(parent, "site");
  cpSync(EXAMPLE, root, { recursive: true });
  return root;
}

/** Every file under `dir` as path → bytes, so two builds can be compared byte for byte. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, entry);
    if (statSync(abs).isFile()) files.set(relative(dir, abs).split("\\").join("/"), readFileSync(abs, "latin1"));
  }
  return files;
}

function errorsOf(result: BuildResult): readonly unknown[] {
  return result.diagnostics.filter((finding) => finding.severity === "error");
}

test("the example's code file lists the three plugins through the public contract", async () => {
  const loaded = await loadCodeConfig(EXAMPLE);
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(
    loaded.plugins.map((plugin) => plugin.name),
    ["check-descriptions", "number-sections", "write-page-index"],
  );
});

test("the example's validator, Markdown transform, and custom output each reach the written site", async () => {
  const parent = mkdtempSync(join(tmpdir(), "plugin-api-example-"));
  const root = copyOfExample(parent);
  try {
    const result = await build({ root, out: join(parent, "out"), themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(errorsOf(result), []);

    const index = readFileSync(join(parent, "out", "index.html"), "utf8");
    assert.match(index, /<h2[^>]*>1\. What the plugins do<\/h2>/u, "the Markdown hook numbered the section");

    const inventory = readFileSync(join(parent, "out", "plugin-api", "pages.json"), "utf8");
    assert.deepEqual(JSON.parse(inventory), [
      { url: "/", title: "Plugin API example" },
      { url: "/guide/writing/", title: "Write a plugin" },
    ]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the example's validator warns at the page that has no description", async () => {
  const parent = mkdtempSync(join(tmpdir(), "plugin-api-validator-"));
  const root = copyOfExample(parent);
  try {
    const page = join(root, "guide", "writing.md");
    writeFileSync(page, readFileSync(page, "utf8").replace(/^description: .*\n/mu, ""));

    const result = await build({ root, out: join(parent, "out"), themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(errorsOf(result), [], "a warning does not fail the build");
    const finding = result.diagnostics.find((diagnostic) => diagnostic.id === "example.missing-description");
    assert.ok(finding, JSON.stringify(result.diagnostics, null, 2));
    assert.equal(finding.severity, "warning");
    assert.equal(finding.pos?.file, "guide/writing.md");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("repeated and incremental builds of the example write a full build's bytes", async () => {
  const parent = mkdtempSync(join(tmpdir(), "plugin-api-builds-"));
  const root = copyOfExample(parent);
  const out = join(parent, "out");
  const full = join(parent, "full");
  const cacheDir = join(parent, "cache");
  try {
    const first = await build({ root, out: full, themeRoot: THEME, defaultLayout: "doc" });
    const reference = snapshot(full);

    const repeated = await build({ root, out: join(parent, "repeated"), themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(errorsOf(repeated), []);
    assert.deepEqual(snapshot(join(parent, "repeated")), reference, "a second full build is byte for byte the first");

    await build({ root, out, themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
    assert.deepEqual(snapshot(out), reference, "a cold cached build matches the full build");
    const unchanged = await build({ root, out, themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(unchanged.renderedPages, 0, "an unchanged rebuild is a whole-build cache hit");
    assert.deepEqual(snapshot(out), reference);

    const index = join(root, "index.md");
    writeFileSync(index, `${readFileSync(index, "utf8")}\nAn edit, so the next build must do work.\n`);
    const incremental = await build({ root, out, themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
    assert.deepEqual(errorsOf(incremental), []);

    const edited = join(parent, "edited");
    await build({ root, out: edited, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(snapshot(out), snapshot(edited), "the incremental build equals a full build of the edited site");
    assert.notDeepEqual(snapshot(out), reference, "the edit reached the output");
    assert.match(readFileSync(join(out, "index.html"), "utf8"), /An edit, so the next build must do work\./u);

    assert.deepEqual(repeated.files, first.files);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
