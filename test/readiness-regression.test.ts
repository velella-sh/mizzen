/**
 * A deliberate break lowers the score and status, and restoring the artifact returns the baseline. Issue #1269.
 */
import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gateReadiness } from "../src/readiness/gate.ts";
import { readinessReport, verifyReadinessReport } from "../src/readiness/report.ts";
import type { ReadinessReport } from "../src/contracts/readiness.ts";
import { scanBuild } from "../src/readiness/scan.ts";
import { buildFixture, copyBuild, type BuiltFixture } from "./readiness-fixture.ts";

let built: BuiltFixture;
let baseline: ReadinessReport;

before(async () => {
  built = await buildFixture();
  baseline = readinessReport(await scanBuild(built.out));
});

after(() => built.cleanup());

/** The score of one dimension, or `undefined`. */
function dimension(report: ReadinessReport, id: string): number | undefined {
  return report.dimensions.find((entry) => entry.dimension === id)?.score;
}

test("breaking the source map lowers structure and verification, and restoring it returns baseline", async () => {
  assert.equal(baseline.status, "pass");
  assert.equal(baseline.overall, 100);
  const broken = copyBuild(built, "regression-sourcemap");
  const mapPath = join(broken, "sourcemap.json");
  const original = readFileSync(mapPath, "utf8");
  writeFileSync(mapPath, JSON.stringify({ version: 0, pages: [] }));

  const regressed = readinessReport(await scanBuild(broken));
  assert.equal(regressed.status, "fail");
  assert.equal(regressed.overall !== undefined && regressed.overall < 100, true);
  assert.equal(dimension(regressed, "structure")! < dimension(baseline, "structure")!, true);
  assert.equal(dimension(regressed, "verification")! < dimension(baseline, "verification")!, true);
  assert.equal(regressed.findings.some((entry) => entry.code === "structure.sourcemap"), true);
  assert.equal(gateReadiness(regressed, { minOverall: 90, min: {} }).passed, false);

  writeFileSync(mapPath, original);
  const restored = readinessReport(await scanBuild(broken));
  assert.equal(restored.status, "pass");
  assert.equal(restored.overall, baseline.overall);
  assert.equal(restored.digest, baseline.digest);
  assert.equal(verifyReadinessReport(restored), true);
});

test("removing a pack lowers context, and putting it back returns baseline", async () => {
  const broken = copyBuild(built, "regression-pack");
  const pack = join(broken, "pack/guide.json");
  const original = readFileSync(pack, "utf8");
  unlinkSync(pack);

  const regressed = readinessReport(await scanBuild(broken));
  assert.equal(dimension(regressed, "context")! < dimension(baseline, "context")!, true);
  assert.equal(regressed.findings.some((entry) => entry.code === "context.packs"), true);

  writeFileSync(pack, original);
  const restored = readinessReport(await scanBuild(broken));
  assert.equal(dimension(restored, "context"), dimension(baseline, "context"));
  assert.equal(restored.digest, baseline.digest);
});

test("removing proof makes verification unknown, and the strict gate fails until it is restored", async () => {
  const broken = copyBuild(built, "regression-proof");
  const trust = join(broken, "trust.json");
  const original = readFileSync(trust, "utf8");
  unlinkSync(trust);

  const unknown = readinessReport(await scanBuild(broken));
  assert.equal(unknown.rules.find((rule) => rule.code === "verification.trust")?.status, "unknown");
  assert.equal(gateReadiness(unknown, { min: {}, onUnknown: "fail" }).passed, false);
  assert.equal(unknown.findings.some((entry) => entry.code === "verification.trust"), false);

  writeFileSync(trust, original);
  const restored = readinessReport(await scanBuild(broken));
  assert.equal(restored.rules.find((rule) => rule.code === "verification.trust")?.status, "pass");
  assert.equal(gateReadiness(restored, { min: {}, onUnknown: "fail" }).reasons.some((reason) => reason.startsWith("verification.trust")), false);
  assert.equal(restored.findings.length, baseline.findings.length);
});

test("a proof that names another build is caught without touching the digest", async () => {
  const broken = copyBuild(built, "regression-trust-shape");
  const trustPath = join(broken, "trust.json");
  const trust = JSON.parse(readFileSync(trustPath, "utf8")) as { build: { pages: number } };
  trust.build.pages = 99;
  writeFileSync(trustPath, JSON.stringify(trust));
  const regressed = readinessReport(await scanBuild(broken));
  assert.equal(regressed.rules.find((rule) => rule.code === "verification.trust")?.status, "fail");
  assert.equal(dimension(regressed, "verification")! < 100, true);
  assert.equal(regressed.findings.some((entry) => entry.code === "verification.trust"), true);
});
