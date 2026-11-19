/**
 * The versioned report and the CI gate: schema, digest, text/JSON agreement, thresholds, unknowns, and critical rules.
 * Issues #1264 and #1265.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ReadinessReport } from "../src/contracts/readiness.ts";
import { gateReadiness } from "../src/readiness/gate.ts";
import { formatReadiness, formatReadinessJson, readinessDigest, readinessReport, verifyReadinessReport } from "../src/readiness/report.ts";
import { scanBuild, type ScanResult } from "../src/readiness/scan.ts";
import { buildFixture, copyBuild, type BuiltFixture } from "./readiness-fixture.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as new (options: object) => {
  compile(schema: object): { (value: unknown): boolean; errors?: unknown };
};
const SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", "readiness-report.schema.json"), "utf8")) as object;

let built: BuiltFixture;
let scan: ScanResult;
let report: ReadinessReport;

before(async () => {
  built = await buildFixture();
  scan = await scanBuild(built.out);
  report = readinessReport(scan, { evidence: "https://github.com/example/actions/runs/42" });
});

after(() => built.cleanup());

test("the JSON report validates against the published schema", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(SCHEMA);
  assert.equal(validate(JSON.parse(formatReadinessJson(report))), true, JSON.stringify(validate.errors));
});

test("the report carries a schema, build hash, rubric version, and a digest that covers it", () => {
  assert.equal(report.version, 1);
  assert.equal(report.schema, "https://github.com/velella-sh/mizzen/schema/readiness-report.schema.json");
  assert.match(report.build.hash, /^[0-9a-f]{64}$/);
  assert.equal(report.rubric.version, "1.0.0");
  assert.match(report.digest, /^[0-9a-f]{64}$/);
  assert.equal(verifyReadinessReport(report), true);
  const tampered = { ...report, overall: 99 };
  assert.equal(verifyReadinessReport(tampered), false);
  const { digest: _digest, ...rest } = report;
  assert.equal(readinessDigest(rest), report.digest);
});

test("text and JSON agree about rules, statuses, subscores, and unknowns", () => {
  const text = formatReadiness(report);
  const parsed = JSON.parse(formatReadinessJson(report)) as ReadinessReport;
  assert.deepEqual(parsed.rules, report.rules);
  assert.deepEqual(parsed.dimensions, report.dimensions);
  assert.deepEqual(parsed.unknowns, report.unknowns);
  assert.equal(parsed.status, report.status);
  assert.equal(parsed.overall, report.overall);
  assert.match(text, new RegExp(`Status: ${report.status}`));
  for (const dimension of report.dimensions) {
    if (dimension.score !== undefined) assert.equal(text.includes(dimension.score.toFixed(1)), true, dimension.dimension);
  }
  for (const rule of report.unknowns) assert.equal(text.includes(rule.code), true);
});

test("the JSON bytes are deterministic for one build", () => {
  assert.equal(formatReadinessJson(report), formatReadinessJson(readinessReport(scan, { evidence: "https://github.com/example/actions/runs/42" })));
});

test("thresholds pass a clean build, and an unknown fails only when asked", () => {
  const passing = gateReadiness(report, { minOverall: 90, min: { structure: 90, navigation: 90 } });
  assert.equal(passing.passed, true);
  assert.deepEqual(passing.checks.map((check) => check.target), ["overall", "structure", "navigation"]);
  assert.equal(passing.checks.every((check) => check.passed), true);

  const strict = gateReadiness(report, { min: {}, onUnknown: "fail" });
  assert.equal(strict.passed, false);
  assert.equal(strict.reasons.some((reason) => reason.includes("examples.evaluation")), true);
  assert.equal(strict.reasons.some((reason) => reason.includes("maintenance.state")), true);
});

test("a failed proof fails the gate whatever the average says, and an unknown dimension fails its threshold", async () => {
  const broken = copyBuild(built, "gate-broken");
  writeFileSync(join(broken, "sourcemap.json"), "{}");
  const brokenScan = await scanBuild(broken);
  const brokenReport = readinessReport(brokenScan);
  assert.equal(brokenReport.status, "fail");
  const gate = gateReadiness(brokenReport, { minOverall: 0, min: { structure: 1 } });
  assert.equal(gate.passed, false);
  assert.equal(gate.reasons.some((reason) => reason.startsWith("critical verification.digest failed")), true);
  assert.equal(gate.reasons.some((reason) => reason.startsWith("structure ")), false);

  const unknown = gateReadiness(
    {
      ...report,
      dimensions: report.dimensions.map((entry) => {
        if (entry.dimension !== "maintenance") return entry;
        const { score: _score, ...rest } = entry;
        return { ...rest, status: "unknown" as const };
      }),
    },
    { min: { maintenance: 50 } },
  );
  assert.equal(unknown.passed, false);
  assert.equal(unknown.reasons.some((reason) => reason.includes("maintenance unknown")), true);
});
