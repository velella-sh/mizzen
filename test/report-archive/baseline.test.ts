/**
 * Baseline for the report archive epic (#521): what the current snapshot, history, list, and record page outputs
 * already do with two published runs. Nothing here changes the engine; the confirmed gap is in
 * `docs/report-archive.md`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dataSnapshot } from "../../src/cli/data.ts";
import { dataChanges } from "../../src/data/changes/write.ts";
import { readLock } from "../../src/data/lock.ts";
import { buildModel, type ModelResult } from "../../src/model/build.ts";
import { pageAt, site } from "../data-record-site.ts";

const FIRST = "2026-03-01T10:20:30Z";
const SECOND = "2026-03-08T10:20:30Z";

/** One published run. The commit is the input the run scanned, not the commit that writes the record. */
interface Scan {
  readonly id: string;
  readonly date: string;
  readonly commit: string;
  readonly status: string;
}

const SCAN_1: Scan = { id: "scan-1", date: "2026-03-01", commit: "a".repeat(40), status: "clean" };
const SCAN_2: Scan = { id: "scan-2", date: "2026-03-08", commit: "b".repeat(40), status: "clean" };

/** The scans source, as the site writes it. */
function scansYaml(scans: readonly Scan[]): string {
  return scans
    .map((scan) => `- id: ${scan.id}\n  date: ${scan.date}\n  commit: "${scan.commit}"\n  status: ${scan.status}\n`)
    .join("");
}

/** A site with a scans collection, a latest list, an archive list, and a record template. */
function files(scans: readonly Scan[], snapshot = true): Record<string, string> {
  return {
    "mizzen.yml":
      "title: Report archive baseline\n" +
      "collections:\n" +
      "  scans:\n" +
      "    source: _data/scans.yml\n" +
      "    template: _templates/scan.md\n" +
      "    permalink: /scans/{id}/\n" +
      "    dates: [date]\n" +
      "    changelog:\n" +
      "      track: [status]\n" +
      "      pages: true\n",
    "_data/scans.yml": scansYaml(scans),
    "_templates/scan.md":
      "---\ntitle: \"Scan {id}\"\n---\n" +
      "# Scan :field[id]\n\n" +
      "Commit: :field[commit]\n\n" +
      (snapshot ? "Snapshot: :snapshot[ref]\n\n" : "") +
      "## History\n\n" +
      ":::changes\n- :field[date] :field[type] :field[record]\n:::\n",
    "scans/index.md":
      "---\ntitle: Latest scan\n" +
      "list:\n" +
      "  collection: scans\n" +
      "  where: { status: clean }\n" +
      "  sort: date desc\n" +
      "  perPage: 1\n" +
      "---\n# Latest scan\n",
    "archive/index.md":
      "---\ntitle: All scans\n" +
      "list:\n" +
      "  collection: scans\n" +
      "  where: { status: clean }\n" +
      "  sort: date desc\n" +
      "---\n# All scans\n",
  };
}

/** One git command with fixed author and committer dates. */
function git(root: string, date: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
}

/** Commits the named paths and returns the new commit. */
function commit(root: string, date: string, message: string, paths: readonly string[]): string {
  git(root, date, ["add", ...paths]);
  git(root, date, ["commit", "-q", "-m", message]);
  return git(root, date, ["rev-parse", "HEAD"]);
}

/** The history file's events, in file order. */
function events(root: string): { type: string; record: string; date: string; ref?: string; fields?: Record<string, unknown> }[] {
  return readFileSync(join(root, "data-changes", "scans.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; record: string; date: string; ref?: string; fields?: Record<string, unknown> });
}

/** The output bytes of every page, so two builds can be compared. */
function pages(result: ModelResult): { url: string; markdown: string; html: string }[] {
  return result.site.pages.map((page) => ({ url: page.url, markdown: page.markdown, html: page.html }));
}

/** The ids a list page shows, in order. */
function listed(result: ModelResult, url: string): string[] {
  return pageAt(result, url)?.list?.records.map((record) => record.id) ?? [];
}

test("snapshot and history date the second run and keep the first in the list", async () => {
  const root = site(files([SCAN_1]));
  try {
    const siteFiles = ["mizzen.yml", "_data/scans.yml", "_templates/scan.md", "scans/index.md", "archive/index.md"];
    git(root, FIRST, ["init", "-q"]);
    const firstCommit = commit(root, FIRST, "scan one", siteFiles);

    assert.equal((await dataSnapshot({ root, name: "scans" })).code, 0);
    assert.equal((await dataChanges({ root, write: true })).code, 0);

    const firstLock = await readLock(root);
    assert.deepEqual(firstLock.diagnostics, []);
    assert.deepEqual(firstLock.lock.snapshots?.scans, {
      source: "_data/scans.yml",
      ref: firstCommit,
      capturedAt: FIRST,
      tool: "git",
      toolVersion: firstLock.lock.snapshots?.scans?.toolVersion,
    });
    assert.deepEqual(events(root).map((event) => [event.type, event.record, event.date, event.ref]), [
      ["imported", "scans", FIRST, firstCommit],
    ]);

    const first = await buildModel(root);
    assert.deepEqual(first.diagnostics.filter((d) => d.severity === "error"), []);
    assert.deepEqual(listed(first, "/scans/"), ["scan-1"]);
    assert.equal(pageAt(first, "/scans/page/2/"), undefined);
    assert.deepEqual(listed(first, "/archive/"), ["scan-1"]);
    assert.match(pageAt(first, "/scans/scan-1/")!.markdown, new RegExp(`Commit: ${SCAN_1.commit}`));
    assert.match(pageAt(first, "/scans/scan-1/")!.markdown, new RegExp(`Snapshot: ${firstCommit}`));
    assert.equal(pageAt(first, "/scans/scan-1/")?.record?.changes, undefined);
    assert.deepEqual(pageAt(first, "/changes/scans/")?.list?.records.map((record) => record.fields["type"]), ["imported"]);

    writeFileSync(join(root, "_data/scans.yml"), scansYaml([SCAN_1, SCAN_2]));
    commit(root, SECOND, "scan two", ["_data/scans.yml"]);
    assert.equal((await dataSnapshot({ root, name: "scans" })).code, 0);
    assert.equal((await dataChanges({ root, write: true })).code, 0);

    const secondLock = await readLock(root);
    assert.deepEqual(secondLock.diagnostics, []);
    assert.equal(secondLock.lock.snapshots?.scans?.capturedAt, SECOND);
    assert.notEqual(secondLock.lock.snapshots?.scans?.ref, firstCommit);
    assert.deepEqual(Object.keys(secondLock.lock.snapshots ?? {}), ["scans"], "one current snapshot per collection");
    assert.deepEqual(events(root).map((event) => [event.type, event.record, event.date, event.fields]), [
      ["imported", "scans", FIRST, undefined],
      ["added", "scan-2", SECOND, { status: "clean" }],
    ]);

    const second = await buildModel(root);
    assert.deepEqual(second.diagnostics.filter((d) => d.severity === "error"), []);
    assert.deepEqual(listed(second, "/scans/"), ["scan-2"], "the latest list moves to the second run");
    assert.deepEqual(listed(second, "/scans/page/2/"), ["scan-1"], "the first run stays on the next page");
    assert.deepEqual(listed(second, "/archive/"), ["scan-2", "scan-1"], "the filtered list keeps both runs");
    assert.equal(pageAt(second, "/scans/scan-1/")?.record?.id, "scan-1");
    assert.equal(pageAt(second, "/scans/scan-2/")?.record?.changes?.map((event) => event.type).join(), "added");
    assert.match(pageAt(second, "/scans/scan-2/")!.markdown, new RegExp(`Commit: ${SCAN_2.commit}`));
    assert.deepEqual(pageAt(second, "/changes/scans/")?.list?.records.map((record) => record.fields["type"]), [
      "added",
      "imported",
    ]);

    // The collection snapshot is the newest one on every record page, including the one archived first.
    assert.match(pageAt(second, "/scans/scan-1/")!.markdown, new RegExp(`Commit: ${SCAN_1.commit}`));
    assert.match(
      pageAt(second, "/scans/scan-1/")!.markdown,
      new RegExp(`Snapshot: ${secondLock.lock.snapshots?.scans?.ref}`),
    );
    assert.doesNotMatch(pageAt(second, "/scans/scan-1/")!.markdown, new RegExp(`Snapshot: ${firstCommit}`));

    assert.deepEqual(pages(await buildModel(root)), pages(second), "the same data and lock rebuild the same bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first record page keeps its URL and bytes when a second run is published", async () => {
  const root = site(files([SCAN_1], false));
  try {
    const first = await buildModel(root);
    assert.deepEqual(first.diagnostics.filter((d) => d.severity === "error"), []);
    const archived = pageAt(first, "/scans/scan-1/")!;
    const markdown = archived.markdown;
    const html = archived.html;

    writeFileSync(join(root, "_data/scans.yml"), scansYaml([SCAN_1, SCAN_2]));
    const second = await buildModel(root);
    assert.deepEqual(second.diagnostics.filter((d) => d.severity === "error"), []);
    assert.deepEqual(listed(second, "/scans/"), ["scan-2"]);
    assert.deepEqual(listed(second, "/scans/page/2/"), ["scan-1"]);
    assert.deepEqual(listed(second, "/archive/"), ["scan-2", "scan-1"]);

    const rebuilt = pageAt(second, "/scans/scan-1/")!;
    assert.equal(rebuilt.url, archived.url);
    assert.equal(rebuilt.markdown, markdown);
    assert.equal(rebuilt.html, html);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
