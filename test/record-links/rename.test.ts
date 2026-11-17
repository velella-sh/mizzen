/**
 * #513: two sites share a record. The source's lock names the target's published `urls.json`; the record resolves by
 * its stable id, so a renamed slug reaches the new URL and the target still answers the old URL with a redirect. A
 * removed record is reported at the source reference and its old URL shows a removal notice.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OutputContext } from "../../src/contracts/output.ts";
import { readUrlsLock, writeUrlsLock, type UrlsLock } from "../../src/data/urls-lock.ts";
import { resolveRecordReference, type RecordReference } from "../../src/links/record-reference.ts";
import { recordTargets, type RecordTarget, type RecordUrlMap } from "../../src/links/record-targets.ts";
import { buildModel } from "../../src/model/build.ts";
import { redirects } from "../../src/outputs/redirects.ts";
import { urls } from "../../src/outputs/urls.ts";

const FIXTURE = new URL("../../fixtures/record-links/", import.meta.url);

/** The reference the source site writes in `links.md`. */
const reference: RecordReference = {
  project: "ebb",
  collection: "items",
  id: "ebb",
  pos: { file: "links.md", line: 4, column: 1, endLine: 4, endColumn: 5 },
};

/** One target in the source's record-link lock. */
interface LockTarget {
  readonly project: string;
  readonly public: boolean;
  /** The target's published `urls.json`, relative to the source site. */
  readonly urls: string;
  /** The target's `urls.lock.json`, with the earlier URLs and the removed records. */
  readonly previous?: string;
}

/** The source site's record-link lock. */
interface RecordLinkLock {
  readonly version: 1;
  readonly targets: readonly LockTarget[];
}

/** A context that renders nothing: the urls and redirects outputs do not need a page. */
const quiet: OutputContext = {
  renderPage: () => Promise.reject(new Error("the acceptance test never renders a page")),
  report: () => undefined,
};

/** Copies the two-site fixture into a temporary folder. */
async function withFixture(run: (site: { readonly source: string; readonly target: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mizzen-record-links-"));
  try {
    cpSync(fileURLToPath(new URL("target/", FIXTURE)), join(root, "target"), { recursive: true });
    cpSync(fileURLToPath(new URL("source/", FIXTURE)), join(root, "source"), { recursive: true });
    await run({ source: join(root, "source"), target: join(root, "target") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Builds the target, writes its published `urls.json`, and accepts the URL lock. */
async function publish(target: string, updateUrls = false) {
  const model = await buildModel(target, updateUrls ? { updateUrls: true } : {});
  assert.deepEqual(model.diagnostics.filter((finding) => finding.severity === "error"), []);
  const files = await urls.run(model.site, quiet);
  assert.equal(files.length, 1);
  writeFileSync(join(target, files[0]!.path), String(files[0]!.contents));
  await writeUrlsLock(target, model.urls.next);
  return model;
}

/** The source's lock entry for Ebb. */
function lockTarget(source: string): LockTarget {
  const lock = JSON.parse(readFileSync(join(source, "record-links.lock.json"), "utf8")) as RecordLinkLock;
  return lock.targets[0]!;
}

/** The target's current records, read from the map the source lock names. */
function currentTargets(source: string, target: LockTarget): readonly RecordTarget[] {
  const map = JSON.parse(readFileSync(resolve(source, target.urls), "utf8")) as RecordUrlMap;
  const read = recordTargets([{ project: target.project, public: target.public, urls: map }]);
  assert.deepEqual(read.diagnostics, []);
  return read.targets;
}

/** The target's earlier records, from the URL lock the source lock names. */
function previousTargets(source: string, target: LockTarget): readonly RecordTarget[] {
  if (target.previous === undefined) return [];
  const lock = JSON.parse(readFileSync(resolve(source, target.previous), "utf8")) as UrlsLock;
  const collections: Record<string, Record<string, string>> = {};
  for (const [collection, records] of Object.entries(lock.collections)) {
    collections[collection] = Object.fromEntries(Object.entries(records).map(([id, entry]) => [id, entry.url]));
  }
  const read = recordTargets([{ project: target.project, public: target.public, urls: { collections } }]);
  assert.deepEqual(read.diagnostics, []);
  return read.targets;
}

/** Resolves the reference from the source's locked inputs. */
function resolveAtSource(source: string) {
  const target = lockTarget(source);
  const previous = previousTargets(source, target);
  return resolveRecordReference(reference, {
    targets: currentTargets(source, target),
    ...(previous.length === 0 ? {} : { previous }),
  });
}

test("a renamed target record resolves by id, and the old URL still redirects to the new one", async () => {
  await withFixture(async ({ source, target }) => {
    await publish(target);
    const before = resolveAtSource(source);
    assert.deepEqual(before.diagnostics, []);
    assert.equal(before.resolved?.url, "https://example.org/ebb/items/ebb/");

    writeFileSync(join(target, "_data/items.yml"), "- id: ebb\n  name: Ebb Renamed\n- id: tide\n  name: Tide\n");
    const renamed = await publish(target, true);

    const locked = await readUrlsLock(target);
    assert.equal(locked.lock.collections.items?.ebb?.url, "/ebb/items/ebb-renamed/");
    assert.deepEqual(locked.lock.collections.items?.ebb?.previous, ["/ebb/items/ebb/"]);
    const after = resolveAtSource(source);
    assert.deepEqual(after.diagnostics, []);
    assert.equal(after.resolved?.url, "https://example.org/ebb/items/ebb-renamed/");

    const files = await redirects.run(renamed.site, quiet);
    const byPath = new Map(files.map((file) => [file.path, String(file.contents)]));
    assert.match(
      byPath.get("items/ebb/index.html") ?? "",
      /url=https:\/\/example\.org\/ebb\/items\/ebb-renamed\//,
      "the old URL still answers with a redirect to the new one",
    );
    assert.equal(byPath.get("_redirects"), "/items/ebb/ https://example.org/ebb/items/ebb-renamed/ 301\n");
  });
});

test("a removed target record is reported at the source reference, and its last URL answers with a notice", async () => {
  await withFixture(async ({ source, target }) => {
    await publish(target);
    writeFileSync(join(target, "_data/items.yml"), "- id: tide\n  name: Tide\n");
    const removed = await publish(target);

    const found = resolveAtSource(source);
    assert.equal(found.resolved, undefined);
    const diagnostic = found.diagnostics.find((finding) => finding.id === "network.record-removed");
    assert.equal(diagnostic?.severity, "error");
    assert.match(diagnostic?.message ?? "", /\/ebb\/items\/ebb\//);
    assert.equal(diagnostic?.pos?.file, "links.md");
    assert.equal(diagnostic?.pos?.line, 4);

    const files = await redirects.run(removed.site, quiet);
    const byPath = new Map(files.map((file) => [file.path, String(file.contents)]));
    assert.match(byPath.get("items/ebb/index.html") ?? "", /has been removed/);
  });
});
