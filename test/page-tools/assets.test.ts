import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Diagnostic, FrontMatter, Page, Site, SiteConfig } from "../../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../../src/contracts/output.ts";
import { pageTools, toolUrl } from "../../src/outputs/page-tools.ts";

/** A site config with the defaults a build fills in, plus the given overrides. */
function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
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
    ...overrides,
  };
}

/** A page whose front matter holds `tool:`, with the source span of a page that has front matter. */
function page(file: string, tool: string): Page {
  return {
    url: `/${file.replace(/\.md$/, "/")}`,
    source: { file, line: 4, column: 1, endLine: 4, endColumn: 1 },
    frontMatter: { tool } as FrontMatter,
    title: file,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, collections: {}, data: {} };
}

/** An output context that records every diagnostic and never renders a page. */
function context(root: string, reports: Diagnostic[] = []): OutputContext {
  return {
    renderPage: () => Promise.reject(new Error("the page tools output must not render pages")),
    build: { root, workers: 1 },
    report: (diagnostic) => {
      reports.push(diagnostic);
    },
  };
}

/** A temporary site root holding the given files. */
function root(files: Readonly<Record<string, string>>): string {
  const parent = mkdtempSync(join(tmpdir(), "page-tools-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(parent, path)), { recursive: true });
    writeFileSync(join(parent, path), text);
  }
  return parent;
}

/** The body of a text file, when the output wrote it. */
function textOf(file: OutputFile): string {
  return typeof file.contents === "string" ? file.contents : new TextDecoder().decode(file.contents);
}

test("a root site publishes only the selected tool at its own path", async () => {
  const root1 = root({ "tool/tool.js": "export const rows = 2;\n", "tool/other.js": "ignored\n" });
  try {
    const reports: Diagnostic[] = [];
    const files = await pageTools.run(
      site([page("index.md", "tool/tool.js")]),
      context(root1, reports),
    );
    assert.deepEqual(reports, []);
    assert.deepEqual(files.map((file) => file.path), ["tool/tool.js"]);
    assert.equal(textOf(files[0]!), "export const rows = 2;\n");
    assert.equal(toolUrl("", "tool/tool.js"), "/tool/tool.js");
  } finally {
    rmSync(root1, { recursive: true, force: true });
  }
});

test("a nested base path keeps the file path and puts the base in the URL", async () => {
  const root1 = root({ "tool/tool.js": "run();\n" });
  try {
    const reports: Diagnostic[] = [];
    const files = await pageTools.run(
      site([page("index.md", "tool/tool.js")], { base: "/sample" }),
      context(root1, reports),
    );
    assert.deepEqual(reports, []);
    assert.deepEqual(files.map((file) => file.path), ["tool/tool.js"], "the output folder already deploys under the base");
    assert.equal(toolUrl("/sample", files[0]!.path), "/sample/tool/tool.js");
  } finally {
    rmSync(root1, { recursive: true, force: true });
  }
});

test("pages share one copy, written in path order", async () => {
  const root1 = root({ "tool/a.js": "a();\n", "tool/b.js": "b();\n" });
  try {
    const reports: Diagnostic[] = [];
    const files = await pageTools.run(
      site([page("one.md", "tool/b.js"), page("two.md", "tool/a.js"), page("three.md", "tool/b.js")]),
      context(root1, reports),
    );
    assert.deepEqual(reports, []);
    assert.deepEqual(files.map((file) => file.path), ["tool/a.js", "tool/b.js"]);
  } finally {
    rmSync(root1, { recursive: true, force: true });
  }
});

test("a missing asset is an error at the page's front-matter span", async () => {
  const root1 = root({ "tool/tool.js": "run();\n" });
  try {
    const reports: Diagnostic[] = [];
    const files = await pageTools.run(
      site([page("guide/index.md", "tool/gone.js")], { base: "/sample" }),
      context(root1, reports),
    );
    assert.deepEqual(files, []);
    assert.equal(reports.length, 1);
    const [report] = reports;
    assert.equal(report!.id, "page-tools.missing");
    assert.equal(report!.severity, "error");
    assert.deepEqual(report!.pos, { file: "guide/index.md", line: 1, column: 1, endLine: 3, endColumn: 1 });
  } finally {
    rmSync(root1, { recursive: true, force: true });
  }
});
