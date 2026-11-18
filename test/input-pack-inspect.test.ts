/**
 * #936 inspect reports the format, sources, sizes, and hashes without touching the project; #937 a tampered or
 * undeclared file is refused before an install can start.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/data/lock.ts";
import { inspectPackage } from "../src/inputs/inspect.ts";
import { manifestText } from "../src/inputs/manifest.ts";
import { readPackage } from "../src/inputs/pack.ts";
import { verifyPackage } from "../src/inputs/verify.ts";
import { copySite, exportTo, scratch } from "./input-pack-site.ts";

/** Every file under `root`, with its bytes, sorted by path. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(root, join(entry.parentPath, entry.name)).split(/[\\/]/).join("/");
    files[path] = readFileSync(join(entry.parentPath, entry.name), "latin1");
  }
  return files;
}

/** The byte offset where the first declared content starts. */
function bodyOffset(header: string): number {
  return Buffer.byteLength(header);
}

async function exported(parent: string): Promise<string> {
  const site = copySite(parent);
  const file = join(parent, "site.mizzenpack");
  const result = await exportTo(site, file);
  assert.equal(result.code, 0);
  return file;
}

test("inspect lists every source, size, hash, and the format without changing the project", async () => {
  const parent = scratch();
  try {
    const file = await exported(parent);
    const site = copySite(join(parent, "copy"));
    const before = snapshot(site);
    const result = await inspectPackage({ file });
    assert.equal(result.code, 0);
    const inspection = result.inspection!;
    assert.equal(inspection.format, 1);
    assert.equal(inspection.sha256, sha256(readFileSync(file)));
    assert.equal(inspection.bytes, readFileSync(file).byteLength);
    assert.deepEqual(inspection.inputs.map((input) => input.id), ["products", "products-copy", "suppliers", "unused"]);
    for (const input of inspection.inputs) {
      assert.ok(input.bytes > 0);
      assert.equal(input.sha256.length, 64);
    }
    assert.deepEqual(snapshot(site), before, "inspect reads only the package");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("verify accepts an intact package and reports its hash and inputs", async () => {
  const parent = scratch();
  try {
    const file = await exported(parent);
    const result = await verifyPackage({ file });
    assert.equal(result.code, 0);
    assert.equal(result.sha256, sha256(readFileSync(file)));
    assert.deepEqual(result.inputs, ["products", "products-copy", "suppliers", "unused"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a tampered content is refused with its hash", async () => {
  const parent = scratch();
  try {
    const file = await exported(parent);
    const pkg = (await readPackage(file)).pkg!;
    const bytes = readFileSync(file);
    const offset = bodyOffset(`mizzen-input-pack/1\n${manifestText(pkg.manifest)}\n`);
    bytes[offset] = bytes[offset]! ^ 0xff;
    writeFileSync(file, bytes);

    const result = await verifyPackage({ file });
    assert.equal(result.code, 1);
    assert.equal(result.diagnostics[0]!.id, "inputs.package-mismatch");
    assert.match(result.diagnostics[0]!.message, new RegExp(pkg.manifest.blobs[0]!.sha256));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("bytes appended after the declared contents are an undeclared file and are refused", async () => {
  const parent = scratch();
  try {
    const file = await exported(parent);
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("undeclared\n")]));
    const result = await verifyPackage({ file });
    assert.equal(result.code, 1);
    assert.equal(result.diagnostics[0]!.id, "inputs.package-undeclared-data");
    assert.match(result.diagnostics[0]!.message, /11 bytes/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a truncated package, a broken manifest, and a missing magic each get their own diagnostic", async () => {
  const parent = scratch();
  try {
    const file = await exported(parent);
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, bytes.length - 1));
    assert.equal((await verifyPackage({ file })).diagnostics[0]!.id, "inputs.package-truncated");

    writeFileSync(file, "mizzen-input-pack/1\n{not json}\n");
    assert.equal((await verifyPackage({ file })).diagnostics[0]!.id, "inputs.manifest-invalid");

    writeFileSync(file, "not a package\n");
    assert.equal((await verifyPackage({ file })).diagnostics[0]!.id, "inputs.package-magic");

    writeFileSync(file, "");
    assert.equal((await verifyPackage({ file })).diagnostics[0]!.id, "inputs.package-magic");

    const missing = await verifyPackage({ file: join(parent, "absent.mizzenpack") });
    assert.equal(missing.diagnostics[0]!.id, "inputs.package-missing");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
