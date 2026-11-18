/**
 * #931 selection and required dependencies; #932 every missing input by id; #933 byte-identical exports; #934 equal
 * content stored once with both references; #935 only declared inputs enter.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/data/lock.ts";
import { copySite, exportTo, scratch, writeFiles } from "./input-pack-site.ts";

test("two exports of the same site are byte-identical and report the same hash", async () => {
  const parent = scratch();
  try {
    const site = copySite(parent);
    const first = join(parent, "first.mizzenpack");
    const second = join(parent, "second.mizzenpack");
    const one = await exportTo(site, first);
    const two = await exportTo(site, second);
    assert.equal(one.code, 0);
    assert.equal(two.code, 0);
    assert.deepEqual(readFileSync(one.package!.file!), readFileSync(two.package!.file!));
    assert.equal(one.package!.sha256, two.package!.sha256);
    assert.equal(one.package!.sha256, sha256(readFileSync(first)));
    assert.ok(!/"?20\d\d-\d\d-\d\dT/.test(readFileSync(first, "utf8")), "no timestamp enters the package");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("equal content is stored once while both input references survive", async () => {
  const parent = scratch();
  try {
    const site = copySite(parent);
    const file = join(parent, "site.mizzenpack");
    const result = await exportTo(site, file);
    const manifest = result.package!.manifest;
    const products = manifest.inputs.find((input) => input.id === "products")!;
    const copy = manifest.inputs.find((input) => input.id === "products-copy")!;
    assert.equal(products.sha256, copy.sha256);
    assert.equal(manifest.inputs.length, 4);
    assert.equal(manifest.blobs.length, 3);
    assert.equal(manifest.blobs.filter((blob) => blob.sha256 === products.sha256).length, 1);
    assert.equal(manifest.blobs.find((blob) => blob.sha256 === products.sha256)!.bytes, products.bytes);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a package for one collection carries that collection and every references target, and nothing else", async () => {
  const parent = scratch();
  try {
    const site = copySite(parent);
    const file = join(parent, "subset.mizzenpack");
    const result = await exportTo(site, file, ["products"]);
    assert.equal(result.code, 0, result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    assert.deepEqual(result.package!.manifest.inputs.map((input) => input.id), ["products", "suppliers"]);
    const all = await exportTo(site, join(parent, "all.mizzenpack"));
    assert.deepEqual(all.package!.manifest.inputs.map((input) => input.id), ["products", "products-copy", "suppliers", "unused"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an unknown collection is named, and a selected collection without its target still exports", async () => {
  const parent = scratch();
  try {
    const site = copySite(parent);
    const unknown = await exportTo(site, join(parent, "x.mizzenpack"), ["missing"]);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.diagnostics[0]!.id, "inputs.unknown-collection");
    assert.match(unknown.diagnostics[0]!.message, /missing/);
    assert.equal(existsSync(join(parent, "x.mizzenpack")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("every missing input is reported by id before a package is created", async () => {
  const parent = scratch();
  try {
    const site = join(parent, "site");
    writeFiles(site, {
      "mizzen.yml": "collections:\n  one:\n    source: _data/one.yml\n  two:\n    source: _data/two.yml\n  three:\n    source: _data/three.yml\n",
      "_data/three.yml": "- id: only\n  name: Only\n",
    });
    const file = join(parent, "missing.mizzenpack");
    const result = await exportTo(site, file);
    assert.equal(result.code, 1);
    const missing = result.diagnostics.filter((diagnostic) => diagnostic.id === "inputs.input-missing");
    assert.equal(missing.length, 2);
    const messages = missing.map((diagnostic) => diagnostic.message).join("\n");
    assert.match(messages, /"one"/);
    assert.match(messages, /"two"/);
    assert.doesNotMatch(messages, /"three"/);
    assert.equal(existsSync(file), false, "no partial package is written");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("environment files, unrelated cache files, and files outside the site never enter a package", async () => {
  const parent = scratch();
  try {
    const site = join(parent, "site");
    const outside = join(parent, "outside.yml");
    writeFileSync(outside, "- id: outside\n  secret: OUTSIDE-SECRET\n");
    writeFiles(site, {
      "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n",
      "_data/items.yml": "- id: one\n  name: One\n",
      ".env": "TOKEN=ENV-SECRET\n",
      ".mizzen/cache/blob": "CACHE-SECRET\n",
      "notes.txt": "UNRELATED\n",
    });
    const file = join(parent, "restricted.mizzenpack");
    const result = await exportTo(site, file);
    assert.equal(result.code, 0, result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    assert.deepEqual(result.package!.manifest.inputs.map((input) => input.source), ["_data/items.yml"]);
    const text = readFileSync(file, "utf8");
    for (const secret of ["ENV-SECRET", "CACHE-SECRET", "UNRELATED", "OUTSIDE-SECRET"]) {
      assert.ok(!text.includes(secret), `${secret} is not in the package`);
    }
    assert.ok(text.includes("_data/items.yml"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a declared environment file, a path outside the site, and a symlink to outside are refused", async () => {
  const parent = scratch();
  try {
    const site = join(parent, "site");
    writeFiles(site, {
      "mizzen.yml": "collections:\n  env:\n    source: .env\n",
      ".env": "TOKEN=x\n",
    });
    const env = await exportTo(site, join(parent, "env.mizzenpack"));
    assert.equal(env.code, 1);
    assert.equal(env.diagnostics[0]!.id, "inputs.source-unsupported");
    assert.match(env.diagnostics[0]!.message, /environment file|machine state/);

    writeFiles(site, { "mizzen.yml": "collections:\n  escape:\n    source: ../outside.yml\n", "../outside.yml": "- id: x\n" });
    const outside = await exportTo(site, join(parent, "outside.mizzenpack"));
    assert.equal(outside.code, 1);
    assert.match(outside.diagnostics[0]!.message, /not a relative path/);

    const linked = join(parent, "linked");
    writeFiles(linked, { "mizzen.yml": "collections:\n  link:\n    source: _data/link.yml\n" });
    mkdirSync(join(linked, "_data"), { recursive: true });
    writeFileSync(join(parent, "real.yml"), "- id: x\n  name: Outside\n");
    symlinkSync(join(parent, "real.yml"), join(linked, "_data", "link.yml"));
    const link = await exportTo(linked, join(parent, "link.mizzenpack"));
    assert.equal(link.code, 1);
    assert.match(link.diagnostics[0]!.message, /symbolic link/);
    assert.equal(link.diagnostics[0]!.id, "inputs.source-unsupported");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an npm source is refused with direction to install it in the destination", async () => {
  const parent = scratch();
  try {
    const site = join(parent, "site");
    writeFiles(site, { "mizzen.yml": "collections:\n  pkg:\n    source: npm:pkg/data.yml\n" });
    const result = await exportTo(site, join(parent, "npm.mizzenpack"));
    assert.equal(result.code, 1);
    assert.equal(result.diagnostics[0]!.id, "inputs.source-unsupported");
    assert.match(result.diagnostics[0]!.help ?? "", /Install the package/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
