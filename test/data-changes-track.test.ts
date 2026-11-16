import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load.ts";
import { summaryOf, tracked, unknownTracked } from "../src/data/changes/track.ts";

function config(changelog: string) {
  const root = mkdtempSync(join(tmpdir(), "data-track-"));
  writeFileSync(join(root, "mizzen.yml"), `collections:\n  items:\n    source: _data/items.yml\n    changelog:\n${changelog}`);
  return loadConfig(root);
}

test("a tracked field is followed and nothing else is", () => {
  const loaded = config("      track: [title, price]\n      ignore: [price]\n      importThreshold: 5\n");
  assert.deepEqual(loaded.diagnostics, []);
  const changelog = loaded.config.collections.items!.changelog;
  assert.equal(changelog?.importThreshold, 5);
  const follows = tracked(changelog);
  assert.equal(follows("title"), true);
  assert.equal(follows("price"), false, "ignored wins over tracked");
  assert.equal(follows("other"), false, "no field is tracked by default");
  assert.equal(tracked(undefined)("title"), false);
});

test("a tracked field the collection does not have is named", () => {
  assert.deepEqual(unknownTracked({ track: ["title", "nope"] }, [{ fields: { title: "A" } }]), ["nope"]);
});

test("an unknown changelog key and a bad type are config errors", () => {
  assert.ok(config("      mystery: 1\n").diagnostics.length > 0);
  assert.ok(config("      track: title\n").diagnostics.length > 0);
});

test("a template writes the summary from the event and the record", () => {
  const changelog = { labels: { changed: "{title}: {field} {old} -> {new}" } };
  assert.equal(
    summaryOf(changelog, "changed", { id: "a", field: "price", old: 1, new: 2, record: { title: "Widget" } }),
    "Widget: price 1 -> 2",
  );
  assert.equal(summaryOf(changelog, "added", { id: "a" }), "Added a");
});
