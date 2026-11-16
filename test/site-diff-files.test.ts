import assert from "node:assert/strict";
import { test } from "node:test";
import { diffBuilds } from "../src/diff/index.ts";
import { cleanup, writeBuild } from "./site-diff-builds.ts";

const page = { url: "/", title: "Home", md: "# Home\n" };

test("a changed hashed stylesheet is one changed file under its plain name", async () => {
  const a = await writeBuild({ pages: [page], files: { "assets/theme/base-aaaaaaaaaaaaaaaa.css": "a{}" } });
  const b = await writeBuild({ pages: [page], files: { "assets/theme/base-bbbbbbbbbbbbbbbb.css": "a{color:red}" } });
  const diff = await diffBuilds(a, b);
  assert.deepEqual(diff.files.added, []);
  assert.deepEqual(diff.files.removed, []);
  assert.equal(diff.files.changed.length, 1);
  assert.equal(diff.files.changed[0]!.name, "assets/theme/base.css");
  assert.deepEqual(diff.files.changed[0]!.size, { before: 3, after: 12 });
  cleanup(a, b);
});

test("a new feed entry is an added file", async () => {
  const a = await writeBuild({ pages: [page] });
  const b = await writeBuild({ pages: [page], files: { "feed.xml": "<feed/>" } });
  const diff = await diffBuilds(a, b);
  assert.deepEqual(diff.files.added.map((f) => f.name), ["feed.xml"]);
  cleanup(a, b);
});

test("a changed search index is a changed file in its own group", async () => {
  const a = await writeBuild({ pages: [page], files: { "pagefind/pagefind.js": "1" } });
  const b = await writeBuild({ pages: [page], files: { "pagefind/pagefind.js": "22" } });
  const diff = await diffBuilds(a, b);
  assert.equal(diff.files.changed[0]!.group, "pagefind");
  cleanup(a, b);
});

test("files a page owns are not listed as files", async () => {
  const a = await writeBuild({ pages: [page] });
  const b = await writeBuild({ pages: [{ ...page, md: "# Home\n\nmore\n" }] });
  const diff = await diffBuilds(a, b);
  assert.deepEqual(diff.files.changed, []);
  cleanup(a, b);
});
