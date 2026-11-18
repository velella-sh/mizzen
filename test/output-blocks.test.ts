import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { blocks } from "../src/outputs/blocks.ts";

const config: SiteConfig = {
  title: "Mizzen",
  base: "",
  lang: "en",
  dir: "ltr",
  languages: [],
  source: ".",
  include: [],
  exclude: [],
  navigation: "_data/navigation.yml",
  collections: {},
  feeds: {},
  defaults: [],
  theme: { options: {} },
  search: {},
  redirects: {},
  outputs: {},
};

/** The render host is not read by the blocks output, so it answers nothing. */
const ctx: OutputContext = {
  renderPage: () => Promise.resolve(""),
  report: () => {},
};

function page(url: string, file: string, blocks?: readonly Block[]): Page {
  return {
    url,
    source: { file, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: file,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...(blocks === undefined ? {} : { blocks }),
  };
}

function site(pages: readonly Page[]): Site {
  return { config, pages, nav: {}, collections: {}, data: {} };
}

async function run(pages: readonly Page[]): Promise<readonly OutputFile[]> {
  return blocks.run(site(pages), ctx);
}

test("blocks.json holds every block's url, file, and line, with keys sorted", async () => {
  const at = (file: string, line: number) => ({ file, line, column: 1, endLine: line, endColumn: 2 });
  const files = await run([
    page("/guide/", "guide/a.md", [
      { id: "zeta", pos: at("guide/a.md", 9) },
      { id: "intro", pos: at("guide/a.md", 5) },
    ]),
    page("/guide/b/", "guide/b.md", [{ id: "alpha", pos: at("guide/b.md", 3) }]),
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "blocks.json");
  assert.equal(
    files[0]?.contents,
    '{"blocks":{"alpha":{"file":"guide/b.md","line":3,"url":"/guide/b/"},' +
      '"intro":{"file":"guide/a.md","line":5,"url":"/guide/"},' +
      '"zeta":{"file":"guide/a.md","line":9,"url":"/guide/"}},"version":1}\n',
  );
});

test("a site without blocks writes no blocks.json", async () => {
  assert.deepEqual(await run([page("/guide/", "guide/a.md"), page("/about/", "about.md", [])]), []);
});
