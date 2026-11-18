import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/parallel/site", import.meta.url));

test("a build reports its time per stage, and a whole-build cache hit reports none", async () => {
  const parent = mkdtempSync(join(tmpdir(), "build-timings-"));
  const options = {
    root: FIXTURE,
    out: join(parent, "site"),
    themeRoot: THEME,
    cache: true,
    cacheDir: join(parent, "cache"),
  };
  try {
    const startedAt = performance.now();
    const first = await build(options);
    const wallMs = performance.now() - startedAt;

    const timings = first.timings;
    assert.ok(timings, "a build that ran reports its stage times");
    for (const [stage, ms] of Object.entries(timings)) {
      assert.ok(Number.isFinite(ms) && ms >= 0, `${stage} is a time`);
    }
    assert.ok(timings.renderMs > 0, "the build rendered pages");
    const stages = timings.dataMs + timings.renderMs + timings.outputsMs + timings.writeMs;
    assert.ok(stages <= wallMs, "the stages do not exceed the wall time around the build");

    const hit = await build(options);
    assert.equal(hit.renderedPages, 0, "the second build is a whole-build cache hit");
    assert.equal(hit.timings, undefined, "a cache hit ran no stage");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
