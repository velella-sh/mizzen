import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/data/lock.ts";
import { verifyReceipt } from "../src/verification/receipt.ts";
import { provedProof } from "./verification-fixture.ts";

const COMMIT = "abc1234";
const AFTER = sha256("after\n");

/** A temporary tarball with the proof's recorded bytes. */
function tarballOf(proofBytes: string): { dir: string; file: string; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), "verification-receipt-"));
  const file = join(dir, "package.tgz");
  writeFileSync(file, proofBytes);
  return { dir, file, hash: sha256(proofBytes) };
}

test("a receipt binds to the commit, tarball, CI result, and inputs", async () => {
  const bytes = "the released tarball\n";
  const tarball = tarballOf(bytes);
  try {
    const proof = provedProof({
      package: { commit: COMMIT, tarballSha256: tarball.hash, ci: "passed" },
    });
    const result = await verifyReceipt(proof, {
      commit: COMMIT,
      tarball: tarball.file,
      ci: "passed",
      files: { "docs/install.md": AFTER },
    });
    assert.deepEqual(result.failures, []);
    assert.equal(result.ok, true);
    assert.equal(result.tarballSha256, tarball.hash);
  } finally {
    rmSync(tarball.dir, { recursive: true, force: true });
  }
});

test("a different commit, tarball, or CI result invalidates the receipt", async () => {
  const original = tarballOf("the released tarball\n");
  const swapped = tarballOf("a different tarball\n");
  try {
    const proof = provedProof({
      package: { commit: COMMIT, tarballSha256: original.hash, ci: "passed" },
    });
    const wrongCommit = await verifyReceipt(proof, {
      commit: "9999999",
      tarball: original.file,
      ci: "passed",
      files: { "docs/install.md": AFTER },
    });
    assert.equal(wrongCommit.ok, false);
    assert.ok(wrongCommit.failures.some((failure) => failure.code === "verification.package"));

    const wrongTarball = await verifyReceipt(proof, {
      commit: COMMIT,
      tarball: swapped.file,
      ci: "passed",
      files: { "docs/install.md": AFTER },
    });
    assert.equal(wrongTarball.ok, false);
    assert.ok(wrongTarball.failures.some((failure) => /tarball SHA-256/u.test(failure.message)));

    for (const ci of ["failed", "unknown"] as const) {
      const wrongCi = await verifyReceipt(proof, {
        commit: COMMIT,
        tarball: original.file,
        ci,
        files: { "docs/install.md": AFTER },
      });
      assert.equal(wrongCi.ok, false);
      assert.ok(wrongCi.failures.some((failure) => /CI result/u.test(failure.message)));
    }
  } finally {
    rmSync(original.dir, { recursive: true, force: true });
    rmSync(swapped.dir, { recursive: true, force: true });
  }
});

test("swapping an input file or editing the proof invalidates the receipt", async () => {
  const tarball = tarballOf("the released tarball\n");
  try {
    const proof = provedProof({
      package: { commit: COMMIT, tarballSha256: tarball.hash, ci: "passed" },
    });
    const swappedInput = await verifyReceipt(proof, {
      commit: COMMIT,
      tarball: tarball.file,
      ci: "passed",
      files: { "docs/install.md": sha256("different\n") },
    });
    assert.equal(swappedInput.ok, false);
    assert.ok(swappedInput.failures.some((failure) => failure.code === "verification.input"));

    const tampered = { ...proof, proofHash: "0".repeat(64) };
    const edited = await verifyReceipt(tampered, {
      commit: COMMIT,
      tarball: tarball.file,
      ci: "passed",
      files: { "docs/install.md": AFTER },
    });
    assert.equal(edited.ok, false);
    assert.ok(edited.failures.some((failure) => failure.code === "verification.proof-hash"));
  } finally {
    rmSync(tarball.dir, { recursive: true, force: true });
  }
});

test("a proof without a package cannot be bound to a release", async () => {
  const proof = provedProof();
  const result = await verifyReceipt(proof, {
    commit: COMMIT,
    tarball: join(tmpdir(), "missing.tgz"),
    ci: "passed",
    files: { "docs/install.md": AFTER },
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => /not bound to a release package/u.test(failure.message)));
});
