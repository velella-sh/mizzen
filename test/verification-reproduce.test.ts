import assert from "node:assert/strict";
import { test } from "node:test";
import type { BuildReport } from "../src/reproduce/manifest.ts";
import { inputHashOf, reproductionEvidence } from "../src/verification/reproduce.ts";
import { verificationTask } from "./verification-fixture.ts";

/** A minimal valid build report. */
function report(
  hash: string,
  options: { readonly content?: Record<string, string>; readonly tool?: string; readonly files?: Record<string, string> } = {},
): BuildReport {
  return {
    format: 1,
    categories: ["inputs", "config", "tools", "environment", "outputs"],
    inputs: { locks: {}, data: {}, content: options.content ?? {} },
    config: {
      sha256: "1".repeat(64),
      rules: { defaults: [], redirects: {}, outputs: {}, collections: {}, feeds: [], calendars: [] },
    },
    tools: { mizzen: options.tool ?? "0.2.6", node: "24.0.0", theme: { name: "lateen", version: "1.0.0" } },
    environment: { timezone: "UTC", locale: "en-US" },
    outputs: { hash, files: options.files ?? {} },
  };
}

test("an identical rebuild matches and carries no differences", () => {
  const snapshot = verificationTask().snapshot;
  const evidence = reproductionEvidence({
    snapshot,
    expected: report("a".repeat(64), { files: { "index.html": "b".repeat(64) } }),
    actual: report("a".repeat(64), { files: { "index.html": "b".repeat(64) } }),
  });
  assert.equal(evidence.match, true);
  assert.equal(evidence.expectedHash, evidence.actualHash);
  assert.deepEqual(evidence.explained, []);
  assert.deepEqual(evidence.unexplained, []);
  assert.equal(evidence.inputHash, inputHashOf(snapshot));
  assert.equal(evidence.tool.expected, "0.2.6");
});

test("an output change with unchanged inputs is reported as unexplained", () => {
  const evidence = reproductionEvidence({
    snapshot: verificationTask().snapshot,
    expected: report("a".repeat(64), { files: { "index.html": "b".repeat(64) } }),
    actual: report("c".repeat(64), { files: { "index.html": "d".repeat(64) } }),
  });
  assert.equal(evidence.match, false);
  assert.deepEqual(evidence.explained, []);
  assert.ok(evidence.unexplained.some((difference) => difference.category === "outputs" && difference.path === "hash"));
});

test("an output change explained by an input change is kept apart from an unexplained one", () => {
  const evidence = reproductionEvidence({
    snapshot: verificationTask().snapshot,
    expected: report("a".repeat(64), { content: { "guide.md": "1".repeat(64) } }),
    actual: report("c".repeat(64), { content: { "guide.md": "2".repeat(64) } }),
  });
  assert.equal(evidence.match, false);
  assert.ok(evidence.explained.some((difference) => difference.category === "inputs" && difference.path === "content/guide.md"));
  assert.deepEqual(evidence.unexplained, []);
});

test("a different tool version cannot reproduce the hash", () => {
  const evidence = reproductionEvidence({
    snapshot: verificationTask().snapshot,
    expected: report("a".repeat(64)),
    actual: report("a".repeat(64), { tool: "0.2.7" }),
  });
  assert.equal(evidence.match, false);
  assert.deepEqual(evidence.tool, { expected: "0.2.6", actual: "0.2.7" });
});
