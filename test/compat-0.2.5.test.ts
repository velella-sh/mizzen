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

const baselineDir = fileURLToPath(new URL("../fixtures/compat-0.2.5", import.meta.url));
const siteFixture = fileURLToPath(new URL("../fixtures/compat-0.2.4/site", import.meta.url));
const theme = fileURLToPath(new URL("../fixtures/compat-0.2/theme", import.meta.url));
const bin = fileURLToPath(new URL("../bin/mizzen.ts", import.meta.url));

// Captured from the published @velella/mizzen@0.2.5 with `--write-baseline`. The engine version stamp is normalized;
// every other public byte must match. A reviewed change records the difference in the fixture README instead of
// regenerating the baseline.
test("a 0.2.5 site keeps its pages, canonicals, redirects, JSON, and Markdown on the release build", async () => {
  const baseline = JSON.parse(await readFile(join(baselineDir, "baseline.json"), "utf8")) as ReleaseSnapshot;
  assert.equal(baseline.engine, "0.2.5");
  assert.equal(Object.keys(baseline.files).length, 197);
  assert.deepEqual(baseline.sitemap.length, 31);

  const parent = await mkdtemp(join(tmpdir(), "compat-0.2.5-"));
  const site = join(parent, "site");
  const out = join(parent, "out");
  try {
    cpSync(siteFixture, site, { recursive: true });
    execFileSync(process.execPath, [bin, "build", "site", "--out", "out", "--theme", theme], {
      cwd: parent,
      stdio: "pipe",
    });
    const candidate = snapshotOutput(out, version);
    const diff = compareSnapshots(baseline, candidate);
    assert.equal(
      hasDifferences(diff),
      false,
      `the release build differs from 0.2.5:\n${JSON.stringify(diff, null, 2)}`,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
