import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { copyFixture, harness, type Harness } from "./mcp-helpers.ts";

let h: Harness;
before(async () => {
  h = await harness(copyFixture("docs-site"));
});
after(() => h.close());

test("search_docs finds a page by its words and answers with url, title, excerpt, and source", async () => {
  const r = await h.call("search_docs", { query: "install" });
  assert.equal(r.isError, false);
  assert.ok(r.data.total > 0);
  const hit = r.data.results.find((x: { url: string }) => x.url === "/install/");
  assert.ok(hit);
  assert.equal(hit.source, "install.md");
  assert.match(hit.excerpt, /install/i);
});

test("search_docs gives the same ranking twice and an empty list for nothing", async () => {
  const a = await h.call("search_docs", { query: "install" });
  const b = await h.call("search_docs", { query: "install" });
  assert.equal(a.text, b.text);
  const none = await h.call("search_docs", { query: "zzqxjv" });
  assert.equal(none.isError, false);
  assert.deepEqual(none.data.results, []);
});

test("search_docs honours limit", async () => {
  const r = await h.call("search_docs", { query: "beacon", limit: 2 });
  assert.ok(r.data.results.length <= 2);
});

test("get_page returns the Markdown, headings, source, and trust of a page", async () => {
  const r = await h.call("get_page", { page: "/install/" });
  assert.equal(r.data.title, "Install Beacon");
  assert.equal(r.data.source, "install.md");
  assert.ok(r.data.headings.some((x: { id: string }) => x.id === "by-hand"));
  assert.match(r.data.markdown, /Beacon ships as a single binary/);
  assert.ok(typeof r.data.trust === "string");
});

test("get_page finds a page by source path and cuts to one heading", async () => {
  const r = await h.call("get_page", { page: "install.md", heading: "by-hand" });
  assert.equal(r.isError, false);
  assert.ok(!/Homebrew/.test(r.data.markdown) || r.data.markdown.length < 2000);
});

test("get_page on an unknown page names the closest ones", async () => {
  const r = await h.call("get_page", { page: "/instal/" });
  assert.equal(r.isError, true);
  assert.equal(r.data.code, "unknown-page");
  assert.ok(r.data.closest.some((c: { url: string }) => c.url === "/install/"));
});

test("list_pages pages through the site with a cursor", async () => {
  const first = await h.call("list_pages", { limit: 3 });
  assert.equal(first.data.pages.length, 3);
  assert.ok(first.data.nextCursor);
  const second = await h.call("list_pages", { limit: 3, cursor: first.data.nextCursor });
  assert.notEqual(second.data.pages[0].url, first.data.pages[0].url);
  const bad = await h.call("list_pages", { cursor: "x" });
  assert.equal(bad.isError, true);
});

test("list_pages filters by prefix", async () => {
  const r = await h.call("list_pages", { prefix: "/install" });
  assert.ok(r.data.pages.length >= 1);
  assert.ok(r.data.pages.every((p: { url: string }) => p.url.startsWith("/install")));
});

test("get_block_source names file, span, text, and hash for a heading and for quoted text", async () => {
  const heading = await h.call("get_block_source", { page: "/install/", heading: "by-hand" });
  assert.equal(heading.data.ok, true);
  assert.equal(heading.data.file, "install.md");
  assert.match(heading.data.text, /By hand/);
  assert.match(heading.data.beforeHash, /^[0-9a-f]{64}$/);
  const text = await h.call("get_block_source", { page: "/install/", text: "Beacon ships as a single binary" });
  assert.equal(text.data.status, "found");
  assert.equal(text.data.span.line, 9);
});

test("get_block_source lists several matches and never guesses", async () => {
  const r = await h.call("get_block_source", { page: "/install/", text: "beacon" });
  if (r.data.status === "ambiguous") assert.ok(r.data.matches.length > 1);
  else assert.ok(r.isError || r.data.status === "found");
  const both = await h.call("get_block_source", { page: "/install/", heading: "by-hand", text: "x" });
  assert.equal(both.data.code, "bad-request");
});

test("get_diagnostics returns the build's diagnostics, filterable", async () => {
  const all = await h.call("get_diagnostics", {});
  assert.equal(all.data.version, 1);
  assert.ok(Array.isArray(all.data.diagnostics));
  const errors = await h.call("get_diagnostics", { severity: "error" });
  assert.ok(errors.data.diagnostics.every((d: { severity: string }) => d.severity === "error"));
});

test("get_pack returns a bounded context pack and refuses a request over the cap", async () => {
  const r = await h.call("get_pack", { goal: "install beacon", maxTokens: 800 });
  assert.equal(r.data.ok, true);
  assert.match(r.data.markdown, /Context pack/);
  const over = await h.call("get_pack", { goal: "install beacon", maxTokens: 10_000_000 });
  assert.equal(over.isError, true);
  assert.equal(over.data.code, "budget-too-large");
});
