import assert from "node:assert/strict";
import { test } from "node:test";
import { recordPropsOf } from "../src/data/record-context.ts";
import { headMeta } from "../src/outputs/head-meta.ts";
import { changesFeed } from "../src/outputs/feed.ts";
import { llms } from "../src/outputs/llms.ts";
import { llmsFull } from "../src/outputs/llms-full.ts";
import { manifest } from "../src/outputs/manifest.ts";
import { search } from "../src/outputs/search.ts";
import { sitemap } from "../src/outputs/sitemap.ts";
import type { OutputContext } from "../src/contracts/index.ts";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "url: https://example.com\n" +
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n" +
    "    views:\n" +
    "      compact:\n" +
    "        template: _templates/compact.md\n" +
    "        permalink: /components/{id}/compact/\n" +
    "        layout: compact\n",
  "_data/components.yml": "- id: button\n  name: Button\n",
  "_templates/components.md":
    "---\ntitle: \"{name}\"\nlayout: record\nlast_modified_at: 2026-01-01\n---\n# :field[name]\n\nFull page.\n",
  "_templates/compact.md":
    "---\ntitle: \"{name} compact\"\nlast_modified_at: 2026-01-01\n---\nCompact page for :field[name].\n",
  "_data/navigation.yml": "docs:\n  - collection: components\n",
};

const context = (): OutputContext => ({
  renderPage: async () => "",
  report: () => {},
});

test("a view is another page of the same record, with its own layout and the main page as canonical", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const main = pageAt(result, "/components/button/")!;
    const view = pageAt(result, "/components/button/compact/")!;

    assert.equal(main.record?.view, undefined);
    assert.deepEqual(main.record?.views, { compact: "/components/button/compact/" });
    assert.equal(view.record?.view, "compact");
    assert.equal(view.record?.id, "button");
    assert.equal(view.frontMatter.layout, "compact");
    assert.equal(view.frontMatter.canonical_url, "/components/button/");
    assert.equal(view.frontMatter.search, false);
    assert.equal(view.frontMatter.sitemap, false);
    assert.match(view.markdown, /Compact page for Button/);

    const head = headMeta(result.site, view, []);
    assert.deepEqual(
      head.links.filter((link) => link.rel === "canonical"),
      [{ rel: "canonical", href: "https://example.com/components/button/" }],
    );
    assert.deepEqual(recordPropsOf(result.site, main)?.views, { compact: "/components/button/compact/" });
  });
});

test("a view stays out of navigation, search, the sitemap, feeds, and llms-full", async () => {
  await withSite(FILES, async (root, result) => {
    const group = result.site.nav["docs"]?.[0];
    assert.ok(group !== undefined && "children" in group);
    assert.deepEqual(group.children.map((child) => ("url" in child ? child.url : "")), ["/components/button/"]);

    const sitemapFile = (await sitemap.run(result.site, context()))[0]!;
    assert.match(String(sitemapFile.contents), /\/components\/button\//);
    assert.doesNotMatch(String(sitemapFile.contents), /compact/);

    const feedFile = (await changesFeed(result.site, root))[0]!;
    assert.match(String(feedFile.contents), /\/components\/button\//);
    assert.doesNotMatch(String(feedFile.contents), /compact/);

    const short = String((await llms.run(result.site, context()))[0]!.contents);
    assert.match(short, /\/components\/button\//);
    assert.doesNotMatch(short, /compact/);

    const full = String((await llmsFull.run(result.site, context()))[0]!.contents);
    assert.match(full, /\/components\/button\//);
    assert.doesNotMatch(full, /compact/);

    const index = JSON.parse(String((await manifest.run(result.site, context()))[0]!.contents)) as {
      pages: { url: string; view?: string }[];
    };
    assert.equal(index.pages.find((page) => page.url === "/components/button/")?.view, undefined);
    assert.equal(index.pages.find((page) => page.url === "/components/button/compact/")?.view, "compact");

    const searchFiles = await search.run(result.site, context());
    const entry = searchFiles.find((file) => file.path === "pagefind/pagefind-entry.json");
    assert.ok(entry, "the search index is written");
    const languages = JSON.parse(String(entry.contents)) as { languages: Record<string, { page_count: number }> };
    assert.equal(languages.languages.en?.page_count, 1, "only the main page is indexed");
  });
});

test("a view is not built when its URL pattern cannot be filled", async () => {
  await withSite(
    {
      ...FILES,
      "mizzen.yml": FILES["mizzen.yml"].replace("/components/{id}/compact/", "/components/{slug}/compact/"),
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.permalink-field"]);
      const main = pageAt(result, "/components/button/")!;
      assert.equal(main.record?.views, undefined);
      assert.equal(pageAt(result, "/components/button/compact/"), undefined);
    },
  );
});
