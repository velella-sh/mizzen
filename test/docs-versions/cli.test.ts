/**
 * `mizzen versions snapshot` (#597): the snapshot command, its dry run, an invalid input that writes nothing, and a
 * repeated run that never overwrites a release.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli/index.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/docs-versions/", import.meta.url));

function copyFixture(): string {
  const root = join(mkdtempSync(join(tmpdir(), "docs-versions-cli-")), "site");
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** Runs the CLI and records what it printed. */
async function run(args: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { log: (message) => out.push(message), error: (message) => err.push(message) });
  return { code, out, err };
}

test("versions snapshot --dry-run lists the files and writes nothing", async () => {
  const root = copyFixture();
  try {
    const dry = await run(["versions", "snapshot", "v3", root, "--dry-run"]);
    assert.equal(dry.code, 0);
    assert.deepEqual(dry.err, []);
    assert.deepEqual(dry.out, [
      "v3: would write 4 files (dry run; nothing written)",
      "  v3/README.md",
      "  v3/_data/navigation.yml",
      "  v3/guide/install.md",
      "  v3/guide/upgrade.md",
    ]);
    assert.equal(existsSync(join(root, "v3")), false);

    const real = await run(["versions", "snapshot", "v3", root]);
    assert.equal(real.code, 0);
    assert.deepEqual(real.err, []);
    assert.deepEqual(real.out, ["v3: wrote 4 files", ...dry.out.slice(1)]);
    assert.equal(readFileSync(join(root, "v3/guide/install.md"), "utf8"), readFileSync(join(root, "guide/install.md"), "utf8"));
  } finally {
    rmSync(dirname(root), { recursive: true, force: true });
  }
});

test("an invalid version name exits 1 and writes nothing", async () => {
  const root = copyFixture();
  try {
    const result = await run(["versions", "snapshot", "latest", root]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, []);
    assert.match(result.err[0] ?? "", /not a version folder name/);
    assert.equal(existsSync(join(root, "latest")), false);

    const missing = await run(["versions", "snapshot"]);
    assert.equal(missing.code, 2);
    assert.match(missing.err[0] ?? "", /needs a version name/);
  } finally {
    rmSync(dirname(root), { recursive: true, force: true });
  }
});

test("a repeated snapshot exits 1 and leaves the released bytes alone", async () => {
  const root = copyFixture();
  try {
    assert.equal((await run(["versions", "snapshot", "v3", root])).code, 0);
    const released = readFileSync(join(root, "v3/guide/install.md"), "utf8");
    writeFileSync(join(root, "guide/install.md"), "# Install\n\nEdited after the release.\n");

    const repeat = await run(["versions", "snapshot", "v3", root, "--dry-run"]);
    assert.equal(repeat.code, 1);
    assert.deepEqual(repeat.out, []);
    assert.match(repeat.err[0] ?? "", /already exists/);
    assert.equal(readFileSync(join(root, "v3/guide/install.md"), "utf8"), released);
  } finally {
    rmSync(dirname(root), { recursive: true, force: true });
  }
});
