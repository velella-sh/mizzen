/**
 * #943 a package exported from one path builds the same site in a fresh checkout, offline; #934 the exported references
 * survive in the destination's files.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { importInputs } from "../src/inputs/install.ts";
import { build } from "../src/pipeline/build.ts";
import { THEME, copySite, exportTo, scratch } from "./input-pack-site.ts";

/** Every file under `root`, as `/`-separated relative paths in code-point order. */
function filesOf(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(/[\\/]/).join("/"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

test("a package exported in one path builds byte-identical output in a fresh offline checkout", async () => {
  const parent = scratch();
  const original = globalThis.fetch;
  try {
    const source = copySite(parent);
    const file = join(parent, "site.mizzenpack");
    const exported = await exportTo(source, file);
    assert.equal(exported.code, 0);

    const fresh = copySite(join(parent, "fresh"), { data: false });
    const imported = await importInputs({ root: fresh, file });
    assert.equal(imported.code, 0, imported.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    assert.deepEqual(filesOf(join(fresh, "_data")), filesOf(join(source, "_data")));

    globalThis.fetch = (() => {
      throw new Error("a build must not fetch");
    }) as typeof fetch;
    const first = await build({
      root: source,
      out: join(parent, "out-source"),
      themeRoot: THEME,
      defaultLayout: "doc",
      cache: false,
    });
    const second = await build({
      root: fresh,
      out: join(parent, "out-fresh"),
      themeRoot: THEME,
      defaultLayout: "doc",
      cache: false,
    });
    assert.deepEqual(first.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.deepEqual(second.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);

    const left = filesOf(first.out);
    const right = filesOf(second.out);
    assert.deepEqual(right, left);
    for (const path of left) {
      assert.deepEqual(readFileSync(join(second.out, path)), readFileSync(join(first.out, path)), path);
    }
    const html = readFileSync(join(second.out, "index.html"), "utf8");
    assert.match(html, /<td>alpha<\/td>/);
    assert.match(html, /<td>beta<\/td>/);
  } finally {
    globalThis.fetch = original;
    rmSync(parent, { recursive: true, force: true });
  }
});
