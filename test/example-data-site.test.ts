import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";
import { build } from "../src/pipeline/build.ts";
import { buildModel } from "../src/model/build.ts";

const ROOT = fileURLToPath(new URL("../examples/data-site/", import.meta.url));
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

async function buildTo(out: string) {
  return build({ root: ROOT, out, themeRoot: THEME });
}

test("the example site names two collections and declares a feed and search filters", () => {
  const { config, diagnostics } = loadConfig(ROOT);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(Object.keys(config.collections).sort(), ["components", "releases"]);
  assert.ok(config.feeds["releases"] !== undefined, "the site declares a feed");
  assert.deepEqual(config.collections["components"]?.search?.filters, ["status", "region"]);
});

test("the example site's data, templates, and config mention no product", () => {
  const files = ["mizzen.yml", "index.md", "_data/components.yml", "_data/releases.json", "_templates/components.md", "_templates/releases.md"];
  const text = files.map((file) => readFileSync(join(ROOT, file), "utf8")).join("\n").toLowerCase();
  for (const word of ["lateen", "velella", "evergreen", "beacon", "snapp"]) {
    assert.ok(!text.includes(word), `${word} is not in the example`);
  }
});

test("the example site builds twice with no error and the same bytes, and its URL lock is current", async () => {
  const parent = mkdtempSync(join(tmpdir(), "example-site-"));
  try {
    const first = await buildTo(join(parent, "first"));
    const second = await buildTo(join(parent, "second"));
    for (const result of [first, second]) {
      assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);
    }
    assert.deepEqual(first.files, second.files);
    for (const file of ["feeds/releases.xml", "feeds/releases.json", "search-facets.json", "urls.json", "status/stable/index.html"]) {
      assert.ok(first.files.includes(file), `the build writes ${file}`);
      assert.equal(readFileSync(join(parent, "first", file), "utf8"), readFileSync(join(parent, "second", file), "utf8"));
    }
    const model = await buildModel(ROOT);
    assert.ok(model.urls.locked, "the example keeps a urls.lock.json");
    assert.equal(model.urls.changed.length, 0, "no record URL differs from urls.lock.json");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
