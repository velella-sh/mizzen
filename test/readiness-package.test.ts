/**
 * `mizzen readiness` from a packed tarball: build, score, badge, and recheck the same JSON in a second run.
 * This is an offline simulation of an install: the tarball is packed and extracted into a `node_modules` layout,
 * and its dependencies are the checkout's already-installed ones. No registry is contacted. Issue #1270.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ReadinessReport } from "../src/contracts/readiness.ts";
import { FIXTURE_SITE, FIXTURE_THEME } from "./readiness-fixture.ts";

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const EVIDENCE = "https://ci.example/actions/runs/7";

let parent: string;
let cli: string;
let out: string;
let reportPath: string;
let badgePath: string;

/** Runs the installed CLI and returns stdout, or the exit code and stderr for a failing run. */
function installed(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { cwd: parent, encoding: "utf8", stdio: "pipe" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

before(() => {
  parent = mkdtempSync(join(tmpdir(), "readiness-package-"));
  // Pack a copy of the sources, so this test never races the checkout's own `dist/`.
  const source = join(parent, "source");
  for (const entry of ["package.json", "tsconfig.json", "tsconfig.build.json", "src", "bin", "schema", "skills", "CHANGELOG.md", "README.md", "LICENSE"]) {
    const from = join(PACKAGE, entry);
    if (existsSync(from)) cpSync(from, join(source, entry), { recursive: true });
  }
  symlinkSync(join(PACKAGE, "node_modules"), join(source, "node_modules"), "dir");
  const tarballs = join(parent, "tarballs");
  mkdirSync(tarballs);
  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", tarballs], {
    cwd: source,
    encoding: "utf8",
    stdio: "pipe",
  })
    .trim()
    .split("\n")
    .pop()!;

  const installedRoot = join(parent, "project", "node_modules", "@velella", "mizzen");
  mkdirSync(installedRoot, { recursive: true });
  execFileSync("tar", ["-xzf", join(tarballs, packed), "-C", installedRoot, "--strip-components=1"]);
  symlinkSync(join(PACKAGE, "node_modules"), join(installedRoot, "node_modules"), "dir");
  cli = join(installedRoot, "bin", "mizzen.js");

  out = join(parent, "out");
  reportPath = join(parent, "readiness.json");
  badgePath = join(parent, "readiness.svg");
});

after(() => rmSync(parent, { recursive: true, force: true }));

test("the installed CLI builds the sample site", () => {
  const built = installed(["build", FIXTURE_SITE, "--theme", FIXTURE_THEME, "--out", out]);
  assert.equal(built.code, 0, built.stderr);
  assert.equal(existsSync(join(out, "guide", "index.html")), true);
  assert.equal(existsSync(join(out, ".mizzen", "manifest.json")), true);
});

test("the installed CLI writes a report and a badge for that build", () => {
  const scored = installed([
    "readiness",
    out,
    "--report",
    reportPath,
    "--badge",
    badgePath,
    "--evidence",
    EVIDENCE,
    "--min-overall",
    "90",
    "--min",
    "verification=100",
  ]);
  assert.equal(scored.code, 0, scored.stderr);
  assert.match(scored.stdout, /Mizzen readiness 1\.0\.0/);
  assert.match(scored.stdout, /Status: pass/);

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReadinessReport;
  assert.equal(report.schema, "https://github.com/velella-sh/mizzen/schema/readiness-report.schema.json");
  assert.equal(report.status, "pass");
  assert.equal(report.overall, 100);
  assert.equal(report.evidence, EVIDENCE);
  assert.match(report.digest, /^[0-9a-f]{64}$/);
  assert.equal(report.rubric.version, "1.0.0");

  const badge = readFileSync(badgePath, "utf8");
  assert.match(badge, /^<svg /);
  assert.match(badge, /readiness v1\.0\.0/);
  assert.match(badge, new RegExp(EVIDENCE.replace(/[.?]/g, "\\$&")));
});

test("the installed CLI rechecks thresholds and evidence from that same JSON", () => {
  const rechecked = installed(["readiness", out, "--compare", reportPath, "--min-overall", "90", "--min", "verification=100"]);
  assert.equal(rechecked.code, 0, rechecked.stderr);
  assert.match(rechecked.stdout, /Rules: 0 change\(s\)/);
  assert.match(rechecked.stdout, /Pages: 0 change\(s\)/);

  const evidence = JSON.parse(readFileSync(reportPath, "utf8")) as ReadinessReport;
  assert.equal(evidence.evidence, EVIDENCE, "evidence is read from the report of the first run");
});

test("a report whose digest no longer matches its content is refused", () => {
  const tamperedPath = join(parent, "tampered.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReadinessReport;
  writeFileSync(tamperedPath, JSON.stringify({ ...report, overall: 99 }));
  const refused = installed(["readiness", out, "--compare", tamperedPath]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /not a verified readiness report/);
});

test("the tarball carries the report schema and no evaluation data", () => {
  const pkg = join(parent, "project", "node_modules", "@velella", "mizzen");
  assert.equal(existsSync(join(pkg, "schema", "readiness-report.schema.json")), true);
  assert.equal(existsSync(join(pkg, "dist", "cli", "index.js")), true);
  assert.equal(existsSync(join(pkg, "test")), false);
});
