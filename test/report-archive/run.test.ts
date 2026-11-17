import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, CollectionSnapshot, Diagnostic } from "../../src/contracts/index.ts";
import { readText } from "../../src/data/collections.ts";
import { identifyRuns } from "../../src/data/report-archive/run.ts";

const SNAPSHOT: CollectionSnapshot = {
  source: "_data/scans.yml",
  ref: "c".repeat(40),
  capturedAt: "2026-03-08T10:20:30Z",
  tool: "git",
  toolVersion: "2.50.0",
};

/** A scans collection read from YAML text, with the same loader the build uses. */
function collectionOf(text: string, snapshot?: CollectionSnapshot): Collection {
  const problems: Diagnostic[] = [];
  const records = readText("scans", "_data/scans.yml", "_data/scans.yml", text, "id", problems);
  assert.deepEqual(problems, []);
  assert.ok(records !== undefined);
  return { name: "scans", source: "_data/scans.yml", records, ...(snapshot === undefined ? {} : { snapshot }) };
}

test("reads a run id, date, commit, and locked inputs from configured fields", () => {
  const text =
    `- id: first\n  run: 2026-03-01-aaaa\n  ran: "2026-03-01"\n  sha: "${"a".repeat(40)}"\n` +
    `- id: second\n  run: 2026-03-08-bbbb\n  ran: "2026-03-08"\n  sha: "${"b".repeat(40)}"\n`;
  const result = identifyRuns(collectionOf(text, SNAPSHOT), {
    fields: { id: "run", date: "ran", commit: "sha" },
    published: [{ id: "2026-03-08-bbbb", date: "2026-03-08", commit: "b".repeat(40) }],
  });

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.runs, [
    { id: "2026-03-01-aaaa", date: "2026-03-01", commit: "a".repeat(40), inputs: SNAPSHOT },
    { id: "2026-03-08-bbbb", date: "2026-03-08", commit: "b".repeat(40), inputs: SNAPSHOT },
  ]);
});

test("two records with one run id are one error, and only the first run is kept", () => {
  const text =
    `- id: first\n  run: same\n  date: "2026-03-01"\n  commit: "${"a".repeat(40)}"\n` +
    `- id: second\n  run: same\n  date: "2026-03-08"\n  commit: "${"b".repeat(40)}"\n`;
  const result = identifyRuns(collectionOf(text), { fields: { id: "run" } });

  assert.deepEqual(result.runs.map((run) => [run.id, run.commit]), [["same", "a".repeat(40)]]);
  assert.equal(result.diagnostics.length, 1);
  const found = result.diagnostics[0]!;
  assert.equal(found.id, "data.report-run-duplicate-id");
  assert.equal(found.severity, "error");
  assert.match(found.message, /Record "second" of "scans" repeats run id "same"/);
  assert.match(found.message, /_data\/scans\.yml:1:3 \(_data\/scans\.yml:5:3\)/);
  assert.deepEqual([found.pos?.line, found.pos?.column], [5, 3]);
});

test("a published run whose inputs changed is an untracked overwrite and is left out", () => {
  const text = `- id: scan-1\n  date: "2026-03-08"\n  commit: "${"b".repeat(40)}"\n`;
  const result = identifyRuns(collectionOf(text, SNAPSHOT), {
    published: [{ id: "scan-1", date: "2026-03-01", commit: "a".repeat(40) }],
  });

  assert.deepEqual(result.runs, []);
  assert.equal(result.diagnostics.length, 1);
  const found = result.diagnostics[0]!;
  assert.equal(found.id, "data.report-run-untracked-overwrite");
  assert.equal(found.severity, "error");
  assert.match(found.message, new RegExp(`was published for 2026-03-01 at ${"a".repeat(40)}`));
  assert.match(found.message, new RegExp(`source now pins 2026-03-08 at ${"b".repeat(40)}`));
  assert.deepEqual([found.pos?.line, found.pos?.column], [1, 3]);
});

test("a record without a commit is reported, and no run is derived", () => {
  const result = identifyRuns(collectionOf(`- id: scan-1\n  date: "2026-03-01"\n`));

  assert.deepEqual(result.runs, []);
  assert.equal(result.diagnostics.length, 1);
  const found = result.diagnostics[0]!;
  assert.equal(found.id, "data.report-run-invalid");
  assert.match(found.message, /Record "scan-1" of "scans" has no `commit`/);
  assert.deepEqual([found.pos?.line, found.pos?.column], [1, 3]);
});
