import assert from "node:assert/strict";
import { test } from "node:test";
import type { Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { loadConfig } from "../src/config/load.ts";
import { sha256 } from "../src/data/lock.ts";
import { collectionCsv } from "../src/outputs/collection-csv.ts";
import { collectionJson } from "../src/outputs/collection-json.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pos = { file: "_data/posts.yml", startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
const ctx: OutputContext = { renderPage: () => Promise.reject(new Error("no pages")), report: () => {} };

function config(collections: SiteConfig["collections"], outputs: SiteConfig["outputs"] = {}): SiteConfig {
  return {
    title: "T", base: "", lang: "en", dir: "ltr", languages: [], source: ".", include: [], exclude: [],
    navigation: "_data/navigation.yml", collections, feeds: {}, defaults: [], theme: { options: {} }, search: {}, redirects: {}, outputs,
  };
}

function site(collections: SiteConfig["collections"], outputs: SiteConfig["outputs"] = {}): Site {
  const records = [
    { id: "b", fields: { title: "Beta, the \"second\"", secret: "x" }, position: pos, fieldPositions: {} },
    { id: "a", fields: { title: "Alpha", secret: "y", tags: ["t"] }, position: pos, fieldPositions: {} },
  ];
  return {
    config: config(collections, outputs),
    pages: [],
    nav: {},
    collections: {
      posts: { name: "posts", source: "_data/posts.yml", records, snapshot: { source: "_data/posts.yml", ref: "abc", capturedAt: "2026-03-01" } },
      hidden: { name: "hidden", source: "_data/hidden.yml", records },
    },
    data: {},
  };
}

const COLLECTIONS = { posts: { source: "_data/posts.yml", raw: { private: ["secret"] } }, hidden: { source: "_data/hidden.yml", raw: false as const } };

test("raw JSON carries the snapshot and leaves out a private field, CSV matches, and checksums match the files", async () => {
  const s = site(COLLECTIONS);
  const json = await collectionJson.run(s, ctx);
  const csv = await collectionCsv.run(s, ctx);
  const raw = json.find((f) => f.path === "data/posts.raw.json")!;
  const body = JSON.parse(raw.contents as string);
  assert.deepEqual(body.snapshot, { source: "_data/posts.yml", ref: "abc", capturedAt: "2026-03-01" });
  assert.deepEqual(body.records.map((r: { id: string }) => r.id), ["b", "a"]);
  assert.ok(!(raw.contents as string).includes("secret"));

  const table = csv.find((f) => f.path === "data/posts.csv")!.contents as string;
  assert.equal(table, 'id,title,tags\nb,"Beta, the ""second""",\na,Alpha,"[""t""]"\n');
  const sums = csv.find((f) => f.path === "data/posts.sha256")!.contents as string;
  assert.equal(sums, `${sha256(table)}  posts.csv\n${sha256(raw.contents as string)}  posts.raw.json\n`);
  assert.deepEqual(csv.map((f) => f.path), ["data/posts.csv", "data/posts.sha256"]);
});

test("a collection that turns raw output off gets no raw file, and the checksum drops a JSON the build does not write", async () => {
  const s = site(COLLECTIONS);
  const paths = [...(await collectionJson.run(s, ctx)), ...(await collectionCsv.run(s, ctx))].map((f) => f.path);
  assert.ok(!paths.some((p) => p.startsWith("data/hidden.") && p !== "data/hidden.json"));
  const off = await collectionCsv.run(site(COLLECTIONS, { "collection-json": false }), ctx);
  assert.equal((off.find((f) => f.path === "data/posts.sha256")!.contents as string).split("\n").filter(Boolean).length, 1);
});

test("raw config is read from mizzen.yml", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-config-"));
  writeFileSync(join(root, "mizzen.yml"), "collections:\n  a:\n    source: a.yml\n    raw:\n      private: [secret]\n  b:\n    source: b.yml\n    raw: false\n");
  const loaded = loadConfig(root);
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.config.collections["a"]?.raw, { private: ["secret"] });
  assert.equal(loaded.config.collections["b"]?.raw, false);
});
