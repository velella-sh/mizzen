import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../src/model/build.ts";
import { llmsFull } from "../src/outputs/llms-full.ts";
import { manifest } from "../src/outputs/manifest.ts";
import { sourcemap } from "../src/outputs/sourcemap.ts";
import { twins } from "../src/outputs/twins.ts";
import type { OutputContext } from "../src/contracts/index.ts";
import { ids, pageAt, site, withSite } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n",
  "_data/components.yml": "- id: button\n  name: Button\n- id: input\n  name: Input\n",
  "_templates/components.md": "---\ntitle: \"{name}\"\nlayout: record\n---\n# :field[name]\n\nBody.\n",
};

test("one page per record, with the record's position, URL, title, and template", async () => {
  await withSite(FILES, (root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const records = result.site.pages.filter((page) => page.record !== undefined);
    assert.deepEqual(records.map((page) => page.url), ["/components/button/", "/components/input/"]);
    assert.deepEqual(records.map((page) => page.title), ["Button", "Input"]);
    const button = pageAt(result, "/components/button/")!;
    assert.equal(button.kind, "doc");
    assert.deepEqual(button.source, {
      file: "_data/components.yml",
      line: 1,
      column: 3,
      endLine: 2,
      endColumn: 15,
    });
    assert.deepEqual(button.record, {
      collection: "components",
      id: "button",
      position: { file: "_data/components.yml", startLine: 1, startColumn: 3, endLine: 2, endColumn: 15 },
      template: "_templates/components.md",
      templateLine: 5,
      fallbacks: [],
    });
    assert.match(button.html, /data-src="_data\/components.yml:2:9-2:14"/);
    assert.match(button.markdown, /Button/);
    assert.ok(root.length > 0);
  });
});

test("two builds of the same input are byte-identical", async () => {
  const root = site(FILES);
  try {
    const first = await buildModel(root);
    const second = await buildModel(root);
    assert.deepEqual(second.site, first.site);
    assert.deepEqual(second.diagnostics, first.diagnostics);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record page and a file page with one URL collide with one error naming both sources", async () => {
  await withSite(
    {
      ...FILES,
      "components/button.md": "---\ntitle: A file page\n---\nText.\n",
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["page.duplicate-url"]);
      const finding = result.diagnostics[0]!;
      assert.match(finding.message, /components\/button\.md/);
      assert.match(finding.message, /_data\/components\.yml/);
      assert.equal(result.site.pages.filter((page) => page.url === "/components/button/").length, 1);
    },
  );
});

const FIXTURE = fileURLToPath(new URL("../fixtures/data-site/", import.meta.url));

test("the data-site fixture builds one page per record, with the standard outputs, identically twice", async () => {
  const context: OutputContext = { renderPage: async () => "", report: () => {} };
  const first = await buildModel(FIXTURE);
  const second = await buildModel(FIXTURE);
  assert.deepEqual(first.diagnostics, []);

  const records = first.site.pages.filter((page) => page.record !== undefined);
  assert.equal(records.length, 30, "12 components, 10 releases, 8 regions");
  for (const page of records) {
    assert.ok(page.url.startsWith("/components/") || page.url.startsWith("/releases/") || page.url.startsWith("/regions/"));
    assert.equal(page.source.file.startsWith("_data/"), true);
    assert.ok(page.title.length > 0);
  }

  for (const output of [twins, manifest, sourcemap, llmsFull]) {
    const one = await output.run(first.site, context);
    const two = await output.run(second.site, context);
    assert.deepEqual(two, one, `${output.name} is byte-identical`);
  }
  const twinsOut = await twins.run(first.site, context);
  assert.equal(twinsOut.filter((file) => /^components\/.*\/index\.md$/.test(file.path)).length, 12);
});
