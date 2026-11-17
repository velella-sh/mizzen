/**
 * The report archive gallery (#525): the existing latest page and list filters consume two published runs, show
 * each run's date and commit, and rebuild the same bytes. The fixture is `fixtures/report-archive/gallery/`.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel, type ModelResult } from "../../src/model/build.ts";
import { pageAt } from "../data-record-site.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/report-archive/gallery/", import.meta.url));
const SCANS = "_data/scans.yml";
const FIRST = { date: "2026-03-01", commit: "a".repeat(40) };
const SECOND = { date: "2026-03-08", commit: "b".repeat(40) };

/** A writable copy of the read-only fixture. */
function copy(): string {
  const root = mkdtempSync(join(tmpdir(), "report-gallery-"));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** The ids a list page shows, in order. */
function listed(result: ModelResult, url: string): string[] {
  return pageAt(result, url)?.list?.records.map((record) => record.id) ?? [];
}

/** The output bytes of every page, so two builds can be compared. */
function pages(result: ModelResult): { url: string; markdown: string; html: string }[] {
  return result.site.pages.map((page) => ({ url: page.url, markdown: page.markdown, html: page.html }));
}

test("the latest page and every gallery filter show the first run before the second is published", async () => {
  const root = copy();
  try {
    const source = readFileSync(join(FIXTURE, SCANS), "utf8");
    writeFileSync(join(root, SCANS), source.slice(0, source.indexOf("- id: scan-2")));

    const result = await buildModel(root);
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.deepEqual(listed(result, "/latest/"), ["scan-1"]);
    assert.equal(pageAt(result, "/latest/page/2/"), undefined);
    assert.deepEqual(listed(result, "/gallery/"), ["scan-1"]);
    assert.deepEqual(listed(result, "/gallery/clean/"), ["scan-1"]);
    assert.deepEqual(listed(result, "/gallery/recent/"), []);

    const card = pageAt(result, "/gallery/")!.markdown;
    assert.match(card, new RegExp(FIRST.date));
    assert.match(card, new RegExp(FIRST.commit));
    const record = pageAt(result, "/scans/scan-1/")!.markdown;
    assert.match(record, new RegExp(`Date: ${FIRST.date}`));
    assert.match(record, new RegExp(`Commit: ${FIRST.commit}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gallery rebuilds with the second run and keeps the first run visible", async () => {
  const root = copy();
  try {
    const result = await buildModel(root);
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);

    assert.deepEqual(listed(result, "/latest/"), ["scan-2"], "the latest page moves to the second run");
    assert.deepEqual(listed(result, "/latest/page/2/"), ["scan-1"], "the first run stays on page two");
    assert.deepEqual(listed(result, "/gallery/"), ["scan-2", "scan-1"], "the gallery keeps both runs");
    assert.deepEqual(listed(result, "/gallery/clean/"), ["scan-1"], "the status filter keeps the first run");
    assert.deepEqual(listed(result, "/gallery/recent/"), ["scan-2"], "the date filter keeps the second run");

    const gallery = pageAt(result, "/gallery/")!.markdown;
    for (const run of [SECOND, FIRST]) {
      assert.match(gallery, new RegExp(run.date));
      assert.match(gallery, new RegExp(run.commit));
    }
    assert.match(pageAt(result, "/scans/scan-2/")!.markdown, new RegExp(`Commit: ${SECOND.commit}`));

    assert.deepEqual(pages(await buildModel(root)), pages(result), "the same runs rebuild the same bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
