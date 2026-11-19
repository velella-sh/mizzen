/**
 * #938 paths and size are checked before activation; #939 a lock conflict changes nothing without an explicit choice;
 * #940 a failing import keeps the previous lock and input; #941 installing the same package twice changes nothing.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sha256, storedPath, writeLock, type DataLock, type LockedSource } from "../src/data/lock.ts";
import { importInputs } from "../src/inputs/install.ts";
import { manifestText, type PackManifest } from "../src/inputs/manifest.ts";
import { packBytes, readPackage } from "../src/inputs/pack.ts";
import { copySite, exportTo, scratch, writeFiles } from "./input-pack-site.ts";

const FEED = "https://example.test/feed.csv";

/** A site that pins `bytes` as `FEED`. */
async function pinnedSite(parent: string, name: string, bytes: string): Promise<string> {
  const root = join(parent, name);
  writeFiles(root, { "mizzen.yml": `collections:\n  feed:\n    source: ${FEED}\n` });
  const hash = sha256(bytes);
  mkdirSync(join(root, ".mizzen", "data"), { recursive: true });
  writeFileSync(storedPath(root, hash), bytes);
  const lock: DataLock = {
    version: 1,
    sources: { [FEED]: { address: FEED, bytes: bytes.length, sha256: hash } },
  };
  await writeLock(root, lock);
  return root;
}

/** A hand-built package for one input, used to test the import trust boundary. */
function customPackage(file: string, source: string): void {
  const content = Buffer.from("- id: x\n  name: X\n");
  const digest = sha256(content);
  const manifest: PackManifest = {
    format: 1,
    inputs: [{ id: "x", source, bytes: content.length, sha256: digest }],
    blobs: [{ sha256: digest, bytes: content.length }],
    lock: { version: 1, sources: {} },
  };
  writeFileSync(file, packBytes(manifest, new Map([[digest, content]])));
}

test("import writes every declared input and a second import changes no tracked file", async () => {
  const parent = scratch();
  try {
    const source = copySite(parent);
    const file = join(parent, "site.mizzenpack");
    assert.equal((await exportTo(source, file)).code, 0);

    const destination = join(parent, "destination");
    writeFiles(destination, {
      "mizzen.yml": readFileSync(join(source, "mizzen.yml"), "utf8"),
      "index.md": readFileSync(join(source, "index.md"), "utf8"),
    });
    const first = await importInputs({ root: destination, file });
    assert.equal(first.code, 0, first.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    assert.ok(first.changed.includes("products"));
    for (const path of ["_data/products.yml", "_data/products-copy.yml", "_data/suppliers.csv", "_data/unused.yml"]) {
      assert.equal(readFileSync(join(destination, path), "utf8"), readFileSync(join(source, path), "utf8"), path);
    }
    assert.equal(existsSync(join(destination, "mizzen.lock.json")), false, "file inputs need no lock");

    const before = new Map(
      readdirSync(destination, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const path = join(entry.parentPath, entry.name);
          return [path, { mtime: statSync(path).mtimeMs, bytes: readFileSync(path).toString("latin1") }];
        }),
    );
    const second = await importInputs({ root: destination, file });
    assert.equal(second.code, 0);
    assert.deepEqual(second.changed, []);
    assert.match(second.messages.join("\n"), /already installed/);
    for (const [path, beforeFile] of before) {
      assert.equal(statSync(path).mtimeMs, beforeFile.mtime, `${path} was not rewritten`);
      assert.equal(readFileSync(path).toString("latin1"), beforeFile.bytes, path);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a lock conflict names each input and changes nothing until it is accepted", async () => {
  const parent = scratch();
  try {
    const source = await pinnedSite(parent, "source", "id,name\n1,Alpha\n");
    const file = join(parent, "feed.mizzenpack");
    assert.equal((await exportTo(source, file)).code, 0);
    const destination = await pinnedSite(parent, "destination", "id,name\n2,Beta\n");
    const destinationLock = JSON.parse(readFileSync(join(destination, "mizzen.lock.json"), "utf8")) as DataLock;
    const extraction = {
      source: "_data/products.ndjson",
      query: "ndjson",
      querySha256: sha256("ndjson"),
      bytes: 0,
      sha256: sha256(""),
      records: 0,
    };
    await writeLock(destination, { ...destinationLock, extractions: { products: extraction } });
    const lockBefore = readFileSync(join(destination, "mizzen.lock.json"), "utf8");
    const newHash = sha256("id,name\n1,Alpha\n");

    const blocked = await importInputs({ root: destination, file });
    assert.equal(blocked.code, 1);
    const conflict = blocked.diagnostics.find((diagnostic) => diagnostic.id === "inputs.lock-conflict")!;
    assert.match(conflict.message, /"feed"/);
    assert.match(conflict.help ?? "", /--accept feed/);
    assert.equal(readFileSync(join(destination, "mizzen.lock.json"), "utf8"), lockBefore);
    assert.equal(existsSync(storedPath(destination, newHash)), false);

    const accepted = await importInputs({ root: destination, file, accept: ["feed"] });
    assert.equal(accepted.code, 0, accepted.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    assert.deepEqual(JSON.parse(readFileSync(join(destination, "mizzen.lock.json"), "utf8")).sources[FEED].sha256, newHash);
    assert.deepEqual(JSON.parse(readFileSync(join(destination, "mizzen.lock.json"), "utf8")).extractions, { products: extraction });
    assert.equal(readFileSync(storedPath(destination, newHash), "utf8"), "id,name\n1,Alpha\n");
    assert.equal((await importInputs({ root: destination, file })).changed.length, 0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a path outside the site, an absolute path, and an environment file are refused before any write", async () => {
  const parent = scratch();
  try {
    for (const [index, source] of ["../escape.yml", "/tmp/escape.yml", ".env"].entries()) {
      const destination = join(parent, `destination-${index}`);
      writeFiles(destination, { "mizzen.yml": "collections: {}\n" });
      const file = join(parent, `bad-${index}.mizzenpack`);
      customPackage(file, source);
      const result = await importInputs({ root: destination, file });
      assert.equal(result.code, 1, source);
      assert.equal(result.diagnostics[0]!.id, "inputs.path-invalid", source);
      assert.equal(existsSync(join(parent, "escape.yml")), false);
      assert.equal(existsSync(join(destination, "escape.yml")), false);
      assert.equal(existsSync(join(destination, ".env")), false);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a symbolic link at the destination is refused and the link's target is untouched", async () => {
  const parent = scratch();
  try {
    const destination = join(parent, "destination");
    const outside = join(parent, "outside");
    mkdirSync(destination, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFiles(destination, { "mizzen.yml": "collections: {}\n" });
    symlinkSync(outside, join(destination, "_data"));
    const file = join(parent, "link.mizzenpack");
    customPackage(file, "_data/items.yml");

    const result = await importInputs({ root: destination, file });
    assert.equal(result.code, 1);
    assert.equal(result.diagnostics[0]!.id, "inputs.path-invalid");
    assert.match(result.diagnostics[0]!.message, /symbolic link/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an oversized package and an oversized input are refused before activation", async () => {
  const parent = scratch();
  try {
    const source = copySite(parent);
    const file = join(parent, "site.mizzenpack");
    assert.equal((await exportTo(source, file)).code, 0);
    const destination = join(parent, "destination");
    writeFiles(destination, { "mizzen.yml": "collections: {}\n" });

    const packageTooLarge = await importInputs({ root: destination, file, maxBytes: 32 });
    assert.equal(packageTooLarge.code, 1);
    assert.equal(packageTooLarge.diagnostics[0]!.id, "inputs.package-too-large");

    const inputTooLarge = await importInputs({ root: destination, file, maxInputBytes: 10 });
    assert.equal(inputTooLarge.code, 1);
    assert.equal(inputTooLarge.diagnostics[0]!.id, "inputs.input-too-large");
    assert.equal(existsSync(join(destination, "_data")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a package that fails its hash check changes neither the previous input nor the lock", async () => {
  const parent = scratch();
  try {
    const source = copySite(parent);
    const file = join(parent, "site.mizzenpack");
    assert.equal((await exportTo(source, file)).code, 0);
    const destination = join(parent, "destination");
    writeFiles(destination, { "mizzen.yml": "collections: {}\n", "_data/products.yml": "PREVIOUS\n" });
    const pkg = (await readPackage(file)).pkg!;
    const bytes = readFileSync(file);
    const offset = Buffer.byteLength(`mizzen-input-pack/1\n${manifestText(pkg.manifest)}\n`);
    bytes[offset] = bytes[offset]! ^ 0xff;
    writeFileSync(file, bytes);

    const result = await importInputs({ root: destination, file });
    assert.equal(result.code, 1);
    assert.equal(result.diagnostics[0]!.id, "inputs.package-mismatch");
    assert.equal(readFileSync(join(destination, "_data/products.yml"), "utf8"), "PREVIOUS\n");
    assert.equal(existsSync(join(destination, "_data/suppliers.csv")), false);
    assert.equal(existsSync(join(destination, "mizzen.lock.json")), false);
    assert.equal(existsSync(join(destination, ".mizzen")), false, "nothing was staged");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a failure while activating the second input restores the first and leaves no lock", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("a write-permission failure cannot be provoked as root");
    return;
  }
  const parent = scratch();
  const blocked = join(parent, "destination", "b");
  try {
    const source = join(parent, "source");
    writeFiles(source, {
      "mizzen.yml": "collections:\n  a:\n    source: a/one.yml\n  b:\n    source: b/two.yml\n",
      "a/one.yml": "- id: one\n  name: New A\n",
      "b/two.yml": "- id: two\n  name: New B\n",
    });
    const file = join(parent, "two.mizzenpack");
    assert.equal((await exportTo(source, file)).code, 0);

    const destination = join(parent, "destination");
    writeFiles(destination, {
      "mizzen.yml": readFileSync(join(source, "mizzen.yml"), "utf8"),
      "a/one.yml": "OLD A\n",
    });
    mkdirSync(blocked, { recursive: true });
    chmodSync(blocked, 0o500);

    const result = await importInputs({ root: destination, file, accept: ["a"] });
    assert.equal(result.code, 1);
    assert.equal(result.diagnostics[0]!.id, "inputs.import-failed");
    assert.equal(readFileSync(join(destination, "a/one.yml"), "utf8"), "OLD A\n", "the first input was restored");
    assert.equal(existsSync(join(destination, "b/two.yml")), false);
    assert.equal(existsSync(join(destination, "mizzen.lock.json")), false);
    const meta = join(destination, ".mizzen");
    if (existsSync(meta)) {
      assert.deepEqual(readdirSync(meta).filter((name) => name.startsWith("inputs-stage-")), [], "staging is removed");
    }
  } finally {
    try {
      chmodSync(blocked, 0o700);
    } catch {
      // The folder was never created when the export failed first.
    }
    rmSync(parent, { recursive: true, force: true });
  }
});


test("import invalidates only extractions whose local source changed, including file-only packages", async () => {
  const parent = scratch();
  try {
    for (const mixed of [false, true]) {
      const root = join(parent, mixed ? "mixed" : "file-only");
      const local = Buffer.from('{"id":"new"}\n');
      const remote = Buffer.from("id,name\n1,Alpha\n");
      const localHash = sha256(local);
      const remoteHash = sha256(remote);
      const inputs = [{ id: "items", source: "_data/items.ndjson", bytes: local.length, sha256: localHash }];
      const blobs = new Map([[localHash, local]]);
      const lockSources: Record<string, LockedSource> = {};
      if (mixed) {
        inputs.push({ id: "feed", source: FEED, bytes: remote.length, sha256: remoteHash });
        blobs.set(remoteHash, remote);
        lockSources[FEED] = { address: FEED, bytes: remote.length, sha256: remoteHash };
      }
      const manifest: PackManifest = {
        format: 1,
        inputs,
        blobs: [...blobs].map(([digest, content]) => ({ sha256: digest, bytes: content.length })),
        lock: { version: 1, sources: lockSources },
      };
      const file = join(parent, `${mixed ? "mixed" : "file-only"}.mizzenpack`);
      writeFileSync(file, packBytes(manifest, blobs));

      writeFiles(root, { "mizzen.yml": "collections: {}\n", "_data/items.ndjson": "old\n" });
      const affected = {
        source: "./_data/items.ndjson",
        query: "ndjson",
        querySha256: sha256("items-query"),
        bytes: 0,
        sha256: sha256(""),
        records: 0,
      };
      const unrelated = { ...affected, source: "_data/other.ndjson", querySha256: sha256("other-query") };
      await writeLock(root, { version: 1, sources: {}, extractions: { items: affected, other: unrelated } });

      const result = await importInputs({ root, file, accept: ["items"] });
      assert.equal(result.code, 0, result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      assert.ok(result.changed.includes("mizzen.lock.json"), mixed ? "mixed import" : "file-only import");
      const installed = JSON.parse(readFileSync(join(root, "mizzen.lock.json"), "utf8")) as DataLock;
      assert.deepEqual(installed.extractions, { other: unrelated });
      assert.equal(readFileSync(join(root, "_data/items.ndjson"), "utf8"), local.toString());
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
