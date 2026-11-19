/**
 * Bind a receipt to its commit, tarball, CI result, and inputs (#1191).
 *
 * A receipt is only useful if it names the exact package a release published. This check reads
 * the tarball the caller supplies, hashes it, and compares the SHA-256 with the package recorded
 * in the proof; it also compares the commit, requires a passing CI result, and rechecks every
 * transaction file against the public input. Replacing the tarball, the commit, or one input
 * file invalidates the receipt instead of silently verifying a different release.
 *
 * The proof's own hash is checked first, so editing the recorded package fields cannot make a
 * swapped tarball match.
 */
import { readFile } from "node:fs/promises";
import type { ReceiptVerification, VerificationFailure, VerificationProof } from "../contracts/verification.ts";
import { sha256 } from "../data/lock.ts";
import { proofHashMatches } from "./proof.ts";

/** What {@link verifyReceipt} compares against. */
export interface ReceiptInput {
  /** The commit the release was built from. */
  readonly commit: string;
  /** The tarball file the release published. */
  readonly tarball: string;
  /** The CI result for that commit. */
  readonly ci: "passed" | "failed" | "unknown";
  /** Site-relative path to the SHA-256 after the task, or `null` when absent. */
  readonly files: Readonly<Record<string, string | null>>;
}

/** Reads the receipt's package and checks every binding. */
export async function verifyReceipt(
  proof: VerificationProof,
  input: ReceiptInput,
): Promise<ReceiptVerification> {
  const failures: VerificationFailure[] = [];
  const fail = (code: string, message: string, path?: string): void => {
    failures.push({ code, message, ...(path === undefined ? {} : { path }) });
  };

  if (!proofHashMatches(proof)) {
    fail("verification.proof-hash", "The proof hash does not match the proof content; the record changed after it was written.");
  }
  if (proof.package === undefined) {
    fail("verification.package", "The proof is not bound to a release package.");
    return { ok: false, tarballSha256: "", failures };
  }

  let tarballSha256 = "";
  try {
    tarballSha256 = sha256(await readFile(input.tarball));
  } catch (err) {
    fail("verification.package", `The tarball "${input.tarball}" cannot be read: ${(err as Error).message}.`);
  }
  if (tarballSha256 !== "" && tarballSha256 !== proof.package.tarballSha256) {
    fail("verification.package", "The tarball SHA-256 does not match the proof's package.");
  }
  if (input.commit !== proof.package.commit || input.commit !== proof.transaction.commit) {
    fail("verification.package", "The commit does not match the proof's commit.");
  }
  if (input.ci !== "passed" || proof.package.ci !== "passed") {
    fail("verification.package", `The CI result is "${input.ci}" in the input and "${proof.package.ci}" in the proof; a release receipt needs "passed".`);
  }

  const recorded = new Map(proof.transaction.files.map((change) => [change.path, change.after]));
  const supplied = Object.keys(input.files).sort();
  const expected = [...recorded.keys()].sort();
  if (supplied.length !== expected.length || supplied.some((path, index) => path !== expected[index])) {
    fail("verification.input", "The input files do not name exactly the transaction's files.");
  }
  for (const [path, hash] of recorded) {
    if (!(path in input.files)) {
      fail("verification.input", `Input file "${path}" is missing.`, path);
    } else if (input.files[path] !== hash) {
      fail("verification.input", `Input file "${path}" changed after the receipt.`, path);
    }
  }

  return { ok: failures.length === 0, tarballSha256, failures };
}
