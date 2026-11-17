import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "../src/index.ts";
import { compareSnapshots, hasDifferences, snapshotOutput, type ReleaseSnapshot } from "../scripts/release-compat.ts";

const compat = fileURLToPath(new URL("../fixtures/compat-0.2.2", import.meta.url));
const theme = fileURLToPath(new URL("../fixtures/compat-0.2/theme", import.meta.url));
const bin = fileURLToPath(new URL("../bin/mizzen.ts", import.meta.url));

// The 0.2.2 baseline was built from the published package with this fixed test theme. The engine version stamp in
// agent.json is normalized; every other byte must match. A reviewed change adds the difference to the fixture README
// rather than regenerating the baseline.
test("a 0.2.2 site keeps its pages, canonicals, redirects, JSON, and Markdown on the release build", async () => {
  const baseline = JSON.parse(await readFile(join(compat, "baseline.json"), "utf8")) as ReleaseSnapshot;
  assert.equal(baseline.engine, "0.2.2");
  assert.ok(Object.keys(baseline.files).length > 150);
  assert.ok(Object.keys(baseline.files).some((path) => path.endsWith(".json")));
  assert.ok(Object.keys(baseline.files).some((path) => path.endsWith(".md")));
  assert.ok(Object.keys(baseline.canonicals).length > 0);
  assert.match(baseline.redirects, /catalogue\/components\//);

  const parent = await mkdtemp(join(tmpdir(), "compat-0.2.2-"));
  const site = join(parent, "site");
  const out = join(parent, "out");
  try {
    // Build a copy in an empty folder, as the release script does: the fixture's git checkout would add review state.
    cpSync(join(compat, "site"), site, { recursive: true });
    execFileSync(process.execPath, [bin, "build", "site", "--out", "out", "--theme", theme], {
      cwd: parent,
      stdio: "pipe",
    });
    const candidate = snapshotOutput(out, version);
    const diff = compareSnapshots(baseline, candidate);
    assert.equal(
      hasDifferences(diff),
      false,
      `the release build differs from 0.2.2:\n${JSON.stringify(diff, null, 2)}`,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
