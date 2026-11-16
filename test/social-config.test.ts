import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";

function load(yml: string) {
  const root = mkdtempSync(join(tmpdir(), "social-config-"));
  try {
    writeFileSync(join(root, "mizzen.yml"), yml);
    return loadConfig(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}

test("the social key loads with its template and fonts, and a site without it has none", () => {
  const ok = load("social:\n  template: default\n  fonts:\n    - fonts/a.woff\n");
  assert.deepEqual(ok.diagnostics, []);
  assert.deepEqual(ok.config.social, { template: "default", fonts: ["fonts/a.woff"] });
  assert.equal(load("title: X\n").config.social, undefined);
  assert.deepEqual(load("social: {}\n").config.social, { fonts: [] });
});

test("an unknown social key, a path in the template name, or a non-list of fonts is an error", () => {
  for (const yml of ["social:\n  colour: red\n", "social:\n  template: ../x\n", "social:\n  fonts: a.woff\n"]) {
    assert.ok(load(yml).diagnostics.some((d) => d.severity === "error"), yml);
  }
});

test("both schemas carry the social key", () => {
  const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../schema/${name}`, import.meta.url)), "utf8"));
  assert.ok(read("config.schema.json").properties.social);
  assert.ok(read("front-matter.schema.json").properties.social);
});
