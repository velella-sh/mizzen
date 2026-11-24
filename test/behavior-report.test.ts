import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { BehaviorReport } from "../src/contracts/behavior.ts";
import { buildModel } from "../src/model/build.ts";
import {
  behaviorReferenceOf,
  behaviorReportOf,
  lookupBehavior,
  queryBehaviors,
} from "../src/behavior/report.ts";
import {
  behavior,
  behaviorPage,
  behaviorTree,
  evidenceLock,
  FIXTURE_CONFIG,
  symbol,
  testFile,
} from "./behavior-fixture.ts";

const ENTRIES = [
  behavior({
    id: "greet.verified",
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
    evidenceUrl: "https://ci.example.org/runs/1",
  }),
  behavior({
    id: "greet.no-evidence",
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
  }),
  behavior({
    id: "greet.missing-test",
    status: "experimental",
    surface: ["symbol:greet"],
    testFile: "test/does-not-exist.test.ts",
    testName: "nothing",
  }),
  behavior({
    id: "greet.missing-test-name",
    status: "experimental",
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "a name the file does not contain",
  }),
  behavior({
    id: "greet.failing",
    status: "experimental",
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
    testOutcome: "failed",
  }),
  behavior({
    id: "greet.missing-surface",
    surface: ["symbol:not-published"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
    evidenceUrl: "https://ci.example.org/runs/1",
  }),
  behavior({
    id: "greet.locked",
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
    evidenceId: "run-1",
    evidenceKind: "ci",
  }),
  behavior({
    id: "greet.unresolved",
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
    evidenceId: "ghost",
    evidenceKind: "ci",
  }),
  behavior({
    id: "greet.versioned",
    status: "removed",
    introduced: "1.0.0",
    changed: ["1.5.0"],
    deprecated: "2.0.0",
    removed: "3.0.0",
    surface: ["symbol:greet"],
  }),
  behavior({
    id: "greet.linux",
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
    evidenceUrl: "https://ci.example.org/runs/1",
    environments: ["{ os: linux, runtime: node }"],
  }),
  behavior({
    id: "greet.windows",
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
    evidenceUrl: "https://ci.example.org/runs/1",
    environments: ["{ os: windows }"],
  }),
  behavior({
    id: "greet.private",
    public: false,
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
    evidenceUrl: "https://ci.example.org/runs/1",
  }),
  behavior({
    id: "greet.private-evidence",
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
    evidenceUrl: "https://secret.example.org/run",
    evidencePublic: false,
  }),
  behavior({
    id: "greet.document-only",
    surface: ["symbol:greet"],
    testFile: "test/greet.test.ts",
    testName: "greet returns the name",
    evidenceUrl: "https://example.org/design-note",
    evidenceKind: "document",
  }),
  behavior({
    id: "farewell.old",
    status: "deprecated",
    deprecated: "2.0.0",
    replacement: "greet.verified",
    surface: ["symbol:farewell"],
    evidenceUrl: "https://example.org/deprecation",
    evidenceKind: "document",
  }),
];

async function fixture(): Promise<{ readonly root: string; readonly report: BehaviorReport }> {
  const root = behaviorTree({
    "mizzen.yml": FIXTURE_CONFIG,
    "pkg/index.ts": [symbol("greet", "(name: string): string"), symbol("farewell", "(name: string): string")].join("\n"),
    "test/greet.test.ts": testFile("greet returns the name"),
    ".mizzen/evidence.lock.json": evidenceLock("run-1"),
    "docs/api.md": behaviorPage(ENTRIES),
  });
  const model = await buildModel(root);
  const { report } = await behaviorReportOf({ site: model.site, root, version: "2.5.0" });
  return { root, report };
}

test("#1348 a behavior links to its public surface, and a missing item is visible in coverage", async () => {
  const { root, report } = await fixture();
  try {
    const byId = new Map(report.behaviors.map((record) => [record.id, record]));
    const linked = byId.get("greet.verified")?.surface[0];
    assert.equal(linked?.item, "symbol:greet");
    assert.equal(linked?.state, "linked");
    assert.equal(linked?.area, "api");
    assert.equal(linked?.kind, "symbol");
    assert.equal(linked?.name, "greet");
    assert.equal(linked?.source?.file, "pkg/index.ts");
    assert.match(linked?.signature ?? "", /greet\(/);

    const missing = byId.get("greet.missing-surface")?.surface[0];
    assert.equal(missing?.state, "missing");
    assert.ok(byId.get("greet.missing-surface")?.verification.reasons.includes("missing-surface"));
    assert.ok(report.coverage.surface.missing >= 1);
    assert.ok(report.coverage.surface.linked >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1349 a test link resolves its file and expected outcome, and a missing one leaves the behavior unverified", async () => {
  const { root, report } = await fixture();
  try {
    const byId = new Map(report.behaviors.map((record) => [record.id, record]));
    const verified = byId.get("greet.verified")!;
    assert.equal(verified.tests[0]?.file, "test/greet.test.ts");
    assert.equal(verified.tests[0]?.name, "greet returns the name");
    assert.equal(verified.tests[0]?.outcome, "passed");
    assert.equal(verified.tests[0]?.state, "found");
    assert.match(verified.tests[0]?.digest ?? "", /^[0-9a-f]{64}$/);
    assert.equal(verified.verification.status, "verified");

    const missing = byId.get("greet.missing-test")!;
    assert.equal(missing.tests[0]?.state, "missing");
    assert.ok(missing.verification.reasons.includes("missing-test"));

    const wrongName = byId.get("greet.missing-test-name")!;
    assert.equal(wrongName.tests[0]?.state, "missing");
    assert.ok(wrongName.verification.reasons.includes("missing-test"));

    const failed = byId.get("greet.failing")!;
    assert.equal(failed.tests[0]?.outcome, "failed");
    assert.ok(failed.verification.reasons.includes("nonpassing-test"));
    assert.equal(failed.verification.status, "unverified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1350 a versioned query returns the contract at that version", async () => {
  const { root, report } = await fixture();
  try {
    const atIntroduction = queryBehaviors(report, { version: "1.2.0" });
    const versioned = atIntroduction.behaviors.find((record) => record.id === "greet.versioned");
    assert.equal(versioned?.statusAtVersion, "supported");
    const changed = atIntroduction.behaviors.find((record) => record.id === "greet.versioned");
    assert.deepEqual(changed?.versions.changed, ["1.5.0"]);

    const deprecated = queryBehaviors(report, { version: "2.5.0" });
    assert.equal(deprecated.behaviors.find((record) => record.id === "greet.versioned")?.statusAtVersion, "deprecated");

    const removed = queryBehaviors(report, { version: "3.0.0" });
    assert.equal(removed.behaviors.find((record) => record.id === "greet.versioned")?.statusAtVersion, "removed");

    const before = queryBehaviors(report, { version: "0.9.0" });
    assert.equal(before.behaviors.some((record) => record.id === "greet.versioned"), false);

    const reference = behaviorReferenceOf(report.behaviors[0]!, "1.2.0");
    assert.deepEqual(reference, { kind: "behavior", id: report.behaviors[0]!.id, version: "1.2.0" });
    assert.ok(lookupBehavior(report, reference) !== undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1352 a behavior records its environment and a query is scoped to what it covers", async () => {
  const { root, report } = await fixture();
  try {
    const linux = report.behaviors.find((record) => record.id === "greet.linux");
    assert.deepEqual(linux?.environments, [{ os: "linux", runtime: "node" }]);

    const onLinux = queryBehaviors(report, { environment: { os: "linux" } });
    assert.ok(onLinux.behaviors.some((record) => record.id === "greet.linux"));
    assert.ok(!onLinux.behaviors.some((record) => record.id === "greet.windows"));
    assert.ok(onLinux.behaviors.some((record) => record.id === "greet.verified"), "an unscoped behavior covers every environment");

    const onWindows = queryBehaviors(report, { environment: { os: "windows" } });
    assert.ok(onWindows.behaviors.some((record) => record.id === "greet.windows"));
    assert.ok(!onWindows.behaviors.some((record) => record.id === "greet.linux"));

    const node = queryBehaviors(report, { environment: { runtime: "node" } });
    assert.ok(node.behaviors.some((record) => record.id === "greet.linux"));
    const bun = queryBehaviors(report, { environment: { os: "linux", runtime: "bun" } });
    assert.ok(!bun.behaviors.some((record) => record.id === "greet.linux"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1353 the evidence policy verifies supported claims only with the required evidence", async () => {
  const { root, report } = await fixture();
  try {
    assert.deepEqual(report.policy.supported, { tests: 1, evidence: 1, kinds: ["test", "ci", "benchmark"] });
    assert.equal(report.policy.removed.evidence, 0);
    const byId = new Map(report.behaviors.map((record) => [record.id, record]));
    assert.equal(byId.get("greet.verified")?.verification.status, "verified");
    assert.equal(byId.get("greet.no-evidence")?.verification.status, "unverified");
    assert.deepEqual(byId.get("greet.no-evidence")?.verification.reasons, ["missing-evidence"]);
    assert.equal(byId.get("greet.locked")?.verification.status, "verified", "a pinned evidence id resolves");
    assert.equal(byId.get("greet.locked")?.evidence[0]?.state, "resolved");
    assert.equal(byId.get("greet.locked")?.evidence[0]?.digest, "c".repeat(64));

    assert.equal(byId.get("greet.unresolved")?.verification.status, "unverified");
    assert.ok(byId.get("greet.unresolved")?.verification.reasons.includes("unresolved-evidence"));
    assert.ok(byId.get("greet.unresolved")?.verification.reasons.includes("missing-evidence"));

    assert.equal(byId.get("greet.document-only")?.verification.status, "unverified");
    assert.deepEqual(byId.get("greet.document-only")?.verification.reasons, ["missing-evidence"]);

    assert.equal(byId.get("farewell.old")?.verification.status, "verified", "a deprecated behavior needs documentation evidence");
    assert.equal(byId.get("greet.versioned")?.verification.status, "verified", "a removed behavior needs no test evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1353 private behaviors and evidence values are excluded from public data", async () => {
  const { root, report } = await fixture();
  try {
    assert.equal(report.coverage.private, 1);
    assert.equal(report.behaviors.some((record) => record.id === "greet.private"), false);
    const privateEvidence = report.behaviors.find((record) => record.id === "greet.private-evidence");
    assert.equal(privateEvidence?.verification.status, "verified");
    assert.deepEqual(privateEvidence?.evidence[0], { kind: "ci", state: "resolved", redacted: true });
    const json = JSON.stringify(report);
    assert.equal(json.includes("secret.example.org"), false);
    assert.equal(json.includes("greet.private\""), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
