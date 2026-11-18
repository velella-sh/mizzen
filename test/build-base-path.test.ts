// One source built twice under two preview bases: the pages, their links, their assets, and the manifest follow
// whichever base the build was given, never the config's.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../src/pipeline/build.ts";

/** Writes `files` under `root`, creating their folders. */
function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

test("two preview base paths give two builds their own links, assets, and manifest", async () => {
  const parent = mkdtempSync(join(tmpdir(), "build-base-path-"));
  try {
    const theme = join(parent, "theme");
    tree(theme, {
      "src/index.ts": 'export const theme = { name: "t", folders: ["layouts"] };\n',
      "layouts/doc.ts":
        'export default (p: any) => `<html><head><title>${p.page.title}</title></head><body><a href="${p.page.url}">${p.page.title}</a>${p.page.html}</body></html>`;\n',
      "layouts/doc.css": ".doc { color: red; }\n",
    });
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Preview\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });

    // A trailing or leading slash is normalized away, so each form names the same path.
    for (const preview of ["/preview/pr-1/", "preview/pr-2"]) {
      const base = `/${preview.replace(/^\/+|\/+$/g, "")}`;
      const out = join(parent, base.replace(/\W/g, "-"));
      const result = await build({ root: site, out, themeRoot: theme, defaultLayout: "doc", basePath: preview });
      assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);

      const html = readFileSync(join(out, "index.html"), "utf8");
      assert.match(html, new RegExp(`<a href="${base}/">Home</a>`), "the page link carries its own base");
      const css = new RegExp(`<link rel="stylesheet" href="${base}/(assets/theme/page-[0-9a-f]{16}\\.css)">`).exec(html);
      assert.ok(css, "the page CSS is linked under its own base");
      assert.ok(existsSync(join(out, css[1]!)), "the hashed CSS is written");

      const manifest = JSON.parse(readFileSync(join(out, ".mizzen/manifest.json"), "utf8")) as {
        pages: { url: string; outputs: readonly string[] }[];
      };
      assert.deepEqual(manifest.pages.map((page) => page.url), [`${base}/`], "the manifest URL carries the base");
      assert.ok(
        manifest.pages[0]!.outputs.every((path) => !path.startsWith("/")),
        "output paths stay relative to the folder that deploys under the base",
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
