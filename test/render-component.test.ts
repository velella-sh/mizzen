/**
 * A unit renders another component by name through the registry, so a site's override applies and the component's CSS
 * and island follow it onto the page; and a component learns whether it was written inline.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { h } from "preact";
import type { Head, Layout, Page, Site } from "../src/contracts/index.ts";
import { build } from "../src/pipeline/build.ts";
import { renderPage } from "../src/render/render.ts";
import type { ThemeComponent } from "../src/render/render.ts";

const pos = { file: "a.md", line: 1, column: 1, endLine: 1, endColumn: 1 };
const site = { config: { base: "" }, pages: [], nav: {}, collections: {}, data: {} } as unknown as Site;
const head: Head = { title: "T", meta: [], links: [], jsonLd: [] };
function page(html: string): Page {
  return { url: "/", source: pos, frontMatter: {}, title: "T", lang: "en", dir: "ltr", headings: [], html, markdown: "", kind: "doc" };
}
const plain: Layout = ({ page: p, islands }) =>
  h("body", null, h("main", { dangerouslySetInnerHTML: { __html: p.html } }), ...islands.map((i) => h("i", { "data-src": i.src })));

const components: Record<string, ThemeComponent> = {
  inner: { component: ({ props }) => `<b>${String(props.text ?? "")}</b>`, css: "components/inner/style.css", island: { name: "inner", src: "/inner.js" } },
  outer: { component: ({ renderComponent }) => `<p>${renderComponent("inner", { text: "hi" })}</p>` },
  probe: { component: ({ inline }) => `<u>${inline}</u>` },
  loop: { component: ({ renderComponent }) => renderComponent("loop") },
};

test("a component renders another by name, and the page takes its CSS and island", () => {
  const result = renderPage({ site, page: page('<sl-component name="outer"></sl-component>'), layout: plain, components, trail: [], pager: {}, head });
  assert.match(result.html, /<p><b>hi<\/b><\/p>/);
  assert.deepEqual(result.css, ["components/inner/style.css"]);
  assert.deepEqual(result.islands.map((island) => island.name), ["inner"]);
  assert.deepEqual(result.diagnostics, []);
});

test("a layout renders a component by name, and an unknown name is a warning with no output", () => {
  const viaLayout: Layout = ({ renderComponent }) => h("body", null, h("div", { dangerouslySetInnerHTML: { __html: renderComponent("inner", { text: "x" }) + renderComponent("nope") } }));
  const result = renderPage({ site, page: page("<p>none</p>"), layout: viaLayout, components, trail: [], pager: {}, head });
  assert.match(result.html, /<div><b>x<\/b><\/div>/);
  assert.deepEqual(result.css, ["components/inner/style.css"]);
  assert.deepEqual(result.islands.map((island) => island.src), ["/inner.js"]);
  assert.deepEqual(result.diagnostics.map((d) => d.id), ["render.unknown-component"]);
});

test("units that render each other without end stop with a diagnostic", () => {
  const result = renderPage({ site, page: page('<sl-component name="loop"></sl-component>'), layout: plain, components, trail: [], pager: {}, head });
  assert.deepEqual(result.diagnostics.map((d) => d.id), ["render.component-depth"]);
});

test("inline is true for a text directive and false for leaf, container, and alert", () => {
  const html = [
    '<sl-component name="probe" data-props="{}" data-inline></sl-component>',
    '<sl-component name="probe" data-props="{}"></sl-component>',
  ].join("");
  const result = renderPage({ site, page: page(html), layout: plain, components, trail: [], pager: {}, head });
  assert.deepEqual([...result.html.matchAll(/<u[^>]*>(\w+)<\/u>/g)].map((m) => m[1]), ["true", "false"]);
});

function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

test("a build renders the site's override of a component named from another, and marks directives inline", async () => {
  const parent = mkdtempSync(join(tmpdir(), "render-component-"));
  try {
    tree(join(parent, "theme"), {
      "src/index.ts": 'export const theme = { name: "t", folders: ["layouts", "components"] };\n',
      "layouts/doc.ts": 'export default (p: any) => `<html><body>${p.page.html}</body></html>`;\n',
      "components/badge/index.ts": 'export const directive = "badge";\nexport default () => "theme badge";\n',
      "components/badge/style.css": ".theme-badge { color: red; }\n",
      "components/card/index.ts": 'export const directive = "card";\nexport default (p: any) => `<div>${p.renderComponent("badge")}</div>`;\n',
      "components/probe/index.ts": 'export const directive = "probe";\nexport default (p: any) => `<u>${p.inline}</u>`;\n',
    });
    tree(join(parent, "site"), {
      "mizzen.yml": "title: T\ntheme:\n  overrides:\n    components:\n      badge: theme/badge.ts\n",
      "theme/badge.ts": 'export const directive = "badge";\nexport default () => "site badge";\n',
      "index.md": "---\ntitle: Home\n---\n\n::card\n\nText :probe[x] here.\n\n::probe\n",
    });
    const out = join(parent, "out");
    await build({ root: join(parent, "site"), out, themeRoot: join(parent, "theme"), defaultLayout: "doc" });
    const text = readFileSync(join(out, "index.html"), "utf8");
    assert.match(text, /<div[^>]*>site badge<\/div>/, "the override, not the theme's unit");
    assert.deepEqual([...text.matchAll(/<u[^>]*>(\w+)<\/u>/g)].map((m) => m[1]), ["true", "false"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
