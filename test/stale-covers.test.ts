import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { coversLine, expandCovers } from "../src/stale/covers.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "stale-covers-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const FILES = { "src/b.ts": "b", "src/a.ts": "a", "src/deep/c.ts": "c", "schema/x.json": "{}" };

test("a path names one file", async () => {
  const root = tree(FILES);
  const r = await expandCovers({ covers: ["src/a.ts"], root, file: "p.md" });
  assert.deepEqual(r.files, ["src/a.ts"]);
  assert.deepEqual(r.diagnostics, []);
});

test("globs expand in sorted order without duplicates", async () => {
  const root = tree(FILES);
  const r = await expandCovers({ covers: ["src/**/*.ts", "src/a.ts"], root, file: "p.md" });
  assert.deepEqual(r.files, ["src/a.ts", "src/b.ts", "src/deep/c.ts"]);
  const one = await expandCovers({ covers: ["src/*.ts"], root, file: "p.md" });
  assert.deepEqual(one.files, ["src/a.ts", "src/b.ts"]);
});

test("a pattern that matches nothing is reported at the key's line", async () => {
  const root = tree(FILES);
  const r = await expandCovers({ covers: ["nope/*.ts", "missing.ts"], root, file: "p.md", line: 4 });
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.diagnostics.map((d) => [d.id, d.pos?.line]), [["stale.covers-empty", 4], ["stale.covers-empty", 4]]);
});

test("a path outside the root is rejected", async () => {
  const root = tree(FILES);
  const r = await expandCovers({ covers: ["../x.ts", "/etc/passwd", "src/../../y"], root, file: "p.md" });
  assert.deepEqual(r.diagnostics.map((d) => d.id), ["stale.covers-outside-root", "stale.covers-outside-root", "stale.covers-outside-root"]);
  assert.deepEqual(r.files, []);
});

test("a symbolic link is not followed out of the root", async () => {
  const outside = tree({ "secret.ts": "s" });
  const root = tree(FILES);
  symlinkSync(outside, join(root, "link"));
  symlinkSync(join(outside, "secret.ts"), join(root, "src", "secret.ts"));
  const r = await expandCovers({ covers: ["**/*.ts"], root, file: "p.md" });
  assert.deepEqual(r.files, ["src/a.ts", "src/b.ts", "src/deep/c.ts"]);
  const direct = await expandCovers({ covers: ["src/secret.ts"], root, file: "p.md" });
  assert.deepEqual(direct.files, []);
});

test("a value that is not a list of strings is invalid", async () => {
  const root = tree(FILES);
  for (const covers of ["src/a.ts", [1], [""], undefined]) {
    const r = await expandCovers({ covers, root, file: "p.md" });
    assert.equal(r.diagnostics[0]?.id, "stale.covers-invalid");
  }
});

test("coversLine finds the key in the front matter", () => {
  assert.equal(coversLine("---\ntitle: x\ncovers:\n  - a\n---\nbody"), 3);
  assert.equal(coversLine("no front matter"), 1);
});
