import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";
import { withoutAddedHead } from "../scripts/release-compat.ts";

const fixture = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
const compat = fileURLToPath(new URL("../fixtures/compat-0.2", import.meta.url));

// Every intentional difference must name the page, its new hash, and the reason; never replace the 0.2.0 hashes.
/** Pages whose description meta is new in 0.2.6: the site-description fallback on a page with none of its own. */
const DESCRIPTION_PAGES = new Set<string>([]);

const intendedDifferences: Record<string, { sha256: string; reason: string }> = {
  "features/index.html": {
    sha256: "a8eb846e424876014d0e21c68ed3df8100e47495840ffc5745007726c60f4e2c",
    reason: "Code fences carry highlight, line, and annotation data in one data-code attribute (#866).",
  },
};

test("the 0.2.0 docs fixture keeps its page list and every page's HTML bytes", async () => {
  const baseline: { engine: string; pages: Record<string, string> } =
    JSON.parse(await readFile(join(compat, "pages.json"), "utf8"));
  assert.equal(baseline.engine, "0.2.0");
  const parent = await mkdtemp(join(tmpdir(), "compat-0.2-"));
  const out = join(parent, "site");
  try {
    const result = await build({ root: fixture, out, themeRoot: join(compat, "theme"), defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);
    const pages = result.files.filter((file) => file.endsWith(".html"));
    assert.deepEqual(pages, Object.keys(baseline.pages), "no page was added, removed, or moved");
    for (const path of Object.keys(intendedDifferences)) {
      assert.ok(path in baseline.pages, `unknown exception: ${path}`);
      assert.ok(intendedDifferences[path]!.reason.trim(), `missing reason: ${path}`);
      assert.notEqual(intendedDifferences[path]!.sha256, baseline.pages[path], `unnecessary exception: ${path}`);
    }
    for (const path of pages) {
      // 0.2.6 added head tags (see the fixture README); they are removed, nothing else is.
      const html = withoutAddedHead(await readFile(join(out, path), "utf8"), false, DESCRIPTION_PAGES.has(path));
      const hash = createHash("sha256").update(html).digest("hex");
      assert.equal(hash, intendedDifferences[path]?.sha256 ?? baseline.pages[path], path);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
