import assert from "node:assert/strict";
import { test } from "node:test";
import { llmsFull } from "../src/outputs/llms-full.ts";
import { manifest } from "../src/outputs/manifest.ts";
import { sourcemap } from "../src/outputs/sourcemap.ts";
import { twins } from "../src/outputs/twins.ts";
import type { OutputContext } from "../src/contracts/index.ts";
import { withSite } from "./data-record-site.ts";

const files = (llms: string) => ({
  "mizzen.yml":
    "url: https://example.com\n" +
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n" +
    `    ${llms}\n`,
  "_data/components.yml": "- id: button\n  name: Button\n  body: |\n    ## Usage\n\n    Press it.\n",
  "_templates/components.md": "---\ntitle: \"{name}\"\nlayout: record\n---\n# :field[name]\n\n:field[body]\n",
});

const context = (): OutputContext => ({
  renderPage: async () => "",
  report: () => {},
});

test("the twin, manifest entry, source map entry, and llms.txt entry exist for one record page", async () => {
  await withSite(files("markdown: [body]"), async (_root, result) => {
    const site = result.site;
    const twin = (await twins.run(site, context())).find((file) => file.path === "components/button/index.md");
    assert.ok(twin, "the Markdown twin is written");
    assert.match(String(twin.contents), /Button/);
    assert.match(String(twin.contents), /## Usage/);

    const index = JSON.parse(String((await manifest.run(site, context()))[0]!.contents)) as {
      pages: { url: string; source: string; title: string; layout: string | null; outputs: string[] }[];
    };
    const entry = index.pages.find((page) => page.url === "/components/button/");
    assert.ok(entry);
    assert.equal(entry.source, "_data/components.yml");
    assert.equal(entry.title, "Button");
    assert.equal(entry.layout, "record");
    assert.deepEqual(entry.outputs, ["components/button/index.html", "components/button/index.md"]);

    const map = JSON.parse(String((await sourcemap.run(site, context()))[0]!.contents)) as {
      pages: { url: string; source: string; template?: string; sections: { file: string; line: number }[] }[];
    };
    const mapped = map.pages.find((page) => page.url === "/components/button/")!;
    assert.equal(mapped.source, "_data/components.yml");
    assert.equal(mapped.template, "_templates/components.md");
    assert.deepEqual(
      mapped.sections.map((section) => section.file),
      ["_templates/components.md", "_data/components.yml"],
    );
  });
});

test("a collection with llms: false stays out of llms-full.txt", async () => {
  await withSite(files("llms: false"), async (_root, result) => {
    const off = String((await llmsFull.run(result.site, context()))[0]!.contents);
    assert.doesNotMatch(off, /Press it|components\/button/);
  });
  await withSite(files("llms: true"), async (_root, result) => {
    const on = String((await llmsFull.run(result.site, context()))[0]!.contents);
    assert.match(on, /components\/button\//);
  });
});
