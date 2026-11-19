import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { traceFixture } from "./trace-fixture.ts";

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

test("the installed package replays a trace offline in a clean checkout and changes no file", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mizzen-trace-package-"));
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
    writeFileSync(join(installed, "package.json"), `${JSON.stringify({ name: "@velella/mizzen", version: "0.2.5", type: "module" }, null, 2)}\n`, "utf8");
    symlinkSync(join(PACKAGE, "node_modules"), join(installed, "node_modules"), "dir");

    mkdirSync(join(checkout, "docs"), { recursive: true });
    writeFileSync(join(checkout, "docs", "install.md"), "# Install\n\nRun it.\n", "utf8");
    writeFileSync(join(checkout, "trace.json"), `${JSON.stringify(traceFixture(), null, 2)}\n`, "utf8");

    const before = hashes(checkout);
    const run = spawnSync(process.execPath, [join(installed, "bin", "mizzen.js"), "trace", "replay", join(checkout, "trace.json")], {
      cwd: checkout,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: checkout,
        NO_COLOR: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /replay ok: 5 events at snapshot/);
    assert.match(run.stdout, /nothing was written/);
    assert.deepEqual(hashes(checkout), before);
    assert.deepEqual(readdirSync(checkout).sort(), ["docs", "trace.json"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
