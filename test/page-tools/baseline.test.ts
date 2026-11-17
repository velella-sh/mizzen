/**
 * Baseline for a browser tool on a documentation site with a base path. No engine change: this records what the two
 * current mechanisms write, and the gap the page-tools epic has to close.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../../src/pipeline/build.ts";

function tree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** The smallest theme that can carry a client module: one layout and one component with `client.ts`. */
const THEME = {
  "src/index.ts": 'export const theme = { name: "baseline", folders: ["layouts", "components"] };\n',
  "layouts/doc.ts": `export default (p: any) =>
  \`<html><head><title>\${p.page.title}</title></head><body><main>\${p.page.html}</main>\${p.islands
    .map((i: any) => \`<script type="module" src="\${i.src}"></script>\`)
    .join("")}</body></html>\`;
`,
  "components/sample-tool/index.ts": `export const directive = "sample-tool";
export default (p: any) => \`<div data-sample-tool data-input="\${p.props.input ?? ""}">Loading</div>\`;
`,
  "components/sample-tool/client.ts": `const root = document.querySelector("[data-sample-tool]");
const input: string | null = root?.getAttribute("data-input") ?? null;
if (root && input) {
  fetch(input).then((r) => r.json()).then((data: { rows: number }) => {
    root.textContent = String(data.rows);
  });
}
`,
};

/** A standalone tool: its own page, a browser module, and the local input that module reads. */
const TOOL = {
  "tool/index.html": `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sample tool</title><script src="tool.js" defer></script></head>
<body><main><h1>Sample tool</h1><p id="out">Loading</p></main></body>
</html>
`,
  "tool/tool.js": 'fetch("data.json").then((r) => r.json()).then((data) => { document.getElementById("out").textContent = String(data.rows); });\n',
  "tool/data.json": '{"rows": 2}\n',
};

test("under a base path the theme module carries the base, while the local tool is copied unchanged and stays unlinked", async () => {
  const parent = mkdtempSync(join(tmpdir(), "page-tools-baseline-"));
  try {
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Sample\nbase: /sample\n",
      "index.md": "---\ntitle: Tool\nlayout: doc\n---\n\n:::sample-tool{input=\"/sample/tool/data.json\"}\nThis page stays readable without the tool.\n:::\n",
      "plain.md": "---\ntitle: Plain\nlayout: doc\n---\n\nNo tool here.\n",
      ...TOOL,
    });
    const theme = join(parent, "theme");
    tree(theme, THEME);
    const out = join(parent, "out");

    const result = await build({ root: site, out, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);

    // The browser-module mechanism: only the theme's client.ts becomes a module, written under the base.
    const island = "assets/theme/islands/components/sample-tool/client.js";
    const islandUrl = `/sample/${island}`;
    assert.ok(result.files.includes(island), island);
    assert.match(readFileSync(join(out, "index.html"), "utf8"), new RegExp(`<script type="module" src="${islandUrl}"></script>`));
    assert.doesNotMatch(readFileSync(join(out, "plain/index.html"), "utf8"), /assets\/theme\/islands|sample-tool/);
    const module = readFileSync(join(out, island), "utf8");
    assert.match(module, /data-sample-tool/);
    assert.doesNotMatch(module, /: string \| null/, "types are stripped before the module is written");

    // The asset mechanism: the local tool and its input are copied byte for byte, with their relative URLs intact.
    for (const path of ["tool/index.html", "tool/tool.js", "tool/data.json"]) {
      assert.ok(result.files.includes(path), path);
      assert.deepEqual(readFileSync(join(out, path)), readFileSync(join(site, path)), path);
    }
    assert.match(readFileSync(join(out, "tool/index.html"), "utf8"), /<script src="tool\.js"/);
    assert.doesNotMatch(readFileSync(join(out, "tool/index.html"), "utf8"), /\/sample\//, "the copy is not base-aware");

    // The gap: the page loads a theme module, not the site's own tool module or input. Nothing in the build ties
    // `tool/` to the page, so a tool that needs the page's markup and chrome has no place to live.
    const page = readFileSync(join(out, "index.html"), "utf8");
    assert.doesNotMatch(page, /tool\.js/, "the page does not load the site's own browser module");
    assert.equal(result.files.includes("tool/index.html"), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
