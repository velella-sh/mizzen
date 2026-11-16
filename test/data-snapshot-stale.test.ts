import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { doctor } from "../src/cli/doctor.ts";
import { staleSnapshots } from "../src/data/snapshot.ts";

const snapshots = {
  fresh: { source: "a.yml", capturedAt: "2026-11-10" },
  old: { source: "b.yml", capturedAt: "2026-01-01T08:00:00Z" },
  undated: { source: "c.yml" },
};

test("a snapshot older than maxAgeDays on a fixed date is stale; fresh, undated and unset are not", () => {
  assert.deepEqual(staleSnapshots(snapshots, 30, "2026-11-16"), [{ collection: "old", capturedAt: "2026-01-01T08:00:00Z", ageDays: 319 }]);
  assert.deepEqual(staleSnapshots(snapshots, 400, "2026-11-16"), []);
  assert.deepEqual(staleSnapshots(snapshots, undefined, "2026-11-16"), []);
  assert.deepEqual(staleSnapshots(undefined, 30, "2026-11-16"), []);
  assert.deepEqual(staleSnapshots(snapshots, 30, "not a date"), []);
});

function site(extra: string): string {
  const root = mkdtempSync(join(tmpdir(), "snap-stale-"));
  mkdirSync(join(root, "_data"));
  writeFileSync(join(root, "mizzen.yml"), `collections:\n  items:\n    source: _data/items.yml\n${extra}`);
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n");
  writeFileSync(
    join(root, "mizzen.lock.json"),
    '{"snapshots":{"items":{"capturedAt":"2026-01-01","source":"_data/items.yml"}},"sources":{},"version":1}\n',
  );
  return root;
}

test("doctor reports a stale collection only when snapshot.maxAgeDays is set", async () => {
  const stale = (await doctor({ root: site("snapshot:\n  maxAgeDays: 30\n"), today: "2026-11-16" })).filter((d) => d.id === "doctor.snapshot-stale");
  assert.equal(stale.length, 1);
  assert.match(stale[0]!.message, /"items".*2026-01-01/);
  const silent = await doctor({ root: site(""), today: "2026-11-16" });
  assert.equal(silent.filter((d) => d.id === "doctor.snapshot-stale").length, 0);
});
