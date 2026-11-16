import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pageCounts } from "../src/cli/page-counts.ts";
import { watch } from "../src/cli/watch.ts";
import { write } from "../fixtures/data-large/generate.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

test("pageCounts names the pages a rebuild rendered and reused, and is silent when nothing was reused", () => {
  assert.equal(pageCounts({ renderedPages: 1, cachedPages: 30 }), " (1 page rendered, 30 reused)");
  assert.equal(pageCounts({ renderedPages: 2, cachedPages: 30 }), " (2 pages rendered, 30 reused)");
  assert.equal(pageCounts({ renderedPages: 31, cachedPages: 0 }), "");
  assert.equal(pageCounts({ renderedPages: 0, cachedPages: 0 }), "");
});

test("changing one record rebuilds one page, reuses the rest, and the lists show the change", async () => {
  const root = mkdtempSync(join(tmpdir(), "watch-data-"));
  const parent = mkdtempSync(join(tmpdir(), "watch-data-out-"));
  const out = join(parent, "site");
  write(root, 40);
  const logs: string[] = [];
  const watcher = await watch({ root, out, themeRoot: THEME, cache: true, log: (message) => logs.push(message) });
  try {
    const file = join(root, "_data", "releases.json");
    const text = readFileSync(file, "utf8");
    const needle = '"summary": "Release 10 ';
    assert.ok(text.includes(needle));
    writeFileSync(file, text.replace(needle, `${needle}(edited) `));

    const rebuilt = await watcher.rebuild("change in _data/releases.json");
    assert.equal(rebuilt.renderedPages, 1, "only the page of the changed record is rendered");
    assert.ok(rebuilt.cachedPages > 30, `the others are reused (${rebuilt.cachedPages})`);
    assert.match(logs.at(-1) ?? "", / \(1 page rendered, \d+ reused\)$/);

    const all = readdirDeep(out).map((path) => readFileSync(join(out, path), "utf8"));
    assert.ok(all.some((html) => html.includes("(edited)")), "the change is in the output");
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

function readdirDeep(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? readdirDeep(dir, join(prefix, entry.name)) : entry.name.endsWith(".html") ? [join(prefix, entry.name)] : [],
  );
}
