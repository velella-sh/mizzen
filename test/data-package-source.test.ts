import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveNpmSource, splitNpmAddress } from "../src/data/package-source.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-package-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("a scoped and an unscoped npm address split into the package and its file", () => {
  assert.deepEqual(splitNpmAddress("npm:@acme/data/items.yml"), { name: "@acme/data", subpath: "items.yml" });
  assert.deepEqual(splitNpmAddress("npm:data/nested/items.json"), { name: "data", subpath: "nested/items.json" });
  assert.equal(splitNpmAddress("npm:data"), undefined);
  assert.equal(splitNpmAddress("npm:data/../secret.yml"), undefined);
});

test("an installed package's file resolves with the version and a site-relative display path", async () => {
  const root = tree({
    "node_modules/@acme/data/package.json": JSON.stringify({ name: "@acme/data", version: "2.3.4" }),
    "node_modules/@acme/data/items.yml": "- id: a\n",
  });
  try {
    const result = await resolveNpmSource(root, "npm:@acme/data/items.yml");
    assert.equal(result.diagnostic, undefined);
    assert.equal(result.source?.name, "@acme/data");
    assert.equal(result.source?.version, "2.3.4");
    assert.equal(result.source?.display, "node_modules/@acme/data/items.yml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing package and a missing file each name the address in one diagnostic", async () => {
  const root = tree({ "node_modules/data/package.json": JSON.stringify({ version: "1.0.0" }) });
  try {
    assert.equal((await resolveNpmSource(root, "npm:missing/items.yml")).diagnostic?.id, "data.package-missing");
    assert.equal((await resolveNpmSource(root, "npm:data/items.yml")).diagnostic?.id, "data.package-path-missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a link that leaves the package is refused", async () => {
  const root = tree({
    "node_modules/data/package.json": JSON.stringify({ version: "1.0.0" }),
    "secret.yml": "- id: leaked\n",
  });
  try {
    mkdirSync(join(root, "node_modules/data"), { recursive: true });
    symlinkSync(join(root, "secret.yml"), join(root, "node_modules/data/items.yml"));
    const result = await resolveNpmSource(root, "npm:data/items.yml");
    assert.equal(result.source, undefined);
    assert.equal(result.diagnostic?.id, "data.package-escape");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
