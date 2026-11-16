/**
 * The two 0.2.0 Atom feeds keep their exact bytes after the shared writer landed. These strings are the published
 * shape: a change here changes what a feed reader sees, so it needs a deliberate reason.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { changesFeed } from "../src/outputs/feed.ts";
import { changelogFeed } from "../src/outputs/changelog-feed.ts";

const pos = { file: "test/no-such-feed-source/page.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

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

function page(url: string, overrides: Partial<Page> = {}): Page {
  return {
    url,
    source: pos,
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, collections: {}, data: {} };
}

function heading(depth: Heading["depth"], id: string, text: string): Heading {
  return { depth, id, text, pos };
}

test("changes.xml keeps its exact bytes", async () => {
  const model = site(
    [page("/a/", { title: "A", frontMatter: { last_modified_at: "2026-10-01", description: "First." } })],
    { url: "https://x.io" },
  );
  const files = await changesFeed(model);
  assert.equal(
    String(files[0]!.contents),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">',
      "  <title>Example</title>",
      '  <link href="https://x.io/changes.xml" rel="self" type="application/atom+xml"/>',
      '  <link href="https://x.io/" rel="alternate" type="text/html"/>',
      "  <id>https://x.io/changes.xml</id>",
      "  <updated>2026-10-01T00:00:00.000Z</updated>",
      "  <author>",
      "    <name>Example</name>",
      "  </author>",
      "  <entry>",
      "    <title>A</title>",
      '    <link href="https://x.io/a/" rel="alternate" type="text/html"/>',
      "    <id>https://x.io/a/</id>",
      "    <updated>2026-10-01T00:00:00.000Z</updated>",
      "    <summary>First.</summary>",
      "  </entry>",
      "</feed>",
      "",
    ].join("\n"),
  );
});

test("changelog.xml keeps its exact bytes", async () => {
  const model = site(
    [
      page("/changelog/", {
        title: "Changelog",
        frontMatter: { changelog: true },
        headings: [heading(2, "v1", "1.0.0 — 2026-10-01")],
      }),
    ],
    { url: "https://x.io" },
  );
  const files = await changelogFeed(model);
  assert.equal(
    String(files[0]!.contents),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">',
      "  <title>Example</title>",
      '  <link href="https://x.io/changelog.xml" rel="self" type="application/atom+xml"/>',
      '  <link href="https://x.io/changelog/" rel="alternate" type="text/html"/>',
      "  <id>https://x.io/changelog.xml</id>",
      "  <updated>2026-10-01T00:00:00.000Z</updated>",
      "  <author>",
      "    <name>Example</name>",
      "  </author>",
      "  <entry>",
      "    <title>1.0.0 — 2026-10-01</title>",
      '    <link href="https://x.io/changelog/#v1" rel="alternate" type="text/html"/>',
      "    <id>https://x.io/changelog/#v1</id>",
      "    <updated>2026-10-01T00:00:00.000Z</updated>",
      "  </entry>",
      "</feed>",
      "",
    ].join("\n"),
  );
});
