import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../src/pipeline/build.ts";
import { run, site, write } from "./helpers-stale.ts";

/** A theme whose doc layout prints the page's stale state, so a test reads exactly what a layout sees. */
function theme(): string {
  const root = mkdtempSync(join(tmpdir(), "stale-page-theme-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "stale-theme", type: "module" }),
    "src/index.ts": 'export const theme = { name: "stale-theme", folders: ["layouts"] };\n',
    "layouts/doc.ts":
      "export default function doc({ page }) {\n" +
      '  return `<!DOCTYPE html>\\n<html lang="en"><body>${page.html}<p id="stale">${JSON.stringify(page.stale ?? null)}</p></body></html>\\n`;\n' +
      "}\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const FILES = {
  "mizzen.yml": 'title: T\ndefaults:\n  - path: ""\n    values:\n      layout: doc\n',
  "guide.md": "---\ntitle: Guide\ncovers: [src/x.ts]\n---\n# Guide\n",
  "other.md": "---\ntitle: Other\ncovers: [src/y.ts]\n---\n# Other\n",
  "src/x.ts": "x",
  "src/y.ts": "y",
};

function jsonBody(out: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(out, path), "utf8")) as Record<string, unknown>;
}

test("a page with covers reaches the layout and the page JSON with its stale state", async () => {
  const root = site(FILES);
  const themeRoot = theme();
  const out = mkdtempSync(join(tmpdir(), "stale-page-out-"));
  try {
    // No lock: there is nothing reviewed to hand to the theme or the page JSON.
    const first = await build({ root, out, themeRoot, defaultLayout: "doc" });
    assert.deepEqual(first.diagnostics.filter((d) => d.severity === "error"), []);
    assert.ok(readFileSync(join(out, "guide/index.html"), "utf8").includes('<p id="stale">null</p>'));
    assert.ok(!("stale" in jsonBody(out, "guide/index.json")));

    // One page is marked; the other is never reviewed. The marked page then changes.
    assert.equal((await run(["stale", "mark", "guide.md", "--site", root, "--date", "2026-01-01"])).code, 0);
    write(root, { "src/x.ts": "changed" });
    const second = await build({ root, out, themeRoot, defaultLayout: "doc" });
    assert.deepEqual(second.diagnostics.filter((d) => d.severity === "error"), []);
    assert.ok(readFileSync(join(out, "guide/index.html"), "utf8").includes('"reviewed":"2026-01-01"'));
    assert.deepEqual(jsonBody(out, "guide/index.json").stale, {
      reviewed: "2026-01-01",
      files: [{ path: "src/x.ts", change: "changed" }],
    });
    assert.deepEqual(jsonBody(out, "other/index.json").stale, { files: [{ path: "src/y.ts", change: "added" }] });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("a page without covers gets no stale state", async () => {
  const root = site({ "mizzen.yml": FILES["mizzen.yml"], "plain.md": "# Plain\n" });
  const themeRoot = theme();
  const out = mkdtempSync(join(tmpdir(), "stale-page-out-"));
  try {
    const result = await build({ root, out, themeRoot, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);
    assert.ok(readFileSync(join(out, "plain/index.html"), "utf8").includes('<p id="stale">null</p>'));
    assert.ok(!("stale" in jsonBody(out, "plain/index.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("a site in a repository subfolder still exposes stale state", async () => {
  const root = site({
    ...FILES,
    "mizzen.yml": `${FILES["mizzen.yml"]}source: docs\nrepository:\n  url: https://github.com/example/docs\n  dir: ./web/site/\n`,
    "docs/guide.md": FILES["guide.md"],
  });
  const themeRoot = theme();
  const out = mkdtempSync(join(tmpdir(), "stale-page-out-"));
  try {
    assert.equal((await run(["stale", "mark", "docs/guide.md", "--site", root, "--date", "2026-01-01"])).code, 0);
    write(root, { "src/x.ts": "changed" });
    const result = await build({ root, out, themeRoot, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);
    assert.match(readFileSync(join(out, "guide/index.html"), "utf8"), /"reviewed":"2026-01-01"/);
    assert.deepEqual(jsonBody(out, "guide/index.json").stale, {
      reviewed: "2026-01-01",
      files: [{ path: "src/x.ts", change: "changed" }],
    });
  } finally {
    for (const path of [root, themeRoot, out]) rmSync(path, { recursive: true, force: true });
  }
});

test("a covered file change misses the whole-build cache", async () => {
  const root = site(FILES);
  const themeRoot = theme();
  const out = mkdtempSync(join(tmpdir(), "stale-page-out-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "stale-page-cache-"));
  try {
    assert.equal((await run(["stale", "mark", "--all", "--site", root, "--date", "2026-01-01"])).code, 0);
    await build({ root, out, themeRoot, defaultLayout: "doc", cache: true, cacheDir });
    // The covered file changes while every source file stays the same: the output must not come from the cache.
    write(root, { "src/x.ts": "changed" });
    await build({ root, out, themeRoot, defaultLayout: "doc", cache: true, cacheDir });
    assert.deepEqual(jsonBody(out, "guide/index.json").stale, {
      reviewed: "2026-01-01",
      files: [{ path: "src/x.ts", change: "changed" }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
