/**
 * The public rubric and a scan of a real build: weights, prerequisites, rule coverage, and located findings.
 * Issues #1259, #1260, #1262, and #1263.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { finding, compareFindings, siteScope, pageScope } from "../src/readiness/findings.ts";
import { formatReadiness, readinessReport } from "../src/readiness/report.ts";
import { RUBRIC } from "../src/readiness/rubric.ts";
import { scanBuild, type ScanResult } from "../src/readiness/scan.ts";
import { buildFixture, copyBuild, type BuiltFixture } from "./readiness-fixture.ts";

let built: BuiltFixture;
let scan: ScanResult;

before(async () => {
  built = await buildFixture();
  scan = await scanBuild(built.out);
});

after(() => built.cleanup());

test("rubric weights sum to 100 and every dimension's rules add up to its weight", () => {
  assert.equal(RUBRIC.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0), 100);
  for (const dimension of RUBRIC.dimensions) {
    const rules = RUBRIC.rules.filter((rule) => rule.dimension === dimension.id);
    assert.ok(rules.length > 0, `${dimension.id} has a rule`);
    assert.equal(rules.reduce((sum, rule) => sum + rule.weight, 0), dimension.weight, `${dimension.id} weights`);
  }
  assert.equal(new Set(RUBRIC.rules.map((rule) => rule.code)).size, RUBRIC.rules.length, "rule codes are unique");
  assert.equal(new Set(RUBRIC.dimensions.map((dimension) => dimension.id)).size, RUBRIC.dimensions.length);
});

test("the rubric states prerequisites, remediation, and why each dimension matters", () => {
  for (const dimension of RUBRIC.dimensions) {
    assert.ok(dimension.rationale.length > 20, `${dimension.id} has a rationale`);
  }
  for (const rule of RUBRIC.rules) {
    assert.match(rule.link, /^https:\/\//, `${rule.code} links to public docs`);
    assert.ok(rule.action.length > 10, `${rule.code} says what to do`);
    assert.ok(rule.title.length > 10, `${rule.code} says what passing means`);
  }
  for (const code of ["structure.blocks", "context.packs", "examples.evaluation", "verification.trust", "maintenance.review"]) {
    assert.ok(RUBRIC.rules.find((rule) => rule.code === code)?.prerequisite !== undefined, `${code} names its prerequisite`);
  }
  const critical = RUBRIC.dimensions.filter((dimension) => dimension.critical).map((dimension) => dimension.id);
  assert.deepEqual(critical, ["verification", "permissions"]);
});

test("a real build passes structure, navigation, context, verification, and permissions", () => {
  const report = readinessReport(scan);
  assert.equal(report.build.hash.length, 64);
  assert.equal(report.build.pages, 2);
  assert.equal(report.build.files > 20, true);
  assert.equal(report.status, "pass");
  assert.equal(report.overall, 100);
  for (const dimension of ["structure", "navigation", "context", "verification", "permissions"] as const) {
    const score = report.dimensions.find((entry) => entry.dimension === dimension);
    assert.equal(score?.status, "pass", `${dimension} passes`);
    assert.equal(score?.score, 100, `${dimension} scores 100`);
  }
  assert.deepEqual(
    report.unknowns.map((rule) => rule.code),
    ["examples.evaluation", "maintenance.state"],
  );
  assert.deepEqual(scan.findings, []);
});

test("a missing artifact becomes a located finding with code, evidence, and remediation", async () => {
  const broken = copyBuild(built, "missing-pack");
  const path = join(broken, "pack/guide.json");
  writeFileSync(path, "");
  const result = await scanBuild(broken);
  const pack = result.findings.filter((entry) => entry.code === "context.packs");
  assert.equal(pack.length > 0, true);
  for (const entry of pack) {
    assert.equal(entry.dimension, "context");
    assert.equal(entry.severity, "error");
    assert.ok(entry.message.length > 0);
    assert.ok(entry.evidence.length > 0);
    assert.match(entry.remediation.action, /pack|context-packs/i);
    assert.match(entry.remediation.link, /^https:\/\//);
    assert.equal(entry.scope.systemic, entry.scope.page === undefined);
  }
});

test("findings are deterministic and carry page and block scope", () => {
  const first = finding("structure.sourcemap", {
    scope: pageScope("/guide/", "intro"),
    message: "A block has no span.",
    evidence: "sourcemap.json has no span for intro",
    pos: { file: "guide/index.md", line: 4, column: 1, endLine: 4, endColumn: 9 },
  });
  assert.deepEqual(first.scope, { kind: "block", page: "/guide/", block: "intro", systemic: false });
  assert.equal(first.pos?.file, "guide/index.md");
  assert.match(first.remediation.link, /readiness\.md$/);
  assert.equal(compareFindings(first, first), 0);

  const systemic = finding("context.packs", { scope: siteScope(), message: "No pack.", evidence: "pack/ is empty" });
  const local = finding("structure.markdown", { scope: pageScope("/guide/"), message: "No twin.", evidence: "missing guide/index.md" });
  assert.deepEqual([local, systemic].sort(compareFindings).map((entry) => entry.code), ["context.packs", "structure.markdown"]);
});

test("the text report agrees with the scan and never prints a machine path", () => {
  const report = readinessReport(scan);
  const text = formatReadiness(report);
  assert.match(text, /Mizzen readiness 1\.0\.0/);
  assert.match(text, /Status: pass/);
  assert.match(text, /unknown/);
  assert.equal(text.includes(built.out), false);
  assert.equal(text.includes(built.parent), false);
  for (const dimension of report.dimensions) assert.equal(text.includes(dimension.dimension), true);
});

test("a forged source map is caught from the artifact, not from file presence", async () => {
  const broken = copyBuild(built, "broken-sourcemap");
  const map = JSON.parse(readFileSync(join(broken, "sourcemap.json"), "utf8")) as { pages: unknown[] };
  map.pages = [];
  writeFileSync(join(broken, "sourcemap.json"), JSON.stringify(map));
  const result = await scanBuild(broken);
  const outcome = result.outcomes.find((entry) => entry.code === "structure.sourcemap");
  assert.equal(outcome?.status, "fail");
  const findings = result.findings.filter((entry) => entry.code === "structure.sourcemap");
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((entry) => entry.scope.page).sort(), ["/guide/", "/reference/"]);
});
