import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ReportFinding, ReportRun, ReportSet } from "../src/contracts/index.ts";
import { buildModel } from "../src/model/build.ts";
import { checkReport } from "../src/outputs/check-report.ts";
import { collectDoctorRun } from "../src/reports/doctor.ts";
import { prepareReport } from "../src/reports/prepare.ts";

const finding = (id: string, message = id): ReportFinding => ({ id, message, severity: "warning" });
const run = (id: string, findings: ReportFinding[], extra: Partial<ReportRun> = {}): ReportRun => ({
  id, findings, tool: "Example", scope: "docs", coverage: "complete", checks: [], metrics: [], ...extra,
});
const input = (runs: ReportRun[], comparisons: ReportSet["comparisons"] = []): ReportSet => ({
  schemaVersion: 1, title: "Check results", route: "/checks/", runs, comparisons,
});

test("compares complete same-scope runs by stable finding id", () => {
  const runs = [
    run("first", [finding("same"), finding("gone"), finding("changed")]),
    run("second", [finding("same"), finding("changed", "new message"), finding("new")]),
    run("partial", [], { coverage: "partial" }),
    run("other", [], { scope: "other" }),
  ];
  const pairs = runs.slice(1).map(({ id: head }) => ({ base: "first", head }));
  const { report, problems } = prepareReport(input(runs, pairs), "/docs");
  assert.deepEqual(problems, []);
  assert.equal(report?.jsonUrl, "/docs/checks/data.json");
  assert.deepEqual(report?.comparisons[0]?.changes.map(({ kind }) => kind), ["new", "resolved", "changed", "unchanged"]);
  assert.deepEqual(report?.comparisons.slice(1).map(({ state, changes }) => [state, changes]), [
    ["incomplete", []], ["different-scope", []],
  ]);
});

test("uses gaps for missing dates, missing metrics, incomplete coverage and incompatible units", () => {
  const { report } = prepareReport(input([
    run("first", [finding("warning")], { date: "2026-11-20", metrics: [{ id: "size", unit: "B", value: 10 }] }),
    run("no-date", [], { metrics: [{ id: "size", unit: "B", value: 20 }] }),
    run("different-unit", [], { date: "2026-11-21T14:00:00.123Z", metrics: [{ id: "size", unit: "KiB", value: 1 }] }),
    run("partial", [], { date: "2026-11-22T14:00:00Z", coverage: "partial" }),
    run("empty", [], { date: "2026-11-23" }),
  ]), "");
  assert.deepEqual(report?.series.find(({ id }) => id === "warning")?.points.map(({ value }) => value), [1, null, 0, null, 0]);
  const metrics = report?.series.filter(({ kind }) => kind === "metric");
  assert.deepEqual(metrics?.map(({ points }) => points.map(({ value }) => value)), [
    [10, null, null, null, null], [null, null, 1, null, null],
  ]);
});

test("rejects malformed or ambiguous publication inputs with field locations", () => {
  const malformed = input([run("first", [finding("same"), finding("same")], {
    date: "2026-02-30", evidence: ["https://name:secret@example.com"],
  })], [{ base: "first", head: "missing" }]);
  assert.deepEqual(prepareReport(malformed, "").problems.map(({ pointer }) => pointer), [
    "/runs/0/findings/1/id", "/runs/0/evidence/0", "/runs/0/date", "/comparisons/0",
  ]);
  assert.match(prepareReport({ ...malformed, raw: "unapproved" }, "").problems[0]?.message ?? "", /raw/);
  assert.equal(prepareReport({ ...malformed, route: "/checks/\n" }, "").report, undefined);
});

test("generates bounded pages and byte-stable public JSON from the same model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mizzen-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "_data"));
  await writeFile(join(root, "mizzen.yml"), "title: Reports\nbase: /product\noutputs: { check-report: true }\n");
  const data = input([run("first", Array.from({ length: 51 }, (_, index) => finding(`finding-${index}`)))]);
  await writeFile(join(root, "_data/report-set.json"), JSON.stringify(data));
  const { site, diagnostics } = await buildModel(root);
  assert.deepEqual(diagnostics.filter(({ severity }) => severity === "error"), []);
  assert.deepEqual(site.pages.filter(({ reportView }) => reportView).map(({ url }) => url), [
    "/product/checks/", "/product/checks/runs/first/", "/product/checks/runs/first/page/2/",
  ]);
  const first = site.pages.find(({ url }) => url.endsWith("/runs/first/"));
  assert.deepEqual(first?.reportView, {
    kind: "run", id: "first", start: 0, end: 50, page: 1, pages: 2, next: "/product/checks/runs/first/page/2/",
  });
  const [json] = await checkReport.run(site, {} as never);
  assert.equal(json?.path, "checks/data.json");
  assert.deepEqual(JSON.parse(String(json?.contents)), site.checkReport);
  assert.deepEqual(await checkReport.run((await buildModel(root)).site, {} as never), [json]);
  assert.doesNotMatch(await readFile(join(root, "_data/report-set.json"), "utf8"), /jsonUrl/);
});

test("the Mizzen producer collects a real doctor run and preserves skipped checks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mizzen-report-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "mizzen.yml"), "title: Check Results\n");
  const collected = await collectDoctorRun({ root, nodeVersion: "20.0.0" }, { id: "real", scope: "docs" });
  assert.equal(collected.coverage, "partial");
  assert(collected.checks.some(({ status }) => status === "skipped"));
  assert(collected.findings.some(({ severity }) => severity === "error"));
  assert(collected.findings.every(({ rule }) => rule !== "doctor.check-skipped"));
  assert.deepEqual(prepareReport(input([collected]), "").problems, []);
});
