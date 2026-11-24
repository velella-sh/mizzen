import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import { behaviorReportOf } from "../src/behavior/report.ts";
import {
  behavior,
  behaviorPage,
  behaviorTree,
  FIXTURE_CONFIG,
  symbol,
  testFile,
} from "./behavior-fixture.ts";

function baseline(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "mizzen.yml": FIXTURE_CONFIG,
    "pkg/index.ts": [symbol("greet", "(name: string): string"), symbol("farewell", "(name: string): string")].join("\n"),
    "test/greet.test.ts": testFile("greet returns the name"),
    ...extra,
  };
}

test("#1347 a behavior record has a stable id, title, normative statement, and its own source span", async () => {
  const first = behavior({ id: "greet.returns-name", title: "Greeting returns the name", normative: "A greeting includes the supplied name." });
  const second = behavior({ id: "farewell.returns-name", title: "Farewell returns the name" });
  const page = behaviorPage([first, second]);
  const root = behaviorTree(baseline({ "docs/api.md": page }));
  try {
    const model = await buildModel(root);
    assert.deepEqual(model.diagnostics.filter((entry) => entry.severity === "error"), []);
    const authored = model.site.pages.find((candidate) => candidate.source.file === "docs/api.md");
    assert.ok(authored !== undefined);
    assert.equal(authored.behaviors?.length, 2);
    const [one, two] = authored.behaviors!;
    assert.equal(one?.id, "greet.returns-name");
    assert.equal(one?.title, "Greeting returns the name");
    assert.equal(one?.normative, "A greeting includes the supplied name.");
    assert.equal(two?.id, "farewell.returns-name");

    // Each declaration points at its own entry, not at the whole front matter or the key.
    const lines = page.split("\n");
    const lineOf = (needle: string): number => lines.findIndex((line) => line.includes(needle)) + 1;
    assert.equal(one?.source.file, "docs/api.md");
    assert.equal(one?.source.line, lineOf("- id: greet.returns-name"));
    assert.equal(two?.source.line, lineOf("- id: farewell.returns-name"));
    assert.ok((one?.source.line ?? 0) < (two?.source.line ?? 0));
    assert.notEqual(one?.source.line, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1347 a duplicate behavior id is rejected and names both source locations", async () => {
  const first = behaviorPage([behavior({ id: "greet.returns-name", surface: [] })]);
  const second = behaviorPage([behavior({ id: "greet.returns-name", surface: [] })]);
  const root = behaviorTree(baseline({ "docs/a.md": first, "docs/b.md": second }));
  try {
    const model = await buildModel(root);
    const { report, diagnostics } = await behaviorReportOf({ site: model.site, root, version: "1.0.0" });
    const duplicate = diagnostics.find((diagnostic) => diagnostic.id === "behavior.duplicate-id");
    assert.ok(duplicate !== undefined, diagnostics.map((entry) => entry.id).join(", "));
    assert.match(duplicate.message, /docs\/a\.md:/);
    assert.match(duplicate.message, /docs\/b\.md:/);
    assert.equal(report.behaviors.length, 0, "a duplicate id is rejected, not reported twice");
    const finding = report.findings.find((entry) => entry.code === "behavior.duplicate-id");
    assert.equal(finding?.locations?.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1351 supported, experimental, deprecated, and removed keep their version history and replacement", async () => {
  const entries = [
    behavior({ id: "greet.active", status: "supported", surface: [], title: "Active" }),
    behavior({ id: "greet.experimental", status: "experimental", surface: [], title: "Experimental" }),
    behavior({
      id: "greet.old",
      status: "deprecated",
      deprecated: "2.0.0",
      replacement: "greet.active",
      surface: [],
      title: "Old",
    }),
    behavior({
      id: "greet.gone",
      status: "removed",
      deprecated: "2.0.0",
      removed: "3.0.0",
      replacement: "greet.active",
      surface: [],
      title: "Gone",
    }),
  ];
  const root = behaviorTree(baseline({ "docs/api.md": behaviorPage(entries) }));
  try {
    const model = await buildModel(root);
    const { report, diagnostics } = await behaviorReportOf({ site: model.site, root });
    assert.deepEqual(diagnostics, []);
    const byId = new Map(report.behaviors.map((record) => [record.id, record]));
    assert.equal(byId.get("greet.active")?.status, "supported");
    assert.equal(byId.get("greet.experimental")?.status, "experimental");
    assert.equal(byId.get("greet.old")?.status, "deprecated");
    assert.equal(byId.get("greet.old")?.replacement, "greet.active");
    assert.equal(byId.get("greet.old")?.versions.deprecated, "2.0.0");
    assert.equal(byId.get("greet.gone")?.status, "removed");
    assert.equal(byId.get("greet.gone")?.versions.removed, "3.0.0");
    assert.deepEqual(byId.get("greet.gone")?.versions, { introduced: "1.0.0", deprecated: "2.0.0", removed: "3.0.0" });
    assert.equal(report.coverage.byStatus.deprecated, 1);
    assert.equal(report.coverage.byStatus.removed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1351 invalid replacement links are rejected", async () => {
  const entries = [
    behavior({ id: "base", surface: [] }),
    behavior({
      id: "missing.target",
      status: "deprecated",
      deprecated: "2.0.0",
      replacement: "does.not.exist",
      surface: [],
    }),
    behavior({
      id: "self.link",
      status: "deprecated",
      deprecated: "2.0.0",
      replacement: "self.link",
      surface: [],
    }),
    behavior({
      id: "to.removed",
      status: "deprecated",
      deprecated: "2.0.0",
      replacement: "removed",
      surface: [],
    }),
    behavior({ id: "removed", status: "removed", removed: "3.0.0", surface: [] }),
    behavior({
      id: "cycle.a",
      status: "deprecated",
      deprecated: "2.0.0",
      replacement: "cycle.b",
      surface: [],
    }),
    behavior({
      id: "cycle.b",
      status: "deprecated",
      deprecated: "2.0.0",
      replacement: "cycle.a",
      surface: [],
    }),
  ];
  const root = behaviorTree(baseline({ "docs/api.md": behaviorPage(entries) }));
  try {
    const model = await buildModel(root);
    const { report, diagnostics } = await behaviorReportOf({ site: model.site, root });
    const codes = new Set(diagnostics.map((diagnostic) => diagnostic.id));
    assert.ok(codes.has("behavior.unknown-replacement"));
    assert.ok(codes.has("behavior.invalid-replacement"));
    assert.ok(codes.has("behavior.replacement-cycle"));
    const missing = diagnostics.find((diagnostic) => diagnostic.id === "behavior.unknown-replacement");
    assert.match(missing!.message, /does\.not\.exist/);
    const cycle = diagnostics.find((diagnostic) => diagnostic.id === "behavior.replacement-cycle");
    assert.match(cycle!.message, /cycle\.a -> cycle\.b -> cycle\.a/);
    const byId = new Map(report.behaviors.map((record) => [record.id, record]));
    assert.equal(byId.get("missing.target")?.replacement, undefined, "an invalid link is not published");
    assert.equal(byId.get("cycle.a")?.replacement, undefined);
    assert.ok(byId.get("missing.target")?.verification.reasons.includes("invalid-replacement"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1351 a deprecated or removed status needs its milestone version, in order", async () => {
  const entries = [
    behavior({ id: "deprecated.no.version", status: "deprecated", surface: [] }),
    behavior({ id: "removed.no.version", status: "removed", surface: [] }),
    behavior({ id: "backwards", status: "deprecated", deprecated: "0.5.0", surface: [] }),
    behavior({ id: "lying", status: "supported", removed: "3.0.0", surface: [] }),
  ];
  const root = behaviorTree(baseline({ "docs/api.md": behaviorPage(entries) }));
  try {
    const model = await buildModel(root);
    const ids = model.diagnostics.map((diagnostic) => diagnostic.id);
    assert.ok(ids.includes("behavior.missing-deprecated"));
    assert.ok(ids.includes("behavior.missing-removed"));
    assert.ok(ids.includes("behavior.version-order"));
    assert.ok(ids.includes("behavior.status-version"));
    for (const diagnostic of model.diagnostics.filter((entry) => entry.id.startsWith("behavior."))) {
      assert.equal(diagnostic.pos?.file, "docs/api.md");
      assert.ok((diagnostic.pos?.line ?? 0) > 3);
    }
    const authored = model.site.pages.find((page) => page.source.file === "docs/api.md");
    assert.equal(authored?.behaviors, undefined, "a malformed entry is rejected whole");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
