import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { BehaviorReport } from "../src/contracts/behavior.ts";
import { buildModel } from "../src/model/build.ts";
import { behaviorReportOf, compareBehaviorReports } from "../src/behavior/report.ts";
import {
  behavior,
  behaviorPage,
  behaviorTree,
  FIXTURE_CONFIG,
  symbol,
  testFile,
} from "./behavior-fixture.ts";

/** The two behaviors both fixture versions document. */
function entries(greetEvidence = "https://ci.example.org/runs/greet"): string[] {
  return [
    behavior({
      id: "greet.returns-name",
      title: "Greeting returns the name",
      normative: "A greeting includes the supplied name.",
      surface: ["symbol:greet"],
      testFile: "test/greet.test.ts",
      testName: "greet returns the name",
      evidenceUrl: greetEvidence,
    }),
    behavior({
      id: "farewell.returns-name",
      title: "Farewell returns the name",
      normative: "A farewell includes the supplied name.",
      surface: ["symbol:farewell"],
      testFile: "test/farewell.test.ts",
      testName: "farewell returns the name",
      evidenceUrl: "https://ci.example.org/runs/farewell",
    }),
  ];
}

/** A fixture at one API version and with one pair of test files. */
function site(options: {
  readonly greetSignature?: string;
  readonly greetTest?: string;
  readonly farewellTest?: string;
  readonly greetEvidence?: string;
} = {}): string {
  return behaviorTree({
    "mizzen.yml": FIXTURE_CONFIG,
    "pkg/index.ts": [
      symbol("greet", options.greetSignature ?? "(name: string): string"),
      symbol("farewell", "(name: string): string"),
    ].join("\n"),
    "test/greet.test.ts": options.greetTest ?? testFile("greet returns the name"),
    "test/farewell.test.ts": options.farewellTest ?? testFile("farewell returns the name"),
    "docs/api.md": behaviorPage(entries(options.greetEvidence)),
  });
}

async function reportOf(root: string, version: string): Promise<BehaviorReport> {
  const model = await buildModel(root);
  return (await behaviorReportOf({ site: model.site, root, version })).report;
}

test("#1356 an API change is traced from surface through tests and its documentation page, and drifts only the affected behavior", async () => {
  const oldRoot = site({ greetSignature: "(name: string): string" });
  const newRoot = site({ greetSignature: "(name: string, lang: string): string" });
  try {
    const before = await reportOf(oldRoot, "1.0.0");
    const after = await reportOf(newRoot, "1.1.0");
    const beforeGreet = before.behaviors.find((record) => record.id === "greet.returns-name")!;
    const afterGreet = after.behaviors.find((record) => record.id === "greet.returns-name")!;

    assert.equal(beforeGreet.page.url, afterGreet.page.url);
    assert.equal(beforeGreet.page.source, "docs/api.md");
    assert.equal(afterGreet.surface[0]?.source?.file, "pkg/index.ts");
    assert.equal(afterGreet.tests[0]?.file, "test/greet.test.ts");
    assert.notEqual(beforeGreet.surface[0]?.signature, afterGreet.surface[0]?.signature);

    const comparison = compareBehaviorReports(before, after);
    assert.deepEqual(comparison.added, []);
    assert.deepEqual(comparison.removed, []);
    assert.equal(comparison.unchanged, 1, "farewell is untouched");
    assert.deepEqual(comparison.drift.map((entry) => entry.behavior), ["greet.returns-name"]);
    const drift = comparison.drift[0]!;
    assert.deepEqual(drift.kinds, ["signature"]);
    assert.equal(drift.documentation.source.file, "docs/api.md");
    assert.equal(drift.documentation.normative, "A greeting includes the supplied name.");
    assert.equal(drift.tests.after[0]?.file, "test/greet.test.ts");
    assert.equal(drift.tests.after[0]?.state, "found");
    assert.notEqual(drift.surface.before[0]?.signature, drift.surface.after[0]?.signature);
    assert.equal(comparison.baseline, "1.0.0");
    assert.equal(comparison.current, "1.1.0");
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
    rmSync(newRoot, { recursive: true, force: true });
  }
});

test("#1354 a changed test flags only the behavior that links it", async () => {
  const oldRoot = site();
  const newRoot = site({
    farewellTest: `${testFile("farewell returns the name")}// a changed assertion\n`,
  });
  try {
    const comparison = compareBehaviorReports(await reportOf(oldRoot, "1.0.0"), await reportOf(newRoot, "1.1.0"));
    assert.deepEqual(comparison.drift.map((entry) => entry.behavior), ["farewell.returns-name"]);
    assert.deepEqual(comparison.drift[0]?.kinds, ["test"]);
    assert.equal(comparison.unchanged, 1);
    assert.notEqual(
      comparison.drift[0]?.tests.before[0]?.digest,
      comparison.drift[0]?.tests.after[0]?.digest,
      "the report includes the test file digest that changed",
    );
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
    rmSync(newRoot, { recursive: true, force: true });
  }
});

test("#1354 changed evidence flags the behavior and shows documentation and tests together", async () => {
  const oldRoot = site({ greetEvidence: "https://ci.example.org/runs/greet" });
  const newRoot = site({ greetEvidence: "https://ci.example.org/runs/greet-v2" });
  try {
    const comparison = compareBehaviorReports(await reportOf(oldRoot, "1.0.0"), await reportOf(newRoot, "1.1.0"));
    assert.deepEqual(comparison.drift.map((entry) => entry.behavior), ["greet.returns-name"]);
    assert.deepEqual(comparison.drift[0]?.kinds, ["evidence"]);
    const drift = comparison.drift[0]!;
    assert.equal(drift.documentation.title, "Greeting returns the name");
    assert.equal(drift.tests.after[0]?.outcome, "passed");
    assert.notEqual(drift.evidence.before[0]?.digest, drift.evidence.after[0]?.digest);
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
    rmSync(newRoot, { recursive: true, force: true });
  }
});
