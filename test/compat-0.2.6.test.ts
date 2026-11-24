import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "../src/index.ts";
import {
  compareCli,
  compareConfig,
  compareContracts,
  compareSnapshots,
  compareUrls,
  hasDifferences,
  helpInventory,
  readContractSurface,
  readUrlSurface,
  snapshotOutput,
  type CliSurface,
  type ContractSurface,
  type ReleaseSnapshot,
} from "../scripts/release-compat.ts";

const baselineDir = fileURLToPath(new URL("../fixtures/compat-0.2.6", import.meta.url));
const siteFixture = fileURLToPath(new URL("../fixtures/compat-0.2.4/site", import.meta.url));
const theme = fileURLToPath(new URL("../fixtures/compat-0.2/theme", import.meta.url));
const bin = fileURLToPath(new URL("../bin/mizzen.ts", import.meta.url));

// Captured from the published @velella/mizzen@0.2.6 with `--write-baseline`. The engine version stamp is normalized;
// every other public byte must match. A reviewed change records the difference in the fixture README instead of
// regenerating the baseline.
/** `trust.json`'s `build.id` in the baseline: a hash of the rendered HTML, so it only moves when the HTML does. */
const BASELINE_BUILD_ID = "2a206cf5ba876667827a15dc7a2572b9d0a5f7d538e3ca2e9d3da2039a04e536";

test("a 0.2.6 site keeps its pages, canonicals, redirects, JSON, and Markdown on the release build", async () => {
  const baseline = JSON.parse(await readFile(join(baselineDir, "baseline.json"), "utf8")) as ReleaseSnapshot;
  assert.equal(baseline.engine, "0.2.6");
  assert.equal(Object.keys(baseline.files).length, 197);
  assert.deepEqual(baseline.sitemap.length, 31);

  const parent = await mkdtemp(join(tmpdir(), "compat-0.2.6-"));
  const site = join(parent, "site");
  const out = join(parent, "out");
  try {
    cpSync(siteFixture, site, { recursive: true });
    execFileSync(process.execPath, [bin, "build", "site", "--out", "out", "--theme", theme], {
      cwd: parent,
      stdio: "pipe",
    });
    // The published 0.2.6 package predates the head wiring; the candidate's head tags are removed, nothing else is.
    const candidate = snapshotOutput(out, version, { baseline, descriptions: ["index.html"], buildId: BASELINE_BUILD_ID });
    const diff = compareSnapshots(baseline, candidate);
    assert.equal(
      hasDifferences(diff),
      false,
      `the release build differs from 0.2.6:\n${JSON.stringify(diff, null, 2)}`,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the URL surface reports a moved record, a changed redirect, and a new page", () => {
  const parent = mkdtempSync(join(tmpdir(), "compat-urls-"));
  try {
    const before = join(parent, "before");
    const after = join(parent, "after");
    mkdirSync(before);
    mkdirSync(after);
    writeFileSync(join(before, "urls.json"), JSON.stringify({ collections: { components: { button: "https://example.com/button/" } } }));
    writeFileSync(join(after, "urls.json"), JSON.stringify({ collections: { components: { button: "https://example.com/controls/button/" } } }));
    const baselineSnapshot: ReleaseSnapshot = {
      engine: "0.2.6",
      files: { "index.html": "a", "button/index.html": "b" },
      canonicals: { "index.html": "https://example.com/" },
      redirects: "/old https://example.com/ 301\n",
      sitemap: ["https://example.com/", "https://example.com/button/"],
    };
    const candidateSnapshot: ReleaseSnapshot = {
      ...baselineSnapshot,
      files: { "index.html": "a", "button/index.html": "b", "new/index.html": "c" },
      redirects: "/old https://example.com/new/ 301\n",
      sitemap: [...baselineSnapshot.sitemap, "https://example.com/new/"],
    };
    const diff = compareUrls(readUrlSurface(before, baselineSnapshot), readUrlSurface(after, candidateSnapshot));
    assert.deepEqual(diff.pages, ["+new/index.html"]);
    assert.deepEqual(diff.records, ["~components.button https://example.com/button/ -> https://example.com/controls/button/"]);
    assert.deepEqual(diff.redirects, ["-/old https://example.com/ 301", "+/old https://example.com/new/ 301"]);
    assert.deepEqual(diff.sitemap, ["+https://example.com/new/"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the configuration comparison names each changed path", () => {
  const differences = compareConfig(
    { hash: "a", rules: { redirects: { "/old": "x" }, feeds: ["releases"] } },
    { hash: "a", rules: { redirects: { "/old": "y" }, feeds: ["releases", "components"] } },
  );
  assert.deepEqual(differences, [
    { path: "rules.feeds", baseline: "[\"releases\"]", candidate: "[\"releases\",\"components\"]" },
    { path: "rules.redirects./old", baseline: "\"x\"", candidate: "\"y\"" },
  ]);
});

test("the CLI comparison reports added commands and options, never a removal it did not see", () => {
  const baselineHelp = [
    "  build [dir]               Build the site",
    "  agent capabilities        Print capabilities",
    "  --out <path>         Output folder",
    "  --theme <dir>        Theme root",
  ].join("\n");
  const candidateHelp = [
    "  build [dir]               Build the site",
    "  agent capabilities        Print capabilities",
    "  surface [dir]             Report coverage",
    "  --out <path>         Output folder",
    "  --theme <dir>        Theme root",
    "  --min <percent>      Coverage floor",
  ].join("\n");
  const baseline: CliSurface = {
    ...helpInventory(baselineHelp),
    probes: [{ name: "--help", exit: 0, output: baselineHelp }],
  };
  const candidate: CliSurface = {
    ...helpInventory(candidateHelp),
    probes: [{ name: "--help", exit: 0, output: candidateHelp }],
  };
  const diff = compareCli(baseline, candidate);
  assert.deepEqual(diff.commands, { added: ["surface"], removed: [] });
  assert.deepEqual(diff.options, { added: ["--min"], removed: [] });
  assert.deepEqual(diff.probes, [{ name: "--help", baselineExit: 0, candidateExit: 0, output: "changed" }]);
});

test("the contract comparison reports added types and schemas and a changed schema", () => {
  const parent = mkdtempSync(join(tmpdir(), "compat-contracts-"));
  try {
    const before = join(parent, "before");
    const after = join(parent, "after");
    for (const dir of [before, after]) {
      mkdirSync(join(dir, "schema"), { recursive: true });
      mkdirSync(join(dir, "dist", "contracts"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ exports: { ".": "./dist/index.js" } }));
    }
    writeFileSync(join(before, "schema", "task.schema.json"), "{\"version\":1}\n");
    writeFileSync(join(after, "schema", "task.schema.json"), "{\"version\":2}\n");
    writeFileSync(join(after, "schema", "graph.schema.json"), "{\"version\":1}\n");
    writeFileSync(join(before, "dist", "contracts", "index.d.ts"), "export type { Task, Trace } from \"./task.ts\";\n");
    writeFileSync(join(after, "dist", "contracts", "index.d.ts"), "export type { Graph, Task } from \"./graph.ts\";\n");
    const baseline: ContractSurface = readContractSurface(before);
    const candidate: ContractSurface = readContractSurface(after);
    const diff = compareContracts(baseline, candidate);
    assert.equal(diff.exports, false);
    assert.deepEqual(diff.schemas, { added: ["graph.schema.json"], removed: [], changed: ["task.schema.json"] });
    assert.deepEqual(diff.types, { added: ["Graph"], removed: ["Trace"] });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
