import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Site } from "../src/contracts/content.ts";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { URLS_LOCK_FILE } from "../src/data/urls-lock.ts";
import { build } from "../src/pipeline/build.ts";
import { redirects } from "../src/outputs/redirects.ts";
import { SITEMAP_LIMITS, writeSitemap } from "../src/outputs/sitemap.ts";
import { ids, pageAt, site, withSite } from "./data-record-site.ts";
import { loadRuntime, urlsOf, withIndexedSite } from "./search-runtime.ts";

/** A site whose records are addressed by a slug, which may change without changing the record's id. */
function files(items: string, url: "retain" | "redirect" = "retain"): Record<string, string> {
  return {
    "mizzen.yml":
      "collections:\n" +
      "  items:\n" +
      "    source: _data/items.yml\n" +
      "    template: _templates/item.md\n" +
      "    permalink: /items/{slug}/\n" +
      "    aliases: aka\n" +
      "    lifecycle:\n" +
      "      states: [current, retired]\n" +
      "      retired: [retired]\n" +
      "      replacement: replacedBy\n" +
      `      url: ${url}\n`,
    "_data/items.yml": items,
    "_templates/item.md": "---\ntitle: \"{id}\"\n---\n# :field[id]\n",
  };
}

/** The files the redirects output writes for a model, by path. */
async function redirectOutput(site: Site): Promise<{ files: Map<string, string>; reported: Diagnostic[] }> {
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("the redirects output never renders a page")),
    report: (finding) => reported.push(finding),
  };
  const files = await redirects.run(site, ctx);
  return { files: new Map(files.map((file) => [file.path, String(file.contents)])), reported };
}

test("a replacement is found by id after its slug, and so its URL, changes", async () => {
  await withSite(
    files("- id: old\n  slug: before\n  state: retired\n  replacedBy: new\n- id: new\n  slug: after\n"),
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      assert.equal(pageAt(result, "/items/before/")?.record?.replacementUrl, "/items/after/");
    },
  );
});

test("an unknown replacement is reported at the record's line", async () => {
  await withSite(
    files("- id: old\n  slug: before\n  state: retired\n  replacedBy: ghost\n"),
    async (_root, result) => {
      const finding = result.diagnostics.find((entry) => entry.id === "lifecycle.replacement-unknown");
      assert.equal(finding?.severity, "error");
      assert.equal(finding?.pos?.file, "_data/items.yml");
      assert.equal(finding?.pos?.line, 1);
      assert.equal(pageAt(result, "/items/before/")?.record?.replacementUrl, undefined);
    },
  );
});

test("a self reference is reported at the record's line", async () => {
  await withSite(
    files("- id: old\n  slug: before\n  state: retired\n  replacedBy: old\n"),
    async (_root, result) => {
      const finding = result.diagnostics.find((entry) => entry.id === "lifecycle.replacement-self");
      assert.equal(finding?.severity, "error");
      assert.equal(finding?.pos?.file, "_data/items.yml");
      assert.equal(finding?.pos?.line, 1);
    },
  );
});

test("url: retain keeps the retired record's page and writes no redirect", async () => {
  await withSite(
    files("- id: old\n  slug: before\n  state: retired\n  replacedBy: new\n- id: new\n  slug: after\n", "retain"),
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      assert.equal(pageAt(result, "/items/before/")?.record?.replacementUrl, "/items/after/");
      const { files: written, reported } = await redirectOutput(result.site);
      assert.deepEqual(reported, []);
      assert.equal(written.get("items/before/index.html"), undefined);
      assert.equal(written.get("_redirects"), undefined);
    },
  );
});

test("url: redirect removes the retired page and sends its old URLs to the replacement's current URL", async () => {
  const lock = `${JSON.stringify({
    version: 1,
    collections: {
      items: {
        old: { url: "/items/before/", previous: ["/items/older/"] },
        new: { url: "/items/after/", previous: ["/items/new-old/"] },
      },
    },
  })}\n`;
  await withSite(
    {
      ...files("- id: old\n  slug: before\n  state: retired\n  replacedBy: new\n- id: new\n  slug: after\n", "redirect"),
      [URLS_LOCK_FILE]: lock,
    },
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      assert.equal(pageAt(result, "/items/before/"), undefined);
      const { files: written, reported } = await redirectOutput(result.site);
      assert.deepEqual(reported, []);
      assert.match(written.get("items/before/index.html")!, /url=\/items\/after\//);
      assert.match(written.get("items/older/index.html")!, /url=\/items\/after\//);
      assert.equal(
        written.get("_redirects"),
        "/items/before/ /items/after/ 301\n/items/new-old/ /items/after/ 301\n/items/older/ /items/after/ 301\n",
      );
    },
  );
});

test("a merged record sends its alias and every locked earlier URL to its replacement", async () => {
  const lock = `${JSON.stringify({
    version: 1,
    collections: {
      items: {
        old: { url: "/items/before/", previous: ["/items/original/"] },
        new: { url: "/items/after/", previous: [] },
      },
    },
  })}\n`;
  await withSite(
    {
      ...files(
        "- id: old\n  slug: before\n  state: retired\n  replacedBy: new\n  aka: [\"/items/aka/\"]\n- id: new\n  slug: after\n",
        "redirect",
      ),
      [URLS_LOCK_FILE]: lock,
    },
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      const { files: written, reported } = await redirectOutput(result.site);
      assert.deepEqual(reported, []);
      for (const path of ["items/before/index.html", "items/original/index.html", "items/aka/index.html"]) {
        assert.match(written.get(path)!, /url=\/items\/after\//);
      }
      assert.equal(
        written.get("_redirects"),
        "/items/aka/ /items/after/ 301\n/items/before/ /items/after/ 301\n/items/original/ /items/after/ 301\n",
      );
    },
  );
});

test("an earlier path claimed for two different replacements is reported once and written once", async () => {
  await withSite(
    files(
      "- id: old\n  slug: before\n  state: retired\n  replacedBy: new\n  aka: [\"/items/shared/\"]\n" +
        "- id: new\n  slug: after\n" +
        "- id: other\n  slug: other\n  state: retired\n  replacedBy: last\n  aka: [\"/items/shared/\"]\n" +
        "- id: last\n  slug: last\n",
      "redirect",
    ),
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      const { files: written, reported } = await redirectOutput(result.site);
      const conflict = reported.find((finding) => finding.id === "redirects.duplicate");
      assert.equal(conflict?.severity, "error");
      assert.match(conflict?.message ?? "", /items\.old/);
      assert.match(conflict?.message ?? "", /items\.other/);
      assert.match(conflict?.message ?? "", /\/items\/after\//);
      assert.match(conflict?.message ?? "", /\/items\/last\//);
      const shared = written.get("_redirects")!.split("\n").filter((line) => line.startsWith("/items/shared/"));
      assert.deepEqual(shared, ["/items/shared/ /items/after/ 301"], "one claim wins and only one line is written");
    },
  );
});

/** A site whose retired record keeps its page; `machine` marks retired records for machine readers, or leaves it unset. */
function presenceFiles(machine: boolean): Record<string, string> {
  return {
    "mizzen.yml": [
      "url: https://example.com",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "    template: _templates/item.md",
      "    permalink: /items/{id}/",
      "    lifecycle:",
      "      states: [current, retired]",
      "      retired: [retired]",
      ...(machine ? ["      machine: true"] : []),
      "",
    ].join("\n"),
    "_data/items.yml": "- id: old\n  state: retired\n  summary: alpha\n- id: new\n  state: current\n  summary: beta\n",
    "_templates/item.md": '---\ntitle: "{id}"\n---\n# :field[id]\n\n:field[summary]\n',
  };
}

test("a retained retired record leaves the sitemap and the search index together unless the collection marks it for machines", async () => {
  const context: OutputContext = { renderPage: async () => "", report: () => {} };
  for (const machine of [false, true]) {
    await withIndexedSite(presenceFiles(machine), async (result, runtime) => {
      const [sitemap] = await writeSitemap(result.site, context, SITEMAP_LIMITS);
      const xml = sitemap!.contents.toString();
      assert.equal(xml.includes("https://example.com/items/old/"), machine);
      assert.match(xml, /https:\/\/example\.com\/items\/new\//);
      assert.deepEqual(await urlsOf(await runtime.search("alpha")), machine ? ["/items/old/"] : []);
      assert.deepEqual(await urlsOf(await runtime.search("beta")), ["/items/new/"]);
      assert.equal(pageAt(result, "/items/old/")?.frontMatter.search, machine ? undefined : false);
      assert.equal(pageAt(result, "/items/old/")?.frontMatter.sitemap, machine ? undefined : false);
    });
  }
});

/** The restore fixture: one record retired behind a redirect, and the same record published again. */
function restoreFiles(restored: boolean): Record<string, string> {
  return {
    "mizzen.yml": [
      "title: Example",
      "url: https://example.com",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "    template: _templates/item.md",
      "    permalink: /items/{slug}/",
      "    dates: [published]",
      "    lifecycle:",
      "      states: [current, retired]",
      "      retired: [retired]",
      "      replacement: replacedBy",
      "      url: redirect",
      "feeds:",
      "  items:",
      "    collection: items",
      "    date: published",
      "api:",
      "  collections:",
      "    items:",
      "      fields: [summary]",
      "",
    ].join("\n"),
    "_data/items.yml":
      `- id: old\n  slug: before\n  state: ${restored ? "current" : "retired"}\n` +
      (restored ? "" : "  replacedBy: new\n") +
      "  summary: alpha\n  published: 2026-01-01\n" +
      "- id: new\n  slug: after\n  state: current\n  summary: beta\n  published: 2026-01-02\n",
    "_templates/item.md": '---\ntitle: "{id}"\nlayout: doc\n---\n# :field[id]\n\n:field[summary]\n',
  };
}

test("a restored record comes back at its locked URL and in every output", async () => {
  const theme = fileURLToPath(new URL("../../lateen", import.meta.url));
  const root = site(restoreFiles(false));
  const out = mkdtempSync(join(tmpdir(), "lifecycle-restore-"));
  try {
    const retired = await build({ root, out, themeRoot: theme, updateUrls: true });
    assert.deepEqual(retired.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    const lock = readFileSync(join(root, URLS_LOCK_FILE), "utf8");
    assert.equal(JSON.parse(lock).collections.items.old.url, "/items/before/");
    assert.match(readFileSync(join(out, "items/before/index.html"), "utf8"), /url=https:\/\/example\.com\/items\/after\//);

    writeFileSync(join(root, "_data/items.yml"), restoreFiles(true)["_data/items.yml"]!);
    const restored = await build({ root, out, themeRoot: theme, updateUrls: true });
    assert.deepEqual(restored.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.equal(readFileSync(join(root, URLS_LOCK_FILE), "utf8"), lock);

    const page = readFileSync(join(out, "items/before/index.html"), "utf8");
    assert.doesNotMatch(page, /url=\/items\/after\//);
    assert.match(page, /alpha/);
    assert.match(readFileSync(join(out, "sitemap.xml"), "utf8"), /https:\/\/example\.com\/items\/before\//);
    assert.match(readFileSync(join(out, "feeds/items.xml"), "utf8"), /https:\/\/example\.com\/items\/before\//);
    assert.ok(existsSync(join(out, "api/v1/items/old.json")));
    const api = JSON.parse(readFileSync(join(out, "api/v1/items.json"), "utf8")) as {
      records: readonly { id: string }[];
    };
    assert.deepEqual(api.records.map((record) => record.id), ["new", "old"]);

    const { runtime, restore } = await loadRuntime(out);
    try {
      assert.deepEqual(await urlsOf(await runtime.search("alpha")), ["/items/before/"]);
    } finally {
      restore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

/** The presence fixture with one declared feed and an API over the same collection. */
function machineFiles(machine: boolean): Record<string, string> {
  return {
    ...presenceFiles(machine),
    "mizzen.yml": [
      "title: Example",
      "url: https://example.com",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "    template: _templates/item.md",
      "    permalink: /items/{id}/",
      "    dates: [published]",
      "    lifecycle:",
      "      states: [current, retired]",
      "      retired: [retired]",
      ...(machine ? ["      machine: true"] : []),
      "feeds:",
      "  items:",
      "    collection: items",
      "    date: published",
      "api:",
      "  collections:",
      "    items:",
      "      fields: [summary]",
      "",
    ].join("\n"),
    "_data/items.yml":
      "- id: old\n  state: retired\n  summary: alpha\n  published: 2026-01-01\n- id: new\n  state: current\n  summary: beta\n  published: 2026-01-02\n",
    "_templates/item.md": '---\ntitle: "{id}"\nlayout: doc\n---\n# :field[id]\n\n:field[summary]\n',
  };
}

test("a retired record leaves the feed and the API record files together unless the collection marks it for machines", async () => {
  const theme = fileURLToPath(new URL("../../lateen", import.meta.url));
  for (const machine of [false, true]) {
    const root = site(machineFiles(machine));
    const out = mkdtempSync(join(tmpdir(), "lifecycle-out-"));
    try {
      const result = await build({ root, out, themeRoot: theme, defaultLayout: "doc" });
      assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);

      const feed = readFileSync(join(out, "feeds/items.xml"), "utf8");
      assert.equal(feed.includes("https://example.com/items/old/"), machine);
      assert.match(feed, /https:\/\/example\.com\/items\/new\//);

      assert.equal(existsSync(join(out, "api/v1/items/old.json")), machine);
      assert.ok(existsSync(join(out, "api/v1/items/new.json")));
      const collection = JSON.parse(readFileSync(join(out, "api/v1/items.json"), "utf8")) as {
        records: readonly { id: string }[];
      };
      assert.deepEqual(
        collection.records.map((record) => record.id),
        machine ? ["new", "old"] : ["new"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  }
});

/** The sequence fixture: one collection with a feed and an API, addressed by a slug that may change. */
function sequenceFiles(items: string): Record<string, string> {
  return {
    "mizzen.yml": [
      "title: Example",
      "url: https://example.com",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "    template: _templates/item.md",
      "    permalink: /items/{slug}/",
      "    dates: [published]",
      "    lifecycle:",
      "      states: [current, retired]",
      "      retired: [retired]",
      "      replacement: replacedBy",
      "      url: redirect",
      "feeds:",
      "  items:",
      "    collection: items",
      "    date: published",
      "api:",
      "  collections:",
      "    items:",
      "      fields: [summary]",
      "",
    ].join("\n"),
    "_data/items.yml": items,
    "_templates/item.md": '---\ntitle: "{id}"\nlayout: doc\n---\n# :field[id]\n\n:field[summary]\n',
  };
}

/** One release's records: `old` retired behind a redirect, and `new` at the given slug. */
function sequenceItems(retired: boolean, replacementSlug: string): string {
  return (
    "- id: old\n" +
    "  slug: before\n" +
    `  state: ${retired ? "retired" : "current"}\n` +
    (retired ? "  replacedBy: new\n" : "") +
    "  summary: alpha\n  published: 2026-01-01\n" +
    "- id: new\n" +
    `  slug: ${replacementSlug}\n` +
    "  state: current\n  summary: beta\n  published: 2026-01-02\n"
  );
}

/** A file the build wrote, as text. */
function outputText(out: string, path: string): string {
  return readFileSync(join(out, path), "utf8");
}

/** Asserts that `path` is a redirect page whose target is `target`. */
function assertRedirect(out: string, path: string, target: string): void {
  const html = outputText(out, path);
  assert.ok(html.includes(`<link rel="canonical" href="${target}">`), `${path} redirects to ${target}`);
  assert.ok(html.includes(`<meta http-equiv="refresh" content="0; url=${target}">`), `${path} refreshes to ${target}`);
}

/** Asserts that `path` is a real page showing `text`, not a redirect. */
function assertPage(out: string, path: string, text: string): void {
  const html = outputText(out, path);
  assert.ok(html.includes(text), `${path} shows ${text}`);
  assert.doesNotMatch(html, /http-equiv="refresh"/, `${path} is not a redirect`);
}

/** The page URLs in the sitemap. */
function sitemapUrls(out: string): string[] {
  return [...outputText(out, "sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
}

/** The entry links in the collection's feed. */
function feedUrls(out: string): string[] {
  return [...outputText(out, "feeds/items.xml").matchAll(/<entry>[\s\S]*?<link href="([^"]+)"/g)].map(
    (match) => match[1]!,
  );
}

/** The record ids in the collection's API document, in order. */
function apiIds(out: string): string[] {
  const document = JSON.parse(outputText(out, "api/v1/items.json")) as { records: readonly { id: string }[] };
  return document.records.map((record) => record.id);
}

/** Asserts what the built site's search finds for the two records' summaries. */
async function assertSearch(out: string, alpha: string[], beta: string[]): Promise<void> {
  const { runtime, restore } = await loadRuntime(out);
  try {
    assert.deepEqual(await urlsOf(await runtime.search("alpha")), alpha);
    assert.deepEqual(await urlsOf(await runtime.search("beta")), beta);
  } finally {
    restore();
  }
}

test("retirement, a replacement's move, and a restore hold every output across three releases", async () => {
  const theme = fileURLToPath(new URL("../../lateen", import.meta.url));
  const root = site(sequenceFiles(sequenceItems(true, "after")));
  const outputs = mkdtempSync(join(tmpdir(), "lifecycle-sequence-"));
  const errorsOf = (result: { readonly diagnostics: readonly Diagnostic[] }): Diagnostic[] =>
    result.diagnostics.filter((finding) => finding.severity === "error");
  try {
    // Release 1: `old` is retired behind a redirect to `new` at /items/after/.
    const one = join(outputs, "one");
    const first = await build({ root, out: one, themeRoot: theme, updateUrls: true });
    assert.deepEqual(errorsOf(first), []);
    assertRedirect(one, "items/before/index.html", "https://example.com/items/after/");
    assertPage(one, "items/after/index.html", "beta");
    assert.equal(outputText(one, "_redirects"), "/items/before/ https://example.com/items/after/ 301\n");
    assert.deepEqual(sitemapUrls(one), ["https://example.com/items/after/"]);
    assert.deepEqual(feedUrls(one), ["https://example.com/items/after/"]);
    assert.deepEqual(apiIds(one), ["new"]);
    assert.equal(existsSync(join(one, "api/v1/items/old.json")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, URLS_LOCK_FILE), "utf8")), {
      version: 1,
      collections: {
        items: {
          new: { url: "/items/after/", previous: [] },
          old: { url: "/items/before/", previous: [] },
        },
      },
    });
    await assertSearch(one, [], ["/items/after/"]);

    // Release 2: `new` moves to /items/after-renamed/, so both its old path and `old`'s redirect follow it.
    writeFileSync(join(root, "_data/items.yml"), sequenceItems(true, "after-renamed"));
    const two = join(outputs, "two");
    const second = await build({ root, out: two, themeRoot: theme, updateUrls: true });
    assert.deepEqual(errorsOf(second), []);
    assertRedirect(two, "items/after/index.html", "https://example.com/items/after-renamed/");
    assertRedirect(two, "items/before/index.html", "https://example.com/items/after-renamed/");
    assertPage(two, "items/after-renamed/index.html", "beta");
    assert.equal(
      outputText(two, "_redirects"),
      "/items/after/ https://example.com/items/after-renamed/ 301\n" +
        "/items/before/ https://example.com/items/after-renamed/ 301\n",
    );
    assert.deepEqual(sitemapUrls(two), ["https://example.com/items/after-renamed/"]);
    assert.deepEqual(feedUrls(two), ["https://example.com/items/after-renamed/"]);
    assert.deepEqual(apiIds(two), ["new"]);
    assert.equal(existsSync(join(two, "api/v1/items/old.json")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, URLS_LOCK_FILE), "utf8")), {
      version: 1,
      collections: {
        items: {
          new: { url: "/items/after-renamed/", previous: ["/items/after/"] },
          old: { url: "/items/before/", previous: [] },
        },
      },
    });
    const movedLock = readFileSync(join(root, URLS_LOCK_FILE), "utf8");
    await assertSearch(two, [], ["/items/after-renamed/"]);

    // Release 3: `old` is restored at its locked URL while the replacement's old path keeps resolving.
    writeFileSync(join(root, "_data/items.yml"), sequenceItems(false, "after-renamed"));
    const three = join(outputs, "three");
    const third = await build({ root, out: three, themeRoot: theme, updateUrls: true });
    assert.deepEqual(errorsOf(third), []);
    assertPage(three, "items/before/index.html", "alpha");
    assertRedirect(three, "items/after/index.html", "https://example.com/items/after-renamed/");
    assertPage(three, "items/after-renamed/index.html", "beta");
    assert.equal(outputText(three, "_redirects"), "/items/after/ https://example.com/items/after-renamed/ 301\n");
    assert.deepEqual(sitemapUrls(three), [
      "https://example.com/items/after-renamed/",
      "https://example.com/items/before/",
    ]);
    assert.deepEqual(feedUrls(three), [
      "https://example.com/items/after-renamed/",
      "https://example.com/items/before/",
    ]);
    assert.deepEqual(apiIds(three), ["new", "old"]);
    const oldRecord = JSON.parse(outputText(three, "api/v1/items/old.json")) as {
      url: string;
      previousUrls: readonly string[];
    };
    assert.equal(oldRecord.url, "/items/before/");
    assert.deepEqual(oldRecord.previousUrls, []);
    assert.equal(readFileSync(join(root, URLS_LOCK_FILE), "utf8"), movedLock);
    await assertSearch(three, ["/items/before/"], ["/items/after-renamed/"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outputs, { recursive: true, force: true });
  }
});
