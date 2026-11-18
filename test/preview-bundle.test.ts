// #844: a preview packages its output into one folder a host can serve, with a manifest of the base and build hash.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { bundle } from "../scripts/bundle.ts";
import { build } from "../src/pipeline/build.ts";

/** Writes `files` under `root`, creating their folders. */
function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A theme with one layout, so a build needs nothing else. */
function theme(root: string): string {
  const dir = join(root, "theme");
  tree(dir, {
    "src/index.ts": 'export const theme = { name: "t", folders: ["layouts"] };\n',
    "layouts/doc.ts":
      'export default (p: any) => `<html><head><title>${p.page.title}</title></head><body>${p.page.html}</body></html>`;\n',
  });
  return dir;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("a preview bundle carries its files, base, and build hash, the same bytes every run", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preview-bundle-"));
  try {
    const themeRoot = theme(parent);
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Preview\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
      "guide.md": "---\ntitle: Guide\nlayout: doc\n---\n\nGuide\n",
    });
    const out = join(parent, "out");
    const built = await build({
      root: site,
      out,
      themeRoot,
      defaultLayout: "doc",
      basePath: "/preview/pr-1",
      preview: { canonicalBase: "https://preview.example.com/" },
    });
    const manifest = JSON.parse(readFileSync(join(out, ".mizzen/manifest.json"), "utf8")) as {
      base: string;
      build: { hash: string };
    };

    const bundleDir = join(parent, "bundle");
    const result = await bundle(out, bundleDir);

    assert.equal(result.base, "/preview/pr-1");
    assert.equal(result.buildHash, manifest.build.hash, "the manifest's build hash wins");
    assert.equal(result.base, manifest.base);

    const paths = Object.keys(result.files);
    assert.ok(paths.length > 0, "the output has files");
    assert.ok(!paths.some((path) => path.startsWith(".mizzen/")), "no .mizzen file is packaged");
    assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "paths are sorted");
    for (const path of paths) {
      const bytes = readFileSync(join(bundleDir, "files", path));
      assert.equal(result.files[path], sha256(bytes), `${path} hashes its own bytes`);
      assert.deepEqual(bytes, readFileSync(join(out, path)), `${path} is copied unchanged`);
    }
    assert.equal(paths.includes("index.html"), true, "the pages are copied");
    assert.equal(existsSync(join(bundleDir, "files", ".mizzen")), false, "the .mizzen folder is not copied");

    const first = readFileSync(join(bundleDir, "bundle.json"), "utf8");
    assert.deepEqual(JSON.parse(first), { version: 1, ...result });
    await bundle(out, bundleDir);
    assert.equal(readFileSync(join(bundleDir, "bundle.json"), "utf8"), first, "a second run writes the same bytes");
    assert.equal(built.diagnostics.filter((d) => d.severity === "error").length, 0, "the preview builds cleanly");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("bundle refuses a folder that is not a recorded build", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preview-bundle-refuse-"));
  try {
    await assert.rejects(bundle(join(parent, "nothing"), join(parent, "bundle")), /no readable/);

    const old = join(parent, "old");
    tree(old, { ".mizzen/manifest.json": `${JSON.stringify({ version: 1, pages: [] })}\n` });
    await assert.rejects(bundle(old, join(parent, "bundle")), /does not record a base/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
