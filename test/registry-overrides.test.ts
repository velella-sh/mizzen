import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../src/pipeline/build.ts";
import { loadRegistry } from "../src/render/registry.ts";

/** Writes `files` under `root`, creating their folders. */
function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const THEME = {
  "src/index.ts": 'export const theme = { name: "t", folders: ["layouts", "chrome", "components"] };\n',
  "layouts/doc.ts": 'export default () => "theme doc";\n',
  "layouts/doc.css": ".doc { color: red; }\n",
  "chrome/header/index.ts": 'export default () => "theme header";\n',
  "components/badge/index.ts": 'export const directive = "badge";\nexport default () => "theme badge";\n',
};

test("an override replaces its unit and every other unit keeps the theme's", async () => {
  const parent = mkdtempSync(join(tmpdir(), "registry-overrides-"));
  try {
    tree(join(parent, "theme"), THEME);
    tree(join(parent, "site"), {
      "theme/doc.ts": 'export default () => "site doc";\n',
      "theme/badge.ts": 'export const directive = "badge";\nexport default () => "site badge";\n',
    });
    const registry = await loadRegistry(join(parent, "theme"), {
      siteRoot: join(parent, "site"),
      overrides: { layouts: { doc: "theme/doc.ts" }, components: { badge: "theme/badge.ts" } },
    });

    assert.deepEqual(registry.diagnostics, []);
    assert.equal(registry.layouts.doc?.file, "theme/doc.ts");
    assert.equal(registry.layouts.doc?.layout({} as never), "site doc");
    assert.equal(registry.layouts.doc?.css, undefined, "a replaced layout brings its own CSS");
    assert.equal(registry.components.badge?.component({} as never), "site badge");
    assert.equal(registry.components.badge?.directive, "badge");

    assert.equal(registry.chrome.header?.file, "chrome/header/index.ts");
    assert.equal(registry.chrome.header?.chrome({} as never), "theme header");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an override naming no unit, naming no file, or leaving the site root is an error", async () => {
  const parent = mkdtempSync(join(tmpdir(), "registry-overrides-bad-"));
  try {
    tree(join(parent, "theme"), THEME);
    const site = join(parent, "site");
    tree(site, { "outside.ts": 'export default () => "outside";\n' });
    const registry = await loadRegistry(join(parent, "theme"), {
      siteRoot: site,
      overrides: {
        layouts: { nosuch: "outside.ts", doc: "missing.ts" },
        components: { badge: "../outside.ts" },
      },
    });

    const ids = registry.diagnostics.map((d) => d.id).sort();
    assert.deepEqual(ids, ["registry.override-missing", "registry.override-outside", "registry.override-unknown"]);
    assert.match(registry.diagnostics.find((d) => d.id === "registry.override-outside")?.message ?? "", /leaves the site root/);
    assert.equal(registry.layouts.doc?.file, "layouts/doc.ts", "a missing override leaves the theme's unit in place");
    assert.equal(registry.components.badge?.file, "components/badge/index.ts");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the site config's overrides reach the build", async () => {
  const parent = mkdtempSync(join(tmpdir(), "build-overrides-"));
  try {
    tree(join(parent, "theme"), THEME);
    tree(join(parent, "site"), {
      "mizzen.yml": `title: Overrides\nbase: /docs\ntheme:\n  overrides:\n    layouts:\n      doc: theme/doc.ts\n    components:\n      badge: theme/badge.ts\n`,
      "theme/doc.ts":
        'export default (p: any) => `<html><head><title>${p.page.title}</title></head><body><main>${p.page.html}</main></body></html>`;\n',
      "theme/badge.ts": 'export const directive = "badge";\nexport default ({ props }: any) => `<b class="site-badge">${props.label}</b>`;\n',
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\n::badge{label=new}\n",
    });
    const out = join(parent, "out");
    const result = await build({ root: join(parent, "site"), out, themeRoot: join(parent, "theme"), defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);

    const html = readFileSync(join(out, "index.html"), "utf8");
    assert.match(html, /<main>/);
    assert.match(html, /<b class="site-badge"[^>]*>new<\/b>/);
    assert.doesNotMatch(html, /theme doc|theme badge/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
