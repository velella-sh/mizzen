import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EvalReport } from "../src/contracts/evals.ts";

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const TSC = join(PACKAGE, "node_modules", "typescript", "bin", "tsc");

/** A SHA-256 for every file under `root`, keyed by its relative path. */
function hashes(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.set(relative(root, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  walk(root);
  return found;
}

test("the built package runs the reference suite offline and writes no fixture", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mizzen-eval-package-"));
  const installed = join(workspace, "package");
  const checkout = join(workspace, "checkout");
  try {
    execFileSync(process.execPath, [TSC, "-p", join(PACKAGE, "tsconfig.build.json"), "--outDir", join(installed, "dist")], {
      cwd: PACKAGE,
      stdio: "pipe",
      timeout: 120_000,
    });
    cpSync(join(PACKAGE, "bin"), join(installed, "bin"), { recursive: true });
    cpSync(join(PACKAGE, "schema"), join(installed, "schema"), { recursive: true });
    cpSync(join(PACKAGE, "fixtures", "evals"), join(checkout, "evals"), { recursive: true });
    writeFileSync(join(installed, "package.json"), `${JSON.stringify({ name: "@velella/mizzen", version: "0.2.6", type: "module" }, null, 2)}\n`, "utf8");
    symlinkSync(join(PACKAGE, "node_modules"), join(installed, "node_modules"), "dir");

    const env = {
      PATH: process.env.PATH ?? "",
      HOME: checkout,
      NO_COLOR: "1",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
    };
    const before = hashes(checkout);
    const run = spawnSync(process.execPath, [join(installed, "bin", "mizzen.js"), "eval", "evals", "--format", "json"], {
      cwd: checkout,
      encoding: "utf8",
      timeout: 120_000,
      env,
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout) as EvalReport;
    assert.equal(report.totals.cases, 10);
    assert.equal(report.totals.passed, 10);
    assert.equal(report.totals.invalid, 0);
    assert.equal(report.totals.unavailable, 0);
    assert.equal(report.gate.passed, true);
    assert.deepEqual(hashes(checkout), before, "the suite wrote no file and no receipt");

    const mismatched = spawnSync(
      process.execPath,
      [join(installed, "bin", "mizzen.js"), "eval", "evals", "--format", "json", "--package", "simulated-install"],
      { cwd: checkout, encoding: "utf8", timeout: 120_000, env },
    );
    assert.equal(mismatched.status, 1);
    const refused = JSON.parse(mismatched.stdout) as EvalReport;
    assert.equal(refused.totals.invalid, 10);
    assert.ok(refused.cases.every((item) => item.findings.some((finding) => finding.code === "eval.pin-package")));
    assert.deepEqual(hashes(checkout), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
