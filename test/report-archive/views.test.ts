import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, Diagnostic } from "../../src/contracts/index.ts";
import { readText } from "../../src/data/collections.ts";
import { identifyRuns } from "../../src/data/report-archive/run.ts";
import { reportViews } from "../../src/data/report-archive/views.ts";

const FIRST = { id: "scan-1", date: "2026-03-01", commit: "a".repeat(40) };
const SECOND = { id: "scan-2", date: "2026-03-08", commit: "b".repeat(40) };
const OPTIONS = { latest: "/reports/latest/", archive: "/reports/{id}/", base: "" };

/** A scans collection read from YAML text, with the same loader the build uses. */
function collectionOf(scans: readonly { readonly id: string; readonly date: string; readonly commit: string }[]): Collection {
  const text = scans
    .map((scan) => `- id: ${scan.id}\n  date: ${scan.date}\n  commit: "${scan.commit}"\n`)
    .join("");
  const problems: Diagnostic[] = [];
  const records = readText("scans", "_data/scans.yml", "_data/scans.yml", text, "id", problems);
  assert.deepEqual(problems, []);
  assert.ok(records !== undefined);
  return { name: "scans", source: "_data/scans.yml", records };
}

test("the latest report has one URL and each run has an archived URL built from its id", () => {
  const views = reportViews(identifyRuns(collectionOf([FIRST, SECOND])).runs, OPTIONS);

  assert.equal(views.latest, "/reports/latest/");
  assert.deepEqual(views.archived, [
    { id: "scan-1", url: "/reports/scan-1/" },
    { id: "scan-2", url: "/reports/scan-2/" },
  ]);
});

test("publishing a second run moves neither the latest URL nor the first run's archived URL", () => {
  const before = reportViews(identifyRuns(collectionOf([FIRST])).runs, OPTIONS);
  const after = reportViews(identifyRuns(collectionOf([FIRST, SECOND])).runs, OPTIONS);

  assert.equal(after.latest, before.latest);
  assert.deepEqual(after.archived[0], before.archived[0]);
  assert.equal(after.archived[0]!.url, "/reports/scan-1/");
  assert.equal(after.archived[1]!.url, "/reports/scan-2/");
});
