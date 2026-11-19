import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { TaskSnapshot } from "../src/contracts/index.ts";
import type { TraceDocument } from "../src/contracts/trace.ts";
import { parseTrace, TRACE_VERSION } from "../src/trace/parse.ts";
import { TraceRecorder, TraceRecordError } from "../src/trace/record.ts";
import { inputHashOf, referenceProblem } from "../src/trace/safe.ts";
import { taskSnapshot } from "../src/tasks/snapshot.ts";

const schema = JSON.parse(
  readFileSync(new URL("../schema/trace.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

const SNAPSHOT: TaskSnapshot = taskSnapshot({
  content: "a".repeat(64),
  data: "b".repeat(64),
  config: "c".repeat(64),
  tooling: "d".repeat(64),
});

function recorded(): TraceDocument {
  const recorder = new TraceRecorder({
    task: { id: "e".repeat(64), goal: "Update the install guide" },
    snapshot: SNAPSHOT,
  });
  recorder.append({
    stage: "context",
    kind: "context",
    capability: "pack",
    status: "ok",
    input: { topic: "install" },
    result: "pack/install.json",
    cost: { contextTokens: 1200, refillTokens: 0, toolCalls: 0 },
  });
  recorder.receipt("pack", "pack/install.json");
  recorder.append({
    stage: "edit",
    kind: "edit",
    capability: "edit.apply",
    status: "ok",
    input: { patch: "install.patch.json" },
    result: "install.proof.json",
    file: "docs/install.md",
    links: { patch: "f".repeat(64), span: { line: 4, column: 1, endLine: 4, endColumn: 9 }, diff: "1".repeat(64) },
    durationMs: 42,
  });
  recorder.receipt("proof", "install.proof.json");
  return recorder.document();
}

test("the trace schema is closed, versioned, and the recorder output matches it", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["version", "task", "snapshot", "events", "receipts"]);
  assert.equal(TRACE_VERSION, 1);

  const trace = recorded();
  assert.equal(validate(trace), true, validate.errors?.map((error) => `${error.instancePath} ${error.message}`).join("; ") ?? "");
  assert.deepEqual(parseTrace(trace).trace, trace);
  assert.match(trace.id, /^[0-9a-f]{64}$/);
});

test("events are ordered from zero and every later event names an earlier parent", () => {
  const trace = recorded();
  const second = { ...trace.events[1]!, sequence: 3 };
  const [outOfOrder] = parseTrace({ ...trace, events: [trace.events[0]!, second] }).problems;
  assert.ok(outOfOrder);
  assert.equal(outOfOrder.code, "trace.sequence");

  const [noParent] = parseTrace({
    ...trace,
    id: undefined,
    events: [trace.events[0]!, { ...trace.events[1]!, parent: null }],
  }).problems;
  assert.ok(noParent);
  assert.equal(noParent.code, "trace.parent");

  const [futureParent] = parseTrace({
    ...trace,
    id: undefined,
    events: [trace.events[0]!, { ...trace.events[1]!, parent: 2 }],
  }).problems;
  assert.ok(futureParent);
  assert.equal(futureParent.path, "/events/1/parent");

  const [rootParent] = parseTrace({
    ...trace,
    id: undefined,
    events: [{ ...trace.events[0]!, parent: 0 }, trace.events[1]!],
  }).problems;
  assert.ok(rootParent);
  assert.equal(rootParent.path, "/events/0/parent");
});

test("a tampered id, snapshot, or receipt id is refused", () => {
  const trace = recorded();
  const [id] = parseTrace({ ...trace, id: "0".repeat(64) }).problems;
  assert.ok(id);
  assert.equal(id.code, "trace.id");

  const [snapshot] = parseTrace({ ...trace, snapshot: { ...trace.snapshot, content: "0".repeat(64) } }).problems;
  assert.ok(snapshot);
  assert.equal(snapshot.code, "trace.snapshot");

  const [receipt] = parseTrace({
    ...trace,
    receipts: [{ ...trace.receipts[0]!, id: "0".repeat(64) }],
    id: undefined,
  }).problems;
  assert.ok(receipt);
  assert.equal(receipt.code, "trace.receipt-id");
});

test("a tool call keeps the input hash and result reference, and no input body", () => {
  const trace = recorded();
  const event = trace.events[0]!;
  assert.equal(event.inputHash, inputHashOf({ topic: "install" }));
  assert.equal(event.result, "pack/install.json");
  assert.equal(JSON.stringify(trace).includes("install.patch.json"), false);
  assert.deepEqual(trace.receipts.map((receipt) => receipt.reference), ["pack/install.json", "install.proof.json"]);
});

test("sensitive values are refused before an event is appended", () => {
  const recorder = new TraceRecorder({ task: { id: "e".repeat(64), goal: "Update" }, snapshot: SNAPSHOT });
  assert.throws(
    () => recorder.append({
      stage: "edit",
      kind: "edit",
      capability: "edit.apply",
      status: "ok",
      input: { reasoning: "private" },
    }),
    (err: unknown) => err instanceof TraceRecordError && err.problems[0]?.code === "trace.private-reasoning",
  );
  assert.throws(
    () => recorder.append({ stage: "edit", kind: "edit", capability: "edit.apply", status: "ok", result: "/Users/alice/site/proof.json" }),
    (err: unknown) => err instanceof TraceRecordError && err.problems[0]?.code === "trace.reference",
  );
  assert.equal(
    recorder.append({ stage: "edit", kind: "edit", capability: "edit.apply", status: "skipped", input: {} }).sequence,
    0,
  );

  assert.equal(referenceProblem("docs/install.md"), undefined);
  assert.notEqual(referenceProblem("https://user:pass@example.com/x"), undefined);
  assert.equal(referenceProblem("docs/install.md"), undefined);
  assert.equal(referenceProblem("https://example.com/install"), undefined);
});
