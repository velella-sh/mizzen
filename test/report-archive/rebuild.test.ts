/**
 * Rebuild for #526: publish a second run, then rebuild the first report from the inputs its run pinned and compare the
 * output byte for byte. The run's identity and locked inputs come from `identifyRuns`; the inputs name the git ref the
 * first report was built from, so the rebuild reads that ref and the snapshot, never the current working tree.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataSnapshot } from "../../src/cli/data.ts";
import { readText } from "../../src/data/collections.ts";
import { lockText, readLock } from "../../src/data/lock.ts";
import { identifyRuns } from "../../src/data/report-archive/run.ts";
import { buildModel, type ModelResult } from "../../src/model/build.ts";
import type { Collection, CollectionSnapshot, Diagnostic } from "../../src/contracts/index.ts";
import { pageAt, site } from "../data-record-site.ts";

const FIRST = "2026-03-01T10:20:30Z";
const SECOND = "2026-03-08T10:20:30Z";

/** One published run. The commit is the input the run scanned, not the commit that writes the record. */
interface Scan {
  readonly id: string;
  readonly date: string;
  readonly commit: string;
}

const SCAN_1: Scan = { id: "scan-1", date: "2026-03-01", commit: "a".repeat(40) };
const SCAN_2: Scan = { id: "scan-2", date: "2026-03-08", commit: "b".repeat(40) };

/** The scans source, as the site writes it. */
function scansYaml(scans: readonly Scan[]): string {
  return scans.map((scan) => `- id: ${scan.id}\n  date: ${scan.date}\n  commit: "${scan.commit}"\n`).join("");
}

/** A site with a scans collection, a latest list, an archive list, and a record template that shows the snapshot. */
function files(scans: readonly Scan[]): Record<string, string> {
  return {
    "mizzen.yml":
      "title: Reproducible report archive\n" +
      "collections:\n" +
      "  scans:\n" +
      "    source: _data/scans.yml\n" +
      "    template: _templates/scan.md\n" +
      "    permalink: /scans/{id}/\n" +
      "    dates: [date]\n",
    "_data/scans.yml": scansYaml(scans),
    "_templates/scan.md":
      "---\ntitle: \"Scan {id}\"\n---\n" +
      "# Scan :field[id]\n\n" +
      "Date: :field[date] · Commit: :field[commit]\n\n" +
      "Snapshot: :snapshot[ref]\n",
    "scans/index.md":
      "---\ntitle: Latest scan\nlist:\n  collection: scans\n  sort: date desc\n  perPage: 1\n---\n# Latest scan\n",
    "archive/index.md":
      "---\ntitle: All scans\nlist:\n  collection: scans\n  sort: date desc\n---\n# All scans\n",
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

/** The scans collection as the build reads it, with the snapshot the lock holds. */
function collectionOf(root: string, snapshot: CollectionSnapshot): Collection {
  const problems: Diagnostic[] = [];
  const records = readText(
    "scans",
    "_data/scans.yml",
    "_data/scans.yml",
    readFileSync(join(root, "_data/scans.yml"), "utf8"),
    "id",
    problems,
  );
  assert.deepEqual(problems, []);
  assert.ok(records !== undefined);
  return { name: "scans", source: "_data/scans.yml", records, snapshot };
}

/** The ids a list page shows, in order. */
function listed(result: ModelResult, url: string): string[] {
  return pageAt(result, url)?.list?.records.map((record) => record.id) ?? [];
}

test("the first report rebuilt from its locked inputs matches the published output", async () => {
  const root = site(files([SCAN_1]));
  const rebuiltRoot = mkdtempSync(join(tmpdir(), "report-rebuild-"));
  try {
    git(root, FIRST, ["init", "-q"]);
    const firstCommit = commit(root, FIRST, "scan one", [
      "mizzen.yml",
      "_data/scans.yml",
      "_templates/scan.md",
      "scans/index.md",
      "archive/index.md",
    ]);
    assert.equal((await dataSnapshot({ root, name: "scans" })).code, 0);

    const published = await buildModel(root);
    assert.deepEqual(published.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    const original = pageAt(published, "/scans/scan-1/")!;
    assert.match(original.markdown, new RegExp(`Snapshot: ${firstCommit}`));

    const firstLock = await readLock(root);
    assert.deepEqual(firstLock.diagnostics, []);
    const snapshot = firstLock.lock.snapshots?.scans;
    assert.ok(snapshot !== undefined);
    const [run] = identifyRuns(collectionOf(root, snapshot)).runs;
    assert.ok(run !== undefined);
    assert.equal(snapshot.ref, firstCommit);
    assert.deepEqual(run.inputs, snapshot);

    writeFileSync(join(root, "_data/scans.yml"), scansYaml([SCAN_1, SCAN_2]));
    commit(root, SECOND, "scan two", ["_data/scans.yml"]);
    assert.equal((await dataSnapshot({ root, name: "scans" })).code, 0);

    const latest = await buildModel(root);
    assert.deepEqual(latest.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.deepEqual(listed(latest, "/scans/"), ["scan-2"]);
    assert.equal(pageAt(latest, "/scans/scan-1/")!.url, original.url, "the archived URL stays put");

    // Rebuild the first report from the inputs its run pinned: the tree at its ref, and its snapshot in the lock.
    execFileSync("tar", ["-x", "-C", rebuiltRoot], {
      input: execFileSync("git", ["archive", "--format=tar", run.inputs!.ref!], { cwd: root }),
    });
    writeFileSync(
      join(rebuiltRoot, "mizzen.lock.json"),
      lockText({ version: 1, sources: {}, snapshots: { scans: run.inputs! } }),
    );

    const rebuilt = await buildModel(rebuiltRoot);
    assert.deepEqual(rebuilt.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.equal(pageAt(rebuilt, "/scans/scan-2/"), undefined, "the rebuild holds only the run's inputs");
    const again = pageAt(rebuilt, "/scans/scan-1/")!;
    assert.equal(again.url, original.url);
    assert.equal(again.markdown, original.markdown);
    assert.equal(again.html, original.html);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(rebuiltRoot, { recursive: true, force: true });
  }
});
