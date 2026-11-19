import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TraceDocument, TraceEvent, TraceReceipt } from "../src/contracts/trace.ts";
import { compareTraces, replayTrace } from "../src/trace/replay.ts";
import { traceFixture } from "./trace-fixture.ts";

/** One event with mutable top-level fields, for building a replay to compare. */
type MutableEvent = { -readonly [K in keyof TraceEvent]: TraceEvent[K] };

/** One receipt with mutable fields; its id is derived by the parser. */
interface MutableReceipt {
  id?: string;
  kind: TraceReceipt["kind"];
  reference: string;
}

/** The parts of a trace a replay test changes. */
interface MutableTrace {
  id?: string;
  nondeterministic?: readonly string[];
  readonly task: { id: string; goal: string };
  readonly events: MutableEvent[];
  receipts: MutableReceipt[];
}

/** A deep copy without the derived fields, so parse derives fresh ids and timing pointers. */
function replayed(trace: TraceDocument, change: (value: MutableTrace) => void): unknown {
  const value = structuredClone(trace) as unknown as MutableTrace;
  delete value.id;
  delete value.nondeterministic;
  value.receipts = value.receipts.map((receipt) => {
    const { id: _id, ...rest } = receipt;
    return rest;
  });
  change(value);
  return value;
}

test("replay accepts the recorded order, hashes, and results", () => {
  const result = replayTrace(traceFixture());
  assert.equal(result.ok, true);
  assert.equal(result.events, 5);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.differences, []);
});

test("replay refuses a snapshot other than the recorded one", () => {
  const result = replayTrace(traceFixture(), { snapshot: "0".repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0]?.code, "trace.replay-snapshot");
  assert.equal(result.events, 5);
});

test("timing is nondeterministic: a replay that differs only in time still matches", () => {
  const trace = traceFixture();
  const replay = replayed(trace, (value) => {
    value.events[0]!.durationMs = 999;
    value.events[1]!.at = "2027-01-01T00:00:00Z";
  });
  const result = replayTrace(trace, { expect: replay });
  assert.equal(result.ok, true, result.differences.map((difference) => difference.path).join(", "));
});

test("a different input hash, result, order, or receipt is reported with its path", () => {
  const trace = traceFixture();

  const hash = compareTraces(trace, replayed(trace, (value) => { value.events[2]!.inputHash = "0".repeat(64); }));
  assert.equal(hash.ok, false);
  assert.deepEqual(hash.differences.map((difference) => [difference.kind, difference.path]), [["hash", "/events/2/inputHash"]]);

  const result = compareTraces(trace, replayed(trace, (value) => { value.events[2]!.result = "other.proof.json"; }));
  assert.equal(result.differences[0]?.kind, "result");

  const order = compareTraces(trace, replayed(trace, (value) => { value.events.pop(); }));
  assert.equal(order.differences[0]?.kind, "order");

  const receipt = compareTraces(trace, replayed(trace, (value) => { value.receipts[0]!.reference = "other.json"; }));
  assert.equal(receipt.differences[0]?.kind, "receipt");
});

test("replay reads only: a file beside the trace keeps its bytes and mtime", () => {
  const folder = mkdtempSync(join(tmpdir(), "mizzen-trace-replay-"));
  try {
    const file = join(folder, "docs.md");
    writeFileSync(file, "# Install\n", "utf8");
    const before = { hash: createHash("sha256").update(readFileSync(file)).digest("hex"), mtime: statSync(file).mtimeMs };
    assert.equal(replayTrace(traceFixture()).ok, true);
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), before.hash);
    assert.equal(statSync(file).mtimeMs, before.mtime);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
