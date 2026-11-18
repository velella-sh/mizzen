/**
 * #930 a versioned manifest validates its inputs, hashes, and lock; #942 an unknown format is refused with the version
 * that reads it.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PACK_FORMAT, isInputManifest, validateManifest, type PackManifest } from "../src/inputs/manifest.ts";
import { readPackage } from "../src/inputs/pack.ts";
import { copySite, exportTo, scratch } from "./input-pack-site.ts";

function packageOf(parent: string): string {
  return join(parent, "site.mizzenpack");
}

test("an exported manifest validates against the format and names every input and its content", async () => {
  const parent = scratch();
  try {
    const site = copySite(parent);
    const file = packageOf(parent);
    const result = await exportTo(site, file);
    assert.equal(result.code, 0, result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    assert.ok(result.package !== undefined);
    const manifest = result.package.manifest;
    assert.equal(manifest.format, PACK_FORMAT);
    assert.equal(validateManifest(manifest), undefined);
    assert.equal(isInputManifest(manifest), true);
    assert.deepEqual(manifest.inputs.map((input) => input.id), ["products", "products-copy", "suppliers", "unused"]);
    for (const input of manifest.inputs) {
      assert.equal(input.sha256.length, 64);
      assert.ok(manifest.blobs.some((blob) => blob.sha256 === input.sha256 && blob.bytes === input.bytes));
    }
    assert.deepEqual(manifest.lock, { version: 1, sources: {} }, "the fixture has file inputs only");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a manifest with an unknown format, a mismatched hash, an extra key, or a stray lock entry is refused", async () => {
  const parent = scratch();
  try {
    const site = copySite(parent);
    const file = packageOf(parent);
    const result = await exportTo(site, file);
    const manifest = result.package!.manifest;

    assert.match(validateManifest({ ...manifest, format: 2 }) ?? "", /format 2/);
    assert.match(validateManifest({ ...manifest, extra: true }) ?? "", /exactly format, inputs, blobs, and lock/);

    const tampered = {
      ...manifest,
      inputs: manifest.inputs.map((input, index) =>
        index === 0 ? { ...input, sha256: "0".repeat(64) } : input,
      ),
    } satisfies PackManifest;
    assert.match(validateManifest(tampered) ?? "", /names content the package does not hold/);

    const wrongLock: PackManifest = {
      ...manifest,
      lock: {
        version: 1,
        sources: {
          "https://example.test/other.csv": {
            address: "https://example.test/other.csv",
            bytes: 1,
            sha256: "0".repeat(64),
          },
        },
      },
    };
    assert.match(validateManifest(wrongLock) ?? "", /not a declared input/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a package whose first line names format 2 is rejected and names the compatible version", async () => {
  const parent = scratch();
  try {
    const site = copySite(parent);
    const file = packageOf(parent);
    assert.equal((await exportTo(site, file)).code, 0);
    const bytes = readFileSync(file).toString("latin1");
    writeFileSync(file, bytes.replace("mizzen-input-pack/1\n", "mizzen-input-pack/2\n"), "latin1");

    const read = await readPackage(file);
    assert.equal(read.pkg, undefined);
    const diagnostic = read.diagnostics[0]!;
    assert.equal(diagnostic.id, "inputs.format-unsupported");
    assert.match(diagnostic.message, /format 2/);
    assert.match(diagnostic.message, /format 1/);
    assert.match(diagnostic.message, /0\.2\.5/, "the message names the Mizzen that reads format 1");
    assert.match(diagnostic.help ?? "", /reads format 2/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
