/**
 * With analytics on, a build is still reproducible: two builds of one site write the same bytes and `mizzen verify`
 * accepts them, and turning analytics off changes only what analytics adds (the head tag, the origin list).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verify } from "../src/cli/verify.ts";
import { MANIFEST_PATH } from "../src/outputs/build-hash.ts";
import { headMeta } from "../src/outputs/head-meta.ts";
import { build } from "../src/pipeline/build.ts";
import { config, page, site } from "./helpers-analytics.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const ON = "analytics:\n  provider: plausible\n  site: example.com\nverify:\n  bingFile: 0123456789abcdef0123456789abcdef\n";

function writeSite(parent: string, name: string, yml: string): string {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mizzen.yml"), `title: Demo\nurl: https://demo.test\n${yml}`);
  writeFileSync(join(root, "index.md"), "---\ntitle: Home\n---\n# Home\n\nHello.\n");
  writeFileSync(join(root, "a.md"), "---\ntitle: A\nanalytics: false\n---\n# A\n\nPage A.\n");
  return root;
}

function filesOf(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(/[\\/]/).join("/"))
    .sort();
}

test("builds with analytics on are byte-identical, verified, and differ from off only by what analytics adds", async () => {
  const parent = mkdtempSync(join(tmpdir(), "analytics-determinism-"));
  try {
    const outOne = join(parent, "out1");
    const outTwo = join(parent, "out2");
    const outOff = join(parent, "off");
    const opts = { themeRoot: THEME, defaultLayout: "doc" };
    const one = await build({ root: writeSite(parent, "s1", ON), out: outOne, ...opts });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const two = await build({ root: writeSite(parent, "s2", ON), out: outTwo, ...opts });
    await build({ root: writeSite(parent, "s3", ""), out: outOff, ...opts });

    assert.deepEqual(one.diagnostics.filter((d) => d.severity === "error"), []);
    assert.deepEqual(two.diagnostics.filter((d) => d.severity === "error"), []);
    assert.deepEqual(filesOf(outTwo), filesOf(outOne));
    for (const path of filesOf(outOne)) {
      assert.ok(readFileSync(join(outOne, path)).equals(readFileSync(join(outTwo, path))), `${path} is identical`);
    }
    assert.equal((await verify({ dir: outOne })).ok, true);

    // Off: the same pages byte for byte; the verification file, the origin list and the hashes that cover them go.
    const added = filesOf(outOne).filter((path) => !filesOf(outOff).includes(path));
    assert.deepEqual(added, ["BingSiteAuth.xml"]);
    for (const path of filesOf(outOff).filter((p) => p.endsWith(".html"))) {
      assert.equal(readFileSync(join(outOff, path), "utf8"), readFileSync(join(outOne, path), "utf8"), path);
    }
    const manifest = (out: string) => JSON.parse(readFileSync(join(out, MANIFEST_PATH), "utf8")) as { pages: unknown; origins?: string[] };
    assert.deepEqual(manifest(outOne).pages, manifest(outOff).pages);
    assert.deepEqual(manifest(outOne).origins, ["https://plausible.io"]);
    assert.equal(manifest(outOff).origins, undefined);
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("the head tag holds no value that changes between computations", async () => {
  const model = site(config({ analytics: { provider: "plausible", site: "example.com" } }));
  const first = JSON.stringify(headMeta(model, page(), []).scripts);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = JSON.stringify(headMeta(model, page(), []).scripts);
  assert.equal(second, first);
  assert.doesNotMatch(first, /\d{4}-\d\d-\d\d|\d{10,}/, "no date or timestamp in the tag");
});
