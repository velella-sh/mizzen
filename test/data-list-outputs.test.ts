import assert from "node:assert/strict";
import { test } from "node:test";
import { llmsFull } from "../src/outputs/llms-full.ts";
import { llms } from "../src/outputs/llms.ts";
import { twins } from "../src/outputs/twins.ts";
import type { OutputContext } from "../src/contracts/index.ts";
import { withSite } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "collections:\n" +
    "  posts:\n" +
    "    source: _data/posts.yml\n" +
    "    template: _templates/posts.md\n" +
    "    permalink: /posts/{id}/\n",
  "_data/posts.yml": "- id: a\n  title: Alpha\n- id: b\n  title: Beta\n- id: c\n  title: Gamma\n",
  "_templates/posts.md": "---\ntitle: \"{title}\"\n---\n# :field[title]\n",
  "_data/navigation.yml":
    "docs:\n" +
    "  - title: Blog\n    url: /blog/\n" +
    "  - title: Blog page two\n    url: /blog/page/2/\n",
  "blog/index.md":
    "---\ntitle: Blog\nlist:\n  collection: posts\n  sort: title\n  perPage: 2\n  fields: [title]\n---\nLIST-BODY\n",
};

const context = (): OutputContext => ({ renderPage: async () => "", report: () => {} });

test("each list page has its own twin, holding only its records as a table", async () => {
  await withSite(FILES, async (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const files = await twins.run(result.site, context());
    const first = String(files.find((file) => file.path === "blog/index.md")?.contents);
    const second = String(files.find((file) => file.path === "blog/page/2/index.md")?.contents);
    assert.match(first, /LIST-BODY/);
    assert.match(first, /\| \[Alpha\]\(\/posts\/a\/\) \|/);
    assert.doesNotMatch(first, /Gamma/);
    assert.match(second, /Gamma/);
    assert.doesNotMatch(second, /Alpha/);
  });
});

test("llms.txt lists the first page of a list once, and llms-full leaves list pages out", async () => {
  await withSite(FILES, async (_root, result) => {
    const index = String((await llms.run(result.site, context()))[0]!.contents);
    assert.match(index, /\[Blog\]\(\/blog\/index\.md\)/);
    assert.doesNotMatch(index, /page\/2\/index\.md/);
    const full = String((await llmsFull.run(result.site, context()))[0]!.contents);
    assert.doesNotMatch(full, /LIST-BODY/);
  });
});
