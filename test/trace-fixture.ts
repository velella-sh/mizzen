import assert from "node:assert/strict";
import type { TraceDocument } from "../src/contracts/trace.ts";
import { inputHashOf } from "../src/trace/safe.ts";
import { TraceRecorder } from "../src/trace/record.ts";
import { taskSnapshot } from "../src/tasks/snapshot.ts";

/** The snapshot every fixture is pinned to. */
export const FIXTURE_SNAPSHOT = taskSnapshot({
  content: "a".repeat(64),
  data: "b".repeat(64),
  config: "c".repeat(64),
  tooling: "d".repeat(64),
});

/** The task id every fixture records against. */
export const FIXTURE_TASK = { id: "e".repeat(64), goal: "Update the install guide" };

/** A deterministic clock, so a fixture with timing still serializes the same way. */
export const FIXTURE_NOW = (): string => "2026-03-01T10:00:00Z";

/** A complete trace: context, a decision, an edit with links, a failed verification, and an approval. */
export function traceFixture(): TraceDocument {
  const recorder = new TraceRecorder({ task: FIXTURE_TASK, snapshot: FIXTURE_SNAPSHOT, now: FIXTURE_NOW });
  recorder.append({
    stage: "context",
    kind: "context",
    capability: "pack",
    status: "ok",
    input: { topic: "install" },
    result: "pack/install.json",
    subtask: "research",
    links: { pack: inputHashOf("pack body") },
    cost: { contextTokens: 100, refillTokens: 20, toolCalls: 1 },
    durationMs: 10,
  });
  recorder.receipt("pack", "pack/install.json");
  recorder.append({
    stage: "decision",
    kind: "decision",
    capability: "pack",
    status: "ok",
    input: { topic: "install" },
    subtask: "research",
    reason: "The install page is the source of truth.",
    policy: "policy.context-source",
    cost: { contextTokens: 0, refillTokens: 0, toolCalls: 1 },
  });
  recorder.append({
    stage: "edit",
    kind: "edit",
    capability: "edit.apply",
    status: "ok",
    input: { file: "docs/install.md", beforeHash: "1".repeat(64) },
    result: "install.proof.json",
    file: "docs/install.md",
    subtask: "write",
    links: {
      patch: "2".repeat(64),
      span: { line: 4, column: 1, endLine: 4, endColumn: 9 },
      transaction: "3".repeat(64),
      diff: "4".repeat(64),
    },
    cost: { contextTokens: 50, refillTokens: 0, toolCalls: 1 },
    durationMs: 25,
  });
  recorder.receipt("proof", "install.proof.json");
  recorder.append({
    stage: "verify",
    kind: "verify",
    capability: "edit.verify",
    status: "failed",
    input: { proof: "install.proof.json" },
    result: "install.proof.json",
    file: "docs/install.md",
    subtask: "verify",
    reason: "The doctor found one error.",
    cost: { contextTokens: 10, refillTokens: 5, toolCalls: 1 },
    durationMs: 8,
  });
  recorder.receipt("verification", "install.proof.json");
  recorder.append({
    stage: "decision",
    kind: "approval",
    capability: "edit.verify",
    status: "ok",
    input: { proof: "install.proof.json" },
    subtask: "verify",
    reason: "The proof matches the source after the fix.",
    policy: "policy.proof-required",
    cost: { contextTokens: 0, refillTokens: 0, toolCalls: 1 },
  });
  return recorder.document();
}

/** A trace long enough to bound: `count` ordinary calls, one decision, and receipts on the third. */
export function longTraceFixture(count = 20): TraceDocument {
  const recorder = new TraceRecorder({ task: FIXTURE_TASK, snapshot: FIXTURE_SNAPSHOT });
  for (let index = 0; index < count; index += 1) {
    const decision = index === Math.floor(count / 2);
    recorder.append({
      stage: decision ? "decision" : "verify",
      kind: decision ? "decision" : "verify",
      capability: `call.${index}`,
      status: "ok",
      input: { index },
      result: index === 2 ? "call-2.proof.json" : `call-${index}.json`,
      file: `docs/page-${index}.md`,
      subtask: "bulk",
      cost: { contextTokens: 1, refillTokens: 0, toolCalls: 1 },
      ...(decision ? { reason: "Keep this one.", policy: "policy.keep" } : {}),
    });
  }
  recorder.receipt("proof", "call-2.proof.json");
  return recorder.document();
}

/** Asserts that a trace parses and returns it; keeps tests honest about the public shape. */
export function assertTrace(trace: TraceDocument): TraceDocument {
  assert.equal(typeof trace.id, "string");
  assert.ok(trace.events.length > 0);
  return trace;
}
