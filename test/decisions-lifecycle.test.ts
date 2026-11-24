/**
 * #1359 and #1361: the decision lifecycle and its validity.
 *
 * The five statuses relate through `supersedes`, and a supersession cycle is refused. `supersededBy` is derived from
 * the other records. Validity is by version or snapshot, and a historical question resolves the decision in effect
 * then, not the newest record.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionRecord } from "../src/contracts/index.ts";
import { applyLifecycle, appliesAt, compareVersions, inEffectAt } from "../src/decisions/lifecycle.ts";
import { parseDecision } from "../src/decisions/parse.ts";

/** A record built from front matter, with no body. */
function record(id: string, status: DecisionRecord["status"], date: string, extra: readonly string[] = []): DecisionRecord {
  const text = [
    "---",
    `id: ${id}`,
    `title: ${id}`,
    `status: ${status}`,
    `date: ${date}`,
    "source: x",
    ...extra,
    "---",
    "",
    "## Decision",
    `Do ${id}.`,
  ].join("\n");
  const parsed = parseDecision(text, { file: `${id}.md` });
  assert.ok(parsed.record, JSON.stringify(parsed.diagnostics));
  return parsed.record!;
}

test("#1359 supersededBy is derived from the records that name it in supersedes", () => {
  const one = record("ADR-1", "superseded", "2025-01-01");
  const two = record("ADR-2", "accepted", "2025-02-01", ["supersedes: [ADR-1]"]);
  const lifecycle = applyLifecycle([one, two]);
  assert.deepEqual(lifecycle.problems, []);
  const byId = new Map(lifecycle.records.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get("ADR-1")?.supersededBy, ["ADR-2"]);
  assert.deepEqual(byId.get("ADR-2")?.supersededBy, []);
});

test("#1359 a supersession cycle is refused, and its members are never in effect", () => {
  const a = record("A", "accepted", "2025-01-01", ["supersedes: [B]"]);
  const b = record("B", "accepted", "2025-02-01", ["supersedes: [A]"]);
  const lifecycle = applyLifecycle([a, b]);
  const cycle = lifecycle.problems.find((problem) => problem.id === "decision.supersession-cycle");
  assert.ok(cycle, JSON.stringify(lifecycle.problems));
  assert.equal(cycle?.severity, "error");
  const resolved = inEffectAt(lifecycle.records, {}, new Set(lifecycle.cycles.flat()));
  assert.equal(resolved.current, undefined);
});

test("#1359 a record that supersedes itself is an error", () => {
  const self = record("A", "accepted", "2025-01-01", ["supersedes: [A]"]);
  const lifecycle = applyLifecycle([self]);
  assert.ok(lifecycle.problems.some((problem) => problem.id === "decision.self-supersession"));
});

test("#1361 a version-bounded decision applies only to the version it names", () => {
  const one = record("ADR-1", "superseded", "2025-01-01", ["validity:\n  versions: [v1]"]);
  assert.equal(appliesAt(one, { version: "v1" }), true);
  assert.equal(appliesAt(one, { version: "v2" }), false);
  // A question with no version is not excluded by a version bound.
  assert.equal(appliesAt(one, {}), true);
});

test("#1361 a historical question answers the decision in effect then, not the newest", () => {
  const one = record("ADR-1", "superseded", "2025-01-01", ["validity:\n  versions: [v1]"]);
  const two = record("ADR-2", "accepted", "2025-02-01", ["supersedes: [ADR-1]", "validity:\n  versions: [v2]"]);
  const lifecycle = applyLifecycle([one, two]);

  const atV1 = inEffectAt(lifecycle.records, { version: "v1" });
  assert.equal(atV1.current?.id, "ADR-1");
  assert.deepEqual(atV1.history.map((entry) => entry.id), []);

  const atV2 = inEffectAt(lifecycle.records, { version: "v2" });
  assert.equal(atV2.current?.id, "ADR-2");
  assert.deepEqual(atV2.history.map((entry) => entry.id), ["ADR-1"]);
});

test("#1361 a snapshot-bounded decision applies only when the question names that snapshot", () => {
  const one = record("ADR-1", "accepted", "2025-01-01", ["validity:\n  snapshots: [build-1]"]);
  assert.equal(appliesAt(one, { snapshot: "build-1" }), true);
  assert.equal(appliesAt(one, { snapshot: "build-2" }), false);
  assert.equal(appliesAt(one, {}), true);
});

test("#1361 a from/until range is inclusive, and a reversed range is an error", () => {
  const range = record("ADR-1", "accepted", "2025-01-01", ["validity:\n  from: v1.2\n  until: v2.0"]);
  assert.equal(appliesAt(range, { version: "v1.2" }), true);
  assert.equal(appliesAt(range, { version: "v2.0" }), true);
  assert.equal(appliesAt(range, { version: "v2.1" }), false);
  const reversed = record("ADR-2", "accepted", "2025-01-01", ["validity:\n  from: v2\n  until: v1"]);
  assert.ok(applyLifecycle([reversed]).problems.some((problem) => problem.id === "decision.validity-range"));
});

test("#1361 versions are compared by their numeric segments", () => {
  assert.equal(compareVersions("v1", "v1.0"), 0);
  assert.equal(compareVersions("v1.2", "v1.10"), -1);
  assert.equal(compareVersions("v2", "v1.9"), 1);
});
