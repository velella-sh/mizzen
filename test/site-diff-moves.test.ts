import assert from "node:assert/strict";
import { test } from "node:test";
import { diffBuilds } from "../src/diff/index.ts";
import { cleanup, writeBuild } from "./site-diff-builds.ts";

const stub = (to: string) => `<!doctype html><meta http-equiv="refresh" content="0; url=${to}">`;

test("a renamed file is a move; the old URL is broken without a redirect", async () => {
  const a = await writeBuild({ pages: [{ url: "/old/", source: "docs/guide.md", md: "# Guide\n" }] });
  const b = await writeBuild({ pages: [{ url: "/new/", source: "docs/guide.md", md: "# Guide\n" }] });
  const diff = await diffBuilds(a, b);
  assert.deepEqual(diff.pages.moved.map((m) => [m.from, m.to, m.by, m.redirect]), [["/old/", "/new/", "source", false]]);
  assert.deepEqual(diff.pages.removed, []);
  assert.deepEqual(diff.pages.added, []);
  assert.deepEqual(diff.brokenUrls, ["/old/"]);
  cleanup(a, b);
});

test("a move with a redirect at the old URL keeps it unbroken", async () => {
  const a = await writeBuild({ pages: [{ url: "/old/", source: "docs/guide.md", md: "# Guide\n" }] });
  const b = await writeBuild({
    pages: [{ url: "/new/", source: "docs/guide.md", md: "# Guide\n" }],
    files: { "old/index.html": stub("/new/") },
  });
  const diff = await diffBuilds(a, b);
  assert.equal(diff.pages.moved[0]!.redirect, true);
  assert.deepEqual(diff.brokenUrls, []);
  cleanup(a, b);
});

test("a renamed record is paired by its id", async () => {
  const rec = (id: string) => ({ record: { collection: "people", id, fields: { name: "Ada" } } });
  const a = await writeBuild({ pages: [{ url: "/people/ada/", source: "_data/people.yml#ada", md: "# Ada\n", json: rec("ada") }] });
  const b = await writeBuild({ pages: [{ url: "/people/ada-l/", source: "_data/people.yml#ada", md: "# Ada\n", json: rec("ada") }] });
  const diff = await diffBuilds(a, b);
  assert.equal(diff.pages.moved.length, 1);
  assert.equal(diff.pages.moved[0]!.to, "/people/ada-l/");
  cleanup(a, b);
});

test("pages that only look alike are never paired", async () => {
  const a = await writeBuild({ pages: [{ url: "/a/", source: "a.md", md: "# Same\n\nbody\n" }] });
  const b = await writeBuild({ pages: [{ url: "/b/", source: "b.md", md: "# Same\n\nbody\n" }] });
  const diff = await diffBuilds(a, b);
  assert.deepEqual(diff.pages.moved, []);
  assert.equal(diff.pages.removed.length, 1);
  assert.equal(diff.pages.added.length, 1);
  cleanup(a, b);
});
