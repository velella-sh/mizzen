import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import type { Site } from "../src/contracts/content.ts";
import { redirects } from "../src/outputs/redirects.ts";
import { URLS_LOCK_FILE } from "../src/data/urls-lock.ts";
import { ids, withSite } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "collections:\n" +
    "  pages:\n" +
    "    source: _data/pages.yml\n" +
    "    template: _templates/page.md\n" +
    "    permalink: /pages/{id}/\n" +
    "    aliases: aka\n",
  "_data/pages.yml": "- id: new\n  name: New\n",
  "_templates/page.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n",
};

/** A context that keeps every diagnostic, so a test can check what the output reported. */
function collecting(): { ctx: OutputContext; reported: Diagnostic[] } {
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("the redirects output never renders a page")),
    report: (d) => reported.push(d),
  };
  return { ctx, reported };
}

/** Runs the redirects output on a model and returns its files by path. */
async function run(site: Site): Promise<{ files: Map<string, string>; reported: Diagnostic[] }> {
  const { ctx, reported } = collecting();
  const files = await redirects.run(site, ctx);
  return {
    files: new Map(files.map((file: OutputFile) => [file.path, String(file.contents)])),
    reported,
  };
}

/** A lock whose record `new` had the given earlier addresses. */
function lock(previous: readonly string[]): string {
  return `${JSON.stringify({
    version: 1,
    collections: { pages: { new: { url: "/pages/new/", previous } } },
  })}\n`;
}

test("every earlier URL in the lock redirects to the current one in one hop", async () => {
  await withSite(
    { ...FILES, [URLS_LOCK_FILE]: lock(["/pages/old/", "/pages/middle/"]) },
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      const { files, reported } = await run(result.site);
      assert.deepEqual(reported, []);
      assert.match(files.get("pages/old/index.html")!, /url=\/pages\/new\//);
      assert.match(files.get("pages/middle/index.html")!, /url=\/pages\/new\//);
      assert.equal(files.get("_redirects"), "/pages/middle/ /pages/new/ 301\n/pages/old/ /pages/new/ 301\n");
    },
  );
});

test("an alias field names an earlier path and an earlier id, each redirecting to the record", async () => {
  await withSite(
    { ...FILES, "_data/pages.yml": '- id: new\n  name: New\n  aka: ["/old-path/", "old-id"]\n' },
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      const { files, reported } = await run(result.site);
      assert.deepEqual(reported, []);
      assert.match(files.get("old-path/index.html")!, /url=\/pages\/new\//);
      assert.match(files.get("pages/old-id/index.html")!, /url=\/pages\/new\//);
    },
  );
});

test("an alias that a live page uses is reported, and the page stays", async () => {
  await withSite(
    {
      ...FILES,
      "mizzen.yml": `${FILES["mizzen.yml"]}  other:\n    source: _data/other.yml\n    template: _templates/page.md\n    permalink: /pages/{id}/\n`,
      "_data/other.yml": "- id: taken\n  name: Taken\n",
      "_data/pages.yml": '- id: new\n  name: New\n  aka: ["/pages/taken/"]\n',
    },
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      const { reported } = await run(result.site);
      assert.deepEqual(reported.map((finding) => finding.id), ["redirects.over-page"]);
    },
  );
});

test("a removed record with gone writes a notice, and with a redirect sends readers to the target", async () => {
  const removed = { ...FILES, [URLS_LOCK_FILE]: lock([]), "_data/pages.yml": "[]\n" };
  await withSite({ ...removed, "mizzen.yml": `${FILES["mizzen.yml"]}    onRemoved: gone\n` }, async (_root, result) => {
    assert.deepEqual(ids(result), []);
    const { files } = await run(result.site);
    const notice = files.get("pages/new/index.html")!;
    assert.match(notice, /has been removed/);
    assert.match(notice, /name="robots" content="noindex"/);
    assert.match(notice, /<a href="\/">Continue<\/a>/);
  });
  await withSite(
    { ...removed, "mizzen.yml": `${FILES["mizzen.yml"]}    onRemoved:\n      redirect: /list/\n` },
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      const { files } = await run(result.site);
      assert.match(files.get("pages/new/index.html")!, /url=\/list\//);
      assert.equal(files.get("_redirects"), "/pages/new/ /list/ 301\n");
    },
  );
});

test("a gone notice links to the collection's list page when the site has one", async () => {
  await withSite(
    {
      ...FILES,
      [URLS_LOCK_FILE]: lock([]),
      "_data/pages.yml": "[]\n",
      "list.md": "---\ntitle: List\npermalink: /pages/\n---\n",
      "mizzen.yml": `${FILES["mizzen.yml"]}    onRemoved: gone\n`,
    },
    async (_root, result) => {
      assert.deepEqual(ids(result), []);
      const { files } = await run(result.site);
      assert.match(files.get("pages/new/index.html")!, /<a href="\/pages\/">Continue<\/a>/);
    },
  );
});
