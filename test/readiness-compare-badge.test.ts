/**
 * Compare two builds, and publish a badge only from a verified report. Issues #1266 and #1267.
 */
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { badgeMarkdown, badgeSvg, ReadinessBadgeError } from "../src/readiness/badge.ts";
import { checkedReport, compareReadiness, formatComparison, ReadinessCompareError } from "../src/readiness/compare.ts";
import { readinessDigest, readinessReport } from "../src/readiness/report.ts";
import { scanBuild } from "../src/readiness/scan.ts";
import { buildFixture, copyBuild, type BuiltFixture } from "./readiness-fixture.ts";

let built: BuiltFixture;
let report: ReturnType<typeof readinessReport>;

before(async () => {
  built = await buildFixture();
  report = readinessReport(await scanBuild(built.out), { evidence: "https://github.com/example/actions/runs/42" });
});

after(() => built.cleanup());

test("a regression names the rule, dimension, and page that changed", async () => {
  const broken = copyBuild(built, "compare-twin");
  unlinkSync(join(broken, "guide/index.md"));
  const afterReport = readinessReport(await scanBuild(broken));
  const comparison = compareReadiness(report, afterReport);
  assert.equal(comparison.rubricChanged, false);
  assert.equal(comparison.before.build, report.build.hash);
  assert.equal(comparison.after.build, afterReport.build.hash);
  assert.equal(comparison.overallDelta !== undefined && comparison.overallDelta < 0, true);

  const markdown = comparison.rules.find((rule) => rule.code === "structure.markdown");
  assert.equal(markdown?.change, "regressed");
  assert.equal(markdown?.before, "pass");
  assert.equal(markdown?.after, "fail");
  assert.equal(comparison.rules.find((rule) => rule.code === "structure.manifest")?.change, "unchanged");

  const page = comparison.pages.find((entry) => entry.page === "/guide/");
  assert.ok(page !== undefined);
  assert.ok(page.added.includes("structure.markdown"));
  assert.equal(page.after > page.before, true);

  const text = formatComparison(comparison);
  assert.match(text, /before [0-9a-f]{64}/);
  assert.match(text, /after {2}[0-9a-f]{64}/);
  assert.match(text, /regressed structure\.markdown: pass -> fail/);
  assert.match(text, /\/guide\//);
});

test("restoring an artifact returns the comparison to baseline", async () => {
  const broken = copyBuild(built, "compare-restore");
  unlinkSync(join(broken, "pack/guide.json"));
  const regressed = readinessReport(await scanBuild(broken));
  assert.equal(compareReadiness(report, regressed).rules.find((rule) => rule.code === "context.packs")?.change, "regressed");

  const restored = copyBuild(built, "compare-restored");
  const back = readinessReport(await scanBuild(restored), { evidence: "https://github.com/example/actions/runs/42" });
  assert.equal(compareReadiness(report, back).rules.every((rule) => rule.change === "unchanged"), true);
  assert.deepEqual(compareReadiness(report, back).pages, []);
  assert.equal(back.digest, report.digest);
});

test("a rubric version difference is stated and never hidden", () => {
  const { digest: _digest, ...rest } = report;
  const next = { ...rest, rubric: { version: "2.0.0" } };
  const changed = { ...next, digest: readinessDigest(next) };
  const comparison = compareReadiness(report, changed);
  assert.equal(comparison.rubricChanged, true);
  assert.match(formatComparison(comparison), /Rubric changed: 1\.0\.0 -> 2\.0\.0/);
});

test("a badge keeps the score, rubric version, unknown count, and evidence link", () => {
  const svg = badgeSvg(report);
  assert.match(svg, /^<svg /);
  assert.match(svg, /readiness v1\.0\.0/);
  assert.match(svg, /100\.0/);
  assert.match(svg, /2 unknown/);
  assert.match(svg, /<a href="https:\/\/github\.com\/example\/actions\/runs\/42">/);
  assert.match(svg, /aria-label="readiness /);
  assert.equal(svg, badgeSvg(report));

  const markdown = badgeMarkdown(report);
  assert.match(markdown, /!\[readiness v1\.0\.0: 100\.0 · 2 unknown \(pass\)\]\(readiness\.svg\)/);
  assert.match(markdown, /\(https:\/\/github\.com\/example\/actions\/runs\/42\)/);
});

test("a badge refuses a report whose digest does not match its content", () => {
  const tampered = { ...report, overall: 99 };
  assert.throws(() => badgeSvg(tampered), ReadinessBadgeError);
  assert.throws(() => badgeMarkdown(tampered), ReadinessBadgeError);
  assert.throws(() => checkedReport(tampered, "tampered.json"), ReadinessCompareError);
  assert.equal(checkedReport(report, "report.json"), report);
});

test("an unknown status survives into the badge", () => {
  const { digest: _digest, overall: _overall, ...rest } = report;
  const unknown = { ...rest, status: "unknown" as const };
  const next = { ...unknown, digest: readinessDigest(unknown) };
  const svg = badgeSvg(next);
  assert.match(svg, />unknown/);
});
