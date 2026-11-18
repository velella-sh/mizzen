import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import type { ImportedPage } from "../../src/import/contract.ts";
import { convertNav } from "../../src/import/vitepress/nav.ts";

const CONFIG = ".vitepress/config.mjs";

const pages: ImportedPage[] = [
  { source: "docs/index.md", destination: "index.md", contents: "" },
  { source: "docs/guide/install.md", destination: "guide/install.md", contents: "" },
];

test("nav entries keep their order, groups become children, and internal links use destination URLs", () => {
  const config = `export default { themeConfig: { nav: [
    { text: "Guide", items: [
      { text: "Install", link: "/guide/install" },
      { text: "External", link: "https://example.com/docs" },
    ] },
    { text: "Home", link: "/" },
  ] } };`;
  const { contents, diagnostics } = convertNav(config, CONFIG, pages, "docs/");

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(parse(contents ?? ""), {
    main: [
      {
        title: "Guide",
        children: [
          { title: "Install", url: "/guide/install/" },
          { title: "External", url: "https://example.com/docs" },
        ],
      },
      { title: "Home", url: "/" },
    ],
  });
});

test("a link to an unknown page stays as written, and an entry without literal text is reported", () => {
  const config = `export default { themeConfig: { nav: [
    { text: "Missing", link: "/guide/missing" },
    ...extra,
  ] } };`;
  const { contents, diagnostics } = convertNav(config, CONFIG, pages, "docs/");

  assert.deepEqual(parse(contents ?? ""), { main: [{ title: "Missing", url: "/guide/missing" }] });
  assert.deepEqual(
    diagnostics.map((finding) => [finding.id, finding.severity, finding.pos?.file]),
    [["import.nav", "warning", CONFIG]],
  );
});

test("a config without a nav declares no navigation, and a non-array nav is reported", () => {
  assert.equal(convertNav("export default { themeConfig: {} };", CONFIG, pages, "docs/").contents, undefined);

  const dynamic = convertNav("export default { themeConfig: { nav: navigation } };", CONFIG, pages, "docs/");
  assert.equal(dynamic.contents, undefined);
  assert.deepEqual(dynamic.diagnostics.map((finding) => finding.id), ["import.nav"]);
});
