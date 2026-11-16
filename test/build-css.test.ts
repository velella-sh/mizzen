import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../src/pipeline/build.ts";

function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

test("a build links hashed base and per-page CSS under base, and writes the files and the fonts they name", async () => {
  const parent = mkdtempSync(join(tmpdir(), "build-css-"));
  try {
    const theme = join(parent, "theme");
    tree(theme, {
      "src/index.ts": 'export const theme = { name: "t", folders: ["layouts", "chrome", "styles"] };\n',
      "layouts/doc.ts": 'export default (p: any) => `<html><head><title>${p.page.title}</title></head><body>${p.page.html}</body></html>`;\n',
      "layouts/doc.css": ".layout { color: red; }\n",
      "chrome/header/index.ts": "export default () => '';\n",
      "chrome/header/style.css": ".header { margin: 0; }\n",
      "styles/base.css": '@font-face { font-family: F; src: url("../fonts/f.woff2"); }\nbody { margin: 0; }\n',
      "fonts/f.woff2": "font-bytes",
    });
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: T\nbase: /docs\nurl: https://example.com\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });
    const out = join(parent, "out");
    const result = await build({ root: site, out, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);

    const html = readFileSync(join(out, "index.html"), "utf8");
    const links = [...html.matchAll(/<link rel="stylesheet" href="\/docs\/(assets\/theme\/[^"]+\.css)">/g)].map((m) => m[1]!);
    assert.equal(links.length, 2);
    assert.match(links[0]!, /^assets\/theme\/base-[0-9a-f]{16}\.css$/);
    assert.match(links[1]!, /^assets\/theme\/page-[0-9a-f]{16}\.css$/);
    for (const link of links) {
      assert.ok(result.files.includes(link), `${link} is listed as written`);
      assert.ok(existsSync(join(out, link)), `${link} exists`);
    }
    const base = readFileSync(join(out, links[0]!), "utf8");
    assert.match(base, /\.header/, "chrome CSS is in the base bundle");
    assert.match(readFileSync(join(out, links[1]!), "utf8"), /\.layout/, "the layout's CSS is in the page bundle");
    const font = /url\(\/docs\/(assets\/theme\/fonts\/f-[0-9a-f]{16}\.woff2)\)/.exec(base);
    assert.ok(font, "the font url points at its hashed copy under base");
    assert.ok(existsSync(join(out, font[1]!)));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

/**
 * The layout that asks the engine to leave the `Geist` faces out of this page's preloads. The font
 * files and faces are the same as {@link plainFontTheme}; only the hint differs.
 */
const HINTED_LAYOUT = `export default (p: any) => {
  p.hints?.skipFontPreload("geist");
  return \`<html><head><title>\${p.page.title}</title></head><body>\${p.page.html}</body></html>\`;
};
`;

const PLAIN_LAYOUT = `export default (p: any) =>
  \`<html><head><title>\${p.page.title}</title></head><body>\${p.page.html}</body></html>\`;
`;

const FONT_STYLES = [
  '@font-face { font-family: "Geist"; font-display: optional; src: url("../fonts/geist.woff2") format("woff2"); }',
  '@font-face { font-family: "Geist Mono"; font-display: optional; src: url("../fonts/mono.woff2") format("woff2"); }',
  "body { margin: 0; }",
  "",
].join("\n");

/** The preload URLs a built page asks for, in document order. */
function preloads(html: string): string[] {
  return [...html.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)].map((match) => match[1]!);
}

test("a layout can leave a replaced font family out of the preloads, and only that family", async () => {
  const parent = mkdtempSync(join(tmpdir(), "build-fonts-"));
  try {
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: T\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });
    const buildWith = async (layout: string, name: string): Promise<string[]> => {
      const theme = join(parent, name);
      tree(theme, {
        "src/index.ts": 'export const theme = { name: "t", folders: ["layouts", "styles"] };\n',
        "layouts/doc.ts": layout,
        "styles/base.css": FONT_STYLES,
        "fonts/geist.woff2": "geist-bytes",
        "fonts/mono.woff2": "mono-bytes",
      });
      const out = join(parent, `${name}-out`);
      const result = await build({ root: site, out, themeRoot: theme, defaultLayout: "doc" });
      assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);
      return preloads(readFileSync(join(out, "index.html"), "utf8"));
    };
    const plain = await buildWith(PLAIN_LAYOUT, "plain");
    assert.equal(plain.length, 2, "both optional faces are preloaded without a hint");
    const hinted = await buildWith(HINTED_LAYOUT, "hinted");
    assert.equal(hinted.length, 1, "the replaced family is not preloaded");
    assert.match(hinted[0]!, /mono-[0-9a-f]{16}\.woff2$/, "the family that was not replaced keeps its preload");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
