import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../src/model/build.ts";
import { applyEditTransaction, parseEditTransaction } from "../src/edits/edit-transaction.ts";
import { buildDependencyGraph } from "../src/pipeline/dependency-graph.ts";
import { planInvalidation } from "../src/pipeline/invalidation.ts";
import { build } from "../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A temporary folder holding `files`, removed by the caller. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "edits-transaction-build-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Every file under `dir` as path → bytes, so two builds can be compared byte for byte. */
function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) map.set(rel.split("\\").join("/"), readFileSync(abs, "latin1"));
  }
  return map;
}

/** SHA-256 of a text. */
function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("a transaction invalidates only the changed page and the warm build matches a full build", { timeout: 180_000 }, async () => {
  const source = "---\ntitle: A\n---\n# A\n";
  const root = tree({
    "mizzen.yml": "title: Transaction build\n",
    "index.md": "---\ntitle: Home\n---\n# Home\n",
    "guide/a.md": source,
    "guide/b.md": "---\ntitle: B\n---\n# B\n",
    "_data/navigation.yml": "- title: Home\n  url: /\n- title: A\n  url: /guide/a/\n- title: B\n  url: /guide/b/\n",
  });
  const parent = mkdtempSync(join(tmpdir(), "edits-transaction-build-out-"));
  const cacheDir = join(parent, "cache");
  const warmOut = join(parent, "warm");
  const fullOut = join(parent, "full");
  try {
    // The graph names one affected output for a body edit of guide/a.md.
    const { site } = await buildModel(root);
    const graph = await buildDependencyGraph({ root, site });
    const plan = planInvalidation({ graph: graph.graph, changes: [{ kind: "changed", path: "guide/a.md" }] });
    assert.deepEqual(plan.outputs.map((output) => output.url), ["/guide/a/"]);

    const first = await build({ root, out: warmOut, themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
    assert.ok(first.renderedPages > 0);

    const parsed = parseEditTransaction({
      version: 1,
      task: { id: "build-refresh" },
      snapshot: { files: { "guide/a.md": hash(source) } },
      patches: [
        {
          file: "guide/a.md",
          patches: [
            {
              span: { line: 4, column: 3, endLine: 4, endColumn: 3 },
              expected: "A",
              replacement: "AA",
              beforeHash: hash(source),
            },
          ],
        },
      ],
    });
    assert.deepEqual(parsed.problems, []);
    assert.ok(parsed.transaction);
    await applyEditTransaction({
      siteRoot: root,
      transaction: parsed.transaction,
      receipt: join(parent, "transaction.receipt.json"),
      audit: join(parent, "transaction.audit.jsonl"),
    });
    assert.equal(readFileSync(join(root, "guide/a.md"), "utf8"), "---\ntitle: A\n---\n# AA\n");

    const warm = await build({ root, out: warmOut, themeRoot: THEME, defaultLayout: "doc", cache: true, cacheDir });
    const full = await build({ root, out: fullOut, themeRoot: THEME, defaultLayout: "doc" });
    assert.ok(warm.cachedPages >= 1, "the unchanged pages were reused");
    assert.ok(warm.renderedPages < full.renderedPages, "the warm build rendered fewer pages than the full build");
    assert.deepEqual(snapshot(warmOut), snapshot(fullOut), "the incremental build matches the full build byte for byte");
    assert.match(readFileSync(join(warmOut, "guide", "a", "index.html"), "utf8"), /AA/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
