/**
 * `mizzen inputs verify`: checks a package's magic, format, manifest, every content hash, and that no bytes follow the
 * declared contents. It changes nothing, so CI can verify a downloaded artifact before an install step.
 */
import type { Diagnostic } from "../contracts/index.ts";
import { MAX_PACKAGE_BYTES } from "./manifest.ts";
import { readPackage } from "./pack.ts";

/** What {@link verifyPackage} found. */
export interface VerifyPackageResult {
  /** 0 when the package is intact, 1 when it is not. */
  readonly code: number;
  /** Every problem found, with a fix. */
  readonly diagnostics: readonly Diagnostic[];
  /** The package hash and input count, for the success line. */
  readonly sha256?: string;
  /** Declared input ids, in manifest order. */
  readonly inputs?: readonly string[];
}

/** Reads and checks a package without writing anything. */
export async function verifyPackage(options: { readonly file: string; readonly maxBytes?: number }): Promise<VerifyPackageResult> {
  const read = await readPackage(options.file, options.maxBytes ?? MAX_PACKAGE_BYTES);
  if (read.pkg === undefined) return { code: 1, diagnostics: read.diagnostics };
  return {
    code: 0,
    diagnostics: [],
    sha256: read.pkg.sha256,
    inputs: read.pkg.manifest.inputs.map((input) => input.id),
  };
}
